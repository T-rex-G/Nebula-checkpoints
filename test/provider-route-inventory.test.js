'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { locations } = require('./oracles/route-policy');

const root = path.resolve(__dirname, '..');
/*
 * The routes as the route policy reads them: server.js, and every module
 * registration function it calls, in place (test/oracles/route-policy.js).
 * Each carries its guard chain as written, so the inventory follows a route
 * into whichever module now registers it.
 */
const registered = locations(root).filter(entry => entry.kind === 'route');
/* The source the routes are written in, for what is named inside a handler rather than in its guard chain. */
const routeSources = [...new Set([path.join(root, 'server.js'), ...registered.map(entry => path.join(root, entry.at.replace(/:\d+$/, '')))])]
  .map(file => [path.relative(root, file), fs.readFileSync(file, 'utf8')]);
const capabilityDocument = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'public-alpha-capabilities.json'), 'utf8')
);

const reviewedExemptions = Object.freeze({
  'GET /api/accounts': 'Local session account inventory; no repository provider transport.',
  'POST /api/accounts/switch-idx': 'Local active-session account selection.',
  'POST /api/accounts/remove': 'Local session account removal.',
  'POST /api/accounts/switch': 'Account credential validation precedes repository capability context.',
  'POST /api/github-app/connect': 'GitHub App account authorization bootstrap, not repository feature transport.',
  'GET /api/github-app/status': 'Local GitHub App configuration and session status.',
  'POST /api/github-app/refresh': 'GitHub App account credential refresh, not repository feature transport.',
  'POST /api/github-app/disconnect': 'Local GitHub App session-account removal.',
  'GET /api/security/csrf': 'Local authenticated security-context projection.',
  'POST /api/security/step-up': 'Local authenticated step-up grant creation.',
  'POST /api/logout': 'Local authenticated session termination.',
  'POST /api/alpha/providers/disconnect-all': 'Owned alpha credential-lifecycle cleanup, independent of repository feature capability.',
  'POST /api/alpha/delete': 'Owned alpha deletion lifecycle after verified provider cleanup.',
  'GET /api/me': 'Provider identity bootstrap required before repository capability projection.',
  'GET /api/workspace/posture': 'Workspace posture: the session credential\'s own kind, scopes and expiry, and this identity\'s persisted recovery and exposure summaries.',
  'GET /api/safety': 'Local repository-scoped safety-state read.',
  'POST /api/safety': 'Local repository-scoped safety-state update.',
  'GET /api/security/sessions': 'Local authenticated session inventory.',
  'POST /api/security/revoke-others': 'Local authenticated session revocation.'
});

/* The authenticated API routes, each with the capabilities its guard chain names. */
function authenticatedRoutes(entries) {
  const routes = [];
  for (const entry of entries) {
    if (!entry.path.startsWith('/api/')) continue;
    const authType = entry.guards.find(guard => (
      guard === 'auth'
      || guard === 'accountAuth'
      || guard === 'alphaDeletionAuthentication'
    ));
    if (!authType) continue;
    /* Every capability a route names, including one it checks only when a request asks for it. */
    const features = entry.guards
      .map(guard => guard.match(/^capabilityAccess(?:When)?\s*\(\s*(['"])([a-z][a-z0-9.-]+)\1/))
      .filter(Boolean)
      .map(found => found[2]);
    routes.push({
      method: entry.method,
      path: entry.path,
      authType,
      feature: features[0] || null,
      features
    });
  }
  return routes;
}

function validateInventory(entries) {
  const routes = authenticatedRoutes(entries);
  const routeKeys = new Set(routes.map(route => `${route.method} ${route.path}`));
  assert.strictEqual(routeKeys.size, routes.length, 'authenticated route inventory contains duplicate method/path entries');

  const unclassified = routes
    .filter(route => !route.feature && !reviewedExemptions[`${route.method} ${route.path}`])
    .map(route => `${route.method} ${route.path}`)
    .sort();
  assert.deepStrictEqual(
    unclassified,
    [],
    `Authenticated routes need capabilityAccess or a reviewed exemption: ${unclassified.join(', ')}`
  );

  const staleExemptions = Object.keys(reviewedExemptions)
    .filter(key => !routeKeys.has(key))
    .sort();
  assert.deepStrictEqual(staleExemptions, [], `Reviewed route exemptions are stale: ${staleExemptions.join(', ')}`);

  for (const route of routes.filter(entry => entry.feature)) {
    for (const provider of ['github']) {
      const features = capabilityDocument.providers?.[provider]?.['hosted-alpha'] || {};
      assert(
        Object.prototype.hasOwnProperty.call(features, route.feature),
        `${route.method} ${route.path} maps ${provider} to implicit default capability ${route.feature}`
      );
    }
  }
  return routes;
}

const routes = validateInventory(registered);
for (const [key, feature] of Object.entries({
  'GET /api/rate': 'rate.read',
  'GET /api/repo/:owner/:repo/commits': 'repository.read',
  'GET /api/repo/:owner/:repo/commit/:sha': 'repository.read',
  'GET /api/repo/:owner/:repo/intelligence/events': 'governance',
  'GET /api/repo/:owner/:repo/evidence': 'governance'
})) {
  const route = routes.find(entry => `${entry.method} ${entry.path}` === key);
  assert(route, `missing authenticated provider route ${key}`);
  assert.strictEqual(route.feature, feature, `${key} must consult ${feature} before provider transport`);
}

/* Branch reads name branches.read, and an explicit Git LFS upload is checked at the route before its body is read. */
for (const [key, feature] of Object.entries({
  'GET /api/repo/:owner/:repo': 'branches.read',
  'GET /api/repo/:owner/:repo/files': 'branches.read',
  'GET /api/repo/:owner/:repo/branch-protection': 'branches.read',
  'GET /api/repo/:owner/:repo/refs-snapshot': 'branches.read',
  'POST /api/repo/:owner/:repo/emergency-manifest': 'branches.read',
  'POST /api/repo/:owner/:repo/governance/baselines/generate': 'branches.read',
  'POST /api/repo/:owner/:repo/upload': 'lfs'
})) {
  const route = routes.find(entry => `${entry.method} ${entry.path}` === key);
  assert(route, `missing authenticated provider route ${key}`);
  assert(route.features.includes(feature), `${key} must name ${feature}`);
}

/* Every capability the registry offers is named by at least one route, so none is offered without a gate. */
const allNamed = new Set(routes.flatMap(route => route.features));
for (const [, source] of routeSources) {
  for (const found of source.matchAll(/capabilityAccess(?:When)?\s*\(\s*(['"])([a-z][a-z0-9.-]+)\1/g)) allNamed.add(found[2]);
}
const unnamed = Object.keys(capabilityDocument.providers.github['hosted-alpha']).filter(feature => !allNamed.has(feature)).sort();
assert.deepStrictEqual(unnamed, [], `registry capabilities no route names: ${unnamed.join(', ')}`);

/* No route can accept what is not Supported: the experimental opt-in does not exist. */
for (const [name, source] of routeSources) {
  assert(!/allowExperimental/.test(source), `${name} must not carry an experimental opt-in`);
}

assert.throws(
  () => validateInventory([...registered, { kind: 'route', method: 'GET', path: '/api/repo/:owner/:repo/new-provider-read', guards: ['auth'] }]),
  /new-provider-read/,
  'a newly added authenticated provider route must fail until it is classified'
);

console.log('provider route inventory tests passed');
