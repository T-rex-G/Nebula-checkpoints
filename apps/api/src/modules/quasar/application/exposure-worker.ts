import {
  DETECTION_ENGINE_VERSION, RULES_VERSION, detectInHunks, detectInPath, detectInText, type DetectionResult
} from '../domain/exposure-detection.ts';
import { archiveKind } from '../domain/exposure-archives.ts';
import { FINGERPRINT_KEY_VERSION, buildFindings, fingerprintKeyId } from '../domain/exposure-findings.ts';
import { BINARY_EXTENSIONS, extensionOf } from '../client/exposure-reader.ts';
import type { ArchiveRead, BlobText, ChangedFile, Hunk, SkippedEntry, listCommits } from '../client/exposure-reader.ts';
import { EXPOSURE_CONFIG_VERSION, MAX_FINDINGS_PER_SCAN, type ScanRecord } from '../persistence/exposure-store.ts';
import {
  requireStore, requireReader, requireSessionResolver, budgetsFrom, boundedInteger, isObjectId, SKIP_BINARY,
  MAX_ARCHIVES_IN_FLIGHT, settle, yieldToEventLoop, errorCode, type ExposureRunnerOptions, type SessionResolver,
  type ObservedFinding, type Provenance, type TreeRead, type HistoryRead, type ScanOutcome, type ExposureWorkerOptions
} from './scan-ports.ts';
export { EXPOSURE_BUDGET_VERSION, DEFAULT_BUDGETS } from './scan-ports.ts';
export type {
  Budgets, ScanStore, ScanReader, SessionResolver, ScanConnections, ExposureRunnerOptions, ExposureWorkerOptions,
  ObservedFinding
} from './scan-ports.ts';

/*
 * Running a scan: one process, one free web service, repositories nobody here
 * has seen, and no assumption that this process will still be alive a minute
 * from now.
 *
 * Four things shape it.
 *
 * One commit. The scan row carries the commit its ref was resolved to before
 * the scan was accepted, and this file reads that and never the ref. A branch
 * that moves between the tree read and the blob reads would otherwise produce
 * a finding set assembled from two trees, with locations that never existed
 * together -- so a reader sent to one would find nothing there and stop
 * believing the rest.
 *
 * A budget is visible. Every ceiling produces `partial` coverage with the
 * reason named, because silently stopping at a limit and reporting success is
 * the worst thing a security feature can do: it tells somebody their
 * repository is clean because the scan gave up. The same is true of a file the
 * reader declined -- a symlink, a submodule, an oversized blob, a binary -- so
 * any skip at all means partial.
 *
 * Cancellation is the lease. The renewal is already periodic and already
 * returns false exactly when the scan is no longer running-and-ours: cancelled
 * by its owner, or reclaimed because this worker was thought dead. Using one
 * mechanism for both means neither is the one nobody wired up, and a lost
 * claim stops the scan mid-file rather than between jobs.
 *
 * Nothing is kept. No clone, no temporary directory, no cursor. A restarted
 * scan asks the provider again at the same commit, and that is not a
 * concession: a `finally` block cannot run after SIGKILL, so a design whose
 * recovery needs a disk is a design whose recovery does not work. What is in
 * the database is all there is, and it is enough.
 */

