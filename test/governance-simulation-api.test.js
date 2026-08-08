'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { createGovernanceApiService } = require('../src/governance-api');
const { policyDocumentHash } = require('../src/governance-model');
const key = value => crypto.createHash('sha256').update(value).digest('hex');
const now = Date.parse('2026-07-22T16:40:30.000Z');
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const actorKey = key('github:alice');
const authorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: actorKey, login: 'alice', authMethod: 'oauth' },
  governanceActor: { kind: 'human', identityKey: actorKey, login: 'alice', verified: true },
  repositoryAccess: { baseRole: 'read', providerRole: 'read', level: 10, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: false, reviewer: false, activator: false, administrator: false },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T16:40:00.000Z', expiresAt: '2026-07-22T16:41:00.000Z', reasonCode: null }
};
const proposed = { versionId: '20000000-0000-4000-8000-000000000002', policyId: '10000000-0000-4000-8000-000000000001', versionNumber: 2, document: { schemaVersion: 1, rules: [{ id: 'deny-reset', action: 'branch.reset', effect: 'deny' }] }, documentHash: policyDocumentHash({ schemaVersion: 1, rules: [{ id: 'deny-reset', action: 'branch.reset', effect: 'deny' }] }) };
const active = { versionId: '30000000-0000-4000-8000-000000000003', policyId: proposed.policyId, versionNumber: 1, document: { schemaVersion: 1, rules: [] }, documentHash: policyDocumentHash({ schemaVersion: 1, rules: [] }) };
const calls = [];
const store = {
  async listPolicies() { return []; }, async createPolicy() {},
  async getPolicyStateInScope(input) { calls.push(['policy', input]); return { policyId: input.policyId, activeVersionId: active.versionId }; },
  async createDraft() {}, async getDraft() {}, async updateDraft() {}, async submitDraft() {}, async listVersions() {},
  async getVersionInScope(input) { calls.push(['version', input]); return input.versionId === proposed.versionId ? proposed : active; },
  async getReviewState() {}, async claimReviewer() {}, async recordReviewDecision() {},
  async activateVersion() {}, async rollbackVersion() {}, async listActivationHistory() {},
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
  assert.strictEqual(typeof service.simulateVersion, 'function');
  const report = await service.simulateVersion({
    scope, authorization, policyId: proposed.policyId, versionId: proposed.versionId,
    input: { schemaVersion: 1, scenarios: [{ id: 'reset', action: 'branch.reset', attributes: { branch: 'main' } }] }
  });
  assert.strictEqual(report.scope.scopeKey, 'github:github.com:acme/demo');
  assert.strictEqual(report.proposed.versionId, proposed.versionId);
  assert.strictEqual(report.baseline.versionId, active.versionId);
  assert.strictEqual(report.results[0].change, 'strengthened');
  assert.strictEqual(calls.filter(([name]) => name === 'version').length, 2);
  assert(!calls.some(([name]) => name === 'write'), 'simulation must use no store write');
  console.log('governance simulation API tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
