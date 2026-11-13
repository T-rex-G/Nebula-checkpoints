'use strict';

const assert = require('assert');
const path = require('path');
const { locations } = require('./oracles/route-policy');
const root = path.join(__dirname, '..');

/*
 * A mutation resolves one authorization, from the server's own evidence, and
 * carries it into the gateway's descriptor without the credential
 * (test/mutation-context.test.js); the gateway normalizes it and keeps it
 * (test/mutation-gateway.test.js), and refuses evidence it cannot read, below.
 * The composed resolver, and the credential it asks GitHub with, are
 * test/composition.test.js's. No module takes governance roles or repository
 * access from a request's body (test/module-rules.test.js); that the composed
 * server refuses such a claim as the person GitHub says they are is
 * test/composition-postgres.test.js's and test/composition-governance.test.js's.
 */
assert.throws(() => require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts').normalizeMutationDescriptor({
  action: 'file.write', provider: 'github', owner: 'acme', repo: 'demo', actorIdentityKey: 'a'.repeat(64), actorLogin: 'alice',
  method: 'PUT', route: '/api/repo/acme/demo/file', authorization: {}
}), error => error.name === 'AuthorizationResolverError' && error.code === 'AUTHORIZATION_SCHEMA_UNSUPPORTED', 'gateway descriptor must normalize authorization evidence');

/*
 * Reading a public repository makes nobody its collaborator. The reader
 * access everyone has on one is accepted only by routes whose data is the
 * reader's own -- their audits and scans, keyed by identity -- and refused by
 * everything the repository's collaborators share: governance's guard refuses
 * a public reader unless the route opts in, and says why
 * (test/governance-context.test.js).
 */
/* Read from the route policy, so a route counts wherever it is registered: the composition root or a module's routes. */
const policyRoutes = locations(root).filter(entry => entry.kind === 'route');
const ownWork = policyRoutes.filter(entry => entry.guards.includes("governanceAccess('reader', OWN_WORK)")).map(entry => `${entry.method} ${entry.path}`).sort();
assert.deepStrictEqual(ownWork, [
  'GET /api/repo/:owner/:repo/code-audit/history',
  'GET /api/repo/:owner/:repo/code-audit/history/:auditId',
  'GET /api/repo/:owner/:repo/code-audit/metrics',
  'GET /api/repo/:owner/:repo/code-audit/watch',
  'GET /api/repo/:owner/:repo/exposure/findings',
  'GET /api/repo/:owner/:repo/exposure/findings/:fingerprint/readability-probes',
  'GET /api/repo/:owner/:repo/exposure/findings/:fingerprint/verifications',
  'GET /api/repo/:owner/:repo/exposure/scans',
  'GET /api/repo/:owner/:repo/exposure/scans/:scanId',
  'GET /api/repo/:owner/:repo/exposure/scans/:scanId/observations',
  'POST /api/repo/:owner/:repo/code-audit/history/clear',
  'POST /api/repo/:owner/:repo/exposure/clear',
  'POST /api/repo/:owner/:repo/exposure/scans',
  'POST /api/repo/:owner/:repo/exposure/scans/:scanId/cancel'
], 'exactly the identity-scoped routes accept a public reader');
/*
 * OWN_WORK is used nowhere else. Its routes are the two modules', and no
 * route registered anywhere else takes it; within the modules it is a route's
 * allowance and nothing else (test/module-rules.test.js). That the composition
 * hands Kepler's allowance to each of them -- so a public reader is let into
 * their own scans and audits of a public repository, and refused its
 * governance -- is asked of the composed server by
 * test/composition-postgres.test.js.
 */
const moduleFiles = [...new Set(policyRoutes.filter(entry => entry.guards.includes("governanceAccess('reader', OWN_WORK)")).map(entry => entry.at.split(':')[0]))];
assert.deepStrictEqual(moduleFiles.sort(), ['apps/api/src/modules/quasar/http/exposure-routes.ts', 'apps/api/src/modules/uranus/http/code-audit-routes.ts']);
for (const entry of policyRoutes.filter(item => item.path.startsWith('/api/repo/:owner/:repo/governance'))) {
  assert(!entry.guards.some(guard => guard.includes('OWN_WORK')), `governance is collaborators' business: ${entry.method} ${entry.path}`);
}
/*
 * A team decision about an audit finding is the collaborators' business:
 * reading the decisions takes the reader role on the repository itself, and
 * making or taking one back takes the reviewer role, never a public reader.
 */
for (const [method, route, role] of [
  ['get', '/api/repo/:owner/:repo/code-audit/triage', 'reader'],
  ['get', '/api/repo/:owner/:repo/code-audit/findings/:findingId/triage-events', 'reader'],
  ['get', '/api/repo/:owner/:repo/code-audit/gate', 'reader'],
  ['post', '/api/repo/:owner/:repo/code-audit/findings/:findingId/triage', 'reviewer'],
  ['post', '/api/repo/:owner/:repo/code-audit/findings/:findingId/reopen', 'reviewer']
]) {
  const entry = policyRoutes.find(item => item.method === method.toUpperCase() && item.path === route);
  assert(entry && entry.guards.includes(`governanceAccess('${role}')`) && !entry.guards.some(guard => guard.includes('OWN_WORK')), `${route} takes the ${role} role of a collaborator`);
}
for (const action of ['verify', 'probe-readability', 'accept-risk']) {
  const route = policyRoutes.find(entry => entry.method === 'POST' && entry.path === `/api/repo/:owner/:repo/exposure/findings/:fingerprint/${action}`);
  assert(route && route.guards.includes("governanceAccess('administrator')") && !route.guards.some(guard => guard.includes('OWN_WORK')), `${action} stays with administrators`);
}

console.log('authorization resolver server contract tests passed');
