'use strict';
const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');
const { normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { policyDocumentHash } = require('../src/governance-model');

const authorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true }, installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T19:00:00.000Z', reasonCode: null }
};
const descriptor = normalizeMutationDescriptor({
  mutationId: '11111111-1111-4111-8111-111111111111', action: 'file.write', provider: 'github', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'PUT', route: '/api/repo/Acme/Demo/file',
  metadata: { branch: 'main', path: 'README.md' }, authorization
});
const document = { schemaVersion: 1, enforcement: { mode: 'block' }, rules: [{ id: 'deny-write', action: 'file.write', effect: 'deny', controlRefs: ['SOC2-TSC:CC8.1'] }] };
const activeRow = {
  policy_id: '10000000-0000-4000-8000-000000000001', policy_key: 'security',
  active_version_id: '20000000-0000-4000-8000-000000000002', revision: 3,
  version_number: 1, document, document_hash: policyDocumentHash(document)
};
function fakePool(rows = [activeRow]) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/SELECT p\.policy_id/.test(sql)) return { rows };
      if (/SELECT record_hash FROM nv_governance_policy_decisions/.test(sql)) return { rows: [] };
      if (/INSERT INTO nv_governance_policy_decisions/.test(sql)) return { rowCount: 1, rows: [{ seq: 1 }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  return { calls, async connect() { return client; }, async query() { return { rows: [] }; } };
}

(async () => {
  const pool = fakePool();
  const store = new GovernanceStore(pool, {
    secret: 'runtime-policy-decision-secret-0123456789abcdef',
    idFactory: () => '30000000-0000-4000-8000-000000000003',
    now: () => new Date('2026-07-22T18:30:00.000Z')
  });
  assert.strictEqual(typeof store.evaluateAndAppendPolicyDecision, 'function', 'store must implement runtime evaluation');
  const decision = await store.evaluateAndAppendPolicyDecision({ scope: authorization.scope, descriptor });
  assert.strictEqual(decision.enforcementOutcome, 'block');
  assert.strictEqual(decision.blockCode, 'POLICY_MUTATION_BLOCKED');
  assert.strictEqual(decision.decisionId, '30000000-0000-4000-8000-000000000003');
  assert.match(decision.recordHash, /^[0-9a-f]{64}$/);
  assert.match(decision.descriptorHash, /^[0-9a-f]{64}$/);
  assert(Object.isFrozen(decision.controlMapping));
  const insert = pool.calls.find(call => /INSERT INTO nv_governance_policy_decisions/.test(call.sql));
  assert(insert, 'decision must be inserted before provider execution');
  assert.strictEqual(JSON.parse(insert.params[21]).mappingHash, decision.controlMapping.mappingHash);
  const scopeLockIndex = pool.calls.findIndex(call => /nv-governance-active-set:/.test(String(call.params[0] || '')));
  const activeQueryIndex = pool.calls.findIndex(call => /SELECT p\.policy_id/.test(call.sql));
  assert(scopeLockIndex >= 0 && scopeLockIndex < activeQueryIndex, 'runtime must lock the repository active-policy set before reading it');

  const tooManyRows = Array.from({ length: 101 }, (_, index) => ({ ...activeRow, policy_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, policy_key: `policy-${String(index).padStart(3, '0')}` }));
  const tooManyPool = fakePool(tooManyRows);
  const tooManyStore = new GovernanceStore(tooManyPool, { secret: 'runtime-policy-decision-secret-0123456789abcdef' });
  await assert.rejects(() => tooManyStore.evaluateAndAppendPolicyDecision({ scope: authorization.scope, descriptor }), error => error.code === 'GOVERNANCE_ACTIVE_POLICY_LIMIT_EXCEEDED');
  assert(tooManyPool.calls.some(call => /LIMIT 101/.test(call.sql)), 'runtime active-policy query must be bounded');

  const corruptPool = fakePool([{ ...activeRow, document_hash: 'f'.repeat(64) }]);
  const corruptStore = new GovernanceStore(corruptPool, { secret: 'runtime-policy-decision-secret-0123456789abcdef' });
  await assert.rejects(() => corruptStore.evaluateAndAppendPolicyDecision({ scope: authorization.scope, descriptor }), error => error.code === 'POLICY_ACTIVE_VERSION_INTEGRITY_FAILED');
  assert(corruptPool.calls.some(call => call.sql === 'ROLLBACK'));
  console.log('governance enforcement store tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
