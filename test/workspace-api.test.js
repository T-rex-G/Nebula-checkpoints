'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createWorkspaceRouter } = require('../src/workspace-api');
const { verifiedHumanIdentity } = require('../src/workspace-identity');

async function main() {
  const sessions = new Map();
  const context = { principalId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), role: 'owner', connection: null };
  let verified = 0, claimed = 0, legacyCalls = 0, unavailable = false;
  const store = {
    async readContext(token) { if (unavailable) throw new Error('database secret must never leak'); return sessions.get(token) || null; },
    async claim({ verifyIdentity }) {
      await verifyIdentity(); claimed++;
      const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, context);
      return { token, context };
    },
    async signOut(token) { sessions.delete(token); },
    async bindConnection({ identity }) { assert.strictEqual(identity.providerUserId, '99'); return { id: 'bound' }; }
  };
  const secret = crypto.randomBytes(32).toString('hex');
  const seal = data => { const body = Buffer.from(JSON.stringify(data)).toString('base64url'); return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('hex'); };
  const unseal = raw => {
    try { const [body, signature] = String(raw).split('.'); if (crypto.createHmac('sha256', secret).update(body).digest('hex') !== signature) return null; return JSON.parse(Buffer.from(body, 'base64url')); } catch { return null; }
  };
  const cookie = (req, name) => String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
  const app = express(); app.use(express.json());
  app.use('/api/workspace', createWorkspaceRouter({
    enabled: true, store, seal, unseal, getCookie: cookie, csrfSecret: secret,
    verifyAccount: async body => {
      verified++;
      assert.strictEqual(body.token, 'test-provider-credential');
      return { identity: verifiedHumanIdentity({ provider: 'github', providerAccountId: 99 }), legacyIdentityKey: 'a'.repeat(64) };
    }
  }));
  app.use('/api', (req, res) => { legacyCalls++; res.status(403).json({ code: 'ALPHA_ACCESS_REQUIRED' }); });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  async function request(route, { body, headers = {}, method = body ? 'POST' : 'GET', keepCookies = true } = {}) {
    const response = await fetch(base + route, { method, headers: {
      'content-type': 'application/json', 'x-nv': '1', origin: base,
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (keepCookies) for (const value of response.headers.getSetCookie()) {
      const part = value.split(';')[0], i = part.indexOf('='); jar.set(part.slice(0, i), part.slice(i + 1));
    }
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  try {
    const anon = await request('/api/workspace/session');
    assert.strictEqual(anon.body.authenticated, false);
    assert(anon.body.csrfToken);
    assert.strictEqual(anon.headers.get('cache-control'), 'no-store');
    const body = { token: 'test-provider-credential', setupSecret: 'test-setup-secret' };
    assert.strictEqual((await request('/api/workspace/setup', { body })).status, 403);
    assert.strictEqual(verified, 0, 'missing CSRF must fail before external identity verification');
    assert.strictEqual((await request('/api/workspace/setup', { body, headers: { 'x-nv-csrf': anon.body.csrfToken, origin: 'https://other.example' } })).status, 403);
    assert.strictEqual((await request('/api/workspace/setup', { body: { ...body, role: 'owner' }, headers: { 'x-nv-csrf': anon.body.csrfToken } })).status, 400);
    const setup = await request('/api/workspace/setup', { body, headers: { 'x-nv-csrf': anon.body.csrfToken } });
    assert.strictEqual(setup.status, 201);
    assert.strictEqual(claimed, 1);
    assert.deepStrictEqual(setup.body.context, context);
    assert(setup.headers.getSetCookie().some(x => x.startsWith('nv_workspace_session=') && /HttpOnly/.test(x) && /SameSite=Strict/.test(x)));
    assert(!JSON.stringify(setup.body).includes('test-provider-credential'));
    const signed = await request('/api/workspace/session');
    assert.strictEqual(signed.body.authenticated, true);
    assert.deepStrictEqual(signed.body.context, context);
    assert.strictEqual((await request('/api/workspace/connections', { body: { token: body.token }, headers: { 'x-nv-csrf': anon.body.csrfToken } })).status, 403,
      'pre-authentication CSRF must not authorize authenticated operations');
    assert.strictEqual((await request('/api/workspace/connections', { body: { token: body.token }, headers: { 'x-nv-csrf': signed.body.csrfToken } })).status, 201);
    assert.strictEqual((await request('/api/repos')).body.code, 'ALPHA_ACCESS_REQUIRED', 'workspace cookie is not a cohort bypass');
    assert.strictEqual(legacyCalls, 1);
    assert.strictEqual((await request('/api/workspace/not-an-entry-point')).status, 404);
    assert.strictEqual(legacyCalls, 1, 'unknown foundation paths do not fall into other API handlers');
    unavailable = true;
    const failed = await request('/api/workspace/session');
    assert.strictEqual(failed.status, 503, 'storage failure must not fall back to an anonymous or cookie-only session');
    assert(!JSON.stringify(failed.body).includes('database secret'));
    unavailable = false;
    assert.strictEqual((await request('/api/workspace/sign-out', { body: {}, headers: { 'x-nv-csrf': signed.body.csrfToken } })).status, 200);
    assert.strictEqual(sessions.size, 0);
    assert.strictEqual((await request('/api/workspace/session')).body.authenticated, false);
  } finally { await new Promise(resolve => server.close(resolve)); }

  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mount = source.indexOf("app.use('/api/workspace', createWorkspaceRouter(");
  assert(mount > source.indexOf('if (!MAINTENANCE_MODE) return next();'), 'workspace APIs must honor maintenance');
  assert(mount < source.indexOf("app.use('/api', alphaAccessBoundary)"), 'only the narrow workspace router precedes invitations');
  assert(source.includes('verifiedHumanIdentity(account)'), 'provider-verified identity must be projected before storage');
  console.log('workspace API tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
