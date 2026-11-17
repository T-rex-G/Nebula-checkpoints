/*
 * Step-up: a sensitive action authorized once, now, by the reader at the
 * keyboard.
 *
 * Before the page sends an action the server marks sensitive -- deleting a
 * repository, taking an emergency control, rotating a key -- it asks the
 * server for a grant bound to exactly that action and scope: short-lived and
 * good once. To get one the reader types the active account's login, and,
 * signed in with a token, the token again. Signed in through GitHub, allowing
 * the app decided whether the account may do this at all; this decides
 * whether to do it now, and the server checks the authorization with the
 * provider again.
 *
 * The login must match exactly, and the server says no more than that a
 * mismatch is one -- it must not echo back what was typed. So the comparison
 * is made here too, where both strings are in hand and the difference can be
 * named before a request is spent on it. A phone keyboard is why: iOS
 * autocorrect and smart punctuation are on by default and are not turned off
 * by spellcheck, so a login with hyphens comes back with en-dashes. The
 * fields decline those keyboard features outright; this catches whatever
 * still slips through. Both fields are emptied as soon as they are read.
 */
import { STEP_UP_HEADER } from '../../../../../packages/contracts/src/api-envelope.ts';
import type { ModalRequest } from '../../components/modal.ts';
import type { RequestOptions } from '../../platform/transport.ts';
import { escapeHtml } from '../../platform/html.ts';
import { field } from '../../platform/values.ts';

/* The header the grant travels in: the contract's own name. */
export { STEP_UP_HEADER };

/* What the reader is asked: the action named, the login to type, and the token where the session holds one. */
export function stepUpBody(label: string, login: string, tokenMethod: boolean): string {
  return `<p style="font-size:.9rem;line-height:1.6"><b>${escapeHtml(label)}</b> requires a short-lived, single-use authorization bound to this exact operation.</p>
      <label class="field-label" for="stepUpLogin">Type the active account login <b class="mono">${escapeHtml(login)}</b></label>
      <input id="stepUpLogin" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" inputmode="text">
      ${tokenMethod ? `<label class="field-label" for="stepUpCredential">Re-enter the current provider token</label><input id="stepUpCredential" type="password" autocomplete="off" spellcheck="false">` : `<p class="hint">Allowing this on GitHub decides whether the account <em>may</em> do it at all, once. This is the separate question of whether to do it <em>now</em>: the authorization is checked against the provider again, lasts five minutes, and works a single time.</p>`}`;
}

/* The words for a login typed that is not the login asked for. */
export function mismatchMessage(login: string): string {
  return `That does not match ${login} exactly — check for autocorrect changing the dashes or the capitals.`;
}

interface Field {
  value: string;
}

export interface StepUpDeps {
  readonly modal: (request: ModalRequest) => Promise<boolean>;
  readonly api: (path: string, opts?: RequestOptions) => Promise<unknown>;
  readonly toast: (message: string, kind?: 'ok' | 'err' | '') => unknown;
  /* Who is signed in: their login, and how they signed in. */
  readonly identity: () => unknown;
  /* The dialog's field of this id, while it is on the page. */
  readonly field: (id: 'stepUpLogin' | 'stepUpCredential') => Field | null;
}

export interface StepUp {
  /* A grant for this action and scope, or '' when the reader declined or typed another login. */
  request(action: string, scope: unknown, label?: string): Promise<string>;
  /* The request sent with a grant, or null when no grant was given. */
  send(action: string, scope: unknown, path: string, opts?: RequestOptions, label?: string): Promise<unknown>;
}

export function createStepUp(deps: StepUpDeps): StepUp {
  async function request(action: string, scope: unknown, label = 'sensitive action'): Promise<string> {
    const me = deps.identity();
    const login = field(me, 'login');
    if (!me || !login) throw new Error('Sign in before authorizing a sensitive action');
    const signedIn = String(login);
    const tokenMethod = String(field(me, 'authMethod') || 'token') === 'token';
    const ok = await deps.modal({ title: 'Verify sensitive action', danger: true, okText: 'Authorize once', bodyHTML: stepUpBody(label, signedIn, tokenMethod) });
    if (!ok) return '';
    const loginField = deps.field('stepUpLogin');
    const credentialField = tokenMethod ? deps.field('stepUpCredential') : null;
    const confirm = (loginField ? loginField.value : '').trim();
    const credential = credentialField ? credentialField.value.trim() : '';
    if (loginField) loginField.value = '';
    if (credentialField) credentialField.value = '';
    if (confirm !== signedIn) {
      deps.toast(mismatchMessage(signedIn), 'err');
      return '';
    }
    const result = await deps.api('/api/security/step-up', { method: 'POST', body: { action, scope, confirm, ...(tokenMethod ? { credential } : {}) } });
    const grant = field(result, 'grant');
    return typeof grant === 'string' ? grant : '';
  }

  async function send(action: string, scope: unknown, path: string, opts: RequestOptions = {}, label?: string): Promise<unknown> {
    const grant = await request(action, scope, label);
    if (!grant) return null;
    return deps.api(path, { ...opts, headers: { ...(opts.headers || {}), [STEP_UP_HEADER]: grant } });
  }

  return { request, send };
}
