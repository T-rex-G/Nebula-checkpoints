'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
/* Every route with its guard chain, as the route policy reads them from server.js and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(root).filter(entry => entry.kind === 'route');
/* The gateway's action catalogue is the mutation contract's (packages/contracts/src/mutation.ts). */
const { MUTATION_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const registered = action => Object.hasOwn(MUTATION_ACTIONS, action);
const guardsOf = (method, routePath, label) => {
  const entry = policyRoutes.find(candidate => candidate.method === method && candidate.path === `/api/repo/:owner/:repo/governance${routePath}`);
  assert(entry, `${label} route must exist`);
  return entry.guards;
};
const activate = guardsOf('POST', '/policies/:policyId/versions/:versionId/activate', 'activation');
const rollback = guardsOf('POST', '/policies/:policyId/versions/:versionId/rollback', 'rollback');
guardsOf('GET', '/policies/:policyId/activations', 'activation history');
assert(activate.includes("governanceAccess('activator')") && rollback.includes("governanceAccess('activator')"), 'activation writes require activator role');
assert(activate.includes("governanceMutationContext('governance.policy.activate')"), 'activation must enter mutation gateway');
assert(rollback.includes("governanceMutationContext('governance.policy.rollback')"), 'rollback must enter mutation gateway');
assert(registered('governance.policy.activate'), 'gateway must register activation');
assert(registered('governance.policy.rollback'), 'gateway must register rollback');
console.log('governance activation server contract tests passed');
