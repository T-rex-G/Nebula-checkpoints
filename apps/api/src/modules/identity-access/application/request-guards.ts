/*
 * The guards a request passes before a route reads or changes anything.
 *
 * Provider routes see only GitHub accounts. Account management (the list,
 * switching, removal, sign-out, the CSRF token) sees retired accounts too, so
 * they can be replaced, and their cleanup evidence recorded, rather than lost.
 *
 *   - providerSessionAccess attaches the signed-in session and its account,
 *     for a read that changes nothing.
 *   - auth does that, resolves the account's credential (an App installation's
 *     token is minted here), checks the session's security and the request's
 *     CSRF token, loads the identity's safety controls and refuses what they
 *     refuse, and spends a step-up grant for a sensitive operation.
 *   - accountAuth does the same for account management, without resolving a
 *     credential or asking for step-up, and accepts a retired account.
 *
 * A refusal answers with its own status and code; anything else is a 500
 * whose message is the error's own, as it always was.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { sensitiveOperationFor, type StepUpRequest } from '../../../platform/authorization/security-foundation.ts';
import { assertGithubAccount, identityKey, isGithubAccount } from '../domain/account-identity.ts';
import type { SignedInSession } from './provider-sessions.ts';

type Next = () => void;

/* An Express response as the guards answer on it; the session's security sets its cookie on it. */
interface GuardResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): GuardResponse;
  json(body: unknown): unknown;
}

interface ProviderAccount { readonly provider?: unknown; [field: string]: unknown }

interface ProviderSession {
  readonly accounts: readonly ProviderAccount[];
  readonly active?: number;
  readonly retiredSelection?: unknown;
  [field: string]: unknown;
}

/*
 * An Express request as the guards and what they ask read it: its method,
 * path, headers, parameters and body, and what the guards attach. The session
 * is read from the cookie, and the session's security reads the CSRF and
 * step-up headers.
 */
export interface GuardedRequest {
  session?: ProviderSession;
  sessionAccount?: ProviderAccount;
  gh?: ProviderAccount;
  effectiveSafety?: unknown;
  readonly method: string;
  readonly path?: string;
  readonly headers: IncomingHttpHeaders;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

interface Refusal { readonly status?: number; readonly message?: string; readonly code?: unknown }

export interface RequestGuardDeps {
  /* The provider session, retired accounts kept when asked (provider-sessions.ts). */
  readonly sessionOf: (req: GuardedRequest, options: { retainRetiredAccounts: boolean }) => Promise<SignedInSession | null>;
  /* The account with its credential resolved (the GitHub provider, with the App broker). */
  readonly resolveAccount: (account: ProviderAccount) => Promise<ProviderAccount>;
  /* The session's own security (session-security.ts). */
  readonly ensureSessionSecurity: (req: GuardedRequest, res: GuardResponse) => Promise<unknown>;
  readonly verifyRequestCsrf: (req: GuardedRequest) => unknown;
  readonly consumeStepUpAuthorization: (req: GuardedRequest, res: GuardResponse, operation: StepUpRequest) => Promise<unknown>;
  /* The identity's safety controls, and what they refuse (Corona). */
  readonly loadSafety: (req: GuardedRequest) => Promise<unknown>;
  readonly guardSafety: (req: GuardedRequest) => string | null;
}

export function createRequestGuards(deps: RequestGuardDeps) {
  async function attachProviderSession(req: GuardedRequest, { retainRetired = false } = {}): Promise<void> {
    const s = req.session || await deps.sessionOf(req, { retainRetiredAccounts: retainRetired });
    if (!s) {
      throw Object.assign(new Error('Not signed in'), { status: 401, code: 'AUTH_REQUIRED' });
    }
    if (!retainRetired && s.retiredSelection) {
      throw Object.assign(new Error('The selected account is no longer supported. Choose a GitHub account.'), {
        status: 409, code: 'ACCOUNT_SELECTION_REQUIRED'
      });
    }
    req.session = s;
    req.sessionAccount = s.accounts[Math.min(s.active || 0, s.accounts.length - 1)];
    if (!retainRetired) assertGithubAccount(req.sessionAccount);
    req.gh = { ...req.sessionAccount };
  }

  function providerAuthenticationFailure(res: GuardResponse, error: Refusal) {
    return res.status(error.status || 500).json({
      error: error.message || 'Security check failed',
      ...(error.code ? { code: error.code } : {})
    });
  }

  async function providerSessionAccess(req: GuardedRequest, res: GuardResponse, next: Next): Promise<void> {
    try {
      await attachProviderSession(req);
      next();
    } catch (error) {
      providerAuthenticationFailure(res, error as Refusal);
    }
  }

  async function auth(req: GuardedRequest, res: GuardResponse, next: Next): Promise<unknown> {
    try {
      await attachProviderSession(req);
      req.gh = await deps.resolveAccount(req.sessionAccount as ProviderAccount);
      await deps.ensureSessionSecurity(req, res);
      deps.verifyRequestCsrf(req);
      req.effectiveSafety = await deps.loadSafety(req);
      const blocked = deps.guardSafety(req);
      if (blocked) return res.status(423).json({ error: blocked, locked: true });
      const operation = sensitiveOperationFor({
        method: req.method, path: req.path, params: req.params, body: req.body,
        provider: req.gh.provider || 'github', identityKey: identityKey(req.gh)
      } as Parameters<typeof sensitiveOperationFor>[0]);
      if (operation) await deps.consumeStepUpAuthorization(req, res, operation);
      next();
    } catch (e) {
      const error = e as Refusal;
      res.status(error.status || 500).json({
        error: error.message || 'Security check failed',
        ...(error.code ? { code: error.code } : {})
      });
    }
    return undefined;
  }

  /*
   * A session with no GitHub account left is signed out for every product read:
   * there is nothing to choose. Sign-out and account removal still accept it, so
   * its stored credentials can be cleaned up.
   */
  function signedOutWithoutGithub(req: GuardedRequest, res: GuardResponse): boolean {
    if (req.session && Array.isArray(req.session.accounts) && req.session.accounts.some(isGithubAccount)) return false;
    res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' });
    return true;
  }

  async function accountAuth(req: GuardedRequest, res: GuardResponse, next: Next): Promise<unknown> {
    try {
      await attachProviderSession(req, { retainRetired: true });
      await deps.ensureSessionSecurity(req, res);
      deps.verifyRequestCsrf(req);
      req.effectiveSafety = await deps.loadSafety(req);
      const blocked = deps.guardSafety(req);
      if (blocked) return res.status(423).json({ error: blocked, locked: true });
      next();
    } catch (e) {
      providerAuthenticationFailure(res, e as Refusal);
    }
    return undefined;
  }

  return { attachProviderSession, providerAuthenticationFailure, providerSessionAccess, auth, signedOutWithoutGithub, accountAuth };
}

export type RequestGuards = ReturnType<typeof createRequestGuards>;
