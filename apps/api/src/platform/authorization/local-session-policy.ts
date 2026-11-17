import { randomBytes } from 'node:crypto';

export const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* The lifetime a database-free session carries in its sealed cookie. */
export interface SessionLifetime {
  readonly id: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface LocalSessionPolicy {
  valid(data: unknown): boolean;
  prepare<T extends object>(data: T): T & { readonly lifetime: SessionLifetime };
  revoke(data: unknown): void;
}

function lifetimeOf(data: unknown): Partial<SessionLifetime> | null {
  const lifetime = data && typeof data === 'object' ? (data as { readonly lifetime?: unknown }).lifetime : undefined;
  return lifetime && typeof lifetime === 'object' ? lifetime as Partial<SessionLifetime> : null;
}

// Database-free sessions are a single-process profile. Starting a new process
// invalidates its predecessor's cookies, including any revoked by that process.
// Keep revocations until absolute expiry; never evict a live revocation to admit
// another, since that would silently make a logged-out cookie usable again.
export function createLocalSessionPolicy({ now = Date.now, maxRevocations = 10000 }: { readonly now?: () => number; readonly maxRevocations?: number } = {}): LocalSessionPolicy {
  const startedAt = now();
  const revoked = new Map<string, number>();
  function valid(data: unknown): boolean {
    const lifetime = lifetimeOf(data);
    const time = now();
    return Boolean(lifetime && /^[0-9a-f]{48}$/.test(lifetime.id || '')
      && Number.isSafeInteger(lifetime.issuedAt) && Number.isSafeInteger(lifetime.expiresAt)
      && (lifetime.issuedAt as number) >= startedAt && (lifetime.issuedAt as number) <= time
      && (lifetime.expiresAt as number) > time && (lifetime.expiresAt as number) - (lifetime.issuedAt as number) <= ABSOLUTE_TTL_MS
      && !revoked.has(lifetime.id as string));
  }
  function prepare<T extends object>(data: T): T & { readonly lifetime: SessionLifetime } {
    if ((data as { readonly lifetime?: unknown }).lifetime) {
      if (!valid(data)) throw Object.assign(new Error('Session expired; sign in again'), { status: 401 });
      return data as T & { readonly lifetime: SessionLifetime };
    }
    const issuedAt = now();
    return { ...data, lifetime: { id: randomBytes(24).toString('hex'),
      issuedAt, expiresAt: issuedAt + ABSOLUTE_TTL_MS } };
  }
  function revoke(data: unknown): void {
    if (!valid(data)) return;
    const lifetime = lifetimeOf(data) as SessionLifetime;
    const time = now();
    for (const [id, expiresAt] of revoked) if (expiresAt <= time) revoked.delete(id);
    if (revoked.size >= maxRevocations) {
      throw Object.assign(new Error('Session revocation is unavailable; sign-out was not completed'), {
        status: 503, code: 'SESSION_REVOCATION_UNAVAILABLE'
      });
    }
    revoked.set(lifetime.id, lifetime.expiresAt);
  }
  return Object.freeze({ valid, prepare, revoke });
}
