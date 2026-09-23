'use strict';

const { detectInText, RULES_VERSION, DETECTION_ENGINE_VERSION } = require('./exposure-detection');
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
const EXPOSURE_BUDGET_VERSION = 1;

const DEFAULT_BUDGETS = Object.freeze({
  /* Files read per scan. The tree may hold more; this is what gets opened. */
  maxFiles: 2_000,
  /* Total decoded bytes scanned, so a repository of large text files cannot
     cost more than one of many small ones. */
  maxBytes: 32 * 1024 * 1024,
  /* Wall clock, because this process also answers HTTP and a scan is the
     slowest thing it does. */
  maxWallClockMs: 4 * 60 * 1000,
  /* Findings buffered before a write. Bounded by what the store will take in
     one call. */
  flushEveryFindings: 100,
  /* How often the lease is renewed, which is also how often a cancellation is
     noticed. Small enough that a cancel is acted on quickly, large enough that
     a scan is not mostly database round trips. */
  renewEveryFiles: 25
});

const COMMIT_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

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
    flushEveryFindings: boundedInteger(
      source.flushEveryFindings, DEFAULT_BUDGETS.flushEveryFindings, 1, MAX_FINDINGS_PER_SCAN
    ),
    renewEveryFiles: boundedInteger(source.renewEveryFiles, DEFAULT_BUDGETS.renewEveryFiles, 1, 1000)
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
    let findingCount = 0;

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
    }

    async function flush() {
      if (!pending.length) return true;
      await checkAccess();
      const batch = pending;
      pending = [];
      await store.recordObservations({ scanId: scan.scanId, claimOwner, findings: batch, now: now() });
      return true;
    }

    try {
      await checkAccess();
      const tree = await reader.readTree({ scope: scan.scope, commitSha, token });
      if (tree.truncated) {
        skippedAny = true;
        budgetReason = tree.skippedReason || 'tree-truncated';
      }
      if (Array.isArray(tree.skipped) && tree.skipped.length) skippedAny = true;

      for (const entry of tree.entries) {
        /*
         * Yield first. A budget check that runs before the loop has handed
         * control back is a budget check inside a block that has already
         * stalled the process.
         */
        await yieldToEventLoop();

        if (filesScanned >= budgets.maxFiles) {
          budgetReason = 'file-count-limit';
          skippedAny = true;
          break;
        }
        if (bytesScanned >= budgets.maxBytes) {
          budgetReason = 'byte-limit';
          skippedAny = true;
          break;
        }
        if (now() - startedAt >= budgets.maxWallClockMs) {
          budgetReason = 'time-limit';
          skippedAny = true;
          break;
        }

        /*
         * The lease renewal is the cancellation signal. It is false when the
         * scan is no longer running under this claim, which is exactly the
         * set of cases where continuing would be writing into somebody else's
         * job or into one its owner has already ended.
         */
        await checkAccess();

        const blob = await reader.readBlob({ scope: scan.scope, sha: entry.sha, path: entry.path, token });
        await checkAccess();
        filesScanned += 1;
        if (blob.skip || typeof blob.text !== 'string') {
          skippedAny = true;
          continue;
        }
        const blobBytes = Buffer.byteLength(blob.text, 'utf8');
        if (bytesScanned + blobBytes > budgets.maxBytes || now() - startedAt >= budgets.maxWallClockMs) {
          skippedAny = true;
          budgetReason = bytesScanned + blobBytes > budgets.maxBytes ? 'byte-limit' : 'time-limit';
          break;
        }
        bytesScanned += blobBytes;

        const detection = detectInText({ text: blob.text, path: entry.path });
        if (!detection.scanned || detection.truncated) skippedAny = true;
        if (!detection.candidates.length) continue;

        /*
         * `buildFindings` returns the sanitized findings and, separately, the
         * probes that carry the bytes. Only the findings are used here: a
         * background job has no per-candidate authorization to verify
         * anything, so the probes are simply dropped and go out of scope with
         * this iteration.
         */
        const built = buildFindings({
          detection, path: entry.path, scope: scan.scope, commit: commitSha, hmacKey: fingerprintKey,
          keyVersion: scan.fingerprintKeyVersion
        });
        const admitted = built.findings.slice(0, MAX_FINDINGS_PER_SCAN - findingCount);
        pending.push(...admitted);
        findingCount += admitted.length;
        if (pending.length >= budgets.flushEveryFindings) await flush();
        if (findingCount >= MAX_FINDINGS_PER_SCAN || admitted.length < built.findings.length) {
          skippedAny = true;
          budgetReason = 'finding-limit';
          break;
        }
      }

      await flush();
      await checkAccess();
      if (now() - startedAt >= budgets.maxWallClockMs) {
        skippedAny = true;
        budgetReason = 'time-limit';
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
        bytesScanned
      });
      return Object.freeze({
        claimed: true, state: complete ? 'complete' : 'partial', filesScanned, bytesScanned
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

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await run(); } catch { /* the next tick tries again */ }
      schedule();
    }, intervalMs);
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
