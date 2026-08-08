'use strict';
const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');

class Client {
  constructor(steps) { this.steps = [...steps]; this.calls = []; }
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    this.calls.push({ text, params });
    const step = this.steps.shift();
    assert(step, `unexpected query ${text}`);
    if (step.match) assert.match(text, step.match, text);
    if (step.check) step.check(params, text);
    return step.result || { rows: [], rowCount: 0 };
  }
  release() {}
}
class Pool {
  constructor(client) { this.client = client; }
  connect() { return Promise.resolve(this.client); }
  query(sql, params) { return this.client.query(sql, params); }
}
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const scopeKey = 'github:github.com:acme/demo';
const actor = { identityKey: 'a'.repeat(64), login: 'Alice' };
const ids = {
  webhook: '10000000-0000-4000-8000-000000000001',
  event: '20000000-0000-4000-8000-000000000002',
  policy: '30000000-0000-4000-8000-000000000003',
  version: '40000000-0000-4000-8000-000000000004',
  export: '50000000-0000-4000-8000-000000000005'
};
function makeStore(client, generated = []) {
  let index = 0;
  return new GovernanceStore(new Pool(client), {
    secret: 'delivery-store-secret-0123456789abcdef0123456789',
    idFactory: () => generated[index++],
    saltFactory: () => 'b'.repeat(64),
    now: () => new Date('2026-07-23T10:00:00.000Z')
  });
}
(async () => {
  {
    const client = new Client([{ match: /FROM nv_governance_notification_preferences/, result: { rows: [] } }]);
    const result = await makeStore(client).getNotificationPreferences({ scope, actor });
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.lastReadSeq, 0);
    assert(result.eventTypes.includes('policy.activated'));
  }
  {
    const row = { webhook_id: ids.webhook, scope_key: scopeKey, name: 'SOC', endpoint_url: 'https://hooks.example.com/events', event_types: ['policy.activated'], enabled: true, secret_version: 1, created_by_login: 'Alice', created_at: '2026-07-23T10:00:00.000Z', updated_at: '2026-07-23T10:00:00.000Z', deleted_at: null };
    const client = new Client([
      { match: /^BEGIN$/ },
      { match: /INSERT INTO nv_governance_webhooks/, result: { rows: [row], rowCount: 1 } },
      { match: /^COMMIT$/ }
    ]);
    const result = await makeStore(client, [ids.webhook]).createWebhook({
      scope, actor, definition: { name: 'SOC', url: 'https://hooks.example.com/events', eventTypes: ['policy.activated'], enabled: true }
    });
    assert.strictEqual(result.webhook.webhookId, ids.webhook);
    assert(result.signingSecret.startsWith('nvwhsec_'));
  }
  {
    const joined = {
      event_seq: 9, source_kind: 'lifecycle', source_seq: 4, source_id: ids.event, scope_key: scopeKey,
      event_type: 'policy.activated', occurred_at: '2026-07-23T09:00:00.000Z',
      lifecycle_policy_id: ids.policy, lifecycle_version_id: ids.version, lifecycle_actor_login: 'Alice',
      lifecycle_details: { activationId: ids.webhook, action: 'activate', documentHash: 'c'.repeat(64), simulationHash: 'd'.repeat(64) },
      lifecycle_details_hash: 'e'.repeat(64), lifecycle_record_hash: 'f'.repeat(64),
      lifecycle_provider: 'github', lifecycle_authority: 'github.com', lifecycle_owner: 'Acme', lifecycle_repo: 'Demo'
    };
    const client = new Client([{ match: /FROM nv_governance_event_outbox o/, result: { rows: [joined] } }]);
    const events = await makeStore(client).eventRows(client, { scope, afterSeq: 0, limit: 10 });
    assert.strictEqual(events[0].eventSeq, 9);
    assert.strictEqual(events[0].subject.activationId, ids.webhook);
    assert.strictEqual(events[0].evidence.documentHash, 'c'.repeat(64));
  }
  {
    const joined = {
      event_seq: 9, source_kind: 'lifecycle', source_seq: 4, source_id: ids.event, scope_key: scopeKey,
      event_type: 'policy.activated', occurred_at: '2026-07-23T09:00:00.000Z',
      lifecycle_policy_id: ids.policy, lifecycle_version_id: ids.version, lifecycle_actor_login: 'Alice',
      lifecycle_details: { activationId: ids.webhook, action: 'activate', documentHash: 'c'.repeat(64) },
      lifecycle_details_hash: 'e'.repeat(64), lifecycle_record_hash: 'f'.repeat(64),
      lifecycle_provider: 'github', lifecycle_authority: 'github.com', lifecycle_owner: 'Acme', lifecycle_repo: 'Demo'
    };
    const client = new Client([
      { match: /^BEGIN ISOLATION LEVEL REPEATABLE READ$/ },
      { match: /pg_advisory_xact_lock/ },
      { match: /FROM nv_governance_exports/, result: { rows: [] } },
      { match: /max\(event_seq\)/, result: { rows: [{ max_seq: 9 }] } },
      { match: /FROM nv_governance_event_outbox o/, result: { rows: [joined] } },
      { match: /INSERT INTO nv_governance_exports/, check(params) { assert.strictEqual(params[0], ids.export); assert.strictEqual(params[13], 1); }, result: { rowCount: 1 } },
      { match: /^COMMIT$/ }
    ]);
    const result = await makeStore(client, [ids.export]).createEvidenceExport({
      scope, actor, format: 'json', afterEventSeq: 0, limit: 1000, idempotencyKey: 'export-key-12345'
    });
    assert.strictEqual(result.manifest.recordCount, 1);
    assert.strictEqual(result.manifest.lastEventSeq, 9);
  }
  console.log('governance delivery store tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
