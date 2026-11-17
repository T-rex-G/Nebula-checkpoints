/*
 * The provider session: the accounts a person has signed in with, and where
 * that is kept between requests.
 *
 * Three places, by deployment. With a database, the cookie carries only a
 * session id and the session is a row in nv_sessions, sealed. In the hosted
 * alpha the row is the privacy store's, owned by the tester whose alpha
 * session made it, and written through the store so that two requests writing
 * at once merge rather than overwrite (../domain/hosted-session-merge.ts).
 * Without a database the cookie carries the session itself, bounded by the
 * local session policy.
 *
 * A store that cannot answer is unavailable, never empty: read as "no
 * session", a fault let a sign-in delete the row it could not read. A session
 * that has ended reads as none, and a write to one is refused.
 */
import { randomBytes } from 'node:crypto';
import type { Fields } from '../../../platform/values/fields.ts';
import { githubSession, holdsAccounts, identityKey, persistedSession, type AccountLike, type SessionAccounts } from '../domain/account-identity.ts';
import { recomputeHostedSessionMutation, type HostedSession } from '../domain/hosted-session-merge.ts';

/* The session the request read in the hosted alpha, and the store's revision of it, kept on the request for its write. */
export const HOSTED_SESSION_BASE = Symbol('hosted provider session base');
export const HOSTED_SESSION_REVISION = Symbol('hosted provider session revision');

type Session = SessionAccounts & HostedSession;
/* A provider session sessionOf answers: one it found holding a list of accounts. */
export type SignedInSession = Session & { accounts: Fields[] };
/* The response a session is written to: its cookie is set on it. */
export interface SessionResponse { setHeader(name: string, value: string): unknown }

interface SessionRequest {
  readonly headers: { readonly cookie?: string | undefined };
  alpha?: { readonly testerId?: string } | null;
  session?: unknown;
  [HOSTED_SESSION_BASE]?: unknown;
  [HOSTED_SESSION_REVISION]?: unknown;
}

interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number | null }>;
}

interface OwnedSession {
  readonly session: Session;
  readonly revision: unknown;
}

export interface ProviderSessionDeps {
  /* Whether the deployment keeps sessions in a database; fixed at startup. */
  readonly databaseConfigured: boolean;
  readonly ready: () => Promise<boolean>;
  readonly pool: () => Queryable;
  readonly config: { readonly enabled: boolean };
  readonly privacyStore: {
    readHostedProviderSession(input: { testerId: string; sessionId: string }): Promise<OwnedSession>;
    mutateHostedProviderSession(input: { testerId: string; sessionId: string; mutate(current: Session): Session }): Promise<OwnedSession>;
  } | null;
  readonly seal: (value: unknown) => string;
  readonly unseal: (text: string) => unknown;
  readonly readCookie: (req: SessionRequest, name: string) => string | null;
  readonly writeCookie: (res: SessionResponse, value: string, maxAge?: number) => void;
  readonly localSessionPolicy: {
    prepare(data: unknown): { readonly lifetime: { readonly expiresAt: number } };
    valid(session: unknown): boolean;
    revoke(session: unknown): void;
  };
  /* Ends the live streams a session holds open (Pulsar's live hub). */
  readonly closeLiveSessions: (sessionIds: string[], reason?: string) => unknown;
}

const failure = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);

/*
 * The store's refusals of an owned provider session, as answers rather than
 * server faults. An ended session is handled by the caller (it is no session);
 * these are the rest: a session another tester holds, and a tester whose
 * access is gone or whose data is being deleted.
 */
export function ownedSessionRefusal(error: unknown): unknown {
  const code = error && (error as { readonly code?: unknown }).code;
  if (code === 'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT') {
    return failure('This sign-in belongs to another alpha session', { status: 403, code });
  }
  if (code === 'ALPHA_TESTER_REVOKED' || code === 'ALPHA_TESTER_UNAVAILABLE') {
    return failure('Alpha access is required', { status: 401, code: 'ALPHA_ACCESS_REQUIRED' });
  }
  if (code === 'ALPHA_TESTER_DELETING') {
    return failure('Alpha data deletion is in progress', { status: 409, code });
  }
  return error;
}

/*
 * An account this alpha access disconnected keeps its cleanup evidence, and is
 * not bound to the access again. That is a refusal with a way forward, made
 * before anything was connected -- not a fault to retry.
 */
export function alphaConnectionRefusal(error: unknown): unknown {
  const code = error && (error as { readonly code?: unknown }).code;
  if (code === 'ALPHA_PROVIDER_LIFECYCLE_STARTED' || code === 'ALPHA_PROVIDER_BINDING_CONFLICT') {
    return failure('This GitHub account was disconnected from this alpha access and cannot be connected to it again.', {
      status: 409,
      code: 'ALPHA_PROVIDER_IDENTITY_RETIRED',
      providerChanged: false,
      safeState: 'Nothing was connected. The disconnected account stays disconnected.',
      nextAction: 'Sign in with another GitHub account, or end the alpha session and ask the operator for a new invitation to use this one.'
    });
  }
  if (code === 'ALPHA_PROVIDER_ACCOUNT_CAPACITY') {
    return failure('This session already holds the most accounts it can. Remove one first.', {
      status: 409, code, providerChanged: false, safeState: 'Nothing was connected.'
    });
  }
  return ownedSessionRefusal(error);
}

