'use strict';
const assert = require('assert');
const { markup } = require('./helpers/governance-view');
const { createGovernance } = require('../apps/web/src/features/governance/governance-actions.ts');
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
const html = markup({
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
/*
 * The delivery the screen draws is read by the module: notifications from the
 * start and exports a bounded page at a time, webhooks only for an
 * administrator, a new or rotated signing secret shown once with its warning,
 * and none of it kept in the browser's storage.
 */
(async () => {
  for (const administer of [true, false]) {
    const asked = [];
    const stored = [];
    const shown = [];
    const state = { work: { owner: 'Acme', repo: 'Demo' }, governance: { access: { capabilities: { administer } }, delivery: {} } };
    const governance = createGovernance({
      state, mutate: change => change(state.governance),
      api: async (url, init = {}) => { asked.push(`${init.method || 'GET'} ${url}`); return /webhooks$/.test(url) && init.method === 'POST' ? { signingSecret: 'once' } : {}; },
      modal: async request => { shown.push(request); return true; }, toast() {}, stepUp: async () => null,
      $: selector => ({ '#govWebhookName': { value: 'hook' }, '#govWebhookUrl': { value: 'https://hooks.example.com/x' }, '#govWebhookTypes': { value: 'policy.activated' } })[selector] || null,
      doc: { createElement: () => ({}), body: { appendChild() {} }, activeElement: null },
      storage: () => ({ getItem: () => null, setItem: (key, value) => stored.push([key, value]) }),
      draw() {}, requestAnimationFrame: run => run(), setTimeout: () => 0, clearTimeout() {}, now: () => 0, randomId: () => 'id', cssEscape: value => value
    });
    await governance.handlers['delivery-refresh']({ dataset: {} });
    const base = '/api/repo/Acme/Demo/governance';
    assert.deepStrictEqual(asked, [`GET ${base}/notifications?limit=50&afterSeq=0`, `GET ${base}/notifications/preferences`, `GET ${base}/exports?limit=50`, ...(administer ? [`GET ${base}/webhooks`] : [])],
      administer ? 'an administrator reads the webhooks too' : 'webhooks must load only for administrators');
    if (administer) {
      await governance.handlers['create-webhook']({ dataset: {} });
      const secret = shown.find(request => request.title === 'Webhook signing secret \u2014 save now');
      assert(secret && secret.bodyHTML.includes('once') && secret.bodyHTML.includes('This secret is shown once and cannot be recovered.'));
    }
    assert.deepStrictEqual(stored, [], 'governance evidence must not be persisted in browser storage');
  }
  console.log('governance delivery interface tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
