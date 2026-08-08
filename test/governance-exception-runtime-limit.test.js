'use strict';
const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');
const { normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { policyDocumentHash } = require('../src/governance-model');

class Client {
  constructor(rows) { this.rows = rows; this.calls = []; }
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    this.calls.push({ text, params });
    if (text === 'BEGIN') return { rows: [] };
    if (/pg_advisory_xact_lock_shared/.test(text)) return { rows: [] };
    if (/FROM nv_governance_policies p JOIN nv_governance_policy_heads h/.test(text)) {
      const document = { schemaVersion: 1, enforcement: { mode: 'block' }, rules: [{ id: 'deny-write', action: 'file.write', effect: 'deny' }] };
      return { rows: [{
        policy_id: '10000000-0000-4000-8000-000000000001', policy_key: 'secure',
        active_version_id: '20000000-0000-4000-8000-000000000002', revision: 1,
        version_number: 1, document, document_hash: policyDocumentHash(document)
      }] };
    }
    if (/FROM nv_governance_exception_requests r/.test(text)) {
      assert.match(text, /h\.revision=r\.head_revision/, 'runtime loading must bind the exact policy-head revision');
      assert.match(text, /e\.created_at <= \$4/, 'runtime must ignore approvals after the decision timestamp');
      assert.match(text, /revoked\.created_at <= \$4/, 'runtime must ignore revocations after the decision timestamp');
      assert.match(text, /LIMIT 101$/, 'runtime exception loading must be bounded');
      return { rows: this.rows };
    }
    if (text === 'ROLLBACK') return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  }
  release() {}
}
class Pool {
  constructor(client) { this.client = client; }
  connect() { return Promise.resolve(this.client); }
  query(sql, params) { return this.client.query(sql, params); }
}
const authorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'provider', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T22:00:00.000Z', reasonCode: null }
};
const descriptor = normalizeMutationDescriptor({
  mutationId: '11111111-1111-4111-8111-111111111111', action: 'file.write', provider: 'github', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'PUT', route: '/api/repo/Acme/Demo/file', metadata: { path: 'README.md' }, authorization
});
const rows = Array.from({ length: 101 }, (_, index) => ({
  exception_id: `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000001`,
  policy_id: '10000000-0000-4000-8000-000000000001',
  version_id: '20000000-0000-4000-8000-000000000002',
  document_hash: 'f'.repeat(64), kind: 'exception', action: 'file.write', rule_ids: ['deny-write'],
  expires_at: '2026-07-22T21:00:00.000Z', approved_at: '2026-07-22T19:00:00.000Z',
  approved_by_identity_key: 'b'.repeat(64), approved_by_login: 'Admin'
}));
(async () => {
  const client = new Client(rows);
  const store = new GovernanceStore(new Pool(client), {
    secret: 'governance-exception-limit-secret-0123456789',
    idFactory: () => '90000000-0000-4000-8000-000000000009',
    now: () => new Date('2026-07-22T19:10:00.000Z')
  });
  await assert.rejects(
    () => store.evaluateAndAppendPolicyDecision({ scope: authorization.scope, descriptor }),
    error => error.code === 'GOVERNANCE_ACTIVE_EXCEPTION_LIMIT_EXCEEDED' && error.status === 503
  );
  assert(client.calls.some(call => call.text === 'ROLLBACK'), 'overflow must roll back the decision transaction');
  console.log('governance exception runtime limit tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
