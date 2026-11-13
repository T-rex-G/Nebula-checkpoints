/*
 * Repository audits as short-lived jobs, so no request waits on one.
 *
 * An audit reads a branch, asks two registries and analyses what it read. On
 * a small instance that takes a minute or more: longer than an edge proxy
 * keeps a quiet request open, and long enough for a phone to drop it. So the
 * first request starts the audit and answers at once with a run id, and the
 * page asks again with that id, hearing the stage each time, until the
 * result is there.
 *
 * A job belongs to the identity that started it, and an identity has at most
 * one. Asking again for the same repository and ref while it runs returns the
 * running job instead of starting a second; asking for another repository
 * while it runs is refused. A job lives in this process's memory only --
 * never in the database, a log or a queue -- and is dropped a short while
 * after it finishes, collected or not. A restart loses it, and the page is
 * told the run is gone rather than left polling.
 *
 * What a running job reports is a stage name and counts. The result, when
 * there is one, is exactly what the audit returned, and it is handed only to
 * the identity whose audit it was.
 *
 * It is platform, not Uranus: the deployed-site check and the rendered audit
 * are jobs of the same kind, each with its own stages, limits and words, all
 * written out in the jobs contract.
 */

import { randomBytes } from 'node:crypto';
import { JOB_ERROR_CODES, JOB_FIRST_STAGE, JOB_STAGES, type JobFailure, type JobKind, type RunningJob } from '../../../../../packages/contracts/src/jobs.ts';

export interface JobLimits {
  /* How long a finished job is held for the page to collect. */
  readonly keepMs: number;
  /* The longest a job may run, reading included, before it is abandoned. */
  readonly maxRunMs: number;
  /* Jobs running at once, across every identity. */
  readonly maxRunning: number;
}

export const JOBS: JobLimits = Object.freeze({
  /* How long a finished audit is held for the page to collect. */
  keepMs: 2 * 60 * 1000,
  /* The longest an audit may run, reading included, before it is abandoned. */
  maxRunMs: 8 * 60 * 1000,
  /* Audits running at once, across every identity. */
  maxRunning: 16
});

const STAGES: ReadonlySet<string> = new Set(JOB_STAGES.audit);

/*
 * A deployed-site check is the same kind of work -- a few dozen outbound
 * requests, longer than a quiet request is kept open at the edge -- so it is
 * the same kind of job, with its own stages, limits and words.
 */
export const SITE_JOBS: JobLimits = Object.freeze({ keepMs: 2 * 60 * 1000, maxRunMs: 90 * 1000, maxRunning: 8 });
export const SITE_STAGES: ReadonlySet<string> = new Set(JOB_STAGES.site);

interface JobWords {
  readonly codes: Readonly<Record<JobFailure, string>>;
  readonly first: string;
  readonly stages: ReadonlySet<string>;
  readonly limits: JobLimits;
  readonly safeState: string;
  readonly gone: string;
  readonly inProgress: string;
  readonly busy: string;
  readonly timeout: string;
}

const KINDS: Readonly<Record<JobKind, JobWords>> = Object.freeze({
  audit: Object.freeze({
    codes: JOB_ERROR_CODES.audit, first: JOB_FIRST_STAGE.audit, stages: STAGES, limits: JOBS,
    safeState: 'Nothing was changed. The audit only reads.',
    gone: 'This audit is no longer held by the server. It may have restarted. Run the audit again.',
    inProgress: 'An audit of another repository is already running for this session. Wait for it to finish.',
    busy: 'The server is running as many audits as it can hold. Try again in a minute.',
    timeout: 'The audit ran past the time this server gives one. Run it again; a smaller branch finishes sooner.'
  }),
  rendered: Object.freeze({
    codes: JOB_ERROR_CODES.rendered, first: JOB_FIRST_STAGE.rendered, stages: new Set(JOB_STAGES.rendered),
    limits: Object.freeze({ keepMs: 120000, maxRunMs: 100000, maxRunning: 1 }),
    safeState: 'The browser only requested public resources. No forms were submitted.',
    gone: 'This rendered audit expired or the server restarted. Start it again.',
    inProgress: 'A rendered audit is already running for this session.',
    busy: 'The isolated browser is busy. Try again shortly.',
    timeout: 'The rendered audit exceeded its time limit.'
  }),
  site: Object.freeze({
    codes: JOB_ERROR_CODES.site, first: JOB_FIRST_STAGE.site, stages: SITE_STAGES, limits: SITE_JOBS,
    safeState: 'Nothing was changed. The check only reads what any visitor can.',
    gone: 'This site check is no longer held by the server. It may have restarted. Check the site again.',
    inProgress: 'A check of another site is already running for this session. Wait for it to finish.',
    busy: 'The server is running as many site checks as it can hold. Try again in a minute.',
    timeout: 'The site check ran past the time this server gives one. Check the site again.'
  })
});

