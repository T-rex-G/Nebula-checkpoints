'use strict';
const assert = require('assert');
const path = require('path');
/* Every route as the route policy reads them from the composition root and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(path.join(__dirname, '..')).filter(entry => entry.kind === 'route');
const exposes = routePath => policyRoutes.some(entry => entry.method === 'GET' && entry.path === routePath);
/*
 * The runtime that decides each mutation's policy, and what it says, are
 * asked of the code that does it:
 *   - Kepler's governance host builds the runtime under the deployment's
 *     failure mode, and logs a policy it cannot evaluate with that mode
 *     (test/governance-host.test.js);
 *   - the server reads the mode from NV_GOVERNANCE_RUNTIME_FAILURE_MODE, and
 *     the composed gateway puts every mutation to the runtime, emitting
 *     policy.evaluated, and policy.blocked when it refuses
 *     (test/composition.test.js);
 *   - a warning or an observation is surfaced in the answer's bounded
 *     X-Nebulaverse-Policy-* headers (test/mutation-context.test.js);
 *   - and a governance refusal keeps its decision code, whichever family it
 *     comes from (test/kepler-governance-routes.test.js).
 */
for (const injected of ['policyDecision', 'controlMapping', 'enforcementMode']) {
  assert.throws(() => require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts').normalizeMutationDescriptor({ action: 'file.write', [injected]: {} }),
    error => error.name === 'MutationGatewayError' && error.code === 'MUTATION_POLICY_INPUT_FORBIDDEN', 'client/server descriptors must not inject policy decisions');
}
assert(exposes('/api/repo/:owner/:repo/governance/decisions/verify'), 'server must expose decision-chain verification');
assert(exposes('/api/repo/:owner/:repo/governance/decisions'), 'server must expose bounded policy decision history');
console.log('governance enforcement server contract tests passed');
