'use strict';
/*
 * Older governance decisions are read a page at a time
 * (features/governance/governance-actions.ts): merged without counting one
 * twice, the cursor kept for the next page or dropped once the history is
 * complete, and a page for a repository or account no longer open dropped.
 */
const assert = require('assert');
const { createGovernance } = require('../apps/web/src/features/governance/governance-actions.ts');

function harness() {
  let resolve;
  const requests = [];
  const state = { work: { owner: 'Acme', repo: 'Demo' }, governance: { digitalTwin: { history: { decisions: [{ seq: 50 }, { seq: 49 }], nextBeforeDecisionSeq: 49, nextDecisionSeq: null } } } };
  const governance = createGovernance({
    state,
    mutate: change => change(state.governance),
    api: url => { requests.push(url); return new Promise(done => { resolve = done; }); },
    modal: async () => true, toast() {}, stepUp: async () => null,
    $: () => null,
    doc: { createElement: () => ({}), body: { appendChild() {} }, activeElement: null },
    storage: () => ({ getItem: () => null, setItem() {} }),
    draw() {}, requestAnimationFrame: run => run(), setTimeout: () => 0, clearTimeout() {},
    now: () => 0, randomId: () => 'id', cssEscape: value => value
  });
  const load = (cursor, order = 'desc') => governance.handlers['load-more-decisions']({ dataset: order === 'desc' ? { beforeSeq: String(cursor) } : { afterSeq: String(cursor) } });
  return { state, requests, load, resolve: value => resolve(value) };
}

(async () => {
  const current = harness();
  const first = current.load(49);
  assert.strictEqual(current.requests[0], '/api/repo/Acme/Demo/governance/decisions?limit=50&beforeSeq=49');
  current.resolve({ decisions: [{ seq: 49 }, { seq: 48 }, { seq: 47 }], nextBeforeSeq: 47, complete: false });
  await first;
  assert.strictEqual(JSON.stringify(current.state.governance.digitalTwin.history.decisions.map(item => item.seq)), '[50,49,48,47]');
  assert.strictEqual(current.state.governance.digitalTwin.history.nextBeforeDecisionSeq, 47);
  const finalPage = current.load(47);
  current.resolve({ decisions: [{ seq: 46 }], nextBeforeSeq: null, complete: true });
  await finalPage;
  assert.strictEqual(current.state.governance.digitalTwin.history.nextBeforeDecisionSeq, null);

  const legacy = harness();
  const ascending = legacy.load(50, 'asc');
  assert(legacy.requests[0].endsWith('afterSeq=50'));
  legacy.resolve({ decisions: [{ seq: 51 }], nextAfterSeq: 51, complete: false });
  await ascending;
  assert.strictEqual(legacy.state.governance.digitalTwin.history.nextDecisionSeq, 51);

  for (const change of ['repository', 'account']) {
    const switched = harness();
    const pending = switched.load(49);
    if (change === 'repository') switched.state.work.repo = 'Other';
    else switched.state.governance = { digitalTwin: { history: { decisions: [{ seq: 100 }] } } };
    const before = JSON.stringify(switched.state.governance);
    switched.resolve({ decisions: [{ seq: 48 }], nextBeforeSeq: 48, complete: false });
    await pending;
    assert.strictEqual(JSON.stringify(switched.state.governance), before, `${change} changes discard the old asynchronous page`);
  }
  console.log('governance decision pagination client tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
