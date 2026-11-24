'use strict';
const assert = require('node:assert/strict');
const { exposureFindingPayload } = require('../apps/api/src/modules/quasar/index.ts');
const { createExposure, freshExposureState } = require('../apps/web/src/features/exposure/exposure-controller.ts');
const secret = 'ghp_' + 'A'.repeat(36);
const finding = { fingerprint: 'f'.repeat(64), rule: 'github-pat', path: `archive.zip!/${secret}.txt`, disposition: 'open' };
const publicFinding = exposureFindingPayload(finding);
assert(!JSON.stringify(publicFinding).includes(secret), 'serialized DTO must never retain the raw credential-shaped filename');
assert.equal(publicFinding.path, publicFinding.displayPath);
assert.equal(finding.path, `archive.zip!/${secret}.txt`, 'private reread locator is unchanged');

/* A scan's report, read by the Exposure screen's controller (features/exposure/exposure-controller.ts). */
function harness(answer) {
  const page = { work: { owner: 'acme', repo: 'demo', branch: 'main' }, me: null, exposure: freshExposureState('first') };
  let scope = 'first';
  const requests = [];
  const screen = createExposure({
    state: page,
    api: async url => { requests.push(url); return answer(url); },
    mutate: change => change(page.exposure),
    render() {}, announce() {}, invalidatePosture() {},
    scopeKey: () => scope, path: () => 'acme/demo',
    shown: () => true, hidden: () => false, readsHistory: () => true,
    timers: { set: () => 0, clear() {} }, now: () => Date.now(),
    download() {}, reports: { exposureSarif: () => '', exposureCsv: () => '' }
  });
  return { requests, load: scanId => screen.loadReport(scanId), get state() { return page.exposure; }, switch() { scope = 'second'; page.exposure = freshExposureState('second'); } };
}
const entry = fingerprint => ({ finding: { fingerprint, rule: 'github-pat' }, occurrences: [1], occurrenceCount: 1 });
(async () => {
  let reads = 0;
  const paged = harness(() => ++reads === 1 ? { observations: [entry('first')], nextCursor: 'opaque', complete: false } : { observations: [entry('last')], nextCursor: null, complete: true });
  await paged.load('scan');
  assert.equal(reads, 2, 'history reports must fetch every page');
  assert.match(paged.requests[1], /cursor=opaque/);
  assert.equal(paged.state.reports.scan.entries.length, 2);
  assert.equal(paged.state.reports.scan.complete, true);
  let round = 0;
  const bounded = harness(() => ({ observations: [entry(String(++round))], nextCursor: 'cursor' + round, complete: false }));
  await bounded.load('scan');
  assert.equal(round, 5, 'malformed/unbounded report continuations stop at the 500-row scan budget');
  assert.equal(bounded.state.reports.scan.complete, false);
  const failed = harness(() => { throw new Error('outage'); });
  await failed.load('scan');
  assert(failed.state.reports.scan.error);
  assert.equal(failed.state.reports.scan.entries, null);
  let release;
  const switched = harness(() => new Promise(resolve => { release = resolve; }));
  const pending = switched.load('scan'); switched.switch();
  release({ observations: [entry('private')], complete: true });
  await pending;
  assert.deepEqual(switched.state.reports, {}, 'late history results cannot repopulate another account');
  console.log('Exposure public DTO and report paging regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
