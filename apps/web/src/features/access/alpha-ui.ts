/*
 * Controlled public-alpha access, readiness, and session-state UI.
 *
 * The access page's markup is the page's own (index.html, #page-alpha-access);
 * this decides what it says and shows: whether entry is open or by
 * invitation, whether the service is awake, why a sign-in did not finish, and
 * when the gate hands over to the workspace.
 */
import { APP_HEADER, APP_HEADER_VALUE } from '../../../../../packages/contracts/src/api-envelope.ts';
import { field, hasFields } from '../../platform/values.ts';
import type { Fields } from '../../platform/values.ts';

const RETRY_DELAYS: readonly number[] = Object.freeze([1000, 2000, 4000, 8000]);
const GENERIC_INVITE_ERROR = 'Invitation could not be redeemed. Check the invitation and try again.';

/* What /api/alpha/status answered, as the server sent it; read through field(). */
let status: Fields | null = null;
let redeemBound = false;
/*
 * Why a sign-in did not finish, held for as long as this screen lasts.
 *
 * showOpenAccess() clears the error region when it draws -- it is redrawing
 * the card, and a stale redemption failure must not outlive the form it came
 * from. The callback's answer is not stale: it is the reason this load
 * exists, so it is re-applied rather than wiped.
 */
let entryNotice = '';

const byId = (id: string): HTMLElement | null => document.getElementById(id);
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds); });
const word = (name: string): string => {
  const value = field(status, name);
  return typeof value === 'string' ? value : '';
};

function activateAccessPage(): void {
  document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
  const page = byId('page-alpha-access');
  if (page) page.classList.add('active');
  window.scrollTo(0, 0);
}

export function showWaking(message = 'Checking service readiness…'): void {
  const target = byId('alphaWakeState');
  if (target) target.textContent = message;
}

export function showTerms(version: unknown): void {
  const target = byId('alphaTermsVersion');
  if (target) target.textContent = version ? `Terms ${String(version)}` : 'Current alpha terms';
}

function showAccessError(message: string): void {
  const target = byId('alphaAccessError');
  if (!target) return;
  target.textContent = message;
  target.hidden = !message;
}

/*
 * The invitation form is the only way in when the gate is on, and means
 * nothing when it is off -- there is no code to redeem. Rather than wrap
 * these in a container, each is hidden by id: the browser suite finds this
 * card by the names a reader reads, and a new wrapper around them is a
 * structural change for no gain.
 */
function setInviteFormHidden(hidden: boolean): void {
  for (const id of ['alphaInviteInput', 'alphaTermsAccept', 'alphaRedeemBtn']) {
    const element = byId(id);
    if (element) element.hidden = hidden;
  }
  for (const id of ['alphaInviteInput', 'alphaTermsAccept']) {
    const label = document.querySelector<HTMLElement>(`label[for="${id}"]`);
    if (label) label.hidden = hidden;
  }
}

function setOpenAccessHidden(hidden: boolean): void {
  const open = byId('alphaOpenAccess');
  if (open) open.hidden = hidden;
}

/* The landing's closing call names the same way in as the card it returns the reader to. */
function labelClosingCall(text: string): void {
  const call = document.querySelector('.lp-cta-btn');
  if (call) call.textContent = text;
}

function announce(name: 'nebula:alpha-access-gated' | 'nebula:alpha-access-granted'): void {
  window.dispatchEvent(new CustomEvent(name));
}

function adopt(nextStatus: unknown): void {
  if (hasFields(nextStatus)) status = nextStatus;
}

/*
 * Entry is open: the gate is configured off, so there is no invitation to
 * redeem and nothing to check. The landing page stays rather than handing
 * over on its own -- it used to hand over, and that was the flash: the page
 * was raised and taken away a beat later. The front door should not do that,
 * and a visitor who wants past it can say so.
 */
