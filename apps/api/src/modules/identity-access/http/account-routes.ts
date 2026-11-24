/*
 * The accounts a session holds: signing in with a token, the list and the
 * switch between them, removing one, signing out, and who the selected
 * account is.
 *
 * Only GitHub is supported. An account of a provider the product no longer
 * supports is retired: it is listed and can be removed, so its credentials
 * can be cleaned up, but it cannot be chosen. Removing the last GitHub
 * account ends the session, retired accounts with it. In the hosted alpha a
 * GitHub App connection is shown as the tester's, never by the installation's
 * own account, and the provider session cookie is cleared rather than the
 * session destroyed, since the store owns the session there.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { member, type Fields } from '../../../platform/values/fields.ts';
import {
  providerDisconnectPending, uniqueGuidance, type DisconnectProviderAccounts, type ProviderSession
} from './disconnect-answers.ts';

type Fail = (res: Response, error: unknown) => unknown;

export interface AccountRouteDeps {
  readonly accountAuth: RequestHandler;
  readonly config: { readonly enabled: boolean };
  readonly fail: Fail;
  /* The provider's own account for a credential: GitHub's /user, or the installation an App connection names. */
  providerIdentity(account: Fields): Promise<unknown>;
  /* Adds a signed-in account to the request's session, or begins one, and writes it. */
  addAccount(req: Request, res: Response, token: string, user: unknown, provider: string, baseUrl: string, options: Fields): Promise<unknown>;
  /* Answers 401 for a session with no GitHub account left, and says whether it did. */
  signedOutWithoutGithub(req: Request, res: Response): boolean;
  /* The name the hosted alpha shows for the tester. */
  retainedActor(req: Request): string;
  githubAppConnectionView(account: Fields, active: boolean): Fields;
  isGithubAccount(account: unknown): boolean;
  clearStepUpAuthorization(session: ProviderSession): void;
  setSession(req: Request, res: Response, session: ProviderSession): Promise<unknown>;
  sessionOf(req: Request, options: { retainRetiredAccounts: boolean }): Promise<ProviderSession | null>;
  destroySession(req: Request, res: Response): Promise<unknown>;
  readonly disconnectProviderAccounts: DisconnectProviderAccounts;
  clearProviderSessionCookie(req: Request, res: Response): void;
}

export interface MeRouteDeps {
  readonly accountAuth: RequestHandler;
  readonly config: { readonly enabled: boolean };
  readonly fail: Fail;
  signedOutWithoutGithub(req: Request, res: Response): boolean;
  isGithubAccount(account: unknown): boolean;
  retainedActor(req: Request): string;
  githubAppConnectionView(account: Fields, active: boolean): Fields;
  gh(account: Fields, path: string): Promise<unknown>;
  /* What the account's credential lets the product do, and the offline cache scope the browser keys its copies by. */
  providerCapabilities(account: Fields): unknown;
  offlineCacheScope(req: Request): unknown;
  /* The build's version, as the server names it. */
  readonly releaseVersion: string;
}

const UNSUPPORTED_SELECTION = 'That account is no longer supported. Remove it or choose a GitHub account.';

/* What the account guard attached: the session, the selected account and its credential. */
const sessionOn = (req: Request): ProviderSession => Reflect.get(req, 'session') as ProviderSession;
const selectedAccount = (req: Request): Fields => Reflect.get(req, 'sessionAccount') as Fields;
const credentialOn = (req: Request): Fields => Reflect.get(req, 'gh') as Fields;
/* An index from the request, compared and used as JavaScript compares and uses it. */
const indexIn = (value: unknown, accounts: readonly unknown[]): boolean => (value as number) >= 0 && (value as number) < accounts.length;

