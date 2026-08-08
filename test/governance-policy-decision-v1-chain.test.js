'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fixture = require('./fixtures/governance-policy-decision-v1.json');
const { GovernanceStore } = require('../src/governance-store');
const { POLICY_DECISION_GENESIS } = require('../src/governance-enforcement');
const { stableJson } = require('../src/governance-model');

const secret = 'historical-policy-chain-secret-0123456789abcdef';
const decisionId = '90000000-0000-4000-8000-000000000009';
const decisionHash = crypto.createHash('sha256').update(stableJson(fixture.decision), 'utf8').digest('hex');
const recordHash = crypto.createHmac('sha256', secret).update(stableJson({
  decisionId,
  mutationId: fixture.decision.mutationId,
  scopeKey: fixture.decision.scope.scopeKey,
  decisionHash,
  previousHash: POLICY_DECISION_GENESIS,
  createdAt: fixture.decision.evaluatedAt
}), 'utf8').digest('hex');
const row = {
  seq: 1,
  decision_id: decisionId,
  mutation_id: fixture.decision.mutationId,
  decision: fixture.decision,
  decision_hash: decisionHash,
  previous_hash: POLICY_DECISION_GENESIS,
  record_hash: recordHash,
  created_at: fixture.decision.evaluatedAt
};
class Client {
  constructor() { this.calls = 0; }
  async query(sql) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^BEGIN TRANSACTION/.test(text)) return { rows: [] };
    if (/SELECT count\(\*\)::int AS total_count/.test(text)) return { rows: [{ total_count: 1 }] };
    if (/FROM nv_governance_policy_decisions/.test(text)) return { rows: [row] };
    if (text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  }
  release() {}
}
class Pool {
  constructor(client) { this.client = client; }
  connect() { return Promise.resolve(this.client); }
  query(sql, params) { return this.client.query(sql, params); }
}
(async () => {
  const store = new GovernanceStore(new Pool(new Client()), { secret });
  const result = await store.verifyPolicyDecisionChainInScope({ scope: fixture.decision.scope, limit: 10 });
  assert.deepStrictEqual(result, {
    valid: true, checked: 1, total: 1, complete: true, reasonCode: null,
    firstInvalidSeq: null, headHash: recordHash
  });
  console.log('governance policy decision v1 chain tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