export function createExposureRunner(options: ExposureRunnerOptions = {}) {
  const store = requireStore(options.store);
  const reader = requireReader(options.reader);
  const sessionResolver = requireSessionResolver(options.sessionResolver);
  const fingerprintKey = options.fingerprintKey;
  if (!Buffer.isBuffer(fingerprintKey) && typeof fingerprintKey !== 'string') {
    throw new TypeError('An exposure runner requires a derived fingerprint key');
  }
  const budgets = budgetsFrom(options.budgets);
  const now: () => number = typeof options.now === 'function' ? options.now : Date.now;
  /*
   * A connection pool for one scan, when the caller can supply one. It is
   * opened when a scan starts and closed when it ends, whatever the outcome,
   * so no socket outlives the scan that opened it.
   */
  const createTransport = typeof options.createTransport === 'function' ? options.createTransport : null;
  const leaseMs = boundedInteger(options.leaseMs, 60_000, 1000, 10 * 60 * 1000);

  async function runOnce() {
    const claimed = await store.claimScan({ now: now(), leaseMs });
    if (!claimed) return Object.freeze({ claimed: false });
    const { scan, claimOwner } = claimed;

    if (scan.fingerprintKeyId !== fingerprintKeyId(fingerprintKey)
      || scan.rulesVersion !== RULES_VERSION || scan.engineVersion !== DETECTION_ENGINE_VERSION
      || scan.fingerprintKeyVersion !== FINGERPRINT_KEY_VERSION || scan.configVersion !== EXPOSURE_CONFIG_VERSION) {
      await finalize(scan, claimOwner, {
        state: 'failed', coverage: 'unknown', skippedReason: 'configuration-changed',
        filesScanned: 0, bytesScanned: 0
      });
      return Object.freeze({ claimed: true, stopped: 'configuration-changed' });
    }

    /*
     * The commit is the scan's, and it has to be a commit. A row carrying a
     * ref name, a short sha or nothing at all is a row this worker cannot
     * honour, and reading "the current tip" instead would be inventing consent
     * for a tree nobody authorised.
     */
    const commitSha = String(scan && scan.commitSha || '').toLowerCase();
    if (!isObjectId(commitSha)) {
      await finalize(scan, claimOwner, {
        state: 'failed', coverage: 'unknown', skippedReason: 'transport-refused',
        filesScanned: 0, bytesScanned: 0
      });
      return Object.freeze({ claimed: true, stopped: 'commit-invalid' });
    }

    /*
     * The session is resolved now, not stored earlier. A job row holding a
     * copy of a credential is a credential that outlives the consent that
     * produced it; resolving at execution means a disconnect or a revocation
     * simply stops the next scan.
     */
    let session: Awaited<ReturnType<SessionResolver>>;
    try {
      session = await sessionResolver({ scope: scan.scope, requestedBy: scan.requestedBy, scanId: scan.scanId });
    } catch {
      session = null;
    }
    let token = session && typeof session.token === 'string' ? session.token : '';
    if (!token) {
      await finalize(scan, claimOwner, {
        state: 'failed', coverage: 'unknown', skippedReason: 'authorization-revoked',
        filesScanned: 0, bytesScanned: 0
      });
      return Object.freeze({ claimed: true, stopped: 'authorization-revoked' });
    }

    const startedAt = now();
    let filesScanned = 0;
    let bytesScanned = 0;
    let skippedAny = false;
    let budgetReason: string | null = null;
    let pending: ObservedFinding[] = [];
    /* Credentials, not sightings: one seen in the tree and in the commit that
       added it is one credential against the ceiling. */
    const seenFingerprints = new Set<string>();
    /* What was not read, and why, so a report can say so in numbers. */
    let filesTotal = 0;
    let filesSkippedBinary = 0;
    let filesSkippedOther = 0;
    let archivesScanned = 0;
    let archiveMembersScanned = 0;
    const history = scan.scanMode === 'history';
    /* Counted for a history scan only; a tree scan records none. */
    let commitsTotal = 0;
    let commitsScanned = 0;
    let commitsSkipped = 0;
    let lastCheckAt = 0;
    let dispatchedSinceCheck = 0;

    async function checkAccess(): Promise<void> {
      const held = await store.renewClaim({ scanId: scan.scanId, claimOwner, leaseMs, now: now() });
      if (!held) {
        throw Object.assign(new Error('Scan claim is no longer held'), { code: 'EXPOSURE_SCAN_NOT_OWNED' });
      }
      let current: Awaited<ReturnType<SessionResolver>>;
      try {
        current = await sessionResolver({ scope: scan.scope, requestedBy: scan.requestedBy, scanId: scan.scanId });
      } catch { current = null; }
      /* The same test the scan started with: a token is a string, or there is none. */
      const renewed = current && typeof current.token === 'string' ? current.token : '';
      if (!renewed) {
        throw Object.assign(new Error('Scan authorization was revoked'), { code: 'EXPOSURE_AUTHORIZATION_REVOKED' });
      }
      token = renewed;
      lastCheckAt = now();
      dispatchedSinceCheck = 0;
    }

    /*
     * Before a read is started, the check is due every `renewEveryFiles` reads
     * or every `accessCheckIntervalMs`, whichever comes first. A cancel or a
     * revoked session is noticed within that bound, and no read is ever started
     * after one has been noticed. Every write still checks unconditionally.
     */
    let checking: Promise<void> | null = null;
    async function checkAccessIfDue(): Promise<void> {
      /* Reads waiting on a check share it, and none starts until it has passed. */
      if (checking) return checking;
      if (dispatchedSinceCheck >= budgets.renewEveryFiles
        || now() - lastCheckAt >= Math.min(budgets.accessCheckIntervalMs, leaseMs / 2)) {
        checking = checkAccess().finally(() => { checking = null; });
        return checking;
      }
    }

    function countSkip(reason: unknown): void {
      if (reason === SKIP_BINARY) filesSkippedBinary += 1;
      else filesSkippedOther += 1;
    }

    async function flush(): Promise<boolean> {
      if (!pending.length) return true;
      await checkAccess();
      const batch = pending;
      pending = [];
      await store.recordObservations({ scanId: scan.scanId, claimOwner, findings: batch, now: now() });
      return true;
    }

    /*
     * Returns false when the finding ceiling stopped the scan. `provenance`
     * says where this sighting was: in the tree, or in the commit that added
     * it -- which the store merges when a credential is both.
     */
    async function admit(detection: DetectionResult, filePath: string, provenance: Provenance, commit: string = commitSha): Promise<boolean> {
      const built = buildFindings({
        detection, path: filePath, scope: scan.scope, commit, hmacKey: fingerprintKey,
        keyVersion: scan.fingerprintKeyVersion
      });
      let limited = false;
      for (const finding of built.findings) {
        if (!seenFingerprints.has(finding.fingerprint)) {
          if (seenFingerprints.size >= MAX_FINDINGS_PER_SCAN) { limited = true; break; }
          seenFingerprints.add(finding.fingerprint);
        }
        pending.push(Object.freeze({ ...finding, ...provenance }));
      }
      if (pending.length >= budgets.flushEveryFindings) await flush();
      if (limited) {
        skippedAny = true;
        budgetReason = 'finding-limit';
        return false;
      }
      return true;
    }

    function outOfTime(): boolean {
      return now() - startedAt >= budgets.maxWallClockMs;
    }

    async function beforeHistoryPage(): Promise<void> {
      if (outOfTime()) {
        throw Object.assign(new Error('Scan time budget was exhausted'), { code: 'EXPOSURE_TIME_LIMIT' });
      }
      await checkAccessIfDue();
    }

    function reserveBytes(count: number): boolean {
      if (outOfTime()) {
        skippedAny = true;
        budgetReason = budgetReason || 'time-limit';
        return false;
      }
      if (bytesScanned + count > budgets.maxBytes) {
        skippedAny = true;
        budgetReason = budgetReason || 'byte-limit';
        return false;
      }
      bytesScanned += count;
      return true;
    }

    function scanText(text: string): DetectionResult | null {
      if (!reserveBytes(Buffer.byteLength(text, 'utf8'))) return null;
      const detection = detectInText({ text, maxDecodedBytes: budgets.maxBytes - bytesScanned });
      bytesScanned += detection.decodedBytes || 0;
      if (!detection.scanned || detection.truncated) skippedAny = true;
      return detection;
    }

    const connections = createTransport ? createTransport() : null;
    const transport = connections && typeof connections.request === 'function' ? connections.request : undefined;
    /* Reads already started when the scan stops: the tree's, then history's.
       Each is wrapped so it can never reject unobserved; they are simply not
       looked at. */
    const treeReads: TreeRead[] = [];
    const historyReads: HistoryRead[] = [];
    const openArchive = typeof reader.readArchive === 'function' ? reader.readArchive.bind(reader) : null;
    const canOpenArchives = openArchive !== null;
    const IN_TREE = Object.freeze({ inTree: true });

    /*
     * An archive's files, each scanned as a file of its own and located inside
     * it; the credential containers in it found by name. Anything it could not
     * read makes the scan partial, like a file in the tree would.
     */
    async function admitArchive(opened: ArchiveRead, provenance: Provenance, commit: string): Promise<boolean> {
      archivesScanned += 1;
      if (opened.truncated || opened.membersSkipped) skippedAny = true;
      for (const member of opened.members) {
        const detection = scanText(member.text);
        if (!detection) return false;
        archiveMembersScanned += 1;
        if (detection.candidates.length && !(await admit(detection, member.path, provenance, commit))) return false;
      }
      for (const named of opened.named) {
        const detection = detectInPath({ path: named.path, sha: named.sha });
        if (detection.candidates.length && !(await admit(detection, named.path, provenance, commit))) return false;
      }
      return true;
    }

    try {
      await checkAccess();
      const tree = await reader.readTree({ scope: scan.scope, commitSha, token, transport });
      if (tree.truncated) {
        skippedAny = true;
        budgetReason = tree.skippedReason || 'tree-truncated';
      }
      const skipped: readonly SkippedEntry[] = Array.isArray(tree.skipped) ? tree.skipped : [];
      if (skipped.length) skippedAny = true;
      filesTotal = tree.entries.length + skipped.length;
      for (const item of skipped) countSkip(item && item.reason);

      /*
       * A file can be an exposure without being read. A committed keystore or
       * password database is one whatever its bytes say, and its name is all a
       * scan needs -- so these are found from the tree, before any blob is
       * fetched, and without fetching them.
       */
      let stopped = false;
      for (const item of skipped) {
        if (!item || !item.sha || !item.path) continue;
        const detection = detectInPath({ path: item.path, sha: item.sha });
        if (!detection.candidates.length) continue;
        if (!(await admit(detection, item.path, IN_TREE))) { stopped = true; break; }
      }

      /*
       * Reads start ahead of where the scan is, up to `readConcurrency`, and
       * are consumed strictly in tree order. Every ceiling is decided when a
       * read is started -- the byte ceiling at the size the tree declares --
       * so a scan with the same inputs stops at the same file however the
       * network happens to order the answers.
       */
      const entries = tree.entries;
      let next = 0;
      let dispatched = 0;
      let dispatchedBytes = 0;
      let dispatching = !stopped;

      const fill = async (): Promise<void> => {
        while (dispatching && treeReads.length < budgets.readConcurrency && next < entries.length) {
          if (dispatched >= budgets.maxFiles) {
            budgetReason = 'file-count-limit';
            skippedAny = true;
            dispatching = false;
            break;
          }
          if (outOfTime()) {
            budgetReason = 'time-limit';
            skippedAny = true;
            dispatching = false;
            break;
          }
          const entry = entries[next];
          if (!entry) break;
          /*
           * An archive read holds its response, its bytes and what it inflates
           * to at once -- tens of megabytes at the ceilings -- so no more than
           * two are in flight on a service with half a gigabyte. The next one
           * waits for an earlier read to be consumed; nothing is skipped.
           */
          if (entry.archive && canOpenArchives
            && treeReads.filter(item => item.entry.archive).length >= MAX_ARCHIVES_IN_FLIGHT) {
            break;
          }
          const declared = Number.isInteger(entry.size) && entry.size > 0 ? entry.size : 0;
          if (dispatchedBytes >= budgets.maxBytes || dispatchedBytes + declared > budgets.maxBytes) {
            budgetReason = 'byte-limit';
            skippedAny = true;
            dispatching = false;
            break;
          }
          /*
           * The lease renewal is the cancellation signal. It is false when the
           * scan is no longer running under this claim, which is exactly the
           * set of cases where continuing would be writing into somebody else's
           * job or into one its owner has already ended.
           */
          await checkAccessIfDue();
          next += 1;
          dispatched += 1;
          dispatchedSinceCheck += 1;
          dispatchedBytes += declared;
          const started: Promise<BlobText | ArchiveRead> = entry.archive && openArchive
            ? openArchive({ scope: scan.scope, sha: entry.sha, path: entry.path, token, transport })
            : reader.readBlob({ scope: scan.scope, sha: entry.sha, path: entry.path, token, transport });
          treeReads.push({ entry, settled: settle(started) });
        }
      };

      await fill();
      while (treeReads.length) {
        /*
         * Yield first. A budget check that runs before the loop has handed
         * control back is a budget check inside a block that has already
         * stalled the process.
         */
        await yieldToEventLoop();
        const taken = treeReads.shift();
        if (!taken) break;
        const { entry, settled } = taken;
        const outcome = await settled;
        if ('error' in outcome) throw outcome.error;
        const blob = outcome.value;
        const blobText = 'text' in blob ? blob.text : undefined;
        if (entry.archive && canOpenArchives && !blob.skip && 'members' in blob && Array.isArray(blob.members)) {
          /* An archive that opened counts as a file read; what is inside it
             is counted separately, so the tree's numbers still add up. */
          filesScanned += 1;
          if (!(await admitArchive(blob, IN_TREE, commitSha))) { dispatching = false; break; }
        } else if (blob.skip || typeof blobText !== 'string') {
          skippedAny = true;
          countSkip(entry.archive && !canOpenArchives ? SKIP_BINARY : blob.skip);
        } else {
          /*
           * Counted only when text was actually scanned, so a report's numbers
           * add up: read, plus binary, plus other, plus any a ceiling stopped
           * before, is the whole tree.
           */
          const detection = scanText(blobText);
          if (!detection) { dispatching = false; break; }
          filesScanned += 1;
          /*
           * `buildFindings` returns the sanitized findings and, separately, the
           * probes that carry the bytes. Only the findings are used here: a
           * background job has no per-candidate authorization to verify
           * anything, so the probes are simply dropped and go out of scope with
           * this iteration.
           */
          if (detection.candidates.length && !(await admit(detection, entry.path, IN_TREE))) {
            dispatching = false;
            break;
          }
        }
        await fill();
      }
      /* Files the scan never started, because a ceiling came first. */
      if (next < entries.length) skippedAny = true;
      treeReads.length = 0;

      /*
       * History, after the tree: the current files are what a reader acts on
       * first, so a scan that runs out of time has read those. Oldest commit
       * first, so the first sighting of a credential is the commit that
       * introduced it; each commit's changes read ahead with the same bounded
       * concurrency and consumed in order.
       */
      const listHistory = typeof reader.listCommits === 'function' ? reader.listCommits.bind(reader) : null;
      const readChanges = typeof reader.readCommitChanges === 'function' ? reader.readCommitChanges.bind(reader) : null;
      if (history && listHistory && readChanges && budgetReason !== 'finding-limit' && !outOfTime()) {
        await checkAccess();
        let listing: Awaited<ReturnType<typeof listCommits>> | null;
        try {
          listing = await listHistory({
            scope: scan.scope, commitSha, token, transport,
            maxCommits: budgets.maxCommits, beforePage: beforeHistoryPage
          });
        } catch (error) {
          const reason = errorCode(error) === 'EXPOSURE_TIME_LIMIT' ? 'time-limit'
            : errorCode(error) === 'EXPOSURE_RATE_LIMITED' ? 'rate-limited' : null;
          if (!reason) throw error;
          listing = null;
          skippedAny = true;
          budgetReason = budgetReason || reason;
        }
        if (listing) {
          if (listing.truncated) {
            skippedAny = true;
            budgetReason = budgetReason || 'commit-limit';
          }
          const commits = listing.commits.slice().reverse();
          commitsTotal = commits.length;
          let cursor = 0;
          let historyDispatching = true;
          let blobReads = 0;
          const historyFill = async (): Promise<void> => {
            while (historyDispatching && historyReads.length < budgets.readConcurrency && cursor < commits.length) {
              if (outOfTime()) {
                budgetReason = budgetReason || 'time-limit';
                skippedAny = true;
                historyDispatching = false;
                break;
              }
              await checkAccessIfDue();
              const item = commits[cursor];
              if (!item) break;
              cursor += 1;
              dispatchedSinceCheck += 1;
              /* Merge conflict resolutions can introduce bytes in neither
                 parent. Read the provider's first-parent diff for merges too. */
              const started = readChanges({
                scope: scan.scope, sha: item.sha, token, transport, beforePage: beforeHistoryPage
              });
              historyReads.push({ settled: settle(started) });
            }
          };

          /* A change the provider sent without a patch, read from its blob. */
          const admitWholeFile = async (file: ChangedFile, provenance: Provenance, commit: string): Promise<boolean> => {
            if (!file.blobSha) { skippedAny = true; return true; }
            const kind = archiveKind(file.path);
            const pathDetection = detectInPath({ path: file.path, sha: file.blobSha });
            if (pathDetection.candidates.length) return admit(pathDetection, file.path, provenance, commit);
            if (blobReads >= budgets.maxHistoryBlobReads) { skippedAny = true; return true; }
            if (kind && openArchive) {
              blobReads += 1;
              await checkAccessIfDue();
              const opened = await openArchive({ scope: scan.scope, sha: file.blobSha, path: file.path, token, transport });
              if (opened.skip || !Array.isArray(opened.members)) { skippedAny = true; return true; }
              return admitArchive(opened, provenance, commit);
            }
            /* Binary by name: nothing a text rule could read, in history or now. */
            if (kind || BINARY_EXTENSIONS.has(extensionOf(file.path))) return true;
            blobReads += 1;
            await checkAccessIfDue();
            const blob = await reader.readBlob({ scope: scan.scope, sha: file.blobSha, path: file.path, token, transport });
            if (blob.skip === SKIP_BINARY) return true;
            if (blob.skip || typeof blob.text !== 'string') { skippedAny = true; return true; }
            const detection = scanText(blob.text);
            if (!detection) return false;
            return detection.candidates.length ? admit(detection, file.path, provenance, commit) : true;
          };

          await historyFill();
          while (historyReads.length) {
            await yieldToEventLoop();
            const taken = historyReads.shift();
            if (!taken) break;
            const outcome = await taken.settled;
            if ('error' in outcome) {
              const reason = errorCode(outcome.error) === 'EXPOSURE_TIME_LIMIT' ? 'time-limit'
                : errorCode(outcome.error) === 'EXPOSURE_RATE_LIMITED' ? 'rate-limited' : null;
              if (reason) {
                /* Preserve completed work when a deadline or throttle stops history. */
                skippedAny = true;
                budgetReason = budgetReason || reason;
                historyDispatching = false;
                historyReads.length = 0;
                break;
              }
              throw outcome.error;
            }
            const changes = outcome.value;
            if (changes.skip) {
              commitsSkipped += 1;
              skippedAny = true;
              await historyFill();
              continue;
            }
            if (changes.truncated || changes.unsafePaths) skippedAny = true;
            const provenance: Provenance = Object.freeze({
              inTree: false, introducedCommit: changes.sha, introducedAt: changes.committedAt || null
            });
            let keepGoing = true;
            for (const file of changes.files) {
              if (outOfTime()) {
                skippedAny = true;
                budgetReason = budgetReason || 'time-limit';
                keepGoing = false;
                break;
              }
              const hunks: readonly Hunk[] | null = Array.isArray(file.hunks) ? file.hunks : null;
              if (hunks) {
                /* Context participates in detection too, so charge all bytes
                   handed to the detector, before it sees them. */
                const size = hunks.reduce((total, hunk) => total +
                  (hunk.lines.some(line => line.added)
                    ? Buffer.byteLength(hunk.lines.map(line => String(line.text || '')).join('\n'), 'utf8') : 0), 0);
                if (!reserveBytes(size)) { keepGoing = false; break; }
                const detection = detectInHunks({ hunks, maxDecodedBytes: budgets.maxBytes - bytesScanned });
                bytesScanned += detection.decodedBytes || 0;
                if (detection.truncated) skippedAny = true;
                if (detection.candidates.length && !(await admit(detection, file.path, provenance, changes.sha))) {
                  keepGoing = false;
                  break;
                }
              } else if (!(await admitWholeFile(file, provenance, changes.sha))) {
                keepGoing = false;
                break;
              }
            }
            if (!keepGoing) { historyDispatching = false; historyReads.length = 0; break; }
            commitsScanned += 1;
            await historyFill();
          }
          commitsSkipped = commitsTotal - commitsScanned;
          if (commitsSkipped) skippedAny = true;
        }
      } else if (history) {
        /* Every requested but unstarted stage is incomplete, including the
           deadline crossing while the last tree response arrives. */
        skippedAny = true;
        if (outOfTime()) budgetReason = budgetReason || 'time-limit';
      }

      await flush();
      await checkAccess();
      if (outOfTime() && next < entries.length) {
        skippedAny = true;
        budgetReason = budgetReason || 'time-limit';
      }
      const complete = !skippedAny && !budgetReason;
      await finalize(scan, claimOwner, {
        state: complete ? 'complete' : 'partial',
        coverage: complete ? 'complete' : 'partial',
        /*
         * A ceiling names itself; anything else that was not read is
         * `unreadable-files`. Either way the coverage is partial, which is the
         * part that matters: nothing here can report a repository as fully
         * read when it was not.
         */
        skippedReason: complete ? null : (budgetReason || 'unreadable-files'),
        filesScanned,
        bytesScanned,
        filesTotal,
        filesSkippedBinary,
        filesSkippedOther,
        commitsTotal: history ? commitsTotal : null,
        commitsScanned: history ? commitsScanned : null,
        commitsSkipped: history ? commitsSkipped : null,
        archivesScanned,
        archiveMembersScanned
      });
      return Object.freeze({
        claimed: true, state: complete ? 'complete' : 'partial', filesScanned, bytesScanned,
        ...(history ? { commitsScanned } : {})
      });
    } catch (error) {
      if (errorCode(error) === 'EXPOSURE_SCAN_NOT_OWNED') {
        return Object.freeze({ claimed: true, stopped: 'claim-lost' });
      }
      if (errorCode(error) === 'EXPOSURE_AUTHORIZATION_REVOKED') {
        /*
         * The session went away mid-scan. Stop, record it as that rather than
         * as a transport problem, and do not retry -- a retry would be holding
         * a revoked credential in the hope it comes back.
         */
        await finalize(scan, claimOwner, {
          state: 'failed', coverage: 'unknown', skippedReason: 'authorization-revoked',
          filesScanned, bytesScanned
        });
        return Object.freeze({ claimed: true, stopped: 'authorization-revoked' });
      }
      if (errorCode(error).startsWith('EXPOSURE_')) {
        await finalize(scan, claimOwner, {
          state: 'failed', coverage: 'unknown', skippedReason: 'transport-refused',
          filesScanned, bytesScanned
        });
        return Object.freeze({ claimed: true, stopped: 'read-failed' });
      }
      /*
       * Anything else is not this file's to interpret, and it is deliberately
       * not finalised: a scan left running is one a lease expiry will hand to
       * another worker, which is the right outcome for a fault nobody
       * understands yet. Recording it as failed would retire a job that might
       * simply have hit a bug worth fixing.
       */
      throw error;
    } finally {
      /* Reads still in flight finish into nothing, and no socket outlives
         the scan. */
      treeReads.length = 0;
      historyReads.length = 0;
      if (connections && typeof connections.close === 'function') {
        try { connections.close(); } catch { /* closing is best effort */ }
      }
    }
  }

  async function finalize(scan: ScanRecord, claimOwner: string, outcome: ScanOutcome): Promise<void> {
    try {
      await store.finalizeScan({ scanId: scan.scanId, claimOwner, now: now(), ...outcome });
    } catch (error) {
      /*
       * A finalize that fails because the claim is gone is not an error: the
       * owner cancelled, or the lease expired and somebody else owns this now.
       * Anything else is real.
       */
      if (errorCode(error) !== 'EXPOSURE_SCAN_NOT_OWNED') throw error;
    }
  }

  return Object.freeze({ budgets, runOnce });
}

