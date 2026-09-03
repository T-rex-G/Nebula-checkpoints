'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const env = read('.env.example');
const render = read('render.yaml');
const readme = read('README.md');
const deploy = read('docs/operations/DEPLOY_RENDER_NEON.md');
const security = read('docs/operations/SECURITY_DEPLOYMENT.md');
const server = read('server.js');
assert(env.includes('NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn'), '.env.example must declare the backward-compatible runtime failure mode');
assert(render.includes('NV_GOVERNANCE_RUNTIME_FAILURE_MODE'), 'Render configuration must expose the runtime failure mode');
assert(/NV_GOVERNANCE_RUNTIME_FAILURE_MODE[\s\S]{0,100}value:\s*warn/.test(render), 'Render default must be explicit warn');
for (const text of [readme, deploy, security]) {
  assert(text.includes('NV_GOVERNANCE_RUNTIME_FAILURE_MODE'), 'deployment documentation must explain the runtime failure mode');
  assert(text.includes('observe'), 'deployment documentation must explain observe rollout');
  assert(text.includes('block'), 'deployment documentation must explain block rollout');
}
assert(server.includes("runtime policy evaluation unavailable"), 'runtime failures must be logged with a bounded signal');
assert(server.includes("failureMode: GOVERNANCE_RUNTIME_FAILURE_MODE"), 'runtime logs must identify the configured failure mode');
console.log('governance enforcement deployment contract tests passed');
