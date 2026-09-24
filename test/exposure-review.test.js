'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memorySingleUseStore } = require('../src/single-use-store');
const { writeLiveClient, DROPPED } = require('../src/live-stream');
const { guardedFetch, PROFILES } = require('../src/guarded-fetch');
const { createExposureRunner } = require('../src/exposure-worker');
const { fingerprintKeyId, FINGERPRINT_KEY_VERSION } = require('../src/exposure-findings');
const { RULES_VERSION, DETECTION_ENGINE_VERSION } = require('../src/exposure-detection');
const { EXPOSURE_CONFIG_VERSION } = require('../src/exposure-store');
const { resolveExposureSession } = require('../src/exposure-session');
const { alphaActorLabel } = require('../src/alpha-privacy');

test('capacity cannot evict an unexpired single-use grant', () => {
  const map = new Map();
  const store = memorySingleUseStore(map, { maxEntries: 100 });
  for (let i = 0; i < 100; i += 1) {
    assert.equal(store.consumeOnce({ key: String(i), expiresAt: 2000, now: 1000 }), true);
  }
  assert.equal(store.consumeOnce({ key: 'overflow', expiresAt: 2000, now: 1000 }), false);
  assert.equal(store.consumeOnce({ key: '0', expiresAt: 2000, now: 1000 }), false);
  assert.equal(map.size, 100);
  assert.equal(store.consumeOnce({ key: 'new', expiresAt: 3000, now: 2001 }), true);
});

test('an SSE payload cannot cross the buffer ceiling and destroys a stalled socket', () => {
  const client = { writableLength: 8, writes: 0, destroys: 0,
    write() { this.writes += 1; }, destroy() { this.destroys += 1; } };
  assert.equal(writeLiveClient(client, 'abc', { maxBufferedBytes: 10 }), DROPPED);
  assert.equal(client.writes, 0);
  assert.equal(client.destroys, 1);
});

test('the outbound deadline includes DNS and late DNS cannot open a socket', async () => {
  let finishDns;
  let sockets = 0;
  const dns = new Promise(resolve => { finishDns = resolve; });
  const started = Date.now();
  const request = guardedFetch({
    url: 'https://example.com/', profile: PROFILES.PROVIDER_READ, method: 'GET', deadlineMs: 1000,
    resolveAddresses: () => dns,
    requestImpl() { sockets += 1; throw new Error('No socket should be created'); }
  }).catch(error => error);
  let timer;
  const outcome = await Promise.race([request, new Promise(resolve => {
    timer = setTimeout(() => resolve(null), 1400);
  })]);
  clearTimeout(timer);
  finishDns([{ address: '93.184.216.34', family: 4 }]);
  await request;
  assert.equal(outcome && outcome.code, 'GUARDED_FETCH_DEADLINE');
  assert(Date.now() - started < 1400);
  assert.equal(sockets, 0);
});

function workerFixture(files = 2, budgets = undefined) {
  const key = Buffer.alloc(32, 7);
  const fixture = { active: true, held: true, read: 0, recorded: [], final: null };
  fixture.scan = {
    scanId: 'review-scan', scope: { provider: 'github', authority: 'github.com', owner: 'a', repo: 'b' },
    requestedBy: 'alice', commitSha: 'c'.repeat(40), rulesVersion: RULES_VERSION,
    engineVersion: DETECTION_ENGINE_VERSION, fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
    fingerprintKeyId: fingerprintKeyId(key), configVersion: EXPOSURE_CONFIG_VERSION
  };
  fixture.run = () => createExposureRunner({
    fingerprintKey: key,
    ...(budgets ? { budgets } : {}),
    store: {
      claimScan: async () => ({ scan: fixture.scan, claimOwner: 'review-owner' }),
      renewClaim: async () => fixture.held,
      recordObservations: async input => { fixture.recorded.push(...input.findings); },
      finalizeScan: async input => { fixture.final = input; }
    },
    sessionResolver: async () => fixture.active ? { token: 'fixture-session' } : null,
    reader: {
      readTree: async () => ({ entries: Array.from({ length: files }, (_, index) => ({
        path: index + '.js', sha: String(index)
      })), skipped: [] }),
      readBlob: async () => {
        fixture.read += 1;
        if (fixture.afterBlob) fixture.afterBlob();
        return { text: 'token = gh' + 'p_' + 'S'.repeat(36) };
      }
    }
  }).runOnce();
  return fixture;
}

