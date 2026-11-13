/*
 * Per-session rate limit: 300 API requests a minute.
 *
 * The caller's bucket is named by the server's identity function, from the
 * unsealed session rather than the cookie as it arrived (see
 * platform/rate-limit/rate-limit-identity.ts), so a caller cannot mint bucket
 * identities.
 *
 * Two limiters, and the local one exists to protect the shared one.
 *
 * The shared counter is what makes a limit of three hundred mean three
 * hundred rather than three hundred per instance. But consulting it is a
 * query, and a limiter that queries once per request hands an attacker a way
 * to turn a flood of cheap HTTP into a flood of database work -- against a
 * pool of three connections on a free plan. The in-process bucket in front of
 * it is what stops that: once the shared counter has refused a caller, this
 * process remembers until their window closes and refuses them again without
 * asking anything. A caller being throttled therefore costs no queries at all,
 * which is exactly the caller sending the most requests.
 *
 * An absolute local ceiling sits above that as a backstop for the case the
 * shared counter never refuses because it cannot answer.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const API_RATE_WINDOW_MS = 60000;
export const API_RATE_LIMIT = 300;
export const LOCAL_ADMISSION_CEILING = API_RATE_LIMIT + 30;
/* The local buckets kept at most, and the age past which one is swept first. */
const MAX_BUCKETS = 5000;
const STALE_BUCKET_MS = 120000;

/* The shared counter: `RateLimitStore.count` in a deployment with a database. */
export interface RateCounter {
  count(request: {
    readonly namespace: string;
    readonly key: string;
    readonly windowMs: number;
    readonly limit: number;
    readonly inclusiveReset: boolean;
  }): Promise<{ readonly allowed: boolean }>;
}

interface Bucket {
  t: number;
  n: number;
  refusedUntil: number;
}

export interface RateAdmissionOptions {
  /* The caller's bucket key. */
  readonly identify: (req: Request) => string;
  /* The shared counter, or null where this process is the only counter there is. */
  readonly counter: () => RateCounter | null;
  readonly now?: () => number;
}

export function apiRateAdmission({ identify, counter, now: clock = Date.now }: RateAdmissionOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return function apiRateAdmissionStep(req: Request, res: Response, next: NextFunction): void {
    const key = identify(req);
    const now = clock();
    let b = buckets.get(key);
    if (!b || now - b.t > API_RATE_WINDOW_MS) { b = { t: now, n: 0, refusedUntil: 0 }; buckets.set(key, b); }
    b.n += 1;
    if (buckets.size > MAX_BUCKETS) {
      for (const [bucketKey, value] of buckets) {
        if (now - value.t > STALE_BUCKET_MS) buckets.delete(bucketKey);
      }
      for (const oldest of buckets.keys()) {
        if (buckets.size <= MAX_BUCKETS) break;
        buckets.delete(oldest);
      }
    }

    /* Already refused inside this window: answer from memory, ask nothing. */
    if (b.refusedUntil > now) {
      res.status(429).json({ error: 'Rate limit: slow down a little' });
      return;
    }
    if (b.n > LOCAL_ADMISSION_CEILING) {
      b.refusedUntil = b.t + API_RATE_WINDOW_MS;
      res.status(429).json({ error: 'Rate limit: slow down a little' });
      return;
    }

    const store = counter();
    /* Without a database this process is the only counter there is, and the
       local bucket is the limit rather than an admission filter in front of it. */
    if (!store) {
      if (b.n > API_RATE_LIMIT) {
        res.status(429).json({ error: 'Rate limit: slow down a little' });
        return;
      }
      return next();
    }

    const bucket = b;
    store.count({
      namespace: 'api', key, windowMs: API_RATE_WINDOW_MS, limit: API_RATE_LIMIT,
      /* The window this limiter has always kept: it reopens once MORE than
         sixty seconds have passed, which is not the webhook limiter's rule. */
      inclusiveReset: false
    }).then(verdict => {
      if (verdict.allowed) return next();
      bucket.refusedUntil = bucket.t + API_RATE_WINDOW_MS;
      res.status(429).json({ error: 'Rate limit: slow down a little' });
    }).catch(() => {
      /* A counter that cannot answer has not said this caller is within their
         limit, and a local count would answer "well within" on every instance
         that has not seen them. Refuse, and say it is the limiter that is
         unavailable rather than the caller who is over. */
      res.status(503).json({
        error: 'Request limits cannot be checked right now; retry shortly',
        code: 'RATE_LIMIT_UNAVAILABLE'
      });
    });
  };
}
