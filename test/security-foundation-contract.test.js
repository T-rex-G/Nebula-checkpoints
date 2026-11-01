'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');
const neural = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'visualizations', 'neural.js'), 'utf8');

/* The guards that enforce it are identity and access's, composed by the server; each takes the platform's one security foundation. */
for (const guard of ['request-guards.ts', 'session-security.ts', 'repository-access.ts']) {
  assert(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'identity-access', 'application', guard), 'utf8').includes("/platform/authorization/security-foundation.ts';"), `${guard} must use the centralized security foundation module`);
}
assert(server.includes('createRequestGuards({') && server.includes('createSessionSecurity({') && server.includes('createRepositoryAccess({'), 'the server composes the guards');
{
  /* The same-origin step itself, on the requests it exists to refuse, and its place in front of every API route. */
  const { apiSameOrigin } = require('../apps/api/src/http/pipeline/index.ts');
  const { currentRoutePolicy } = require('./oracles/current-route-policy');
  const refuses = headers => {
    let passed = false;
    let status = 0;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    apiSameOrigin({})({ method: 'POST', headers: { 'x-nv': '1', ...headers }, protocol: 'https', get: () => 'nebulaverse.example' }, res, () => { passed = true; });
    return !passed && status === 403;
  };
  assert(refuses({ 'sec-fetch-site': 'cross-site' }) && refuses({ origin: 'https://evil.example' }) && !refuses({ origin: 'https://nebulaverse.example' }),
    'unsafe API requests must reject cross-site browser origins');
  const sequence = currentRoutePolicy(root).sequence;
  const sameOrigin = sequence.findIndex(entry => entry.kind === 'middleware' && entry.label === 'api-same-origin' && entry.mount === '/api');
  const firstApiRoute = sequence.findIndex(entry => entry.kind === 'route' && entry.path.startsWith('/api/'));
  assert(sameOrigin > -1 && sameOrigin < firstApiRoute, 'the same-origin step must stand in front of every API route');
}
{
  /* Wherever they are registered, as the route policy reads them. */
  const { currentRoutePolicy } = require('./oracles/current-route-policy');
  const routes = currentRoutePolicy(root).sequence.filter(entry => entry.kind === 'route');
  assert(routes.some(entry => entry.method === 'GET' && entry.path === '/api/security/csrf'), 'authenticated clients need a CSRF token endpoint');
  assert(routes.some(entry => entry.method === 'POST' && entry.path === '/api/security/step-up'), 'sensitive actions need a step-up grant endpoint');
}
/* The guards are identity and access's (application/request-guards.ts), composed by the server. */
assert(/async function auth[\s\S]+verifyRequestCsrf[\s\S]+sensitiveOperationFor[\s\S]+consumeStepUpAuthorization/.test(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'identity-access', 'application', 'request-guards.ts'), 'utf8'))
  && server.includes('createRequestGuards({'), 'auth must centrally enforce CSRF and single-use step-up grants');
assert(server.includes("authMethod: 'token'")
  && fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'identity-access', 'http', 'oauth-routes.ts'), 'utf8').includes("authMethod: 'oauth'"),
'session accounts must preserve the authentication method');
{
  /* Wherever the route is registered, as the route policy reads its chain. */
  const { currentRoutePolicy } = require('./oracles/current-route-policy');
  const logout = currentRoutePolicy(root).sequence.find(entry => entry.kind === 'route' && entry.method === 'POST' && entry.path === '/api/logout');
  assert(logout && ['auth', 'accountAuth'].includes(logout.guards[0]), 'logout must be an authenticated CSRF-protected mutation');
}

assert(app.includes("'x-nv-csrf': csrfToken"), 'JSON mutations must carry the CSRF token');
assert(app.includes("opts.headers"), 'API helper must support action-specific authorization headers');
assert(app.includes('async function requestStepUp'), 'client must request action-scoped step-up authorization');
assert(app.includes("'x-nv-step-up': grant"), 'sensitive mutations must carry the one-time step-up grant');
assert((app.match(/setRequestHeader\('x-nv-csrf'/g) || []).length >= 2, 'raw upload paths must carry CSRF tokens');
assert(/repository\.delete[\s\S]+method: 'DELETE'/.test(app), 'repository deletion must use step-up authorization');
assert(/branch\.reset[\s\S]+\/reset/.test(app), 'hard reset must use step-up authorization');
assert(/pull\.merge[\s\S]+pulls\/\$\{p\.number\}\/merge/.test(app), 'PR merge must use step-up authorization');
assert(/sessions\.revoke-others[\s\S]+revoke-others/.test(neural), 'revoking other sessions must use step-up authorization');
assert(/sessions\.revoke-others[\s\S]+emergency-manifest/.test(neural), 'Emergency Shield must not bypass session-revocation step-up authorization');

console.log('security foundation contract tests passed');
