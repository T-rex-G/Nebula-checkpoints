'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const checks = [
  'scripts/verify.js',
  'test/public-alpha-provenance.test.js',
  'test/capability-registry.test.js',
  'test/capability-registry-server-contract.test.js',
  'test/provider-route-inventory.test.js',
  'test/public-alpha-documentation.test.js'
];

function runFoundationGate() {
  for (const check of checks) {
    const result = spawnSync(process.execPath, [check], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Foundation gate failed: ${check}`);
  }
}

if (require.main === module) {
  try {
    runFoundationGate();
    console.log('Foundation gate passed.');
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { checks, runFoundationGate };
