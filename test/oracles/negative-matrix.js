'use strict';
/*
 * The negative-request matrix: every route, asked by callers who should be
 * refused -- or who should get exactly as far as they got before -- and the
 * status and error code each one received.
 *
 * Captured from the monolith before anything moved. The decomposed server must
 * answer every cell the same way; a guard moved below a handler, a public route
 * that grew a check, or a protected one that lost it shows up as a changed cell.
 *
 * Each context speaks from its own loopback address, so the per-address API
 * admission limit (300 a minute) is never what a cell records.
 */
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { deriveKey, KEY_PURPOSES } = require('../../src/key-derivation');
const { withLifetime } = require('../fixtures/local-session');
const { serverEntry } = require('../helpers/server-entry');

const SESSION_SECRET = ['oracle', 'matrix', '0123456789abcdef', '0123456789abcdef'].join('-');
const SNAPSHOT_SECRET = ['oracle', 'snapshot', 'fedcba9876543210', 'fedcba9876543210'].join('-');
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SAMPLE_PARAMS = Object.freeze({
  owner: 'sandbox', repo: 'demo', hookId: '1', policyId: '10000000-0000-4000-8000-000000000001',
  versionId: '30000000-0000-4000-8000-000000000003', draftId: '60000000-0000-4000-8000-000000000006',
  exceptionId: '50000000-0000-4000-8000-000000000005', webhookId: '70000000-0000-4000-8000-000000000007',
  fingerprint: 'a'.repeat(64), number: '1', id: '1', name: 'main', sha: 'b'.repeat(40), tag: 'v1.0.0'
});

function samplePath(routePath) {
  if (routePath === '/vendor/*') return '/vendor/oracle/0.0.0/missing.js';
  return routePath
    .replace(/:([A-Za-z]+)(\([^)]*\))?\??/g, (_, name) => SAMPLE_PARAMS[name] || 'p1')
    .replace(/\*/g, 'oracle');
}

