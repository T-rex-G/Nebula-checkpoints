'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createGovernanceApiService } = require('../src/governance-api');
const key = value => crypto.createHash('sha256').update(value).digest('hex');
const userKey = key('github:reader');
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const authorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: userKey, login: 'reader', authMethod: 'oauth' },
  governanceActor: { kind: 'human', identityKey: userKey, login: 'reader', verified: true },
  repositoryAccess: { baseRole: 'read', providerRole: 'read', level: 10, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: false, reviewer: false, activator: false, administrator: false },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T20:00:00.000Z', expiresAt: '2026-07-22T20:02:00.000Z', reasonCode: null }
};
const calls = [];
const store = {
  async listPolicies() { return []; }, async createPolicy() {}, async getPolicyStateInScope() {},
  async createDraft() {}, async getDraft() {}, async updateDraft() {}, async submitDraft() {},
  async listVersions() {}, async getVersionInScope() {}, async getReviewState() {}, async claimReviewer() {}, async recordReviewDecision() {},
  async activateVersion() {}, async rollbackVersion() {}, async listActivationHistory() {},
  async createExceptionRequest() {}, async getException() {}, async listExceptions() {}, async decideException() {}, async revokeException() {},
  async listPolicyDecisionsInScope() {}, async verifyPolicyDecisionChainInScope() {},
  async getDigitalTwinReadModelData(input) { calls.push(input); return { asOf: '2026-07-22T20:00:00.000Z', policies: [], versions: [], drafts: [], exceptions: [], activations: [], decisions: [], completeness: { policies: true, versions: true, drafts: true, exceptions: true, activations: true, decisions: true }, nextDecisionSeq: null }; },
  async getNotificationPreferences() { return { enabled: true, eventTypes: [], lastReadSeq: 0 }; },
  async updateNotificationPreferences(input) { return input.preferences; },
  async markNotificationsRead(input) { return { lastReadSeq: input.throughSeq }; },
  async listNotifications() { return { events: [], unreadCount: 0 }; },
  async createWebhook() { return {}; }, async listWebhooks() { return []; }, async updateWebhook() { return {}; },
  async rotateWebhookSecret() { return {}; }, async deleteWebhook() { return {}; }, async listWebhookDeliveries() { return []; },
  async createEvidenceExport() { return {}; }, async listEvidenceExports() { return []; }, async getEvidenceExport() { return {}; }, async verifyEvidenceExport() { return { valid: true }; }

};

(async () => {
  const service = createGovernanceApiService({
    store,
    now: () => Date.parse('2026-07-22T20:01:00.000Z'),
    resolveRepositoryFacts: async ({ scope: normalizedScope }) => ({ schemaVersion: 1, defaultBranch: 'main', protectedBranches: ['main'], pullRequestsEnabled: true, branchesComplete: true, protectedBranchesTruncated: false, resolvedForScopeKey: normalizedScope.scopeKey })
  });
  const templates = await service.listPolicyTemplates({ scope, authorization });
  assert(templates.length >= 3);
  const baseline = await service.generateRepositoryBaseline({ scope, authorization, input: { templateId: 'protected-default-branch' } });
  assert.strictEqual(baseline.provenance.factsSource, 'server-resolved');
  assert.strictEqual(baseline.scope.scopeKey, 'github:github.com:acme/demo');
  await assert.rejects(
    service.generateRepositoryBaseline({ scope, authorization, input: { templateId: 'protected-default-branch', facts: { defaultBranch: 'evil' } } }),
    error => error.code === 'GOVERNANCE_BASELINE_INPUT_INVALID'
  );
  const twin = await service.getPolicyDigitalTwin({ scope, authorization, historyLimit: 25, afterDecisionSeq: 0 });
  assert.strictEqual(twin.scope.scopeKey, 'github:github.com:acme/demo');
  assert.strictEqual(calls[0].historyLimit, 25);
  console.log('governance template and Digital Twin API tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
