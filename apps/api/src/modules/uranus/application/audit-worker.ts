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

import { Worker, isMainThread, parentPort, workerData, type ResourceLimits, type WorkerOptions } from 'node:worker_threads';
import { entryFile } from '../../../entrypoint.ts';
import { assertAuditActive } from '../domain/audit-cancellation.ts';
import type { AnalyseInput, AuditFile } from '../domain/code-audit.ts';
import { analyse, scanRules } from './audit-engine.ts';

const KIND = 'nv-code-audit';

export interface WorkerBudget {
  readonly heapMb: number;
  readonly youngMb: number;
  readonly traceMs: number;
  readonly traceHeapShare: number;
  readonly watchMs: number;
  readonly hardMs: number;
  readonly fallbackMs: number;
  readonly queue: number;
  readonly rulesMs: number;
}

export const BUDGET: WorkerBudget = Object.freeze({
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

type Limit = 'memory' | 'time';

export class AuditLimitError extends Error {
  override readonly name = 'AuditLimitError';
  readonly limit: Limit;
  constructor(limit: Limit) {
    super(limit === 'memory'
      ? 'The repository needed more memory than this server gives one audit.'
      : 'The analysis ran past the time this server gives one audit.');
    this.limit = limit;
  }
}

function publicFailure(code: string, message: string, status: number): Error {
  return Object.assign(new Error(message), { code, status, providerChanged: false, safeState: 'Nothing was changed. The audit only reads.' });
}

/* How the first run is bounded, or which bound the rules-only run follows. */
type TraceBound =
  | { readonly traceMs: number; readonly heapCeiling: number }
  | { readonly skip: Limit | 'rules' };
/* What crosses into the worker: paths and text, and the lookups' answers. */
interface WorkerData {
  readonly kind: typeof KIND;
  readonly mode: 'analyse' | 'rules';
  readonly files: readonly AuditFile[];
  readonly paths: AnalyseInput['paths'];
  readonly registry: AnalyseInput['registry'];
  readonly advisories: AnalyseInput['advisories'];
  readonly licences: AnalyseInput['licences'];
  readonly intel: AnalyseInput['intel'];
  readonly extra: AnalyseInput['extra'];
  readonly trace: TraceBound;
}
type WorkerInput = Partial<AnalyseInput> & { readonly files: readonly AuditFile[]; readonly mode?: 'analyse' | 'rules' };
/*
 * What a run hands back: the analysis, or a rules-only batch's scan, as the
 * worker posted it. It crosses a thread boundary by structured clone, so it
 * is what was posted, not a typed value this side can vouch for.
 */
export type WorkerResult = unknown;

/* Run once in a worker: analyse what the main thread read, post the result, exit. */
function runInWorker(data: WorkerData): void {
  const { files, paths, registry, advisories, licences, intel, trace, extra, mode } = data;
  /* The rules alone, for a batch beyond the traced set: findings and flags out, no text. */
  if (mode === 'rules') {
    parentPort?.postMessage({ result: scanRules(files) });
    return;
  }
  /* A memory or time limit leaves tracing to the rules; the rules-only bound is never posted to an analysis. */
  const bounded = 'skip' in trace
    ? { skip: trace.skip === 'rules' ? null : trace.skip }
    : { deadline: Date.now() + Math.max(0, Number(trace.traceMs) || 0), heapCeiling: Number(trace.heapCeiling) || Infinity };
  const result = analyse({ files, paths, registry, advisories, licences: licences || null, intel, trace: bounded, extra: extra || null });
  parentPort?.postMessage({ result });
}

/* The part of a worker thread a run uses: replaceable in tests. */
export interface AuditThread {
  terminate(): Promise<number>;
  getHeapStatistics?(): Promise<{ readonly used_heap_size: number }>;
  once(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'error', listener: (error: unknown) => void): unknown;
  once(event: 'exit', listener: () => void): unknown;
}
export type AuditThreadSpawn = new (filename: string, options: WorkerOptions) => AuditThread;

/* The one field a worker posts: what it computed. */
function resultOf(message: unknown): WorkerResult {
  return typeof message === 'object' && message !== null && 'result' in message ? message.result : undefined;
}

/*
 * One worker run. Resolves with the result; rejects with an AuditLimitError
 * when the heap or the hard deadline stopped it, or with a fixed failure for
 * anything else. `spawn` is the Worker constructor, replaceable in tests.
 */
function runWorker(input: WorkerInput, trace: TraceBound, hardMs: number, budget: WorkerBudget, spawn: AuditThreadSpawn = Worker, signal?: AbortSignal | null): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    assertAuditActive(signal);
    let settled = false;
    let worker: AuditThread | undefined;
    const finish = (error: unknown, result?: WorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (signal) signal.removeEventListener('abort', abort);
      /* The next queued audit starts only after this thread has actually stopped. */
      const stopped = worker ? worker.terminate().catch(() => {}) : Promise.resolve();
      void stopped.then(() => { if (error) reject(error); else resolve(result); });
    };
    const abort = (): void => {
      try { assertAuditActive(signal); } catch (error) { finish(error); }
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
    const resourceLimits: ResourceLimits = { maxOldGenerationSizeMb: Math.max(HEAP_FLOOR_MB, budget.heapMb), maxYoungGenerationSizeMb: budget.youngMb, stackSizeMb: 8 };
    const data: WorkerData = { kind: KIND, mode: input.mode || 'analyse', files: input.files, paths: input.paths, registry: input.registry, advisories: input.advisories, licences: input.licences || null, intel: input.intel || null, extra: input.extra || null, trace };
    try {
      worker = new spawn(entryFile('code-audit-worker'), { workerData: data, resourceLimits });
    } catch {
      finish(publicFailure('AUDIT_ANALYSIS_FAILED', 'The audit could not start its analysis. Run it again.', 503));
      return;
    }
    worker.once('message', message => finish(null, resultOf(message)));
    worker.once('error', error => finish(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? new AuditLimitError('memory')
      : publicFailure('AUDIT_ANALYSIS_FAILED', 'The analysis stopped on a file it could not read. Run it again; if it stops again, the repository has a file this audit cannot parse.', 500)));
    /* An exit before a message, with no error, is a heap limit reached during teardown or a killed thread. */
    worker.once('exit', () => finish(new AuditLimitError('memory')));
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

let running = 0;
const waiting: { resolve(): void }[] = [];
function acquire(budget: WorkerBudget, onQueued: ((position: number) => void) | null, signal: AbortSignal | null | undefined): Promise<void> {
  assertAuditActive(signal);
  if (running === 0) {
    running = 1;
    return Promise.resolve();
  }
  if (waiting.length >= budget.queue) {
    return Promise.reject(publicFailure('AUDIT_BUSY', 'The server is analysing as many audits as it can hold. Try again in a minute.', 503));
  }
  if (onQueued) onQueued(waiting.length + 1);
  return new Promise((resolve, reject) => {
    const waiter = { resolve: () => { cleanup(); resolve(); } };
    const cleanup = (): void => { if (signal) signal.removeEventListener('abort', abort); };
    const abort = (): void => {
      const index = waiting.indexOf(waiter);
      if (index < 0) return;
      waiting.splice(index, 1);
      cleanup();
      try { assertAuditActive(signal); } catch (error) { reject(error); }
    };
    waiting.push(waiter);
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}
function release(): void {
  const next = waiting.shift();
  if (next) next.resolve();
  else running = 0;
}

export interface OffThreadOptions {
  readonly budget?: WorkerBudget;
  readonly onStage?: (stage: 'queued' | 'analysing' | 'patterns', detail?: { readonly position?: number; readonly limit?: Limit }) => void;
  readonly spawn?: AuditThreadSpawn;
  readonly signal?: AbortSignal | null;
}

/*
 * Analyse off the main thread. `onStage` hears 'queued' while another
 * analysis holds the worker, 'analysing' when this one starts, and
 * 'patterns' when the first run was stopped and the rules-only run begins.
 */
export async function analyseOffThread(input: AnalyseInput, { budget = BUDGET, onStage = () => {}, spawn = Worker, signal }: OffThreadOptions = {}): Promise<WorkerResult> {
  await acquire(budget, position => onStage('queued', { position }), signal);
  try {
    assertAuditActive(signal);
    onStage('analysing');
    try {
      const heapCeiling = budget.heapMb * budget.traceHeapShare * 1024 * 1024;
      const result = await runWorker(input, { traceMs: budget.traceMs, heapCeiling }, budget.hardMs, budget, spawn, signal);
      assertAuditActive(signal);
      return result;
    } catch (error) {
      assertAuditActive(signal);
      if (!(error instanceof AuditLimitError)) throw error;
      onStage('patterns', { limit: error.limit });
      try {
        const result = await runWorker(input, { skip: error.limit }, budget.fallbackMs, budget, spawn, signal);
        assertAuditActive(signal);
        return result;
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
export async function scanOffThread(input: { readonly files: readonly AuditFile[] }, { budget = BUDGET, spawn = Worker, signal }: OffThreadOptions = {}): Promise<WorkerResult> {
  await acquire(budget, null, signal);
  try {
    const result = await runWorker({ mode: 'rules', files: input.files }, { skip: 'rules' }, budget.rulesMs, budget, spawn, signal);
    assertAuditActive(signal);
    return result;
  } finally {
    release();
  }
}

/*
 * Started as a worker by runWorker above: `workerData` is the WorkerData it
 * posted, through a structured clone that keeps its maps and plain values.
 */
const started: unknown = workerData;
function isAuditWork(value: unknown): value is WorkerData {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === KIND;
}
if (!isMainThread && isAuditWork(started)) runInWorker(started);
