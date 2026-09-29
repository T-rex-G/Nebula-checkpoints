'use strict';

/*
 * The analysis half of a repository audit, on a worker thread.
 *
 * Reading a branch waits on the network and stays on the main thread.
 * Analysing it is pure computation, and it used to run there too: on a small
 * instance that held the event loop for most of a minute, the platform's
 * health check went unanswered, and the service was restarted in the middle
 * of the audit -- which the browser saw as a 502 from the edge, then a 429,
 * then a challenge page. On a worker the main thread keeps answering.
 *
 * The worker is bounded three ways:
 *
 *   - its heap is capped, so a repository too large for the instance fails
 *     the worker and not the process. The cap is set on the worker and also
 *     watched from here, because a process-wide --max-old-space-size (in
 *     NODE_OPTIONS, say) overrides a worker's own limit;
 *   - tracing stops starting new files at a soft deadline or past a heap
 *     ceiling below the cap, server code first, and the coverage ledger
 *     names what was left to the rules;
 *   - a hard deadline terminates the worker outright.
 *
 * A worker stopped by its heap or its hard deadline is answered by a second,
 * cheaper run that checks every file against the rules without tracing, and
 * the ledger says so. Only a failure of that run fails the audit.
 *
 * One analysis runs at a time: two at once would double the memory the
 * instance has to find, and the second would not finish sooner. The queue
 * is short and bounded; each waiting audit is told it is waiting.
 *
 * Nothing crosses the boundary but paths and text going in and the result
 * coming out. The worker writes nothing, logs nothing, and an error from it
 * is replaced by a fixed message: an exception can quote the text it was
 * reading, and that text is the customer's source.
 */

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const KIND = 'nv-code-audit';

const BUDGET = Object.freeze({
  /* The analysis of a 12 MB branch peaks near 160 MB of heap; the rest is headroom under a 512 MB instance. */
  heapMb: 224,
  youngMb: 32,
  /* No file is started after this; files already started finish. */
  traceMs: 45_000,
  /* Nor past this share of the heap cap: tracing stops before the worker is stopped. */
  traceHeapShare: 0.7,
  /* How often the heap is read from this side. */
  watchMs: 250,
  /* The worker is terminated after this, whatever it is doing. */
  hardMs: 120_000,
  /* The rules-only run reads every file once, without tracing. */
  fallbackMs: 90_000,
  /* Audits waiting for the one running analysis. */
  queue: 8,
  /* One batch of the rules-only pass beyond the traced set. */
  rulesMs: 60_000
});

/*
 * The least heap a worker is ever started with. Below a few megabytes V8
 * cannot build the isolate at all, and that failure aborts the whole
 * process rather than the worker; a smaller budget is enforced by the watch
 * alone.
 */
const HEAP_FLOOR_MB = 64;

class AuditLimitError extends Error {
  constructor(limit) {
    super(limit === 'memory'
      ? 'The repository needed more memory than this server gives one audit.'
      : 'The analysis ran past the time this server gives one audit.');
    this.name = 'AuditLimitError';
    this.limit = limit;
  }
}

function publicFailure(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.providerChanged = false;
  error.safeState = 'Nothing was changed. The audit only reads.';
  return error;
}

/* Run once in a worker: analyse what the main thread read, post the result, exit. */
function runInWorker() {
  const { analyse, scanRules } = require('./code-audit');
  const { files, paths, registry, advisories, licences, intel, trace, extra, mode } = workerData;
  /* The rules alone, for a batch beyond the traced set: findings and flags out, no text. */
  if (mode === 'rules') {
    parentPort.postMessage({ result: scanRules(files) });
    return;
  }
  const bounded = trace && trace.skip
    ? { skip: trace.skip }
    : { deadline: Date.now() + Math.max(0, Number(trace && trace.traceMs) || 0), heapCeiling: Number(trace && trace.heapCeiling) || Infinity };
  const result = analyse({ files, paths, registry, advisories, licences: licences || null, intel, trace: bounded, extra: extra || null });
  parentPort.postMessage({ result });
}

/*
 * One worker run. Resolves with the result; rejects with an AuditLimitError
 * when the heap or the hard deadline stopped it, or with a fixed failure for
 * anything else. `spawn` is the Worker constructor, replaceable in tests.
 */
