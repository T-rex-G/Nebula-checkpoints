/*
 * The accounts sheet: the reader's accounts, the one in use, and switching,
 * removing one, adding one, and signing out of all.
 *
 * Only a GitHub account can be in use. A GitLab or Gitea account from before
 * is listed only so it can be removed: it is never switched to and nothing is
 * loaded from its old host, and the sheet says what to do about its token.
 *
 * An account change is an identity boundary crossed in the open. What the
 * page held is let go of before the server is asked, and the page then starts
 * again as whoever the server answers for -- whether it made the change or
 * refused it, for a refusal used to leave the page let go of and nobody's.
 * The sheet stays up, its controls held, until that start has ended, and only
 * then is the reader told the change is made. A removal the provider has not
 * finished is not a removal: the account is still signed in, so nothing more
 * is let go of, no other tab is told, and the reader is told it is pending.
 */
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import { field, items } from '../../platform/values.ts';
import type { RequestOptions } from '../../platform/transport.ts';
import type { ModalRequest } from '../../components/modal.ts';
import { githubIdentity } from './session.ts';

export const GITHUB_MARK = '<svg class="prov-ico" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2a10 10 0 0 0-3.16 19.5c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.1.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .26.18.58.69.48A10 10 0 0 0 12 2z"/></svg>';

/* The accounts as the server lists them, and whether this deployment offers the wider grant. */
export interface AccountsView {
  readonly accounts: unknown;
  readonly active: unknown;
  readonly oauthOn: boolean;
}

/* The sheet's body: the lead for retired accounts, a row for each account, and the sheet's own actions. */
export function accountsBody(view: AccountsView): string {
  const accounts = items(view.accounts).map((account, index) => ({ account, index }));
  /* The account in use, read as the list reads it: by the position the server names. */
  const active = field(view.accounts, String(view.active));
  const retiredCount = accounts.filter(({ account }) => !githubIdentity(account)).length;
  const retiredActive = !githubIdentity(active);
  const lead = retiredCount
    ? `<p class="hint acct-lead">${retiredActive ? 'Choose a GitHub account to continue. ' : ''}GitLab and Gitea accounts are no longer supported. Remove ${retiredCount === 1 ? 'it' : 'them'}, then revoke ${retiredCount === 1 ? 'its token' : 'their tokens'} in that provider's settings.</p>`
    : '';
  const login = (account: unknown): string => escapeHtml(field(account, 'login'));
  const rows = accounts.map(({ account, index }) => {
    const inUse = index === view.active;
    if (githubIdentity(account)) {
      const avatar = String(field(account, 'avatar') || '');
      return `
      <div class="acct-row ${inUse ? 'active' : ''}">
        ${/^https:\/\//i.test(avatar) ? `<img class="avatar" src="${escapeAttribute(field(account, 'avatar'))}" alt="">` : '<span class="avatar acct-avatar-empty" aria-hidden="true"></span>'}
        <div class="acct-meta">
          <div class="acct-login">${login(account)}</div>
          <div class="acct-host">${GITHUB_MARK}<span>github.com</span></div>
        </div>
        <div class="acct-actions">
          ${inUse ? '<span class="br-tag">active</span>'
            : `<button class="btn btn-ghost small" data-switch="${index}">Switch</button>`}
          <button class="btn btn-ghost small danger" data-remove="${index}" title="Sign out this account only">Remove</button>
        </div>
      </div>`;
    }
    return `
      <div class="acct-row retired">
        <span class="avatar acct-retired-mark" aria-hidden="true"></span>
        <div class="acct-meta">
          <div class="acct-login">${login(account)}</div>
          <div class="acct-host"><span>${field(account, 'provider') === 'gitea' ? 'Gitea' : 'GitLab'} · no longer supported</span></div>
        </div>
        <div class="acct-actions">
          <button class="btn btn-ghost small danger" data-remove="${index}" title="Remove this account and its stored token">Remove</button>
        </div>
      </div>`;
  }).join('');
  const widerGrant = githubIdentity(active) && field(active, 'authMethod') === 'oauth' && view.oauthOn
    ? '<a class="btn btn-ghost small" href="/api/oauth/login?permission=repository-delete">Allow repository deletion on GitHub</a>' : '';
  return `${lead}${rows}
      <div class="detail-actions" style="margin-top:14px">
        <button class="btn btn-ghost small" id="accAdd">Add account</button>
        ${widerGrant}
        <button class="btn btn-ghost small danger" id="accOut">Sign out (all)</button>
      </div>`;
}

const pending = (answer: unknown): boolean => field(answer, 'ok') === false && field(answer, 'status') === 'pending';

export const REMOVAL_PENDING = 'Removing that account is waiting on the provider\'s clean-up. It is still signed in; try again shortly.';

interface Control {
  disabled: boolean;
  readonly dataset: { readonly switch?: string; readonly remove?: string };
  addEventListener(type: 'click', listener: () => void): void;
}

