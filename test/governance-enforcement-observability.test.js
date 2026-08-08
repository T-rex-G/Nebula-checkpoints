'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { GovernanceStore } = require('../src/governance-store');
const { evaluateActivePolicySet, POLICY_DECISION_GENESIS } = require('../src/governance-enforcement');
const { normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { stableJson } = require('../src/governance-model');

const secret = 'policy-observability-secret-0123456789abcdef';
const scope = { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' };
const authorization = {
  schemaVersion: 1, scope,
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T20:00:00.000Z', reasonCode: null }
};
const descriptor = normalizeMutationDescriptor({
  mutationId: '11111111-1111-4111-8111-111111111111', action: 'file.write', provider: 'github', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'PUT', route: '/api/repo/Acme/Demo/file',
  metadata: { branch: 'main', path: 'README.md' }, authorization
});
const decisionId = '30000000-0000-4000-8000-000000000003';
const createdAt = '2026-07-22T18:30:00.000Z';
const decision = evaluateActivePolicySet({ scope, descriptor, activePolicies: [], evaluatedAt: createdAt });
const decisionHash = crypto.createHash('sha256').update(stableJson(decision), 'utf8').digest('hex');
const recordHash = crypto.createHmac('sha256', secret).update(stableJson({
  decisionId, mutationId: decision.mutationId, scopeKey: scope.scopeKey, decisionHash,
  previousHash: POLICY_DECISION_GENESIS, createdAt
}), 'utf8').digest('hex');
const row = {
  seq: 1, decision_id: decisionId, mutation_id: decision.mutationId, decision,
  decision_hash: decisionHash, previous_hash: POLICY_DECISION_GENESIS, record_hash: recordHash,
  created_at: createdAt, total_count: 1, remaining_count: 1
};
class Pool {
  constructor(rows) { this.rows = rows; this.calls = []; }
  async query(sql, params = []) {
    this.calls.push({ sql: String(sql), params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(String(sql).trim())) return { rows: [], rowCount: 0 };
    const afterSeq = Number(params[1] || 0);
    const limit = Number(params[2] || params[1] || 100);
    const selected = this.rows.filter(item => Number(item.seq) > afterSeq).slice(0, limit);
    return { rows: selected };
  }
  async connect() { return { query: this.query.bind(this), release() {} }; }
}
(async () => {
  const pool = new Pool([row]);
  const store = new GovernanceStore(pool, { secret });
  assert.strictEqual(typeof store.listPolicyDecisionsInScope, 'function');
  assert.strictEqual(typeof store.verifyPolicyDecisionChainInScope, 'function');
  await assert.rejects(
    () => store.listPolicyDecisionsInScope({ scope, limit: 1.5 }),
    error => error && error.code === 'GOVERNANCE_LIMIT_INVALID'
  );
  await assert.rejects(
    () => store.listPolicyDecisionsInScope({ scope, limit: 10, afterSeq: -1 }),
    error => error && error.code === 'GOVERNANCE_CURSOR_INVALID'
  );
  const list = await store.listPolicyDecisionsInScope({ scope, limit: 10, afterSeq: 0 });
  assert.strictEqual(list.decisions.length, 1);
  assert.strictEqual(list.decisions[0].descriptorHash, decision.descriptorHash);
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.complete, true);
  assert.strictEqual(list.afterSeq, 0);
  assert.strictEqual(list.nextAfterSeq, 1);
  assert(pool.calls.some(call => /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/.test(call.sql.trim())), 'decision history must use a consistent read-only snapshot');
  const verification = await store.verifyPolicyDecisionChainInScope({ scope, limit: 10 });
  assert.strictEqual(verification.valid, true);
  assert.strictEqual(verification.checked, 1);
  assert.strictEqual(verification.complete, true);
  assert.strictEqual(verification.reasonCode, null);

  const limitedRows = Array.from({ length: 3 }, (_, index) => ({
    ...row,
    seq: index + 1,
    decision_id: `30000000-0000-4000-8000-00000000000${index + 3}`,
    mutation_id: `11111111-1111-4111-8111-11111111111${index + 1}`,
    decision: { ...decision, mutationId: `11111111-1111-4111-8111-11111111111${index + 1}` },
    total_count: 3,
    remaining_count: 3 - index
  }));
  let previous = POLICY_DECISION_GENESIS;
  for (const item of limitedRows) {
    item.decision_hash = crypto.createHash('sha256').update(stableJson(item.decision), 'utf8').digest('hex');
    item.previous_hash = previous;
    item.record_hash = crypto.createHmac('sha256', secret).update(stableJson({
      decisionId: item.decision_id, mutationId: item.mutation_id, scopeKey: scope.scopeKey,
      decisionHash: item.decision_hash, previousHash: previous, createdAt
    }), 'utf8').digest('hex');
    previous = item.record_hash;
  }
  const limited = await new GovernanceStore(new Pool(limitedRows), { secret }).verifyPolicyDecisionChainInScope({ scope, limit: 2 });
  assert.strictEqual(limited.valid, true);
  assert.strictEqual(limited.checked, 2);
  assert.strictEqual(limited.total, 3);
  assert.strictEqual(limited.complete, false);
  assert.strictEqual(limited.reasonCode, 'POLICY_DECISION_VERIFICATION_LIMIT');

  const tampered = { ...row, decision: { ...row.decision, actor: { ...row.decision.actor, login: 'Mallory' } } };
  const invalid = await new GovernanceStore(new Pool([tampered]), { secret }).verifyPolicyDecisionChainInScope({ scope, limit: 10 });
  assert.strictEqual(invalid.valid, false);
  assert.strictEqual(invalid.reasonCode, 'POLICY_DECISION_HASH_MISMATCH');
  console.log('governance enforcement observability tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
