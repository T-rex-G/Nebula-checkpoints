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

  function showAccessGate(nextStatus = status) {
    status = nextStatus || status;
    activateAccessPage();
    showTerms(status && status.termsVersion);
    const terms = byId('alphaTermsAccept');
    if (terms) terms.checked = false;
    const invite = byId('alphaInviteInput');
    if (invite) invite.focus();
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
      if (invite) invite.focus();
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
    if (status.mode === 'off' || status.authenticated === true) {
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
    showAccessGate,
    showWaking,
    showTerms,
    showExpired
  });
})(window);
