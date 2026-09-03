'use strict';

const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const {
  GovernanceDeliveryError,
  normalizeWebhookDestination,
  deriveWebhookSigningSecret,
  signWebhookPayload
} = require('./governance-delivery');
const { stableJson } = require('./governance-model');

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

function hashText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function requireStore(store) {
  const methods = ['claimWebhookDeliveries', 'getGovernanceEvent', 'recordWebhookDeliveryAttempt'];
  if (!store || methods.some(method => typeof store[method] !== 'function')) {
    throw new TypeError('Webhook worker requires a complete governance delivery store');
  }
  return store;
}

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Webhook worker clock is invalid');
  return date;
}

function errorCodeOf(error) {
  const source = String(error && error.code || '').trim().toUpperCase();
  if (/^[A-Z][A-Z0-9_]{2,99}$/.test(source)) return source;
  return 'WEBHOOK_TRANSPORT_ERROR';
}

function permanentStatus(statusCode) {
  if (statusCode >= 300 && statusCode < 400) return true;
  return statusCode >= 400 && statusCode < 500 && ![408, 425, 429].includes(statusCode);
}

function sendPinnedHttpsWebhook(input = {}) {
  const body = String(input.body || '');
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    const error = new Error('Webhook body exceeds the delivery limit');
    error.code = 'WEBHOOK_BODY_TOO_LARGE';
    return Promise.reject(error);
  }
  const destination = input.destination;
  if (!destination || !Array.isArray(destination.addresses) || !destination.addresses.length) {
    const error = new Error('Webhook destination is unresolved');
    error.code = 'WEBHOOK_DNS_INVALID';
    return Promise.reject(error);
  }
  const parsed = new URL(destination.url);
  const selected = destination.addresses[0];
  const requestImpl = typeof input.requestImpl === 'function' ? input.requestImpl : https.request;
  const timeoutMs = Number.isInteger(input.timeoutMs) ? Math.min(Math.max(input.timeoutMs, 1000), 30_000) : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = requestImpl({
      protocol: 'https:',
      hostname: parsed.hostname,
      port: 443,
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      method: 'POST',
      headers: input.headers,
      servername: parsed.hostname,
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      timeout: timeoutMs,
      agent: false
    }, response => {
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > 64 * 1024) response.destroy();
      });
      response.on('end', () => finish(resolve, { statusCode: Number(response.statusCode || 0) }));
      response.on('error', error => finish(reject, error));
      response.resume();
    });
    request.on('timeout', () => {
      const error = new Error('Webhook request timed out');
      error.code = 'WEBHOOK_TIMEOUT';
      request.destroy(error);
    });
    request.on('error', error => finish(reject, error));
    request.end(body);
  });
}

async function processWebhookDeliveryBatch(options = {}) {
  const store = requireStore(options.store);
  if (Buffer.byteLength(String(options.masterSecret || ''), 'utf8') < 32) {
    throw new TypeError('Webhook worker master secret is invalid');
  }
  const resolveAddresses = typeof options.resolveAddresses === 'function'
    ? options.resolveAddresses
    : async hostname => dns.promises.lookup(hostname, { all: true, verbatim: true });
  const transport = typeof options.transport === 'function' ? options.transport : sendPinnedHttpsWebhook;
  const claimed = await store.claimWebhookDeliveries({ limit: options.limit || 10, leaseSeconds: options.leaseSeconds || 60 });
  const summary = { claimed: claimed.length, delivered: 0, retrying: 0, deadLettered: 0 };

  for (const delivery of claimed) {
    const requestTime = nowDate(options.now);
    let eventHash = '0'.repeat(64);
    let signatureHash = '0'.repeat(64);
    let statusCode = null;
    let delivered = false;
    let terminal = false;
    let errorCode = null;
    try {
      const event = await store.getGovernanceEvent({ scope: delivery.scope, eventSeq: delivery.eventSeq });
      eventHash = event.eventHash;
      const body = stableJson(event);
      if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
        const error = new Error('Webhook body exceeds the delivery limit');
        error.code = 'WEBHOOK_BODY_TOO_LARGE';
        throw error;
      }
      const parsed = new URL(delivery.url);
      const addresses = await resolveAddresses(parsed.hostname);
      const destination = normalizeWebhookDestination(delivery.url, addresses);
      const signingSecret = deriveWebhookSigningSecret(
        options.masterSecret,
        delivery.scope.scopeKey,
        delivery.webhookId,
        delivery.secretSalt,
        delivery.secretVersion
      );
      const timestamp = requestTime.toISOString();
      const signature = signWebhookPayload(signingSecret, delivery.deliveryId, timestamp, body);
      signatureHash = hashText(signature);
      const headers = {
        'Content-Type': 'application/vnd.nebulaverse.governance-event+json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'User-Agent': 'Nebulaverse-X-Governance-Webhook/1.0',
        'X-Nebulaverse-Delivery': delivery.deliveryId,
        'X-Nebulaverse-Event': event.type,
        'X-Nebulaverse-Event-Hash': event.eventHash,
        'X-Nebulaverse-Timestamp': timestamp,
        'X-Nebulaverse-Signature': signature,
        'Idempotency-Key': delivery.deliveryId
      };
      const response = await transport({ destination, body, headers, signingSecret, timeoutMs: options.timeoutMs });
      statusCode = Number(response && response.statusCode || 0);
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
        const error = new Error('Webhook transport returned an invalid status');
        error.code = 'WEBHOOK_STATUS_INVALID';
        throw error;
      }
      delivered = statusCode >= 200 && statusCode < 300;
      terminal = !delivered && permanentStatus(statusCode);
      if (!delivered) errorCode = `WEBHOOK_HTTP_${statusCode}`;
    } catch (error) {
      errorCode = errorCode || errorCodeOf(error);
      terminal = terminal || error instanceof GovernanceDeliveryError && error.code === 'GOVERNANCE_WEBHOOK_SSRF_BLOCKED';
    }

    const state = await store.recordWebhookDeliveryAttempt({
      deliveryId: delivery.deliveryId,
      eventHash,
      requestTimestamp: requestTime.toISOString(),
      signatureHash,
      delivered,
      terminal,
      statusCode,
      errorCode
    });
    if (state.status === 'delivered') summary.delivered += 1;
    else if (state.status === 'dead-letter') summary.deadLettered += 1;
    else summary.retrying += 1;
  }
  return summary;
}

function startWebhookWorker(options = {}) {
  const intervalMs = Number.isInteger(options.intervalMs) ? Math.min(Math.max(options.intervalMs, 10_000), 15 * 60_000) : 30_000;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processWebhookDeliveryBatch(options);
    } catch (error) {
      if (typeof options.onError === 'function') options.onError(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  void run();
  return Object.freeze({ stop: () => clearInterval(timer), run });
}

module.exports = Object.freeze({
  MAX_WEBHOOK_BODY_BYTES,
  sendPinnedHttpsWebhook,
  processWebhookDeliveryBatch,
  startWebhookWorker
});
