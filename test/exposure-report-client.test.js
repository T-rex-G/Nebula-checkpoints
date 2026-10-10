'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describeFinding, describeDisposition, safeDisplayPath } = require('../src/exposure-narration');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const dto = { describeFinding, describeDisposition, safeDisplayPath, EXPOSURE_VERIFIABLE_RULES: new Set() };
vm.runInNewContext(server.slice(server.indexOf('function exposureFindingPayload('), server.indexOf('const EXPOSURE_VERIFIABLE_RULES')), dto);
const secret = 'ghp_' + 'A'.repeat(36);
const finding = { fingerprint: 'f'.repeat(64), rule: 'github-pat', path: `archive.zip!/${secret}.txt`, disposition: 'open' };
const publicFinding = dto.exposureFindingPayload(finding);
assert(!JSON.stringify(publicFinding).includes(secret), 'serialized DTO must never retain the raw credential-shaped filename');
assert.equal(publicFinding.path, publicFinding.displayPath);
assert.equal(finding.path, `archive.zip!/${secret}.txt`, 'private reread locator is unchanged');

function harness(answer) {
  let state = { reports: {} };
  let scope = 'first';
  const requests = [];
  const context = { URLSearchParams, exposureState: () => state, exposureScopeKey: () => scope,
    wPath: () => 'acme/demo', renderExposure() {}, api: async url => { requests.push(url); return answer(url); } };
  const start = app.indexOf('async function loadExposureReport(');
  const end = app.indexOf('\n/*', start);
  vm.runInNewContext(app.slice(start, end), context);
  return { requests, load: context.loadExposureReport, get state() { return state; }, switch() { scope = 'second'; state = { reports: {} }; } };
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
