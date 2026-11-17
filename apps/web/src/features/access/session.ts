/*
 * Signing in with a token and signing out: who the session is, and the page
 * held to it.
 *
 * Signing in crosses the account boundary before the server is asked, so a
 * reading for whoever was here before can never land for whoever arrives.
 * When the attempt fails -- a mistyped token while adding an account -- the
 * server still answers for the reader who was signed in, but the page has
 * already let go of everything it held for them; going back to the workspace
 * then starts the page again as that reader, rather than showing an empty
 * workspace that belongs to nobody.
 *
 * Signing out lets go of this browser's data whatever the server answers,
 * even when it cannot be reached -- except when the server says the sign-out
 * is still in progress: the provider's clean-up is not finished and the
 * session is still there, so nothing is let go, the other tabs are not told,
 * and the reader is asked to try again. One sign-out at a time: a second
 * press while the first is on its way is the same sign-out, not a second
 * request that comes back "not signed in".
 */
import type { RequestOptions } from '../../platform/transport.ts';

export interface GithubAccount {
  readonly provider: 'github';
  readonly login?: string;
  readonly avatar?: string;
  readonly caps?: unknown;
  readonly [field: string]: unknown;
}

/* Whether an answer names a GitHub account: the only kind this deployment signs in. */
export function githubIdentity(account: unknown): account is GithubAccount {
  return !!account && typeof account === 'object' && (account as { provider?: unknown }).provider === 'github';
}

/* The GitHub account an answer names, or the refusal a page shows for one that names none. */
export function requireGithubIdentity(account: unknown): GithubAccount {
  if (!githubIdentity(account)) {
    const error = new Error('Connect a GitHub account to continue.') as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  return account;
}

const pending = (result: unknown): boolean => !!result && typeof result === 'object'
  && (result as { ok?: unknown }).ok === false && (result as { status?: unknown }).status === 'pending';

export interface SessionDeps {
  readonly api: (path: string, options?: RequestOptions) => Promise<unknown>;
  /* The account boundary (account-boundary.ts). */
  readonly purge: (full: boolean) => Promise<void>;
  readonly broadcast: () => void;
  /* The sign-in form: the token typed, its error line, its button, and the way back to a workspace. */
  readonly token: () => string;
  readonly clearToken: () => void;
  readonly hideError: () => void;
  readonly setBusy: (busy: boolean) => void;
  readonly backShown: () => boolean;
  readonly showBack: (shown: boolean) => void;
  /* Who the page is for, and what it remembers of them in this tab. */
  readonly adopt: (me: GithubAccount | null) => void;
  readonly adoptCapabilities: (caps: unknown) => void;
  readonly remember: (me: GithubAccount) => void;
  readonly loadProviderCapabilities: () => Promise<void>;
  readonly applyCaps: () => void;
  readonly setAvatar: (url: unknown) => void;
  readonly toast: (message: string, kind?: string) => void;
  readonly presentError: (error: unknown) => void;
  readonly showRevocationGuidance: (guidance: unknown) => unknown;
  /* Where a reader goes: the workspace once signed in, the sign-in once out, the workspace from the sign-in. */
  readonly arrive: () => void;
  readonly showSignIn: () => void;
  readonly showWorkspace: () => void;
  /* Start the page again as whoever the server answers for. */
  readonly restart: () => unknown;
}

export interface Session {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /* The sign-in's way back to the workspace. */
  back(): void;
}

export function createSession(deps: SessionDeps): Session {
  /* Set when a failed attempt let go of a workspace the server still answers for. */
  let workspaceLetGo = false;
  let leaving: Promise<void> | null = null;

  async function signIn(): Promise<void> {
    const token = deps.token();
    deps.hideError();
    if (!token) return;
    deps.setBusy(true);
    try {
      await deps.purge(true);
      let me = requireGithubIdentity(await deps.api('/api/login', { method: 'POST', body: { token, provider: 'github' } }));
      deps.adopt(me);
      try {
        const fresh = requireGithubIdentity(await deps.api('/api/me'));
        me = { ...me, ...fresh };
        deps.adopt(me);
        deps.adoptCapabilities(fresh.caps || null);
        deps.remember(me);
        await deps.loadProviderCapabilities();
      } catch { /* Signed in all the same: what /api/me adds is read again on the next start. */ }
      workspaceLetGo = false;
      deps.broadcast();
      deps.showBack(false);
      deps.applyCaps();
      deps.clearToken();
      deps.setAvatar(me.avatar);
      deps.toast(`Welcome aboard, ${String(me.login)} ✦`, 'ok');
      deps.arrive();
    } catch (error) {
      if (deps.backShown()) workspaceLetGo = true;
      deps.hideError();
      deps.presentError(error);
    } finally {
      deps.setBusy(false);
    }
  }

  function back(): void {
    deps.showBack(false);
    if (workspaceLetGo) {
      workspaceLetGo = false;
      deps.restart();
      return;
    }
    deps.showWorkspace();
  }

  async function leave(): Promise<void> {
    let remoteError: unknown = null;
    let result: unknown = null;
    try {
      result = await deps.api('/api/logout', { method: 'POST' });
    } catch (error) {
      remoteError = error;
    }
    if (pending(result)) {
      deps.toast('Sign-out is waiting on the provider\'s clean-up. You are still signed in; keep this page open and sign out again shortly.');
      return;
    }
    await deps.purge(true);
    deps.broadcast();
    deps.adopt(null);
    deps.showSignIn();
    if (remoteError) deps.presentError(remoteError);
    else if (result) deps.showRevocationGuidance((result as { revocationGuidance?: unknown }).revocationGuidance);
  }

  function signOut(): Promise<void> {
    if (!leaving) leaving = leave().finally(() => { leaving = null; });
    return leaving;
  }

  return { signIn, signOut, back };
}
