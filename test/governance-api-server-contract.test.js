'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { serverSource, serverImports } = require('./helpers/server-source');
const root = path.join(__dirname, '..');
const server = serverSource();
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
const kepler = serverImports('modules/kepler/index.ts');
assert(kepler, 'the server must load governance through the Kepler index');
/* Governance's life in the process -- its store and API service -- is Kepler's governance host, composed by the server. */
const host = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'kepler', 'application', 'governance-host.ts'), 'utf8');
assert(/\bcreateGovernanceHost\b/.test(kepler) && host.includes('service = createGovernanceApiService({ store });'), 'server must load the governance API boundary');
assert(host.includes('store = new GovernanceStore(deps.pool(), { secret: deps.auditSecret });'), 'server must load the durable governance store');
assert(/\bregisterGovernanceRoutes\b/.test(kepler) && /\bregisterGovernanceLifecycleRoutes\b/.test(kepler), 'server must register the governance routes through Kepler');
assert(server.includes('governance: req => req.governance'), 'the routes must read the governance context the server guard attached');
/* The governance guard and its mutation context are Kepler's (http/governance-context.ts), composed by the server. */
const governanceContext = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'kepler', 'http', 'governance-context.ts'), 'utf8');
assert(governanceContext.includes('function governanceAccess(') && server.includes('const { governanceAccess, governanceMutationContext } = createGovernanceContext({'), 'server must expose one governance authorization middleware');
assert(governanceContext.includes('function governanceMutationContext('), 'governance writes must use one mutation gateway middleware');
assert(governanceContext.includes('req.governance.authorization'), 'governance boundary must retain only server-derived authorization evidence');
assert(governanceRoutes.includes('authorization: governance(req).authorization') && !/authorization: req\.body/.test(governanceRoutes), 'governance routes must pass only the server-derived authorization evidence');
for (const source of [server, governanceRoutes]) {
  assert(!source.includes('req.body.governanceRoles'), 'browser governance roles must never be trusted');
  assert(!source.includes('req.body.actorIdentityKey'), 'browser actor identities must never be trusted');
}
assert(governanceRoutes.includes("req.get('Idempotency-Key')"), 'governance writes must accept a bounded idempotency key without putting it in descriptors');
assert(governanceContext.includes("res.setHeader('Cache-Control', 'no-store')"), 'governance responses must disable browser and intermediary caching');
/* The safety guard is Corona's (domain/safety-guard.ts). */
const safetyGuard = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'corona', 'domain', 'safety-guard.ts'), 'utf8');
assert(safetyGuard.includes('export function isCurrentGovernanceControlPlaneRequest('), 'read-only exemption must enumerate the current governance control-plane routes');
assert(safetyGuard.includes('if (isCurrentGovernanceControlPlaneRequest(r)) return null;'), 'guardSafety must use the bounded governance-route classifier');
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
