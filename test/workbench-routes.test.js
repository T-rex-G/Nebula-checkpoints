'use strict';

/*
 * The workbench routes the capability probes earned claims for, run through
 * the server against the transcribed GitHub model: the refusals the product
 * adds on top of the provider, which a probe against GitHub cannot show.
 *
 *   - a rename or a folder move onto a path that exists is refused, not an
 *     overwrite the provider would have accepted without a word;
 *   - a rename finds its source past a directory listing's thousand entries,
 *     and refuses a folder by name;
 *   - a merge carries the head the reviewer saw, and a moved head is refused;
 *   - a code search cannot widen its own scope with a qualifier;
 *   - a workflow run id is a number, not a path segment.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { hashJson } = require('../src/intelligence');
const { KEY_PURPOSES, deriveKey, deriveSecret } = require('../src/key-derivation');
const { createCsrfToken, createStepUpGrant, normalizeStepUpRequest, scopeHash } = require('../src/security-foundation');

const root = path.resolve(__dirname, '..');
const port = 33000 + Math.floor(Math.random() * 1000);
const secret = 'workbench-route-test-secret-0123456789abcdef-0123456789abcdef';
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const csrfSecret = deriveSecret(secret, KEY_PURPOSES.CSRF_TOKEN);
const stepUpSecret = deriveSecret(secret, KEY_PURPOSES.STEP_UP_GRANT);
const sessionNonce = 'c'.repeat(48);
const TOKEN = 'github-model-mutation-credential';
const account = { provider: 'github', authMethod: 'token', login: 'fixture-user', token: TOKEN };
const identity = hashJson({ provider: 'github', baseUrl: '', login: account.login });
const csrf = createCsrfToken(csrfSecret, { sessionBinding: sessionNonce, identityKey: identity });

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function cookie(stepUp = null) {
  return `nv_session=${seal({ accounts: [account], active: 0, security: { sessionNonce, stepUp } })}`;
}
function mutation(method, body, extra = {}, stepUp = null) {
  return {
    method,
    headers: { cookie: cookie(stepUp), 'content-type': 'application/json', 'x-nv': '1', 'x-nv-csrf': csrf, ...extra },
    body: JSON.stringify(body || {})
  };
}

const child = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'github-model-fetch.js'), 'server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    SESSION_SECRET: secret,
    DATABASE_URL: '',
    NV_GITHUB_MODEL_TOKEN: TOKEN,
    NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });

const request = (pathname, options = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, options);
const read = pathname => request(pathname, { headers: { cookie: cookie() } });
async function body(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { text }; }
}
async function files() {
  const response = await read('/api/repo/Acme/Demo/files?ref=main');
  assert.strictEqual(response.status, 200, logs);
  return (await response.json()).files.sort();
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs}`);
    try { if ((await request('/healthz')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready\n${logs}`);
}

function mergeStepUp(pullNumber) {
  const operation = normalizeStepUpRequest('pull.merge', { owner: 'Acme', repo: 'Demo', pullNumber, method: 'merge' },
    { provider: 'github', identityKey: identity });
  const jti = crypto.randomUUID();
  const record = { jti, action: operation.action, scopeHash: scopeHash(operation.scope), expiresAt: Date.now() + 300000, assurance: 'credential' };
  const grant = createStepUpGrant(stepUpSecret, {
    sessionBinding: sessionNonce, identityKey: identity, action: operation.action, scope: operation.scope, assurance: 'credential'
  }, { jti, ttlMs: 300000 });
  return { record, grant };
}

(async () => {
  try {
    await waitForServer();
    const before = await files();
    assert.deepStrictEqual(before, ['a.txt', 'b.txt', 'docs/one.md', 'docs/sub/two.md', 'guides/one.md']);

    /* ---- Rename ---------------------------------------------------------- */
    let response = await request('/api/repo/Acme/Demo/rename', mutation('POST', { from: 'a.txt', to: 'b.txt', branch: 'main' }));
    let answer = await body(response);
    assert.strictEqual(response.status, 409, JSON.stringify(answer));
    assert.strictEqual(answer.code, 'DESTINATION_EXISTS');
    assert.match(answer.error, /b\.txt already exists/);
    assert.deepStrictEqual(await files(), before, 'a refused rename changes nothing');

    response = await request('/api/repo/Acme/Demo/rename', mutation('POST', { from: 'a.txt', to: 'b.txt/inner.txt', branch: 'main' }));
    answer = await body(response);
    assert.strictEqual(response.status, 409, JSON.stringify(answer));
    assert.match(answer.error, /b\.txt is a file/);

    response = await request('/api/repo/Acme/Demo/rename', mutation('POST', { from: 'docs', to: 'documents', branch: 'main' }));
    answer = await body(response);
    assert.strictEqual(response.status, 400, JSON.stringify(answer));
    assert.strictEqual(answer.code, 'SOURCE_IS_FOLDER');

    response = await request('/api/repo/Acme/Demo/rename', mutation('POST', { from: 'a.txt', to: 'a.txt', branch: 'main' }));
    assert.strictEqual(response.status, 400);

    response = await request('/api/repo/Acme/Demo/rename', mutation('POST', { from: 'a.txt', to: 'archive/a.txt', branch: 'main' }));
    answer = await body(response);
    assert.strictEqual(response.status, 200, JSON.stringify(answer));
    assert.match(answer.commit, /^[0-9a-f]{40}$/);
    /* The commit a write returns is the head the next write is pinned to, as the client does. */
    const current = answer.commit;
    assert.deepStrictEqual(await files(), ['archive/a.txt', 'b.txt', 'docs/one.md', 'docs/sub/two.md', 'guides/one.md']);

    /* A stale view is refused rather than applied to a newer head. */
    response = await request('/api/repo/Acme/Demo/rename', mutation('POST', {
      from: 'b.txt', to: 'c.txt', branch: 'main', expectedHeadSha: '0'.repeat(40)
    }));
    answer = await body(response);
    assert.strictEqual(response.status, 409, JSON.stringify(answer));
    assert.strictEqual(answer.code, 'BRANCH_CHANGED');

    /* ---- Folder move ----------------------------------------------------- */
    response = await request('/api/repo/Acme/Demo/move-dir', mutation('POST', { from: 'docs', to: 'guides', branch: 'main', expectedHeadSha: current }));
    answer = await body(response);
    assert.strictEqual(response.status, 409, JSON.stringify(answer));
    assert.strictEqual(answer.code, 'DESTINATION_EXISTS');
    assert.match(answer.error, /guides\/one\.md already exists/);

    response = await request('/api/repo/Acme/Demo/move-dir', mutation('POST', { from: 'docs', to: 'manuals', branch: 'main', expectedHeadSha: current }));
    answer = await body(response);
    assert.strictEqual(response.status, 200, JSON.stringify(answer));
    assert.strictEqual(answer.moved, 2);
    assert.deepStrictEqual(await files(), ['archive/a.txt', 'b.txt', 'guides/one.md', 'manuals/one.md', 'manuals/sub/two.md']);

    /* ---- Merge with a pinned head ---------------------------------------- */
    const pulls = await body(await read('/api/repo/Acme/Demo/pulls?state=open'));
    const pull = pulls.find(item => item.title === 'Route test pull');
    assert(pull, JSON.stringify(pulls));
    const detail = await body(await read(`/api/repo/Acme/Demo/pulls/${pull.number}`));
    assert.match(String(detail.headSha), /^[0-9a-f]{40}$/, 'the pull request detail must carry the head it shows');

    let stepUp = mergeStepUp(pull.number);
    response = await request(`/api/repo/Acme/Demo/pulls/${pull.number}/merge`,
      mutation('PUT', { method: 'merge', expectedHeadSha: '9'.repeat(40) }, { 'x-nv-step-up': stepUp.grant }, stepUp.record));
    answer = await body(response);
    assert.strictEqual(response.status, 409, JSON.stringify(answer));
    assert.strictEqual(answer.code, 'PULL_HEAD_CHANGED');

    stepUp = mergeStepUp(pull.number);
    response = await request(`/api/repo/Acme/Demo/pulls/${pull.number}/merge`,
      mutation('PUT', { method: 'merge', expectedHeadSha: 'nope' }, { 'x-nv-step-up': stepUp.grant }, stepUp.record));
    assert.strictEqual(response.status, 400);

    stepUp = mergeStepUp(pull.number);
    response = await request(`/api/repo/Acme/Demo/pulls/${pull.number}/merge`,
      mutation('PUT', { method: 'merge', expectedHeadSha: detail.headSha }, { 'x-nv-step-up': stepUp.grant }, stepUp.record));
    answer = await body(response);
    assert.strictEqual(response.status, 200, JSON.stringify(answer));
    assert.match(answer.sha, /^[0-9a-f]{40}$/);
    assert((await files()).includes('feature.txt'), 'the merge lands the head it was pinned to');

    /* ---- Search scope ---------------------------------------------------- */
    for (const widened of ['secret repo:someone/else', 'x user:someone', 'a OR b', 'x org:acme']) {
      response = await read(`/api/repo/Acme/Demo/search?q=${encodeURIComponent(widened)}`);
      answer = await body(response);
      assert.strictEqual(response.status, 400, `${widened}: ${JSON.stringify(answer)}`);
      assert.strictEqual(answer.code, 'SEARCH_QUERY_INVALID');
    }
    response = await read(`/api/repo/Acme/Demo/search?q=${encodeURIComponent('nvx-alpha17-search-fixture')}`);
    answer = await body(response);
    assert.strictEqual(response.status, 200, JSON.stringify(answer));
    assert(Array.isArray(answer));

    /* ---- Workflow run ids ------------------------------------------------ */
    response = await request('/api/repo/Acme/Demo/actions/..%2F..%2Fhooks/rerun', mutation('POST', {}));
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await body(response)).code, 'WORKFLOW_RUN_INVALID');
    response = await read('/api/repo/Acme/Demo/actions/abc/jobs');
    assert.strictEqual(response.status, 400);

    console.log('workbench route tests passed');
  } catch (error) {
    console.error(error && error.stack || error);
    if (logs) console.error(logs.slice(-4000));
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
