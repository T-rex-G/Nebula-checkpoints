'use strict';
/*
 * The alpha's privacy retention (apps/api/src/modules/identity-access/application/alpha-privacy-retention.ts):
 * started once, run at once and daily after that, only for an enabled alpha
 * with a store, and logged by counts and error codes, never by a message.
 */
const assert = require('assert');
const { createAlphaPrivacyRetention } = require('../apps/api/src/modules/identity-access/index.ts');

const timers = [];
const logs = [];
const saved = { setInterval: global.setInterval, log: console.log, error: console.error };
global.setInterval = (callback, ms) => {
  const timer = { callback, ms, unrefed: false, unref() { timer.unrefed = true; } };
  timers.push(timer);
  return timer;
};
console.log = (...args) => logs.push(['log', ...args]);
console.error = (...args) => logs.push(['error', ...args]);
const restore = () => { global.setInterval = saved.setInterval; console.log = saved.log; console.error = saved.error; };
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const reset = () => { timers.length = 0; logs.length = 0; };

function store(answers) {
  const queue = [...answers];
  const counter = { runs: 0 };
  counter.runRetention = async () => {
    counter.runs += 1;
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return counter;
}

async function main() {
  try {
    /* Nothing runs for an alpha that is off, or without a store. */
    for (const deps of [{ config: { enabled: false }, store: store([{}]) }, { config: { enabled: true }, store: null }]) {
      reset();
      createAlphaPrivacyRetention(deps).start();
      await settled();
      assert.strictEqual(timers.length, 0);
      assert.strictEqual(logs.length, 0);
      if (deps.store) assert.strictEqual(deps.store.runs, 0);
    }

    /* Started, it runs at once and then daily, and a second start changes nothing. */
    {
      reset();
      const privacy = store([{ sessions: 2, feedback: 0, evidence: 7, partial: 1.5, label: '3', huge: Number.MAX_SAFE_INTEGER + 1, nested: { a: 1 } }, {}]);
      const config = { enabled: true };
      const retention = createAlphaPrivacyRetention({ config, store: privacy });
      retention.start();
      retention.start();
      await settled();
      assert.strictEqual(privacy.runs, 1);
      assert.deepStrictEqual(timers.map(timer => [timer.ms, timer.unrefed]), [[24 * 60 * 60 * 1000, true]]);
      const [kind, line] = logs[0];
      assert.strictEqual(kind, 'log');
      const entry = JSON.parse(line);
      assert.match(entry.t, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepStrictEqual(entry.alphaRetention, { sessions: 2, feedback: 0, evidence: 7 }, 'only whole counts are logged');
      timers[0].callback();
      await settled();
      assert.strictEqual(privacy.runs, 2, 'the daily run');
      assert.deepStrictEqual(JSON.parse(logs[1][1]).alphaRetention, {});

      /* The alpha's configuration is read on every run. */
      config.enabled = false;
      timers[0].callback();
      await settled();
      assert.strictEqual(privacy.runs, 2, 'no run once the alpha is off');
    }

    /* A failure is logged by its code when it has a well-formed one, and never by its message. */
    {
      reset();
      const failures = [
        [Object.assign(new Error('tester alice@example.com locked'), { code: 'ALPHA_PRIVACY_LOCKED' }), 'ALPHA_PRIVACY_LOCKED'],
        [Object.assign(new Error('tester alice@example.com reset'), { code: 'econnreset' }), 'ALPHA_RETENTION_FAILED'],
        [Object.assign(new Error('one letter'), { code: 'A' }), 'ALPHA_RETENTION_FAILED'],
        [Object.assign(new Error('too long'), { code: `A${'B'.repeat(80)}` }), 'ALPHA_RETENTION_FAILED'],
        [new Error('tester alice@example.com'), 'ALPHA_RETENTION_FAILED']
      ];
      const privacy = store(failures.map(([error]) => error).concat([null]));
      createAlphaPrivacyRetention({ config: { enabled: true }, store: privacy }).start();
      await settled();
      for (let i = 1; i <= failures.length; i += 1) { timers[0].callback(); await settled(); }
      const errors = logs.filter(item => item[0] === 'error').map(item => JSON.parse(item[1]));
      assert.deepStrictEqual(errors.map(item => [item.warn, item.code]), [
        ...failures.map(([, code]) => ['alpha privacy retention failed', code]),
        ['alpha privacy retention failed', 'ALPHA_RETENTION_FAILED']
      ], 'a run that answers nothing readable is a failure too');
      assert(!JSON.stringify(logs).includes('alice'), 'no message reaches the log');
    }
  } finally {
    restore();
  }
  finished = true;
  console.log('alpha privacy retention tests passed');
}

/* A deferred nobody settles leaves main() waiting with nothing left to run, and Node would exit cleanly. */
let finished = false;
process.on('exit', () => {
  if (finished) return;
  restore();
  console.error('alpha privacy retention tests did not finish: an operation was left waiting');
  process.exitCode = 1;
});
main().catch(error => { restore(); console.error(error); process.exit(1); });
