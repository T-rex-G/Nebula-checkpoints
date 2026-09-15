/* Controlled public-alpha access, readiness, and session-state UI. */
'use strict';

(function alphaUiModule(global) {
  const RETRY_DELAYS = Object.freeze([1000, 2000, 4000, 8000]);
  const GENERIC_INVITE_ERROR = 'Invitation could not be redeemed. Check the invitation and try again.';
  let status = null;
  let redeemBound = false;

  const byId = id => document.getElementById(id);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  function activateAccessPage() {
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    const page = byId('page-alpha-access');
    if (page) page.classList.add('active');
    window.scrollTo(0, 0);
  }

  function showWaking(message = 'Checking service readiness…') {
    const target = byId('alphaWakeState');
    if (target) target.textContent = message;
  }

  function showTerms(version) {
    const target = byId('alphaTermsVersion');
    if (target) target.textContent = version ? `Terms ${version}` : 'Current alpha terms';
  }

  function showAccessError(message) {
    const target = byId('alphaAccessError');
    if (!target) return;
    target.textContent = message || '';
    target.hidden = !message;
  }

  /*
   * The invitation form is the only way in when the gate is on, and means
   * nothing when it is off -- there is no code to redeem. Rather than wrap
   * these in a container, each is hidden by id: the browser suite finds this
   * card by the names a reader reads, and a new wrapper around them is a
   * structural change for no gain.
   */
  function setInviteFormHidden(hidden) {
    ['alphaInviteInput', 'alphaTermsAccept', 'alphaRedeemBtn']
      .forEach(id => { const el = byId(id); if (el) el.hidden = hidden; });
    ['alphaInviteInput', 'alphaTermsAccept']
      .forEach(id => {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) label.hidden = hidden;
      });
  }

  function setOpenAccessHidden(hidden) {
    const open = byId('alphaOpenAccess');
    if (open) open.hidden = hidden;
  }

  /*
   * Entry is open: the gate is configured off, so there is no invitation to
   * redeem and nothing to check. The landing page stays rather than handing
   * over on its own.
   *
   * It used to hand over, and that is the flash: boot() raised this page on
   * its first line and only learned the mode two round trips later, so the
   * page was painted and taken away a beat afterwards. The front door should
   * not do that, and a visitor who wants past it can say so.
   */
  function showOpenAccess(nextStatus = status) {
    status = nextStatus || status;
    activateAccessPage();
    showTerms(status && status.termsVersion);
    showAccessError('');
    setInviteFormHidden(true);
    setOpenAccessHidden(false);
    /*
     * Which way through depends on who is asking. A session that is already
     * signed in has a workspace to return to; one that is not has to sign in
     * first, and saying so is the difference between a button and a guess.
     */
    const signedIn = !!(status && status.authenticated);
    const note = byId('alphaOpenNote');
    if (note) {
      note.textContent = signedIn
        ? 'Entry is open, and this session is already signed in.'
        : 'Entry is open. No invitation is needed while the gate is off.';
    }
    const pass = byId('alphaPassThrough');
    if (pass) {
      pass.textContent = signedIn ? 'Continue to your workspace' : 'Continue to sign in';
    }
    global.dispatchEvent(new CustomEvent('nebula:alpha-access-gated'));
  }

  /*
   * Whether the deployment runs a controlled alpha at all.
   *
   * The gate decides more than the front door. An invitation, a tester label,
   * an alpha session to end, alpha data to delete -- none of those exist when
   * the operator has the gate off, and every /api/alpha/* route answers 404
   * in that mode. The application has to be able to ask, or it offers alpha
   * controls to a visitor who has no alpha session and cannot get one.
   *
   * Unknown reads as off. The mode is unknown when the status request never
   * landed, or when what landed did not name one, and in that state the
   * honest thing is to withhold controls whose entire purpose is a session we
   * cannot confirm exists.
   *
   * Written as the exact complement of the test boot() makes, rather than as
   * an equality against the one mode that turns the gate on. The server sends
   * 'invite', so a check for that string would have been right in production
   * and wrong wherever a status says the gate is on by another name -- the
   * kind of disagreement the client should never have with itself.
   */
  function gateEnabled() {
    return !!(status && status.mode && status.mode !== 'off');
  }

  function showAccessGate(nextStatus = status) {
    status = nextStatus || status;
    activateAccessPage();
    setOpenAccessHidden(true);
    setInviteFormHidden(false);
    showTerms(status && status.termsVersion);
    const terms = byId('alphaTermsAccept');
    if (terms) terms.checked = false;
    const invite = byId('alphaInviteInput');
    /* preventScroll: the gate now sits on the landing page, and focusing an
       input scrolls it into view -- which threw the reader 323px past the
       headline before they had read a word of it. */
    if (invite) invite.focus({ preventScroll: true });
    /*
     * Announced for the same reason the granted side is: the gate takes the
     * screen, and the chrome belonging to whatever it replaced has to go with
     * it. Said here rather than by each caller, because every path that raises
     * the gate owes the same cleanup -- an expired session left the workbench's
     * floating action sitting over this page's own Continue.
     */
    global.dispatchEvent(new CustomEvent('nebula:alpha-access-gated'));
  }

  async function jsonRequest(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: {
        'x-nv': '1',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = body.code || '';
      throw error;
    }
    return body;
  }

  async function waitUntilReady() {
    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
      try {
        const ready = await jsonRequest('/readyz');
        if (ready && ready.ok) {
          showWaking('Ready');
          return true;
        }
        showWaking(ready && ready.database === 'unavailable' ? 'Waking database' : 'Waking service');
      } catch (error) {
        showWaking(error && error.status === 503 ? 'Waking database' : 'Waking service');
      }
      await delay(RETRY_DELAYS[attempt]);
    }
    showWaking('Temporarily unavailable');
    return false;
  }

  async function redeemInvitation() {
    const invite = byId('alphaInviteInput');
    const terms = byId('alphaTermsAccept');
    const button = byId('alphaRedeemBtn');
    showAccessError('');
    if (!terms || !terms.checked) {
      showAccessError('Accept the current alpha terms before continuing.');
      if (terms) terms.focus();
      return;
    }
    const code = String(invite && invite.value || '').trim();
    if (!code || !status || !status.termsVersion) {
      showAccessError(GENERIC_INVITE_ERROR);
      return;
    }
    if (button) button.disabled = true;
    const request = jsonRequest('/api/alpha/redeem', {
      method: 'POST',
      body: JSON.stringify({ code, acceptedTermsVersion: status.termsVersion })
    });
    if (invite) invite.value = '';
    try {
      await request;
      showAccessError('');
      global.dispatchEvent(new CustomEvent('nebula:alpha-access-granted'));
    } catch {
      showAccessError(GENERIC_INVITE_ERROR);
      if (invite) invite.focus({ preventScroll: true });
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindRedemption() {
    if (redeemBound) return;
    redeemBound = true;
    const button = byId('alphaRedeemBtn');
    const invite = byId('alphaInviteInput');
    if (button) button.addEventListener('click', redeemInvitation);
    if (invite) invite.addEventListener('keydown', event => {
      if (event.key === 'Enter') redeemInvitation();
    });
    /*
     * The same event the redemption path fires. app.js guards its own boot
     * against a second call, so pressing this twice costs nothing.
     */
    const pass = byId('alphaPassThrough');
    if (pass) {
      pass.addEventListener('click', () => {
        global.dispatchEvent(new CustomEvent('nebula:alpha-access-granted'));
      });
    }
  }

  async function boot() {
    bindRedemption();
    activateAccessPage();
    showAccessError('');
    showWaking();
    const ready = await waitUntilReady();
    if (!ready) return Object.freeze({ allowed: false, reason: 'unavailable' });
    try {
      status = await jsonRequest('/api/alpha/status');
    } catch {
      showWaking('Temporarily unavailable');
      return Object.freeze({ allowed: false, reason: 'unavailable' });
    }
    if (status.access === 'revoked' || status.code === 'ALPHA_ACCESS_REVOKED') {
      showExpired('ALPHA_ACCESS_REVOKED');
      return Object.freeze({ allowed: false, reason: 'revoked', status });
    }
    if (status.access === 'expired' || status.code === 'ALPHA_SESSION_EXPIRED') {
      showExpired('ALPHA_SESSION_EXPIRED');
      return Object.freeze({ allowed: false, reason: 'expired', status });
    }
    if (status.mode === 'off') {
      showOpenAccess(status);
      return Object.freeze({ allowed: false, reason: 'open', status });
    }
    if (status.authenticated === true) {
      return Object.freeze({ allowed: true, status });
    }
    showAccessGate(status);
    return Object.freeze({ allowed: false, reason: 'access-required', status });
  }

  function showExpired(code) {
    showAccessGate(status);
    showWaking('Ready');
    showAccessError(code === 'ALPHA_ACCESS_REVOKED'
      ? 'This alpha access was revoked. Request a new invitation from the operator.'
      : 'This alpha session expired. Redeem a new invitation to continue.');
  }

  global.NebulaAlphaUI = Object.freeze({
    boot,
    gateEnabled,
    showAccessGate,
    showOpenAccess,
    showWaking,
    showTerms,
    showExpired
  });
})(window);
