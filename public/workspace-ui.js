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
  let outcomeUnknown = false;
  let workbenchWriteUnknown = false;

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
    WORKSPACE_CONNECTION_REQUIRED: 'Select a Git connection first.',
    WORKSPACE_EXECUTION_CHANGED: 'The selected workspace or Git connection changed. Return to owner connections and reopen the workbench.',
    WORKSPACE_WRITE_UNCERTAIN: 'The write may have completed. Inspect the repository and its latest commit on GitHub before reloading and deliberately trying another write. Nothing will be automatically replayed.',
    WORKSPACE_CREDENTIAL_REQUIRED: 'Reconnect this Git account with a valid token for this workspace session.',
    WORKSPACE_PROVIDER_UNSUPPORTED: 'Owner repository listing currently supports GitHub. This connection can still be managed here.',
    WORKSPACE_REPOSITORIES_UNAVAILABLE: 'Repositories could not be listed. Check the provider permissions and try again.',
    WORKSPACE_ORIGIN_REQUIRED: 'This request did not come from the application.',
    WORKSPACE_INPUT_INVALID: 'Something in that form was not accepted. Check the fields and try again.',
    WORKSPACE_ROUTE_NOT_FOUND: 'That workspace route does not exist.',
    WORKSPACE_UNAVAILABLE: 'The workspace service is unavailable. Reload to check your session before trying again.',
    WORKSPACE_OUTCOME_UNKNOWN: 'The request could not be confirmed and may have completed. Reload to check your session before trying again.',
    WORKSPACE_SETUP_OUTCOME_UNKNOWN: 'Setup could not be confirmed and may have completed. If no owner session is shown, try signing in with the same provider account before claiming again.',
    WORKSPACE_SIGN_IN_OUTCOME_UNKNOWN: 'Sign-in could not be confirmed and may have completed. Check the owner session shown here, or reload if its status is unavailable.',
    WORKSPACE_SIGN_OUT_OUTCOME_UNKNOWN: 'Sign-out could not be confirmed and may have completed. Check your session before leaving this device; reload if its status is unavailable.',
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
    if (code === 'WORKSPACE_WRITE_UNCERTAIN') {
      error.providerChanged = 'unknown';
      error.safeState = 'No automatic retry was requested.';
      error.nextAction = REASONS.WORKSPACE_WRITE_UNCERTAIN;
    }
    return error;
  }

  function snapshot() {
    return Object.freeze({
      available: state.available,
      authenticated: state.authenticated,
      context: state.context,
      outcomeUnknown
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

  function isSession(payload) {
    return payload && typeof payload.authenticated === 'boolean'
      && typeof payload.csrfToken === 'string' && payload.csrfToken.length > 0
      && (!payload.authenticated || (payload.context && typeof payload.context === 'object'));
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
    const payload = await response.json();
    return { response, payload };
  }

  /*
   * Ask the server what this deployment supports and pick up the CSRF token
   * the next write will need. A 404 is the switched-off answer, not a fault.
   */
  async function probe() {
    let result;
    csrfToken = '';
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
    if (!result.response.ok || !isSession(result.payload)) {
      state = { available: null, authenticated: false, context: null };
      return snapshot();
    }
    return adopt(result.payload);
  }

  async function reconcileUnknown(path) {
    outcomeUnknown = true;
    /* A GET can recover the browser's current session even when the preceding
     * POST committed but its reply was lost. It cannot prove an unreceived
     * setup cookie means no owner was created, so never replay that POST. */
    await probe();
    const code = {
      '/setup': 'WORKSPACE_SETUP_OUTCOME_UNKNOWN',
      '/sign-in': 'WORKSPACE_SIGN_IN_OUTCOME_UNKNOWN',
      '/sign-out': 'WORKSPACE_SIGN_OUT_OUTCOME_UNKNOWN'
    }[path];
    throw workspaceError(code || 'WORKSPACE_OUTCOME_UNKNOWN');
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
    if (state.available !== true || !csrfToken) throw workspaceError('WORKSPACE_UNAVAILABLE');
    let result;
    try {
      result = await send(path, 'POST', body);
    } catch {
      return reconcileUnknown(path);
    }
    const { response, payload } = result;
    if (response.ok) {
      const valid = ['/sign-out', '/connections/disconnect'].includes(path) ? payload?.ok === true
        : path === '/connections/connect' ? typeof payload?.id === 'string' && payload.id.length > 0
          : path === '/connections/select' ? payload?.context?.role === 'owner'
            : isSession(payload) && payload.authenticated;
      if (!valid) return reconcileUnknown(path);
      outcomeUnknown = false;
      return payload;
    }
    const code = String(payload && payload.code || '');
    if (retry && response.status === 403 && CSRF_CODES.includes(code)) {
      csrfToken = '';
      await probe();
      return write(path, body, false);
    }
    if (!Object.hasOwn(REASONS, code) || code === 'WORKSPACE_UNAVAILABLE') return reconcileUnknown(path);
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

  async function read(path) {
    let result;
    try { result = await send(path, 'GET'); }
    catch { throw workspaceError('WORKSPACE_UNAVAILABLE'); }
    if (!result.response.ok) {
      const code = result.payload?.code || 'WORKSPACE_UNAVAILABLE';
      if (code === 'WORKSPACE_SESSION_REQUIRED') await probe();
      throw workspaceError(code, result.response.status);
    }
    return result.payload;
  }

  async function listConnections() {
    const payload = await read('/connections');
    if (!Array.isArray(payload?.connections)) throw workspaceError('WORKSPACE_UNAVAILABLE');
    return payload.connections;
  }

  async function connect(input) {
    return write('/connections/connect', credentials(input));
  }

  async function selectConnection(connectionId) {
    const context = state.context;
    if (!state.authenticated || !context) throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401);
    const payload = await write('/connections/select', { workspaceId: context.workspaceId, connectionId });
    return adopt({ authenticated: true, context: payload.context });
  }

  async function disconnect(connectionId) {
    await write('/connections/disconnect', { connectionId });
    if (state.context?.connection?.id === connectionId) state.context = { ...state.context, connection: null };
    return snapshot();
  }

  async function repositories() {
    const payload = await read('/repositories');
    if (!Array.isArray(payload?.repositories)) throw workspaceError('WORKSPACE_REPOSITORIES_UNAVAILABLE');
    return payload;
  }

  async function workbench(path, options, binding, retry = true) {
    const method = String(options.method || 'GET').toUpperCase();
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (!/^\/api\/[a-z]/.test(path) || path.includes('..') || path.includes('\\')) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
    if (unsafe && workbenchWriteUnknown) throw workspaceError('WORKSPACE_WRITE_UNCERTAIN');
    const context = state.context;
    if (!state.authenticated || context?.role !== 'owner') throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401);
    if (!binding || context.principalId !== binding.principalId || context.workspaceId !== binding.workspaceId
      || context.connection?.id !== binding.connectionId) throw workspaceError('WORKSPACE_EXECUTION_CHANGED', 409);
    let response, payload;
    try {
      response = await global.fetch(BASE + '/workbench' + path.slice(4), {
        method, credentials: 'same-origin', cache: 'no-store', signal: options.signal,
        headers: { 'x-nv': '1', 'x-nv-workspace': binding.workspaceId, 'x-nv-connection': binding.connectionId,
          ...(unsafe ? { 'x-nv-csrf': csrfToken, 'Content-Type': 'application/json' } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      payload = await response.json();
    } catch {
      if (unsafe) workbenchWriteUnknown = true;
      throw workspaceError(unsafe ? 'WORKSPACE_WRITE_UNCERTAIN' : 'WORKSPACE_UNAVAILABLE');
    }
    if (!response.ok) {
      const code = payload?.code || 'WORKSPACE_UNAVAILABLE';
      if (unsafe && retry && response.status === 403 && CSRF_CODES.includes(code)) {
        await probe();
        return workbench(path, options, binding, false);
      }
      if (unsafe && (code === 'WORKSPACE_WRITE_UNCERTAIN' || response.status >= 500)) workbenchWriteUnknown = true;
      const error = workspaceError(workbenchWriteUnknown && unsafe ? 'WORKSPACE_WRITE_UNCERTAIN' : code, response.status);
      if (!REASONS[code] && typeof payload?.error === 'string') error.message = payload.error;
      error.nextAction = payload?.nextAction || error.nextAction;
      error.providerChanged = payload?.providerChanged || error.providerChanged;
      throw error;
    }
    const validWrite = path === '/api/safety' ? typeof payload?.readOnly === 'boolean'
      : payload?.verified === true && (path === '/api/repos' ? typeof payload.full_name === 'string'
        : payload.ok === true && /^[a-f0-9]{40}$/i.test(payload.commit || ''));
    if (!payload || (unsafe && !validWrite)) {
      if (unsafe) workbenchWriteUnknown = true;
      throw workspaceError(unsafe ? 'WORKSPACE_WRITE_UNCERTAIN' : 'WORKSPACE_UNAVAILABLE');
    }
    return payload;
  }

  function current() {
    return snapshot();
  }

  /* Test seam only: the browser never needs to rewind module state. */
  function reset() {
    csrfToken = '';
    outcomeUnknown = false;
    workbenchWriteUnknown = false;
    state = { available: null, authenticated: false, context: null };
  }

  global.NebulaWorkspaceUI = Object.freeze({
    probe, claim, signIn, signOut, current, explain, reset, SECRET_RX,
    listConnections, connect, selectConnection, disconnect, repositories, workbench
  });
})(window);
