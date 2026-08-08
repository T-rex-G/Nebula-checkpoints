'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { processWebhookDeliveryBatch } = require('../src/governance-webhook-worker');
const { verifyWebhookSignature } = require('../src/governance-delivery');

const scope = { provider: 'github', baseUrl: 'https://github.com', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' };
const event = {
  schemaVersion: 1,
  eventId: 'nvgevt_1_lifecycle_10000000-0000-4000-8000-000000000001',
  eventSeq: 7,
  type: 'policy.activated',
  occurredAt: '2026-07-23T10:00:00.000Z',
  scope,
  actor: { login: 'alice' },
  subject: { policyId: '20000000-0000-4000-8000-000000000002', versionId: '30000000-0000-4000-8000-000000000003' },
  evidence: { sourceKind: 'lifecycle', sourceSeq: 4, sourceId: '10000000-0000-4000-8000-000000000001', sourceRecordHash: 'a'.repeat(64) },
  eventHash: 'b'.repeat(64)
};
const delivery = {
  deliveryId: '40000000-0000-4000-8000-000000000004',
  webhookId: '50000000-0000-4000-8000-000000000005',
  eventSeq: 7,
  scope,
  url: 'https://hooks.example.com/nebulaverse',
  secretSalt: 'c'.repeat(64),
  secretVersion: 1,
  attemptCount: 0
};

(async () => {
  const attempts = [];
  const store = {
    async claimWebhookDeliveries() { return [delivery]; },
    async getGovernanceEvent(input) { assert.strictEqual(input.eventSeq, 7); assert.strictEqual(input.scope.scopeKey, scope.scopeKey); return event; },
    async recordWebhookDeliveryAttempt(input) { attempts.push(input); return { status: input.delivered ? 'delivered' : input.terminal ? 'dead-letter' : 'retry' }; }
  };
  const sent = [];
  const result = await processWebhookDeliveryBatch({
    store,
    masterSecret: 'm'.repeat(64),
    now: () => new Date('2026-07-23T10:01:00.000Z'),
    resolveAddresses: async hostname => { assert.strictEqual(hostname, 'hooks.example.com'); return [{ address: '93.184.216.34', family: 4 }]; },
    transport: async request => { sent.push(request); return { statusCode: 204 }; }
  });
  assert.deepStrictEqual(result, { claimed: 1, delivered: 1, retrying: 0, deadLettered: 0 });
  assert.strictEqual(sent[0].headers['X-Nebulaverse-Delivery'], delivery.deliveryId);
  assert.strictEqual(sent[0].headers['X-Nebulaverse-Event'], 'policy.activated');
  assert.strictEqual(sent[0].headers['X-Nebulaverse-Event-Hash'], event.eventHash);
  assert(verifyWebhookSignature(
    sent[0].signingSecret,
    delivery.deliveryId,
    sent[0].headers['X-Nebulaverse-Timestamp'],
    sent[0].body,
    sent[0].headers['X-Nebulaverse-Signature']
  ));
  assert.strictEqual(attempts[0].delivered, true);
  assert.strictEqual(attempts[0].eventHash, event.eventHash);
  assert(/^[0-9a-f]{64}$/.test(attempts[0].signatureHash));

  const permanentAttempts = [];
  await processWebhookDeliveryBatch({
    store: {
      ...store,
      async recordWebhookDeliveryAttempt(input) { permanentAttempts.push(input); return { status: 'dead-letter' }; }
    },
    masterSecret: 'm'.repeat(64),
    now: () => new Date('2026-07-23T10:01:00.000Z'),
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async () => ({ statusCode: 410 })
  });
  assert.strictEqual(permanentAttempts[0].terminal, true);
  assert.strictEqual(permanentAttempts[0].errorCode, 'WEBHOOK_HTTP_410');

  const blockedAttempts = [];
  await processWebhookDeliveryBatch({
    store: {
      ...store,
      async recordWebhookDeliveryAttempt(input) { blockedAttempts.push(input); return { status: 'dead-letter' }; }
    },
    masterSecret: 'm'.repeat(64),
    now: () => new Date('2026-07-23T10:01:00.000Z'),
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
    transport: async () => { throw new Error('must not send'); }
  });
  assert.strictEqual(blockedAttempts[0].terminal, true);
  assert.strictEqual(blockedAttempts[0].errorCode, 'GOVERNANCE_WEBHOOK_SSRF_BLOCKED');

  console.log('governance webhook worker tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
