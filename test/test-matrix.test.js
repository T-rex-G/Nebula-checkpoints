'use strict';

const assert = require('assert');
const fs = require('fs');
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
console.log('test matrix tests passed');
