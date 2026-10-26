'use strict';

/*
 * The hosted alpha's boundary in front of every route, read from the route
 * policy (test/oracles/route-policy.js), so a route counts wherever it is
 * registered: in server.js or in a module's routes. A repository route
 * attaches the local provider session, then the invitation's repository
 * boundary, then capability access, then the live provider credentials, and
 * only then any governance or mutation context; the semantic surfaces carry
 * their own boundaries; and the global boundary precedes the first protected
 * API route.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { locations } = require('./oracles/route-policy');

const root = path.resolve(__dirname, '..');
const capabilityDocument = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'public-alpha-capabilities.json'), 'utf8')
);
const policy = locations(root);

function validateAlphaRouteInventory(entries) {
  const registrations = entries.filter(entry => entry.kind === 'route');
  const repositoryRoutes = registrations.filter(
    route => route.path && route.path.startsWith('/api/repo/:owner/:repo')
  );
  assert(repositoryRoutes.length >= 100, 'repository inventory unexpectedly lost route families');
  for (const route of repositoryRoutes) {
    const key = `${route.method} ${route.path}`;
    assert.strictEqual(
      route.guards[0],
      'providerSessionAccess',
      `${key} must attach only the local provider session before alpha authorization`
    );
    assert.strictEqual(
      route.guards[1],
      'alphaRepositoryAccess',
      `${key} must enforce the invitation repository boundary before live provider credentials`
    );
    const authIndex = route.guards.indexOf('auth');
    assert(authIndex > 1, `${key} must resolve live provider credentials only after alpha authorization`);
    const capabilityIndexes = route.guards
      .map((guard, index) => guard.startsWith('capabilityAccess(') ? index : -1)
      .filter(index => index >= 0);
    for (const capabilityIndex of capabilityIndexes) {
      assert(
        capabilityIndex > 1 && capabilityIndex < authIndex,
        `${key} must run capability access after alpha authorization and before live provider credentials`
      );
    }
    for (const guarded of ['governanceAccess', 'governanceMutationContext', 'mutationContext']) {
      const guardedIndex = route.guards.findIndex(guard => guard.startsWith(`${guarded}(`));
      if (guardedIndex >= 0) {
        assert(
          guardedIndex > authIndex,
          `${key} must preserve ${guarded} after provider authentication`
        );
      }
    }
  }
  return { registrations, repositoryRoutes };
}

function assertMiddlewarePrefix(registration, expected, message) {
  assert(registration, message.replace(' must ', ' is missing and must '));
  assert.deepStrictEqual(registration.guards.slice(0, expected.length), expected, message);
}

function validateSemanticRepositorySurfaces(entries) {
  const findRoute = (method, routePath) => entries.find(
    entry => entry.kind === 'route' && entry.method === method && entry.path === routePath
  );
  const surfaces = [
    ['GET', '/api/repos', [
      'providerSessionAccess',
      'alphaRepositoryListAccess',
      "capabilityAccess('repository.read')",
      'auth'
    ]],
    ['POST', '/api/repos', [
      'providerSessionAccess',
      "capabilityAccess('repository.create')",
      'repositoryCreationAccess',
      'auth'
    ]],
    ['GET', '/api/search', [
      'providerSessionAccess',
      "capabilityAccess('global-search')",
      'githubSearchAccess',
      'auth'
    ]],
    ['GET', '/api/notifications', [
      'providerSessionAccess',
      "capabilityAccess('notifications')",
      'auth'
    ]],
    ['POST', '/api/security/step-up', [
      'providerSessionAccess',
      'alphaStepUpRepositoryAccess',
      'auth'
    ]],
    ['POST', '/api/safety', [
      'providerSessionAccess',
      'alphaSafetyMutationAccess',
      'accountAuth'
    ]]
  ];
  for (const [method, routePath, expected] of surfaces) {
    assertMiddlewarePrefix(
      findRoute(method, routePath),
      expected,
      `${method} ${routePath} must enforce its semantic alpha/capability gates before credential or state access`
    );
  }
  const safetyRead = findRoute('GET', '/api/safety');
  assertMiddlewarePrefix(
    safetyRead,
    ['providerSessionAccess', 'accountAuth'],
    'GET /api/safety must use local provider authentication without live credentials'
  );
  /* The read answers through the alpha scope view: the handler is read where the route policy found it. */
  const [file, line] = safetyRead.at.split(':');
  const handler = fs.readFileSync(path.join(root, file), 'utf8').split('\n')[Number(line) - 1];
  assert(
    handler.includes("app.get('/api/safety'") && handler.includes('alphaSafetyView'),
    'GET /api/safety must filter protected repository metadata through the alpha scope view'
  );
  return entries;
}

