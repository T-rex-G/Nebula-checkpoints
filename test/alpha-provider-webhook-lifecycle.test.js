'use strict';

const assert = require('assert');
const { AlphaPrivacyStore } = require('../src/alpha-privacy-store');
const {
  disconnectProviderAccount,
  providerResourceKeyHash,
  providerSessionKeyHash
} = require('../src/provider-disconnect');

const TESTER_A = '12345678-1234-4234-9234-123456789abc';
const TESTER_B = '22345678-1234-4234-9234-123456789abc';
const IDENTITY = 'a'.repeat(64);
const SESSION_HASH_A = providerSessionKeyHash('owned-session-a');
const SESSION_HASH_B = providerSessionKeyHash('owned-session-b');
const RESOURCE_HASH = providerResourceKeyHash({
  provider: 'github',
  authority: 'github.com',
  resourceType: 'provider-webhook',
  resourceReference: 'provider-hook-91'
});
const NOW = new Date('2026-08-08T18:00:00.000Z');

function state() {
  return {
    testers: [
      { tester_id: TESTER_A, revoked_at: null, metadata_purged_at: null },
      { tester_id: TESTER_B, revoked_at: null, metadata_purged_at: null }
    ],
    deletions: [],
    bindings: [TESTER_A, TESTER_B].map(tester_id => ({
      tester_id,
      identity_key: IDENTITY,
      provider: 'github',
      authority: 'github.com',
      connected_at: NOW,
      disconnected_at: null
    })),
    sessionOwnership: [
      { session_key_hash: SESSION_HASH_A, tester_id: TESTER_A, identity_key: IDENTITY, provider: 'github', claimed_at: NOW, released_at: null },
      { session_key_hash: SESSION_HASH_B, tester_id: TESTER_B, identity_key: IDENTITY, provider: 'github', claimed_at: NOW, released_at: null }
    ],
    webhookOwnership: [],
    webhooks: [{
      identity_key: IDENTITY,
      provider: 'github',
      alpha_resource_key_hash: RESOURCE_HASH
    }],
    manifests: [],
    tasks: []
  };
}

class FakePool {
  constructor() {
    this.state = state();
    this.calls = [];
    this.failTaskVerification = false;
  }