export function createProviderSessions(deps: ProviderSessionDeps) {
  const { databaseConfigured, config, seal, unseal, readCookie, writeCookie, localSessionPolicy } = deps;
  const cookieOf = (req: SessionRequest) => unseal(readCookie(req, 'nv_session') || '') as { sid?: unknown; [field: string]: unknown } | null;

  async function setSession(req: SessionRequest, res: SessionResponse, input: unknown, { createNew = false } = {}): Promise<void> {
    const data = persistedSession(input) as Session;
    if (databaseConfigured) {
      if (!(await deps.ready())) throw failure('Session database is temporarily unavailable', { status: 503 });
      let sid: string | null = null;
      const cur = cookieOf(req);
      if (!createNew && cur && cur.sid) sid = cur.sid as string;
      const existingSid = Boolean(sid);
      if (!sid) sid = randomBytes(24).toString('hex');
      if (config.enabled) {
        if (!req.alpha || !req.alpha.testerId || !cur || !cur.sid) {
          throw failure('Owned provider session is unavailable', {
            status: 401, code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
          });
        }
        const base = (req[HOSTED_SESSION_BASE] || structuredClone(data)) as Session;
        const result = await deps.privacyStore!.mutateHostedProviderSession({
          testerId: req.alpha.testerId,
          sessionId: sid,
          mutate(current) {
            return recomputeHostedSessionMutation(base, data, current);
          }
        }).catch((error: unknown) => {
          /* Ended between the read and this write: signed out, as on the read. */
          if (error && (error as { readonly code?: unknown }).code === 'ALPHA_PROVIDER_SESSION_UNAVAILABLE') throw Object.assign(error as object, { status: 401 });
          throw ownedSessionRefusal(error);
        });
        req.session = result.session;
        req[HOSTED_SESSION_BASE] = structuredClone(result.session);
        req[HOSTED_SESSION_REVISION] = result.revision;
        writeCookie(res, seal({ sid }));
        return;
      }
      const identityKeys = [...new Set((Array.isArray(data.accounts) ? data.accounts as AccountLike[] : []).map(identityKey))];
      if (existingSid) {
        const saved = await deps.pool().query(
          `UPDATE nv_sessions SET data=$2,identity_keys=$3::text[],revision=revision+1,updated=now() WHERE sid=$1`,
          [sid, seal(data), identityKeys]
        );
        if (!saved.rowCount) throw failure('This session ended. Sign in again.', { status: 401, code: 'SESSION_REVOKED' });
      } else {
        await deps.pool().query('INSERT INTO nv_sessions (sid,data,identity_keys,updated) VALUES ($1,$2,$3::text[],now())', [sid, seal(data), identityKeys]);
      }
      /*
       * The request carries what was written, as on the other two paths: a
       * route that reads its session after writing it -- the App's setup,
       * finding the account it just added -- reads the session as stored.
       */
      req.session = data;
      writeCookie(res, seal({ sid }));
      return;
    }
    const bounded = localSessionPolicy.prepare(data);
    // Retain the original lifetime through security/account session writes.
    req.session = bounded;
    writeCookie(res, seal(bounded), Math.max(0, Math.ceil((bounded.lifetime.expiresAt - Date.now()) / 1000)));
  }

  /* The session id the request's cookie carries, or ''. */
  function sessionIdFromRequest(req: SessionRequest): string {
    const current = cookieOf(req);
    return current && typeof current.sid === 'string' ? current.sid : '';
  }

  async function destroySession(req: SessionRequest, res: SessionResponse): Promise<void> {
    const sid = sessionIdFromRequest(req);
    if (sid && databaseConfigured) {
      if (!(await deps.ready())) throw failure('Session database is temporarily unavailable; sign-out was not completed', { status: 503 });
      await deps.pool().query('DELETE FROM nv_sessions WHERE sid=$1', [sid]);
    }
    if (!databaseConfigured) localSessionPolicy.revoke(cookieOf(req));
    if (sid) deps.closeLiveSessions([sid], 'session-ended');
    writeCookie(res, '', 0);
  }

  async function sessionOf(req: SessionRequest, { retainRetiredAccounts = false } = {}): Promise<SignedInSession | null> {
    const supported = (session: Session | null) => (retainRetiredAccounts && session && holdsAccounts(session) && session.accounts.length
      ? session
      : githubSession(session));
    const s = cookieOf(req);
    if (!s) return null;
    if (databaseConfigured && !s.sid) return null;
    if (s.sid) {
      if (!(await deps.ready())) throw failure('Session database is temporarily unavailable', { status: 503 });
      if (config.enabled) {
        if (!req.alpha || !req.alpha.testerId) {
          throw failure('Alpha access is required', { status: 401, code: 'ALPHA_ACCESS_REQUIRED' });
        }
        let owned: OwnedSession;
        try {
          owned = await deps.privacyStore!.readHostedProviderSession({
            testerId: req.alpha.testerId,
            sessionId: s.sid as string
          });
        } catch (error) {
          if (error && (error as { readonly code?: unknown }).code === 'ALPHA_PROVIDER_SESSION_UNAVAILABLE') return null;
          throw ownedSessionRefusal(error);
        }
        req[HOSTED_SESSION_BASE] = structuredClone(owned.session);
        req[HOSTED_SESSION_REVISION] = owned.revision;
        return supported(owned.session);
      }
      const r = await deps.pool().query('SELECT data FROM nv_sessions WHERE sid=$1', [s.sid]).catch(() => {
        throw failure('Session database is temporarily unavailable', { status: 503 });
      });
      if (!r.rows.length) return null;
      const d = unseal(r.rows[0]!.data as string) as Session | null;
      return (d && Array.isArray(d.accounts) && d.accounts.length) ? supported(d) : null;
    }
    if (!localSessionPolicy.valid(s)) return null;
    if (Array.isArray(s.accounts) && s.accounts.length) return supported(s as Session);
    return null;
  }

  return { setSession, sessionOf, destroySession, sessionIdFromRequest };
}

export type ProviderSessions = ReturnType<typeof createProviderSessions>;
