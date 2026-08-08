'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, '..', 'src', 'mutation-gateway.js'), 'utf8');
for (const route of [
  '/governance/policies/:policyId/versions/:versionId/exceptions',
  '/governance/exceptions/:exceptionId',
  '/governance/exceptions/:exceptionId/decision',
  '/governance/exceptions/:exceptionId/revoke'
]) assert(server.includes(route), `server must expose ${route}`);
for (const action of ['governance.exception.request', 'governance.exception.decide', 'governance.exception.revoke']) {
  assert(gateway.includes(`'${action}'`), `gateway must register ${action}`);
  assert(server.includes(`governanceMutationContext('${action}')`), `server must route ${action} through gateway`);
}
assert(server.includes("governanceAccess('administrator')"), 'decisions and revocation must require administrator');

assert.match(server, /case 'governance\.exception\.request':[\s\S]*ruleIds:[\s\S]*target:[\s\S]*ruleCount:/, 'exception request gateway metadata must bind the targeted rule set');

console.log('governance exception server contract tests passed');
