'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
/* Every route with its guard chain, as the route policy reads them from the composition root and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(path.join(__dirname, '..')).filter(entry => entry.kind === 'route');
const guardsOf = (method, routePath) => {
  const entry = policyRoutes.find(candidate => candidate.method === method && candidate.path === `/api/repo/:owner/:repo${routePath}`);
  assert(entry, `server must expose ${method} ${routePath}`);
  return entry.guards;
};
/* The gateway's action catalogue is the mutation contract's (packages/contracts/src/mutation.ts). */
const { MUTATION_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const registered = action => Object.hasOwn(MUTATION_ACTIONS, action);
guardsOf('GET', '/governance/policies/:policyId/versions/:versionId/exceptions');
guardsOf('GET', '/governance/exceptions/:exceptionId');
for (const [routePath, action, role] of [
  ['/governance/policies/:policyId/versions/:versionId/exceptions', 'governance.exception.request'],
  ['/governance/exceptions/:exceptionId/decision', 'governance.exception.decide', 'administrator'],
  ['/governance/exceptions/:exceptionId/revoke', 'governance.exception.revoke', 'administrator']
]) {
  const guards = guardsOf('POST', routePath);
  assert(registered(action), `gateway must register ${action}`);
  assert(guards.includes(`governanceMutationContext('${action}')`), `server must route ${action} through gateway`);
  if (role) assert(guards.includes(`governanceAccess('${role}')`), 'decisions and revocation must require administrator');
}

assert.match(fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'kepler', 'domain', 'governance-mutation-metadata.ts'), 'utf8'), /case 'governance\.exception\.request':[\s\S]*ruleIds:[\s\S]*target:[\s\S]*ruleCount:/, 'exception request gateway metadata must bind the targeted rule set');

console.log('governance exception server contract tests passed');
