/* Owner setup and sign-in transport for the personal workspace foundation. */
'use strict';

/*
 * This is deliberately NOT app.js's api(). That client carries the alpha
 * session's CSRF token, and the workspace router issues its own -- bound to a
 * pre-authentication challenge cookie before an owner exists, and to the
 * workspace session afterwards. Sending one where the other is expected fails
 * closed, which is correct but unexplainable to the person reading the screen.
 * Keeping the two transports apart is what makes the boundary in section 3.6
 * of the workspace brief real rather than described.
 */
(function workspaceUiModule(global) {
  const BASE = '/api/workspace';
  const SECRET_RX = /^[A-Za-z0-9_-]{43,128}$/;
  const CSRF_CODES = ['CSRF_REQUIRED', 'CSRF_INVALID', 'CSRF_EXPIRED'];

  /*
   * available: null until probed, false when the deployment has the foundation
   * switched off. The difference matters -- an unprobed state must never be
   * drawn as "off", or a slow first request looks like a disabled feature.
   */
  let state = { available: null, authenticated: false, context: null };
  let csrfToken = '';

  const REASONS = {
    WORKSPACE_FOUNDATION_DISABLED: 'Owner workspaces are switched off for this deployment.',
    WORKSPACE_SETUP_REJECTED: 'That setup credential was not accepted, or ownership has already been claimed.',
    WORKSPACE_SIGN_IN_REJECTED: 'This account does not own a workspace on this deployment.',
    WORKSPACE_SIGN_OUT_REQUIRED: 'A different person is signed in. Sign out first.',
    WORKSPACE_HUMAN_IDENTITY_REQUIRED: 'Workspace ownership needs a personal account. App installations and bot accounts cannot own a workspace.',
    WORKSPACE_PROVIDER_VERIFICATION_FAILED: 'The provider would not confirm this token. Check the token and try again.',
    WORKSPACE_AUTH_RATE_LIMIT: 'Too many attempts. Wait a minute before trying again.',
    WORKSPACE_SESSION_REQUIRED: 'The workspace session has ended. Sign in again.',
    WORKSPACE_SESSION_LIMIT: 'Too many active workspace sessions. Sign out somewhere else first.',
    WORKSPACE_CONNECTION_LIMIT: 'This workspace already holds the maximum number of Git connections.',
    WORKSPACE_CONNECTION_REJECTED: 'That Git connection is not available to this workspace.',
    WORKSPACE_ORIGIN_REQUIRED: 'This request did not come from the application.',
    WORKSPACE_INPUT_INVALID: 'Something in that form was not accepted. Check the fields and try again.',
    WORKSPACE_ROUTE_NOT_FOUND: 'That workspace route does not exist.',
    WORKSPACE_UNAVAILABLE: 'The workspace service could not complete the request. Nothing was changed.',
    CSRF_REQUIRED: 'The page went stale. Reload and try again.',
    CSRF_INVALID: 'The page went stale. Reload and try again.',
    CSRF_EXPIRED: 'The page went stale. Reload and try again.'
  };

  function explain(code) {
    return REASONS[code] || REASONS.WORKSPACE_UNAVAILABLE;
  }

  function workspaceError(code, status) {
    const error = new Error(explain(code));
    error.code = code;
    error.status = status || 0;
    return error;
  }

  function snapshot() {
    return Object.freeze({
      available: state.available,
      authenticated: state.authenticated,
      context: state.context
    });
  }

  function adopt(payload) {
    state = {
      available: true,
      authenticated: Boolean(payload && payload.authenticated),
      context: (payload && payload.context) || null
    };
    if (payload && typeof payload.csrfToken === 'string') csrfToken = payload.csrfToken;
    return snapshot();
  }

  async function send(path, method, body) {
    const headers = { 'x-nv': '1' };
    if (body) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken) headers['x-nv-csrf'] = csrfToken;
    const response = await global.fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }

  /*
   * Ask the server what this deployment supports and pick up the CSRF token
   * the next write will need. A 404 is the switched-off answer, not a fault.
   */
  async function probe() {
    let result;
    try {
      result = await send('/session', 'GET');
    } catch {
      /* Offline or blocked: unknown, never "off". */
      state = { available: null, authenticated: false, context: null };
      return snapshot();
    }
    if (result.response.status === 404) {
      csrfToken = '';
      state = { available: false, authenticated: false, context: null };
      return snapshot();
    }
    if (!result.response.ok) {
      state = { available: null, authenticated: false, context: null };
      return snapshot();
    }
    return adopt(result.payload);
  }

  /*
   * The challenge token behind an unauthenticated write lives five minutes.
   * A person reading the setup instructions will routinely take longer than
   * that, so a stale challenge is the expected case rather than an anomaly:
   * re-probe once and replay, and only then report a stale page.
   */
  async function write(path, body, retry = true) {
    if (!csrfToken) await probe();
    if (state.available === false) throw workspaceError('WORKSPACE_FOUNDATION_DISABLED', 404);
    const { response, payload } = await send(path, 'POST', body);
    if (response.ok) return payload;
    const code = String(payload && payload.code || '');
    if (retry && CSRF_CODES.includes(code)) {
      csrfToken = '';
      await probe();
      return write(path, body, false);
    }
    throw workspaceError(code || 'WORKSPACE_UNAVAILABLE', response.status);
  }

  /*
   * The server refuses a github request that carries a base URL at all, so an
   * empty field must be absent rather than empty. Every route also rejects any
   * key it did not name, which is why each body is built explicitly instead of
   * spread from the caller's object.
   */
  function credentials({ provider, baseUrl, token }) {
    const chosen = String(provider || 'github');
    const body = { token: String(token || '').trim(), provider: chosen };
    const base = String(baseUrl || '').trim();
    if (chosen !== 'github' && base) body.baseUrl = base;
    if (!body.token) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
    return body;
  }

  async function claim(input) {
    const secret = String(input && input.setupSecret || '').trim();
    /*
     * Checked here as well as on the server. A malformed credential would be
     * refused anyway, but it would spend one of the five attempts that lock
     * setup for fifteen minutes -- a costly way to learn about a typo.
     */
    if (!SECRET_RX.test(secret)) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
    const payload = await write('/setup', { ...credentials(input), setupSecret: secret });
    return adopt(payload);
  }

  async function signIn(input) {
    return adopt(await write('/sign-in', credentials(input)));
  }

  async function signOut() {
    await write('/sign-out', {});
    csrfToken = '';
    state = { available: true, authenticated: false, context: null };
    return snapshot();
  }

  function current() {
    return snapshot();
  }

  /* Test seam only: the browser never needs to rewind module state. */
  function reset() {
    csrfToken = '';
    state = { available: null, authenticated: false, context: null };
  }

  global.NebulaWorkspaceUI = Object.freeze({
    probe, claim, signIn, signOut, current, explain, reset, SECRET_RX
  });
})(window);
