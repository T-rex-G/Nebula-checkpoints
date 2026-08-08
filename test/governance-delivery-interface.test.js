'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/governance-ui');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const twin = {
  schemaVersion: 1,
  scope: { owner: 'Acme', repo: 'Demo' },
  freshness: { status: 'current', asOf: '2026-07-23T11:00:00.000Z', completeness: {} },
  current: { policyCount: 0, policies: [], activeVersionCount: 0, enforcementModes: {} },
  proposed: { drafts: [], versions: [] },
  effective: { activePolicyCount: 0, activeExceptionCount: 0 },
  history: { activations: [], decisions: [], exceptions: [] },
  readModelHash: 'a'.repeat(64)
};
const access = {
  actor: { login: 'admin' }, execution: { kind: 'user', authMethod: 'oauth' },
  capabilities: { read: true, author: true, review: true, activate: true, administer: true },
  evidence: { status: 'current', expiresAt: '2099-01-01T00:00:00.000Z' }
};
const html = ui.renderGovernanceInterface({
  digitalTwin: twin, access,
  delivery: {
    preferences: { enabled: true, eventTypes: ['policy.activated'], lastReadSeq: 1 },
    notifications: { events: [{ seq: 2, eventType: '<img src=x onerror=1>', createdAt: '2026-07-23T11:01:00.000Z', eventHash: 'b'.repeat(64) }] },
    exports: [{ exportId: 'e1', format: 'json', eventCount: 1, createdAt: '2026-07-23T11:02:00.000Z', envelopeHash: 'c'.repeat(64) }],
    webhooks: [{ webhookId: 'w1', name: '<script>x</script>', url: 'https://hooks.example.com/events', eventTypes: ['policy.activated'], enabled: true }]
  }
});
assert(html.includes('Notifications and signed evidence'));
assert(html.includes('Create signed export'));
assert(html.includes('Administrative webhooks'));
assert(!html.includes('<script>x</script>') && html.includes('&lt;script&gt;x&lt;/script&gt;'));
assert(!html.includes('<img src=x onerror=1>'));
for (const symbol of ['loadGovernanceDelivery', 'editGovernanceNotificationPreferences', 'createGovernanceEvidenceExport', 'createGovernanceWebhook', 'rotateGovernanceWebhook', 'deleteGovernanceWebhook']) {
  assert(app.includes(`function ${symbol}`) || app.includes(`async function ${symbol}`), `missing ${symbol}`);
}
assert(app.includes('/notifications?limit=50&afterSeq=0'));
assert(app.includes('/exports?limit=50'));
assert(app.includes("state.governance.access.capabilities.administer === true"), 'webhooks must load only for administrators');
assert(app.includes('This secret is shown once and cannot be recovered.'));
assert(!app.includes("localStorage.setItem('governance") && !app.includes('nv_governance_delivery'));
console.log('governance delivery interface tests passed');
