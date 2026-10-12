'use strict';

/*
 * A provider rate limit is a rate limit, whatever status carries it.
 *
 * GitHub answers an exhausted primary limit, and a secondary limit, with 403
 * rather than 429. The server read every 403 as "forbidden": the reader was
 * told their credential could not do what it had just been doing, the
 * deletion and webhook routes offered permission advice for it, and nothing
 * said when to try again. Against the real server:
 *
 *   - a 403 that carries an exhausted limit, or a retry-after, answers 429
 *     PROVIDER_RATE_LIMITED with Retry-After from GitHub's own reset;
 *   - a 429 does the same;
 *   - a 403 without either is still a refusal, with no Retry-After;
 *   - the server asks the provider once per request and leaves the retrying to
 *     the client it has told when to retry.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
let child;
let output = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const providerRequests = () => (output.match(/RATE_FIXTURE_REQUEST/g) || []).length;

async function main() {
  const port = await freePort();
  child = spawn(process.execPath, ['-r', './test/fixtures/provider-rate-limit-fetch.js', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '', NV_ALPHA_ACCESS_MODE: 'off',
      NV_DEPLOYMENT_PROFILE: 'local', SESSION_SECRET: crypto.randomBytes(40).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited\n${output}`);
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`server did not start\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nv': '1' },
    body: JSON.stringify({ provider: 'github', token: 'rate-fixture-only' }) });
  assert.strictEqual(login.status, 200, await login.clone().text());
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const read = async repo => {
    const before = providerRequests();
    const response = await fetch(`${origin}/api/repo/acme/${repo}`, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    /* The repository route asks for the repository and its branches at once. */
    await new Promise(resolve => setTimeout(resolve, 50));
    return { status: response.status, code: body.code, error: body.error, retryAfter: response.headers.get('retry-after'),
      requests: providerRequests() - before };
  };

  const primary = await read('primary');
  assert.strictEqual(primary.status, 429, `an exhausted primary limit is not a refusal: ${JSON.stringify(primary)}`);
  assert.strictEqual(primary.code, 'PROVIDER_RATE_LIMITED');
  const primaryWait = Number(primary.retryAfter);
  assert(Number.isInteger(primaryWait) && primaryWait >= 40 && primaryWait <= 43,
    `Retry-After must come from GitHub's reset, 42 s away: ${primary.retryAfter}`);
  assert.strictEqual(primary.requests, 2, 'one request each for the repository and its branches, and no retry');

  const secondary = await read('secondary');
  assert.deepStrictEqual([secondary.status, secondary.code, secondary.retryAfter], [429, 'PROVIDER_RATE_LIMITED', '30'],
    `a secondary limit is a rate limit: ${JSON.stringify(secondary)}`);
  assert.match(secondary.error, /secondary rate limit/i, 'GitHub\'s own explanation reaches the reader');

  const tooMany = await read('too-many');
  assert.deepStrictEqual([tooMany.status, tooMany.code, tooMany.retryAfter], [429, 'PROVIDER_RATE_LIMITED', '7']);

  const denied = await read('denied');
  assert.deepStrictEqual([denied.status, denied.code, denied.retryAfter], [403, 'PROVIDER_FORBIDDEN', null],
    `a refusal without a limit stays a refusal: ${JSON.stringify(denied)}`);

  console.log('provider rate limit server tests passed');
}

main().catch(error => { console.error(error); console.error(output.slice(-3000)); process.exitCode = 1; }).finally(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
});