  async query(sql, params = []) {
    return new FakeClient(this).query(sql, params);
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
      return { rows: [], rowCount: 0 };
    }
    if (/FROM nv_alpha_provider_bindings WHERE tester_id=\$1 AND identity_key=\$2 AND provider=\$3 FOR UPDATE/.test(text)) {
      const rows = this.pool.state.bindings.filter(item => (
        item.tester_id === params[0] && item.identity_key === params[1] && item.provider === params[2]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_webhooks WHERE identity_key=\$1 AND provider=\$2 AND alpha_resource_key_hash=\$3 FOR UPDATE/.test(text)) {
      const rows = this.pool.state.webhooks.filter(item => (
        item.identity_key === params[0] && item.provider === params[1]
        && item.alpha_resource_key_hash === params[2]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/AS lifecycle_started/.test(text)) {
      const exists = this.pool.state.manifests.some(item => (
        item.identity_key === params[0] && item.provider === params[1]
        && (
          (item.resource_type === 'provider-webhook' && item.resource_key_hash === params[2])
          || (item.tester_id === params[3] && item.resource_type === 'provider-session')
        )
      ));
      return { rows: [{ lifecycle_started: exists }], rowCount: 1 };
    }
    if (/FROM nv_alpha_provider_webhook_ownership WHERE identity_key=\$1 AND provider=\$2 AND resource_key_hash=\$3 FOR UPDATE/.test(text)) {
      const rows = this.pool.state.webhookOwnership.filter(item => (
        item.identity_key === params[0] && item.provider === params[1]
        && item.resource_key_hash === params[2]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/INSERT INTO nv_alpha_provider_webhook_ownership/.test(text)) {
      const row = {
        tester_id: params[0], identity_key: params[1], provider: params[2],
        resource_key_hash: params[3], claimed_at: params[4], released_at: null
      };
      this.pool.state.webhookOwnership.push(row);
      return { rows: [{ claimed_at: row.claimed_at }], rowCount: 1 };
    }
    if (/FROM nv_alpha_cleanup_manifest manifest INNER JOIN nv_alpha_cleanup_tasks task/.test(text)) {
      const rows = this.pool.state.tasks.filter(task => (
        task.tester_id === params[0] && task.identity_key === params[1] && task.provider === params[2]
      )).map(task => ({
        ...structuredClone(task),
        manifest_id: task.manifest_id
      }));
      return { rows, rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_session_ownership WHERE tester_id=\$1 AND identity_key=\$2 AND provider=\$3 ORDER BY session_key_hash FOR UPDATE/.test(text)) {
      const rows = this.pool.state.sessionOwnership.filter(item => (
        item.tester_id === params[0] && item.identity_key === params[1] && item.provider === params[2]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_webhook_ownership ownership JOIN nv_alpha_testers tester/.test(text)) {
      const rows = this.pool.state.webhookOwnership.filter(item => (
        item.identity_key === params[0] && item.provider === params[1]
        && (params.length < 3 || item.resource_key_hash === params[2])
      )).map(item => ({
        ...structuredClone(item),
        tester_revoked_at: this.pool.state.testers.find(tester => tester.tester_id === item.tester_id).revoked_at
      }));
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO nv_alpha_cleanup_manifest/.test(text)) {
      this.pool.state.manifests.push({
        manifest_id: params[0], tester_id: params[1], identity_key: params[2],
        provider: params[3], resource_type: params[4], resource_key_hash: params[5],
        created_at: params[6]
      });
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO nv_alpha_cleanup_tasks/.test(text)) {
      this.pool.state.tasks.push({
        cleanup_id: params[0], manifest_id: params[1], tester_id: params[2],
        identity_key: params[3], provider: params[4], resource_type: params[5],
        resource_key_hash: params[6], status: 'pending', reason_code: params[7],
        created_at: params[8], verified_at: null
      });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM nv_alpha_cleanup_tasks WHERE cleanup_id=\$1 AND tester_id=\$2 FOR UPDATE/.test(text)) {
      const row = this.pool.state.tasks.find(item => (
        item.cleanup_id === params[0] && item.tester_id === params[1]
      ));
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/DELETE FROM nv_webhooks WHERE identity_key=\$1 AND provider=\$2 AND alpha_resource_key_hash=\$3/.test(text)) {
      const before = this.pool.state.webhooks.length;
      this.pool.state.webhooks = this.pool.state.webhooks.filter(item => !(
        item.identity_key === params[0] && item.provider === params[1]
        && item.alpha_resource_key_hash === params[2]
      ));
      return { rows: [], rowCount: before - this.pool.state.webhooks.length };
    }
    if (/UPDATE nv_alpha_provider_webhook_ownership SET released_at=\$5/.test(text)) {
      const row = this.pool.state.webhookOwnership.find(item => (
        item.tester_id === params[0] && item.identity_key === params[1]
        && item.provider === params[2] && item.resource_key_hash === params[3]
        && !item.released_at
      ));
      if (!row) return { rows: [], rowCount: 0 };
      row.released_at = params[4];
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/UPDATE nv_alpha_cleanup_tasks SET status='verified'/.test(text)) {
      if (this.pool.failTaskVerification) return { rows: [], rowCount: 0 };
      const row = this.pool.state.tasks.find(item => (
        item.cleanup_id === params[0] && item.tester_id === params[1]
      ));
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'verified';
      row.verified_at = params[2];
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    throw new Error(`Unhandled fake SQL: ${text}`);
  }

  release() {}
}

function store(pool) {
  let id = 0;
  return new AlphaPrivacyStore({
    pool,
    now: () => NOW,
    randomUUID: () => `90000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
  });
}

async function run() {
  const pool = new FakePool();
  const privacy = store(pool);
  for (const testerId of [TESTER_A, TESTER_B]) {
    await privacy.claimProviderWebhookOwnership({
      testerId,
      identityKey: IDENTITY,
      provider: 'github',
      resourceKeyHash: RESOURCE_HASH
    });
  }
  const preparedA = await privacy.prepareProviderDisconnect({
    testerId: TESTER_A,
    identityKey: IDENTITY,
    provider: 'github',
    currentSessionKeyHash: SESSION_HASH_A,
    webhookResourceKeyHashes: [RESOURCE_HASH],
    inventoryAvailable: true,
    reasonCode: ''
  });
  assert.strictEqual(preparedA.webhooks.length, 1);
  assert.strictEqual(preparedA.webhooks[0].shared, true);
  assert.strictEqual(preparedA.webhooks[0].requesterOwned, true);
  assert.deepStrictEqual(
    preparedA.providerSessions.map(item => item.resourceKeyHash),
    [SESSION_HASH_A]
  );
  const sharedState = await privacy.inspectProviderWebhookCleanup({
    testerId: TESTER_A,
    identityKey: IDENTITY,
    provider: 'github',
    cleanupId: preparedA.webhooks[0].cleanupId,
    resourceKeyHash: RESOURCE_HASH
  });
  assert.deepStrictEqual(sharedState, { verified: false, shared: true });
  const shared = await privacy.completeProviderWebhookCleanup({
    testerId: TESTER_A,
    identityKey: IDENTITY,
    provider: 'github',
    cleanupId: preparedA.webhooks[0].cleanupId,
    resourceKeyHash: RESOURCE_HASH,
    providerVerifiedAbsent: false
  });
  assert.deepStrictEqual(shared, { verified: true, shared: true, localRemoved: false });
  assert.strictEqual(pool.state.webhooks.length, 1);
  assert(pool.state.webhookOwnership.find(item => item.tester_id === TESTER_A).released_at);
  assert.strictEqual(pool.state.webhookOwnership.find(item => item.tester_id === TESTER_B).released_at, null);

  const preparedB = await privacy.prepareProviderDisconnect({
    testerId: TESTER_B,
    identityKey: IDENTITY,
    provider: 'github',
    currentSessionKeyHash: SESSION_HASH_B,
    webhookResourceKeyHashes: [RESOURCE_HASH],
    inventoryAvailable: true,
    reasonCode: ''
  });
  assert.strictEqual(preparedB.webhooks[0].shared, false);
  const beforeCrash = structuredClone(pool.state);
  pool.failTaskVerification = true;
  await assert.rejects(
    () => privacy.completeProviderWebhookCleanup({
      testerId: TESTER_B,
      identityKey: IDENTITY,
      provider: 'github',
      cleanupId: preparedB.webhooks[0].cleanupId,
      resourceKeyHash: RESOURCE_HASH,
      providerVerifiedAbsent: true
    }),
    error => error && error.code === 'ALPHA_CLEANUP_VERIFICATION_CONFLICT'
  );
  assert.deepStrictEqual(pool.state, beforeCrash,
    'local deletion, ownership release, and evidence verification must roll back together');
  pool.failTaskVerification = false;
  const exclusive = await privacy.completeProviderWebhookCleanup({
    testerId: TESTER_B,
    identityKey: IDENTITY,
    provider: 'github',
    cleanupId: preparedB.webhooks[0].cleanupId,
    resourceKeyHash: RESOURCE_HASH,
    providerVerifiedAbsent: true
  });
  assert.deepStrictEqual(exclusive, { verified: true, shared: false, localRemoved: true });
  assert.strictEqual(pool.state.webhooks.length, 0);

  pool.state.webhooks.push({
    identity_key: IDENTITY,
    provider: 'github',
    alpha_resource_key_hash: RESOURCE_HASH
  });
  const terminal = await privacy.completeProviderWebhookCleanup({
    testerId: TESTER_B,
    identityKey: IDENTITY,
    provider: 'github',
    cleanupId: preparedB.webhooks[0].cleanupId,
    resourceKeyHash: RESOURCE_HASH,
    providerVerifiedAbsent: false
  });
  assert.deepStrictEqual(terminal, { verified: true, shared: false, localRemoved: true });
  assert.strictEqual(pool.state.webhooks.length, 0,
    'a verified terminal retry must scrub a reintroduced exact local webhook row');
  assert(!JSON.stringify([preparedA, preparedB, shared, exclusive, terminal]).includes('provider-hook-91'));

  for (const variant of ['upgrade-null-hash', 'claim-crash']) {
    const uncoveredPool = new FakePool();
    uncoveredPool.state.bindings = uncoveredPool.state.bindings.filter(
      item => item.tester_id === TESTER_A
    );
    uncoveredPool.state.sessionOwnership = uncoveredPool.state.sessionOwnership.filter(
      item => item.tester_id === TESTER_A
    );
    uncoveredPool.state.webhooks = [{
      hook_id: 'local-hook-row',
      provider_hook_id: 'provider-hook-91',
      identity_key: IDENTITY,
      provider: 'github',
      alpha_resource_key_hash: variant === 'upgrade-null-hash' ? null : RESOURCE_HASH
    }];
    const uncoveredPrivacy = store(uncoveredPool);
    let providerDeletes = 0;
    let atomicCompletions = 0;
    let finalizations = 0;
    const result = await disconnectProviderAccount({
      account: {
        provider: 'github', authMethod: 'token', token: 'private-token', login: 'private-login'
      },
      tester: { testerId: TESTER_A },
      binding: {
        testerId: TESTER_A,
        identityKey: IDENTITY,
        provider: 'github',
        authority: 'github.com'
      },
      sessionId: 'owned-session-a',
      enumerateProviderWebhooks: async () => [{
        hookId: 'local-hook-row',
        providerHookId: 'provider-hook-91',
        alphaResourceKeyHash: variant === 'upgrade-null-hash' ? null : RESOURCE_HASH
      }],
      prepareDisconnect: input => uncoveredPrivacy.prepareProviderDisconnect(input),
      removeProviderWebhook: async () => {
        providerDeletes += 1;
        return { verifiedAbsent: true };
      },
      completeProviderWebhookCleanup: async input => {
        atomicCompletions += 1;
        return uncoveredPrivacy.completeProviderWebhookCleanup(input);
      },
      finalizeDisconnect: async () => {
        finalizations += 1;
        return { finalized: true };
      },
      invalidateBroker() {}
    });
    const webhookTasks = uncoveredPool.state.tasks.filter(
      task => task.resource_type === 'provider-webhook'
    );
    assert.strictEqual(webhookTasks.length, 1,
      `${variant} must retain one exact hashed pending webhook task`);
    assert.strictEqual(webhookTasks[0].resource_key_hash, RESOURCE_HASH);
    assert.strictEqual(webhookTasks[0].status, 'pending');
    assert.strictEqual(result.providerStateRemoved, false);
    assert.strictEqual(result.webhookCleanup, 'pending');
    assert.strictEqual(result.cleanupId, webhookTasks[0].cleanup_id);
    assert.strictEqual(providerDeletes, 0,
      `${variant} must not mutate a possibly shared provider webhook`);
    assert.strictEqual(atomicCompletions, 0,
      `${variant} must not mutate the local webhook or evidence state`);
    assert.strictEqual(finalizations, 0,
      `${variant} must not disconnect before exact ownership is established`);
    if (variant === 'claim-crash') {
      const lateHash = providerResourceKeyHash({
        provider: 'github',
        authority: 'github.com',
        resourceType: 'provider-webhook',
        resourceReference: 'late-provider-hook'
      });
      uncoveredPool.state.webhooks.push({
        hook_id: 'late-local-row',
        provider_hook_id: 'late-provider-hook',
        identity_key: IDENTITY,
        provider: 'github',
        alpha_resource_key_hash: lateHash
      });
      await assert.rejects(
        () => uncoveredPrivacy.claimProviderWebhookOwnership({
          testerId: TESTER_A,
          identityKey: IDENTITY,
          provider: 'github',
          resourceKeyHash: lateHash
        }),
        error => error && error.code === 'ALPHA_PROVIDER_LIFECYCLE_STARTED',
        'a provider-session cleanup manifest must freeze late ownership claims'
      );
    }
    assert(!JSON.stringify([webhookTasks, result]).includes('provider-hook-91'));
    assert(!JSON.stringify([webhookTasks, result]).includes('private-token'));
  }
  console.log('alpha provider webhook lifecycle tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
