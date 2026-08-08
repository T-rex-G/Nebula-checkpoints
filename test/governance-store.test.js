'use strict';

const assert = require('assert');
let storeModule = {};
try { storeModule = require('../src/governance-store'); } catch {}
assert.strictEqual(typeof storeModule.GovernanceStore, 'function', 'GovernanceStore must be implemented');
const { GovernanceStore } = storeModule;
const { createGovernanceAuditRecord, GOVERNANCE_AUDIT_GENESIS, policyDocumentHash } = require('../src/governance-model');

class ScriptedClient {
  constructor(steps) { this.steps = [...steps]; this.calls = []; this.released = false; }
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    this.calls.push({ text, params });
    const step = this.steps.shift();
    assert(step, `unexpected query: ${text}`);
    if (step.match) assert.match(text, step.match, `query mismatch for: ${text}`);
    if (step.check) step.check(params, text);
    if (step.error) throw step.error;
    return step.result || { rows: [], rowCount: 0 };
  }
  release() { this.released = true; }
}
class ScriptedPool {
  constructor(client) { this.client = client; }
  async connect() { return this.client; }
  async query(sql, params) { return this.client.query(sql, params); }
}

const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006'
];
const actor = { identityKey: 'a'.repeat(64), login: 'alice' };
const reviewer = { identityKey: 'b'.repeat(64), login: 'bob' };
const policyRow = {
  policy_id: ids[0], scope_key: 'github:github.com:acme/demo', provider: 'github', authority: 'github.com',
  owner: 'Acme', repo: 'Demo', policy_key: 'release-protection', name: 'Release protection', description: '',
  created_by_identity_key: actor.identityKey, created_by_login: actor.login, created_at: '2026-07-22T00:00:00.000Z'
};
const versionRow = {
  version_id: ids[1], policy_id: ids[0], version_number: 1, document: { schemaVersion: 1, rules: [] },
  document_hash: 'c'.repeat(64), authored_by_identity_key: actor.identityKey, authored_by_login: actor.login,
  required_approvals: 1, disallow_author_approval: true, has_activation: false, created_at: '2026-07-22T00:01:00.000Z'
};
function auditSteps(previousHash = null) {
  return [
    { match: /pg_advisory_xact_lock/ },
    { match: /SELECT record_hash FROM nv_governance_audit/, result: { rows: previousHash ? [{ record_hash: previousHash }] : [] } },
    { match: /INSERT INTO nv_governance_audit/, result: { rows: [{ created_at: '2026-07-22T00:00:01.000Z' }], rowCount: 1 } }
  ];
}
function makeStore(client, extraIds = ids) {
  let index = 0;
  return new GovernanceStore(new ScriptedPool(client), {
    secret: 'governance-store-secret-0123456789abcdef',
    idFactory: () => extraIds[index++],
    now: () => new Date('2026-07-22T00:00:00.000Z')
  });
}

