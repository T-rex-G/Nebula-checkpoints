'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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
 * Run first, and not a check: one of the checks starts the server, which serves
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

/* One check in its own process, with what it wrote held, in the order it wrote it, until its turn. */
function runCheck(check) {
  return new Promise(resolve => {
    const output = [];
    const child = spawn(process.execPath, [check], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => output.push([process.stdout, chunk]));
    child.stderr.on('data', chunk => output.push([process.stderr, chunk]));
    child.once('error', error => resolve({ check, error, output }));
    child.once('close', status => resolve({ check, status, output }));
  });
}

/*
 * The checks share no port, file or state, so they run at once. They are
 * reported in their order all the same: each check's output in turn, up to
 * and including the first that fails, which is the failure the gate gives --
 * what running them one after another showed.
 */
async function runFoundationGate() {
  for (const step of built() ? [] : prerequisites) {
    const result = spawnSync(process.execPath, [step], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Foundation gate prerequisite failed: ${step}`);
  }
  const results = await Promise.all(checks.map(runCheck));
  for (const result of results) {
    for (const [stream, chunk] of result.output) stream.write(chunk);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Foundation gate failed: ${result.check}`);
  }
}

if (require.main === module) {
  runFoundationGate().then(() => {
    console.log('Foundation gate passed.');
  }, error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { checks, prerequisites, runFoundationGate };
