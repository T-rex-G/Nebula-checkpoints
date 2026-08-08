'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { createGovernanceApiService } = require('../src/governance-api');
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const key = value => crypto.createHash('sha256').update(value).digest('hex');
const reviewerKey = key('reviewer');
const now = Date.parse('2026-07-22T16:00:30.000Z');
function snapshot(level = 40, overrides = {}) {
  const baseRole = level >= 50 ? 'admin' : level >= 40 ? 'maintain' : level >= 30 ? 'write' : 'read';
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
    executionPrincipal: { kind: 'user', identityKey: reviewerKey, login: 'reviewer', authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey: reviewerKey, login: 'reviewer', verified: true },
    repositoryAccess: { baseRole, providerRole: baseRole, level, source: 'github.collaborator.permission', complete: true },
    governanceRoles: { reader: true, author: level >= 30, reviewer: level >= 40, activator: level >= 50, administrator: level >= 50 },
    installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: '2026-07-22T16:00:00.000Z', expiresAt: '2026-07-22T16:01:00.000Z', reasonCode: null },
    ...overrides
  };
}
const calls = [];
const store = {
  listPolicies: async () => [], createPolicy: async () => ({}), getPolicyStateInScope: async () => ({}),
  createDraft: async () => ({}), getDraft: async () => ({ document: { schemaVersion: 1, rules: [] }, requiredApprovals: 1, disallowAuthorApproval: true }),
  updateDraft: async () => ({}), submitDraft: async () => ({}), listVersions: async () => [], getVersionInScope: async () => ({}),
  async getReviewState(input) { calls.push(['getReviewState', input]); return { status: 'pending' }; },
  async claimReviewer(input) { calls.push(['claimReviewer', input]); return { assignmentId: 'a1', review: { status: 'pending' } }; },
  async recordReviewDecision(input) { calls.push(['recordReviewDecision', input]); return { decisionId: 'd1', review: { status: 'approved' } }; },
  async activateVersion() { return {}; }, async rollbackVersion() { return {}; }, async listActivationHistory() { return []; },
  async listPolicyDecisionsInScope() { return { decisions: [], total: 0, complete: true }; }, async verifyPolicyDecisionChainInScope() { return { valid: true, checked: 0, total: 0, complete: true }; },
  async createExceptionRequest(input) { return { exceptionId: 'e1', ...input }; },
  async getException(input) { return { exceptionId: input.exceptionId }; },
  async listExceptions() { return []; },
  async decideException(input) { return { exceptionId: input.exceptionId }; },
  async revokeException(input) { return { exceptionId: input.exceptionId }; },
  async getNotificationPreferences() { return { enabled: true, eventTypes: [], lastReadSeq: 0 }; },
  async updateNotificationPreferences(input) { return input.preferences; },
  async markNotificationsRead(input) { return { lastReadSeq: input.throughSeq }; },
  async listNotifications() { return { events: [], unreadCount: 0 }; },
  async createWebhook() { return {}; }, async listWebhooks() { return []; }, async updateWebhook() { return {}; },
  async rotateWebhookSecret() { return {}; }, async deleteWebhook() { return {}; }, async listWebhookDeliveries() { return []; },
  async createEvidenceExport() { return {}; }, async listEvidenceExports() { return []; }, async getEvidenceExport() { return {}; }, async verifyEvidenceExport() { return { valid: true }; }

};
(async () => {
  const service = createGovernanceApiService({ store, now: () => now });
  const authorization = snapshot();
  const ids = { policyId: '10000000-0000-4000-8000-000000000001', versionId: '20000000-0000-4000-8000-000000000002' };
  await service.getReviewState({ scope, authorization, ...ids });
  await service.claimReviewer({ scope, authorization, ...ids, input: {}, idempotencyKey: 'claim-review-1234' });
  const claim = calls.find(([name]) => name === 'claimReviewer')[1];
  assert.deepStrictEqual(claim.actor, { identityKey: reviewerKey, login: 'reviewer' });
  assert.deepStrictEqual(claim.authorizationEvidence, {
    accessLevel: 40, providerRole: 'maintain', source: 'github.collaborator.permission',
    fetchedAt: '2026-07-22T16:00:00.000Z', expiresAt: '2026-07-22T16:01:00.000Z'
  });
  assert.strictEqual(claim.idempotencyKey, 'claim-review-1234');
  await assert.rejects(
    () => service.claimReviewer({ scope, authorization, ...ids, input: { reviewerIdentityKey: 'f'.repeat(64) } }),
    error => error.code === 'GOVERNANCE_REVIEWER_IDENTITY_FORBIDDEN'
  );
  await assert.rejects(
    () => service.claimReviewer({ scope, authorization, ...ids, input: [] }),
    error => error.code === 'GOVERNANCE_REVIEW_INPUT_INVALID'
  );
  const humanKey = key('github-app-human-reviewer');
  const appAuthorization = snapshot(50, {
    executionPrincipal: { kind: 'installation', identityKey: key('installation:91'), login: 'acme-app', authMethod: 'github-app', installationId: 91 },
    governanceActor: { kind: 'human', identityKey: humanKey, login: 'human-reviewer', verified: true },
    installationCapabilities: { repositorySelected: true, repositorySelection: 'selected', permissions: { metadata: 'read', contents: 'write' } }
  });
  await service.claimReviewer({ scope, authorization: appAuthorization, ...ids, input: {} });
  const appClaim = calls.filter(([name]) => name === 'claimReviewer').at(-1)[1];
  assert.deepStrictEqual(appClaim.actor, { identityKey: humanKey, login: 'human-reviewer' });
  await service.recordReviewDecision({ scope, authorization, ...ids, input: { decision: 'reject', rationale: 'Policy weakens protected branch controls.' }, idempotencyKey: 'decision-1234' });
  const decision = calls.find(([name]) => name === 'recordReviewDecision')[1];
  assert.strictEqual(decision.decision, 'reject');
  assert.strictEqual(decision.actor.identityKey, reviewerKey);
  await assert.rejects(
    () => service.recordReviewDecision({ scope, authorization: snapshot(30), ...ids, input: { decision: 'approve' } }),
    error => error.code === 'GOVERNANCE_ROLE_REQUIRED'
  );
  await assert.rejects(
    () => service.recordReviewDecision({ scope, authorization, ...ids, input: { decision: 'approve', actorLogin: 'mallory' } }),
    error => error.code === 'GOVERNANCE_REVIEWER_IDENTITY_FORBIDDEN'
  );
  console.log('governance review API tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
