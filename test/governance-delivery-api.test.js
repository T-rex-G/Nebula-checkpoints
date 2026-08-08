'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createGovernanceApiService } = require('../src/governance-api');

const key = value => crypto.createHash('sha256').update(value).digest('hex');
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
function snapshot(level = 50) {
  const baseRole = level >= 50 ? 'admin' : level >= 40 ? 'maintain' : level >= 30 ? 'write' : 'read';
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
    executionPrincipal: { kind: 'user', identityKey: key('delivery-admin'), login: 'delivery-admin', authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey: key('delivery-admin'), login: 'delivery-admin', verified: true },
    repositoryAccess: { baseRole, providerRole: baseRole, level, source: 'github.collaborator.permission', complete: true },
    governanceRoles: { reader: true, author: level >= 30, reviewer: level >= 40, activator: level >= 50, administrator: level >= 50 },
    installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: '2026-07-23T10:00:00.000Z', expiresAt: '2026-07-23T10:02:00.000Z', reasonCode: null }
  };
}
const calls = [];
const noop = async () => ({});
const store = {
  listPolicies: async () => [], createPolicy: noop, getPolicyStateInScope: noop,
  createDraft: noop, getDraft: async () => ({ document: { schemaVersion: 1, rules: [] }, requiredApprovals: 1, disallowAuthorApproval: true }), updateDraft: noop, submitDraft: noop,
  listVersions: async () => [], getVersionInScope: noop, getReviewState: noop, claimReviewer: noop, recordReviewDecision: noop,
  activateVersion: noop, rollbackVersion: noop, listActivationHistory: async () => [],
  createExceptionRequest: noop, getException: noop, listExceptions: async () => [], decideException: noop, revokeException: noop,
  listPolicyDecisionsInScope: async () => ({ decisions: [] }), verifyPolicyDecisionChainInScope: noop,
  async getNotificationPreferences(input) { calls.push(['getNotificationPreferences', input]); return { enabled: true, eventTypes: [], lastReadSeq: 0 }; },
  async updateNotificationPreferences(input) { calls.push(['updateNotificationPreferences', input]); return input.preferences; },
  async markNotificationsRead(input) { calls.push(['markNotificationsRead', input]); return { lastReadSeq: input.throughSeq }; },
  async listNotifications(input) { calls.push(['listNotifications', input]); return { events: [] }; },
  async createWebhook(input) { calls.push(['createWebhook', input]); return { webhook: { webhookId: '10000000-0000-4000-8000-000000000001' }, signingSecret: 'nvwhsec_once' }; },
  async listWebhooks(input) { calls.push(['listWebhooks', input]); return []; },
  async updateWebhook(input) { calls.push(['updateWebhook', input]); return { webhookId: input.webhookId }; },
  async rotateWebhookSecret(input) { calls.push(['rotateWebhookSecret', input]); return { signingSecret: 'nvwhsec_rotated' }; },
  async deleteWebhook(input) { calls.push(['deleteWebhook', input]); return { deletedAt: '2026-07-23T10:01:00.000Z' }; },
  async listWebhookDeliveries(input) { calls.push(['listWebhookDeliveries', input]); return []; },
  async createEvidenceExport(input) { calls.push(['createEvidenceExport', input]); return { format: 'nebulaverse-governance-evidence-envelope' }; },
  async listEvidenceExports(input) { calls.push(['listEvidenceExports', input]); return []; },
  async getEvidenceExport(input) { calls.push(['getEvidenceExport', input]); return { format: 'nebulaverse-governance-evidence-envelope' }; },
  async verifyEvidenceExport(input) { calls.push(['verifyEvidenceExport', input]); return { valid: true }; }
};

(async () => {
  const service = createGovernanceApiService({
    store,
    now: () => Date.parse('2026-07-23T10:01:00.000Z'),
    resolveWebhookAddresses: async hostname => hostname === 'hooks.example.com'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]
  });
  const authorization = snapshot();

  await service.updateNotificationPreferences({ scope, authorization, input: { enabled: true, eventTypes: ['policy.activated'] }, idempotencyKey: 'pref-12345678' });
  assert.deepStrictEqual(calls.find(([name]) => name === 'updateNotificationPreferences')[1].actor, { identityKey: key('delivery-admin'), login: 'delivery-admin' });
  await assert.rejects(
    service.updateNotificationPreferences({ scope, authorization, input: { actorLogin: 'mallory' } }),
    error => error.code === 'GOVERNANCE_DELIVERY_IDENTITY_FORBIDDEN'
  );

  await service.markNotificationsRead({ scope, authorization, input: { throughSeq: 12 }, idempotencyKey: 'read-12345678' });
  assert.strictEqual(calls.find(([name]) => name === 'markNotificationsRead')[1].throughSeq, 12);

  const created = await service.createWebhook({
    scope, authorization,
    input: { name: 'Security evidence', url: 'https://hooks.example.com/events', eventTypes: ['policy.decision.block'], enabled: true },
    idempotencyKey: 'hook-create-1234'
  });
  assert.strictEqual(created.signingSecret, 'nvwhsec_once');
  assert.strictEqual(calls.find(([name]) => name === 'createWebhook')[1].definition.url, 'https://hooks.example.com/events');

  await assert.rejects(
    service.createWebhook({ scope, authorization, input: { name: 'bad', url: 'https://127.0.0.1/hook', eventTypes: ['policy.activated'] } }),
    error => error.code === 'GOVERNANCE_WEBHOOK_SSRF_BLOCKED'
  );
  await assert.rejects(
    service.createWebhook({ scope, authorization: snapshot(40), input: { name: 'nope', url: 'https://hooks.example.com/hook', eventTypes: ['policy.activated'] } }),
    error => error.code === 'GOVERNANCE_ROLE_REQUIRED'
  );
  await assert.rejects(
    service.createWebhook({ scope, authorization, input: { name: 'bad', url: 'https://hooks.example.com/hook', eventTypes: ['policy.activated'], secret: 'client-secret' } }),
    error => error.code === 'GOVERNANCE_DELIVERY_SECRET_FORBIDDEN'
  );

  await service.createEvidenceExport({
    scope, authorization,
    input: { format: 'csv', afterEventSeq: 0, throughEventSeq: 10, limit: 10 },
    idempotencyKey: 'export-12345678'
  });
  const exportCall = calls.find(([name]) => name === 'createEvidenceExport')[1];
  assert.strictEqual(exportCall.format, 'csv');
  assert.strictEqual(exportCall.throughEventSeq, 10);
  assert.strictEqual(exportCall.actor.login, 'delivery-admin');

  await service.listEvidenceExports({ scope, authorization, limit: 25 });
  await service.verifyEvidenceExport({ scope, authorization, exportId: '20000000-0000-4000-8000-000000000002' });
  console.log('governance delivery API tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
