'use strict';
const assert = require('assert');
const crypto = require('crypto');
const {
  SUPPORTED_EVENT_TYPES,
  DEFAULT_NOTIFICATION_EVENT_TYPES,
  normalizeNotificationPreferences,
  normalizeWebhookDefinition,
  isPublicAddress,
  normalizeWebhookDestination,
  deriveWebhookSigningSecret,
  signWebhookPayload,
  verifyWebhookSignature,
  buildGovernanceEvent,
  buildSignedEvidenceExport,
  verifySignedEvidenceExport
} = require('../src/governance-delivery');

const scope = { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Widget', scopeKey: 'github:github.com:acme/widget' };
const secret = 's'.repeat(64);

assert(SUPPORTED_EVENT_TYPES.includes('policy.activated'));
assert(SUPPORTED_EVENT_TYPES.includes('policy.decision.block'));
assert(!DEFAULT_NOTIFICATION_EVENT_TYPES.includes('policy.decision.allow'));

const preferences = normalizeNotificationPreferences({ enabled: true, eventTypes: ['policy.activated', 'policy.activated', 'policy.decision.block'] });
assert.deepStrictEqual(preferences.eventTypes, ['policy.activated', 'policy.decision.block']);
assert.throws(() => normalizeNotificationPreferences({ eventTypes: ['unknown.event'] }), /unsupported/i);

const webhook = normalizeWebhookDefinition({
  name: 'SOC receiver',
  url: 'https://hooks.example.com/governance',
  eventTypes: ['policy.activated', 'policy.decision.block'],
  enabled: true
});
assert.strictEqual(webhook.url, 'https://hooks.example.com/governance');
assert.throws(() => normalizeWebhookDefinition({ name: 'x', url: 'http://example.com', eventTypes: ['policy.activated'] }), /https/i);
assert.throws(() => normalizeWebhookDefinition({ name: 'x', url: 'https://user:pass@example.com', eventTypes: ['policy.activated'] }), /credentials/i);

for (const blocked of ['127.0.0.1', '10.1.2.3', '172.16.2.4', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1']) {
  assert.strictEqual(isPublicAddress(blocked), false, `${blocked} must be blocked`);
}
for (const allowed of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.strictEqual(isPublicAddress(allowed), true);
const destination = normalizeWebhookDestination('https://hooks.example.com/governance', [
  { address: '8.8.8.8', family: 4 }
]);
assert.strictEqual(destination.hostname, 'hooks.example.com');
assert.strictEqual(destination.addresses[0].address, '8.8.8.8');
assert.throws(() => normalizeWebhookDestination('https://hooks.example.com/governance', [{ address: '127.0.0.1', family: 4 }]), /public/i);

const signingSecret = deriveWebhookSigningSecret(secret, scope.scopeKey, '11111111-1111-4111-8111-111111111111', 'a'.repeat(64), 1);
assert(signingSecret.startsWith('nvwhsec_'));
const body = JSON.stringify({ hello: 'world' });
const signature = signWebhookPayload(signingSecret, '22222222-2222-4222-8222-222222222222', '2026-07-23T00:00:00.000Z', body);
assert(verifyWebhookSignature(signingSecret, '22222222-2222-4222-8222-222222222222', '2026-07-23T00:00:00.000Z', body, signature));
assert(!verifyWebhookSignature(signingSecret, '22222222-2222-4222-8222-222222222222', '2026-07-23T00:00:00.000Z', `${body}x`, signature));

const event = buildGovernanceEvent({
  eventSeq: 7,
  sourceKind: 'lifecycle',
  sourceSeq: 3,
  sourceId: '33333333-3333-4333-8333-333333333333',
  eventType: 'policy.activated',
  occurredAt: '2026-07-23T00:00:00.000Z',
  scope,
  actorLogin: '=danger',
  policyId: '44444444-4444-4444-8444-444444444444',
  versionId: '55555555-5555-4555-8555-555555555555',
  subject: { activationId: '66666666-6666-4666-8666-666666666666', action: 'activate' },
  evidence: {
    lifecycleRecordHash: 'a'.repeat(64),
    detailsHash: 'b'.repeat(64),
    documentHash: 'c'.repeat(64),
    simulationHash: 'd'.repeat(64)
  }
});
assert.strictEqual(event.schemaVersion, 1);
assert.strictEqual(event.actor.login, '=danger');
assert(/^[0-9a-f]{64}$/.test(event.eventHash));
assert(Object.isFrozen(event));
assert.throws(() => buildGovernanceEvent({ ...event, eventHash: undefined, eventSeq: 8, sourceKind: 'lifecycle', sourceSeq: 4, sourceId: crypto.randomUUID(), eventType: 'policy.activated', occurredAt: event.occurredAt, scope, actorLogin: 'x', subject: { secret: 'abc' }, evidence: {} }), /unsupported|sensitive/i);

const jsonExport = buildSignedEvidenceExport({
  exportId: '77777777-7777-4777-8777-777777777777',
  generatedAt: '2026-07-23T00:01:00.000Z',
  scope,
  actorLogin: 'auditor',
  events: [event],
  format: 'json',
  secret
});
assert.strictEqual(jsonExport.manifest.recordCount, 1);
assert(verifySignedEvidenceExport(jsonExport, secret).valid);
const tampered = JSON.parse(JSON.stringify(jsonExport));
tampered.content += ' ';
assert.strictEqual(verifySignedEvidenceExport(tampered, secret).valid, false);

const csvExport = buildSignedEvidenceExport({
  exportId: '88888888-8888-4888-8888-888888888888',
  generatedAt: '2026-07-23T00:02:00.000Z',
  scope,
  actorLogin: 'auditor',
  events: [event],
  format: 'csv',
  secret
});
assert(csvExport.content.includes("'=danger"), 'CSV must prefix formula-like cells');
assert(verifySignedEvidenceExport(csvExport, secret).valid);
console.log('governance delivery model tests passed');