export function showOpenAccess(nextStatus: unknown = status): void {
  adopt(nextStatus);
  activateAccessPage();
  showTerms(word('termsVersion'));
  showAccessError(entryNotice);
  setInviteFormHidden(true);
  setOpenAccessHidden(false);
  /*
   * Which way through depends on who is asking. A session that is already
   * signed in has a workspace to return to; one that is not has to sign in
   * first, and saying so is the difference between a button and a guess.
   */
  const signedIn = Boolean(field(status, 'authenticated'));
  const note = byId('alphaOpenNote');
  if (note) {
    note.textContent = signedIn
      ? 'Entry is open, and this session is already signed in.'
      : 'Entry is open. No invitation is needed while the gate is off.';
  }
  const pass = byId('alphaPassThrough');
  if (pass) pass.textContent = signedIn ? 'Open your workspace' : 'Get started';
  /* The closing call says what the first screen says: with the gate off there is nothing to request. */
  labelClosingCall(signedIn ? 'Open your workspace' : 'Get started');
  announce('nebula:alpha-access-gated');
}

/*
 * Whether the deployment runs a controlled alpha at all.
 *
 * The gate decides more than the front door. An invitation, a tester label,
 * an alpha session to end, alpha data to delete -- none of those exist when
 * the operator has the gate off, and every /api/alpha/* route answers 404 in
 * that mode. Unknown reads as off: when the status never landed, or named no
 * mode, the honest thing is to withhold controls whose entire purpose is a
 * session we cannot confirm exists. Written as the exact complement of the
 * test boot() makes, rather than an equality against the one mode that turns
 * the gate on, so the client never disagrees with itself.
 */
export function gateEnabled(): boolean {
  const mode = field(status, 'mode');
  return Boolean(mode) && mode !== 'off';
}

/*
 * The door is open but leads nowhere: with the database behind, /api/me and
 * /api/login answer 503, so a reader who takes this door reaches a sign-in
 * screen that cannot succeed and is returned here. Say what is actually
 * wrong instead of offering the trip.
 */
function closeOpenAccess(): void {
  const note = byId('alphaOpenNote');
  if (note) note.textContent = 'Entry is open, but the workspace is temporarily unavailable. Nothing behind this door can answer yet.';
  const pass = byId('alphaPassThrough');
  if (pass instanceof HTMLButtonElement) {
    pass.disabled = true;
    pass.textContent = 'Workspace unavailable';
  }
}

export function showAccessGate(nextStatus: unknown = status): void {
  adopt(nextStatus);
  activateAccessPage();
  setOpenAccessHidden(true);
  setInviteFormHidden(false);
  labelClosingCall('Request entry');
  showTerms(word('termsVersion'));
  const terms = byId('alphaTermsAccept');
  if (terms instanceof HTMLInputElement) terms.checked = false;
  const invite = byId('alphaInviteInput');
  /* preventScroll: the gate sits on the landing page, and focusing an input scrolls it into view -- 323px past the headline. */
  if (invite) invite.focus({ preventScroll: true });
  /*
   * Announced for the same reason the granted side is: the gate takes the
   * screen, and the chrome belonging to whatever it replaced has to go with
   * it. Said here rather than by each caller, because every path that raises
   * the gate owes the same cleanup.
   */
  announce('nebula:alpha-access-gated');
}

/* A refusal from the server: its status and its code, beside its words. */
class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function jsonRequest(path: string, options: RequestInit = {}): Promise<Fields> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      [APP_HEADER]: APP_HEADER_VALUE,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(hasFields(options.headers) ? options.headers : {})
    }
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const said = field(body, 'error');
    throw new RequestError(typeof said === 'string' && said ? said : `Request failed (${response.status})`, response.status, String(field(body, 'code') || ''));
  }
  return hasFields(body) ? body : {};
}

