'use strict';

const assert = require('assert');
let api = {};
try { api = require('../src/governance-api'); } catch {}
for (const name of ['GovernanceApiError', 'assertGovernanceAuthorization', 'createGovernanceApiService']) {
  assert(api[name], `${name} must be implemented`);
}

const { GovernanceApiError, assertGovernanceAuthorization, createGovernanceApiService } = api;
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const key = value => require('crypto').createHash('sha256').update(value).digest('hex');
const userKey = key('github:alice');
const now = Date.parse('2026-07-22T14:00:30.000Z');
function snapshot(level = 30, overrides = {}) {
  const baseRole = level >= 50 ? 'admin' : level >= 40 ? 'maintain' : level >= 30 ? 'write' : level >= 10 ? 'read' : 'none';
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
    executionPrincipal: { kind: 'user', identityKey: userKey, login: 'alice', authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey: userKey, login: 'alice', verified: true },
    repositoryAccess: { baseRole, providerRole: baseRole, level, source: 'github.collaborator.permission', complete: true },
    governanceRoles: {
      reader: level >= 10, author: level >= 30, reviewer: level >= 40,
      activator: level >= 50, administrator: level >= 50
    },
    installationCapabilities: null,
    evidence: {
      status: 'resolved', fetchedAt: '2026-07-22T14:00:00.000Z',
      expiresAt: '2026-07-22T14:01:00.000Z', reasonCode: null
    },
    ...overrides
  };
}

const authorized = assertGovernanceAuthorization({
  authorization: snapshot(30), scope, requiredRole: 'author', now: () => now
});
assert.deepStrictEqual(authorized.actor, { identityKey: userKey, login: 'alice' });
assert.strictEqual(authorized.scope.scopeKey, 'github:github.com:acme/demo');
assert(Object.isFrozen(authorized) && Object.isFrozen(authorized.actor));

assert.throws(
  () => assertGovernanceAuthorization({ authorization: snapshot(10), scope, requiredRole: 'author', now: () => now }),
  error => error instanceof GovernanceApiError && error.code === 'GOVERNANCE_ROLE_REQUIRED' && error.status === 403
);
assert.throws(
  () => assertGovernanceAuthorization({
    authorization: snapshot(30, { evidence: { status: 'resolved', fetchedAt: '2026-07-22T13:58:00.000Z', expiresAt: '2026-07-22T14:00:00.000Z', reasonCode: null } }),
    scope, requiredRole: 'author', now: () => now
  }),
  error => error.code === 'GOVERNANCE_AUTHORIZATION_STALE'
);
assert.throws(
  () => assertGovernanceAuthorization({
    authorization: snapshot(30), scope: { provider: 'github', owner: 'Other', repo: 'Demo' }, requiredRole: 'reader', now: () => now
  }),
  error => error.code === 'GOVERNANCE_SCOPE_MISMATCH'
);

const appActorKey = key('github:authorizer');
const installationSnapshot = snapshot(50, {
  executionPrincipal: { kind: 'installation', identityKey: key('installation:77'), login: 'acme-app', authMethod: 'github-app', installationId: 77 },
  governanceActor: { kind: 'human', identityKey: appActorKey, login: 'reviewer', verified: true },
  installationCapabilities: { repositorySelected: true, repositorySelection: 'selected', permissions: { metadata: 'read', contents: 'write' } }
});
assert.deepStrictEqual(
  assertGovernanceAuthorization({ authorization: installationSnapshot, scope, requiredRole: 'author', now: () => now }).actor,
  { identityKey: appActorKey, login: 'reviewer' },
  'draft ownership must use the verified human rather than the installation identity'
);

