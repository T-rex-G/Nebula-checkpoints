'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  GUARDED_TO_WEBHOOK_CODE,
  processWebhookDeliveryBatch,
  sendPinnedHttpsWebhook,
  startWebhookWorker
} = require('../src/governance-webhook-worker');
const { CODES: GUARDED_FETCH_CODES } = require('../src/guarded-fetch');
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

/*
 * Delivery now runs over the shared guarded transport, which speaks its own
 * codes. `terminal` is decided from the code this file records, so a
 * translation that goes missing is not cosmetic: a permanently misconfigured
 * destination gets recorded as a generic transport error and retried to the
 * attempt ceiling instead of being dead-lettered on the first try.
 *
 * So the table is checked for totality against the transport's own registry
 * rather than trusted, and the codes it produces are checked against this
 * file's vocabulary so a translation cannot quietly invent a new one that
 * nothing reading attempts has ever seen.
 */
{
  const knownWebhookCodes = new Set([
    'WEBHOOK_BODY_TOO_LARGE', 'WEBHOOK_DNS_INVALID', 'WEBHOOK_ENCODING_REFUSED',
    'WEBHOOK_RESPONSE_TOO_LARGE', 'WEBHOOK_SSRF_BLOCKED', 'WEBHOOK_TIMEOUT',
    'WEBHOOK_TRANSPORT_ERROR', 'WEBHOOK_URL_INVALID'
  ]);
  const transportCodes = Object.values(GUARDED_FETCH_CODES);
  assert(transportCodes.length > 0, 'the transport must publish its codes, or this check proves nothing');
  assert.deepStrictEqual(
    transportCodes.filter(code => !(code in GUARDED_TO_WEBHOOK_CODE)), [],
    'every transport code must translate explicitly: a fallback hides the ones that should be terminal'
  );
  assert.deepStrictEqual(
    Object.values(GUARDED_TO_WEBHOOK_CODE).filter(code => !knownWebhookCodes.has(code)), [],
    'a translation may not invent a code outside the vocabulary recorded on delivery attempts'
  );
}

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
  assert.deepStrictEqual(result, { claimed: 1, delivered: 1, retrying: 0, deadLettered: 0, released: 0 });
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

  const redirectAttempts = [];
  let redirectTransportCalls = 0;
  await processWebhookDeliveryBatch({
    store: {
      ...store,
      async recordWebhookDeliveryAttempt(input) { redirectAttempts.push(input); return { status: 'dead-letter' }; }
    },
    masterSecret: 'm'.repeat(64),
    now: () => new Date('2026-07-23T10:01:00.000Z'),
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async () => {
      redirectTransportCalls += 1;
      return { statusCode: 302, headers: { location: 'https://redirect.example.invalid/' } };
    }
  });
  assert.strictEqual(redirectTransportCalls, 1, 'webhook delivery must never follow redirects');
  assert.strictEqual(redirectAttempts[0].terminal, true);
  assert.strictEqual(redirectAttempts[0].errorCode, 'WEBHOOK_HTTP_302');

  let defaultSenderCalls = 0;
  const redirectResponse = await sendPinnedHttpsWebhook({
    destination: {
      url: 'https://hooks.example.com/nebulaverse',
      addresses: [{ address: '93.184.216.34', family: 4 }]
    },
    body: '{}',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
    requestImpl(options, callback) {
      defaultSenderCalls += 1;
      assert.strictEqual(options.hostname, 'hooks.example.com');
      assert.strictEqual(options.agent, false);
      options.lookup('hooks.example.com', {}, (error, address, family) => {
        assert.ifError(error);
        assert.strictEqual(address, '93.184.216.34');
        assert.strictEqual(family, 4);
      });
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 302;
        response.resume = () => queueMicrotask(() => response.emit('end'));
        response.destroy = () => {};
        callback(response);
      };
      request.destroy = error => request.emit('error', error);
      return request;
    }
  });
  assert.deepStrictEqual(redirectResponse, { statusCode: 302 });
  assert.strictEqual(defaultSenderCalls, 1, 'the default pinned sender must not issue a second request for redirects');

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

  /*
   * A batch is claimed all at once under one lease and delivered one at a
   * time. Ten rows, a ten-second transport timeout each, and a sixty-second
   * lease: the arithmetic does not close. Rows reached after the lease has
   * passed are reclaimable by any other worker -- claimWebhookDeliveries takes
   * rows where status is 'delivering' and lease_until has gone by -- so the
   * receiver gets them twice, once from whoever reclaimed them and once from
   * this batch, which is still working through a lease it no longer holds.
   *
   * Database fencing cannot retract an HTTP request that has already left, so
   * the only place this can be fixed is before the send.
   */
  const leaseUntil = '2026-07-23T10:01:00.000Z';
  const slowBatch = ['a', 'b', 'c'].map((suffix, index) => ({
    ...delivery,
    deliveryId: `4000000${index}-0000-4000-8000-00000000000${index + 4}`,
    leaseUntil
  }));
  let slowClock = Date.parse('2026-07-23T10:00:30.000Z');
  const slowSends = [];
  const slowAttempts = [];
  const slowResult = await processWebhookDeliveryBatch({
    store: {
      ...store,
      async claimWebhookDeliveries() { return slowBatch; },
      async recordWebhookDeliveryAttempt(input) { slowAttempts.push(input); return { status: 'delivered' }; }
    },
    masterSecret: 'm'.repeat(64),
    now: () => new Date(slowClock),
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    /* Each send takes twenty-five seconds, so the third begins after the lease. */
    transport: async request => { slowSends.push(request); slowClock += 25_000; return { statusCode: 204 }; }
  });

  assert.strictEqual(
    slowSends.length, 2,
    'a delivery whose lease has passed must not be sent: another worker may already own it'
  );
  assert.strictEqual(
    slowAttempts.length, 2,
    'and no attempt may be recorded for a row this batch no longer holds'
  );
  assert.strictEqual(
    slowResult.released, 1,
    'the batch must report the rows it put down rather than silently dropping them'
  );
  assert.strictEqual(slowResult.claimed, 3);
  assert.strictEqual(slowResult.delivered, 2);

  /* A lease that is still in hand is delivered exactly as before. */
  const heldSends = [];
  await processWebhookDeliveryBatch({
    store: {
      ...store,
      async claimWebhookDeliveries() { return [{ ...delivery, leaseUntil }]; }
    },
    masterSecret: 'm'.repeat(64),
    now: () => new Date('2026-07-23T10:00:30.000Z'),
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async request => { heldSends.push(request); return { statusCode: 204 }; }
  });
  assert.strictEqual(heldSends.length, 1, 'a live lease still delivers');

  /* A claim that carries no lease at all is delivered rather than skipped:
     absence of a lease is not evidence that someone else holds one. */
  const unleasedSends = [];
  await processWebhookDeliveryBatch({
    store: { ...store, async claimWebhookDeliveries() { return [{ ...delivery, leaseUntil: null }]; } },
    masterSecret: 'm'.repeat(64),
    now: () => new Date('2026-07-23T10:01:00.000Z'),
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async request => { unleasedSends.push(request); return { statusCode: 204 }; }
  });
  assert.strictEqual(unleasedSends.length, 1, 'a delivery with no lease recorded is still delivered');

  /*
   * stop() has to be waitable. Clearing the interval only stops the next
   * batch; shutdown then closes the pool underneath the one already running,
   * and a delivery caught that way has already sent its request and can no
   * longer record the attempt -- so its row stays leased and the receiver is
   * sent the same event again once it expires.
   */
  {
    let settled = false;
    let releaseBatch;
    const held = new Promise(resolve => { releaseBatch = resolve; });
    const worker = startWebhookWorker({
      store: {
        ...store,
        async claimWebhookDeliveries() { return [{ ...delivery, leaseUntil: null }]; },
        async recordWebhookDeliveryAttempt(input) { await held; settled = true; return { status: 'delivered' }; }
      },
      masterSecret: 'm'.repeat(64),
      now: () => new Date('2026-07-23T10:00:30.000Z'),
      resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({ statusCode: 204 })
    });

    const drained = worker.stop();
    assert.strictEqual(typeof drained.then, 'function', 'stop must return something a shutdown can wait on');
    assert.strictEqual(settled, false, 'the batch is still in flight when stop returns');
    releaseBatch();
    await drained;
    assert.strictEqual(settled, true, 'awaiting stop must wait for the batch already running');

    /* And nothing new starts after it. */
    let startedAfterStop = 0;
    const quiet = startWebhookWorker({
      store: {
        ...store,
        async claimWebhookDeliveries() { startedAfterStop += 1; return []; }
      },
      masterSecret: 'm'.repeat(64),
      resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({ statusCode: 204 })
    });
    await quiet.stop();
    const before = startedAfterStop;
    await quiet.run();
    assert.strictEqual(startedAfterStop, before, 'a stopped worker must not begin another batch');
  }

  /*
   * And the translation is exercised, not just tabulated. A destination whose
   * answers include a private address is refused by the transport before a
   * socket exists, and this file has to record it as its own SSRF code -- the
   * one the batch treats as terminal. The batch path normalizes destinations
   * first and would catch this earlier; that is the point of checking the
   * transport's own refusal here, because it is the line that still holds if
   * a caller ever assembles a destination another way.
   */
  {
    let opened = 0;
    await assert.rejects(
      sendPinnedHttpsWebhook({
        destination: {
          url: 'https://hooks.example.com/nebulaverse',
          addresses: [{ address: '140.82.121.6', family: 4 }, { address: '169.254.169.254', family: 4 }]
        },
        body: '{}',
        headers: { 'X-Nebulaverse-Signature': 'v1=deadbeef' },
        requestImpl: () => { opened += 1; throw new Error('must not be called'); }
      }),
      error => error.code === 'WEBHOOK_SSRF_BLOCKED',
      'a private answer must be refused in this file\'s vocabulary, which the batch reads as terminal'
    );
    assert.strictEqual(opened, 0, 'and refused before any connection is attempted');
  }

  console.log('governance webhook worker tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
