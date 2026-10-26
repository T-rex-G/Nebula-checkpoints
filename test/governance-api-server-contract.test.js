'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
/* Kepler's governance routes, and every route with its guard chain as the route policy reads them. */
const governanceRoutes = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'kepler', 'http', 'governance-routes.ts'), 'utf8');
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(root).filter(entry => entry.kind === 'route');
const guardsOf = (method, routePath) => {
  const entry = policyRoutes.find(candidate => candidate.method === method && candidate.path === routePath);
  assert(entry, `missing governance route ${method} ${routePath}`);
  assert(entry.at.startsWith('apps/api/src/modules/kepler/http/governance-routes.ts:'), `${method} ${routePath} must be registered by Kepler`);
  return entry.guards;
};
const gateway = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'platform', 'mutation-gateway', 'mutation-gateway.ts'), 'utf8');
/* The gateway's action catalogue is the mutation contract's (packages/contracts/src/mutation.ts). */
const { MUTATION_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const registered = action => Object.hasOwn(MUTATION_ACTIONS, action);

/* The server reaches governance through the Kepler module's index only. */
const kepler = /const \{([^}]*)\} = require\('\.\/apps\/api\/src\/modules\/kepler\/index\.ts'\)/.exec(server);
assert(kepler, 'the server must load governance through the Kepler index');
assert(/\bcreateGovernanceApiService\b/.test(kepler[1]), 'server must load the governance API boundary');
assert(/\bGovernanceStore\b/.test(kepler[1]), 'server must load the durable governance store');
assert(/\bregisterGovernanceRoutes\b/.test(kepler[1]) && /\bregisterGovernanceLifecycleRoutes\b/.test(kepler[1]), 'server must register the governance routes through Kepler');
assert(server.includes('governance: req => req.governance'), 'the routes must read the governance context the server guard attached');
assert(server.includes('function governanceAccess('), 'server must expose one governance authorization middleware');
assert(server.includes('function governanceMutationContext('), 'governance writes must use one mutation gateway middleware');
assert(server.includes('req.governance.authorization'), 'governance boundary must retain only server-derived authorization evidence');
assert(governanceRoutes.includes('authorization: governance(req).authorization') && !/authorization: req\.body/.test(governanceRoutes), 'governance routes must pass only the server-derived authorization evidence');
for (const source of [server, governanceRoutes]) {
  assert(!source.includes('req.body.governanceRoles'), 'browser governance roles must never be trusted');
  assert(!source.includes('req.body.actorIdentityKey'), 'browser actor identities must never be trusted');
}
assert(governanceRoutes.includes("req.get('Idempotency-Key')"), 'governance writes must accept a bounded idempotency key without putting it in descriptors');
assert(server.includes("res.setHeader('Cache-Control', 'no-store')"), 'governance responses must disable browser and intermediary caching');
assert(server.includes('function isCurrentGovernanceControlPlaneRequest('), 'read-only exemption must enumerate the current governance control-plane routes');
assert(server.includes('if (isCurrentGovernanceControlPlaneRequest(req)) return null;'), 'guardSafety must use the bounded governance-route classifier');
assert(!server.includes("if (/^\\/api\\/repo\\/[^/]+\\/[^/]+\\/governance(?:\\/|$)/.test(req.path)) return null;"), 'future governance routes must not inherit an automatic read-only exemption');

const routes = [
  ['GET', '/api/repo/:owner/:repo/governance/policies'],
  ['POST', '/api/repo/:owner/:repo/governance/policies', 'governance.policy.create'],
  ['GET', '/api/repo/:owner/:repo/governance/policies/:policyId'],
  ['POST', '/api/repo/:owner/:repo/governance/policies/:policyId/validate'],
  ['POST', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts', 'governance.draft.create'],
  ['GET', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId'],
  ['PATCH', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId', 'governance.draft.update'],
  ['POST', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/validate'],
  ['POST', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/submit', 'governance.draft.submit'],
  ['GET', '/api/repo/:owner/:repo/governance/policies/:policyId/versions'],
  ['GET', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId'],
  ['GET', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/review'],
  ['POST', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/reviewers/me', 'governance.reviewer.assign'],
  ['POST', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/decisions', 'governance.approval.decide']
];
for (const [method, routePath, action] of routes) {
  const guards = guardsOf(method, routePath);
  assert(guards.some(guard => guard.startsWith('governanceAccess(')), `${method} ${routePath} must stand behind the governance guard`);
  if (!action) {
    assert(!guards.some(guard => guard.startsWith('governanceMutationContext(')), `${method} ${routePath} must not enter the mutation gateway`);
    continue;
  }
  assert(registered(action), `mutation gateway must register ${action}`);
  assert(guards.includes(`governanceMutationContext('${action}')`), `${method} ${routePath} must enter the gateway for ${action}`);
}
assert(!governanceRoutes.includes('reviewerIdentityKey: req.body') && !server.includes('reviewerIdentityKey: req.body'), 'reviewer identity must never come from the browser body');
assert(!policyRoutes.some(entry => entry.guards.some(guard => guard.startsWith("governanceMutationContext('governance.activation"))), 'Task 11 activation workflow must remain out of scope');
console.log('governance API server contract tests passed');