/* Which of a kind's words each failure is told in. */
const FAILURE_WORDS: Readonly<Record<JobFailure, 'gone' | 'inProgress' | 'busy' | 'timeout'>> = Object.freeze({
  RUN_GONE: 'gone', IN_PROGRESS: 'inProgress', BUSY: 'busy', TIMEOUT: 'timeout'
});

/* A failure as the server's public error body tells it. */
export type JobError = Error & { readonly code: string; readonly status: number; readonly providerChanged: false; readonly safeState: string };

function jobError(code: string, message: string, status: number, safeState: string = KINDS.audit.safeState): JobError {
  return Object.assign(new Error(message), { code, status, providerChanged: false as const, safeState });
}

/* What the work reports as it goes: a stage, and counts. Anything else is ignored. */
export interface JobUpdate {
  readonly stage?: unknown;
  readonly done?: unknown;
  readonly total?: unknown;
  readonly position?: unknown;
  readonly limit?: unknown;
}
export interface JobLaunch {
  readonly onProgress: (update: JobUpdate | null | undefined) => void;
  readonly signal: AbortSignal;
}
export interface JobRequest<R> {
  readonly identity: string;
  readonly owner: unknown;
  readonly repo: unknown;
  readonly ref: unknown;
  readonly run?: unknown;
  readonly launch: (launch: JobLaunch) => R | Promise<R>;
}
export type JobAnswer<R> =
  | { readonly status: 202; readonly body: RunningJob }
  | { readonly status: 200; readonly body: R | null }
  | { readonly error: unknown };
export interface JobTarget {
  readonly owner: unknown;
  readonly repo: unknown;
  readonly ref: unknown;
}
interface JobKey {
  readonly identity: string;
  readonly owner: unknown;
  readonly repo: unknown;
  readonly ref: unknown;
  readonly run: unknown;
}
export interface AuditJobs<R> {
  request(input: JobRequest<R>): JobAnswer<R>;
  forget(identity: string): void;
  cancel(input: JobKey): boolean;
  target(input: { readonly identity: string; readonly run: unknown }): JobTarget | null;
  close(): void;
  size(): number;
}
export interface AuditJobsOptions {
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly kind?: string;
  readonly limits?: JobLimits | null;
}

interface Job<R> {
  readonly id: string;
  readonly identity: string;
  readonly owner: unknown;
  readonly repo: unknown;
  readonly ref: unknown;
  readonly startedAt: number;
  finishedAt: number | null;
  stage: string;
  done: number;
  total: number;
  position: number | null;
  limit: 'memory' | 'time' | null;
  result: R | null;
  error: unknown;
  timer: ReturnType<typeof setTimeout> | null;
  readonly controller: AbortController;
}

/* Each job kind the contract names, by its name; nothing else is a kind. */
const kindOf = (kind: string): JobKind | null => (kind === 'audit' || kind === 'site' || kind === 'rendered' ? kind : null);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/*
 * Each answer is `{ status, body }` to send as it is, or `{ error }` for the
 * server to send as its public error body. `now` and `randomId` are
 * replaceable in tests.
 */