export interface AccountsDialogDeps {
  readonly api: (path: string, options?: RequestOptions) => Promise<unknown>;
  readonly modal: (request: ModalRequest) => unknown;
  /* Whether the dialog is still the one this sheet opened. */
  readonly owner: () => () => boolean;
  readonly generation: () => unknown;
  readonly closeModal: (confirmed: boolean) => void;
  readonly setBody: (html: string) => void;
  readonly controls: (selector: string) => readonly Control[];
  readonly oauthOn: () => boolean;
  /* The account boundary (account-boundary.ts). */
  readonly purge: (full: boolean) => Promise<void>;
  readonly broadcast: () => void;
  /* The page: its address cleared, started again, the sign-in shown, what this tab remembers forgotten. */
  readonly clearAddress: () => void;
  readonly restart: () => Promise<unknown>;
  readonly forgetRemembered: () => void;
  readonly showSignIn: () => void;
  /* Adding an account is signing in from the sign-in screen, with a way back. */
  readonly addAccount: () => void;
  readonly signOut: () => unknown;
  readonly toast: (message: string, kind?: string) => void;
  readonly showRevocationGuidance: (guidance: unknown) => unknown;
}

export interface AccountsDialog {
  open(): Promise<void>;
}

export function createAccountsDialog(deps: AccountsDialogDeps): AccountsDialog {
  async function open(): Promise<void> {
    deps.modal({ title: 'Accounts', okText: 'Done', bodyHTML: '<div class="skeleton" style="height:60px"></div>' });
    const ownsModal = deps.owner();
    const sheet = deps.generation();
    try {
      const answer = await deps.api('/api/accounts');
      if (!ownsModal()) return;
      deps.setBody(accountsBody({ accounts: field(answer, 'accounts'), active: field(answer, 'active'), oauthOn: deps.oauthOn() }));
      /* Only what it held is released: by then the dialog may be another's, with controls of its own to keep. */
      const holdSheet = (): (() => void) => {
        const held = deps.controls('#modalBody button').filter(control => !control.disabled);
        for (const control of held) control.disabled = true;
        return () => { for (const control of held) control.disabled = false; };
      };
      const leaveSheet = (): void => { if (deps.generation() === sheet) deps.closeModal(true); };

      /* A start that fails says so itself; the press has nothing to add to it. */
      const quietly = (work: Promise<void>): void => { work.catch(() => {}); };
      for (const control of deps.controls('#modalBody [data-switch]')) {
        control.addEventListener('click', () => { quietly(switchTo(Number(control.dataset.switch))); });
      }
      for (const control of deps.controls('#modalBody [data-remove]')) {
        control.addEventListener('click', () => { quietly(remove(Number(control.dataset.remove))); });
      }
      for (const control of deps.controls('#accAdd')) control.addEventListener('click', () => { deps.closeModal(true); deps.addAccount(); });
      for (const control of deps.controls('#accOut')) control.addEventListener('click', () => { deps.closeModal(true); void deps.signOut(); });

      async function switchTo(index: number): Promise<void> {
        const release = holdSheet();
        let out: unknown = null;
        try {
          await deps.purge(false);
          out = await deps.api('/api/accounts/switch-idx', { method: 'POST', body: { idx: index } });
          deps.broadcast();
          deps.clearAddress();
        } catch (error) { deps.toast(error instanceof Error ? error.message : String(error), 'err'); }
        try {
          await deps.restart();
        } finally {
          release();
          if (out) {
            leaveSheet();
            deps.toast(`Switched to ${String(field(out, 'login'))} ✦`, 'ok');
          }
        }
      }

      async function remove(index: number): Promise<void> {
        const release = holdSheet();
        let out: unknown = null;
        try {
          await deps.purge(false);
          const answer = await deps.api('/api/accounts/remove', { method: 'POST', body: { idx: index } });
          if (pending(answer)) {
            deps.toast(REMOVAL_PENDING);
          } else {
            out = answer;
            await deps.purge(!!field(out, 'empty'));
            deps.broadcast();
          }
        } catch (error) { deps.toast(error instanceof Error ? error.message : String(error), 'err'); }
        try {
          /* The last account gone, there is nobody to start as: the page goes back to sign-in. */
          if (out && field(out, 'empty')) {
            deps.forgetRemembered();
            deps.showSignIn();
          } else {
            if (out) deps.clearAddress();
            await deps.restart();
          }
        } finally {
          release();
          if (out) {
            leaveSheet();
            deps.toast(`${String(field(out, 'removed') || 'The account')} signed out ✦`, 'ok');
            deps.showRevocationGuidance(field(out, 'revocationGuidance'));
          }
        }
      }
    } catch (error) {
      if (ownsModal()) deps.setBody(`<p class="hint">⚠ ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`);
    }
  }

  return { open };
}
