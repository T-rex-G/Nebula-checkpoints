'use strict';

const { detectInHunks, detectInPath, detectInText, RULES_VERSION, DETECTION_ENGINE_VERSION } = require('./exposure-detection');
const { archiveKind } = require('./exposure-archives');
const { BINARY_EXTENSIONS, extensionOf } = require('./exposure-reader');
const { buildFindings, fingerprintKeyId, FINGERPRINT_KEY_VERSION } = require('./exposure-findings');
const { MAX_FINDINGS_PER_SCAN, EXPOSURE_CONFIG_VERSION } = require('./exposure-store');

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

/*
 * The measured caps a scan runs under. They are part of a finding's identity
 * through the scan's config version, because a finding produced under a
 * 200-file ceiling is not comparable with one produced under a 20,000-file
 * ceiling -- the second scan looked where the first never did, so comparing
 * them would report credentials that were always there as newly appeared.
 * Changing any number here moves EXPOSURE_BUDGET_VERSION and, with it, the
 * config version a scan records.
 */
/*
 * 2: binary formats are recognised by name and never fetched, and the byte
 * ceiling is charged at the size the tree declares when a read is started
 * rather than after it lands -- so which file the ceiling falls on no longer
 * depends on which reads happened to finish first.
 */
/*
 * 3: history is read under a commit ceiling and a ceiling on the blobs read
 * for changes the provider sent no patch for, archives are opened, and the
 * wall clock is twice as long to fit both.
 */
const EXPOSURE_BUDGET_VERSION = 3;

const DEFAULT_BUDGETS = Object.freeze({
  /* Files read per scan. The tree may hold more; this is what gets opened. */
  maxFiles: 2_000,
  /* Total decoded bytes scanned, so a repository of large text files cannot
     cost more than one of many small ones. */
  maxBytes: 32 * 1024 * 1024,
  /* Wall clock, because this process also answers HTTP and a scan is the
     slowest thing it does. History doubled what a scan reads, so it doubled. */
  maxWallClockMs: 8 * 60 * 1000,
  /* Commits whose changes a history scan reads, newest back. Past it the
     scan is partial and says `commit-limit`. */
  maxCommits: 1_000,
  /* A change the provider sent without a patch -- too large, or binary -- is
     read from its blob instead. Bounded separately, because a history of
     large generated files would otherwise be a blob read per commit. */
  maxHistoryBlobReads: 200,
  /* Findings buffered before a write. Bounded by what the store will take in
     one call. */
  flushEveryFindings: 100,
  /* How often the lease is renewed, which is also how often a cancellation is
     noticed. Small enough that a cancel is acted on quickly, large enough that
     a scan is not mostly database round trips. */
  renewEveryFiles: 25,
  /*
   * And the same check on a clock, so a scan of large files still notices a
   * cancel or a revoked session within a few seconds rather than within
   * twenty-five files. The two together replace a check before and after every
   * single file -- a lease write and a full session resolution each time --
   * which was most of what a scan spent its time on.
   */
  accessCheckIntervalMs: 5_000,
  /*
   * Reads in flight at once. A blob is a few hundred bytes and a round trip is
   * most of its cost, so a handful in parallel is most of the speed; more than
   * that is impolite to the provider and buys little. Results are consumed in
   * tree order whatever order they arrive in, so a scan with the same inputs
   * makes the same decisions.
   */
  readConcurrency: 6
});

const COMMIT_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_ARCHIVES_IN_FLIGHT = 2;
/* The reader's word for a file that is not text, spelled once here rather than
   requiring the reader -- the worker receives a reader, it does not pick one. */
