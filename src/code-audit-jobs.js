'use strict';

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
 */

const crypto = require('crypto');

const JOBS = Object.freeze({
  /* How long a finished audit is held for the page to collect. */
  keepMs: 2 * 60 * 1000,
  /* The longest an audit may run, reading included, before it is abandoned. */
  maxRunMs: 8 * 60 * 1000,
  /* Audits running at once, across every identity. */
  maxRunning: 16
});

const STAGES = new Set(['queued', 'resolving', 'reading', 'rules', 'advisories', 'intel', 'analysing', 'patterns']);

/*
 * A deployed-site check is the same kind of work -- a few dozen outbound
 * requests, longer than a quiet request is kept open at the edge -- so it is
 * the same kind of job, with its own stages, limits and words.
 */
const SITE_JOBS = Object.freeze({ keepMs: 2 * 60 * 1000, maxRunMs: 90 * 1000, maxRunning: 8 });
const SITE_STAGES = new Set(['page', 'transport', 'paths', 'pages', 'scripts', 'libraries', 'email']);
const KINDS = Object.freeze({
  audit: Object.freeze({
    prefix: 'AUDIT', first: 'resolving', stages: STAGES, limits: JOBS,
    safeState: 'Nothing was changed. The audit only reads.',
    gone: 'This audit is no longer held by the server. It may have restarted. Run the audit again.',
    inProgress: 'An audit of another repository is already running for this session. Wait for it to finish.',
    busy: 'The server is running as many audits as it can hold. Try again in a minute.',
    timeout: 'The audit ran past the time this server gives one. Run it again; a smaller branch finishes sooner.'
  }),
  site: Object.freeze({
    prefix: 'SITE_CHECK', first: 'page', stages: SITE_STAGES, limits: SITE_JOBS,
    safeState: 'Nothing was changed. The check only reads what any visitor can.',
    gone: 'This site check is no longer held by the server. It may have restarted. Check the site again.',
    inProgress: 'A check of another site is already running for this session. Wait for it to finish.',
    busy: 'The server is running as many site checks as it can hold. Try again in a minute.',
    timeout: 'The site check ran past the time this server gives one. Check the site again.'
  })
});

function jobError(code, message, status, safeState = KINDS.audit.safeState) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.providerChanged = false;
  error.safeState = safeState;
  return error;
}

/*
 * Each answer is `{ status, body }` to send as it is, or `{ error }` for the
 * server to send as its public error body. `now` and `randomId` are
 * replaceable in tests.
 */
function createAuditJobs({ now = Date.now, randomId = () => crypto.randomBytes(12).toString('hex'), kind = 'audit', limits = null } = {}) {
  const words = KINDS[kind];
  if (!words) throw new TypeError(`Unknown job kind ${kind}`);
  limits = limits || words.limits;
  const fail = (name, status) => jobError(`${words.prefix}_${name}`, words[{ RUN_GONE: 'gone', IN_PROGRESS: 'inProgress', BUSY: 'busy', TIMEOUT: 'timeout' }[name]], status, words.safeState);
  const jobs = new Map();

  const sweep = () => {
    for (const [identity, job] of jobs) {
      if (job.finishedAt !== null && now() - job.finishedAt > limits.keepMs) jobs.delete(identity);
    }
  };
  const running = () => [...jobs.values()].filter(job => job.finishedAt === null).length;

  const progress = job => update => {
    if (job.finishedAt !== null || !update || !(update.stage === 'queued' || words.stages.has(update.stage))) return;
    job.stage = update.stage;
    if (Number.isFinite(update.done)) job.done = update.done;
    if (Number.isFinite(update.total)) job.total = update.total;
    job.position = update.stage === 'queued' && Number.isFinite(update.position) ? update.position : null;
    job.limit = update.stage === 'patterns' && (update.limit === 'memory' || update.limit === 'time') ? update.limit : job.limit;
  };

  const settle = (job, outcome) => {
    if (job.finishedAt !== null) return;
    clearTimeout(job.timer);
    job.finishedAt = now();
    if (outcome.error) job.error = outcome.error;
    else job.result = outcome.result;
    /* Dropped on time even if nobody asks again: a result is not kept waiting for a request that never comes. */
    job.timer = setTimeout(() => { if (jobs.get(job.identity) === job) jobs.delete(job.identity); }, limits.keepMs + 1);
    if (typeof job.timer.unref === 'function') job.timer.unref();
  };

  const running202 = job => ({
    status: 202,
    body: {
      state: 'running', run: job.id, stage: job.stage, done: job.done, total: job.total,
      position: job.position, limit: job.limit, elapsedMs: Math.max(0, now() - job.startedAt)
    }
  });

  function answer(identity, job) {
    if (job.finishedAt === null) return running202(job);
    if (job.error) {
      /* A failure is told once; asking again starts afresh. */
      clearTimeout(job.timer);
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
  function request({ identity, owner, repo, ref, run, launch }) {
    sweep();
    const job = jobs.get(identity);
    const same = Boolean(job) && job.owner === owner && job.repo === repo && job.ref === ref;
    if (run) {
      if (!job || job.id !== String(run) || !same) {
        return { error: fail('RUN_GONE', 404) };
      }
      return answer(identity, job);
    }
    if (job && job.finishedAt === null) {
      if (same) return running202(job);
      return { error: fail('IN_PROGRESS', 429) };
    }
    if (running() >= limits.maxRunning) {
      return { error: fail('BUSY', 503) };
    }
    const fresh = {
      id: randomId(), identity, owner, repo, ref, startedAt: now(), finishedAt: null,
      stage: words.first, done: 0, total: 0, position: null, limit: null, result: null, error: null, timer: null, controller: new AbortController()
    };
    jobs.set(identity, fresh);
    const controller = fresh.controller;
    fresh.timer = setTimeout(() => {
      settle(fresh, { error: fail('TIMEOUT', 504) });
      controller.abort();
    }, limits.maxRunMs);
    if (typeof fresh.timer.unref === 'function') fresh.timer.unref();
    let started;
    try {
      started = Promise.resolve(launch({ onProgress: progress(fresh), signal: controller.signal }));
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(result => settle(fresh, { result }), error => settle(fresh, { error }));
    return running202(fresh);
  }

  /* Drop whatever an identity has held: its session ended. */
  function forget(identity) {
    const job = jobs.get(identity);
    if (!job) return;
    clearTimeout(job.timer);
    jobs.delete(identity);
    if (job.finishedAt === null) job.controller.abort();
  }

  return Object.freeze({ request, forget, size: () => jobs.size });
}

module.exports = Object.freeze({ createAuditJobs, JOBS, SITE_JOBS, SITE_STAGES });
