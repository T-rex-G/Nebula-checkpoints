'use strict';

const assert = require('assert');
const { ExposureStore, EXPOSURE_CONFIG_VERSION } = require('../../src/exposure-store');

module.exports = async function checkExposureStoreHardening(pool) {
  const store = new ExposureStore({ pool });
  const scope = { provider: 'github', authority: 'github.com', owner: 'fixture', repo: 'Hardening' };
  const identityKey = '1'.repeat(64);
  const fingerprint = '2'.repeat(64);
  const at = Date.now();
  const commit = '3'.repeat(40);
  const finding = { fingerprint, rulesVersion: 1, engineVersion: 1, fingerprintKeyVersion: 1,
    rule: 'github-token', path: 'config.env', placeholder: '<github-token #1>',
    occurrences: [{ line: 1, column: 1 }], occurrenceCount: 1, truncated: false, inTree: true };
  const request = (target, id, now, sha = commit) => target.requestScan({ scope, identityKey,
    requestedBy: 'fixture', refName: 'main', commitSha: sha, idempotencyKey: id,
    rulesVersion: 1, engineVersion: 1, fingerprintKeyVersion: 1, configVersion: EXPOSURE_CONFIG_VERSION, now });
  const scan = await request(store, 'hardening-one', at);
  const held = await store.claimScan({ now: at + 1 });
  assert.strictEqual(held.scan.scanId, scan.scan.scanId);
  const record = (now, extra = {}) => store.recordObservations({ scanId: scan.scan.scanId,
    claimOwner: held.claimOwner, now, findings: [{ ...finding, ...extra }] });
  await record(at + 2);
  const verdict = (state, now) => store.recordVerification({ scope, identityKey, fingerprint,
    requestedBy: 'fixture', record: { state, reason: state === 'verified' ? 'identity-confirmed' : 'credential-refused',
      adapter: 'github-user-token', observedAt: new Date(now).toISOString() } });
  await verdict('verified', at + 2000);
  await verdict('rejected', at + 1000);
  assert.strictEqual((await store.getFinding({ scope, identityKey, fingerprint })).disposition, 'open',
    'an older rejection cannot close a newer verified credential');
  await verdict('rejected', at + 3000);
  assert.strictEqual((await store.getFinding({ scope, identityKey, fingerprint })).disposition, 'credential-rejected');
  await verdict('verified', at + 4000);
  assert.strictEqual((await store.getFinding({ scope, identityKey, fingerprint })).disposition, 'open',
    'a later verified attempt reopens a rejected credential');
  await verdict('rejected', at + 4000);
  const latest = await store.latestAnswers({ scope, identityKey, fingerprints: [fingerprint] });
  assert.strictEqual(latest.verifications[fingerprint].state, 'verified', 'equal timestamps cannot discard live evidence');
  assert.strictEqual((await store.getFinding({ scope, identityKey, fingerprint })).disposition, 'open');
  await store.acceptRisk({ scope, identityKey, fingerprint, actor: 'fixture', now: at + 4500 });
  await verdict('rejected', at + 5000);
  await verdict('verified', at + 6000);
  assert.strictEqual((await store.getFinding({ scope, identityKey, fingerprint })).disposition, 'accepted-risk');

  const history = { inTree: false, introducedCommit: '4'.repeat(40) };
  await record(at + 3, history);
  await record(at + 4, history);
  let observation = (await store.listObservations({ scope, identityKey, scanId: scan.scan.scanId }))[0];
  assert.strictEqual(observation.historyCommits, 1, 'replaying one sighting cannot inflate the count');
  await record(at + 5, { ...history, introducedCommit: '5'.repeat(40) });
  observation = (await store.listObservations({ scope, identityKey, scanId: scan.scan.scanId }))[0];
  assert.strictEqual(observation.historyCommits, 2, 'distinct commit sightings are counted');
  // A reclaimed worker replays the scan from the beginning, under a new token.
  const reclaimed = await store.claimScan({ now: at + 61_000 });
  assert.strictEqual(reclaimed.scan.scanId, scan.scan.scanId);
  await store.recordObservations({ scanId: scan.scan.scanId, claimOwner: reclaimed.claimOwner,
    now: at + 61_001, findings: [{ ...finding, ...history }] });
  observation = (await store.listObservations({ scope, identityKey, scanId: scan.scan.scanId }))[0];
  assert.strictEqual(observation.historyCommits, 2, 'a new fencing token cannot double-count old sightings');
  await store.finalizeScan({ scanId: scan.scan.scanId, claimOwner: reclaimed.claimOwner,
    state: 'complete', coverage: 'complete', now: at + 61_002 });

  const second = await request(store, 'hardening-two', at + 61_010, '6'.repeat(40));
  const next = await store.claimScan({ now: at + 61_011 });
  await store.recordObservations({ scanId: second.scan.scanId, claimOwner: next.claimOwner,
    now: at + 61_012, findings: [finding] });
  assert.strictEqual((await store.scanReport({ scope, identityKey, scanId: scan.scan.scanId }))[0].finding.commit,
    commit, 'old reports keep their own read-back commit');
  await store.finalizeScan({ scanId: second.scan.scanId, claimOwner: next.claimOwner,
    state: 'complete', coverage: 'complete', now: at + 61_013 });

  // This row models an old count whose exact commit set was not retained.
  await pool.query('UPDATE nv_exposure_observations SET history_count_exact=DEFAULT WHERE scan_id=$1', [scan.scan.scanId]);
  assert.strictEqual((await store.scanReport({ scope, identityKey, scanId: scan.scan.scanId }))[0].observation.historyCommits,
    null, 'legacy counts must not be presented as reconstructed exact evidence');

  // A row lock on an empty SELECT does not lock the repository scope. Hold
  // clear after that SELECT, then make another connection attempt admission.
  let signalClear;
  let releaseClear;
  let signalRequest;
  const clearRead = new Promise(resolve => { signalClear = resolve; });
  const continueClear = new Promise(resolve => { releaseClear = resolve; });
  const requestAttempted = new Promise(resolve => { signalRequest = resolve; });
  const wrappedPool = onQuery => ({
    query: async (...args) => { const result = await pool.query(...args); await onQuery(args[0], 'after'); return result; },
    connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (...args) => {
        await onQuery(args[0], 'before');
        const result = await client.query(...args);
        await onQuery(args[0], 'after');
        return result;
      } };
    }
  });
  const clearingStore = new ExposureStore({ pool: wrappedPool(async (sql, phase) => {
    if (phase === 'after' && /SELECT scan_id FROM nv_exposure_scans/.test(sql) && /FOR UPDATE/.test(sql)) {
      signalClear();
      await continueClear;
    }
  }) });
  const admissionStore = new ExposureStore({ pool: wrappedPool(async (sql, phase) => {
    if ((phase === 'before' && /pg_advisory_xact_lock/.test(sql))
      || (phase === 'after' && /INSERT INTO nv_exposure_scans/.test(sql))) signalRequest();
  }) });
  const clearing = clearingStore.clearHistory({ scope, identityKey });
  let requesting;
  let completed = false;
  try {
    await clearRead;
    requesting = request(admissionStore, 'hardening-three', at + 61_020).then(value => { completed = true; return value; });
    await requestAttempted;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(completed, false, 'new admission waits until a concurrent clear commits');
  } finally {
    releaseClear();
    await clearing;
    if (requesting) await requesting;
  }
  const active = await requesting;
  const activeClaim = await store.claimScan({ now: at + 61_021 });
  assert.strictEqual(active.scan.scanId, activeClaim.scan.scanId);
  await store.recordObservations({ scanId: active.scan.scanId, claimOwner: activeClaim.claimOwner,
    now: at + 61_022, findings: [finding] });
  await assert.rejects(store.clearHistory({ scope, identityKey }), error => error.code === 'EXPOSURE_SCAN_ACTIVE');
  assert(await store.getFinding({ scope, identityKey, fingerprint }), 'new scan findings survive the preceding clear');
  await store.cancelScan({ scope, identityKey, scanId: active.scan.scanId, now: at + 61_023 });
  await store.clearHistory({ scope, identityKey });
  assert.strictEqual((await pool.query('SELECT count(*)::integer AS n FROM nv_exposure_history_sightings WHERE scan_id=$1',
    [scan.scan.scanId])).rows[0].n, 0, 'retention cascades to dedupe metadata');

  // Traverse the scanner's full 500-finding ceiling, including exact-page
  // boundaries. Cursor bindings are checked before any cross-scope read.
  const many = await request(store, 'hardening-pages', at + 62_000);
  const pageClaim = await store.claimScan({ now: at + 62_001 });
  const all = Array.from({ length: 500 }, (_, index) => ({ ...finding,
    fingerprint: (index + 1).toString(16).padStart(64, '0'), path: `item-${index}.env` }));
  await store.recordObservations({ scanId: many.scan.scanId, claimOwner: pageClaim.claimOwner,
    now: at + 62_002, findings: all });
  await store.finalizeScan({ scanId: many.scan.scanId, claimOwner: pageClaim.claimOwner,
    now: at + 62_003, state: 'complete', coverage: 'complete' });
  const pageInput = { scope, identityKey, scanId: many.scan.scanId, limit: 100 };
  const first = await store.scanReportPage(pageInput);
  assert.strictEqual(first.observations.length, 100);
  assert.strictEqual(first.complete, false);
  assert(first.nextCursor);
  const received = first.observations.map(entry => entry.observation.fingerprint);
  let page = first;
  let pages = 1;
  while (!page.complete && pages < 6) {
    page = await store.scanReportPage({ ...pageInput, cursor: page.nextCursor });
    received.push(...page.observations.map(entry => entry.observation.fingerprint));
    pages += 1;
  }
  assert.strictEqual(pages, 5);
  assert.strictEqual(page.complete, true);
  assert.strictEqual(page.nextCursor, null);
  assert.strictEqual(new Set(received).size, 500);
  assert.deepStrictEqual(received, all.map(item => item.fingerprint));
  assert.strictEqual((await store.scanReport({ ...pageInput, limit: 100 })).length, 100,
    'the legacy array API remains compatible');
  for (const different of [{ scope: { ...scope, repo: 'Elsewhere' } },
    { identityKey: '7'.repeat(64) }, { scanId: scan.scan.scanId }]) {
    await assert.rejects(store.scanReportPage({ ...pageInput, ...different, cursor: first.nextCursor }),
      error => error.code === 'EXPOSURE_CURSOR_INVALID');
  }
  await assert.rejects(store.scanReportPage({ ...pageInput, cursor: first.nextCursor + 'x' }),
    error => error.code === 'EXPOSURE_CURSOR_INVALID');
  await store.acceptRisk({ scope, identityKey, fingerprint: all[0].fingerprint, actor: 'fixture', now: at + 62_004 });
  await assert.rejects(store.scanReportPage({ ...pageInput, cursor: first.nextCursor }),
    error => error.code === 'EXPOSURE_CURSOR_STALE', 'paging rejects evidence changed between pages');
  await store.clearHistory({ scope, identityKey });
  const empty = await store.scanReportPage(pageInput);
  assert.deepStrictEqual(empty.observations, []);
  assert.strictEqual(empty.complete, true);
  assert.strictEqual(empty.nextCursor, null);
};
