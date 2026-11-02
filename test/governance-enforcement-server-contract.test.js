'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { serverSource } = require('./helpers/server-source');
const server = serverSource();
const governanceRoutes = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'kepler', 'http', 'governance-routes.ts'), 'utf8');
/* Every route as the route policy reads them from the composition root and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(path.join(__dirname, '..')).filter(entry => entry.kind === 'route');
const exposes = routePath => policyRoutes.some(entry => entry.method === 'GET' && entry.path === routePath);
const gateway = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'platform', 'mutation-gateway', 'mutation-gateway.ts'), 'utf8');
/* The runtime is built by Kepler's governance host, which the server composes and hands the gateway's policy port. */
const host = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'kepler', 'application', 'governance-host.ts'), 'utf8');
assert(host.includes('const runtime = createGovernanceRuntime({') && server.includes('createGovernanceHost({') && server.includes('policyEvaluator: governance.runtime'), 'server must create the runtime policy evaluator');
assert(server.includes('policyEvaluator:'), 'mutation gateway must receive the policy evaluator');
assert(fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'platform', 'mutation-gateway', 'mutation-context.ts'), 'utf8').includes("X-Nebulaverse-Policy-Outcome"), 'warning/observe outcome must be surfaced in bounded response headers');
const settings = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'platform', 'config', 'server-settings.ts'), 'utf8');
assert(settings.includes('normalizeGovernanceRuntimeFailureMode(env.NV_GOVERNANCE_RUNTIME_FAILURE_MODE)')
  && server.includes('runtimeFailureMode: env.governanceRuntimeFailureMode') && host.includes('    failureMode: deps.runtimeFailureMode,'), 'runtime failure mode must be explicit and validated');
for (const injected of ['policyDecision', 'controlMapping', 'enforcementMode']) {
  assert.throws(() => require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts').normalizeMutationDescriptor({ action: 'file.write', [injected]: {} }),
    error => error.name === 'MutationGatewayError' && error.code === 'MUTATION_POLICY_INPUT_FORBIDDEN', 'client/server descriptors must not inject policy decisions');
}
assert(gateway.includes('policy.evaluated'), 'gateway must emit policy evaluation evidence');
assert(exposes('/api/repo/:owner/:repo/governance/decisions/verify'), 'server must expose decision-chain verification');
assert(exposes('/api/repo/:owner/:repo/governance/decisions'), 'server must expose bounded policy decision history');
assert(/GOVERNANCE\|MUTATION\|AUTHORIZATION\|SIMULATION\|POLICY/.test(governanceRoutes), 'governance API errors must preserve bounded policy decision codes');
console.log('governance enforcement server contract tests passed');
