'use strict';
/*
 * The global steps of the HTTP pipeline, each on its own (D11).
 *
 * The server's own tests see these through a running process in one
 * environment at a time. Here each step is handed the environments it has to
 * tell apart -- production and not, a configured public origin and a missing
 * one -- and what it does to the response is read call by call. Where the
 * steps sit among the routes is the route policy's to hold
 * (test/architecture-oracles.test.js); the rate admission step has its own
 * contract (test/rate-limit-server-contract.test.js).
 */
const assert = require('assert/strict');
const {
  retireLegacyCookies, securityHeaders, PERMISSIONS_POLICY, contentSecurityPolicy, apiNoStore,
  apiSameOrigin, SAFE_API_METHODS, apiMaintenance, maintenanceMode
} = require('../apps/api/src/http/pipeline/index.ts');

/* A response that records each call made on it, and the headers it holds. */
function response() {
  const calls = [];
  const headers = new Map();
  const res = {
    statusCode: 200,
    calls,
    header: name => headers.get(name.toLowerCase()),
    setHeader(name, value) { calls.push(['setHeader', name]); headers.set(name.toLowerCase(), value); },
    removeHeader(name) { calls.push(['removeHeader', name]); headers.delete(name.toLowerCase()); },
    clearCookie(name, options) { calls.push(['clearCookie', name, options]); },
    vary(name) { calls.push(['vary', name]); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    writeHead(status) { calls.push(['writeHead', status]); return this; }
  };
  return res;
}
function request(fields = {}) {
  const host = fields.host === undefined ? 'nebulaverse.example' : fields.host;
  return { method: 'GET', headers: {}, protocol: 'https', get: name => name === 'host' ? host : undefined, ...fields };
}
function step(handler, req, res = response()) {
  let passed = false;
  handler(req, res, () => { passed = true; });
  return { res, passed };
}

/* Retired owner cookies are cleared where they arrive, Secure in production, and never adopted. */
{
  const req = request({ headers: { cookie: 'theme=dark; nv_workspace_session=old; nv_workspace_oauth_intent=x' } });
  const { res, passed } = step(retireLegacyCookies({ NODE_ENV: 'production' }), req);
  assert(passed);
  assert.deepStrictEqual(res.calls, [
    ['clearCookie', 'nv_workspace_session', { path: '/api/workspace', httpOnly: true, secure: true }],
    ['clearCookie', 'nv_workspace_oauth_intent', { path: '/', httpOnly: true, secure: true }]
  ]);
  const local = step(retireLegacyCookies({}), request({ headers: { cookie: 'nv_workspace_challenge=1' } })).res;
  assert.deepStrictEqual(local.calls, [['clearCookie', 'nv_workspace_challenge', { path: '/api/workspace', httpOnly: true, secure: false }]]);
  /* A cookie whose name only begins like a retired one is someone else's. */
  assert.deepStrictEqual(step(retireLegacyCookies({}), request({ headers: { cookie: 'nv_workspace_sessionx=1' } })).res.calls, []);
}

/* Every answer is framed, sniff-proof and isolated; production adds HSTS and upgrades. */
for (const production of [true, false]) {
  const { res, passed } = step(securityHeaders(production ? { NODE_ENV: 'production' } : { NODE_ENV: 'test' }), request());
  assert(passed);
  assert.strictEqual(res.header('X-Content-Type-Options'), 'nosniff');
  assert.strictEqual(res.header('X-Frame-Options'), 'DENY');
  assert.strictEqual(res.header('Referrer-Policy'), 'no-referrer');
  assert.strictEqual(res.header('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.strictEqual(res.header('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.strictEqual(res.header('Permissions-Policy'), PERMISSIONS_POLICY);
  assert.strictEqual(res.header('Strict-Transport-Security'), production ? 'max-age=31536000; includeSubDomains' : undefined);
  const csp = res.header('Content-Security-Policy');
  assert.strictEqual(csp, contentSecurityPolicy(production));
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert(csp.split('; ').includes(directive), directive);
  }
  assert.strictEqual(csp.split('; ').includes('upgrade-insecure-requests'), production);
}
/* Every powerful feature the product never uses is switched off, not left to a default. */
for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'publickey-credentials-get']) {
  assert(PERMISSIONS_POLICY.split(', ').includes(`${feature}=()`), feature);
}

