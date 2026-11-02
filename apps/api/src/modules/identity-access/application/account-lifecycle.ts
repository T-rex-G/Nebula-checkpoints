/*
 * An account's life in a session: who it is, signing it in, disconnecting
 * it, and the identity's sessions elsewhere.
 *
 * Signing in keeps one entry per identity -- a token account by its login and
 * provider, an App installation by the installation and who authorized it --
 * up to the deployment's account cap, and selects the new one. In the alpha the
 * account is connected to the tester's own provider session, a new one when the
 * cookie names a session that ended. Elsewhere a sign-in that replaces a row
 * holding only retired accounts removes that row and its credentials.
 *
 * Disconnecting forgets any audit held for the account. Outside the alpha it
 * drops an App installation's grant and records it, removes the accounts and
 * keeps the selected identity selected (a GitHub one when the selected account
 * is the one leaving), and says what to revoke at a retired provider. In the
 * alpha each account goes through the provider disconnect, one after the
 * other, until one cannot remove its provider state; a retired account's
 * credential leaves the session at once and its cleanup waits for the
 * operator.
 *
 * An identity's sessions elsewhere are the rows that hold an account of that
 * identity -- in the alpha, the sessions the tester owns -- and ending them
 * removes those rows.
 */
import { randomBytes } from 'node:crypto';
import { member } from '../../../platform/values/fields.ts';
import { cleanText } from '../../../platform/values/text.ts';
import { identityKey, isGithubAccount, providerAuthority, stableProviderIdentityKey, type AccountLike } from '../domain/account-identity.ts';
import { providerRevocationGuidance } from '../domain/alpha-privacy.ts';
import { hostedAccountKey } from '../domain/hosted-session-merge.ts';
import { disconnectProviderAccount, type DisconnectResult } from '../domain/provider-disconnect.ts';
import { HOSTED_SESSION_BASE, HOSTED_SESSION_REVISION, alphaConnectionRefusal, type SignedInSession } from './provider-sessions.ts';

export const RETIRED_CLEANUP = 'PROVIDER_RETIRED_MANUAL_CLEANUP_REQUIRED';

type Fields = Record<string, unknown>;
type Rows = { readonly rows: readonly Fields[] };

/* An account as a session holds it; an old cookie may hold one of a retired provider. */
interface Account extends Omit<AccountLike, 'identityKey'> { identityKey?: unknown; [field: string]: unknown }
interface Session { accounts: Account[]; active?: unknown; retiredSelection?: unknown; [field: string]: unknown }
interface Alpha { readonly testerId?: unknown; [field: string]: unknown }
/* Any request object, as the lifecycle reads it; the session is attached by the session guards before any of this runs. */
type LifecycleRequest = object & {
  session?: Session;
  alpha?: Alpha | null;
  gh?: Account | null;
  [HOSTED_SESSION_BASE]?: unknown;
  [HOSTED_SESSION_REVISION]?: unknown;
};
interface HostedSession { readonly session: Session; readonly revision: unknown }

/* The alpha's privacy store, as the lifecycle uses it. */
export interface LifecyclePrivacyStore {
  prepareProviderDisconnect(input: unknown): unknown;
  completeProviderWebhookCleanup(input: unknown): unknown;
  finalizeProviderDisconnect(input: unknown): unknown;
  createCleanupTask(input: unknown): unknown;
  mutateHostedProviderSession(input: { testerId: unknown; sessionId: string; mutate(current: Session): Session }): Promise<HostedSession>;
  revokeOwnedProviderSessions(input: { testerId: unknown; sessionIds: readonly unknown[] }): Promise<{ readonly revokedSessionIds: Iterable<unknown> }>;
  connectHostedProviderAccount(input: { testerId: unknown; sessionId: string; account: Account; authority: string; capacity: number }): Promise<HostedSession>;
}

