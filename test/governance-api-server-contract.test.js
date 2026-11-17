'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
/* Every route with its guard chain, as the route policy reads them. */
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(root).filter(entry => entry.kind === 'route');
const guardsOf = (method, routePath) => {
  const entry = policyRoutes.find(candidate => candidate.method === method && candidate.path === routePath);
  assert(entry, `missing governance route ${method} ${routePath}`);
  assert(entry.at.startsWith('apps/api/src/modules/kepler/http/governance-routes.ts:'), `${method} ${routePath} must be registered by Kepler`);
  return entry.guards;
};
/* The gateway's action catalogue is the mutation contract's (packages/contracts/src/mutation.ts). */
const { MUTATION_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const registered = action => Object.hasOwn(MUTATION_ACTIONS, action);

/*
 * What stands behind these routes is asked of the code that does it:
 *   - Kepler's governance host builds one API service over the durable
 *     store, under the audit secret (test/governance-host.test.js);
 *   - the governance guard resolves the reader's authorization, holds it to
 *     the route's role, keeps only the server's evidence on the request and
 *     never lets an answer be cached; its mutation context describes a change
 *     from that evidence (test/governance-context.test.js);
 *   - the routes hand the service that evidence and the request's
 *     Idempotency-Key, and pass on nothing a body claims about who is acting
 *     (test/kepler-governance-routes.test.js), and no module takes roles, an
 *     actor's or a reviewer's identity, or an authorization from a body
 *     (test/module-rules.test.js);
 *   - read-only mode lets governance's own control plane through and nothing
 *     else of it (test/corona-safety-guard.test.js).
 * That the server builds all of it over the database, behind one guard, takes
 * no roles or identity from a request's body, refuses a review claimed in
 * another's name and lets the control plane through read-only mode is asked
 * of the composed server by test/composition-governance.test.js.
 */

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
assert(!policyRoutes.some(entry => entry.guards.some(guard => guard.startsWith("governanceMutationContext('governance.activation"))), 'Task 11 activation workflow must remain out of scope');
console.log('governance API server contract tests passed');