(async () => {
  const calls = [];
  const store = {
    async listPolicies(input) { calls.push(['listPolicies', input]); return [{ policyId: 'p1' }]; },
    async createPolicy(input) { calls.push(['createPolicy', input]); return { policyId: 'p1', ...input }; },
    async getPolicyStateInScope(input) { calls.push(['getPolicyStateInScope', input]); return { policyId: input.policyId }; },
    async createDraft(input) { calls.push(['createDraft', input]); return { draftId: 'd1', ...input }; },
    async getDraft(input) { calls.push(['getDraft', input]); return { draftId: input.draftId, document: { schemaVersion: 1, rules: [] }, requiredApprovals: 1, disallowAuthorApproval: true }; },
    async updateDraft(input) { calls.push(['updateDraft', input]); return { draftId: input.draftId, revision: input.expectedRevision + 1 }; },
    async submitDraft(input) { calls.push(['submitDraft', input]); return { versionId: 'v1', versionNumber: 1 }; },
    async listVersions(input) { calls.push(['listVersions', input]); return [{ versionId: 'v1' }]; },
    async getVersionInScope(input) { calls.push(['getVersionInScope', input]); return { versionId: input.versionId }; },
    async getReviewState(input) { calls.push(['getReviewState', input]); return { status: 'pending' }; },
    async claimReviewer(input) { calls.push(['claimReviewer', input]); return { assignment: { assignmentId: 'a1' }, review: { status: 'pending' } }; },
    async recordReviewDecision(input) { calls.push(['recordReviewDecision', input]); return { decision: { decisionId: 'd1' }, review: { status: 'approved' } }; },
    async activateVersion(input) { calls.push(['activateVersion', input]); return {}; },
    async rollbackVersion(input) { calls.push(['rollbackVersion', input]); return {}; },
    async listActivationHistory(input) { calls.push(['listActivationHistory', input]); return []; },
    async createExceptionRequest(input) { calls.push(['createExceptionRequest', input]); return { exceptionId: 'e1' }; },
    async getException(input) { calls.push(['getException', input]); return { exceptionId: input.exceptionId }; },
    async listExceptions(input) { calls.push(['listExceptions', input]); return []; },
    async decideException(input) { calls.push(['decideException', input]); return { exceptionId: input.exceptionId }; },
    async revokeException(input) { calls.push(['revokeException', input]); return { exceptionId: input.exceptionId }; },
    async listPolicyDecisionsInScope(input) { calls.push(['listPolicyDecisionsInScope', input]); return { decisions: [], total: 0, complete: true }; },
    async verifyPolicyDecisionChainInScope(input) { calls.push(['verifyPolicyDecisionChainInScope', input]); return { valid: true, checked: 0, total: 0, complete: true }; },
  async getNotificationPreferences() { return { enabled: true, eventTypes: [], lastReadSeq: 0 }; },
  async updateNotificationPreferences(input) { return input.preferences; },
  async markNotificationsRead(input) { return { lastReadSeq: input.throughSeq }; },
  async listNotifications() { return { events: [], unreadCount: 0 }; },
  async createWebhook() { return {}; }, async listWebhooks() { return []; }, async updateWebhook() { return {}; },
  async rotateWebhookSecret() { return {}; }, async deleteWebhook() { return {}; }, async listWebhookDeliveries() { return []; },
  async createEvidenceExport() { return {}; }, async listEvidenceExports() { return []; }, async getEvidenceExport() { return {}; }, async verifyEvidenceExport() { return { valid: true }; }

  };
  const service = createGovernanceApiService({ store, now: () => now });
  const authorization = snapshot(30);
  await service.listPolicyDecisions({ scope, authorization: snapshot(10), limit: 25, afterSeq: 40 });
  await service.verifyPolicyDecisionChain({ scope, authorization: snapshot(10), limit: 50 });
  assert.strictEqual(calls.find(([name]) => name === 'listPolicyDecisionsInScope')[1].scope.scopeKey, 'github:github.com:acme/demo');
  assert.strictEqual(calls.find(([name]) => name === 'listPolicyDecisionsInScope')[1].afterSeq, 40);
  assert.strictEqual(calls.find(([name]) => name === 'verifyPolicyDecisionChainInScope')[1].limit, 50);

  const document = { schemaVersion: 1, rules: [{ id: 'protect-main', action: 'branch.reset', effect: 'deny' }] };

  const validation = await service.validatePolicyVersion({ scope, authorization, input: { document } });
  assert.deepStrictEqual(validation.approvalPolicy, { requiredApprovals: 1, disallowAuthorApproval: true });
  assert.match(validation.documentHash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(validation.document, document);

  await service.createPolicy({ scope, authorization, idempotencyKey: 'policy-create-1234', input: { policyKey: 'release-safety', name: 'Release safety' } });
  const createPolicyCall = calls.find(([name]) => name === 'createPolicy')[1];
  assert.deepStrictEqual(createPolicyCall.actor, { identityKey: userKey, login: 'alice' });
  assert.strictEqual(createPolicyCall.scope.scopeKey, 'github:github.com:acme/demo');
  assert.strictEqual(createPolicyCall.idempotencyKey, 'policy-create-1234');

  await service.createDraft({ scope, authorization, policyId: '10000000-0000-4000-8000-000000000001', idempotencyKey: 'draft-create-1234', input: { document } });
  const createDraftCall = calls.find(([name]) => name === 'createDraft')[1];
  assert.deepStrictEqual(createDraftCall.actor, { identityKey: userKey, login: 'alice' });
  assert.match(createDraftCall.documentHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(createDraftCall.idempotencyKey, 'draft-create-1234');

  await service.updateDraft({
    scope, authorization, policyId: '10000000-0000-4000-8000-000000000001',
    draftId: '20000000-0000-4000-8000-000000000002', input: { expectedRevision: 2, document }
  });
  assert.strictEqual(calls.find(([name]) => name === 'updateDraft')[1].expectedRevision, 2);

  const storedValidation = await service.validateDraft({
    scope, authorization, policyId: '10000000-0000-4000-8000-000000000001',
    draftId: '20000000-0000-4000-8000-000000000002'
  });
  assert.match(storedValidation.documentHash, /^[0-9a-f]{64}$/);

  await service.submitDraft({
    scope, authorization, policyId: '10000000-0000-4000-8000-000000000001',
    draftId: '20000000-0000-4000-8000-000000000002', input: { expectedRevision: 2 }
  });
  assert.deepStrictEqual(calls.find(([name]) => name === 'submitDraft')[1].actor, { identityKey: userKey, login: 'alice' });

  console.log('governance API tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