export interface AccountLifecycleDeps {
  readonly alphaEnabled: boolean;
  readonly databaseConfigured: boolean;
  /* At most this many accounts in a session. */
  readonly accountCap: () => number;
  readonly ready: () => Promise<boolean>;
  readonly pool: () => { query(text: string, values?: readonly unknown[]): Promise<Rows> };
  /* GitHub's REST API (the GitHub provider) and an account with its credential resolved. */
  readonly gh: (account: unknown, apiPath: string, options?: { readonly method?: string }) => Promise<unknown>;
  readonly resolveAccount: (account: unknown) => Promise<unknown>;
  /*
   * A provider write the disconnect makes on one of the account's repositories,
   * run inside the mutation gateway (the platform's mutation context), which
   * refuses any provider write made outside one.
   */
  readonly runProviderMutation: <T>(
    req: never,
    target: { readonly account: unknown; readonly action: string; readonly owner: string; readonly repo: string; readonly method: string },
    work: () => Promise<T>
  ) => Promise<T>;
  /* The GitHub App broker, or null where no App is configured. */
  readonly appBroker: { invalidate(installationId: unknown): unknown } | null;
  /* An App installation's grant and its audit trail. */
  readonly removeGithubAppInstallation: (identity: unknown, installationId: number) => Promise<unknown>;
  readonly recordGithubAppAudit: (identity: unknown, eventType: string, installationId: number, details: unknown) => Promise<unknown>;
  /* The audits held for an account, forgotten when it leaves. */
  readonly forgetJobs: (account: Account) => void;
  readonly retainedActor: (req: never) => unknown;
  /* The session, its cookie and its security (provider-sessions.ts, session-security.ts). */
  readonly sessionOf: (req: never) => Promise<SignedInSession | null>;
  readonly setSession: (req: never, res: never, data: unknown, options?: { readonly createNew?: boolean }) => Promise<unknown>;
  readonly sessionIdFromRequest: (req: never) => string;
  readonly clearStepUpAuthorization: (session: Session) => void;
  readonly readCookie: (req: never, name: string) => string | null;
  readonly writeCookie: (res: never, value: string, maxAge?: number) => void;
  readonly seal: (value: unknown) => string;
  readonly unseal: (sealed: string) => unknown;
  readonly closeLiveSessions: (sessionIds: readonly string[], reason: string) => unknown;
  /* The alpha's privacy store; none outside the alpha, where nothing here reaches it. */
  readonly privacyStore: LifecyclePrivacyStore | null;
}

