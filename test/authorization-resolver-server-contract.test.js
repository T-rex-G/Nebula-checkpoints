'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { serverFiles, serverSource, serverLoads } = require('./helpers/server-source');
const { locations } = require('./oracles/route-policy');
const root = path.join(__dirname, '..');
const server = serverSource();
const gateway = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'platform', 'mutation-gateway', 'mutation-gateway.ts'), 'utf8');

assert(serverLoads('apps/api/src/platform/authorization/authorization-resolver.ts'), 'server must load the authorization resolver');
assert(server.includes('createAuthorizationResolver({'), 'server must create one authorization resolver');
/* The mutation contexts are the platform's (mutation-context.ts) and Kepler's (governance-context.ts), composed by the server. */
const mutationContextSource = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'platform', 'mutation-gateway', 'mutation-context.ts'), 'utf8');
const governanceContextSource = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'kepler', 'http', 'governance-context.ts'), 'utf8');
assert(mutationContextSource.includes('async function resolveMutationAuthorization(') && server.includes('createRepositoryMutationContext({'), 'server must expose one mutation authorization boundary');
assert(mutationContextSource.includes('req.authorization = await resolveMutationAuthorization(req, action)'), 'mutation context must resolve trusted authorization evidence');
assert(mutationContextSource.includes('authorization: req.authorization'), 'mutation descriptor must carry the credential-free authorization snapshot');
assert(/request:\s*async\s*\(\{\s*account,\s*apiPath\s*\}\)\s*=>\s*github\.gh\(account, apiPath\)/.test(server), 'resolver requests must use server-side GitHub credentials');
for (const source of [server, mutationContextSource, governanceContextSource]) {
  assert(!source.includes('req.body.governanceRoles'), 'browser-supplied governance roles must never be trusted');
  assert(!source.includes('req.body.repositoryAccess'), 'browser-supplied repository access must never be trusted');
}

assert(gateway.includes("from '../authorization/authorization-resolver.ts'"), 'mutation gateway must validate authorization snapshots');
/* The descriptor's guard is the mutation contract's; the gateway hands it the resolver's snapshot guard. */
const descriptorContract = fs.readFileSync(path.join(root, 'packages', 'contracts', 'src', 'mutation.ts'), 'utf8');
assert(gateway.includes('normalizeAuthorization: normalizeAuthorizationSnapshot'), 'gateway descriptor must normalize authorization evidence');
assert.throws(() => require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts').normalizeMutationDescriptor({
  action: 'file.write', provider: 'github', owner: 'acme', repo: 'demo', actorIdentityKey: 'a'.repeat(64), actorLogin: 'alice',
  method: 'PUT', route: '/api/repo/acme/demo/file', authorization: {}
}), error => error.name === 'AuthorizationResolverError' && error.code === 'AUTHORIZATION_SCHEMA_UNSUPPORTED', 'gateway descriptor must normalize authorization evidence');
assert(descriptorContract.includes('security: normalizeMutationSecurity(input.security, definition, refuse),\n    authorization'), 'gateway descriptor must retain normalized authorization evidence');

/*
 * Reading a public repository makes nobody its collaborator. The reader
 * access everyone has on one is accepted only by routes whose data is the
 * reader's own -- their audits and scans, keyed by identity -- and refused by
 * everything the repository's collaborators share.
 */
assert(/if \(isPublicReaderAccess\(context\.authorization\) && options\.publicRepositories !== true\)/.test(governanceContextSource), 'governance access must refuse public readers unless the route opts in');
assert(governanceContextSource.includes("code: 'GOVERNANCE_COLLABORATORS_ONLY'"), 'the refusal must say why');
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
 * OWN_WORK is used nowhere else. In the server's composition root: the routes
 * still registered there, and in each file that hands it to a module, its
 * import from Kepler and that one hand-over. In each such module's routes:
 * the field that receives it, the binding that names it, and its routes.
 */
const ownWorkIn = file => policyRoutes.filter(entry => entry.at.startsWith(`${file}:`) && entry.guards.includes("governanceAccess('reader', OWN_WORK)")).length;
const ownWorkFiles = [...new Set(policyRoutes.filter(entry => entry.guards.includes("governanceAccess('reader', OWN_WORK)")).map(entry => entry.at.split(':')[0]))];
const rootFiles = serverFiles();
const moduleFiles = ownWorkFiles.filter(file => !rootFiles.includes(file));
assert.deepStrictEqual(moduleFiles.sort(), ['apps/api/src/modules/quasar/http/exposure-routes.ts', 'apps/api/src/modules/uranus/http/code-audit-routes.ts']);
for (const file of moduleFiles) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  assert.strictEqual((text.match(/OWN_WORK/g) || []).length, ownWorkIn(file) + 2, `OWN_WORK is used nowhere else in ${file}`);
}
const handOversIn = text => (text.match(/register[A-Za-z]+Routes\(app, \{[^}]*\bOWN_WORK\b/g) || []).length;
const handOvers = handOversIn(server);
assert.strictEqual(handOvers, moduleFiles.length, 'one hand-over to each module whose routes take it');
const importers = rootFiles.filter(file => /import \{[^}]*\bOWN_WORK\b[^}]*\} from '\.\.\/modules\/kepler\/index\.ts';/.test(fs.readFileSync(path.join(root, file), 'utf8')));
for (const file of importers) {
  assert.strictEqual(handOversIn(fs.readFileSync(path.join(root, file), 'utf8')), 1, `${file} imports OWN_WORK to hand it over once`);
}
assert.strictEqual((server.match(/OWN_WORK/g) || []).length, rootFiles.reduce((sum, file) => sum + ownWorkIn(file), 0) + importers.length + handOvers,
  'OWN_WORK is used nowhere else in the composition root');
assert.strictEqual(ownWorkFiles.reduce((sum, file) => sum + ownWorkIn(file), 0), ownWork.length, 'and no other file registers a route with it');
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
