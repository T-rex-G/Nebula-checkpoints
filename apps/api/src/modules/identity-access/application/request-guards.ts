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
import { sensitiveOperationFor } from '../../../platform/authorization/security-foundation.ts';
import { assertGithubAccount, identityKey, isGithubAccount } from '../domain/account-identity.ts';

type Next = () => void;

interface GuardResponse {
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

export interface GuardedRequest {
  session?: ProviderSession | null;
  sessionAccount?: ProviderAccount;
  gh?: ProviderAccount;
  effectiveSafety?: unknown;
  readonly method?: string;
  readonly path?: string;
  readonly params?: unknown;
  readonly body?: unknown;
}

interface Refusal { readonly status?: number; readonly message?: string; readonly code?: unknown }

export interface RequestGuardDeps {
  /* The provider session, retired accounts kept when asked (provider-sessions.ts). */
  readonly sessionOf: (req: never, options: { retainRetiredAccounts: boolean }) => Promise<ProviderSession | null>;
  /* The account with its credential resolved (the GitHub provider, with the App broker). */
  readonly resolveAccount: (account: ProviderAccount) => Promise<ProviderAccount>;
  /* The session's own security (session-security.ts). */
  readonly ensureSessionSecurity: (req: never, res: never) => Promise<unknown>;
  readonly verifyRequestCsrf: (req: never) => void;
  readonly consumeStepUpAuthorization: (req: never, res: never, operation: unknown) => Promise<unknown>;
  /* The identity's safety controls, and what they refuse (Corona). */
  readonly loadSafety: (req: never) => Promise<unknown>;
  readonly guardSafety: (req: never) => string | null;
}

export function createRequestGuards(deps: RequestGuardDeps) {
  const call = deps as unknown as {
    sessionOf(req: GuardedRequest, options: { retainRetiredAccounts: boolean }): Promise<ProviderSession | null>;
    ensureSessionSecurity(req: GuardedRequest, res: GuardResponse): Promise<unknown>;
    verifyRequestCsrf(req: GuardedRequest): void;
    consumeStepUpAuthorization(req: GuardedRequest, res: GuardResponse, operation: unknown): Promise<unknown>;
    loadSafety(req: GuardedRequest): Promise<unknown>;
    guardSafety(req: GuardedRequest): string | null;
  };

  async function attachProviderSession(req: GuardedRequest, { retainRetired = false } = {}): Promise<void> {
    const s = req.session || await call.sessionOf(req, { retainRetiredAccounts: retainRetired });
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
      await call.ensureSessionSecurity(req, res);
      call.verifyRequestCsrf(req);
      req.effectiveSafety = await call.loadSafety(req);
      const blocked = call.guardSafety(req);
      if (blocked) return res.status(423).json({ error: blocked, locked: true });
      const operation = sensitiveOperationFor({
        method: req.method, path: req.path, params: req.params, body: req.body,
        provider: req.gh.provider || 'github', identityKey: identityKey(req.gh)
      } as Parameters<typeof sensitiveOperationFor>[0]);
      if (operation) await call.consumeStepUpAuthorization(req, res, operation);
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
      await call.ensureSessionSecurity(req, res);
      call.verifyRequestCsrf(req);
      req.effectiveSafety = await call.loadSafety(req);
      const blocked = call.guardSafety(req);
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
