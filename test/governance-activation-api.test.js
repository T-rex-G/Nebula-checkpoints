'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { createGovernanceApiService } = require('../src/governance-api');
const { simulatePolicyImpact } = require('../src/governance-simulation');
const { policyDocumentHash } = require('../src/governance-model');
const key = value => crypto.createHash('sha256').update(value).digest('hex');
const now = Date.parse('2026-07-22T18:00:30.000Z');
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const actorKey = key('activator');
const authorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: actorKey, login: 'activator', authMethod: 'oauth' },
  governanceActor: { kind: 'human', identityKey: actorKey, login: 'activator', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T18:01:00.000Z', reasonCode: null }
};
const policyId = '10000000-0000-4000-8000-000000000001';
const proposed = { versionId: '20000000-0000-4000-8000-000000000002', policyId, versionNumber: 2, document: { schemaVersion: 1, rules: [{ id: 'deny-reset', action: 'branch.reset', effect: 'deny' }] } };
proposed.documentHash = policyDocumentHash(proposed.document);
const active = { versionId: '30000000-0000-4000-8000-000000000003', policyId, versionNumber: 1, document: { schemaVersion: 1, rules: [] } };
active.documentHash = policyDocumentHash(active.document);
const simulationRequest = { schemaVersion: 1, scenarios: [{ id: 'reset', action: 'branch.reset', attributes: { branch: 'main' } }] };
const expected = simulatePolicyImpact({ scope: authorization.scope, proposedVersion: proposed, baselineVersion: active, request: simulationRequest });
const calls = [];
const store = {
  listPolicies: async () => [], createPolicy: async () => ({}),
  async getPolicyStateInScope(input) { return { policyId, activeVersionId: active.versionId, revision: 7 }; },
  createDraft: async () => ({}), getDraft: async () => ({}), updateDraft: async () => ({}), submitDraft: async () => ({}), listVersions: async () => [],
  async getVersionInScope(input) { return input.versionId === proposed.versionId ? proposed : active; },
  getReviewState: async () => ({}), claimReviewer: async () => ({}), recordReviewDecision: async () => ({}),
  async activateVersion(input) { calls.push(['activate', input]); return { action: 'activate', revision: 8 }; },
  async rollbackVersion(input) { calls.push(['rollback', input]); return { action: 'rollback', revision: 8 }; },
  async listActivationHistory(input) { calls.push(['history', input]); return []; },
  async listPolicyDecisionsInScope() { return { decisions: [], total: 0, complete: true }; },
  async verifyPolicyDecisionChainInScope() { return { valid: true, checked: 0, total: 0, complete: true }; },
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
  const input = { expectedRevision: 7, reason: 'Promote reviewed policy', simulation: { simulationHash: expected.simulationHash, request: simulationRequest } };
  const result = await service.activateVersion({ scope, authorization, policyId, versionId: proposed.versionId, input, idempotencyKey: 'activation-12345' });
  assert.strictEqual(result.action, 'activate');
  const call = calls.find(([name]) => name === 'activate')[1];
  assert.strictEqual(call.actor.identityKey, actorKey);
  assert.strictEqual(call.authorizationEvidence.accessLevel, 50);
  assert.strictEqual(call.expectedRevision, 7);
  assert.strictEqual(call.simulationEvidence.simulationHash, expected.simulationHash);
  assert.strictEqual(call.idempotencyKey, 'activation-12345');
  await assert.rejects(
    () => service.activateVersion({ scope, authorization, policyId, versionId: proposed.versionId, input: { ...input, simulation: { ...input.simulation, simulationHash: 'f'.repeat(64) } }, idempotencyKey: 'activation-mismatch-123' }),
    error => error.code === 'GOVERNANCE_SIMULATION_MISMATCH'
  );
  await assert.rejects(
    () => service.activateVersion({ scope, authorization: {
      ...authorization,
      repositoryAccess: { ...authorization.repositoryAccess, baseRole: 'maintain', providerRole: 'maintain', level: 40 },
      governanceRoles: { reader: true, author: true, reviewer: true, activator: false, administrator: false }
    }, policyId, versionId: proposed.versionId, input }),
    error => error.code === 'GOVERNANCE_ROLE_REQUIRED'
  );
  await assert.rejects(
    () => service.activateVersion({ scope, authorization, policyId, versionId: proposed.versionId, input: [] }),
    error => error.code === 'GOVERNANCE_ACTIVATION_INPUT_INVALID'
  );
  await assert.rejects(
    () => service.activateVersion({ scope, authorization, policyId, versionId: proposed.versionId, input: { ...input, actorLogin: 'mallory' } }),
    error => error.code === 'GOVERNANCE_ACTIVATOR_IDENTITY_FORBIDDEN'
  );
  for (const [idempotencyKey, expectedCode] of [
    [undefined, 'GOVERNANCE_IDEMPOTENCY_KEY_REQUIRED'],
    ['short', 'GOVERNANCE_IDEMPOTENCY_KEY_INVALID']
  ]) {
    const before = calls.length;
    await assert.rejects(
      () => service.activateVersion({
        scope, authorization, policyId, versionId: proposed.versionId, input, idempotencyKey
      }),
      error => error.code === expectedCode
    );
    assert.strictEqual(calls.length, before, `${expectedCode} must fail before any store access`);
  }
  const humanKey = key('github-app-activator');
  const appAuthorization = {
    ...authorization,
    executionPrincipal: { kind: 'installation', identityKey: key('installation:91'), login: 'acme-app', authMethod: 'github-app', installationId: 91 },
    governanceActor: { kind: 'human', identityKey: humanKey, login: 'human-activator', verified: true },
    installationCapabilities: { repositorySelected: true, repositorySelection: 'selected', permissions: { metadata: 'read', contents: 'write' } }
  };
  await service.activateVersion({
    scope, authorization: appAuthorization, policyId, versionId: proposed.versionId, input,
    idempotencyKey: 'app-activation-12345'
  });
  const appCall = calls.filter(([name]) => name === 'activate').at(-1)[1];
  assert.deepStrictEqual(appCall.actor, { identityKey: humanKey, login: 'human-activator' });
  await service.rollbackVersion({
    scope, authorization, policyId, versionId: proposed.versionId,
    input: { ...input, reason: 'Restore known-good version' },
    idempotencyKey: 'rollback-activation-12345'
  });
  assert(calls.some(([name]) => name === 'rollback'));
  for (const [idempotencyKey, expectedCode] of [
    [undefined, 'GOVERNANCE_IDEMPOTENCY_KEY_REQUIRED'],
    ['short', 'GOVERNANCE_IDEMPOTENCY_KEY_INVALID']
  ]) {
    const beforeRollback = calls.length;
    await assert.rejects(
      () => service.rollbackVersion({
        scope, authorization, policyId, versionId: proposed.versionId,
        input: { ...input, reason: 'Restore known-good version' },
        idempotencyKey
      }),
      error => error.code === expectedCode
    );
    assert.strictEqual(calls.length, beforeRollback, `${expectedCode} must fail before rollback store access`);
  }
  await service.listActivationHistory({ scope, authorization, policyId, limit: 20 });
  assert(calls.some(([name]) => name === 'history'));
  console.log('governance activation API tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
