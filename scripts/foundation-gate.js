'use strict';

const fs = require('fs');
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

/*
 * Run first, and not a check: two of the checks start the server, which serves
 * the page build and refuses to start without one. A release is cut from a
 * clean checkout, so the gate builds when there is no build. It does not
 * rebuild one that exists: the archive carries sources, never the build, and
 * the candidate qualifier builds the page again from the archive's own
 * sources before it tests anything.
 */
const prerequisites = [
  'scripts/build-web.js'
];
const built = () => ['index.html', 'sw.js'].every(file => fs.existsSync(path.join(root, 'dist', 'web', file)));

function runFoundationGate() {
  for (const step of built() ? [] : prerequisites) {
    const result = spawnSync(process.execPath, [step], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Foundation gate prerequisite failed: ${step}`);
  }
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

module.exports = { checks, prerequisites, runFoundationGate };
