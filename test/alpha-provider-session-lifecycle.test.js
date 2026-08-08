'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AlphaPrivacyStore } = require('../src/alpha-privacy-store');
const {
  disconnectProviderAccount,
  providerSessionKeyHash
} = require('../src/provider-disconnect');

const TESTER_A = '12345678-1234-4234-9234-123456789abc';
const TESTER_B = '22345678-1234-4234-9234-123456789abc';
const IDENTITY_A = 'a'.repeat(64);
const IDENTITY_B = 'b'.repeat(64);
const IDENTITY_C = 'd'.repeat(64);
const SID = 'provider-session-owned-by-tester-a';
const SID_HASH = providerSessionKeyHash(SID);
const SESSION_TASK = '30000000-0000-4000-8000-000000000001';
const HOOK_TASK = '30000000-0000-4000-8000-000000000002';
const SECOND_SESSION_TASK = '30000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-08-08T12:00:00.000Z');

function encode(value) {
  return `sealed:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

function decode(value) {
  if (typeof value !== 'string' || !value.startsWith('sealed:')) return null;
  return JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8'));
}

function accountIdentityKey(account) {
  return String(account && account.identityKey || '');
}

function baselineState() {
  return {
    testers: [
      { tester_id: TESTER_A, revoked_at: null, metadata_purged_at: null },
      { tester_id: TESTER_B, revoked_at: null, metadata_purged_at: null }
    ],
    deletions: [],
    bindings: [
      { tester_id: TESTER_A, identity_key: IDENTITY_A, provider: 'github', authority: 'github.com', connected_at: NOW, disconnected_at: null },
      { tester_id: TESTER_A, identity_key: IDENTITY_B, provider: 'github', authority: 'github.com', connected_at: NOW, disconnected_at: null }
    ],
    ownership: [
      { session_key_hash: SID_HASH, tester_id: TESTER_A, identity_key: IDENTITY_A, provider: 'github', claimed_at: NOW, released_at: null },
      { session_key_hash: SID_HASH, tester_id: TESTER_A, identity_key: IDENTITY_B, provider: 'github', claimed_at: NOW, released_at: null }
    ],
    webhookOwnership: [],
    manifests: [
      { manifest_id: '40000000-0000-4000-8000-000000000001', tester_id: TESTER_A, identity_key: IDENTITY_A, provider: 'github', resource_type: 'provider-session', resource_key_hash: SID_HASH, created_at: NOW },
      { manifest_id: '40000000-0000-4000-8000-000000000002', tester_id: TESTER_A, identity_key: IDENTITY_A, provider: 'github', resource_type: 'provider-webhook', resource_key_hash: 'c'.repeat(64), created_at: NOW }
    ],
    tasks: [
      { cleanup_id: SESSION_TASK, manifest_id: '40000000-0000-4000-8000-000000000001', tester_id: TESTER_A, identity_key: IDENTITY_A, provider: 'github', resource_type: 'provider-session', resource_key_hash: SID_HASH, status: 'pending', reason_code: '', created_at: NOW, verified_at: null },
      { cleanup_id: HOOK_TASK, manifest_id: '40000000-0000-4000-8000-000000000002', tester_id: TESTER_A, identity_key: IDENTITY_A, provider: 'github', resource_type: 'provider-webhook', resource_key_hash: 'c'.repeat(64), status: 'verified', reason_code: '', created_at: NOW, verified_at: NOW }
    ],
    sessions: [{
      sid: SID,
      data: encode({
        accounts: [
          { identityKey: IDENTITY_A, provider: 'github', login: 'private-a', token: 'token-a' },
          { identityKey: IDENTITY_B, provider: 'github', login: 'private-b', token: 'token-b' }
        ],
        active: 0,
        security: {
          githubApp: {
            target: { identityKey: IDENTITY_A, userToken: 'pending-token-a' },
            other: { identityKey: IDENTITY_B, userToken: 'pending-token-b' }
          }
        }
      }),
      identity_keys: [IDENTITY_A, IDENTITY_B],
      session_key_hash: SID_HASH,
      revision: 7,
      updated: NOW
    }],
    installations: [
      { identity_key: IDENTITY_A, installation_id: 91 },
      { identity_key: IDENTITY_B, installation_id: 92 }
    ]
  };
}

class FakePool {
  constructor(state = baselineState()) {
    this.state = structuredClone(state);
    this.calls = [];
    this.failBindingDisconnect = false;
    this.failSessionWrite = false;
    this.injectCasConflict = false;
  }

  async query(sql, params = []) {
    const client = new FakeClient(this);
    return client.query(sql, params);
  }

  async connect() {
    return new FakeClient(this);
  }
}

class FakeClient {
  constructor(pool) {
    this.pool = pool;
    this.snapshot = null;
  }

  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    this.pool.calls.push({ sql: text, params: structuredClone(params) });
    if (text === 'BEGIN') {
      this.snapshot = structuredClone(this.pool.state);
      return { rows: [], rowCount: 0 };
    }
    if (text === 'COMMIT') {
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'ROLLBACK') {
      if (this.snapshot) this.pool.state = this.snapshot;
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}], rowCount: 1 };
    if (/FROM nv_alpha_testers WHERE tester_id=\$1 FOR UPDATE/.test(text)) {
      const row = this.pool.state.testers.find(item => item.tester_id === params[0]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM nv_alpha_deletion_requests WHERE tester_id=\$1 FOR UPDATE/.test(text)) {
      const row = this.pool.state.deletions.find(item => item.tester_id === params[0]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM nv_alpha_provider_session_ownership WHERE session_key_hash=\$1 FOR UPDATE/.test(text)) {
      const rows = this.pool.state.ownership.filter(item => item.session_key_hash === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_session_ownership WHERE tester_id=\$1 AND identity_key=\$2 AND provider=\$3 ORDER BY session_key_hash FOR UPDATE/.test(text)) {
      const rows = this.pool.state.ownership.filter(item => (
        item.tester_id === params[0] && item.identity_key === params[1] && item.provider === params[2]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_session_ownership WHERE session_key_hash=ANY\(\$1::text\[\]\)/.test(text)) {
      const rows = this.pool.state.ownership.filter(item => params[0].includes(item.session_key_hash));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_bindings WHERE tester_id=\$1 AND identity_key=\$2 AND provider=\$3 FOR UPDATE/.test(text)) {
      const rows = this.pool.state.bindings.filter(item => (
        item.tester_id === params[0] && item.identity_key === params[1] && item.provider === params[2]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/SELECT EXISTS\( SELECT 1 FROM nv_alpha_cleanup_manifest/.test(text)) {
      const exists = this.pool.state.manifests.some(item => (
        item.tester_id === params[0] && item.identity_key === params[1]
      ));
      return { rows: [{ lifecycle_started: exists }], rowCount: 1 };
    }
    if (/FROM nv_alpha_cleanup_tasks WHERE cleanup_id=\$1 AND tester_id=\$2 FOR UPDATE/.test(text)) {
      const row = this.pool.state.tasks.find(item => item.cleanup_id === params[0] && item.tester_id === params[1]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM nv_alpha_cleanup_tasks WHERE cleanup_id=ANY\(\$1::uuid\[\]\) AND tester_id=\$2/.test(text)) {
      const rows = this.pool.state.tasks.filter(item => (
        params[0].includes(item.cleanup_id) && item.tester_id === params[1]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_cleanup_manifest manifest INNER JOIN nv_alpha_cleanup_tasks task/.test(text)) {
      const rows = this.pool.state.tasks.filter(item => (
        item.tester_id === params[0] && item.identity_key === params[1] && item.provider === params[2]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_bindings WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.bindings.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_cleanup_manifest WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.manifests.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_cleanup_tasks WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.tasks.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_session_ownership WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.ownership.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_webhook_ownership WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.webhookOwnership.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_webhook_ownership ownership JOIN nv_alpha_testers tester/.test(text)) {
      const rows = this.pool.state.webhookOwnership.filter(item => (
        item.identity_key === params[0] && item.provider === params[1]
      )).map(item => ({
        ...structuredClone(item),
        tester_revoked_at: this.pool.state.testers.find(tester => tester.tester_id === item.tester_id).revoked_at
      }));
      return { rows, rowCount: rows.length };
    }
    if (/FROM nv_sessions WHERE sid=\$1 FOR UPDATE/.test(text)) {
      const row = this.pool.state.sessions.find(item => item.sid === params[0]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM nv_sessions WHERE session_key_hash=ANY\(\$1::text\[\]\)/.test(text)) {
      const rows = this.pool.state.sessions.filter(item => params[0].includes(item.session_key_hash));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/AS active_webhook_ownership/.test(text)) {
      const exists = this.pool.state.webhookOwnership.some(item => (
        item.tester_id === params[0] && item.identity_key === params[1]
        && item.provider === params[2] && !item.released_at
      ));
      return { rows: [{ active_webhook_ownership: exists }], rowCount: 1 };
    }
    if (/AS shared_provider_state/.test(text)) {
      const sharedBinding = this.pool.state.bindings.some(item => (
        item.identity_key === params[0] && item.provider === params[1]
        && item.tester_id !== params[2] && !item.disconnected_at
        && this.pool.state.testers.some(tester => tester.tester_id === item.tester_id && !tester.revoked_at)
      ));
      const sharedOwner = this.pool.state.ownership.some(item => (
        item.identity_key === params[0] && item.provider === params[1]
        && item.tester_id !== params[2] && !item.released_at
        && this.pool.state.testers.some(tester => tester.tester_id === item.tester_id && !tester.revoked_at)
      ));
      return { rows: [{ shared_provider_state: sharedBinding || sharedOwner }], rowCount: 1 };
    }
    if (/INSERT INTO nv_alpha_provider_bindings/.test(text)) {
      const row = {
        tester_id: params[0], identity_key: params[1], provider: params[2],
        authority: params[3], connected_at: params[4], disconnected_at: null
      };
      this.pool.state.bindings.push(row);
      return { rows: [{ connected_at: row.connected_at }], rowCount: 1 };
    }
    if (/INSERT INTO nv_alpha_provider_session_ownership/.test(text)) {
      const row = {
        session_key_hash: params[0], tester_id: params[1], identity_key: params[2],
        provider: params[3], claimed_at: params[4], released_at: null
      };
      this.pool.state.ownership.push(row);
      return { rows: [{ claimed_at: row.claimed_at }], rowCount: 1 };
    }
    if (/INSERT INTO nv_sessions\(sid,data,identity_keys,session_key_hash,revision,updated\)/.test(text)) {
      if (this.pool.failSessionWrite) throw new Error('injected session insert failure');
      const row = {
        sid: params[0], data: params[1], identity_keys: [...params[2]],
        session_key_hash: params[3], revision: 0, updated: params[4]
      };
      this.pool.state.sessions.push(row);
      return { rows: [{ revision: 0 }], rowCount: 1 };
    }
    if (/UPDATE nv_alpha_cleanup_tasks SET status='verified'/.test(text)) {
      const row = this.pool.state.tasks.find(item => item.cleanup_id === params[0] && item.tester_id === params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      if (row.status !== 'verified') {
        row.status = 'verified';
        row.verified_at = params[2];
      }
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/UPDATE nv_sessions SET data=\$2,identity_keys=\$3::text\[\],revision=revision\+1/.test(text)) {
      const row = this.pool.state.sessions.find(item => item.sid === params[0]);
      if (this.pool.injectCasConflict) {
        this.pool.injectCasConflict = false;
        row.revision += 1;
        row.data = encode({ ...decode(row.data), concurrentMarker: 'preserved' });
        if (this.snapshot) {
          const snap = this.snapshot.sessions.find(item => item.sid === params[0]);
          snap.revision = row.revision;
          snap.data = row.data;
        }
        return { rows: [], rowCount: 0 };
      }
      if (!row || row.revision !== params[4]) return { rows: [], rowCount: 0 };
      row.data = params[1];
      row.identity_keys = [...params[2]];
      row.revision += 1;
      row.updated = params[3];
      return { rows: [{ revision: row.revision }], rowCount: 1 };
    }
    if (/DELETE FROM nv_sessions WHERE sid=\$1 AND revision=\$2/.test(text)) {
      const index = this.pool.state.sessions.findIndex(item => item.sid === params[0] && item.revision === params[1]);
      if (index < 0) return { rows: [], rowCount: 0 };
      this.pool.state.sessions.splice(index, 1);
      return { rows: [{}], rowCount: 1 };
    }
    if (/DELETE FROM nv_sessions WHERE sid=\$1 AND session_key_hash=\$2 AND revision=\$3/.test(text)) {
      const index = this.pool.state.sessions.findIndex(item => (
        item.sid === params[0] && item.session_key_hash === params[1] && item.revision === params[2]
      ));
      if (index < 0) return { rows: [], rowCount: 0 };
      const [removed] = this.pool.state.sessions.splice(index, 1);
      return { rows: [{ sid: removed.sid }], rowCount: 1 };
    }
    if (/DELETE FROM nv_github_app_installations WHERE identity_key=\$1/.test(text)) {
      const before = this.pool.state.installations.length;
      this.pool.state.installations = this.pool.state.installations.filter(item => item.identity_key !== params[0]);
      return { rows: [], rowCount: before - this.pool.state.installations.length };
    }
    if (/UPDATE nv_alpha_provider_session_ownership SET released_at=\$5/.test(text)) {
      const row = this.pool.state.ownership.find(item => (
        item.session_key_hash === params[0] && item.tester_id === params[1]
        && item.identity_key === params[2] && item.provider === params[3] && !item.released_at
      ));
      if (!row) return { rows: [], rowCount: 0 };
      row.released_at = params[4];
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/UPDATE nv_alpha_provider_session_ownership SET released_at=\$4 WHERE tester_id=\$1 AND identity_key=\$2 AND provider=\$3/.test(text)) {
      const rows = this.pool.state.ownership.filter(item => (
        item.tester_id === params[0] && item.identity_key === params[1]
        && item.provider === params[2] && !item.released_at
      ));
      for (const row of rows) row.released_at = params[3];
      return { rows: [], rowCount: rows.length };
    }
    if (/UPDATE nv_alpha_provider_session_ownership SET released_at=\$3 WHERE tester_id=\$1 AND session_key_hash=ANY\(\$2::text\[\]\)/.test(text)) {
      const rows = this.pool.state.ownership.filter(item => (
        item.tester_id === params[0] && params[1].includes(item.session_key_hash) && !item.released_at
      ));
      for (const row of rows) row.released_at = params[2];
      return { rows: [], rowCount: rows.length };
    }
    if (/UPDATE nv_alpha_provider_bindings SET disconnected_at=\$4/.test(text)) {
      if (this.pool.failBindingDisconnect) return { rows: [], rowCount: 0 };
      const row = this.pool.state.bindings.find(item => (
        item.tester_id === params[0] && item.identity_key === params[1]
        && item.provider === params[2] && !item.disconnected_at
      ));
      if (!row) return { rows: [], rowCount: 0 };
      row.disconnected_at = params[3];
      return { rows: [{ disconnected_at: row.disconnected_at }], rowCount: 1 };
    }
    throw new Error(`Unhandled fake SQL: ${text}`);
  }

  release() {}
}

function makeStore(pool) {
  return new AlphaPrivacyStore({
    pool,
    now: () => NOW,
    sessionCodec: { encode, decode, identityKey: accountIdentityKey }
  });
}

async function testMigrationContract() {
  const migration = path.join(__dirname, '..', 'db', 'migrations', '015_alpha_privacy.sql');
  assert(fs.existsSync(migration), 'missing alpha privacy migration');
  const sql = fs.readFileSync(migration, 'utf8');
  assert.match(sql, /ALTER TABLE nv_sessions[\s\S]+ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS session_key_hash text/);
  assert.match(sql, /nv_sessions_alpha_session_key_hash_unique/);
  assert.match(sql, /PRIMARY KEY\(session_key_hash,tester_id,identity_key,provider\)/);
  assert.match(sql, /nv_alpha_provider_session_owner_guard/);
  assert.match(sql, /existing\.tester_id<>NEW\.tester_id/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS alpha_resource_key_hash text/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS nv_alpha_provider_webhook_ownership/);
  assert.match(sql, /PRIMARY KEY\(tester_id,identity_key,provider,resource_key_hash\)/);
  assert.doesNotMatch(
    sql.match(/CREATE TABLE IF NOT EXISTS nv_alpha_provider_webhook_ownership[\s\S]+?;\n/)?.[0] || '',
    /provider_hook_id|hook_id/,
    'alpha webhook ownership must persist hashes rather than provider/local hook IDs'
  );
}

async function testOwnershipPrecedesRawSidLookup() {
  const pool = new FakePool();
  const store = makeStore(pool);
  await assert.rejects(
    () => store.readHostedProviderSession({ testerId: TESTER_B, sessionId: SID }),
    error => error && error.code === 'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
  );
  const ownershipIndex = pool.calls.findIndex(call => /nv_alpha_provider_session_ownership/.test(call.sql));
  const sidIndex = pool.calls.findIndex(call => /FROM nv_sessions WHERE sid=/.test(call.sql));
  assert(ownershipIndex >= 0);
  assert.strictEqual(sidIndex, -1, 'foreign tester SID must be rejected before raw SID-bound state is read');
  assert.strictEqual(pool.state.sessions[0].revision, 7);
  assert.strictEqual(decode(pool.state.sessions[0].data).accounts[0].token, 'token-a');
}

async function testCasConflictRecomputesFromCurrentEncryptedRow() {
  const pool = new FakePool();
  pool.injectCasConflict = true;
  const store = makeStore(pool);
  const seenRevisions = [];
  const updated = await store.mutateHostedProviderSession({
    testerId: TESTER_A,
    sessionId: SID,
    mutate(session, context) {
      seenRevisions.push(context.revision);
      session.intentMarker = `computed-at-${context.revision}`;
      return session;
    }
  });
  assert.deepStrictEqual(seenRevisions, [7, 8], 'CAS retry must recompute from the new current row');
  assert.strictEqual(updated.revision, 9);
  const current = decode(pool.state.sessions[0].data);
  assert.strictEqual(current.concurrentMarker, 'preserved');
  assert.strictEqual(current.intentMarker, 'computed-at-8');
  assert.deepStrictEqual(pool.state.sessions[0].identity_keys, [IDENTITY_A, IDENTITY_B]);
}

async function testAtomicFinalizationPreservesUnrelatedAccounts() {
  const pool = new FakePool();
  const store = makeStore(pool);
  const result = await store.finalizeProviderDisconnect({
    testerId: TESTER_A,
    identityKey: IDENTITY_A,
    provider: 'github',
    sessionId: SID,
    sessionKeyHash: SID_HASH,
    providerSessionCleanupId: SESSION_TASK
  });
  assert.deepStrictEqual(result, {
    finalized: true,
    sessionRemoved: false,
    accountRemoved: true,
    sharedProviderState: false
  });
  const session = decode(pool.state.sessions[0].data);
  assert.deepStrictEqual(session.accounts, [
    { identityKey: IDENTITY_B, provider: 'github', login: 'private-b', token: 'token-b' }
  ]);
  assert.strictEqual(session.active, 0);
  assert.strictEqual(session.security.githubApp.target, undefined);
  assert.strictEqual(session.security.githubApp.other.userToken, 'pending-token-b');
  assert.deepStrictEqual(pool.state.sessions[0].identity_keys, [IDENTITY_B]);
  assert.strictEqual(pool.state.sessions[0].revision, 8);
  assert(pool.state.bindings.find(item => item.identity_key === IDENTITY_A).disconnected_at);
  assert.strictEqual(pool.state.bindings.find(item => item.identity_key === IDENTITY_B).disconnected_at, null);
  assert(pool.state.ownership.find(item => item.identity_key === IDENTITY_A).released_at);
  assert.strictEqual(pool.state.ownership.find(item => item.identity_key === IDENTITY_B).released_at, null);
  assert.strictEqual(pool.state.tasks.find(item => item.cleanup_id === SESSION_TASK).status, 'verified');
  assert.deepStrictEqual(pool.state.installations, [{ identity_key: IDENTITY_B, installation_id: 92 }]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [IDENTITY_A, SID_HASH, SID, 'token-a', 'private-a']) assert(!serialized.includes(forbidden));
}

async function testLateFailureRollsBackEveryFinalizationWrite() {
  const pool = new FakePool();
  pool.failBindingDisconnect = true;
  const before = structuredClone(pool.state);
  const store = makeStore(pool);
  await assert.rejects(
    () => store.finalizeProviderDisconnect({
      testerId: TESTER_A,
      identityKey: IDENTITY_A,
      provider: 'github',
      sessionId: SID,
      sessionKeyHash: SID_HASH,
      providerSessionCleanupId: SESSION_TASK
    }),
    error => error && error.code === 'ALPHA_PROVIDER_DISCONNECT_CONFLICT'
  );
  assert.deepStrictEqual(pool.state, before, 'late binding conflict must roll back task/session/installation/ownership changes');
}

async function testTerminalRetryScrubsReintroducedTokenState() {
  const pool = new FakePool();
  const store = makeStore(pool);
  await store.finalizeProviderDisconnect({
    testerId: TESTER_A, identityKey: IDENTITY_A, provider: 'github',
    sessionId: SID, sessionKeyHash: SID_HASH, providerSessionCleanupId: SESSION_TASK
  });
  const row = pool.state.sessions[0];
  const reintroduced = decode(row.data);
  reintroduced.accounts.push({
    identityKey: IDENTITY_A, provider: 'github', login: 'reintroduced-a', token: 'reintroduced-token-a'
  });
  reintroduced.security.githubApp.targetAgain = {
    identityKey: IDENTITY_A, userToken: 'reintroduced-pending-token-a'
  };
  row.data = encode(reintroduced);
  row.identity_keys.push(IDENTITY_A);
  row.revision += 1;
  const retried = await store.finalizeProviderDisconnect({
    testerId: TESTER_A, identityKey: IDENTITY_A, provider: 'github',
    sessionId: SID, sessionKeyHash: SID_HASH, providerSessionCleanupId: SESSION_TASK
  });
  assert.strictEqual(retried.finalized, true);
  const scrubbed = decode(pool.state.sessions[0].data);
  assert.strictEqual(scrubbed.accounts.some(item => item.identityKey === IDENTITY_A), false);
  assert.strictEqual(scrubbed.security.githubApp.targetAgain, undefined);
  assert(!pool.state.sessions[0].identity_keys.includes(IDENTITY_A));
  assert.strictEqual(pool.state.tasks.find(item => item.cleanup_id === SESSION_TASK).status, 'verified');
}

async function testSharedInstallationSurvivesOtherTesterFinalization() {
  const state = baselineState();
  const sidBHash = providerSessionKeyHash('provider-session-owned-by-tester-b');
  state.bindings.push({
    tester_id: TESTER_B, identity_key: IDENTITY_A, provider: 'github', authority: 'github.com',
    connected_at: NOW, disconnected_at: null
  });
  state.ownership.push({
    session_key_hash: sidBHash, tester_id: TESTER_B, identity_key: IDENTITY_A,
    provider: 'github', claimed_at: NOW, released_at: null
  });
  const pool = new FakePool(state);
  const store = makeStore(pool);
  const result = await store.finalizeProviderDisconnect({
    testerId: TESTER_A, identityKey: IDENTITY_A, provider: 'github',
    sessionId: SID, sessionKeyHash: SID_HASH, providerSessionCleanupId: SESSION_TASK
  });
  assert.strictEqual(result.sharedProviderState, true);
  assert(pool.state.installations.some(item => item.identity_key === IDENTITY_A),
    'shared GitHub App installation metadata must not be deleted');
  assert.strictEqual(
    pool.state.bindings.find(item => item.tester_id === TESTER_B && item.identity_key === IDENTITY_A).disconnected_at,
    null
  );
  assert.strictEqual(
    pool.state.ownership.find(item => item.tester_id === TESTER_B && item.identity_key === IDENTITY_A).released_at,
    null
  );
}

function emptyConnectionState() {
  const state = baselineState();
  state.bindings = [];
  state.ownership = [];
  state.manifests = [];
  state.tasks = [];
  state.sessions = [];
  state.installations = [];
  return state;
}

async function testConnectionCapacityRejectsBeforeClaims() {
  const pool = new FakePool();
  const store = makeStore(pool);
  await assert.rejects(
    () => store.connectHostedProviderAccount({
      testerId: TESTER_A,
      sessionId: SID,
      account: { identityKey: IDENTITY_C, provider: 'github', login: 'private-c', token: 'token-c' },
      authority: 'github.com',
      capacity: 2
    }),
    error => error && error.code === 'ALPHA_PROVIDER_ACCOUNT_CAPACITY'
  );
  assert.strictEqual(pool.state.bindings.some(item => item.identity_key === IDENTITY_C), false);
  assert.strictEqual(pool.state.ownership.some(item => item.identity_key === IDENTITY_C), false);
  assert.strictEqual(pool.calls.some(call => /INSERT INTO nv_alpha_provider_bindings/.test(call.sql)), false);
}

async function testConnectionSessionFailureCompensatesClaims() {
  const pool = new FakePool(emptyConnectionState());
  pool.failSessionWrite = true;
  const store = makeStore(pool);
  await assert.rejects(
    () => store.connectHostedProviderAccount({
      testerId: TESTER_A,
      sessionId: SID,
      account: { identityKey: IDENTITY_A, provider: 'github', login: 'private-a', token: 'token-a' },
      authority: 'github.com',
      capacity: 10
    }),
    /injected session insert failure/
  );
  assert.deepStrictEqual(pool.state.bindings, []);
  assert.deepStrictEqual(pool.state.ownership, []);
  assert.deepStrictEqual(pool.state.sessions, []);

  pool.failSessionWrite = false;
  const connected = await store.connectHostedProviderAccount({
    testerId: TESTER_A,
    sessionId: SID,
    account: { identityKey: IDENTITY_A, provider: 'github', login: 'private-a', token: 'token-a' },
    authority: 'github.com',
    capacity: 10
  });
  assert.strictEqual(connected.revision, 0);
  assert.strictEqual(pool.state.bindings.length, 1);
  assert.strictEqual(pool.state.ownership.length, 1);
  assert.strictEqual(pool.state.sessions.length, 1);
}

async function testConnectionCasConflictRecomputesAndCompensatesFirstClaims() {
  const pool = new FakePool();
  pool.injectCasConflict = true;
  const store = makeStore(pool);
  const connected = await store.connectHostedProviderAccount({
    testerId: TESTER_A,
    sessionId: SID,
    account: { identityKey: IDENTITY_C, provider: 'github', login: 'private-c', token: 'token-c' },
    authority: 'github.com',
    capacity: 3
  });
  assert.strictEqual(connected.revision, 9);
  assert.strictEqual(connected.session.concurrentMarker, 'preserved');
  assert.deepStrictEqual(connected.session.accounts.map(item => item.identityKey), [
    IDENTITY_A, IDENTITY_B, IDENTITY_C
  ]);
  assert.strictEqual(pool.state.bindings.filter(item => item.identity_key === IDENTITY_C).length, 1);
  assert.strictEqual(pool.state.ownership.filter(item => item.identity_key === IDENTITY_C).length, 1);
}

function multiSessionState() {
  const state = baselineState();
  const secondSid = 'provider-session-second-owned-by-tester-a';
  const secondHash = providerSessionKeyHash(secondSid);
  state.manifests = state.manifests.filter(item => item.resource_type !== 'provider-webhook');
  state.tasks = state.tasks.filter(item => item.resource_type !== 'provider-webhook');
  state.ownership.push({
    session_key_hash: secondHash,
    tester_id: TESTER_A,
    identity_key: IDENTITY_A,
    provider: 'github',
    claimed_at: NOW,
    released_at: null
  });
  state.manifests.push({
    manifest_id: '40000000-0000-4000-8000-000000000003',
    tester_id: TESTER_A,
    identity_key: IDENTITY_A,
    provider: 'github',
    resource_type: 'provider-session',
    resource_key_hash: secondHash,
    created_at: NOW
  });
  state.tasks.push({
    cleanup_id: SECOND_SESSION_TASK,
    manifest_id: '40000000-0000-4000-8000-000000000003',
    tester_id: TESTER_A,
    identity_key: IDENTITY_A,
    provider: 'github',
    resource_type: 'provider-session',
    resource_key_hash: secondHash,
    status: 'pending',
    reason_code: '',
    created_at: NOW,
    verified_at: null
  });
  state.sessions.push({
    sid: secondSid,
    data: encode({
      accounts: [
        { identityKey: IDENTITY_A, provider: 'github', login: 'private-a-2', token: 'token-a-2' },
        { identityKey: IDENTITY_C, provider: 'github', login: 'private-c', token: 'token-c' }
      ],
      active: 0
    }),
    identity_keys: [IDENTITY_A, IDENTITY_C],
    session_key_hash: secondHash,
    revision: 3,
    updated: NOW
  });
  return { state, secondSid, secondHash };
}

async function testProductionServiceFinalizesEveryOwnedSessionAndRetriesTerminalScrub() {
  const fixture = multiSessionState();
  const pool = new FakePool(fixture.state);
  const store = makeStore(pool);
  const options = {
    account: {
      provider: 'github', authMethod: 'token', token: 'private-token', login: 'private-login'
    },
    tester: { testerId: TESTER_A },
    binding: {
      testerId: TESTER_A,
      identityKey: IDENTITY_A,
      provider: 'github',
      authority: 'github.com'
    },
    sessionId: SID,
    enumerateProviderWebhooks: async () => [],
    prepareDisconnect: input => store.prepareProviderDisconnect(input),
    removeProviderWebhook: async () => {
      throw new Error('no webhook deletion expected');
    },
    completeProviderWebhookCleanup: input => store.completeProviderWebhookCleanup(input),
    finalizeDisconnect: input => store.finalizeProviderDisconnect(input),
    invalidateBroker: () => {}
  };
  const first = await disconnectProviderAccount(options);
  assert.strictEqual(first.providerStateRemoved, true);
  assert(pool.state.ownership.filter(item => (
    item.tester_id === TESTER_A && item.identity_key === IDENTITY_A && !item.released_at
  )).length === 0, 'every same-tester provider session ownership must release together');
  for (const row of pool.state.sessions) {
    const current = decode(row.data);
    assert.strictEqual(current.accounts.some(item => item.identityKey === IDENTITY_A), false);
    assert.strictEqual(row.identity_keys.includes(IDENTITY_A), false);
  }
  assert.strictEqual(pool.state.tasks.filter(item => (
    item.resource_type === 'provider-session' && item.status === 'verified'
  )).length, 2);

  const secondRow = pool.state.sessions.find(item => item.session_key_hash === fixture.secondHash);
  const reintroduced = decode(secondRow.data);
  reintroduced.accounts.push({
    identityKey: IDENTITY_A,
    provider: 'github',
    login: 'reintroduced-login',
    token: 'reintroduced-token'
  });
  secondRow.data = encode(reintroduced);
  secondRow.identity_keys.push(IDENTITY_A);
  secondRow.revision += 1;
  const retry = await disconnectProviderAccount(options);
  assert.strictEqual(retry.providerStateRemoved, true,
    'the production service must reach terminal scrub after a lost final response');
  assert.strictEqual(
    decode(secondRow.data).accounts.some(item => item.identityKey === IDENTITY_A),
    false
  );
  assert.strictEqual(secondRow.identity_keys.includes(IDENTITY_A), false);
}

async function testContainmentDeletesSessionAndReleasesAllItsOwnership() {
  const fixture = multiSessionState();
  fixture.state.ownership.push({
    session_key_hash: fixture.secondHash,
    tester_id: TESTER_A,
    identity_key: IDENTITY_C,
    provider: 'github',
    claimed_at: NOW,
    released_at: null
  });
  const pool = new FakePool(fixture.state);
  const store = makeStore(pool);
  const result = await store.revokeOwnedProviderSessions({
    testerId: TESTER_A,
    sessionIds: [fixture.secondSid]
  });
  assert.deepStrictEqual(result, { revokedSessionIds: [fixture.secondSid] });
  assert.strictEqual(pool.state.sessions.some(item => item.sid === fixture.secondSid), false);
  assert.strictEqual(pool.state.sessions.some(item => item.sid === SID), true);
  assert.strictEqual(pool.state.ownership.some(item => (
    item.session_key_hash === fixture.secondHash && !item.released_at
  )), false, 'containment must not leave active ownership for a deleted hosted session');
  assert.strictEqual(pool.state.ownership.some(item => (
    item.session_key_hash === SID_HASH && !item.released_at
  )), true, 'containment must preserve the current owned session');
}

async function run() {
  await testMigrationContract();
  await testOwnershipPrecedesRawSidLookup();
  await testCasConflictRecomputesFromCurrentEncryptedRow();
  await testAtomicFinalizationPreservesUnrelatedAccounts();
  await testLateFailureRollsBackEveryFinalizationWrite();
  await testTerminalRetryScrubsReintroducedTokenState();
  await testSharedInstallationSurvivesOtherTesterFinalization();
  await testConnectionCapacityRejectsBeforeClaims();
  await testConnectionSessionFailureCompensatesClaims();
  await testConnectionCasConflictRecomputesAndCompensatesFirstClaims();
  await testProductionServiceFinalizesEveryOwnedSessionAndRetriesTerminalScrub();
  await testContainmentDeletesSessionAndReleasesAllItsOwnership();
  console.log('alpha provider session lifecycle tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
