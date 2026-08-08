'use strict';
const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');
class ScriptedClient {
  constructor(steps) { this.steps = [...steps]; this.calls = []; }
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim(); this.calls.push({ text, params });
    const step = this.steps.shift(); assert(step, `unexpected query: ${text}`);
    if (step.match) assert.match(text, step.match, `query mismatch: ${text}`);
    if (step.check) step.check(params, text);
    if (step.error) throw step.error;
    return step.result || { rows: [], rowCount: 0 };
  }
  release() {}
}
class Pool { constructor(client) { this.client = client; } connect() { return Promise.resolve(this.client); } query(sql, params) { return this.client.query(sql, params); } }
const ids = {
  policy: '10000000-0000-4000-8000-000000000001', version: '20000000-0000-4000-8000-000000000002',
  assignment: '30000000-0000-4000-8000-000000000003', decision: '40000000-0000-4000-8000-000000000004',
  audit: '50000000-0000-4000-8000-000000000005'
};
const author = { identityKey: 'a'.repeat(64), login: 'author' };
const reviewer = { identityKey: 'b'.repeat(64), login: 'reviewer' };
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const scopeKey = 'github:github.com:acme/demo';
const versionRow = {
  policy_id: ids.policy, version_id: ids.version, version_number: 1, scope_key: scopeKey,
  authored_by_identity_key: author.identityKey, authored_by_login: author.login,
  required_approvals: 1, disallow_author_approval: true, has_activation: false
};
const evidence = { accessLevel: 40, providerRole: 'maintain', source: 'github.collaborator.permission', fetchedAt: '2026-07-22T16:00:00.000Z', expiresAt: '2026-07-22T16:01:00.000Z' };
const assignmentRow = {
  assignment_id: ids.assignment, policy_id: ids.policy, version_id: ids.version,
  reviewer_identity_key: reviewer.identityKey, reviewer_login: reviewer.login,
  reviewer_access_level: 40, reviewer_provider_role: 'maintain', authorization_source: evidence.source,
  authorization_fetched_at: evidence.fetchedAt, authorization_expires_at: evidence.expiresAt,
  created_at: '2026-07-22T16:00:30.000Z'
};
function auditSteps() { return [
  { match: /pg_advisory_xact_lock/ }, { match: /SELECT record_hash FROM nv_governance_audit/, result: { rows: [] } },
  { match: /INSERT INTO nv_governance_audit/, result: { rowCount: 1 } }
]; }
function store(client, generated) { let i = 0; return new GovernanceStore(new Pool(client), { secret: 'governance-review-secret-0123456789abcdef', idFactory: () => generated[i++], now: () => new Date('2026-07-22T16:00:30.000Z') }); }
(async () => {
  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance:${ids.policy}`]); } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-review:${ids.version}`]); } },
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, result: { rows: [versionRow] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [] } },
      { match: /^ROLLBACK$/ }
    ]);
    await assert.rejects(() => store(client, [ids.assignment]).claimReviewer({ policyId: ids.policy, versionId: ids.version, scope, actor: author, authorizationEvidence: evidence }), error => error.code === 'GOVERNANCE_AUTHOR_REVIEW_FORBIDDEN');
  }
  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance:${ids.policy}`]); } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-review:${ids.version}`]); } },
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, result: { rows: [versionRow] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [] } },
      { match: /INSERT INTO nv_governance_review_assignments/, result: { rows: [assignmentRow], rowCount: 1 } },
      ...auditSteps(), { match: /^COMMIT$/ }
    ]);
    const result = await store(client, [ids.assignment, ids.audit]).claimReviewer({ policyId: ids.policy, versionId: ids.version, scope, actor: reviewer, authorizationEvidence: evidence });
    assert.strictEqual(result.assignment.assignmentId, ids.assignment);
    assert.strictEqual(result.review.status, 'pending');
  }
  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance:${ids.policy}`]); } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-review:${ids.version}`]); } },
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, result: { rows: [versionRow] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [assignmentRow] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [] } },
      { match: /INSERT INTO nv_governance_approvals/, result: { rows: [{ approval_id: ids.decision, version_id: ids.version, assignment_id: ids.assignment, decision: 'approve', actor_identity_key: reviewer.identityKey, actor_login: reviewer.login, rationale: '', reviewer_access_level: 40, reviewer_provider_role: 'maintain', authorization_source: evidence.source, authorization_fetched_at: evidence.fetchedAt, authorization_expires_at: evidence.expiresAt, created_at: '2026-07-22T16:00:30.000Z' }], rowCount: 1 } },
      ...auditSteps(), { match: /^COMMIT$/ }
    ]);
    const result = await store(client, [ids.decision, ids.audit]).recordReviewDecision({ policyId: ids.policy, versionId: ids.version, scope, actor: reviewer, authorizationEvidence: evidence, decision: 'approve' });
    assert.strictEqual(result.review.status, 'approved');
    assert.strictEqual(result.review.terminal, true);
  }
  await assert.rejects(
    () => store(new ScriptedClient([]), []).recordReviewDecision({ policyId: ids.policy, versionId: ids.version, scope, actor: reviewer, authorizationEvidence: evidence, decision: 'reject', rationale: '' }),
    error => error.code === 'GOVERNANCE_REJECTION_RATIONALE_REQUIRED'
  );
  await assert.rejects(
    () => store(new ScriptedClient([]), []).recordReviewDecision({ policyId: ids.policy, versionId: ids.version, scope, actor: reviewer, authorizationEvidence: evidence, decision: 'reject', rationale: 'token=github_pat_abcdefghijklmnopqrstuvwxyz123456' }),
    error => error.code === 'GOVERNANCE_SENSITIVE_TEXT'
  );
  {
    const client = new ScriptedClient([
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, result: { rows: [versionRow] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [assignmentRow] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [{ actor_identity_key: reviewer.identityKey, decision: 'approve' }] } }
    ]);
    const review = await store(client, []).getReviewState({ policyId: ids.policy, versionId: ids.version, scope });
    assert.strictEqual(review.status, 'approved');
    assert.strictEqual(review.assignments[0].reviewerLogin, 'reviewer');
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ },
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, result: { rows: [versionRow] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [] } },
      { match: /^ROLLBACK$/ }
    ]);
    await assert.rejects(
      () => store(client, [ids.decision]).recordReviewDecision({ policyId: ids.policy, versionId: ids.version, scope, actor: reviewer, authorizationEvidence: evidence, decision: 'approve' }),
      error => error.code === 'GOVERNANCE_REVIEWER_NOT_ASSIGNED'
    );
  }
  {
    const rejectedRow = {
      approval_id: ids.decision, version_id: ids.version, assignment_id: ids.assignment,
      decision: 'reject', actor_identity_key: reviewer.identityKey, actor_login: reviewer.login,
      rationale: 'The policy removes required branch protection.', reviewer_access_level: 40,
      reviewer_provider_role: 'maintain', authorization_source: evidence.source,
      authorization_fetched_at: evidence.fetchedAt, authorization_expires_at: evidence.expiresAt,
      created_at: '2026-07-22T16:00:30.000Z'
    };
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ },
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, result: { rows: [versionRow] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [assignmentRow] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [] } },
      { match: /INSERT INTO nv_governance_approvals/, result: { rows: [rejectedRow], rowCount: 1 } },
      ...auditSteps(), { match: /^COMMIT$/ }
    ]);
    const result = await store(client, [ids.decision, ids.audit]).recordReviewDecision({
      policyId: ids.policy, versionId: ids.version, scope, actor: reviewer,
      authorizationEvidence: evidence, decision: 'reject', rationale: rejectedRow.rationale
    });
    assert.strictEqual(result.review.status, 'rejected');
    assert.strictEqual(result.review.terminal, true);
    assert.strictEqual(result.review.rejectionCount, 1);
  }
  {
    const approvedRow = {
      approval_id: ids.decision, version_id: ids.version, assignment_id: ids.assignment,
      decision: 'approve', actor_identity_key: reviewer.identityKey, actor_login: reviewer.login,
      rationale: '', reviewer_access_level: 40, reviewer_provider_role: 'maintain',
      authorization_source: evidence.source, authorization_fetched_at: evidence.fetchedAt,
      authorization_expires_at: evidence.expiresAt, created_at: '2026-07-22T16:00:30.000Z'
    };
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ },
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, result: { rows: [versionRow] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [assignmentRow] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [approvedRow] } },
      { match: /^ROLLBACK$/ }
    ]);
    await assert.rejects(
      () => store(client, [ids.assignment]).claimReviewer({ policyId: ids.policy, versionId: ids.version, scope, actor: reviewer, authorizationEvidence: evidence }),
      error => error.code === 'GOVERNANCE_REVIEW_FINALIZED' && error.details.status === 'approved'
    );
  }
  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ },
      { match: /FROM nv_governance_policy_versions v JOIN nv_governance_policies p/, result: { rows: [versionRow] } },
      { match: /FROM nv_governance_review_assignments/, result: { rows: [assignmentRow] } },
      { match: /FROM nv_governance_approvals/, result: { rows: [] } },
      { match: /^COMMIT$/ }
    ]);
    const result = await store(client, [ids.assignment]).claimReviewer({
      policyId: ids.policy, versionId: ids.version, scope, actor: reviewer, authorizationEvidence: evidence
    });
    assert.strictEqual(result.assignment.assignmentId, ids.assignment);
    assert.strictEqual(result.review.assignedCount, 1);
    assert(!client.calls.some(call => /INSERT INTO nv_governance_review_assignments/.test(call.text)), 'natural retry must not insert a duplicate assignment');
  }

  {
    const client = new ScriptedClient([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ },
      { match: /^ROLLBACK$/ }
    ]);
    const times = [new Date('2026-07-22T16:00:30.000Z'), new Date('2026-07-22T16:01:01.000Z')];
    const timedStore = new GovernanceStore(new Pool(client), {
      secret: 'governance-review-secret-0123456789abcdef',
      idFactory: () => ids.assignment,
      now: () => times.length ? times.shift() : new Date('2026-07-22T16:01:01.000Z')
    });
    await assert.rejects(
      () => timedStore.claimReviewer({ policyId: ids.policy, versionId: ids.version, scope, actor: reviewer, authorizationEvidence: evidence }),
      error => error.code === 'GOVERNANCE_REVIEW_AUTHORIZATION_INVALID'
    );
  }
  await assert.rejects(
    () => store(new ScriptedClient([]), [ids.assignment]).claimReviewer({
      policyId: ids.policy, versionId: ids.version, scope, actor: reviewer,
      authorizationEvidence: { ...evidence, expiresAt: '2026-07-22T16:00:29.000Z' }
    }),
    error => error.code === 'GOVERNANCE_REVIEW_AUTHORIZATION_INVALID'
  );
  console.log('governance review store tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
