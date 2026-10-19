'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
/* The gateway's action catalogue is the mutation contract's (packages/contracts/src/mutation.ts). */
const { MUTATION_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const registered = action => Object.hasOwn(MUTATION_ACTIONS, action);
assert(server.includes("versions/:versionId/activate'"), 'activation route must exist');
assert(server.includes("versions/:versionId/rollback'"), 'rollback route must exist');
assert(server.includes("policies/:policyId/activations'"), 'activation history route must exist');
assert(server.includes("governanceAccess('activator')"), 'activation writes require activator role');
assert(server.includes("governanceMutationContext('governance.policy.activate')"), 'activation must enter mutation gateway');
assert(server.includes("governanceMutationContext('governance.policy.rollback')"), 'rollback must enter mutation gateway');
assert(registered('governance.policy.activate'), 'gateway must register activation');
assert(registered('governance.policy.rollback'), 'gateway must register rollback');
console.log('governance activation server contract tests passed');