function seal(value) {
  const key = deriveKey(SESSION_SECRET, KEY_PURPOSES.SESSION_CONTENT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(withLifetime(value)), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function sessionCookie(token, login) {
  return `nv_session=${seal({
    accounts: [{ token, login, avatar: '', provider: 'github', baseUrl: '', authMethod: 'token' }],
    active: 0
  })}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, { method, pathname, headers = {}, body, localAddress }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname, localAddress,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(20000, () => req.destroy(new Error(`${method} ${pathname} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function codeOf(response) {
  if (!/json/.test(String(response.headers['content-type'] || ''))) return null;
  try {
    const parsed = JSON.parse(response.body);
    if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') return parsed.code;
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(parsed.error)) {
      return parsed.error;
    }
  } catch {}
  return null;
}

async function startServer(root) {
  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, ['--require', path.join(root, 'test', 'fixtures', 'oracle-provider-fetch.js'), serverEntry(root)], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      SESSION_SECRET,
      NV_SNAPSHOT_SIGNING_KEY_ID: 'oracle-snapshot-key',
      NV_SNAPSHOT_SIGNING_SECRET: SNAPSHOT_SECRET,
      DATABASE_URL: '',
      NV_ALPHA_ACCESS_MODE: 'off',
      NV_MAINTENANCE_MODE: '',
      NV_TRUSTED_PROXIES: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})\n${logs}`);
    try {
      if ((await request(port, { method: 'GET', pathname: '/healthz' })).status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server did not start\n${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { port, child, logs: () => logs };
}

async function csrfFor(port, cookie, localAddress) {
  const response = await request(port, { method: 'GET', pathname: '/api/security/csrf', headers: { cookie }, localAddress });
  if (response.status !== 200) throw new Error(`CSRF issue failed: ${response.status} ${response.body}`);
  const refreshed = [].concat(response.headers['set-cookie'] || [])
    .map(line => /^nv_session=([^;]+)/.exec(line)).find(Boolean);
  return { token: JSON.parse(response.body).token, cookie: refreshed ? `nv_session=${refreshed[1]}` : cookie };
}

/*
 * The contexts, in the order they run. `unsafeOnly` contexts differ from
 * `anonymous` only for state-changing methods: the same-origin and app-header
 * checks pass every GET by design.
 */
const CONTEXTS = Object.freeze([
  { name: 'anonymous', address: '127.0.0.11', unsafeOnly: false },
  { name: 'no-app-header', address: '127.0.0.12', unsafeOnly: true },
  { name: 'cross-site', address: '127.0.0.13', unsafeOnly: true },
  { name: 'foreign-origin', address: '127.0.0.14', unsafeOnly: true },
  { name: 'forged-session', address: '127.0.0.15', unsafeOnly: false },
  { name: 'reader-without-csrf', address: '127.0.0.16', unsafeOnly: true },
  { name: 'reader', address: '127.0.0.17', unsafeOnly: false },
  { name: 'administrator-without-step-up', address: '127.0.0.18', unsafeOnly: true }
]);

async function headersFor(context, port) {
  switch (context.name) {
    case 'anonymous': return { 'x-nv': '1' };
    case 'no-app-header': return {};
    case 'cross-site': return { 'x-nv': '1', 'sec-fetch-site': 'cross-site' };
    case 'foreign-origin': return { 'x-nv': '1', origin: 'https://attacker.invalid' };
    case 'forged-session': return { 'x-nv': '1', cookie: `nv_session=${crypto.randomBytes(48).toString('base64url')}` };
    case 'reader-without-csrf': return { 'x-nv': '1', cookie: sessionCookie('oracle-reader-token', 'oracle-reader') };
    case 'reader': {
      const { token, cookie } = await csrfFor(port, sessionCookie('oracle-reader-token', 'oracle-reader'), context.address);
      return { 'x-nv': '1', 'x-nv-csrf': token, cookie };
    }
    case 'administrator-without-step-up': {
      const { token, cookie } = await csrfFor(port, sessionCookie('oracle-admin-token', 'oracle-admin'), context.address);
      return { 'x-nv': '1', 'x-nv-csrf': token, cookie };
    }
    default: throw new Error(`unknown context ${context.name}`);
  }
}

/*
 * Routes whose answer to a signed-in caller is the end of that caller's session
 * or a stream that never ends. They are asked anonymously only; their signed-in
 * behaviour has dedicated server tests (logout, revocation, live events).
 */
const SESSION_ENDING = new Set([
  'POST /api/logout', 'POST /api/security/revoke-others', 'POST /api/accounts/remove',
  'POST /api/provider/disconnect', 'POST /api/alpha/end'
]);
const STREAMING = /\/(?:stream|live-events\/stream)$/;

async function runNegativeMatrix(root, policy) {
  const routes = policy.sequence.filter(entry => entry.kind === 'route');
  const server = await startServer(root);
  const cells = [];
  try {
    for (const context of CONTEXTS) {
      const headers = await headersFor(context, server.port);
      for (const route of routes) {
        const id = `${route.method} ${route.path}`;
        if (context.unsafeOnly && !UNSAFE.has(route.method)) continue;
        if (context.name !== 'anonymous' && context.name !== 'no-app-header' &&
            context.name !== 'cross-site' && context.name !== 'foreign-origin' &&
            (SESSION_ENDING.has(id) || STREAMING.test(route.path))) continue;
        if (route.method === 'GET' && STREAMING.test(route.path)) continue;
        const response = await request(server.port, {
          method: route.method, pathname: samplePath(route.path), headers,
          body: UNSAFE.has(route.method) ? {} : undefined, localAddress: context.address
        });
        cells.push({ route: id, context: context.name, status: response.status, code: codeOf(response) });
      }
    }
  } finally {
    server.child.kill('SIGTERM');
  }
  return { schemaVersion: 1, contexts: CONTEXTS.map(context => context.name), cells };
}

module.exports = { runNegativeMatrix, samplePath, CONTEXTS };