/* An API answer is no-store unless it is a 200 the offline binding vouches for. */
{
  const binding = { scope: 's'.repeat(32), repoKey: 'github:owner/repo' };
  const bound = step(apiNoStore(() => binding), request()).res;
  assert.strictEqual(bound.header('Cache-Control'), 'no-store', 'no-store until the status line is written');
  assert.strictEqual(bound.writeHead(200), bound, 'the patched writeHead still answers the response');
  assert.strictEqual(bound.header('Cache-Control'), 'private, max-age=0, must-revalidate');
  assert.strictEqual(bound.header('X-NV-Offline-Scope'), binding.scope);
  assert.strictEqual(bound.header('X-NV-Offline-Repo'), binding.repoKey);
  assert.deepStrictEqual(bound.calls.filter(call => call[0] === 'vary').map(([, name]) => name.toLowerCase()), ['cookie', 'x-nv-offline-scope', 'x-nv-offline-repo']);
  assert.deepStrictEqual(bound.calls.at(-1), ['writeHead', 200]);

  let asked = 0;
  const failed = step(apiNoStore(() => { asked += 1; return binding; }), request()).res;
  failed.setHeader('X-NV-Offline-Scope', 'stale');
  failed.writeHead(404);
  assert.strictEqual(asked, 0, 'only a 200 is offered to the binding');
  assert.strictEqual(failed.header('Cache-Control'), 'no-store');
  assert.strictEqual(failed.header('X-NV-Offline-Scope'), undefined, 'a refusal never carries an offline scope');

  const unbound = step(apiNoStore(() => null), request()).res;
  unbound.statusCode = 200;
  unbound.writeHead();
  assert.strictEqual(unbound.header('Cache-Control'), 'no-store');
}

/* Unsafe API calls must be intentional and same-origin. */
{
  const env = { PUBLIC_BASE_URL: 'https://app.nebulaverse.example' };
  const send = (method, headers, host) => step(apiSameOrigin(env), request({ method, headers, host }));
  for (const method of SAFE_API_METHODS) assert(send(method, {}).passed, `${method} is safe`);
  const missing = send('POST', {});
  assert(!missing.passed);
  assert.deepStrictEqual([missing.res.statusCode, missing.res.body.code], [403, 'APP_HEADER_REQUIRED']);
  const crossSite = send('POST', { 'x-nv': '1', 'sec-fetch-site': 'Cross-Site' });
  assert.deepStrictEqual([crossSite.passed, crossSite.res.body.code], [false, 'CROSS_SITE_REQUEST']);
  assert(send('POST', { 'x-nv': '1' }).passed, 'no Origin header: the app header and fetch metadata decide');
  assert(send('DELETE', { 'x-nv': '1', origin: 'https://nebulaverse.example' }).passed, 'the request\'s own host');
  assert(send('PATCH', { 'x-nv': '1', origin: 'https://app.nebulaverse.example' }).passed, 'the configured public origin');
  for (const origin of ['https://evil.example', 'http://nebulaverse.example', 'null', 'not a url', 'https://app.nebulaverse.example.evil.example']) {
    const refused = send('POST', { 'x-nv': '1', origin });
    assert.deepStrictEqual([refused.passed, refused.res.statusCode, refused.res.body.code], [false, 403, 'CROSS_SITE_REQUEST'], origin);
  }
  /* A malformed configured origin is ignored, not trusted. */
  assert(!step(apiSameOrigin({ PUBLIC_BASE_URL: 'not a url' }), request({ method: 'POST', headers: { 'x-nv': '1', origin: 'not a url' } })).passed);
}

/* Maintenance: an operator's word, read once, answered with a retry hint and no change made. */
{
  for (const [value, expected] of [['1', true], ['true', true], [' ON ', true], ['yes', true], ['0', false], ['', false], ['no', false], ['2', false]]) {
    assert.strictEqual(maintenanceMode({ NV_MAINTENANCE_MODE: value }), expected, JSON.stringify(value));
  }
  assert.strictEqual(maintenanceMode({}), false);
  assert(step(apiMaintenance(false), request()).passed);
  const { res, passed } = step(apiMaintenance(true), request());
  assert(!passed);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.header('Retry-After'), '120');
  assert.strictEqual(res.header('Cache-Control'), 'no-store');
  assert.strictEqual(res.body.error, 'SERVICE_IN_MAINTENANCE');
}

console.log('http pipeline tests passed');
