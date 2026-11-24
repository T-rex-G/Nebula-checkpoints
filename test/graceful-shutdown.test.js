'use strict';
/*
 * Stopping (the platform's graceful shutdown): once, on the first signal;
 * the job queues, the log line, the live streams and the workers in order;
 * then, once the server's connections close, each worker's work waited for in
 * turn, the pool closed and a clean exit -- whatever fails on the way -- with a
 * forced exit bounding it all.
 */
const assert = require('assert');
const { createGracefulShutdown } = require('../apps/api/src/platform/lifecycle/graceful-shutdown.ts');

function controlled(name, calls) {
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return {
    promise,
    finish(failed) { calls.push(['finished', name]); if (failed) settle.reject(new Error(`${name} failed`)); else settle.resolve(name); }
  };
}

function harness(options = {}) {
  const calls = [];
  const work = [controlled('delivery', calls), controlled('scan', calls)];
  let closing = null;
  const timers = [];
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, log: console.log };
  global.setTimeout = (fn, ms) => { const timer = { fn, ms, unref() { calls.push(['unref', ms]); } }; timers.push(timer); calls.push(['timer', ms]); return timer; };
  global.clearTimeout = timer => { calls.push(['clearTimeout', timer && timer.ms]); };
  console.log = line => { const { t, ...entry } = JSON.parse(line); calls.push(['log', typeof t, entry]); };
  const life = createGracefulShutdown({
    closeJobs: () => calls.push(['closeJobs']),
    closeStreams: signal => calls.push(['closeStreams', signal]),
    drain: () => { calls.push(['drain']); return [work[0].promise, null, work[1].promise]; },
    server: () => ({ close(callback) { calls.push(['server.close']); closing = callback; } }),
    closeDatabase: () => { calls.push(['closeDatabase']); return options.databaseFails ? Promise.reject(new Error('pool')) : Promise.resolve(); },
    exit: code => calls.push(['exit', code]),
    ...(options.forceAfterMs === undefined ? {} : { forceAfterMs: options.forceAfterMs })
  });
  const restore = () => { global.setTimeout = real.setTimeout; global.clearTimeout = real.clearTimeout; console.log = real.log; };
  return { life, calls, work, timers, closed: () => closing && closing(), restore };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the graceful shutdown tests did not finish'); process.exitCode = 1; } });

(async () => {
  {
    const h = harness();
    try {
      assert.strictEqual(h.life.shuttingDown(), false);
      await h.life.shutdown('SIGTERM');
      assert.strictEqual(h.life.shuttingDown(), true, 'shutdown has begun');
      assert.deepStrictEqual(h.calls, [
        ['closeJobs'], ['log', 'string', { event: 'shutdown', signal: 'SIGTERM' }], ['closeStreams', 'SIGTERM'], ['drain'],
        ['timer', 10000], ['unref', 10000], ['server.close']
      ], 'no new jobs, the stop logged, the streams told why, the workers stopped, a forced exit set, and the server closed');
      await h.life.shutdown('SIGINT');
      assert.strictEqual(h.calls.length, 7, 'a second signal changes nothing');
      const closing = h.closed();
      await turn();
      assert.deepStrictEqual(h.calls.slice(7), [], 'the pool waits for the workers');
      h.work[0].finish(true);
      await turn();
      assert.deepStrictEqual(h.calls.slice(7), [['finished', 'delivery']], 'and for each in turn, whatever the first did');
      h.work[1].finish(false);
      await closing;
      assert.deepStrictEqual(h.calls.slice(8), [['finished', 'scan'], ['closeDatabase'], ['clearTimeout', 10000], ['exit', 0]], 'then the pool closes and the process exits cleanly');
    } finally { h.restore(); }
  }
  {
    const h = harness({ databaseFails: true, forceAfterMs: 2500 });
    try {
      await h.life.shutdown('SIGINT');
      assert.deepStrictEqual(h.calls.filter(call => call[0] === 'timer'), [['timer', 2500]], 'the forced exit\'s bound is the deployment\'s to set');
      h.work[0].finish(false);
      h.work[1].finish(true);
      await h.closed();
      assert.deepStrictEqual(h.calls.slice(-3), [['closeDatabase'], ['clearTimeout', 2500], ['exit', 0]], 'a pool that fails to close does not hold the exit');
    } finally { h.restore(); }
  }
  {
    const h = harness();
    try {
      await h.life.shutdown('SIGTERM');
      h.timers[0].fn();
      assert.deepStrictEqual(h.calls.slice(-1), [['exit', 1]], 'past its bound the process exits with a failure regardless');
    } finally { h.restore(); }
  }

  finished = true;
  console.log('Graceful shutdown tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