(async () => {
  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /INSERT INTO nv_governance_policies/, check(params) {
        assert.strictEqual(params[1], 'github:github.com:acme/demo');
        assert.strictEqual(params[3], 'github.com');
        assert.strictEqual(params[6], 'release-protection');
      }, result: { rows: [policyRow], rowCount: 1 } },
      { match: /INSERT INTO nv_governance_policy_heads/, result: { rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const store = makeStore(client);
    const created = await store.createPolicy({
      scope: { provider: 'github', owner: 'Acme', repo: 'Demo' },
      policyKey: 'release-protection', name: 'Release protection', actor
    });
    assert.strictEqual(created.policyId, ids[0]);
    assert.strictEqual(created.scopeKey, 'github:github.com:acme/demo');
    assert(client.released);
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /SELECT .* FROM nv_governance_policies .* FOR UPDATE/, result: { rows: [policyRow] } },
      { match: /SELECT COALESCE\(MAX\(version_number\),0\)/, result: { rows: [{ version_number: 0 }] } },
      { match: /INSERT INTO nv_governance_policy_versions/, check(params) {
        assert.strictEqual(params[2], 1);
        assert.strictEqual(params[7], 1);
        assert.strictEqual(params[8], true);
      }, result: { rows: [versionRow], rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const store = makeStore(client, [ids[1], ids[2]]);
    const version = await store.createVersion({
      policyId: ids[0], document: { schemaVersion: 1, rules: [] }, actor,
      approvalPolicy: { requiredApprovals: 1, disallowAuthorApproval: true }
    });
    assert.strictEqual(version.versionNumber, 1);
  }


  const activationScope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
  const activationAuthorization = {
    accessLevel: 50, providerRole: 'admin', source: 'github.collaborator.permission',
    fetchedAt: '2026-07-21T23:59:30.000Z', expiresAt: '2026-07-22T00:01:00.000Z'
  };
  const noPolicyHash = policyDocumentHash({ schemaVersion: 1, rules: [] });
  const activationSimulation = {
    schemaVersion: 1, engineVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: policyRow.scope_key },
    scenarioSetHash: 'e'.repeat(64), resultHash: 'f'.repeat(64), simulationHash: '9'.repeat(64),
    proposed: { versionId: ids[1], documentHash: versionRow.document_hash },
    baseline: { kind: 'no-policy', versionId: null, documentHash: noPolicyHash },
    summary: { scenarioCount: 1, strengthenedCount: 1, relaxedCount: 0, changedCount: 0 },
    activationReadiness: { eligible: true, blockers: [] }
  };
  const activationInput = extra => ({
    policyId: ids[0], versionId: ids[1], expectedRevision: 0, actor: reviewer,
    scope: activationScope, reason: 'activate', authorizationEvidence: activationAuthorization,
    expectedSimulationHash: activationSimulation.simulationHash, simulationEvidence: activationSimulation,
    ...(extra || {})
  });
  const assignmentRow = { reviewer_identity_key: reviewer.identityKey };
  const approvalRow = { actor_identity_key: reviewer.identityKey, decision: 'approve' };

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /SELECT v\.\*,p\.scope_key,h\.active_version_id/, result: { rows: [{ ...versionRow, scope_key: policyRow.scope_key, active_version_id: null, active_document_hash: null, revision: 0 }] } },
      { match: /active_policy_count/, result: { rows: [{ active_policy_count: 0 }] } },
      { match: /SELECT 1 FROM nv_governance_activations/, result: { rows: [] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [] } },
      { match: /^ROLLBACK$/ }
    ]);
    const store = makeStore(client);
    await assert.rejects(() => store.activateVersion(activationInput()), error => error.code === 'GOVERNANCE_APPROVALS_REQUIRED');
  }

  {
    const activationRow = { activation_id: ids[3] };
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /SELECT v\.\*,p\.scope_key,h\.active_version_id/, result: { rows: [{ ...versionRow, scope_key: policyRow.scope_key, active_version_id: null, active_document_hash: null, revision: 0 }] } },
      { match: /active_policy_count/, result: { rows: [{ active_policy_count: 0 }] } },
      { match: /SELECT 1 FROM nv_governance_activations/, result: { rows: [] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [assignmentRow] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [approvalRow] } },
      { match: /INSERT INTO nv_governance_activations/, result: { rows: [activationRow], rowCount: 1 } },
      { match: /UPDATE nv_governance_policy_heads/, result: { rows: [{ active_version_id: ids[1], revision: 1, updated_at: '2026-07-22T00:00:00.000Z' }], rowCount: 1 } },
      { match: /INSERT INTO nv_governance_activation_evidence/, result: { rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const store = makeStore(client, [ids[3], ids[4]]);
    const activated = await store.activateVersion(activationInput());
    assert.strictEqual(activated.revision, 1);
    assert.strictEqual(activated.simulationHash, activationSimulation.simulationHash);
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /SELECT v\.\*,p\.scope_key,h\.active_version_id/, result: { rows: [{ ...versionRow, scope_key: policyRow.scope_key, active_version_id: ids[5], active_document_hash: '8'.repeat(64), revision: 4 }] } },
      { match: /^ROLLBACK$/ }
    ]);
    const store = makeStore(client);
    await assert.rejects(() => store.activateVersion(activationInput({ expectedRevision: 3 })), error => error.code === 'GOVERNANCE_REVISION_CONFLICT');
  }

  {
    const rollbackSimulation = {
      ...activationSimulation,
      baseline: { kind: 'active-version', versionId: ids[5], documentHash: '8'.repeat(64) },
      simulationHash: '7'.repeat(64)
    };
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /SELECT v\.\*,p\.scope_key,h\.active_version_id/, result: { rows: [{ ...versionRow, scope_key: policyRow.scope_key, active_version_id: ids[5], active_document_hash: '8'.repeat(64), revision: 4 }] } },
      { match: /SELECT a\.activation_id FROM nv_governance_activations/, result: { rows: [] } },
      { match: /^ROLLBACK$/ }
    ]);
    const store = makeStore(client);
    await assert.rejects(
      () => store.rollbackVersion(activationInput({ expectedRevision: 4, reason: 'rollback', expectedSimulationHash: rollbackSimulation.simulationHash, simulationEvidence: rollbackSimulation })),
      error => error.code === 'GOVERNANCE_ROLLBACK_TARGET_INVALID'
    );
  }

  {
    const rollbackSimulation = {
      ...activationSimulation,
      baseline: { kind: 'active-version', versionId: ids[5], documentHash: '8'.repeat(64) },
      simulationHash: '7'.repeat(64)
    };
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /SELECT v\.\*,p\.scope_key,h\.active_version_id/, result: { rows: [{ ...versionRow, scope_key: policyRow.scope_key, active_version_id: ids[5], active_document_hash: '8'.repeat(64), revision: 4 }] } },
      { match: /SELECT a\.activation_id FROM nv_governance_activations/, result: { rows: [{ activation_id: ids[2] }] } },
      { match: /INSERT INTO nv_governance_activations/, result: { rows: [{ activation_id: ids[3] }], rowCount: 1 } },
      { match: /UPDATE nv_governance_policy_heads/, result: { rows: [{ active_version_id: ids[1], revision: 5, updated_at: '2026-07-22T00:00:00.000Z' }], rowCount: 1 } },
      { match: /INSERT INTO nv_governance_activation_evidence/, result: { rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const store = makeStore(client, [ids[3], ids[4]]);
    const result = await store.rollbackVersion(activationInput({ expectedRevision: 4, reason: 'restore known-good policy', expectedSimulationHash: rollbackSimulation.simulationHash, simulationEvidence: rollbackSimulation }));
    assert.strictEqual(result.action, 'rollback');
    assert.strictEqual(result.rollbackSourceActivationId, ids[2]);
  }



  {
    const secret = 'governance-store-secret-0123456789abcdef';
    const first = createGovernanceAuditRecord(secret, {
      eventId: ids[2], policyId: ids[0], versionId: ids[1], eventType: 'version.created',
      actorIdentityKey: actor.identityKey, actorLogin: actor.login, previousHash: GOVERNANCE_AUDIT_GENESIS,
      details: { versionNumber: 1 }, createdAt: '2026-07-22T00:00:00.000Z'
    });
    const second = createGovernanceAuditRecord(secret, {
      eventId: ids[3], policyId: ids[0], versionId: ids[1], eventType: 'approval.recorded',
      actorIdentityKey: reviewer.identityKey, actorLogin: reviewer.login, previousHash: first.recordHash,
      details: { decision: 'approve' }, createdAt: '2026-07-22T00:01:00.000Z'
    });
    const rows = [first, second].map((record, index) => ({
      seq: index + 1,
      total_count: 3,
      event_id: record.eventId,
      policy_id: record.policyId,
      version_id: record.versionId,
      event_type: record.eventType,
      actor_identity_key: record.actorIdentityKey,
      actor_login: record.actorLogin,
      details: record.details,
      details_hash: record.detailsHash,
      previous_hash: record.previousHash,
      record_hash: record.recordHash,
      created_at: record.createdAt
    }));
    const client = new ScriptedClient([
      { match: /count\(\*\) OVER\(\)::int AS total_count/, result: { rows } }
    ]);
    const store = makeStore(client);
    const verified = await store.verifyAudit(ids[0], 2);
    assert.strictEqual(verified.valid, true);
    assert.strictEqual(verified.checked, 2);
    assert.strictEqual(verified.total, 3);
    assert.strictEqual(verified.complete, false);
  }

  console.log('governance store tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
