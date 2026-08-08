'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { stableJson } = require('./governance-model');

const REPORT_SCHEMA_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 45_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function discoverTestPrograms(root) {
  const testDir = path.join(root, 'test');
  return fs.readdirSync(testDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => `test/${entry.name}`)
    .sort();
}

function extractMissingModule(output) {
  const match = String(output || '').match(/Cannot find module ['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

function isModuleNotFoundFailure(output) {
  return /\bcode:\s*['"]MODULE_NOT_FOUND['"]/.test(String(output || ''));
}

function isRequestUnavailable(root, request) {
  try {
    require.resolve(request, { paths: [root] });
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'MODULE_NOT_FOUND');
  }
}

function normalizeSubjectHash(value, required = false) {
  const subjectHash = String(value || '').trim().toLowerCase();
  if (!subjectHash) {
    if (required) throw new TypeError('subjectHash is required');
    return null;
  }
  if (!SHA256_PATTERN.test(subjectHash) || /^0{64}$/.test(subjectHash)) throw new TypeError('subjectHash must be a non-zero SHA-256 digest');
  return subjectHash;
}

function packageNameForRequest(request) {
  if (!request || request.startsWith('.') || request.startsWith('/') || request.startsWith('node:')) return null;
  const parts = request.split('/');
  return request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function declaredDependencies(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {})
  ]);
}

function runTestProgram(root, relativePath, options = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [relativePath], {
    cwd: root,
    encoding: 'utf8',
    timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) }
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const output = `${stdout}\n${stderr}`;
  const missingRequest = extractMissingModule(output);
  const missingPackage = packageNameForRequest(missingRequest);
  const declared = options.declaredDependencies || new Set();
  const mayBlock = options.allowMissingDependencies === true
    && !result.signal
    && !(result.error && result.error.code === 'ETIMEDOUT')
    && missingPackage
    && declared.has(missingPackage)
    && isModuleNotFoundFailure(output)
    && isRequestUnavailable(root, missingRequest);
  const status = result.status === 0 ? 'pass' : mayBlock ? 'blocked' : 'fail';

  return {
    path: relativePath,
    status,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    blockedModule: status === 'blocked' ? missingPackage : null,
    durationMs: Math.round(durationMs),
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
    outputHash: sha256(output)
  };
}

function runTestMatrix(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const files = Array.isArray(options.files) ? [...options.files].sort() : discoverTestPrograms(root);
  const subjectHash = normalizeSubjectHash(options.subjectHash, options.requireSubjectHash === true);
  const declared = declaredDependencies(root);
  const tests = files.map(relativePath => runTestProgram(root, relativePath, {
    allowMissingDependencies: options.allowMissingDependencies === true,
    timeoutMs: options.timeoutMs,
    env: options.env,
    declaredDependencies: declared
  }));
  const counts = {
    total: tests.length,
    passed: tests.filter(test => test.status === 'pass').length,
    blocked: tests.filter(test => test.status === 'blocked').length,
    failed: tests.filter(test => test.status === 'fail').length
  };
  const reportCore = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: options.allowMissingDependencies === true ? 'allow-declared-missing-dependencies' : 'require-all',
    subjectHash,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    counts,
    tests: tests.map(({ durationMs, ...test }) => test)
  };
  return {
    ...reportCore,
    generatedAt: (options.now instanceof Date ? options.now : new Date(options.now || Date.now())).toISOString(),
    tests,
    reportHash: sha256(stableJson(reportCore))
  };
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  DEFAULT_TIMEOUT_MS,
  sha256,
  discoverTestPrograms,
  extractMissingModule,
  isModuleNotFoundFailure,
  isRequestUnavailable,
  normalizeSubjectHash,
  packageNameForRequest,
  declaredDependencies,
  runTestProgram,
  runTestMatrix
};
