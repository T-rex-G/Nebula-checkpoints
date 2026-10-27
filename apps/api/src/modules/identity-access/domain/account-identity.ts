/*
 * Who a signed-in account is, as the server names it, and which accounts it
 * serves.
 *
 * An account's identity key is the SHA-256 of what identifies it -- provider,
 * server and login, or for a GitHub App installation the installation and the
 * login that authorized it -- never the login itself. An account that already
 * carries a key in that shape keeps it. The stable provider identity is what
 * the alpha binds a tester to: the provider's own account id where there is
 * one, so a renamed login is still the same person.
 *
 * Only GitHub accounts on github.com are served. A session can still hold an
 * account of another kind, written before that was so; it keeps the account
 * for retention and cleanup, and a request cannot act through it.
 */
import { IDENTITY_KEY } from '../../../../../../packages/contracts/src/ids.ts';
import { hashJson } from '../../../platform/values/stable-hash.ts';

/* The parts of an account these rules read. Every one may be missing on an account an old cookie carries. */
export interface AccountLike {
  readonly provider?: unknown;
  readonly baseUrl?: unknown;
  readonly login?: unknown;
  readonly identityKey?: unknown;
  readonly authMethod?: unknown;
  readonly installationId?: unknown;
  readonly installationAccountId?: unknown;
  readonly authorizedByLogin?: unknown;
  readonly providerAccountId?: unknown;
}

type Account = AccountLike | null | undefined;

export function identityKey(account: Account): string {
  if (account && IDENTITY_KEY.test(String(account.identityKey || ''))) {
    return String(account.identityKey);
  }
  const base = { provider: account && account.provider || 'github', baseUrl: account && account.baseUrl || '', login: account && account.login || '' };
  if (account && account.authMethod === 'github-app') {
    return hashJson({
      ...base,
      authMethod: 'github-app',
      installationId: Number(account.installationId || 0),
      authorizedByLogin: String(account.authorizedByLogin || '').toLowerCase()
    });
  }
  return hashJson(base);
}

/* The host an account's provider answers on: github.com for GitHub, the base URL's host otherwise, or nothing. */
export function providerAuthority(account: Account): string {
  if ((account && account.provider || 'github') === 'github') return 'github.com';
  try { return new URL(String(account && account.baseUrl || '')).host.toLowerCase(); }
  catch { return ''; }
}

export function stableProviderIdentityKey(account: Account): string {
  const provider = String(account && account.provider || 'github');
  const authority = providerAuthority(account);
  if (account && account.authMethod === 'github-app') {
    return hashJson({
      domain: 'nv-alpha-provider-identity/github-app/v1',
      provider,
      authority,
      authMethod: 'github-app',
      installationId: Number(account.installationId || 0),
      installationAccountId: Number(account.installationAccountId || 0)
    });
  }
  const providerAccountId = Number(account && account.providerAccountId || 0);
  if (Number.isSafeInteger(providerAccountId) && providerAccountId > 0) {
    return hashJson({
      domain: 'nv-alpha-provider-identity/account/v1',
      provider,
      authority,
      providerAccountId
    });
  }
  return identityKey(account);
}

/* Refuses an account this server does not serve, as an answer a request can be given. */
export function assertGithubAccount(account: unknown): void {
  const value = account as AccountLike | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.provider !== undefined && value.provider !== 'github')) {
    throw Object.assign(new Error('Only GitHub accounts are supported. Sign in with GitHub.'), {
      status: 401, code: 'PROVIDER_UNSUPPORTED'
    });
  }
  if (value.baseUrl && value.baseUrl !== 'https://github.com') {
    throw Object.assign(new Error('Custom Git server URLs are not supported'), {
      status: 401, code: 'PROVIDER_AUTHORITY_UNSUPPORTED'
    });
  }
}

export function isGithubAccount(account: unknown): boolean {
  try { assertGithubAccount(account); return true; } catch { return false; }
}

export interface SessionAccounts {
  readonly accounts?: unknown;
  readonly active?: unknown;
  readonly security?: unknown;
  readonly [field: string]: unknown;
}

/*
 * The session as a request may act through it: its GitHub accounts only, or
 * none at all. A session holding nothing else is returned as it is. One that
 * also holds retired accounts keeps them stored, for retention and cleanup,
 * and is read without them; if the selected account is one of them, the
 * session says so (retiredSelection) rather than quietly selecting a GitHub
 * account in its place, and any step-up it held is dropped: the person chooses
 * which identity acts.
 */
export function githubSession<S extends SessionAccounts>(session: S | null | undefined): S | (S & { accounts: unknown[]; active: number; retiredSelection: boolean; security: object }) | null {
  if (!session || !Array.isArray(session.accounts)) return null;
  const held: unknown[] = session.accounts;
  const selected = held[Math.min(Math.max(Number(session.active) || 0, 0), held.length - 1)];
  const accounts = held.filter(isGithubAccount);
  if (!accounts.length) return null;
  if (accounts.length === held.length) return session;
  const index = accounts.indexOf(selected);
  return { ...session, accounts, active: Math.max(0, index), retiredSelection: index < 0, security: { ...(session.security as object), stepUp: null } };
}

/*
 * retiredSelection is computed by githubSession() on each read, from the
 * accounts the session holds. Stored, it would outlive the choice that cleared
 * it, and every provider route would keep asking for an account.
 */
export function persistedSession<S>(data: S): S {
  if (!data || typeof data !== 'object' || !('retiredSelection' in data)) return data;
  const { retiredSelection, ...stored } = data as S & { retiredSelection: unknown };
  void retiredSelection;
  return stored as S;
}
