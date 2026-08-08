'use strict';
const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');
const { policyDocumentHash } = require('../src/governance-model');
const { normalizeExceptionTarget } = require('../src/governance-exceptions');

class ScriptedClient {
  constructor(steps) { this.steps = [...steps]; this.calls = []; }
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    this.calls.push({ text, params });
    const step = this.steps.shift();
    assert(step, `unexpected query: ${text}`);
    if (step.match) assert.match(text, step.match, `query mismatch: ${text}`);
    if (step.check) step.check(params, text);
    if (step.error) throw step.error;
    return step.result || { rows: [], rowCount: 0 };
  }
  release() {}
}
class Pool {
  constructor(client) { this.client = client; }
  connect() { return Promise.resolve(this.client); }
  query(sql, params) { return this.client.query(sql, params); }
}
const ids = {
  policy: '10000000-0000-4000-8000-000000000001',
  version: '20000000-0000-4000-8000-000000000002',
  exception: '30000000-0000-4000-8000-000000000003',
  event: '40000000-0000-4000-8000-000000000004',
  audit: '50000000-0000-4000-8000-000000000005'
};
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const scopeKey = 'github:github.com:acme/demo';
const requester = { identityKey: 'a'.repeat(64), login: 'author' };
const administrator = { identityKey: 'b'.repeat(64), login: 'admin' };
const document = { schemaVersion: 1, rules: [{ id: 'deny-write', action: 'file.write', effect: 'deny' }] };
const documentHash = policyDocumentHash(document);
const target = { path: 'README.md' };
const targetHash = normalizeExceptionTarget(target, 'file.write').targetHash;
const authorEvidence = { accessLevel: 30, providerRole: 'write', source: 'provider', fetchedAt: '2026-07-22T19:00:00.000Z', expiresAt: '2026-07-22T19:30:00.000Z' };
const adminEvidence = { accessLevel: 50, providerRole: 'admin', source: 'provider', fetchedAt: '2026-07-22T19:00:00.000Z', expiresAt: '2026-07-22T19:30:00.000Z' };
const versionRow = { scope_key: scopeKey, active_version_id: ids.version, current_head_revision: 1, version_number: 1, document, document_hash: documentHash };
const requestRow = {
  exception_id: ids.exception, scope_key: scopeKey, policy_id: ids.policy, version_id: ids.version,
  version_number: 1, active_version_id: ids.version, current_head_revision: 1, head_revision: 1, document_hash: documentHash,
  kind: 'exception', action: 'file.write', rule_ids: ['deny-write'], target, target_hash: targetHash, reason: 'Emergency repair',
  requested_by_identity_key: requester.identityKey, requested_by_login: requester.login,
  authorization_access_level: 30, authorization_provider_role: 'write', authorization_source: 'provider',
  authorization_fetched_at: authorEvidence.fetchedAt, authorization_expires_at: authorEvidence.expiresAt,
  expires_at: '2026-07-22T20:00:00.000Z', created_at: '2026-07-22T19:05:00.000Z'
};
function auditSteps() { return [
  { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-audit:${ids.policy}`]); } },
  { match: /SELECT record_hash FROM nv_governance_audit/, result: { rows: [] } },
  { match: /INSERT INTO nv_governance_audit/, result: { rowCount: 1 } }
]; }
function store(client, generated, now = () => new Date('2026-07-22T19:05:00.000Z')) {
  let i = 0;
  return new GovernanceStore(new Pool(client), {
    secret: 'governance-exception-secret-0123456789abcdef',
    idFactory: () => generated[i++], now
  });
}
(async () => {
  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /pg_advisory_xact_lock_shared/, check(params) { assert.deepStrictEqual(params, [`nv-governance-active-set:${scopeKey}`]); } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance:${ids.policy}`]); } },
      { match: /FROM nv_governance_policies p JOIN nv_governance_policy_heads h/, result: { rows: [versionRow] } },
      { match: /INSERT INTO nv_governance_exception_requests/, check(params) { assert.strictEqual(params[9], JSON.stringify(target)); assert.strictEqual(params[10], targetHash); }, result: { rows: [requestRow], rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const result = await store(client, [ids.exception, ids.audit]).createExceptionRequest({
      policyId: ids.policy, versionId: ids.version, scope, actor: requester, authorizationEvidence: authorEvidence,
      request: { kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], target, reason: 'Emergency repair', expiresAt: requestRow.expires_at }
    });
    assert.strictEqual(result.exceptionId, ids.exception);
    assert.strictEqual(result.status, 'pending');
  }

  {
    const approvalRow = {
      event_id: ids.event, exception_id: ids.exception, policy_id: ids.policy, version_id: ids.version,
      event_type: 'approve', actor_identity_key: administrator.identityKey, actor_login: administrator.login,
      reason: 'Approved for incident response', authorization_access_level: 50,
      authorization_provider_role: 'admin', authorization_source: 'provider',
      authorization_fetched_at: adminEvidence.fetchedAt, authorization_expires_at: adminEvidence.expiresAt,
      created_at: '2026-07-22T19:05:00.000Z'
    };
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /pg_advisory_xact_lock_shared/ },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-exception:${ids.exception}`]); } },
      { match: /FROM nv_governance_exception_requests r JOIN nv_governance_policies p/, result: { rows: [requestRow] } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-active-exceptions:${scopeKey}:file.write`]); } },
      { match: /FROM nv_governance_exception_events/, result: { rows: [] } },
      { match: /count\(\*\)::int AS active_count/, result: { rows: [{ active_count: 0 }] } },
      { match: /INSERT INTO nv_governance_exception_events/, result: { rows: [approvalRow], rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const result = await store(client, [ids.event, ids.audit]).decideException({
      exceptionId: ids.exception, scope, actor: administrator, authorizationEvidence: adminEvidence,
      decision: 'approve', reason: 'Approved for incident response'
    });
    assert.strictEqual(result.status, 'approved');
    assert.strictEqual(result.events[0].eventType, 'approve');
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock_shared/ }, { match: /pg_advisory_xact_lock/ },
      { match: /FROM nv_governance_exception_requests r JOIN nv_governance_policies p/, result: { rows: [requestRow] } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-active-exceptions:${scopeKey}:file.write`]); } },
      { match: /FROM nv_governance_exception_events/, result: { rows: [] } },
      { match: /^ROLLBACK$/ }
    ]);
    await assert.rejects(() => store(client, [ids.event]).decideException({
      exceptionId: ids.exception, scope, actor: requester,
      authorizationEvidence: { ...adminEvidence, accessLevel: 50 }, decision: 'approve', reason: 'self approval'
    }), error => error.code === 'GOVERNANCE_EXCEPTION_SELF_APPROVAL_FORBIDDEN');
  }

  {
    const times = [new Date('2026-07-22T19:05:00.000Z'), new Date('2026-07-22T19:31:00.000Z')];
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock_shared/ }, { match: /pg_advisory_xact_lock/ },
      { match: /FROM nv_governance_exception_requests r JOIN nv_governance_policies p/, result: { rows: [requestRow] } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-active-exceptions:${scopeKey}:file.write`]); } },
      { match: /FROM nv_governance_exception_events/, result: { rows: [] } },
      { match: /^ROLLBACK$/ }
    ]);
    await assert.rejects(() => store(client, [ids.event], () => times.shift() || new Date('2026-07-22T19:31:00.000Z')).decideException({
      exceptionId: ids.exception, scope, actor: administrator, authorizationEvidence: adminEvidence,
      decision: 'approve', reason: 'late approval'
    }), error => error.code === 'GOVERNANCE_EXCEPTION_AUTHORIZATION_INVALID');
  }
  console.log('governance exception store tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