async function waitUntilReady(): Promise<boolean> {
  for (const wait of RETRY_DELAYS) {
    try {
      const ready = await jsonRequest('/readyz');
      if (field(ready, 'ok')) {
        showWaking('Ready');
        return true;
      }
      showWaking(field(ready, 'database') === 'unavailable' ? 'Waking database' : 'Waking service');
    } catch (error) {
      showWaking(error instanceof RequestError && error.status === 503 ? 'Waking database' : 'Waking service');
    }
    await delay(wait);
  }
  showWaking('Temporarily unavailable');
  return false;
}

async function redeemInvitation(): Promise<void> {
  const invite = byId('alphaInviteInput');
  const terms = byId('alphaTermsAccept');
  const button = byId('alphaRedeemBtn');
  showAccessError('');
  if (!(terms instanceof HTMLInputElement) || !terms.checked) {
    showAccessError('Accept the current alpha terms before continuing.');
    if (terms) terms.focus();
    return;
  }
  const code = invite instanceof HTMLInputElement ? invite.value.trim() : '';
  const termsVersion = word('termsVersion');
  if (!code || !termsVersion) {
    showAccessError(GENERIC_INVITE_ERROR);
    return;
  }
  if (button instanceof HTMLButtonElement) button.disabled = true;
  const request = jsonRequest('/api/alpha/redeem', {
    method: 'POST',
    body: JSON.stringify({ code, acceptedTermsVersion: termsVersion })
  });
  /* The one-time code leaves the field the moment it is sent. */
  if (invite instanceof HTMLInputElement) invite.value = '';
  try {
    await request;
    showAccessError('');
    announce('nebula:alpha-access-granted');
  } catch {
    showAccessError(GENERIC_INVITE_ERROR);
    if (invite) invite.focus({ preventScroll: true });
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

function bindRedemption(): void {
  if (redeemBound) return;
  redeemBound = true;
  const button = byId('alphaRedeemBtn');
  const invite = byId('alphaInviteInput');
  if (button) button.addEventListener('click', () => { void redeemInvitation(); });
  if (invite) invite.addEventListener('keydown', event => { if (event.key === 'Enter') void redeemInvitation(); });
  /* The same event the redemption path fires. app.js guards its own boot against a second call, so pressing this twice costs nothing. */
  const pass = byId('alphaPassThrough');
  if (pass) pass.addEventListener('click', () => announce('nebula:alpha-access-granted'));
}

/*
 * The provider sign-in ends here, whichever way it went: app.js does not run
 * until the gate has handed over, so on an open deployment, where the reader
 * stays at the door, a failed sign-in would otherwise say nothing at all.
 */
const OAUTH_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  state_mismatch: 'that sign-in did not match this browser session. Start it again from this page.',
  provider_unreadable: 'GitHub did not answer in a form we could read. It may be rate-limiting; try again shortly.',
  bad_verification_code: 'that sign-in link had already been used. Start a fresh one.',
  exchange_failed: 'GitHub declined the sign-in.',
  unexpected: 'something failed part-way through.'
});

/* The words for why a sign-in did not finish, from the marker it came back with. */
export function oauthFailureNotice(failure: string): string {
  if (!failure) return '';
  const known = Object.hasOwn(OAUTH_FAILURES, failure) ? OAUTH_FAILURES[failure] : undefined;
  return `Could not finish signing in with GitHub — ${known || `it failed (${failure.replace(/_/g, ' ')}).`}`;
}

function takeCallbackMarkers(): { failure: string; entered: boolean } {
  const params = new URLSearchParams(window.location.search);
  const failure = params.get('oauth') || '';
  const entered = params.get('entered') === '1';
  if (!failure && !entered) return { failure: '', entered: false };
  params.delete('oauth');
  params.delete('entered');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  return { failure, entered };
}

export type BootReason = 'unavailable' | 'revoked' | 'expired' | 'entered' | 'open' | 'access-required';

export interface BootResult {
  readonly allowed: boolean;
  readonly reason?: BootReason;
  readonly status?: Fields;
}

