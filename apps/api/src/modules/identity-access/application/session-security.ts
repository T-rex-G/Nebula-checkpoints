/*
 * The session's own security: the nonce that binds its CSRF tokens and
 * step-up grants to it, the checks a request must pass with them, and the
 * scope its offline cache is keyed by.
 *
 * Both tokens are bound to the session's nonce and to the identity acting
 * (../../../platform/authorization/security-foundation.ts), so a token
 * minted in one session, or for one account, opens nothing in another. A
 * step-up grant is single-use. Which guard remembers it is decided by
 * configuration, never by whether the database happens to be reachable: a
 * deployment with a database has one shared guard, and if it cannot be
 * reached the claim fails and the sensitive action is refused. Falling back to
 * the in-process Map then would be the worst of both, since every instance
 * would answer "unspent" for a grant another had already spent, and a replay
 * would go through precisely during an outage. Without a database the Map is
 * honest: one process, and it covers everything that process can be replayed
 * against.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { CSRF_HEADER, STEP_UP_HEADER } from '../../../../../../packages/contracts/src/api-envelope.ts';
import * as OFFLINE_CACHE_POLICY from '../../../../../../packages/contracts/src/offline-cache-policy.ts';
import { consumePendingStepUp, verifyCsrfToken, verifyStepUpGrant } from '../../../platform/authorization/security-foundation.ts';
import { identityKey, type AccountLike } from '../domain/account-identity.ts';
import type { SessionResponse } from './provider-sessions.ts';

/* How long a CSRF token and a step-up grant are good for once minted. */
export const CSRF_TTL_MS = 30 * 60 * 1000;
export const STEP_UP_TTL_MS = 5 * 60 * 1000;

const SESSION_NONCE = /^[0-9a-f]{48}$/i;

interface SecuredSession {
  security?: { sessionNonce?: unknown; stepUp?: unknown; [field: string]: unknown } | unknown;
  [field: string]: unknown;
}

interface SecurityRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly originalUrl?: string;
  readonly url?: string;
  session?: SecuredSession;
  gh?: AccountLike & { readonly provider?: unknown };
  stepUp?: unknown;
}

type SecurityState = { sessionNonce?: unknown; stepUp?: unknown; [field: string]: unknown };

export interface SessionSecurityDeps {
  readonly databaseConfigured: boolean;
  /* The shared single-use guard, opened on first use; asked for only where a database is configured. */
  readonly durableSingleUseStore: () => unknown;
  readonly setSession: (req: never, res: SessionResponse, data: unknown) => Promise<void>;
  readonly csrfSecret: string;
  readonly stepUpSecret: string;
  /* The methods that change nothing, and so carry no CSRF token. */
  readonly safeMethods: ReadonlySet<string>;
  readonly offlineCacheScopeKey: Buffer;
  readonly sessionIdFromRequest: (req: never) => string;
}