test('the finding ceiling applies across all observation batches', async () => {
  const fixture = workerFixture(502);
  await fixture.run();
  assert.equal(fixture.recorded.length, 500);
  assert.equal(fixture.final.state, 'partial');
  assert.equal(fixture.final.skippedReason, 'finding-limit');
});

/*
 * Strict configuration: one read at a time and authorization rechecked before
 * every read. A revocation during a read stops the scan before a second read
 * and before anything is written. This is the original review guarantee, kept
 * as a tested configuration.
 */
test('authorization revoked during a blob read stops further reads and writes', async () => {
  const fixture = workerFixture(2, { readConcurrency: 1, renewEveryFiles: 1 });
  fixture.afterBlob = () => { fixture.active = false; };
  await fixture.run();
  assert.equal(fixture.read, 1);
  assert.equal(fixture.recorded.length, 0);
  assert.equal(fixture.final.skippedReason, 'authorization-revoked');
});

/*
 * Default configuration: reads overlap and authorization is rechecked every
 * `renewEveryFiles` reads or `accessCheckIntervalMs`, and unconditionally
 * before every write. The guarantee is bounded rather than per read: reads
 * already in flight when the revocation lands may complete, but no read is
 * started after it has been noticed, and nothing read under a revoked
 * session is ever written.
 */
test('under the default budgets a revocation still stops the scan before anything is written', async () => {
  const fixture = workerFixture(40);
  fixture.afterBlob = () => { if (fixture.read === 3) fixture.active = false; };
  await fixture.run();
  assert.equal(fixture.recorded.length, 0, 'nothing read under a revoked session is written');
  assert.equal(fixture.final.skippedReason, 'authorization-revoked');
  assert(fixture.read < 40, `the scan stopped rather than reading everything: ${fixture.read}`);
});

test('a lost claim stops without publishing or finalizing stale work', async () => {
  const fixture = workerFixture();
  fixture.afterBlob = () => { fixture.held = false; };
  assert.equal((await fixture.run()).stopped, 'claim-lost');
  assert.equal(fixture.recorded.length, 0);
  assert.equal(fixture.final, null);
});

test('a queued scan cannot execute with a different fingerprint key', async () => {
  const fixture = workerFixture();
  fixture.scan.fingerprintKeyId = '0'.repeat(64);
  assert.equal((await fixture.run()).stopped, 'configuration-changed');
  assert.equal(fixture.read, 0);
  assert.equal(fixture.final.skippedReason, 'configuration-changed');
});

test('hosted session resolution checks ownership, identity, scope and revocation', async () => {
  const testerId = '00000000-0000-4000-8000-000000000001';
  const key = '1'.repeat(64);
  const account = { provider: 'github', login: 'different-provider-login', token: 'fixture-token' };
  const scope = { provider: 'github', authority: 'github.com', owner: 'a', repo: 'b' };
  const input = { scope, scanId: 'fixture', requestedBy: alphaActorLabel({ testerId }) };
  const dependencies = {
    pool: { async query(sql) {
      if (sql.includes('FROM nv_exposure_scans')) return { rows: [{ identity_key: key }] };
      if (sql.includes('FROM nv_sessions')) return { rows: [{ sid: 'sid', session_key_hash: 'hash' }] };
      return { rows: [{ tester_id: testerId, session_id: 'access' }] };
    } },
    identityKey: () => key, providerAuthority: () => 'github.com', resolveAccount: async value => value,
    alphaEnabled: true, readAlphaSession: async () => ({ testerId }),
    readOwnedSession: async () => ({ session: { accounts: [account] } }),
    repositoryAllowed: () => true
  };
  assert.equal((await resolveExposureSession(input, dependencies)).token, 'fixture-token');
  assert.equal(await resolveExposureSession(input, { ...dependencies, identityKey: () => '2'.repeat(64) }), null);
  assert.equal(await resolveExposureSession(input, { ...dependencies, repositoryAllowed: () => false }), null);
  assert.equal(await resolveExposureSession(input, {
    ...dependencies, readAlphaSession: async () => { throw new Error('revoked'); }
  }), null);
});
