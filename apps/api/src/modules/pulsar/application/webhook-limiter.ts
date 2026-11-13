/*
 * How many webhook deliveries one sender may make to one hook: 120 a minute.
 *
 * The same two-layer shape as the API limiter, and the same reason for it: the
 * shared counter makes a hundred and twenty mean a hundred and twenty rather
 * than that many per instance, and the local bucket in front of it means a
 * sender being throttled costs no queries.
 *
 * This limiter keys on the address and the hook rather than on a session --
 * a provider delivering a webhook has no session -- so the identity is already
 * unforgeable behind trust proxy and needs no derivation.
 *
 * Its window rule is not the API limiter's. This one reopens once sixty
 * seconds have passed; that one reopens once MORE than sixty seconds have.
 * The difference is one millisecond a minute and exists only because both were
 * written by hand, but preserving each is cheaper than explaining an
 * unreproducible 429 to whoever hits the boundary.
 */

export const WEBHOOK_RATE_WINDOW_MS = 60000;
export const WEBHOOK_RATE_LIMIT = 120;
/* The local bucket refuses outright past the limit and thirty more. */
const LOCAL_EXCESS = 30;
/* Past this many buckets, those two windows old are swept. */
const BUCKET_SWEEP_SIZE = 2000;
const BUCKET_STALE_MS = 120000;

export interface WebhookCounter {
  count(request: { namespace: string; key: string; windowMs: number; limit: number; inclusiveReset: boolean }): Promise<{ readonly allowed: boolean }>;
}

export interface WebhookLimiterDeps {
  /* The shared counter, or null where this process is the only counter there is. */
  readonly counter: () => WebhookCounter | null;
  readonly now?: () => number;
}

interface Bucket { startedAt: number; count: number; refusedUntil: number }

export function createWebhookLimiter(deps: WebhookLimiterDeps) {
  const now = deps.now || (() => Date.now());
  const buckets = new Map<string, Bucket>();

  async function allowWebhookRequest(req: { readonly ip?: unknown }, hookId: string): Promise<boolean> {
    const at = now();
    const key = `${String(req.ip || 'unknown').slice(0, 80)}|${hookId}`;
    let bucket = buckets.get(key);
    if (!bucket || at - bucket.startedAt >= WEBHOOK_RATE_WINDOW_MS) bucket = { startedAt: at, count: 0, refusedUntil: 0 };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > BUCKET_SWEEP_SIZE) {
      for (const [k, value] of buckets) if (at - value.startedAt >= BUCKET_STALE_MS) buckets.delete(k);
    }

    if (bucket.refusedUntil > at) return false;
    if (bucket.count > WEBHOOK_RATE_LIMIT + LOCAL_EXCESS) {
      bucket.refusedUntil = bucket.startedAt + WEBHOOK_RATE_WINDOW_MS;
      return false;
    }

    const store = deps.counter();
    if (!store) return bucket.count <= WEBHOOK_RATE_LIMIT;

    let verdict;
    try {
      verdict = await store.count({
        namespace: 'webhook', key, windowMs: WEBHOOK_RATE_WINDOW_MS, limit: WEBHOOK_RATE_LIMIT,
        inclusiveReset: true
      });
    } catch {
      /* Unanswerable is not permission. The caller turns a false into a 429,
         which is the safe reading for a sender that can retry. */
      return false;
    }
    if (!verdict.allowed) bucket.refusedUntil = bucket.startedAt + WEBHOOK_RATE_WINDOW_MS;
    return verdict.allowed;
  }

  /* How many senders it is tracking: the sweep keeps this bounded. */
  const tracked = (): number => buckets.size;

  return { allowWebhookRequest, tracked };
}

export type WebhookLimiter = ReturnType<typeof createWebhookLimiter>;