export function createSessionSecurity(deps: SessionSecurityDeps) {
  const usedStepUpGrants = new Map();
  const setSession = deps.setSession as (req: SecurityRequest, res: SessionResponse, data: unknown) => Promise<void>;
  const sessionIdFromRequest = deps.sessionIdFromRequest as (req: SecurityRequest) => string;

  function stepUpReplayStore(): unknown {
    if (!deps.databaseConfigured) return usedStepUpGrants;
    return deps.durableSingleUseStore();
  }

  /* The session's security state, made if it has none. */
  function sessionSecurityState(session: SecuredSession): SecurityState {
    if (!session.security || typeof session.security !== 'object') session.security = {};
    return session.security as SecurityState;
  }

  function clearStepUpAuthorization(session: SecuredSession): void {
    sessionSecurityState(session).stepUp = null;
  }

  /* Gives the session a nonce if it has none, which also ends any step-up it held. */
  async function ensureSessionSecurity(req: SecurityRequest, res: SessionResponse): Promise<SecurityState> {
    const state = sessionSecurityState(req.session!);
    if (SESSION_NONCE.test(String(state.sessionNonce || ''))) return state;
    state.sessionNonce = randomBytes(24).toString('hex');
    state.stepUp = null;
    await setSession(req, res, req.session);
    return state;
  }

  /* What a token is bound to: this session's nonce and the identity acting. */
  function requestSecurityContext(req: SecurityRequest): { sessionBinding: string; identityKey: string } {
    const state = sessionSecurityState(req.session || {});
    const sessionBinding = String(state.sessionNonce || '');
    const activeIdentityKey = req.gh ? identityKey(req.gh) : '';
    if (!sessionBinding || !activeIdentityKey) {
      throw Object.assign(new Error('Security context is unavailable for this session'), { status: 401, code: 'SECURITY_CONTEXT_REQUIRED' });
    }
    return { sessionBinding, identityKey: activeIdentityKey };
  }

  function verifyRequestCsrf(req: SecurityRequest): unknown {
    if (deps.safeMethods.has(req.method)) return null;
    const token = String(req.headers[CSRF_HEADER] || '');
    if (!token) throw Object.assign(new Error('A fresh CSRF token is required'), { status: 403, code: 'CSRF_REQUIRED' });
    return verifyCsrfToken(deps.csrfSecret, token, requestSecurityContext(req));
  }

  async function consumeStepUpAuthorization(req: SecurityRequest, res: SessionResponse, operation: { action: string; scope: unknown }): Promise<unknown> {
    const token = String(req.headers[STEP_UP_HEADER] || '');
    if (!token) throw Object.assign(new Error('This sensitive action requires step-up authorization'), { status: 403, code: 'STEP_UP_REQUIRED' });
    const context = requestSecurityContext(req);
    const claims = verifyStepUpGrant(deps.stepUpSecret, token, { ...context, action: operation.action, scope: operation.scope });
    const state = sessionSecurityState(req.session!);
    /*
     * Awaited, because the guard behind this may not be in this process. An
     * un-awaited call assigns a Promise, and a Promise is truthy: the audit
     * record at the end of a sensitive action would read it as an authorization
     * and write undefined for every field it carries.
     */
    req.stepUp = await consumePendingStepUp(state, claims, operation, { replayStore: stepUpReplayStore() });
    await setSession(req, res, req.session);
    return req.stepUp;
  }

  /*
   * The key a signed-in request's cached responses are filed under in the
   * browser: this session and this identity, so a cache written for one is
   * never read for another. A session the database keeps is named by its id.
   * One its cookie alone keeps is named by its nonce, which lasts exactly as
   * long as the session does; the cookie itself names nothing that lasts, as
   * it is sealed afresh on every write of the session, so a scope bound to
   * it would change under the browser at the first. A session with neither
   * has no scope, and nothing of it is kept offline.
   */
  function offlineCacheScope(req: SecurityRequest): string {
    const state = req.session && req.session.security && typeof req.session.security === 'object' ? req.session.security as SecurityState : {};
    const nonce = String(state.sessionNonce || '');
    const sessionBinding = sessionIdFromRequest(req) || (SESSION_NONCE.test(nonce) ? nonce : '');
    if (!sessionBinding || !req.gh) return '';
    return createHmac('sha256', deps.offlineCacheScopeKey)
      .update(`${sessionBinding}|${identityKey(req.gh)}`)
      .digest('base64url')
      .slice(0, 32);
  }

  /* A response the browser may keep: a private-cache GET whose scope and repository the request itself proves. */
  function offlineCacheResponseBinding(req: SecurityRequest): { scope: string; repoKey: string } | null {
    if (req.method !== 'GET' || !req.gh) return null;
    let url: URL;
    try { url = new URL((req.originalUrl || req.url) as string, 'https://nebulaverse.invalid'); }
    catch { return null; }
    const decision = OFFLINE_CACHE_POLICY.classifyApiRequest(url, req.method, {
      get(name: string) { return String(req.headers[String(name).toLowerCase()] || ''); }
    }) as { mode?: string; scope?: string; repoKey?: string };
    if (decision.mode !== 'private-cache') return null;
    let expectedRepoKey = '';
    if (/^\/api\/repos(?:\/|$)/.test(url.pathname)) {
      expectedRepoKey = 'account';
    } else {
      const match = /^\/api\/repo\/([^/]+)\/([^/]+)(?:\/|$)/.exec(url.pathname);
      if (!match) return null;
      try {
        expectedRepoKey = `${req.gh.provider || 'github'}:${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`.toLowerCase();
      } catch { return null; }
    }
    const expectedScope = offlineCacheScope(req);
    if (!expectedScope || decision.scope !== expectedScope || decision.repoKey !== expectedRepoKey) return null;
    return { scope: expectedScope, repoKey: expectedRepoKey };
  }

  return {
    sessionSecurityState, clearStepUpAuthorization, ensureSessionSecurity, requestSecurityContext,
    verifyRequestCsrf, consumeStepUpAuthorization, offlineCacheScope, offlineCacheResponseBinding
  };
}

export type SessionSecurity = ReturnType<typeof createSessionSecurity>;