export function createAuditJobs<R = unknown>({ now = Date.now, randomId = () => randomBytes(12).toString('hex'), kind = 'audit', limits = null }: AuditJobsOptions = {}): AuditJobs<R> {
  const named = kindOf(kind);
  if (!named) throw new TypeError(`Unknown job kind ${kind}`);
  const words = KINDS[named];
  const held = limits || words.limits;
  /* Each failure's code is written out in the jobs contract (packages/contracts/src/jobs.ts). */
  const failure = (name: JobFailure, status: number): JobError => jobError(words.codes[name], words[FAILURE_WORDS[name]], status, words.safeState);
  const jobs = new Map<string, Job<R>>();
  // A cancelled or expired result is no longer visible, but its underlying
  // execution may still be shutting down. Keep that work in the capacity
  // budget until launch actually settles, including non-cooperative work.
  let executing = 0;

  const sweep = (): void => {
    for (const [identity, job] of jobs) {
      if (job.finishedAt !== null && now() - job.finishedAt > held.keepMs) jobs.delete(identity);
    }
  };

  const progress = (job: Job<R>) => (update: JobUpdate | null | undefined): void => {
    const stage = update ? update.stage : undefined;
    if (job.finishedAt !== null || !update || typeof stage !== 'string' || !(stage === 'queued' || words.stages.has(stage))) return;
    job.stage = stage;
    if (finite(update.done)) job.done = update.done;
    if (finite(update.total)) job.total = update.total;
    job.position = stage === 'queued' && finite(update.position) ? update.position : null;
    job.limit = stage === 'patterns' && (update.limit === 'memory' || update.limit === 'time') ? update.limit : job.limit;
  };

  const settle = (job: Job<R>, outcome: { readonly error: unknown } | { readonly result: R }): void => {
    if (job.finishedAt !== null || jobs.get(job.identity) !== job) return;
    if (job.timer) clearTimeout(job.timer);
    job.finishedAt = now();
    if ('error' in outcome) job.error = outcome.error;
    else job.result = outcome.result;
    /* Dropped on time even if nobody asks again: a result is not kept waiting for a request that never comes. */
    const timer = setTimeout(() => { if (jobs.get(job.identity) === job) jobs.delete(job.identity); }, held.keepMs + 1);
    if (typeof timer.unref === 'function') timer.unref();
    job.timer = timer;
  };

  const running202 = (job: Job<R>): JobAnswer<R> => ({
    status: 202,
    body: {
      state: 'running', run: job.id, stage: job.stage, done: job.done, total: job.total,
      position: job.position, limit: job.limit, elapsedMs: Math.max(0, now() - job.startedAt)
    }
  });

  function answer(identity: string, job: Job<R>): JobAnswer<R> {
    if (job.finishedAt === null) return running202(job);
    if (job.error) {
      /* A failure is told once; asking again starts afresh. */
      if (job.timer) clearTimeout(job.timer);
      jobs.delete(identity);
      return { error: job.error };
    }
    return { status: 200, body: job.result };
  }

  /*
   * One request. Without `run` it starts an audit (or returns the one this
   * identity already has running for the same repository and ref); with
   * `run` it reports on that audit. `launch({ onProgress, signal })` runs
   * the audit and resolves with its result.
   */
  function request({ identity, owner, repo, ref, run, launch }: JobRequest<R>): JobAnswer<R> {
    sweep();
    const job = jobs.get(identity);
    const same = job !== undefined && job.owner === owner && job.repo === repo && job.ref === ref;
    if (run) {
      if (!job || job.id !== String(run) || !same) {
        return { error: failure('RUN_GONE', 404) };
      }
      return answer(identity, job);
    }
    if (job && job.finishedAt === null) {
      if (same) return running202(job);
      return { error: failure('IN_PROGRESS', 429) };
    }
    if (executing >= held.maxRunning) {
      return { error: failure('BUSY', 503) };
    }
    const fresh: Job<R> = {
      id: randomId(), identity, owner, repo, ref, startedAt: now(), finishedAt: null,
      stage: words.first, done: 0, total: 0, position: null, limit: null, result: null, error: null, timer: null, controller: new AbortController()
    };
    jobs.set(identity, fresh);
    const controller = fresh.controller;
    const timer = setTimeout(() => {
      settle(fresh, { error: failure('TIMEOUT', 504) });
      controller.abort();
    }, held.maxRunMs);
    if (typeof timer.unref === 'function') timer.unref();
    fresh.timer = timer;
    let started: Promise<R>;
    executing += 1;
    try {
      started = Promise.resolve(launch({ onProgress: progress(fresh), signal: controller.signal }));
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(result => {
      executing -= 1;
      settle(fresh, { result });
    }, (error: unknown) => {
      executing -= 1;
      settle(fresh, { error });
    });
    return running202(fresh);
  }

  /* Drop whatever an identity has held: its session ended. */
  function forget(identity: string): void {
    const job = jobs.get(identity);
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    jobs.delete(identity);
    if (job.finishedAt === null) job.controller.abort();
  }

  function cancel({ identity, owner, repo, ref, run }: JobKey): boolean {
    const job = jobs.get(identity);
    if (!job || job.id !== run || job.owner !== owner || job.repo !== repo || job.ref !== ref) return false;
    forget(identity);
    return true;
  }
  // Server-side lookup lets clients poll an opaque run without repeating the
  // target URL in browser history, proxy logs, or request query strings.
  function target({ identity, run }: { readonly identity: string; readonly run: unknown }): JobTarget | null {
    sweep();
    const job = jobs.get(identity);
    if (!job || job.id !== run) return null;
    return Object.freeze({ owner: job.owner, repo: job.repo, ref: job.ref });
  }
  const close = (): void => { for (const identity of jobs.keys()) forget(identity); };
  return Object.freeze({ request, forget, cancel, target, close, size: () => jobs.size });
}
