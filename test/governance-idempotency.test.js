'use strict';

const assert = require('assert');
const { GovernanceStore } = require('../src/governance-store');

class ScriptedClient {
  constructor(steps) { this.steps = [...steps]; this.calls = []; this.released = false; }
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    this.calls.push({ text, params });
    const step = this.steps.shift();
    assert(step, `unexpected query: ${text}`);
    if (step.match) assert.match(text, step.match, `query mismatch: ${text}`);
    if (step.check) step.check(params, text);
    if (step.error) throw step.error;
    return step.result || { rows: [], rowCount: 0 };
  }
  release() { this.released = true; }
}
class ScriptedPool {
  constructor(client) { this.client = client; }
  async connect() { return this.client; }
  async query(sql, params) { return this.client.query(sql, params); }
}
function makeStore(client) {
  return new GovernanceStore(new ScriptedPool(client), {
    secret: 'governance-store-secret-0123456789abcdef',
    now: () => new Date('2026-07-22T14:00:00.000Z')
  });
}
const base = {
  idempotencyKey: 'request-12345678',
  scopeKey: 'github:github.com:acme/demo',
  actorIdentityKey: 'a'.repeat(64),
  operation: 'governance.policy.create',
  request: { policyKey: 'release-safety', name: 'Release safety', description: '' }
};

(async () => {
  let requestHash;
  const response = { policyId: '10000000-0000-4000-8000-000000000001', policyKey: 'release-safety' };
  let firstWorkCalls = 0;
  const firstClient = new ScriptedClient([
    { match: /^BEGIN$/ },
    { match: /INSERT INTO nv_governance_idempotency/, check(params) {
      assert.strictEqual(params[0], base.scopeKey);
      assert.strictEqual(params[1], base.actorIdentityKey);
      assert.strictEqual(params[2], base.operation);
      assert.match(params[3], /^[0-9a-f]{64}$/);
      assert.match(params[4], /^[0-9a-f]{64}$/);
      assert.notStrictEqual(params[3], base.idempotencyKey, 'raw idempotency key must not be stored');
      requestHash = params[4];
    }, result: { rows: [{ request_hash: 'reserved' }], rowCount: 1 } },
    { match: /UPDATE nv_governance_idempotency SET response_body/, check(params) {
      assert.deepStrictEqual(JSON.parse(params[0]), response);
    }, result: { rowCount: 1 } },
    { match: /^COMMIT$/ }
  ]);
  const first = await makeStore(firstClient).idempotentTransaction(base, async () => {
    firstWorkCalls += 1;
    return response;
  });
  assert.deepStrictEqual(first, response);
  assert.strictEqual(firstWorkCalls, 1);

  let replayWorkCalls = 0;
  const replayClient = new ScriptedClient([
    { match: /^BEGIN$/ },
    { match: /INSERT INTO nv_governance_idempotency/, result: { rows: [], rowCount: 0 } },
    { match: /SELECT request_hash,response_body FROM nv_governance_idempotency/, result: { rows: [{ request_hash: requestHash, response_body: response }] } },
    { match: /^COMMIT$/ }
  ]);
  const replay = await makeStore(replayClient).idempotentTransaction(base, async () => {
    replayWorkCalls += 1;
    return { impossible: true };
  });
  assert.deepStrictEqual(replay, response);
  assert.strictEqual(replayWorkCalls, 0, 'exact retries must not execute the governance write twice');

  const conflictClient = new ScriptedClient([
    { match: /^BEGIN$/ },
    { match: /INSERT INTO nv_governance_idempotency/, result: { rows: [], rowCount: 0 } },
    { match: /SELECT request_hash,response_body FROM nv_governance_idempotency/, result: { rows: [{ request_hash: requestHash, response_body: response }] } },
    { match: /^ROLLBACK$/ }
  ]);
  await assert.rejects(
    () => makeStore(conflictClient).idempotentTransaction({ ...base, request: { ...base.request, name: 'Different' } }, async () => response),
    error => error.code === 'GOVERNANCE_IDEMPOTENCY_CONFLICT' && error.status === 409
  );

  const unusedClient = new ScriptedClient([]);
  await assert.rejects(
    () => makeStore(unusedClient).idempotentTransaction({ ...base, idempotencyKey: 'short' }, async () => response),
    error => error.code === 'GOVERNANCE_IDEMPOTENCY_KEY_INVALID'
  );
  assert.strictEqual(unusedClient.calls.length, 0);

  console.log('governance idempotency tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
