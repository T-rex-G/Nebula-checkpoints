'use strict';

const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');

class Client {
  constructor() { this.calls = []; }
  async query(sql, params = []) {
    this.calls.push([String(sql), params]);
    if (/transaction_timestamp/.test(sql)) return { rows: [{ as_of: '2026-07-22T20:00:00.000Z' }] };
    return { rows: [] };
  }
  release() {}
}
const client = new Client();
const pool = { async connect() { return client; }, async query(sql, params) { return client.query(sql, params); } };

(async () => {
  const store = new GovernanceStore(pool, { secret: 'x'.repeat(64) });
  const result = await store.getDigitalTwinReadModelData({
    scope: { provider: 'github', owner: 'Acme', repo: 'Demo' },
    historyLimit: 25,
    afterDecisionSeq: 0
  });
  assert.strictEqual(result.asOf, '2026-07-22T20:00:00.000Z');
  assert(client.calls[0][0].includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert(client.calls.some(([sql]) => sql.includes('nv_governance_policies')));
  assert(client.calls.some(([sql]) => sql.includes('nv_governance_policy_versions')));
  assert(client.calls.some(([sql]) => sql.includes('LEFT JOIN LATERAL') && sql.includes('nv_governance_activation_evidence')));
  assert(client.calls.some(([sql]) => sql.includes('nv_governance_exception_requests')));
  assert(client.calls.some(([sql]) => sql.includes('nv_governance_policy_decisions')));
  assert.strictEqual(client.calls.at(-1)[0], 'COMMIT');
  assert(!client.calls.some(([sql]) => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)), 'Digital Twin transaction must remain read-only');
  console.log('governance Digital Twin store tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