export function registerAccountRoutes(app: Application, deps: AccountRouteDeps): void {
  const { accountAuth, fail } = deps;

  app.post('/api/login', async (req: Request, res: Response) => {
    try {
      const provider = req.body && member(req.body, 'provider');
      if (provider !== undefined && provider !== 'github') {
        return res.status(400).json({ error: 'Only GitHub accounts are supported', code: 'PROVIDER_UNSUPPORTED' });
      }
      if (req.body && member(req.body, 'baseUrl')) {
        return res.status(400).json({ error: 'Custom Git server URLs are not supported', code: 'PROVIDER_AUTHORITY_UNSUPPORTED' });
      }
      const supplied = req.body === null || req.body === undefined ? undefined : member(req.body, 'token');
      const token = typeof supplied === 'string' ? supplied.trim() : '';
      if (!token) return res.status(400).json({ error: 'Token required' });
      const acct = { provider: 'github', token };
      const user = await deps.providerIdentity(acct);
      await deps.addAccount(req, res, token, user, 'github', '', { authMethod: 'token' });
      return res.json({ login: member(user, 'login'), name: member(user, 'name'), avatar: member(user, 'avatar_url'), provider: 'github', authMethod: 'token' });
    } catch (e) {
      if (member(e, 'status') === 401 && member(e, 'code') !== 'ALPHA_ACCESS_REQUIRED') return res.status(401).json({ error: 'Invalid token for that provider.' });
      return fail(res, e);
    }
  });

  app.get('/api/accounts', accountAuth, (req: Request, res: Response) => {
    if (deps.signedOutWithoutGithub(req, res)) return;
    const session = sessionOn(req);
    const activeIdx = Math.min((session.active || 0) as number, session.accounts.length - 1);
    res.json({
      active: activeIdx,
      accounts: session.accounts.map((a, index) => {
        if (deps.config.enabled && a.authMethod === 'github-app') {
          return {
            login: deps.retainedActor(req),
            avatar: '',
            provider: 'github',
            authMethod: 'github-app',
            ...deps.githubAppConnectionView(a, index === activeIdx)
          };
        }
        return {
          login: a.login, avatar: a.avatar,
          provider: a.provider || 'github',
          retired: !deps.isGithubAccount(a),
          authMethod: a.authMethod || 'token',
          host: a.baseUrl ? String(a.baseUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null,
          ...(a.authMethod === 'github-app' ? {
            installationId: Number(a.installationId),
            repositorySelection: a.repositorySelection === 'all' ? 'all' : 'selected',
            authorizedByLogin: String(a.authorizedByLogin || ''),
            status: String(a.installationStatus || 'connected')
          } : {})
        };
      })
    });
  });

  app.post('/api/accounts/switch-idx', accountAuth, async (req: Request, res: Response) => {
    try {
      const session = sessionOn(req);
      const i = req.body && member(req.body, 'idx');
      if (!indexIn(i, session.accounts)) return res.status(400).json({ error: 'Bad index' });
      const chosen = session.accounts[i as number];
      if (!deps.isGithubAccount(chosen)) return res.status(409).json({ error: UNSUPPORTED_SELECTION, code: 'PROVIDER_UNSUPPORTED' });
      session.active = i;
      deps.clearStepUpAuthorization(session);
      await deps.setSession(req, res, session);
      return res.json({ ok: true, login: member(session.accounts[i as number], 'login') });
    } catch (e) { return fail(res, e); }
  });

  /* remove ONE account, keep the rest signed in */
  app.post('/api/accounts/remove', accountAuth, async (req: Request, res: Response) => {
    try {
      const session = sessionOn(req);
      const i = req.body && member(req.body, 'idx');
      if (!indexIn(i, session.accounts)) return res.status(400).json({ error: 'Bad index' });
      const removed = session.accounts[i as number];
      const removedActive = i === (Number(session.active) || 0);
      const cleanup = await deps.disconnectProviderAccounts(req, removed);
      if (!cleanup.supportedComplete) return providerDisconnectPending(res, cleanup);
      const guidance = [...cleanup.manualCleanup];
      const remaining = deps.config.enabled
        ? ((await deps.sessionOf(req, { retainRetiredAccounts: true })) || { accounts: [] }).accounts
        : sessionOn(req).accounts;
      if (!remaining.some(account => deps.isGithubAccount(account))) {
        /* No GitHub account is left to act: retired accounts go too, and the session ends. */
        if (remaining.length) {
          const rest = await deps.disconnectProviderAccounts(req, remaining);
          if (!rest.supportedComplete) return providerDisconnectPending(res, rest);
          guidance.push(...rest.manualCleanup);
        }
        if (deps.config.enabled) deps.clearProviderSessionCookie(req, res);
        else await deps.destroySession(req, res);
        return res.json({ ok: true, removed: member(removed, 'login'), empty: true, ...(guidance.length ? { revocationGuidance: uniqueGuidance(guidance) } : {}) });
      }
      const revocation = guidance.length ? { revocationGuidance: uniqueGuidance(guidance) } : {};
      if (deps.config.enabled) {
        const reread = await deps.sessionOf(req, { retainRetiredAccounts: true });
        Reflect.set(req, 'session', reread);
        return res.json({ ok: true, removed: member(removed, 'login'), active: Number(member(reread, 'active')) || 0, ...revocation });
      }
      const current = sessionOn(req);
      /* The selected identity left: a GitHub account is chosen, never a retired one. */
      if (removedActive) current.active = current.accounts.findIndex(account => deps.isGithubAccount(account));
      await deps.setSession(req, res, current);
      return res.json({ ok: true, removed: member(removed, 'login'), active: member(current.accounts[current.active as number], 'login'), ...revocation });
    } catch (e) { return fail(res, e); }
  });

  app.post('/api/accounts/switch', accountAuth, async (req: Request, res: Response) => {
    try {
      const session = sessionOn(req);
      const i = session.accounts.findIndex(a => a.login === (req.body && member(req.body, 'login')));
      if (i < 0) return res.status(404).json({ error: 'Account not in session' });
      if (!deps.isGithubAccount(session.accounts[i])) return res.status(409).json({ error: UNSUPPORTED_SELECTION, code: 'PROVIDER_UNSUPPORTED' });
      session.active = i;
      deps.clearStepUpAuthorization(session);
      await deps.setSession(req, res, session);
      return res.json({ ok: true, login: member(session.accounts[i], 'login') });
    } catch (e) { return fail(res, e); }
  });
}

/* Signing out disconnects every account in the session, retired ones included, so their cleanup evidence is recorded. */
export function registerSignOutRoute(app: Application, deps: Pick<AccountRouteDeps,
  'accountAuth' | 'config' | 'fail' | 'disconnectProviderAccounts' | 'clearProviderSessionCookie' | 'destroySession'>): void {
  const { accountAuth, fail } = deps;

  app.post('/api/logout', accountAuth, async (req: Request, res: Response) => {
    try {
      /* Every account in the session, retired ones included, so their cleanup evidence is recorded. */
      const cleanup = await deps.disconnectProviderAccounts(req, sessionOn(req).accounts);
      if (!cleanup.supportedComplete) return providerDisconnectPending(res, cleanup);
      if (deps.config.enabled) deps.clearProviderSessionCookie(req, res);
      else await deps.destroySession(req, res);
      return res.json({ ok: true, ...(cleanup.manualCleanup.length ? { revocationGuidance: uniqueGuidance(cleanup.manualCleanup) } : {}) });
    } catch (e) { return fail(res, e); }
  });
}

/* Who the selected account is, with the build a tester quotes in a fault report. */
export function registerMeRoute(app: Application, deps: MeRouteDeps): void {
  const { accountAuth, fail } = deps;

  app.get('/api/me', accountAuth, async (req: Request, res: Response) => {
    try {
      if (deps.signedOutWithoutGithub(req, res)) return undefined;
      const account = selectedAccount(req);
      if (!deps.isGithubAccount(account)) {
        return res.status(409).json({ error: 'The selected account is no longer supported. Choose a GitHub account.', code: 'ACCOUNT_SELECTION_REQUIRED' });
      }
      const credential = credentialOn(req);
      const provider = credential.provider || 'github';
      let out: Fields;
      if (credential.authMethod === 'github-app') {
        out = deps.config.enabled
          ? {
              login: deps.retainedActor(req),
              name: deps.retainedActor(req),
              avatar: '',
              ...deps.githubAppConnectionView(account, true)
            }
          : {
              login: account.login,
              name: account.login,
              avatar: account.avatar,
              installationId: Number(account.installationId),
              authorizedByLogin: String(account.authorizedByLogin || ''),
              repositorySelection: account.repositorySelection === 'all' ? 'all' : 'selected'
            };
      } else {
        const u = await deps.gh(credential, '/user');
        out = { login: member(u, 'login'), name: member(u, 'name'), avatar: member(u, 'avatar_url') };
      }
      res.setHeader('Cache-Control', 'no-store');
      /* The build a tester quotes in a fault report. It rides an authenticated
         response so the landing page no longer has to publish it to everyone. */
      return res.json({
        ...out, provider, authMethod: credential.authMethod || 'token', caps: deps.providerCapabilities(credential),
        offlineCacheScope: deps.offlineCacheScope(req), release: deps.releaseVersion
      });
    } catch (e) { return fail(res, e); }
  });
}
