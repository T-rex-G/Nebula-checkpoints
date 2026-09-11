'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { hashJson } = require('../src/intelligence');
const { KEY_PURPOSES, deriveKey, deriveSecret } = require('../src/key-derivation');
const { createCsrfToken, createStepUpGrant, normalizeStepUpRequest, scopeHash } = require('../src/security-foundation');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-account-operations-'));
const log = path.join(temp, 'provider.jsonl');
const secret = 'account-operations-fixture-secret-0123456789abcdef';
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const csrfKey = deriveSecret(secret, KEY_PURPOSES.CSRF_TOKEN);
const stepUpKey = deriveSecret(secret, KEY_PURPOSES.STEP_UP_GRANT);
const port = 33000 + Math.floor(Math.random() * 1000);
const account = { provider: 'github', authMethod: 'token', login: 'alice', providerAccountId: 7, token: 'fixture-admin' };
let logs = '';
const child = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures/github-account-operations-fetch.js'), 'server.js'], {
  cwd: root, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), SESSION_SECRET: secret,
    DATABASE_URL: '', GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret',
    NV_ALPHA_ACCESS_MODE: 'off', NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn', NV_ACCOUNT_OPERATIONS_LOG: log },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });

function session(selected = account, repository = null, safety = {}) {
  const sessionNonce = crypto.randomBytes(24).toString('hex');
  const identityKey = hashJson({ provider: selected.provider, baseUrl: '', login: selected.login });
  const security = { sessionNonce, stepUp: null };
  let grant;
  if (repository) {
    const [owner, repo] = repository.split('/');
    const operation = normalizeStepUpRequest('repository.delete', { owner, repo }, { provider: 'github', identityKey });
    const jti = crypto.randomUUID();
    security.stepUp = { jti, action: operation.action, scopeHash: scopeHash(operation.scope), expiresAt: Date.now() + 300000, assurance: 'credential' };
    grant = createStepUpGrant(stepUpKey, { sessionBinding: sessionNonce, identityKey, action: operation.action, scope: operation.scope, assurance: 'credential' }, { jti, ttlMs: 300000 });
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ accounts: [selected], active: 0, security, safety }), 'utf8'), cipher.final()]);
  return {
    cookie: `nv_session=${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`,
    'x-nv': '1', 'content-type': 'application/json',
    'x-nv-csrf': createCsrfToken(csrfKey, { sessionBinding: sessionNonce, identityKey }),
    ...(grant ? { 'x-nv-step-up': grant } : {})
  };
}
const events = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const mutations = () => events().filter(event => ['POST', 'DELETE'].includes(event.method));
const request = (route, options) => fetch(`http://127.0.0.1:${port}${route}`, options);
async function check(route, options, expected) {
  const response = await request(route, options);
  const body = await response.json();
  assert.strictEqual(response.status, expected, JSON.stringify(body));
  return { response, body };
}
async function main() {
  try {
    const deadline = Date.now() + 10000;
    while (true) {
      try { if ((await request('/healthz')).ok) break; } catch {}
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await check('/api/account/capabilities', {}, 401);
    const ordinaryOAuth = await request('/api/oauth/login', { redirect: 'manual' });
    assert.strictEqual(new URL(ordinaryOAuth.headers.get('location')).searchParams.get('scope'), 'repo');
    const deletionOAuth = await request('/api/oauth/login?permission=repository-delete', { redirect: 'manual' });
    assert.strictEqual(new URL(deletionOAuth.headers.get('location')).searchParams.get('scope'), 'repo delete_repo');
    const projected = await check('/api/account/capabilities', { headers: session() }, 200);
    assert.match(projected.response.headers.get('cache-control'), /no-store/);
    for (const feature of ['repository.create', 'repository.delete', 'global-search', 'notifications']) {
      assert.strictEqual(projected.body.features[feature].status, 'Experimental');
    }
    assert(!JSON.stringify(projected.body).includes(account.token));
    const fine = await check('/api/account/capabilities', { headers: session({ ...account, token: 'github_pat_fixture' }) }, 200);
    assert.strictEqual(fine.body.features.notifications.status, 'Unavailable');
    assert.strictEqual(fine.body.features['repository.create'].status, 'Experimental');
    const beforeFine = events();
    await check('/api/notifications', { headers: session({ ...account, token: 'github_pat_fixture' }) }, 409);
    assert.deepStrictEqual(events(), beforeFine, 'unsupported notification credentials must never reach GitHub');
    const beforeInvalid = mutations();
    await check('/api/repos', { method: 'POST', headers: session(), body: JSON.stringify({ name: '../other' }) }, 400);
    const csrfMissing = session(); delete csrfMissing['x-nv-csrf'];
    await check('/api/repos', { method: 'POST', headers: csrfMissing, body: JSON.stringify({ name: 'demo' }) }, 403);
    assert.deepStrictEqual(mutations(), beforeInvalid);
    const created = await check('/api/repos', { method: 'POST', headers: session(), body: JSON.stringify({ name: 'demo' }) }, 201);
    assert.strictEqual(created.body.verified, true);
    assert.strictEqual(created.body.full_name, 'alice/demo');
    await check('/api/repo/alice/demo', { headers: session() }, 200);
    const search = await check('/api/search?q=hello', { headers: session() }, 200);
    assert.deepStrictEqual(search.body, [{ repo: 'team/project', path: 'README.md' }]);
    assert.strictEqual(new URLSearchParams(events().find(event => event.path === '/search/code').query).get('q'), 'hello');
    const inbox = await check('/api/notifications', { headers: session() }, 200);
    assert.strictEqual(inbox.body[0].repo, 'team/project');
    const beforeDelete = mutations();
    await check('/api/repo/alice/demo', { method: 'DELETE', headers: session(account, 'alice/demo'), body: '{}' }, 400);
    await check('/api/repo/alice/demo', { method: 'DELETE', headers: session(), body: JSON.stringify({ confirmation: 'alice/demo' }) }, 403);
    await check('/api/repo/alice/demo', { method: 'DELETE', headers: session(account, 'alice/other'), body: JSON.stringify({ confirmation: 'alice/demo' }) }, 403);
    await check('/api/repo/alice/demo', { method: 'DELETE', headers: session(account, 'alice/demo', { readOnly: true }), body: JSON.stringify({ confirmation: 'alice/demo' }) }, 423);
    await check('/api/repo/alice/demo', { method: 'DELETE', headers: session({ ...account, token: 'fixture-read-only' }, 'alice/demo'), body: JSON.stringify({ confirmation: 'alice/demo' }) }, 403);
    assert.deepStrictEqual(mutations(), beforeDelete, 'refused deletions must not mutate a repository');
    const authorized = session(account, 'alice/demo');
    const deleted = await check('/api/repo/alice/demo', { method: 'DELETE', headers: authorized, body: JSON.stringify({ confirmation: 'alice/demo' }) }, 200);
    assert.strictEqual(deleted.body.ok, true);
    const afterDelete = mutations();
    await check('/api/repo/alice/demo', { method: 'DELETE', headers: authorized, body: JSON.stringify({ confirmation: 'alice/demo' }) }, 403);
    assert.deepStrictEqual(mutations(), afterDelete, 'a deletion grant cannot be replayed');
    await check('/api/repo/alice/demo', { method: 'DELETE', headers: session({ ...account, token: 'fixture-no-deletion' }, 'alice/demo'), body: JSON.stringify({ confirmation: 'alice/demo' }) }, 403);
    console.log('GitHub account operations server integration tests passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