/*
 * The loop. One scan at a time in one process, because the caps above are
 * sized for one and two concurrent scans would spend twice the budget the
 * service has.
 */
export type ExposureRunner = ReturnType<typeof createExposureRunner>;
type RunResult = Awaited<ReturnType<ExposureRunner['runOnce']>>;

export function startExposureWorker(options: ExposureWorkerOptions = {}) {
  const runner = createExposureRunner(options);
  const intervalMs = boundedInteger(options.intervalMs, 15_000, 250, 10 * 60 * 1000);
  const stats = { started: 0, completed: 0, failed: 0 };
  let stopped = false;
  let inFlight: Promise<RunResult> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function run() {
    if (stopped) return Object.freeze({ stopped: true });
    if (inFlight) return Object.freeze({ busy: true });
    stats.started += 1;
    inFlight = runner.runOnce();
    try {
      const result = await inFlight;
      if (result && result.claimed) stats.completed += 1;
      return result;
    } catch (error) {
      stats.failed += 1;
      throw error;
    } finally {
      inFlight = null;
    }
  }

  /*
   * After a run that found work, look again almost at once: a queue of scans
   * should drain one after another, not one per poll interval. An idle tick
   * waits the full interval, so an empty queue costs one query per interval.
   */
  function schedule(delayMs: number = intervalMs): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      let claimed = false;
      try {
        const result = await run();
        claimed = Boolean(result && 'claimed' in result && result.claimed);
      } catch { /* the next tick tries again */ }
      schedule(claimed ? Math.min(250, intervalMs) : intervalMs);
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  if (options.autoStart !== false) schedule();

  /*
   * Stopping returns what is in flight so shutdown can await it. A scan
   * abandoned mid-write is recoverable -- its lease expires and another worker
   * reclaims it -- but finishing the one in hand is cheaper than redoing it.
   */
  function stop(): Promise<unknown> {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    return inFlight || Promise.resolve();
  }

  return Object.freeze({ run, stop, stats: () => Object.freeze({ ...stats }) });
}