const SKIP_BINARY = 'binary';

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function budgetsFrom(input) {
  const source = input && typeof input === 'object' ? input : {};
  return Object.freeze({
    maxFiles: boundedInteger(source.maxFiles, DEFAULT_BUDGETS.maxFiles, 1, 100_000),
    /*
     * The floors are 1, not a comfortable minimum. A caller asking for a tiny
     * budget gets a tiny budget and a scan that reports partial coverage --
     * which is visible. Silently raising a configured ceiling to something
     * this file preferred would produce a scan that read more than it was
     * told to, and nobody reading the configuration would know.
     */
    maxBytes: boundedInteger(source.maxBytes, DEFAULT_BUDGETS.maxBytes, 1, 512 * 1024 * 1024),
    maxWallClockMs: boundedInteger(source.maxWallClockMs, DEFAULT_BUDGETS.maxWallClockMs, 0, 30 * 60 * 1000),
    maxCommits: boundedInteger(source.maxCommits, DEFAULT_BUDGETS.maxCommits, 1, 100_000),
    maxHistoryBlobReads: boundedInteger(source.maxHistoryBlobReads, DEFAULT_BUDGETS.maxHistoryBlobReads, 0, 10_000),
    flushEveryFindings: boundedInteger(
      source.flushEveryFindings, DEFAULT_BUDGETS.flushEveryFindings, 1, MAX_FINDINGS_PER_SCAN
    ),
    renewEveryFiles: boundedInteger(source.renewEveryFiles, DEFAULT_BUDGETS.renewEveryFiles, 1, 1000),
    accessCheckIntervalMs: boundedInteger(
      source.accessCheckIntervalMs, DEFAULT_BUDGETS.accessCheckIntervalMs, 250, 60_000
    ),
    readConcurrency: boundedInteger(source.readConcurrency, DEFAULT_BUDGETS.readConcurrency, 1, 16)
  });
}

/*
 * Hand the event loop back between files. This process serves HTTP while it
 * scans, and a loop that reads two thousand blobs without yielding is a loop
 * that stops answering requests for as long as it runs. `setImmediate` runs
 * after I/O callbacks, so a pending response is written before the next file
 * is opened.
 */
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

function errorCode(error) {
  return String((error && error.code) || '');
}