export function createAccountLifecycle(deps: AccountLifecycleDeps) {
  const call = deps as unknown as {
    retainedActor(req: LifecycleRequest): unknown;
    sessionOf(req: LifecycleRequest): Promise<Session | null>;
    setSession(req: LifecycleRequest, res: unknown, data: unknown, options?: unknown): Promise<unknown>;
    sessionIdFromRequest(req: LifecycleRequest): string;
    readCookie(req: LifecycleRequest, name: string): string | null;
    writeCookie(res: unknown, value: string, maxAge?: number): void;
    runProviderMutation<T>(
      req: LifecycleRequest,
      target: { readonly account: unknown; readonly action: string; readonly owner: string; readonly repo: string; readonly method: string },
      work: () => Promise<T>
    ): Promise<T>;
  };
  /* The alpha's store: every path that reads it runs only in the alpha, where it is always given. */
  const store = deps.privacyStore!;

  async function providerIdentity(acct: Account | null | undefined): Promise<unknown> {
    if (acct && acct.authMethod === 'github-app') {
      return { login: acct.login, name: acct.login, avatar_url: acct.avatar, id: acct.installationAccountId };
    }
    return deps.gh(acct, '/user');
  }

  async function disconnectAlphaProviderAccount(req: LifecycleRequest, accountOrAccounts: unknown) {
    const accounts = (Array.isArray(accountOrAccounts) ? accountOrAccounts : [accountOrAccounts])
      .filter(account => account && typeof account === 'object') as Account[];
    /* An audit held for an account that is leaving goes with it. */
    for (const account of accounts) deps.forgetJobs(account);
    if (!deps.alphaEnabled) {
      const targetKeys = new Set(accounts.map(hostedAccountKey));
      for (const account of accounts) {
        if (account.authMethod !== 'github-app') continue;
        if (deps.appBroker) deps.appBroker.invalidate(account.installationId);
        await deps.removeGithubAppInstallation(
          account.authorizedByIdentityKey,
          Number(account.installationId)
        );
        await deps.recordGithubAppAudit(
          account.authorizedByIdentityKey,
          'installation.disconnected',
          Number(account.installationId),
          { actor: call.retainedActor(req), status: 'disconnected' }
        );
      }
      /*
       * The selected identity stays selected when an account before it leaves;
       * an index that merely clamps hands the session to whichever account slid
       * into its place. If the selected one is the account leaving, a GitHub
       * account is chosen, never a retired one -- the same rule the hosted path
       * follows.
       */
      const before = req.session!.accounts;
      const selected = before[Math.min(Math.max(Number(req.session!.active) || 0, 0), Math.max(before.length - 1, 0))];
      req.session!.accounts = before.filter(account => !targetKeys.has(hostedAccountKey(account)));
      const kept = req.session!.accounts.indexOf(selected as Account);
      req.session!.active = kept >= 0 ? kept : Math.max(0, req.session!.accounts.findIndex(isGithubAccount));
      deps.clearStepUpAuthorization(req.session!);
      const manualCleanup = accounts.filter(account => !isGithubAccount(account)).map(account => providerRevocationGuidance(account));
      return Object.freeze({ complete: true, supportedComplete: true, legacy: true, results: Object.freeze([]), manualCleanup: Object.freeze(manualCleanup) });
    }

    const sid = call.sessionIdFromRequest(req);
    const alpha = req.alpha as Alpha;
    if (!sid || !req.alpha || !req.alpha.testerId) {
      throw Object.assign(new Error('Owned provider session is unavailable'), {
        status: 401, code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
      });
    }
    const results: DisconnectResult[] = [];
    for (const account of accounts) {
      const bindingIdentityKey = identityKey(account);
      let resolvedAccount: unknown = null;
      const transportAccount = async () => {
        if (!resolvedAccount) {
          resolvedAccount = await deps.resolveAccount(account);
        }
        return resolvedAccount;
      };
      const result = await disconnectProviderAccount({
        account,
        tester: req.alpha,
        binding: {
          testerId: alpha.testerId,
          identityKey: bindingIdentityKey,
          provider: account.provider || 'github',
          authority: providerAuthority(account)
        },
        sessionId: sid,
        async enumerateProviderWebhooks() {
          const inventory = await deps.pool().query(
            `SELECT hook_id,provider_hook_id,owner,repo,alpha_resource_key_hash
             FROM nv_webhooks
            WHERE provider=$1 AND identity_key=$2
            ORDER BY hook_id`,
            [account.provider || 'github', bindingIdentityKey]
          );
          return inventory.rows.map(row => ({
            hookId: row.hook_id,
            providerHookId: row.provider_hook_id,
            owner: row.owner,
            repo: row.repo,
            alphaResourceKeyHash: row.alpha_resource_key_hash
          }));
        },
        prepareDisconnect: (input: unknown) => store.prepareProviderDisconnect(input),
        async removeProviderWebhook({ webhook }: { readonly webhook: { readonly owner: string; readonly repo: string; readonly providerHookId?: unknown } }) {
          if ((account.provider || 'github') !== 'github' || !webhook.providerHookId) {
            return { verifiedAbsent: false };
          }
          const providerAccount = await transportAccount();
          await call.runProviderMutation(
            req,
            { account: providerAccount, action: 'webhook.disconnect', owner: webhook.owner, repo: webhook.repo, method: 'DELETE' },
            () => deps.gh(
              providerAccount,
              `/repos/${encodeURIComponent(webhook.owner)}/${encodeURIComponent(webhook.repo)}/hooks/${webhook.providerHookId}`,
              { method: 'DELETE' }
            )
          );
          return { verifiedAbsent: false };
        },
        async readProviderWebhook({ webhook }: { readonly webhook: { readonly owner: string; readonly repo: string; readonly providerHookId?: unknown } }) {
          if ((account.provider || 'github') !== 'github' || !webhook.providerHookId) {
            return { absent: false };
          }
          const providerAccount = await transportAccount();
          await deps.gh(
            providerAccount,
            `/repos/${encodeURIComponent(webhook.owner)}/${encodeURIComponent(webhook.repo)}/hooks/${webhook.providerHookId}`
          );
          return { absent: false };
        },
        completeProviderWebhookCleanup: (input: unknown) => (
          store.completeProviderWebhookCleanup(input)
        ),
        invalidateBroker() {
          if (account.authMethod === 'github-app' && deps.appBroker) {
            deps.appBroker.invalidate(account.installationId);
          }
        },
        finalizeDisconnect: (input: unknown) => store.finalizeProviderDisconnect(input),
        /* What cannot be cleaned up through a provider any more is recorded for the operator's privacy cleanup. */
        recordPendingEvidence: (input: Fields) => store.createCleanupTask({
          testerId: input.testerId,
          identityKey: bindingIdentityKey,
          provider: String(account.provider || 'github'),
          resourceType: 'provider-session',
          resourceKeyHash: input.resourceKeyHash,
          reasonCode: input.reasonCode
        })
      } as unknown as Parameters<typeof disconnectProviderAccount>[0]);
      results.push(result);
      /* A retired account's local state waits for the operator; the accounts after it are still disconnected. */
      if (result.reasonCode === RETIRED_CLEANUP) continue;
      if (!result.providerStateRemoved) break;
      if (account.authMethod === 'github-app') {
        await deps.recordGithubAppAudit(
          bindingIdentityKey,
          'installation.disconnected',
          Number(account.installationId),
          { actor: call.retainedActor(req), status: 'disconnected' }
        );
      }
    }
    const retiredKeys = new Set(accounts
      .filter((account, index) => results[index] && results[index].reasonCode === RETIRED_CLEANUP)
      .map(hostedAccountKey));
    if (retiredKeys.size) {
      /* The operator's cleanup task is recorded; the retired credential itself leaves the session now. */
      const dropped = await store.mutateHostedProviderSession({
        testerId: alpha.testerId,
        sessionId: sid,
        mutate(current: Session) {
          const before = Array.isArray(current.accounts) ? current.accounts : [];
          const selected = before[Number(current.active) || 0];
          const kept = before.filter(account => !retiredKeys.has(hostedAccountKey(account)));
          const index = kept.indexOf(selected as Account);
          return { ...current, accounts: kept, active: index >= 0 ? index : Math.max(0, kept.findIndex(isGithubAccount)) };
        }
      });
      req.session = dropped.session;
      req[HOSTED_SESSION_BASE] = structuredClone(dropped.session);
      req[HOSTED_SESSION_REVISION] = dropped.revision;
    }
    return Object.freeze({
      complete: results.length === accounts.length
        && results.every(result => result.providerStateRemoved),
      supportedComplete: results.length === accounts.length
        && results.every(result => result.providerStateRemoved || result.reasonCode === RETIRED_CLEANUP),
      legacy: false,
      results: Object.freeze(results),
      manualCleanup: Object.freeze(results.filter(result => result.reasonCode === RETIRED_CLEANUP).map(result => result.revocationGuidance))
    });
  }

  function clearProviderSessionCookie(req: LifecycleRequest, res: unknown): void {
    const sid = call.sessionIdFromRequest(req);
    if (sid) deps.closeLiveSessions([sid], 'session-ended');
    call.writeCookie(res, '', 0);
  }

  /* Session ids as the inventory read them; the alpha's store checks each before it revokes, and the database compares them as text. */
  async function revokeContainedSessions(req: LifecycleRequest, sessionIds: readonly unknown[]): Promise<readonly unknown[]> {
    if (!sessionIds.length) return [];
    if (deps.alphaEnabled) {
      const result = await store.revokeOwnedProviderSessions({
        testerId: (req.alpha as Alpha).testerId,
        sessionIds
      });
      return [...result.revokedSessionIds];
    }
    await deps.pool().query('DELETE FROM nv_sessions WHERE sid = ANY($1::text[])', [sessionIds]);
    return sessionIds;
  }

  async function addAccount(req: LifecycleRequest, res: unknown, token: unknown, user: Fields | null | undefined, provider = 'github', baseUrl = '', options: Fields = { authMethod: 'token' }): Promise<void> {
    const authMethod = ['token', 'oauth', 'github-app'].includes(options && options.authMethod as string) ? options.authMethod : 'token';
    const existingSession = await call.sessionOf(req);
    const s: Session = existingSession || { accounts: [], active: 0 };
    const account: Account = {
      login: String(user && user.login || '').trim(),
      avatar: String(user && user.avatar_url || ''),
      providerAccountId: Number(user && user.id || 0),
      provider,
      baseUrl,
      authMethod
    };
    if (!account.login) throw Object.assign(new Error('Provider identity is incomplete'), { status: 502 });
    if (authMethod === 'github-app') {
      const extra = (options && options.account && typeof options.account === 'object' ? options.account : {}) as Fields;
      const installationId = Number(extra.installationId);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
        throw Object.assign(new Error('GitHub App installation account is invalid'), { status: 400, code: 'GITHUB_APP_ACCOUNT_INVALID' });
      }
      Object.assign(account, {
        installationId,
        installationAccountId: Number(extra.installationAccountId || 0),
        installationAccountType: cleanText(extra.installationAccountType || 'User', 40),
        repositorySelection: extra.repositorySelection === 'all' ? 'all' : 'selected',
        permissions: extra.permissions && typeof extra.permissions === 'object' ? { ...extra.permissions } : {},
        authorizedByLogin: cleanText(extra.authorizedByLogin || '', 100),
        authorizedById: Number(extra.authorizedById || 0),
        authorizedByIdentityKey: cleanText(extra.authorizedByIdentityKey || '', 128),
        installationHtmlUrl: cleanText(extra.installationHtmlUrl || '', 500),
        installationStatus: cleanText(extra.installationStatus || 'connected', 40),
        lastVerifiedAt: cleanText(extra.lastVerifiedAt || new Date().toISOString(), 80)
      });
      s.accounts = s.accounts.filter(a => !(
        a.authMethod === 'github-app' && Number(a.installationId) === installationId &&
        String(a.authorizedByIdentityKey || '') === account.authorizedByIdentityKey
      ));
    } else {
      account.token = String(token || '');
      if (!account.token) throw Object.assign(new Error('Provider credential is unavailable'), { status: 401 });
      s.accounts = s.accounts.filter(a => !(
        a.authMethod !== 'github-app' && a.login === account.login && (a.provider || 'github') === provider
      ));
    }
    account.identityKey = deps.alphaEnabled
      ? stableProviderIdentityKey(account)
      : identityKey(account);
    s.accounts.push(account);
    if (deps.alphaEnabled) {
      const current = deps.unseal(call.readCookie(req, 'nv_session') || '');
      const heldSid = current ? member(current, 'sid') : undefined;
      const held = typeof heldSid === 'string' && heldSid ? heldSid : '';
      const connect = (sessionId: string) => store.connectHostedProviderAccount({
        testerId: (req.alpha as Alpha).testerId,
        sessionId,
        account,
        authority: providerAuthority(account),
        capacity: deps.accountCap()
      });
      let sid = held || randomBytes(24).toString('hex');
      let connected;
      try {
        connected = await connect(sid).catch((error: { readonly code?: unknown } | null) => {
          /* A cookie naming a session that ended: this sign-in starts a new one. */
          if (!held || !error || error.code !== 'ALPHA_PROVIDER_SESSION_UNAVAILABLE') throw error;
          sid = randomBytes(24).toString('hex');
          return connect(sid);
        });
      } catch (error) {
        throw alphaConnectionRefusal(error);
      }
      req.session = connected.session;
      req[HOSTED_SESSION_BASE] = structuredClone(connected.session);
      req[HOSTED_SESSION_REVISION] = connected.revision;
      call.writeCookie(res, deps.seal({ sid }));
      return;
    }
    while (s.accounts.length > deps.accountCap()) s.accounts.shift();
    s.active = s.accounts.length - 1;
    /* Signing in with GitHub is the choice a retired selection asked for. */
    delete s.retiredSelection;
    deps.clearStepUpAuthorization(s);
    if (!existingSession && deps.databaseConfigured) {
      /* The cookie may still name a row this sign-in replaces, such as one that
         holds only retired provider accounts; its credentials go with it. */
      const replaced = call.sessionIdFromRequest(req);
      if (replaced) {
        await deps.pool().query('DELETE FROM nv_sessions WHERE sid=$1', [replaced]);
        deps.closeLiveSessions([replaced], 'session-ended');
      }
    }
    await call.setSession(req, res, s, { createNew: !existingSession });
  }

  async function sessionsForIdentity(req: LifecycleRequest) {
    const current = deps.unseal(call.readCookie(req, 'nv_session') || '');
    const sid = current ? member(current, 'sid') : undefined;
    const currentSid = sid ? sid : '';
    if (!currentSid || !(await deps.ready())) return { available: false, currentSid: '', rows: [] };
    const login = String((req.gh && req.gh.login) || '');
    const provider = String((req.gh && req.gh.provider) || 'github');
    const targetIdentity = identityKey(req.gh);
    let candidates: readonly Fields[];
    if (deps.alphaEnabled) {
      const owned = await deps.pool().query(
        `SELECT DISTINCT session.sid,session.data,session.updated
         FROM nv_sessions session
         JOIN nv_alpha_provider_session_ownership ownership
           ON ownership.session_key_hash=session.session_key_hash
        WHERE ownership.tester_id=$1
          AND ownership.identity_key=$2
          AND ownership.provider=$3
          AND ownership.released_at IS NULL
        ORDER BY session.updated DESC LIMIT 1000`,
        [(req.alpha as Alpha).testerId, targetIdentity, provider]
      );
      candidates = owned.rows || [];
    } else {
      const [indexed, legacy] = await Promise.all([
        deps.pool().query(
          'SELECT sid, data, updated FROM nv_sessions WHERE identity_keys @> ARRAY[$1]::text[] ORDER BY updated DESC LIMIT 1000',
          [targetIdentity]
        ),
        deps.pool().query(
          "SELECT sid, data, updated FROM nv_sessions WHERE cardinality(identity_keys)=0 ORDER BY updated DESC LIMIT 500"
        )
      ]);
      candidates = [...(indexed.rows || []), ...(legacy.rows || [])];
    }
    const rows: Fields[] = [];
    const seen = new Set();
    for (const row of candidates) {
      if (seen.has(row.sid)) continue;
      seen.add(row.sid);
      const decoded = deps.unseal(row.data as string);
      const accounts = decoded ? member(decoded, 'accounts') : undefined;
      if (!decoded || !Array.isArray(accounts)) continue;
      const matches = (accounts as Account[]).some(a => identityKey(a) === targetIdentity);
      if (matches) rows.push({ sid: row.sid, updated: row.updated, current: row.sid === currentSid, provider });
    }
    return { available: true, currentSid, login, provider, rows };
  }

  return { providerIdentity, disconnectAlphaProviderAccount, clearProviderSessionCookie, revokeContainedSessions, addAccount, sessionsForIdentity };
}

export type AccountLifecycle = ReturnType<typeof createAccountLifecycle>;
