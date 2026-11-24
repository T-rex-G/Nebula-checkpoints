'use strict';
/*
 * Runs every test that starts the server against one runtime (ADR-088):
 *
 *   node scripts/test-server-runtime.js native
 *   node scripts/test-server-runtime.js compiled   (after npm run build:server)
 *
 * The set is found, not listed: every test that starts the server through
 * test/helpers/server-entry.js, directly or through the negative-request
 * matrix, and every test that builds the composed application in its own
 * process through test/helpers/composed-application.js. A new server test
 * joins it by starting or building the server the way every other one does.
 * The compiled run adds the checks of the compiled tree itself
 * (test/compiled/server-tree.js).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'test');

function serverTests() {
  return fs.readdirSync(TESTS)
    .filter(name => name.endsWith('.test.js'))
    .filter(name => {
      const source = fs.readFileSync(path.join(TESTS, name), 'utf8');
      return /\bserverEntry\(/.test(source) || /\bcomposedApplication\(/.test(source) || source.includes("require('./oracles/negative-matrix')");
    })
    .filter(name => name !== 'server-runtime.test.js')
    .sort()
    .map(name => path.join('test', name));
}

function main() {
  const runtime = process.argv[2];
  if (!['native', 'compiled'].includes(runtime)) {
    console.error('usage: node scripts/test-server-runtime.js native|compiled');
    process.exit(2);
  }
  const tests = [...serverTests(), ...(runtime === 'compiled' ? [path.join('test', 'compiled', 'server-tree.js')] : [])];
  const env = { ...process.env, NV_SERVER_RUNTIME: runtime };
  const failed = [];
  for (const test of tests) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [test], { cwd: ROOT, env, stdio: 'inherit' });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status !== 0) failed.push(test);
    console.log(`${result.status === 0 ? 'ok  ' : 'FAIL'} ${test} (${seconds}s, ${runtime})`);
  }
  if (failed.length) {
    console.error(`${failed.length} of ${tests.length} server tests failed against the ${runtime} runtime:\n${failed.join('\n')}`);
    process.exit(1);
  }
  console.log(`${tests.length} server tests passed against the ${runtime} runtime`);
}

if (require.main === module) main();

module.exports = Object.freeze({ serverTests });
