'use strict';
const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');
const { policyDocumentHash } = require('../src/governance-model');

const scope = { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' };
const document = { schemaVersion: 1, enforcement: { mode: 'block' }, rules: [{ id: 'deny-write', action: 'file.write', effect: 'deny' }] };
const requestRow = {
  exception_id: '30000000-0000-4000-8000-000000000003', scope_key: scope.scopeKey,
  policy_id: '10000000-0000-4000-8000-000000000001', version_id: '20000000-0000-4000-8000-000000000002',
  version_number: 1, active_version_id: '20000000-0000-4000-8000-000000000002', current_head_revision: 1, head_revision: 1,
  document_hash: policyDocumentHash(document), kind: 'exception', action: 'file.write', rule_ids: ['deny-write'],
  reason: 'Emergency repair', requested_by_identity_key: 'a'.repeat(64), requested_by_login: 'author',
  authorization_access_level: 30, authorization_provider_role: 'write', authorization_source: 'provider',
  authorization_fetched_at: '2026-07-22T19:00:00.000Z', authorization_expires_at: '2026-07-22T20:00:00.000Z',
  expires_at: '2026-07-22T21:00:00.000Z', created_at: '2026-07-22T19:05:00.000Z'
};
class Client {
  constructor() { this.calls = []; }
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    this.calls.push({ text, params });
    if (text === 'BEGIN') return { rows: [] };
    if (/pg_advisory_xact_lock_shared/.test(text)) return { rows: [] };
    if (/nv-governance-exception:/.test(String(params[0] || ''))) return { rows: [] };
    if (/FROM nv_governance_exception_requests r JOIN nv_governance_policies p/.test(text)) return { rows: [requestRow] };
    if (/nv-governance-active-exceptions:/.test(String(params[0] || ''))) return { rows: [] };
    if (/count\(\*\)::int AS active_count/.test(text)) {
      assert.match(text, /h\.revision=r\.head_revision/, 'approval counting must bind the exact policy-head revision');
      assert.match(text, /approved\.created_at<=\$3/, 'approval counting must use the operation timestamp');
      assert.match(text, /revoked\.created_at<=\$3/, 'revocation counting must use the operation timestamp');
      return { rows: [{ active_count: 100 }] };
    }
    if (/FROM nv_governance_exception_events/.test(text)) return { rows: [] };
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
(async () => {
  const client = new Client();
  const store = new GovernanceStore(new Pool(client), {
    secret: 'governance-exception-approval-limit-secret-012345',
    idFactory: () => '40000000-0000-4000-8000-000000000004',
    now: () => new Date('2026-07-22T19:10:00.000Z')
  });
  await assert.rejects(() => store.decideException({
    exceptionId: requestRow.exception_id, scope,
    actor: { identityKey: 'b'.repeat(64), login: 'admin' },
    authorizationEvidence: { accessLevel: 50, providerRole: 'admin', source: 'provider', fetchedAt: '2026-07-22T19:00:00.000Z', expiresAt: '2026-07-22T20:00:00.000Z' },
    decision: 'approve', reason: 'Approved for incident response'
  }), error => error.code === 'GOVERNANCE_ACTIVE_EXCEPTION_LIMIT_EXCEEDED' && error.status === 409);
  assert(client.calls.some(call => String(call.params[0] || '').includes(`nv-governance-active-exceptions:${scope.scopeKey}:file.write`)), 'approval must serialize on repository and action');
  assert(!client.calls.some(call => /INSERT INTO nv_governance_exception_events/.test(call.text)), 'overflow approval must not append an event');
  console.log('governance exception approval limit tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
