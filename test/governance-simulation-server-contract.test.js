'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const kepler = path.join(root, 'apps', 'api', 'src', 'modules', 'kepler');
assert(fs.existsSync(path.join(kepler, 'domain', 'governance-simulation.ts')), 'simulation module must exist');
/* That the governance service simulates a version's impact with Kepler's simulation is test/governance-simulation-api.test.js's. */
/* The simulation route with its guard chain, as the route policy reads it from Kepler's registration. */
const { locations } = require('./oracles/route-policy');
const simulation = locations(root).find(entry => entry.kind === 'route' && entry.method === 'POST' && entry.path === '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/simulate');
assert(simulation, 'simulation route must exist');
/* That a simulation's or a policy's refusal keeps its code, as every governance family's does, is test/kepler-governance-routes.test.js's. */
assert(simulation.guards.includes("governanceAccess('reader')"), 'simulation requires reader authorization');
assert(!simulation.guards.some(guard => guard.startsWith('governanceMutationContext(')), 'simulation must not enter the mutation gateway');
/* That read-only mode lets exactly the simulation route through is test/corona-safety-guard.test.js's. */
assert(pkg.scripts['test:unit'].includes('governance-simulation.test.js'), 'unit manifest must run simulation tests');
assert(pkg.scripts['test:unit'].includes('governance-simulation-api.test.js'), 'unit manifest must run simulation API tests');
assert(pkg.scripts['test:unit'].includes('governance-simulation-server-contract.test.js'), 'unit manifest must run simulation route contract');
console.log('governance simulation server contract tests passed');
