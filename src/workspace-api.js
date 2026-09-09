'use strict';

const crypto = require('crypto');
const express = require('express');
const { createCsrfToken, verifyCsrfToken } = require('./security-foundation');
const { digest, workspaceError } = require('./workspace-identity');
const { SESSION_TTL_MS } = require('./workspace-store');

const SESSION_COOKIE = 'nv_workspace_session';
const CHALLENGE_COOKIE = 'nv_workspace_challenge';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const NONCE_RX = /^[A-Za-z0-9_-]{43}$/;

function createWorkspaceRouter({ enabled, store, verifyAccount, connectAccount, listRepositories, seal, unseal, getCookie,
  csrfSecret, production = false, publicOrigin = '' }) {
  const router = express.Router();
  const attempts = new Map();
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const cookie = (res, name, value, maxAge) => res.append('Set-Cookie',
    `${name}=${value}; Path=/api/workspace; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${production ? '; Secure' : ''}`);
  const fields = (req, allowed) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some(key => !allowed.includes(key))
      || JSON.stringify(req.body).length > 8192) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
  };
  const sessionToken = req => {
    const value = unseal(getCookie(req, SESSION_COOKIE));
    return value?.kind === 'workspace-session/v1' && NONCE_RX.test(value.token) ? value.token : '';
  };
  const securityContext = (token, context) => ({
    sessionBinding: digest(token), identityKey: `workspace:${context.principalId}:${context.workspaceId}`
  });
  const challengeContext = req => {
    const value = unseal(getCookie(req, CHALLENGE_COOKIE));
    if (value?.kind !== 'workspace-challenge/v1' || !NONCE_RX.test(value.nonce)
      || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return null;
    return { sessionBinding: digest(value.nonce), identityKey: 'workspace-preauth/v1' };
  };
  const replySession = (res, result, status = 200) => {
    cookie(res, SESSION_COOKIE, seal({ kind: 'workspace-session/v1', token: result.token }), SESSION_TTL_MS / 1000);
    cookie(res, CHALLENGE_COOKIE, '', 0);
    return res.status(status).json({ authenticated: true, context: result.context,
      csrfToken: createCsrfToken(csrfSecret, securityContext(result.token, result.context)) });
  };

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) return res.status(404).json({ code: 'WORKSPACE_FOUNDATION_DISABLED' });
    // Retain an explicit origin boundary even when this router is tested or
    // mounted outside the main API stack. Non-browser callers supply Origin too.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const expected = publicOrigin || `${req.protocol}://${req.get('host')}`;
      if (req.headers['x-nv'] !== '1' || req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ code: 'WORKSPACE_ORIGIN_REQUIRED' });
      }
    }
    next();
  });
  // A database error must not become an anonymous or cookie-only session.
  router.use((req, res, next) => {
    req.workspaceToken = sessionToken(req);
    Promise.resolve(req.workspaceToken ? store.readContext(req.workspaceToken) : null)
      .then(context => { req.workspaceContext = context; next(); }).catch(next);
  });

  router.get('/session', wrap(async (req, res) => {
    if (req.workspaceContext) return res.json({ authenticated: true, context: req.workspaceContext,
      csrfToken: createCsrfToken(csrfSecret, securityContext(req.workspaceToken, req.workspaceContext)) });
    const nonce = crypto.randomBytes(32).toString('base64url');
    cookie(res, SESSION_COOKIE, '', 0);
    cookie(res, CHALLENGE_COOKIE, seal({ kind: 'workspace-challenge/v1', nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS }), CHALLENGE_TTL_MS / 1000);
    return res.json({ authenticated: false,
      csrfToken: createCsrfToken(csrfSecret, { sessionBinding: digest(nonce), identityKey: 'workspace-preauth/v1' }, { ttlMs: CHALLENGE_TTL_MS }) });
  }));

  router.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    try {
      const entry = req.path === '/setup' || req.path === '/sign-in';
      if (!entry && !req.workspaceContext) throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401);
      const context = req.workspaceContext ? securityContext(req.workspaceToken, req.workspaceContext) : challengeContext(req);
      if (!context) throw workspaceError('CSRF_REQUIRED');
      verifyCsrfToken(csrfSecret, req.headers['x-nv-csrf'], context);
      if (entry) {
        // IP keyed, not cookie keyed: changing an anonymous cookie is not a reset.
        const key = req.ip, now = Date.now();
        const attempt = attempts.get(key);
        const state = attempt && attempt.until > now ? attempt : { count: 0, until: now + 60000 };
        if (++state.count > 10) throw workspaceError('WORKSPACE_AUTH_RATE_LIMIT', 429);
        attempts.set(key, state);
        if (attempts.size > 1000) attempts.delete(attempts.keys().next().value);
      }
      next();
    } catch (error) { next(error); }
  });
  router.post('/setup', wrap(async (req, res) => {
    fields(req, ['token', 'provider', 'baseUrl', 'setupSecret']);
    if (req.workspaceContext) throw workspaceError('WORKSPACE_SETUP_REJECTED');
    const result = await store.claim({ secret: req.body.setupSecret,
      verifyIdentity: async () => (await verifyAccount(req.body)).identity });
    return replySession(res, result, 201);
  }));
  router.post('/sign-in', wrap(async (req, res) => {
    fields(req, ['token', 'provider', 'baseUrl']);
    const { identity } = await verifyAccount(req.body);
    return replySession(res, await store.signIn({ identity, previousToken: req.workspaceToken }));
  }));
  router.post('/sign-out', wrap(async (req, res) => {
    fields(req, []);
    await store.signOut(req.workspaceToken);
    cookie(res, SESSION_COOKIE, '', 0);
    cookie(res, CHALLENGE_COOKIE, '', 0);
    return res.json({ ok: true });
  }));
  router.post('/connections', wrap(async (req, res) => {
    fields(req, ['token', 'provider', 'baseUrl']);
    const verified = await verifyAccount(req.body);
    return res.status(201).json(await store.bindConnection({ token: req.workspaceToken, ...verified }));
  }));
  router.post('/connections/connect', wrap(async (req, res) => {
    fields(req, ['token', 'provider', 'baseUrl']);
    if (typeof connectAccount !== 'function') throw workspaceError('WORKSPACE_UNAVAILABLE', 503);
    const verified = await connectAccount(req.body);
    return res.status(201).json(await store.bindConnection({ token: req.workspaceToken, ...verified }));
  }));
  router.get('/connections', wrap(async (req, res) => {
    if (!req.workspaceContext) throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401);
    return res.json({ connections: await store.listConnections(req.workspaceToken) });
  }));
  router.get('/repositories', wrap(async (req, res) => {
    if (!req.workspaceContext) throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401);
    if (Object.keys(req.query).length) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
    const account = await store.executionAccount(req.workspaceToken);
    if (typeof listRepositories !== 'function') throw workspaceError('WORKSPACE_REPOSITORIES_UNAVAILABLE', 503);
    return res.json(await listRepositories(account));
  }));
  router.post('/connections/select', wrap(async (req, res) => {
    fields(req, ['workspaceId', 'connectionId']);
    const context = await store.selectConnection({ token: req.workspaceToken, workspaceId: req.body.workspaceId, connectionId: req.body.connectionId });
    return res.json({ context });
  }));
  router.post('/connections/disconnect', wrap(async (req, res) => {
    fields(req, ['connectionId']);
    await store.disconnectConnection({ token: req.workspaceToken, connectionId: req.body.connectionId });
    return res.json({ ok: true });
  }));
  router.use((req, res) => res.status(404).json({ code: 'WORKSPACE_ROUTE_NOT_FOUND' }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const known = /^(?:WORKSPACE_[A-Z_]+|CSRF_(?:INVALID|EXPIRED|REQUIRED))$/.test(error.code || '');
    return res.status(known ? error.status || 403 : 503).json({
      code: known ? error.code : 'WORKSPACE_UNAVAILABLE',
      error: 'Workspace request could not be completed. No repository write was requested.'
    });
  });
  return router;
}

module.exports = { createWorkspaceRouter };
