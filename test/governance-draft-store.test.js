'use strict';

const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');

class ScriptedClient {
  constructor(steps) { this.steps = [...steps]; this.calls = []; this.released = false; }
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
  release() { this.released = true; }
}
class ScriptedPool {
  constructor(client) { this.client = client; }
  async connect() { return this.client; }
  async query(sql, params) { return this.client.query(sql, params); }
}

const ids = {
  policy: '10000000-0000-4000-8000-000000000001',
  draft: '20000000-0000-4000-8000-000000000002',
  version: '30000000-0000-4000-8000-000000000003',
  audit: '40000000-0000-4000-8000-000000000004'
};
const actor = { identityKey: 'a'.repeat(64), login: 'alice' };
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const scopeKey = 'github:github.com:acme/demo';
const document = { schemaVersion: 1, rules: [{ id: 'protect-main', action: 'branch.reset', effect: 'deny' }] };
const hash = require('../src/governance-model').policyDocumentHash(document);
const policyRow = {
  policy_id: ids.policy, scope_key: scopeKey, provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo',
  policy_key: 'release-safety', name: 'Release safety', description: '', created_by_identity_key: actor.identityKey,
  created_by_login: actor.login, created_at: '2026-07-22T14:00:00.000Z', active_version_id: null,
  active_version_number: null, active_document_hash: null, revision: 0, updated_at: '2026-07-22T14:00:00.000Z'
};
const draftRow = {
  draft_id: ids.draft, policy_id: ids.policy, revision: 0, document, document_hash: hash,
  authored_by_identity_key: actor.identityKey, authored_by_login: actor.login,
  required_approvals: 1, disallow_author_approval: true,
  created_at: '2026-07-22T14:01:00.000Z', updated_at: '2026-07-22T14:01:00.000Z'
};
const versionRow = {
  version_id: ids.version, policy_id: ids.policy, version_number: 1, document, document_hash: hash,
  authored_by_identity_key: actor.identityKey, authored_by_login: actor.login,
  required_approvals: 1, disallow_author_approval: true, created_at: '2026-07-22T14:02:00.000Z'
};
function auditSteps() {
  return [
    { match: /pg_advisory_xact_lock/ },
    { match: /SELECT record_hash FROM nv_governance_audit/, result: { rows: [] } },
    { match: /INSERT INTO nv_governance_audit/, result: { rowCount: 1, rows: [{ seq: 1 }] } }
  ];
}
function storeFor(client, generated = [ids.draft, ids.audit]) {
  let index = 0;
  return new GovernanceStore(new ScriptedPool(client), {
    secret: 'governance-store-secret-0123456789abcdef',
    idFactory: () => generated[index++],
    now: () => new Date('2026-07-22T14:01:00.000Z')
  });
}

(async () => {
  {
    const client = new ScriptedClient([]);
    await assert.rejects(
      () => storeFor(client).listPolicies({ scope, limit: '1.5' }),
      error => error.code === 'GOVERNANCE_LIMIT_INVALID' && error.status === 400
    );
    assert.strictEqual(client.calls.length, 0, 'invalid list limits must be rejected before querying PostgreSQL');
  }

  {
    const client = new ScriptedClient([
      { match: /FROM nv_governance_policies p JOIN nv_governance_policy_heads h/, check(params) { assert.strictEqual(params[0], scopeKey); }, result: { rows: [policyRow] } }
    ]);
    const policies = await storeFor(client).listPolicies({ scope });
    assert.strictEqual(policies[0].policyId, ids.policy);
    assert.strictEqual(policies[0].revision, 0);
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /FROM nv_governance_policies WHERE policy_id=\$1 AND scope_key=\$2/, result: { rows: [{ policy_id: ids.policy, scope_key: scopeKey }] } },
      { match: /INSERT INTO nv_governance_policy_drafts/, check(params) {
        assert.strictEqual(params[0], ids.draft);
        assert.strictEqual(params[1], ids.policy);
        assert.strictEqual(params[3], hash);
        assert.strictEqual(params[4], actor.identityKey);
      }, result: { rows: [draftRow], rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const created = await storeFor(client).createDraft({ policyId: ids.policy, scope, actor, document });
    assert.strictEqual(created.draftId, ids.draft);
    assert.strictEqual(created.revision, 0);
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /FROM nv_governance_policy_drafts d JOIN nv_governance_policies p/, result: { rows: [{ ...draftRow, scope_key: scopeKey }] } },
      { match: /^ROLLBACK$/ }
    ]);
    await assert.rejects(
      () => storeFor(client).updateDraft({ policyId: ids.policy, draftId: ids.draft, scope, actor, expectedRevision: 2, document }),
      error => error.code === 'GOVERNANCE_DRAFT_REVISION_CONFLICT' && error.status === 409
    );
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /FROM nv_governance_policy_drafts d JOIN nv_governance_policies p/, result: { rows: [{ ...draftRow, scope_key: scopeKey }] } },
      { match: /UPDATE nv_governance_policy_drafts/, result: { rows: [{ ...draftRow, revision: 1, updated_at: '2026-07-22T14:02:00.000Z' }], rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const updated = await storeFor(client, [ids.audit]).updateDraft({
      policyId: ids.policy, draftId: ids.draft, scope, actor, expectedRevision: 0, document
    });
    assert.strictEqual(updated.revision, 1);
  }

  {
    const client = new ScriptedClient([
      { match: /FROM nv_governance_policy_drafts d JOIN nv_governance_policies p/, result: { rows: [] } }
    ]);
    await assert.rejects(
      () => storeFor(client).getDraft({ policyId: ids.policy, draftId: ids.draft, scope, actor: { identityKey: 'b'.repeat(64), login: 'bob' } }),
      error => error.code === 'GOVERNANCE_DRAFT_NOT_FOUND' && error.status === 404
    );
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ },
      { match: /FROM nv_governance_policy_drafts d JOIN nv_governance_policies p/, result: { rows: [{ ...draftRow, scope_key: scopeKey }] } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance:${ids.policy}`]); } },
      { match: /SELECT COALESCE\(MAX\(version_number\),0\)/, result: { rows: [{ version_number: 0 }] } },
      { match: /INSERT INTO nv_governance_policy_versions/, result: { rows: [versionRow], rowCount: 1 } },
      { match: /DELETE FROM nv_governance_policy_drafts/, result: { rowCount: 1 } },
      ...auditSteps(),
      { match: /^COMMIT$/ }
    ]);
    const submitted = await storeFor(client, [ids.version, ids.audit]).submitDraft({
      policyId: ids.policy, draftId: ids.draft, scope, actor, expectedRevision: 0
    });
    assert.strictEqual(submitted.versionId, ids.version);
    assert.strictEqual(submitted.versionNumber, 1);
  }

  {
    const client = new ScriptedClient([
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, check(params) {
        assert.deepStrictEqual(params.slice(0, 2), [ids.policy, scopeKey]);
      }, result: { rows: [versionRow] } }
    ]);
    const versions = await storeFor(client).listVersions({ policyId: ids.policy, scope });
    assert.strictEqual(versions[0].versionId, ids.version);
  }

  console.log('governance draft store tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
