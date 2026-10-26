/*
 * A GitHub App connection, from the signed-in user's side: connecting one,
 * GitHub's two returns (the user authorization, then the installation),
 * what the session holds, a connection refreshed from GitHub, and one
 * disconnected.
 *
 * Connecting is two signed, single-use states, each bound to the session and
 * to the identity that began it. The user authorization proves who is
 * installing; the installation is then accepted only when GitHub shows that
 * same user can see it and the installation's own account matches. A pending
 * state is spent before it is checked, and stays spent when the check fails,
 * so a wrong nonce cannot be retried until it is guessed; with a database the
 * spend is shared by every instance. An App connection holds no token: the
 * broker mints installation credentials when they are needed. In the hosted
 * alpha a connection is addressed by its hashed connection key, never by the
 * installation's own numbers, and is shown as the tester's.
 *
 * The provider's App client (its states, its error and the broker) is handed
 * in: the GitHub provider already depends on identity and access, and this
 * module must not depend back. The guards are handed in under the names the
 * route policy records.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Application, NextFunction, Request, RequestHandler, Response } from 'express';
import { IDENTITY_KEY } from '../../../../../../packages/contracts/src/ids.ts';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { cleanText } from '../../../platform/values/text.ts';
import { memorySingleUseStore } from '../../../platform/rate-limit/single-use-store.ts';
import {
  providerDisconnectPending, type DisconnectProviderAccounts, type ProviderSession
} from './disconnect-answers.ts';

type Fail = (res: Response, error: unknown) => unknown;
type AppErrorClass = new (message: string, code: string, status?: number) => Error;
type SingleUseClaim = { kind: string; key: string; expiresAt: number; now: number };

/* The provider's App client, as the GitHub provider exports it. */
export interface GithubAppClient {
  readonly AppError: AppErrorClass;
  createState(secret: unknown, context: unknown, options: { now: number; ttlMs: number; nonce: string }): string;
  verifyState(secret: unknown, token: unknown, expected: unknown): Fields;
}

/* The installation-credential broker's operations these routes use. */
export interface GithubAppBrokerOperations {
  authorizationUrl(state: string): string;
  exchangeUserCode(code: unknown): Promise<unknown>;
  getAuthorizedUser(token: unknown): Promise<unknown>;
  installationUrl(state: string): string;
  findUserInstallation(userToken: unknown, installationId: number): Promise<unknown>;
  getInstallation(installationId: unknown): Promise<unknown>;
  invalidate(installationId: number): void;
}

export interface GithubAppConnectionViewDeps {
  readonly config: { readonly enabled: boolean };
  identityKey(account: unknown): string;
}

export interface GithubAppRouteDeps extends GithubAppConnectionViewDeps {
  readonly auth: RequestHandler;
  readonly accountAuth: RequestHandler;
  readonly fail: Fail;
  /* The deployment's App configuration, and its broker when the App is configured. */
  readonly githubApp: { readonly enabled: unknown; readonly webhookConfigured: unknown };
  broker(): GithubAppBrokerOperations | null;
  readonly client: GithubAppClient;
  /* The keys that sign a flow's states and name a spent one. */
  readonly stateSecret: unknown;
  readonly replayKey: Buffer | string;
  /* With a database, a spent state is shared by every instance; without one it is this process's. */
  databaseConfigured(): boolean;
  durableSingleUseStore(): { consumeOnce(claim: SingleUseClaim): Promise<boolean> | boolean };
  readonly connectionView: (account: Fields, active: boolean) => Fields;
  providerIdentity(account: Fields): Promise<unknown>;
  requestSecurityContext(req: Request): Fields;
  sessionSecurityState(session: ProviderSession): Fields;
  ensureSessionSecurity(req: Request, res: Response): Promise<unknown>;
  sessionOf(req: Request): Promise<ProviderSession | null>;
  setSession(req: Request, res: Response, session: ProviderSession): Promise<unknown>;
  destroySession(req: Request, res: Response): Promise<unknown>;
  addAccount(req: Request, res: Response, token: string, user: Fields, provider: string, baseUrl: string, options: Fields): Promise<unknown>;
  clearStepUpAuthorization(session: ProviderSession): void;
  readonly disconnectProviderAccounts: DisconnectProviderAccounts;
  clearProviderSessionCookie(req: Request, res: Response): void;
  /* The installation's non-secret record, and the audit of what happened to it. */
  persistGithubAppInstallation(identity: unknown, installation: unknown, authorizedUser: Fields, status: string): Promise<unknown>;
  recordGithubAppAudit(identity: unknown, eventType: string, installationId: unknown, details: Fields): Promise<unknown>;
  retainedActor(req: Request): string;
}

