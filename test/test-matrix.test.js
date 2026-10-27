'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  discoverTestPrograms,
  extractMissingModule,
  isModuleNotFoundFailure,
  normalizeSubjectHash,
  runTestMatrix
} = require('../src/test-matrix');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-matrix-'));
fs.mkdirSync(path.join(temp, 'test'), { recursive: true });
fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ dependencies: { express: '1.0.0' } }));
fs.writeFileSync(path.join(temp, 'test', 'a-pass.test.js'), "console.log('ok')\n");
fs.writeFileSync(path.join(temp, 'test', 'b-missing.test.js'), "require('express')\n");
fs.writeFileSync(path.join(temp, 'test', 'c-fail.test.js'), "throw new Error('real failure')\n");
fs.writeFileSync(path.join(temp, 'test', 'd-fake-missing.test.js'), "console.error(\"Cannot find module 'express'\"); process.exit(1)\n");
fs.mkdirSync(path.join(temp, 'test', 'e2e'));
fs.writeFileSync(path.join(temp, 'test', 'e2e', 'ignored.test.js'), "throw new Error('ignored')\n");

assert.deepStrictEqual(discoverTestPrograms(temp), [
  'test/a-pass.test.js',
  'test/b-missing.test.js',
  'test/c-fail.test.js',
  'test/d-fake-missing.test.js'
]);
assert.strictEqual(extractMissingModule("Error: Cannot find module 'express'"), 'express');
assert.strictEqual(extractMissingModule('ordinary failure'), null);
assert.strictEqual(isModuleNotFoundFailure("code: 'MODULE_NOT_FOUND'"), true);
assert.strictEqual(isModuleNotFoundFailure("Cannot find module 'express'"), false);
assert.throws(() => normalizeSubjectHash('0'.repeat(64), true), /non-zero/);

const report = runTestMatrix({
  root: temp,
  allowMissingDependencies: true,
  now: new Date('2026-07-23T12:00:00.000Z'),
  subjectHash: '1'.repeat(64),
  requireSubjectHash: true
});
assert.deepStrictEqual(report.counts, { total: 4, passed: 1, blocked: 1, failed: 2 });
assert.strictEqual(report.subjectHash, '1'.repeat(64));
assert.strictEqual(report.tests[0].status, 'pass');
assert.strictEqual(report.tests[1].status, 'blocked');
assert.strictEqual(report.tests[1].blockedModule, 'express');
assert.strictEqual(report.tests[2].status, 'fail');
assert.strictEqual(report.tests[3].status, 'fail', 'printed missing-module text must not be classified as blocked');
assert.match(report.reportHash, /^[a-f0-9]{64}$/);

const strict = runTestMatrix({ root: temp, allowMissingDependencies: false });
assert.strictEqual(strict.counts.blocked, 0);
assert.strictEqual(strict.counts.failed, 3);
assert.throws(() => runTestMatrix({ root: temp, requireSubjectHash: true }), /subjectHash is required/);

const cliTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-matrix-cli-'));
fs.mkdirSync(path.join(cliTemp, 'test'), { recursive: true });
fs.writeFileSync(path.join(cliTemp, 'package.json'), JSON.stringify({ dependencies: {} }));
fs.writeFileSync(path.join(cliTemp, 'test', 'only.test.js'), "console.log('ok')\n");
const cliScript = path.resolve(__dirname, '..', 'scripts', 'test-matrix.js');
let cli = spawnSync(process.execPath, [cliScript, '--require-all', '--require-subject', '--report', 'report.json'], {
  cwd: cliTemp,
  env: { ...process.env, NV_STAGING_SUBJECT_SHA256: '' },
  encoding: 'utf8'
});
assert.strictEqual(cli.status, 2);
assert.match(cli.stderr, /subjectHash is required/);
cli = spawnSync(process.execPath, [cliScript, '--require-all', '--require-subject', '--report', 'report.json'], {
  cwd: cliTemp,
  env: { ...process.env, NV_STAGING_SUBJECT_SHA256: '2'.repeat(64) },
  encoding: 'utf8'
});
assert.strictEqual(cli.status, 0, cli.stderr);
const cliReport = JSON.parse(fs.readFileSync(path.join(cliTemp, 'report.json'), 'utf8'));
assert.strictEqual(cliReport.subjectHash, '2'.repeat(64));
assert.deepStrictEqual(cliReport.counts, { total: 1, passed: 1, blocked: 0, failed: 0 });
fs.rmSync(cliTemp, { recursive: true, force: true });

fs.rmSync(temp, { recursive: true, force: true });

/*
 * A server test listens on a port from test/helpers/free-port.js. Below the
 * kernel's ephemeral range (32768 and up on Linux), because a port there can
 * already be the local end of an outbound connection -- the tests' own
 * PostgreSQL clients among them -- and the server then exits on EADDRINUSE
 * half a second in, as a bare "exit 1". And bound before it is handed out,
 * because a port drawn at random from ranges that overlap was sometimes still
 * held by a server another test had not finished stopping, which then answered
 * the test's requests in place of its own.
 */
(async () => {
  const EPHEMERAL_FLOOR = 32768;
  const { freePort, findFreePort, PORT_RANGE } = require('./helpers/free-port');
  assert(PORT_RANGE.low >= 1024 && PORT_RANGE.high < EPHEMERAL_FLOOR, 'test ports stay below the ephemeral range and above the privileged one');
  for (let i = 0; i < 5; i += 1) {
    const port = freePort();
    assert(port >= PORT_RANGE.low && port <= PORT_RANGE.high, `${port} is outside the test range`);
  }
  const held = net.createServer();
  const heldPort = freePort();
  await new Promise(resolve => held.listen(heldPort, resolve));
  assert.throws(() => findFreePort(heldPort, heldPort), /no free port was found/, 'a port a listener holds is never handed out');
  await new Promise(resolve => held.close(resolve));
  assert.strictEqual(findFreePort(heldPort, heldPort), heldPort, 'the same port is handed out once it is free');

  const sources = [
    ...fs.readdirSync(__dirname).filter(file => file.endsWith('.test.js')).map(file => path.join(__dirname, file)),
    ...fs.readdirSync(path.join(__dirname, 'integration')).filter(file => file.endsWith('.js')).map(file => path.join(__dirname, 'integration', file))
  ];
  let users = 0;
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    assert(!/\bport\s*=\s*\d+\s*\+\s*Math\.floor\(Math\.random\(\)/.test(source), `${path.relative(__dirname, file)} draws its own port; take one from freePort()`);
    if (/\bconst port = freePort\(\);/.test(source)) users += 1;
  }
  assert(users >= 19, `the server tests must take their ports from freePort(): ${users}`);
  console.log('test matrix tests passed');
})().catch(error => { console.error(error); process.exit(1); });