export function showExpired(code: 'ALPHA_ACCESS_REVOKED' | 'ALPHA_SESSION_EXPIRED' | string): void {
  showAccessGate(status);
  showWaking('Ready');
  showAccessError(code === 'ALPHA_ACCESS_REVOKED'
    ? 'This alpha access was revoked. Request a new invitation from the operator.'
    : 'This alpha session expired. Redeem a new invitation to continue.');
}

export async function boot(): Promise<BootResult> {
  bindRedemption();
  activateAccessPage();
  const callback = takeCallbackMarkers();
  entryNotice = oauthFailureNotice(callback.failure);
  showAccessError(entryNotice);
  showWaking();
  /*
   * Both at once, because they answer different questions. Readiness is about
   * the database; the gate's setting is not -- with entry off the status
   * route answers from configuration alone. Asked in sequence, every visitor
   * waited out the whole 1s-2s-4s-8s readiness ladder before the page could
   * say what kind of screen it even was. The ladder still runs; it simply no
   * longer stands in front of a question it cannot answer.
   */
  const readiness = waitUntilReady();
  try {
    status = await jsonRequest('/api/alpha/status');
  } catch (error) {
    /*
     * ALPHA_ACCESS_UNAVAILABLE is the access store not answering -- a
     * database waking from scale-to-zero -- and the server kept the reader's
     * cookie for it. Once readiness says the database answers, ask once more
     * rather than leaving the reader on "unavailable" until they reload.
     */
    const ready = await readiness;
    status = null;
    if (ready && error instanceof RequestError && error.code === 'ALPHA_ACCESS_UNAVAILABLE') {
      try { status = await jsonRequest('/api/alpha/status'); } catch { status = null; }
    }
    if (!status) {
      showWaking('Temporarily unavailable');
      return Object.freeze({ allowed: false, reason: 'unavailable' });
    }
  }
  const current = status;
  if (word('access') === 'revoked' || word('code') === 'ALPHA_ACCESS_REVOKED') {
    showExpired('ALPHA_ACCESS_REVOKED');
    return Object.freeze({ allowed: false, reason: 'revoked', status: current });
  }
  if (word('access') === 'expired' || word('code') === 'ALPHA_SESSION_EXPIRED') {
    showExpired('ALPHA_SESSION_EXPIRED');
    return Object.freeze({ allowed: false, reason: 'expired', status: current });
  }
  if (field(current, 'mode') === 'off') {
    /*
     * The way through is drawn at once, so the page settles in one step.
     * Whether it can be walked depends on the database -- sessions live there
     * -- so the readiness answer decides only that. A reader on the far side
     * of a completed sign-in is not a new arrival: they asked to pass once
     * already, and readiness is awaited on that path alone, because the
     * workspace they are handed to is what needs the database.
     */
    if (callback.entered && await readiness) {
      return Object.freeze({ allowed: true, reason: 'entered', status: current });
    }
    showOpenAccess(current);
    void readiness.then(ready => { if (!ready) closeOpenAccess(); });
    return Object.freeze({ allowed: false, reason: 'open', status: current });
  }
  /*
   * The gate is on, and redemption needs the database that is not answering.
   * Say that plainly rather than offering a field that cannot be honoured: a
   * reader who types an invitation into it has spent their one-time code on a
   * request that was always going to fail.
   */
  if (!await readiness) {
    showWaking('Temporarily unavailable');
    return Object.freeze({ allowed: false, reason: 'unavailable', status: current });
  }
  if (field(current, 'authenticated') === true) return Object.freeze({ allowed: true, status: current });
  showAccessGate(current);
  return Object.freeze({ allowed: false, reason: 'access-required', status: current });
}

const AlphaUI = Object.freeze({ boot, gateEnabled, showAccessGate, showOpenAccess, showWaking, showTerms, showExpired });
export default AlphaUI;