function createExposureRunner(options = {}) {
  const store = options.store;
  const reader = options.reader;
  if (!store || typeof store.claimScan !== 'function') throw new TypeError('An exposure runner requires a store');
  if (!reader || typeof reader.readTree !== 'function' || typeof reader.readBlob !== 'function') {
    throw new TypeError('An exposure runner requires a provider reader');
  }
  const sessionResolver = options.sessionResolver;
  if (typeof sessionResolver !== 'function') {
    throw new TypeError('An exposure runner requires a session resolver');
  }
  const fingerprintKey = options.fingerprintKey;
  if (!Buffer.isBuffer(fingerprintKey) && typeof fingerprintKey !== 'string') {
    throw new TypeError('An exposure runner requires a derived fingerprint key');
  }
  const budgets = budgetsFrom(options.budgets);
  const now = typeof options.now === 'function' ? options.now : Date.now;
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
    if (!COMMIT_PATTERN.test(commitSha)) {
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
    let session;
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
    let budgetReason = null;
    let pending = [];
    /* Credentials, not sightings: one seen in the tree and in the commit that
       added it is one credential against the ceiling. */
    const seenFingerprints = new Set();
    /* What was not read, and why, so a report can say so in numbers. */
    let filesTotal = 0;
    let filesSkippedBinary = 0;
    let filesSkippedOther = 0;
    let archivesScanned = 0;
    let archiveMembersScanned = 0;
    const history = scan.scanMode === 'history';
    let commitsTotal = history ? 0 : null;
    let commitsScanned = history ? 0 : null;
    let commitsSkipped = history ? 0 : null;
    let lastCheckAt = 0;
    let dispatchedSinceCheck = 0;

    async function checkAccess() {
      const held = await store.renewClaim({ scanId: scan.scanId, claimOwner, leaseMs, now: now() });
      if (!held) {
        throw Object.assign(new Error('Scan claim is no longer held'), { code: 'EXPOSURE_SCAN_NOT_OWNED' });
      }
      let current;
      try {
        current = await sessionResolver({ scope: scan.scope, requestedBy: scan.requestedBy, scanId: scan.scanId });
      } catch { current = null; }
      if (!current || !current.token) {
        throw Object.assign(new Error('Scan authorization was revoked'), { code: 'EXPOSURE_AUTHORIZATION_REVOKED' });
      }
      token = current.token;
      lastCheckAt = now();
      dispatchedSinceCheck = 0;
    }

    /*
     * Before a read is started, the check is due every `renewEveryFiles` reads
     * or every `accessCheckIntervalMs`, whichever comes first. A cancel or a
     * revoked session is noticed within that bound, and no read is ever started
     * after one has been noticed. Every write still checks unconditionally.
     */
    async function checkAccessIfDue() {
      if (dispatchedSinceCheck >= budgets.renewEveryFiles
        || now() - lastCheckAt >= budgets.accessCheckIntervalMs) {
        await checkAccess();
      }
    }

    function countSkip(reason) {
      if (reason === SKIP_BINARY) filesSkippedBinary += 1;
      else filesSkippedOther += 1;
    }

    async function flush() {
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
    async function admit(detection, filePath, provenance, commit = commitSha) {
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

    function outOfTime() {
      return now() - startedAt >= budgets.maxWallClockMs;
    }

    const connections = createTransport ? createTransport() : null;
    const transport = connections && typeof connections.request === 'function' ? connections.request : undefined;
    /* Reads already started when the scan stops. Each is wrapped so it can
       never reject unobserved; they are simply not looked at. */
    const inflight = [];
    const canOpenArchives = typeof reader.readArchive === 'function';
    const IN_TREE = Object.freeze({ inTree: true });

    /*
     * An archive's files, each scanned as a file of its own and located inside
     * it; the credential containers in it found by name. Anything it could not
     * read makes the scan partial, like a file in the tree would.
     */
    async function admitArchive(opened, provenance, commit) {
      archivesScanned += 1;
      if (opened.truncated || opened.membersSkipped) skippedAny = true;
      for (const member of opened.members) {
        archiveMembersScanned += 1;
        bytesScanned += Buffer.byteLength(member.text, 'utf8');
        const detection = detectInText({ text: member.text, path: member.path });
        if (!detection.scanned || detection.truncated) skippedAny = true;
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
      const skipped = Array.isArray(tree.skipped) ? tree.skipped : [];
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

      const fill = async () => {
        while (dispatching && inflight.length < budgets.readConcurrency && next < entries.length) {
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
          /*
           * An archive read holds its response, its bytes and what it inflates
           * to at once -- tens of megabytes at the ceilings -- so no more than
           * two are in flight on a service with half a gigabyte. The next one
           * waits for an earlier read to be consumed; nothing is skipped.
           */
          if (entry.archive && canOpenArchives
            && inflight.filter(item => item.entry.archive).length >= MAX_ARCHIVES_IN_FLIGHT) {
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
          const read = entry.archive && canOpenArchives
            ? reader.readArchive({ scope: scan.scope, sha: entry.sha, path: entry.path, token, transport })
            : reader.readBlob({ scope: scan.scope, sha: entry.sha, path: entry.path, token, transport });
          inflight.push({ entry, settled: Promise.resolve(read).then(blob => ({ blob }), error => ({ error })) });
        }
      };

      await fill();
      while (inflight.length) {
        /*
         * Yield first. A budget check that runs before the loop has handed
         * control back is a budget check inside a block that has already
         * stalled the process.
         */
        await yieldToEventLoop();
        const { entry, settled } = inflight.shift();
        const outcome = await settled;
        if (outcome.error) throw outcome.error;
        const blob = outcome.blob;
        if (entry.archive && canOpenArchives && !blob.skip && Array.isArray(blob.members)) {
          /* An archive that opened counts as a file read; what is inside it
             is counted separately, so the tree's numbers still add up. */
          filesScanned += 1;
          if (!(await admitArchive(blob, IN_TREE, commitSha))) { dispatching = false; break; }
        } else if (blob.skip || typeof blob.text !== 'string') {
          skippedAny = true;
          countSkip(entry.archive && !canOpenArchives ? SKIP_BINARY : blob.skip);
        } else {
          /*
           * Counted only when text was actually scanned, so a report's numbers
           * add up: read, plus binary, plus other, plus any a ceiling stopped
           * before, is the whole tree.
           */
          filesScanned += 1;
          bytesScanned += Buffer.byteLength(blob.text, 'utf8');
          const detection = detectInText({ text: blob.text, path: entry.path });
          if (!detection.scanned || detection.truncated) skippedAny = true;
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
      inflight.length = 0;

      /*
       * History, after the tree: the current files are what a reader acts on
       * first, so a scan that runs out of time has read those. Oldest commit
       * first, so the first sighting of a credential is the commit that
       * introduced it; each commit's changes read ahead with the same bounded
       * concurrency and consumed in order.
       */
      const historyReadable = typeof reader.listCommits === 'function' && typeof reader.readCommitChanges === 'function';
      if (history && historyReadable && budgetReason !== 'finding-limit' && !outOfTime()) {
        await checkAccess();
        let listing;
        try {
          listing = await reader.listCommits({
            scope: scan.scope, commitSha, token, transport,
            maxCommits: budgets.maxCommits, stopAt: scan.historyBaseCommit || ''
          });
        } catch (error) {
          if (errorCode(error) !== 'EXPOSURE_RATE_LIMITED') throw error;
          listing = null;
          skippedAny = true;
          budgetReason = budgetReason || 'rate-limited';
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
          const historyFill = async () => {
            while (historyDispatching && inflight.length < budgets.readConcurrency && cursor < commits.length) {
              if (outOfTime()) {
                budgetReason = budgetReason || 'time-limit';
                skippedAny = true;
                historyDispatching = false;
                break;
              }
              await checkAccessIfDue();
              const item = commits[cursor];
              cursor += 1;
              dispatchedSinceCheck += 1;
              /* A merge's changes are its parents' changes, already read. */
              const read = item.parents > 1
                ? Promise.resolve({ merge: true })
                : reader.readCommitChanges({ scope: scan.scope, sha: item.sha, token, transport });
              inflight.push({ entry: item, settled: Promise.resolve(read).then(blob => ({ blob }), error => ({ error })) });
            }
          };

          /* A change the provider sent without a patch, read from its blob. */
          const admitWholeFile = async (file, provenance, commit) => {
            if (!file.blobSha) { skippedAny = true; return true; }
            const kind = archiveKind(file.path);
            const pathDetection = detectInPath({ path: file.path, sha: file.blobSha });
            if (pathDetection.candidates.length) return admit(pathDetection, file.path, provenance, commit);
            if (blobReads >= budgets.maxHistoryBlobReads) { skippedAny = true; return true; }
            if (kind && canOpenArchives) {
              blobReads += 1;
              await checkAccessIfDue();
              const opened = await reader.readArchive({ scope: scan.scope, sha: file.blobSha, path: file.path, token, transport });
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
            bytesScanned += Buffer.byteLength(blob.text, 'utf8');
            const detection = detectInText({ text: blob.text, path: file.path });
            if (!detection.scanned || detection.truncated) skippedAny = true;
            return detection.candidates.length ? admit(detection, file.path, provenance, commit) : true;
          };

          await historyFill();
          while (inflight.length) {
            await yieldToEventLoop();
            const { entry: item, settled } = inflight.shift();
            const outcome = await settled;
            if (outcome.error) {
              if (errorCode(outcome.error) === 'EXPOSURE_RATE_LIMITED') {
                /* The provider asked us to stop. What was read is kept. */
                skippedAny = true;
                budgetReason = budgetReason || 'rate-limited';
                historyDispatching = false;
                inflight.length = 0;
                break;
              }
              throw outcome.error;
            }
            const changes = outcome.blob;
            if (changes.merge) { commitsScanned += 1; await historyFill(); continue; }
            if (changes.skip) {
              commitsSkipped += 1;
              skippedAny = true;
              await historyFill();
              continue;
            }
            commitsScanned += 1;
            if (changes.truncated || changes.unsafePaths) skippedAny = true;
            const provenance = Object.freeze({
              inTree: false, introducedCommit: changes.sha, introducedAt: changes.committedAt || null
            });
            let keepGoing = true;
            for (const file of changes.files) {
              if (Array.isArray(file.hunks)) {
                const detection = detectInHunks({ hunks: file.hunks });
                for (const hunk of file.hunks) {
                  for (const line of hunk.lines) if (line.added) bytesScanned += Buffer.byteLength(line.text, 'utf8') + 1;
                }
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
            if (!keepGoing) { historyDispatching = false; inflight.length = 0; break; }
            await historyFill();
          }
          if (cursor < commits.length) skippedAny = true;
        }
      } else if (history && !historyReadable) {
        skippedAny = true;
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
        commitsTotal,
        commitsScanned,
        commitsSkipped,
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
      inflight.length = 0;
      if (connections && typeof connections.close === 'function') {
        try { connections.close(); } catch { /* closing is best effort */ }
      }
    }
  }

  async function finalize(scan, claimOwner, outcome) {
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
function startExposureWorker(options = {}) {
  const runner = createExposureRunner(options);
  const intervalMs = boundedInteger(options.intervalMs, 15_000, 250, 10 * 60 * 1000);
  const stats = { started: 0, completed: 0, failed: 0 };
  let stopped = false;
  let inFlight = null;
  let timer = null;

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
  function schedule(delayMs = intervalMs) {
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
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    return inFlight || Promise.resolve();
  }

  return Object.freeze({ run, stop, stats: () => Object.freeze({ ...stats }) });
}

module.exports = Object.freeze({
  DEFAULT_BUDGETS,
  EXPOSURE_BUDGET_VERSION,
  createExposureRunner,
  startExposureWorker
});
