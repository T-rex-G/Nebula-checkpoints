'use strict';

/*
 * Repository audits as jobs: started once per identity, resumed rather than
 * doubled, reported by stage and count only, handed to the identity whose
 * audit it was, told of a failure once, abandoned past their time, and
 * dropped a short while after they finish.
 */

const assert = require('assert');
const { createAuditJobs, JOBS } = require('../src/code-audit-jobs');

const settle = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  assert(JOBS.keepMs <= 5 * 60 * 1000, 'a finished audit is held minutes, not longer');
  assert(JOBS.maxRunMs >= 5 * 60 * 1000, 'an audit on a small instance has minutes to finish');

  /* ---- Start, resume, refuse a second repository ---------------------------------------------- */
  {
    let clock = 1_000;
    let ids = 0;
    const jobs = createAuditJobs({ now: () => clock, randomId: () => `run-${++ids}` });
    const work = deferred();
    let launched = 0;
    let report;
    const launch = ({ onProgress }) => { launched += 1; report = onProgress; return work.promise; };
    const start = jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', launch });
    assert.strictEqual(start.status, 202);
    assert.deepStrictEqual(start.body, { state: 'running', run: 'run-1', stage: 'resolving', done: 0, total: 0, position: null, limit: null, elapsedMs: 0 });

    /* The same repository and ref again is the same run, not a second read. */
    const again = jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', launch });
    assert.strictEqual(again.body.run, 'run-1');
    assert.strictEqual(launched, 1);

    /* Another repository while it runs is refused; another identity is not affected. */
    const other = jobs.request({ identity: 'a', owner: 'o', repo: 'other', ref: 'main', launch });
    assert.strictEqual(other.error.code, 'AUDIT_IN_PROGRESS');
    assert.strictEqual(other.error.status, 429);
    const second = jobs.request({ identity: 'b', owner: 'o', repo: 'r', ref: 'main', launch: () => new Promise(() => {}) });
    assert.strictEqual(second.status, 202);
    assert.strictEqual(second.body.run, 'run-2');

    /* Progress is a stage and counts; anything else is ignored. */
    report({ stage: 'reading', done: 3, total: 9 });
    report({ stage: 'made-up', done: 99 });
    clock += 1500;
    let poll = jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-1', launch });
    assert.deepStrictEqual(poll.body, { state: 'running', run: 'run-1', stage: 'reading', done: 3, total: 9, position: null, limit: null, elapsedMs: 1500 });
    /* Asking about exploitation is a stage of its own. */
    report({ stage: 'intel' });
    assert.strictEqual(jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-1', launch }).body.stage, 'intel');
    report({ stage: 'queued', position: 2 });
    assert.strictEqual(jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-1', launch }).body.position, 2);
    report({ stage: 'patterns', limit: 'memory' });
    poll = jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-1', launch });
    assert.strictEqual(poll.body.stage, 'patterns');
    assert.strictEqual(poll.body.limit, 'memory');
    assert.strictEqual(poll.body.position, null);

    /* A run id that is not this identity's current run, or for another repository, is gone. */
    assert.strictEqual(jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-2', launch }).error.code, 'AUDIT_RUN_GONE');
    assert.strictEqual(jobs.request({ identity: 'b', owner: 'o', repo: 'r', ref: 'main', run: 'run-1', launch }).error.code, 'AUDIT_RUN_GONE');
    assert.strictEqual(jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'dev', run: 'run-1', launch }).error.status, 404);

    /* The result is handed over as it came, and held for a retried poll until it expires. */
    work.resolve({ grade: 'B', findings: [] });
    await settle();
    report({ stage: 'reading', done: 1, total: 1 });
    const done = jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-1', launch });
    assert.deepStrictEqual(done, { status: 200, body: { grade: 'B', findings: [] } });
    assert.deepStrictEqual(jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-1', launch }).body, { grade: 'B', findings: [] });
    clock += JOBS.keepMs + 1;
    assert.strictEqual(jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-1', launch }).error.code, 'AUDIT_RUN_GONE', 'a finished audit is dropped once its time is up');

    /* Asking without a run id after it finished starts afresh. */
    const fresh = jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', launch: () => new Promise(() => {}) });
    assert.strictEqual(fresh.body.run, 'run-3');
  }

  /* ---- A failure is told once, and a launch that throws is a failure ---------------------------- */
  {
    const jobs = createAuditJobs({ randomId: () => 'run-x' });
    const failure = Object.assign(new Error('The provider refused the token.'), { status: 401, code: 'PROVIDER_AUTH_FAILED' });
    jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', launch: () => Promise.reject(failure) });
    await settle();
    const told = jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-x', launch: null });
    assert.strictEqual(told.error, failure);
    assert.strictEqual(jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-x', launch: null }).error.code, 'AUDIT_RUN_GONE');
    jobs.request({ identity: 'b', owner: 'o', repo: 'r', ref: 'main', launch: () => { throw new Error('sync'); } });
    await settle();
    assert.strictEqual(jobs.request({ identity: 'b', owner: 'o', repo: 'r', ref: 'main', run: 'run-x', launch: null }).error.message, 'sync');
  }

  /* ---- Past its time an audit is abandoned, and its reads told to stop ------------------------- */
  {
    const jobs = createAuditJobs({ randomId: () => 'run-t', limits: { ...JOBS, maxRunMs: 20 } });
    let signal;
    jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', launch: context => { signal = context.signal; return new Promise(() => {}); } });
    await wait(40);
    assert.strictEqual(signal.aborted, true);
    const late = jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', run: 'run-t', launch: null });
    assert.strictEqual(late.error.code, 'AUDIT_TIMEOUT');
    assert.strictEqual(late.error.status, 504);
  }

  /* ---- A finished audit is dropped on time even when nobody asks again -------------------------- */
  {
    const jobs = createAuditJobs({ randomId: () => 'run-k', limits: { ...JOBS, keepMs: 15 } });
    jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', launch: () => Promise.resolve({ grade: 'A' }) });
    await settle();
    assert.strictEqual(jobs.size(), 1);
    await wait(40);
    assert.strictEqual(jobs.size(), 0);
  }

  /* ---- A bounded number run at once; an identity that leaves takes its audit with it ------------ */
  {
    let ids = 0;
    const jobs = createAuditJobs({ randomId: () => `run-${++ids}`, limits: { ...JOBS, maxRunning: 2 } });
    const signals = [];
    const launch = ({ signal }) => { signals.push(signal); return new Promise(() => {}); };
    jobs.request({ identity: 'a', owner: 'o', repo: 'r', ref: 'main', launch });
    jobs.request({ identity: 'b', owner: 'o', repo: 'r', ref: 'main', launch });
    const busy = jobs.request({ identity: 'c', owner: 'o', repo: 'r', ref: 'main', launch });
    assert.strictEqual(busy.error.code, 'AUDIT_BUSY');
    assert.strictEqual(busy.error.status, 503);
    jobs.forget('a');
    assert.strictEqual(signals[0].aborted, true);
    assert.strictEqual(jobs.size(), 1);
    assert.strictEqual(jobs.request({ identity: 'c', owner: 'o', repo: 'r', ref: 'main', launch }).status, 202);
    jobs.forget('nobody');
  }

  console.log('code audit job tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