const { registrations, repositoryRoutes } = validateAlphaRouteInventory(policy);
validateSemanticRepositorySurfaces(policy);
const route = (method, routePath) => registrations.find(
  entry => entry.method === method && entry.path === routePath
);

for (const [method, routePath] of [
  ['GET', '/api/alpha/status'],
  ['POST', '/api/alpha/redeem'],
  ['POST', '/api/alpha/end']
]) {
  assert(route(method, routePath), `missing ${method} ${routePath}`);
}

const position = entry => policy.indexOf(entry);
const alphaBoundary = policy.find(
  entry => entry.kind === 'use'
    && entry.mount === '/api'
    && entry.label === 'alpha-access-boundary'
);
assert(alphaBoundary, 'the global alpha boundary must be mounted for /api');
const firstProtectedApi = registrations
  .filter(entry => entry.path && entry.path.startsWith('/api/'))
  .filter(entry => !new Set([
    '/api/version',
    '/api/config',
    '/api/capabilities',
    '/api/alpha/status',
    '/api/alpha/redeem'
  ]).has(entry.path))
  .sort((left, right) => position(left) - position(right))[0];
assert(
  position(alphaBoundary) < position(firstProtectedApi),
  'the global alpha boundary must precede the first protected API route'
);

for (const [method, routePath, feature] of [
  ['POST', '/api/repos', 'repository.create'],
  ['DELETE', '/api/repo/:owner/:repo', 'repository.delete'],
  ['GET', '/api/search', 'global-search'],
  ['GET', '/api/notifications', 'notifications']
]) {
  const registration = route(method, routePath);
  assert(registration, `missing ${method} ${routePath}`);
  assert(
    registration.guards.some(guard => guard.startsWith(`capabilityAccess('${feature}'`)),
    `${method} ${routePath} must fail through ${feature} before provider transport`
  );
}

const repositoryList = route('GET', '/api/repos');
assert(repositoryList, 'missing GET /api/repos');
assert.deepStrictEqual(
  repositoryList.guards.slice(0, 4),
  ['providerSessionAccess', 'alphaRepositoryListAccess', "capabilityAccess('repository.read')", 'auth'],
  'repository listing must validate the full provider base URL before capability and credential resolution'
);

assert.deepStrictEqual(Object.keys(capabilityDocument.providers), ['github']);
for (const provider of ['github']) {
  const features = capabilityDocument.providers[provider]['hosted-alpha'];
  for (const feature of ['repository.create', 'repository.delete', 'global-search', 'notifications']) {
    /*
     * Global search is the scoped query the live harness proves; creation,
     * deletion and the inbox are proven by its probes with the credentials the
     * repository-confined harness credential must never hold. Each claim is
     * exactly as strong as its proof.
     */
    const github = ['Supported', 'Provider-verified'];
    assert.deepStrictEqual(
      features[feature].slice(0, 2),
      github,
      `${provider} ${feature} must preserve its evidenced capability level without false provider parity`
    );
  }
}

/* A route added without the boundary, or a semantic boundary removed, fails the inventory. */
const changed = (method, routePath, guards) => policy.map(entry => (
  entry.kind === 'route' && entry.method === method && entry.path === routePath ? { ...entry, guards } : entry
));
assert.throws(
  () => validateAlphaRouteInventory([...policy, {
    kind: 'route', method: 'GET', path: '/api/repo/:owner/:repo/unreviewed-alpha-route',
    guards: ['auth', "capabilityAccess('repository.read')"], handler: 'inline', at: 'server.js:1'
  }]),
  /unreviewed-alpha-route/,
  'a new repository route without the boundary must fail the exhaustive inventory'
);

assert.throws(
  () => validateSemanticRepositorySurfaces(changed('POST', '/api/security/step-up', ['providerSessionAccess', 'auth'])),
  /step-up/,
  'removing the body-carried repository boundary must fail the semantic inventory'
);

assert.throws(
  () => validateSemanticRepositorySurfaces(changed('POST', '/api/safety', ['providerSessionAccess', 'accountAuth'])),
  /safety/,
  'removing the aggregate safety mutation boundary must fail the semantic inventory'
);

console.log(`alpha access server contract tests passed (${repositoryRoutes.length} repository routes)`);