const GITHUB_APP_FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_USED_GITHUB_APP_STATES = 10000;

/* What the account guard attached: the session, the selected account and its credential. */
const sessionOn = (req: Request): ProviderSession => Reflect.get(req, 'session') as ProviderSession;
const selectedAccount = (req: Request): unknown => Reflect.get(req, 'sessionAccount');
const credentialOn = (req: Request): Fields => Reflect.get(req, 'gh') as Fields;
const queryField = (req: Request, name: string): unknown => req.query && member(req.query, name);
const bodyField = (req: Request, name: string): unknown => req.body && member(req.body, name);
/* `String(left || '')` and `String(right || '')` compared in constant time. */
function secureTextEqual(left: unknown, right: unknown): boolean {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* An App connection as the browser sees it: by its hashed key in the hosted alpha, by the installation locally. */
export function createGithubAppConnectionView(deps: GithubAppConnectionViewDeps): (account: Fields, active: boolean) => Fields {
  return function githubAppConnectionView(account: Fields, active: boolean): Fields {
    if (deps.config.enabled) {
      return {
        connectionKey: deps.identityKey(account),
        accountType: String(account.installationAccountType || 'User'),
        repositorySelection: account.repositorySelection === 'all' ? 'all' : 'selected',
        status: String(account.installationStatus || 'connected'),
        lastVerifiedAt: String(account.lastVerifiedAt || ''),
        active: !!active
      };
    }
    return {
      installationId: Number(account.installationId),
      accountLogin: String(account.login || ''),
      accountType: String(account.installationAccountType || 'User'),
      avatar: String(account.avatar || ''),
      repositorySelection: account.repositorySelection === 'all' ? 'all' : 'selected',
      permissions: account.permissions && typeof account.permissions === 'object' ? { ...account.permissions } : {},
      authorizedByLogin: String(account.authorizedByLogin || ''),
      status: String(account.installationStatus || 'connected'),
      lastVerifiedAt: String(account.lastVerifiedAt || ''),
      installationUrl: String(account.installationHtmlUrl || ''),
      active: !!active
    };
  };
}

export function registerGithubAppRoutes(app: Application, deps: GithubAppRouteDeps): void {
  const { auth, accountAuth, fail, client, connectionView: githubAppConnectionView } = deps;
  const GithubAppError = client.AppError;
  const USED_GITHUB_APP_STATES = new Map<unknown, unknown>();
  /* requireGithubAppFeature admits a request to the routes that use the broker only when there is one. */
  const broker = (): GithubAppBrokerOperations => deps.broker() as GithubAppBrokerOperations;

  /*
   * The same guard the step-up grant uses, under its own kind. Without a
   * database this stays the bounded in-process Map it has always been; with one,
   * an OAuth state consumed on any instance is consumed on all of them.
   */
  function githubAppStateStore(): { consumeOnce(claim: SingleUseClaim): Promise<boolean> | boolean } {
    if (!deps.databaseConfigured()) {
      return memorySingleUseStore(USED_GITHUB_APP_STATES, { maxEntries: MAX_USED_GITHUB_APP_STATES });
    }
    return deps.durableSingleUseStore();
  }
  function githubAppStateReplayKey(slot: string, nonce: unknown, identity: unknown): string {
    return createHmac('sha256', deps.replayKey)
      .update(`${String(slot)}|${String(nonce)}|${String(identity)}`)
      .digest('base64url');
  }
  function requireGithubAppFeature(req: Request, res: Response, next: NextFunction): unknown {
    if (!deps.githubApp.enabled || !deps.broker()) {
      return res.status(404).json({ error: 'GitHub App authentication is not configured', code: 'GITHUB_APP_DISABLED' });
    }
    return next();
  }
  function githubAppPending(session: ProviderSession): Fields & Record<string, unknown> {
    const security = deps.sessionSecurityState(session) as Record<string, unknown>;
    if (!security.githubApp || typeof security.githubApp !== 'object') security.githubApp = {};
    return security.githubApp as Record<string, unknown>;
  }
  async function consumeGithubAppPending(session: ProviderSession, slot: string, nonce: unknown, identity: unknown, now = Date.now()): Promise<Fields> {
    const store = githubAppPending(session);
    const pending = store[slot] as Fields | undefined;
    /*
     * The pending state is spent before it is checked, and stays that way even
     * when the check fails. That is deliberate and older than this change: an
     * attempt against a state is the state's one use, so a wrong nonce cannot be
     * retried until it is guessed.
     */
    delete store[slot];
    if (!pending || !secureTextEqual(pending.nonce, nonce) || !secureTextEqual(pending.identityKey, identity) || Number(pending.expiresAt) < Number(now)) {
      throw new GithubAppError('GitHub App authorization state is missing, expired, or already used', 'GITHUB_APP_STATE_REPLAY', 403);
    }
    const replayKey = githubAppStateReplayKey(slot, nonce, identity);
    let claimed;
    try {
      claimed = await githubAppStateStore().consumeOnce({
        kind: 'github-app-state',
        key: replayKey,
        expiresAt: Number(pending.expiresAt),
        now: Number(now)
      });
    } catch {
      /* Unverifiable is not the same as replayed: this one is worth retrying and
         a replay never is, so they must not share a code or a status. */
      throw new GithubAppError(
        'GitHub App authorization state cannot be verified right now', 'GITHUB_APP_STATE_UNAVAILABLE', 503
      );
    }
    if (!claimed) {
      throw new GithubAppError('GitHub App authorization state is missing, expired, or already used', 'GITHUB_APP_STATE_REPLAY', 403);
    }
    return pending;
  }
  async function githubAppCallbackContext(req: Request, res: Response): Promise<Fields> {
    const session = await deps.sessionOf(req);
    if (!session) throw new GithubAppError('Sign in before connecting a GitHub App', 'AUTH_REQUIRED', 401);
    if (session.retiredSelection) {
      throw new GithubAppError('The selected account is no longer supported. Choose a GitHub account.', 'ACCOUNT_SELECTION_REQUIRED', 409);
    }
    Reflect.set(req, 'session', session);
    const account = session.accounts[Math.min((session.active || 0) as number, session.accounts.length - 1)];
    Reflect.set(req, 'sessionAccount', account);
    Reflect.set(req, 'gh', { ...account });
    await deps.ensureSessionSecurity(req, res);
    return deps.requestSecurityContext(req);
  }
  function githubAppRedirect(res: Response, result: string, code: unknown = ''): void {
    const target = new URL('/', 'https://nebulaverse.invalid');
    target.searchParams.set('githubApp', result);
    if (code) target.searchParams.set('code', cleanText(code, 100));
    res.redirect(`${target.pathname}${target.search}`);
  }
  /* A connection in the session, by its hashed key in the hosted alpha and by its installation locally. */
  const addressed = (req: Request) => {
    const requestedConnectionKey = String(bodyField(req, 'connectionKey') || '');
    const requestedInstallationId = Number(bodyField(req, 'installationId'));
    return {
      requestedConnectionKey,
      requestedInstallationId,
      matches: (item: Fields): boolean => item.authMethod === 'github-app' && (
        deps.config.enabled
          ? deps.identityKey(item) === requestedConnectionKey
          : Number(item.installationId) === requestedInstallationId
      )
    };
  };

  app.post('/api/github-app/connect', requireGithubAppFeature, auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const credential = credentialOn(req);
      if ((credential.provider || 'github') !== 'github' || credential.authMethod === 'github-app') {
        return res.status(400).json({
          error: 'Switch to a GitHub PAT or GitHub OAuth account before connecting the GitHub App',
          code: 'GITHUB_APP_USER_ACCOUNT_REQUIRED'
        });
      }
      const user = await deps.providerIdentity(credential);
      const userId = Number(user && member(user, 'id'));
      if (!Number.isSafeInteger(userId) || userId <= 0 || !member(user, 'login')) {
        throw new GithubAppError('GitHub returned incomplete user identity data', 'GITHUB_APP_USER_INVALID', 502);
      }
      const context = deps.requestSecurityContext(req);
      const nonce = randomBytes(18).toString('base64url');
      const now = Date.now();
      const state = client.createState(deps.stateSecret, { ...context, purpose: 'user-auth' }, {
        now, ttlMs: GITHUB_APP_FLOW_TTL_MS, nonce
      });
      githubAppPending(sessionOn(req)).userAuth = {
        nonce,
        expiresAt: now + GITHUB_APP_FLOW_TTL_MS,
        identityKey: context.identityKey,
        userId,
        login: String(member(user, 'login'))
      };
      await deps.setSession(req, res, sessionOn(req));
      return res.json({ url: broker().authorizationUrl(state) });
    } catch (error) {
      deps.recordGithubAppAudit(deps.identityKey(selectedAccount(req)), 'authorization.rejected', null, {
        actor: deps.retainedActor(req), reasonCode: member(error, 'code') || 'CONNECT_FAILED'
      }).catch(() => {});
      return fail(res, error);
    }
  });

  app.get('/api/github-app/oauth/callback', requireGithubAppFeature, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const context = await githubAppCallbackContext(req, res);
      const claims = client.verifyState(deps.stateSecret, queryField(req, 'state'), { ...context, purpose: 'user-auth' });
      const pending = await consumeGithubAppPending(sessionOn(req), 'userAuth', claims.nonce, context.identityKey);
      await deps.setSession(req, res, sessionOn(req));
      const exchange = await broker().exchangeUserCode(queryField(req, 'code'));
      const user = await broker().getAuthorizedUser(member(exchange, 'token'));
      if (Number(member(user, 'id')) !== Number(pending.userId) || String(member(user, 'login')).toLowerCase() !== String(pending.login).toLowerCase()) {
        throw new GithubAppError('GitHub App authorization belongs to a different user', 'GITHUB_APP_USER_MISMATCH', 403);
      }
      const nonce = randomBytes(18).toString('base64url');
      const now = Date.now();
      const expiresIn = member(exchange, 'expiresIn') as number;
      const tokenLifetime = expiresIn > 0 ? Math.min(GITHUB_APP_FLOW_TTL_MS, expiresIn * 1000) : GITHUB_APP_FLOW_TTL_MS;
      const state = client.createState(deps.stateSecret, { ...context, purpose: 'installation-claim' }, {
        now, ttlMs: tokenLifetime, nonce
      });
      githubAppPending(sessionOn(req)).installation = {
        nonce,
        expiresAt: now + tokenLifetime,
        identityKey: context.identityKey,
        userToken: member(exchange, 'token'),
        userId: member(user, 'id'),
        login: member(user, 'login')
      };
      await deps.setSession(req, res, sessionOn(req));
      return res.redirect(broker().installationUrl(state));
    } catch (error) {
      deps.recordGithubAppAudit('github-app-callback', 'authorization.rejected', null, {
        actor: deps.retainedActor(req), reasonCode: member(error, 'code') || 'CALLBACK_FAILED'
      }).catch(() => {});
      return githubAppRedirect(res, 'error', member(error, 'code') || 'GITHUB_APP_CALLBACK_FAILED');
    }
  });

  app.get('/api/github-app/setup', requireGithubAppFeature, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const context = await githubAppCallbackContext(req, res);
      const claims = client.verifyState(deps.stateSecret, queryField(req, 'state'), { ...context, purpose: 'installation-claim' });
      const pending = await consumeGithubAppPending(sessionOn(req), 'installation', claims.nonce, context.identityKey);
      await deps.setSession(req, res, sessionOn(req));
      const installationId = Number(queryField(req, 'installation_id'));
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
        throw new GithubAppError('GitHub App installation ID is invalid', 'GITHUB_APP_INSTALLATION_INVALID', 400);
      }
      const userVisibleInstallation = await broker().findUserInstallation(pending.userToken, installationId);
      const installation = await broker().getInstallation(installationId);
      const visibleAccount = member(userVisibleInstallation, 'account');
      const account = member(installation, 'account');
      if (member(visibleAccount, 'id') !== member(account, 'id') ||
          String(member(visibleAccount, 'login')).toLowerCase() !== String(member(account, 'login')).toLowerCase()) {
        throw new GithubAppError('GitHub App installation ownership verification failed', 'GITHUB_APP_INSTALLATION_OWNERSHIP', 403);
      }
      const authorizedUser = { id: Number(pending.userId), login: String(pending.login) };
      await deps.addAccount(req, res, '', {
        login: member(account, 'login'),
        avatar_url: member(account, 'avatarUrl')
      }, 'github', '', {
        authMethod: 'github-app',
        account: {
          installationId: member(installation, 'id'),
          installationAccountId: member(account, 'id'),
          installationAccountType: member(account, 'type'),
          repositorySelection: member(installation, 'repositorySelection'),
          permissions: member(installation, 'permissions'),
          authorizedByLogin: authorizedUser.login,
          authorizedById: authorizedUser.id,
          authorizedByIdentityKey: context.identityKey,
          installationHtmlUrl: member(installation, 'htmlUrl'),
          installationStatus: 'connected',
          lastVerifiedAt: new Date().toISOString()
        }
      });
      const connectedAccount = sessionOn(req).accounts.find(item => (
        item.authMethod === 'github-app' && Number(item.installationId) === member(installation, 'id')
      ));
      if (!connectedAccount || !IDENTITY_KEY.test(String(connectedAccount.identityKey || ''))) {
        throw new GithubAppError(
          'GitHub App connection identity is unavailable',
          'GITHUB_APP_ACCOUNT_INVALID',
          500
        );
      }
      const installationIdentity = deps.config.enabled
        ? connectedAccount.identityKey
        : context.identityKey;
      await Promise.allSettled([
        deps.persistGithubAppInstallation(installationIdentity, installation, authorizedUser, 'connected'),
        deps.recordGithubAppAudit(installationIdentity, 'installation.connected', member(installation, 'id'), {
          actor: deps.retainedActor(req),
          accountType: member(account, 'type'),
          repositorySelection: member(installation, 'repositorySelection'),
          permissions: member(installation, 'permissions'),
          status: 'connected'
        })
      ]);
      return githubAppRedirect(res, 'connected');
    } catch (error) {
      deps.recordGithubAppAudit('github-app-setup', 'authorization.rejected', queryField(req, 'installation_id'), {
        actor: deps.retainedActor(req), reasonCode: member(error, 'code') || 'SETUP_FAILED'
      }).catch(() => {});
      return githubAppRedirect(res, 'error', member(error, 'code') || 'GITHUB_APP_SETUP_FAILED');
    }
  });

  app.get('/api/github-app/status', accountAuth, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = sessionOn(req);
    const active = Math.min((session.active || 0) as number, session.accounts.length - 1);
    const connections = session.accounts
      .map((account, index) => account.authMethod === 'github-app' ? githubAppConnectionView(account, index === active) : null)
      .filter(Boolean);
    res.json({
      enabled: !!deps.githubApp.enabled,
      webhookConfigured: !!deps.githubApp.webhookConfigured,
      connections
    });
  });

  app.post('/api/github-app/refresh', requireGithubAppFeature, accountAuth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const { matches } = addressed(req);
    const account = sessionOn(req).accounts.find(matches);
    if (!account) return res.status(404).json({ error: 'GitHub App installation is not connected in this session', code: 'GITHUB_APP_CONNECTION_NOT_FOUND' });
    const target = account as Record<string, unknown>;
    const installationId = Number(account.installationId);
    try {
      const installation = await broker().getInstallation(installationId);
      const owner = member(installation, 'account');
      Object.assign(target, {
        login: member(owner, 'login'),
        avatar: member(owner, 'avatarUrl'),
        installationAccountId: member(owner, 'id'),
        installationAccountType: member(owner, 'type'),
        repositorySelection: member(installation, 'repositorySelection'),
        permissions: { ...Object(member(installation, 'permissions')) },
        installationHtmlUrl: member(installation, 'htmlUrl'),
        installationStatus: 'connected',
        lastVerifiedAt: new Date().toISOString()
      });
      if (!deps.config.enabled) broker().invalidate(installationId);
      deps.clearStepUpAuthorization(sessionOn(req));
      await deps.setSession(req, res, sessionOn(req));
      const authorizedUser = { id: Number(account.authorizedById), login: String(account.authorizedByLogin || '') };
      const installationIdentity = deps.config.enabled
        ? account.identityKey
        : account.authorizedByIdentityKey;
      await Promise.allSettled([
        deps.persistGithubAppInstallation(installationIdentity, installation, authorizedUser, 'connected'),
        deps.recordGithubAppAudit(installationIdentity, 'installation.refreshed', member(installation, 'id'), {
          actor: deps.retainedActor(req),
          repositorySelection: member(installation, 'repositorySelection'),
          permissions: member(installation, 'permissions'),
          status: 'connected'
        })
      ]);
      return res.json({ connection: githubAppConnectionView(account, selectedAccount(req) === account) });
    } catch (error) {
      const suspended = member(error, 'code') === 'GITHUB_APP_INSTALLATION_SUSPENDED';
      if (suspended) target.installationStatus = 'suspended';
      deps.recordGithubAppAudit(
        deps.config.enabled ? account.identityKey : account.authorizedByIdentityKey,
        suspended ? 'installation.suspended' : 'authorization.rejected', installationId, {
          actor: deps.retainedActor(req), status: account.installationStatus || 'unavailable', reasonCode: member(error, 'code') || 'REFRESH_FAILED'
        }).catch(() => {});
      return fail(res, error);
    }
  });

  app.post('/api/github-app/disconnect', accountAuth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { requestedConnectionKey, requestedInstallationId, matches } = addressed(req);
      if (deps.config.enabled && !IDENTITY_KEY.test(requestedConnectionKey)) {
        return res.status(400).json({ error: 'GitHub App connection key is invalid', code: 'GITHUB_APP_CONNECTION_INVALID' });
      }
      if (!deps.config.enabled && (!Number.isSafeInteger(requestedInstallationId) || requestedInstallationId <= 0)) {
        return res.status(400).json({ error: 'GitHub App installation ID is invalid', code: 'GITHUB_APP_INSTALLATION_INVALID' });
      }
      const session = sessionOn(req);
      const index = session.accounts.findIndex(matches);
      if (index < 0) return res.status(404).json({ error: 'GitHub App installation is not connected in this session', code: 'GITHUB_APP_CONNECTION_NOT_FOUND' });
      const removed = session.accounts[index] as Fields;
      const installationId = Number(removed.installationId);
      const previousCount = session.accounts.length;
      const cleanup = await deps.disconnectProviderAccounts(req, removed);
      if (!cleanup.complete) return providerDisconnectPending(res, cleanup);
      if (deps.config.enabled) {
        if (previousCount === 1) {
          deps.clearProviderSessionCookie(req, res);
          return res.json({ ok: true, empty: true });
        }
        const reread = await deps.sessionOf(req);
        Reflect.set(req, 'session', reread);
        return res.json({ ok: true, active: Number(member(reread, 'active')) || 0 });
      }
      const current = sessionOn(req);
      if (!current.accounts.length) {
        await deps.destroySession(req, res);
        return res.json({ ok: true, empty: true, installationId });
      }
      await deps.setSession(req, res, current);
      return res.json({ ok: true, installationId, active: member(current.accounts[current.active as number], 'login') });
    } catch (error) { return fail(res, error); }
  });
}
