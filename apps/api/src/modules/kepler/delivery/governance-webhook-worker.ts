import { createHash } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import type { OutgoingHttpHeaders } from 'node:http';
import {
  GovernanceDeliveryError,
  normalizeWebhookDestination,
  deriveWebhookSigningSecret,
  signWebhookPayload
} from './governance-delivery.ts';
import type { GovernanceEvent, WebhookDestination } from './governance-delivery.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import { PROFILES, CODES as GUARDED_FETCH_CODES, GuardedFetchError, guardedFetch } from '../../../platform/network/guarded-fetch.ts';
import type { GuardedResponse, RequestImpl } from '../../../platform/network/guarded-fetch.ts';

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function hashText(value: unknown): string {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/* A delivery failure the attempt record names by code. */
function webhookFailure(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/* A delivery the store leased to this worker, as the store describes it. */
export interface ClaimedDelivery {
  readonly deliveryId: string;
  readonly webhookId: unknown;
  readonly url: string;
  readonly scope: { readonly scopeKey: string };
  readonly eventSeq: unknown;
  readonly secretSalt: unknown;
  readonly secretVersion: unknown;
  readonly leaseUntil?: unknown;
}

/* A plain record of named fields, so the store's reader of fields takes it as it is. */
export type DeliveryAttempt = {
  readonly deliveryId: string;
  readonly eventHash: string;
  readonly requestTimestamp: string;
  readonly signatureHash: string;
  readonly delivered: boolean;
  readonly terminal: boolean;
  readonly statusCode: number | null;
  readonly errorCode: string | null;
};

export interface WebhookDeliveryStore {
  claimWebhookDeliveries(input: { readonly limit: number; readonly leaseSeconds: number }): Promise<readonly ClaimedDelivery[]>;
  getGovernanceEvent(input: { readonly scope: ClaimedDelivery['scope']; readonly eventSeq: unknown }): Promise<GovernanceEvent>;
  recordWebhookDeliveryAttempt(input: DeliveryAttempt): Promise<{ readonly status: string }>;
}

const DELIVERY_STORE_METHODS = ['claimWebhookDeliveries', 'getGovernanceEvent', 'recordWebhookDeliveryAttempt'] as const;

/* The compiler checks a typed caller's store where it is passed; one from untyped code is still refused unless each method the worker calls is there. */
function requireStore(store: WebhookDeliveryStore | null | undefined): WebhookDeliveryStore {
  if (!store || DELIVERY_STORE_METHODS.some(method => typeof store[method] !== 'function')) {
    throw new TypeError('Webhook worker requires a complete governance delivery store');
  }
  return store;
}

export type WorkerClock = () => Date | number | string;

function nowDate(now: WorkerClock | undefined): Date {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Webhook worker clock is invalid');
  return date;
}

function errorCodeOf(error: unknown): string {
  const source = String(error && (error as { readonly code?: unknown }).code || '').trim().toUpperCase();
  if (/^[A-Z][A-Z0-9_]{2,99}$/.test(source)) return source;
  return 'WEBHOOK_TRANSPORT_ERROR';
}

function permanentStatus(statusCode: number): boolean {
  if (statusCode >= 300 && statusCode < 400) return true;
  return statusCode >= 400 && statusCode < 500 && ![408, 425, 429].includes(statusCode);
}

/*
 * The webhook's entry point, now a thin caller of the one outbound path in
 * apps/api/src/platform/network/guarded-fetch.ts rather than a second implementation of it.
 *
 * Two things are preserved deliberately. The destination's addresses are
 * handed over rather than resolved again -- a second lookup is a second chance
 * for the name to answer differently, which is the window pinning closes --
 * and the error vocabulary stays the webhook's own, because those codes are
 * recorded on delivery attempts and read by whoever is looking at why a
 * delivery failed.
 */
/*
 * The transport speaks its own codes; a delivery attempt records this file's.
 * The table is total rather than defaulted: every code the transport can
 * raise has a line here, which its type now requires and the test asserts
 * against the transport's own registry. A `||` fallback would have absorbed a
 * missing line, and the cost of that is not cosmetic -- `terminal` is decided
 * from the recorded code, so a permanent fault translated as a generic
 * transport error is retried until the attempt ceiling instead of being
 * dead-lettered once.
 *
 * WEBHOOK_TRANSPORT_ERROR is deliberate for the three that can only mean a
 * mistake in this repository rather than anything about the destination: an
 * invalid profile, an invalid method, or a bare refusal carries no advice an
 * operator could act on, and inventing a code per internal slip would grow
 * the vocabulary operators read without telling them anything.
 */
type GuardedFetchCode = (typeof GUARDED_FETCH_CODES)[keyof typeof GUARDED_FETCH_CODES];
export const GUARDED_TO_WEBHOOK_CODE: Readonly<Record<GuardedFetchCode, string>> = Object.freeze({
  [GUARDED_FETCH_CODES.BODY_TOO_LARGE]: 'WEBHOOK_BODY_TOO_LARGE',
  [GUARDED_FETCH_CODES.DEADLINE]: 'WEBHOOK_TIMEOUT',
  [GUARDED_FETCH_CODES.DNS_INVALID]: 'WEBHOOK_DNS_INVALID',
  [GUARDED_FETCH_CODES.ENCODING_REFUSED]: 'WEBHOOK_ENCODING_REFUSED',
  [GUARDED_FETCH_CODES.METHOD_INVALID]: 'WEBHOOK_TRANSPORT_ERROR',
  [GUARDED_FETCH_CODES.PROFILE_INVALID]: 'WEBHOOK_TRANSPORT_ERROR',
  [GUARDED_FETCH_CODES.REFUSED]: 'WEBHOOK_TRANSPORT_ERROR',
  [GUARDED_FETCH_CODES.RESPONSE_TOO_LARGE]: 'WEBHOOK_RESPONSE_TOO_LARGE',
  [GUARDED_FETCH_CODES.SSRF_BLOCKED]: 'WEBHOOK_SSRF_BLOCKED',
  [GUARDED_FETCH_CODES.TIMEOUT]: 'WEBHOOK_TIMEOUT',
  [GUARDED_FETCH_CODES.TRANSPORT_FAILED]: 'WEBHOOK_TRANSPORT_ERROR',
  [GUARDED_FETCH_CODES.URL_INVALID]: 'WEBHOOK_URL_INVALID'
});
const WEBHOOK_CODE_BY_GUARDED: Readonly<Record<string, string>> = GUARDED_TO_WEBHOOK_CODE;

export interface WebhookRequest {
  readonly destination?: WebhookDestination | null;
  readonly body?: unknown;
  readonly headers?: OutgoingHttpHeaders;
  readonly signingSecret?: string;
  readonly timeoutMs?: number;
  readonly requestImpl?: RequestImpl;
}

export async function sendPinnedHttpsWebhook(input: WebhookRequest = {}): Promise<GuardedResponse> {
  const destination = input.destination;
  if (!destination || !Array.isArray(destination.addresses) || !destination.addresses.length) {
    throw webhookFailure('Webhook destination is unresolved', 'WEBHOOK_DNS_INVALID');
  }
  const body = String(input.body || '');
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    throw webhookFailure('Webhook body exceeds the delivery limit', 'WEBHOOK_BODY_TOO_LARGE');
  }
  try {
    return await guardedFetch({
      url: destination.url,
      profile: PROFILES.WEBHOOK,
      method: 'POST',
      headers: input.headers,
      body,
      addresses: destination.addresses,
      timeoutMs: input.timeoutMs,
      requestImpl: input.requestImpl
    });
  } catch (error) {
    if (error instanceof GuardedFetchError) {
      /* Own keys only: an inherited name is not one of the transport's codes. */
      const code = Object.hasOwn(WEBHOOK_CODE_BY_GUARDED, error.code) ? WEBHOOK_CODE_BY_GUARDED[error.code] : undefined;
      const translated = webhookFailure('Webhook delivery failed', code || 'WEBHOOK_TRANSPORT_ERROR');
      if (error.transportCode) Object.assign(translated, { transportCode: error.transportCode });
      throw translated;
    }
    throw error;
  }
}

export type WebhookTransport = (request: WebhookRequest & { readonly destination: WebhookDestination; readonly body: string; readonly headers: OutgoingHttpHeaders; readonly signingSecret: string }) => Promise<unknown>;

export interface WebhookWorkerOptions {
  readonly store?: WebhookDeliveryStore | null;
  readonly masterSecret?: unknown;
  readonly resolveAddresses?: (hostname: string) => Promise<unknown>;
  readonly transport?: WebhookTransport;
  readonly limit?: number;
  readonly leaseSeconds?: number;
  readonly now?: WorkerClock;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface BatchSummary {
  claimed: number;
  delivered: number;
  retrying: number;
  deadLettered: number;
  released: number;
}

export async function processWebhookDeliveryBatch(options: WebhookWorkerOptions = {}): Promise<BatchSummary> {
  const store = requireStore(options.store);
  if (Buffer.byteLength(String(options.masterSecret || ''), 'utf8') < 32) {
    throw new TypeError('Webhook worker master secret is invalid');
  }
  const resolveAddresses = typeof options.resolveAddresses === 'function'
    ? options.resolveAddresses
    : async (hostname: string) => dnsPromises.lookup(hostname, { all: true, verbatim: true });
  const transport: WebhookTransport = typeof options.transport === 'function' ? options.transport : sendPinnedHttpsWebhook;
  const claimed = await store.claimWebhookDeliveries({ limit: options.limit || 10, leaseSeconds: options.leaseSeconds || 60 });
  const summary: BatchSummary = { claimed: claimed.length, delivered: 0, retrying: 0, deadLettered: 0, released: 0 };

  for (const delivery of claimed) {
    const requestTime = nowDate(options.now);
    /*
     * The batch is claimed all at once under one lease and delivered one at a
     * time. Ten rows at a ten-second transport timeout apiece against a
     * sixty-second lease is arithmetic that does not close, and the rows at
     * the back are the ones it fails for.
     *
     * A row whose lease has passed is reclaimable by any other worker --
     * claimWebhookDeliveries takes rows still marked 'delivering' whose
     * lease_until has gone by -- so sending it here would deliver it twice:
     * once from whoever reclaimed it and once from a batch still working
     * through a lease it no longer holds. Database fencing cannot retract an
     * HTTP request that has already left, so the only place to stop that is
     * before the send.
     *
     * The comparison is `<=` because that is exactly what the reclaim query
     * uses. A boundary the two disagree about is a row that one of them thinks
     * is free while the other is still sending it.
     *
     * Nothing has to be written to put the row down. Its lease has expired,
     * which is already the state that makes it available; leaving it is the
     * release.
     */
    const leaseUntil = delivery.leaseUntil ? new Date(delivery.leaseUntil as string | number | Date) : null;
    if (leaseUntil && Number.isFinite(leaseUntil.getTime()) && leaseUntil.getTime() <= requestTime.getTime()) {
      summary.released += 1;
      continue;
    }
    let eventHash = '0'.repeat(64);
    let signatureHash = '0'.repeat(64);
    let statusCode: number | null = null;
    let delivered = false;
    let terminal = false;
    let errorCode: string | null = null;
    try {
      const event = await store.getGovernanceEvent({ scope: delivery.scope, eventSeq: delivery.eventSeq });
      eventHash = event.eventHash;
      const body = stableJson(event);
      if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
        throw webhookFailure('Webhook body exceeds the delivery limit', 'WEBHOOK_BODY_TOO_LARGE');
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
      statusCode = Number(response && (response as { readonly statusCode?: unknown }).statusCode || 0);
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
        throw webhookFailure('Webhook transport returned an invalid status', 'WEBHOOK_STATUS_INVALID');
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

export interface WebhookWorker {
  readonly stop: () => Promise<void>;
  readonly run: () => Promise<void>;
}

export function startWebhookWorker(options: WebhookWorkerOptions = {}): WebhookWorker {
  const requested = options.intervalMs;
  const intervalMs = typeof requested === 'number' && Number.isInteger(requested) ? Math.min(Math.max(requested, 10_000), 15 * 60_000) : 30_000;
  let running = false;
  let stopped = false;
  /*
   * Held so stop() can be waited on. Clearing the interval only stops the next
   * batch; the one already running keeps going, and shutdown closes the pool
   * underneath it. A delivery caught that way has already sent its request and
   * can no longer record the attempt, so its row stays 'delivering' until the
   * lease expires and the receiver is sent the same event again -- a duplicate
   * on every restart that lands mid-batch.
   */
  let inFlight: Promise<void> = Promise.resolve();
  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    inFlight = (async () => {
      try {
        await processWebhookDeliveryBatch(options);
      } catch (error) {
        if (typeof options.onError === 'function') options.onError(error);
      } finally {
        running = false;
      }
    })();
    await inFlight;
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  void run();
  /*
   * stop() returns that promise rather than nothing, so a caller who can wait
   * does, and one who cannot behaves exactly as before.
   */
  return Object.freeze({
    stop: () => { stopped = true; clearInterval(timer); return inFlight; },
    run
  });
}