function runWorker(input, trace, hardMs, budget, spawn = Worker) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (worker) worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new AuditLimitError('time')), hardMs);
    /* The heap, read from outside: a busy worker still answers, and one past its cap is stopped. */
    const cap = budget.heapMb * 1024 * 1024;
    const watch = setInterval(() => {
      if (!worker || typeof worker.getHeapStatistics !== 'function') return;
      worker.getHeapStatistics()
        .then(stats => { if (stats && stats.used_heap_size > cap) finish(new AuditLimitError('memory')); })
        .catch(() => {});
    }, budget.watchMs);
    try {
      worker = new spawn(__filename, {
        workerData: { kind: KIND, mode: input.mode || 'analyse', files: input.files, paths: input.paths, registry: input.registry, advisories: input.advisories, licences: input.licences || null, intel: input.intel || null, extra: input.extra || null, trace },
        resourceLimits: { maxOldGenerationSizeMb: Math.max(HEAP_FLOOR_MB, budget.heapMb), maxYoungGenerationSizeMb: budget.youngMb, stackSizeMb: 8 }
      });
    } catch {
      finish(publicFailure('AUDIT_ANALYSIS_FAILED', 'The audit could not start its analysis. Run it again.', 503));
      return;
    }
    worker.once('message', message => finish(null, message && message.result));
    worker.once('error', error => finish(error && error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? new AuditLimitError('memory')
      : publicFailure('AUDIT_ANALYSIS_FAILED', 'The analysis stopped on a file it could not read. Run it again; if it stops again, the repository has a file this audit cannot parse.', 500)));
    /* An exit before a message, with no error, is a heap limit reached during teardown or a killed thread. */
    worker.once('exit', () => finish(new AuditLimitError('memory')));
  });
}

let running = 0;
const waiting = [];
function acquire(budget, onQueued) {
  if (running === 0) {
    running = 1;
    return Promise.resolve();
  }
  if (waiting.length >= budget.queue) {
    return Promise.reject(publicFailure('AUDIT_BUSY', 'The server is analysing as many audits as it can hold. Try again in a minute.', 503));
  }
  if (onQueued) onQueued(waiting.length + 1);
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else running = 0;
}

/*
 * Analyse off the main thread. `onStage` hears 'queued' while another
 * analysis holds the worker, 'analysing' when this one starts, and
 * 'patterns' when the first run was stopped and the rules-only run begins.
 */
async function analyseOffThread(input, { budget = BUDGET, onStage = () => {}, spawn = Worker } = {}) {
  await acquire(budget, position => onStage('queued', { position }));
  try {
    onStage('analysing');
    try {
      const heapCeiling = budget.heapMb * budget.traceHeapShare * 1024 * 1024;
      return await runWorker(input, { traceMs: budget.traceMs, heapCeiling }, budget.hardMs, budget, spawn);
    } catch (error) {
      if (!(error instanceof AuditLimitError)) throw error;
      onStage('patterns', { limit: error.limit });
      try {
        return await runWorker(input, { skip: error.limit }, budget.fallbackMs, budget, spawn);
      } catch (fallback) {
        if (!(fallback instanceof AuditLimitError)) throw fallback;
        throw publicFailure('AUDIT_TOO_LARGE', 'This repository is larger than this server can audit in one pass, even without tracing. Audit a smaller branch, or run it on a larger instance.', 503);
      }
    }
  } finally {
    release();
  }
}

/*
 * One batch of the rules-only pass, off the main thread, taking its turn in
 * the same queue as the analyses so two never run at once. A batch stopped by
 * the heap or the clock rejects, and the caller counts its files as unread.
 */
async function scanOffThread(input, { budget = BUDGET, spawn = Worker } = {}) {
  await acquire(budget);
  try {
    return await runWorker({ mode: 'rules', files: input.files }, { skip: 'rules' }, budget.rulesMs, budget, spawn);
  } finally {
    release();
  }
}

if (!isMainThread && workerData && workerData.kind === KIND) runInWorker();

module.exports = Object.freeze({ analyseOffThread, scanOffThread, AuditLimitError, BUDGET });
