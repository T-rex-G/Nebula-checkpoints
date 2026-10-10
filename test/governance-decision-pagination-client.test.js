'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('async function loadMoreGovernanceDecisions(');
const end = source.indexOf('\nfunction governanceBasePath()', start);
assert(start >= 0 && end > start, 'the actual client pagination function must be available');
function harness() {
  let resolve;
  const requests = [];
  const state = { work: { owner: 'Acme', repo: 'Demo' }, governance: { digitalTwin: { history: { decisions: [{ seq: 50 }, { seq: 49 }], nextBeforeDecisionSeq: 49, nextDecisionSeq: null } } } };
  const context = {
    state,
    wPath: () => `${state.work.owner}/${state.work.repo}`,
    api: url => { requests.push(url); return new Promise(done => { resolve = done; }); },
    renderGovernanceInterface() {},
    announceGovernance() {}
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.loadPage = loadMoreGovernanceDecisions;`, context);
  return { state, requests, load: context.loadPage, resolve: value => resolve(value) };
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
