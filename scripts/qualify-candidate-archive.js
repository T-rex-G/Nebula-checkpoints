#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const registry = require('../config/public-alpha-capabilities.json');
const { qualificationCatalog } = require('../src/public-alpha-qualification');
const {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope
} = require('../src/qualification-evidence');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_PATH_BYTES = 1024;
const MINIMUM_MATRIX_TESTS = 141;
const MINIMUM_BROWSER_TESTS = 56;
const COMMAND_TIMEOUTS_MS = Object.freeze({
  archive: 60 * 1000,
  install: 10 * 60 * 1000,
  gate: 5 * 60 * 1000,
  matrix: 10 * 60 * 1000,
  browser: 15 * 60 * 1000
});
const SAFE_AMBIENT_ENV_KEYS = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'PLAYWRIGHT_BROWSERS_PATH'
]);

function fail(message) {
  throw new TypeError(message);
}

function assertPinnedNodeVersion(version = process.version) {
  if (version !== 'v22.23.1') fail('candidate qualification requires Node v22.23.1');
  return version;
}

function parseArgs(argv) {
  const values = Array.isArray(argv) ? argv.map(String) : [];
  const names = new Map([
    ['--archive', 'archivePath'],
    ['--comparison-archive', 'comparisonArchivePath'],
    ['--sha256', 'expectedSha256'],
    ['--extract-dir', 'extractDir'],
    ['--report', 'reportPath'],
    ['--browser-report', 'browserReportPath'],
    ['--evidence', 'evidencePath'],
    ['--source-commit', 'sourceCommit'],
    ['--origin-id', 'originId']
  ]);
  const output = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const target = names.get(name);
    const value = values[index + 1];
    if (!target || value == null || value === '' || Object.hasOwn(output, target)) {
      fail('candidate qualifier arguments are invalid');
    }
    output[target] = value;
  }
  if (Object.keys(output).length !== names.size) fail('candidate qualifier requires every named argument');
  for (const field of [
    'archivePath', 'comparisonArchivePath', 'extractDir', 'reportPath',
    'browserReportPath', 'evidencePath'
  ]) {
    if (!path.isAbsolute(output[field])) fail(`${field} must use an absolute path`);
    output[field] = path.normalize(output[field]);
  }
  output.expectedSha256 = String(output.expectedSha256).trim().toLowerCase();
  if (!SHA256_PATTERN.test(output.expectedSha256) || /^0{64}$/.test(output.expectedSha256)) {
    fail('--sha256 must be an exact non-zero SHA-256 digest');
  }
  output.sourceCommit = String(output.sourceCommit).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(output.sourceCommit) || /^0{40}$/.test(output.sourceCommit)) {
    fail('--source-commit must be an exact non-zero commit');
  }
  output.originId = String(output.originId).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(output.originId)) fail('--origin-id is invalid');
  return output;
}

function assertRegularFile(filePath, label) {
  let metadata;
  try {
    metadata = fs.lstatSync(filePath);
  } catch {
    fail(`${label} must be a readable regular non-symlink file`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular non-symlink file`);
  if (metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES) fail(`${label} is outside the safe size limit`);
  return metadata;
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function filesEqual(leftPath, rightPath) {
  const left = assertRegularFile(leftPath, 'candidate archive');
  const right = assertRegularFile(rightPath, 'comparison archive');
  if (left.size !== right.size) return false;
  const leftDescriptor = fs.openSync(leftPath, 'r');
  const rightDescriptor = fs.openSync(rightPath, 'r');
  const leftBuffer = Buffer.allocUnsafe(64 * 1024);
  const rightBuffer = Buffer.allocUnsafe(64 * 1024);
  const readExact = (descriptor, buffer, length, position) => {
    let total = 0;
    while (total < length) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        total,
        length - total,
        position + total
      );
      if (bytesRead === 0) fail('candidate archive changed during comparison: incomplete read');
      total += bytesRead;
    }
  };
  try {
    let offset = 0;
    while (offset < left.size) {
      const length = Math.min(leftBuffer.length, left.size - offset);
      readExact(leftDescriptor, leftBuffer, length, offset);
      readExact(rightDescriptor, rightBuffer, length, offset);
      if (!crypto.timingSafeEqual(leftBuffer.subarray(0, length), rightBuffer.subarray(0, length))) return false;
      offset += length;
    }
    return true;
  } finally {
    fs.closeSync(leftDescriptor);
    fs.closeSync(rightDescriptor);
  }
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs == null ? COMMAND_TIMEOUTS_MS.archive : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60 * 1000) {
    fail('candidate command timeout is invalid');
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || Object.fromEntries(
      SAFE_AMBIENT_ENV_KEYS
        .filter(key => process.env[key] != null && String(process.env[key]))
        .map(key => [key, String(process.env[key])])
    ),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    fail(`${options.label || command} timed out after ${timeoutMs} ms`);
  }
  const allowedStatuses = new Set(options.allowedStatuses || [0]);
  if (result.error || !allowedStatuses.has(result.status)) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 4000);
    fail(`${options.label || command} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function buildQualificationEnvironment(baseEnv, workspace, subjectSha256) {
  const source = baseEnv && typeof baseEnv === 'object' ? baseEnv : {};
  const root = path.resolve(workspace);
  const home = path.join(root, '.qualification-home');
  const temporary = path.join(root, '.qualification-tmp');
  const cache = path.join(root, '.qualification-npm-cache');
  for (const directory of [home, temporary, cache]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const environment = {};
  for (const key of SAFE_AMBIENT_ENV_KEYS) {
    if (source[key] == null || !String(source[key])) continue;
    const value = String(source[key]);
    if (/[\u0000\r\n]/.test(value)) fail(`qualification environment ${key} is invalid`);
    if (key === 'PLAYWRIGHT_BROWSERS_PATH' && !path.isAbsolute(value)) {
      fail('PLAYWRIGHT_BROWSERS_PATH must use an absolute path');
    }
    environment[key] = value;
  }
  if (!environment.PATH) environment.PATH = path.dirname(process.execPath);
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    CI: 'true',
    NO_COLOR: '1',
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_USERCONFIG: path.join(home, '.npmrc-disabled'),
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NV_STAGING_SUBJECT_SHA256: subjectSha256
  });
  return Object.freeze(environment);
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) {
    fail('archive entry inventory is invalid');
  }
  const seen = new Set();
  let rootName = null;
  for (const rawEntry of entries) {
    const entry = String(rawEntry);
    if (
      !entry ||
      Buffer.byteLength(entry, 'utf8') > MAX_PATH_BYTES ||
      entry.includes('\\') ||
      entry.includes('\0') ||
      entry.includes(' -> ') ||
      path.posix.isAbsolute(entry)
    ) fail('archive contains an unsafe path');
    const withoutSlash = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (
      !withoutSlash ||
      path.posix.normalize(withoutSlash) !== withoutSlash ||
      withoutSlash.split('/').some(part => part === '' || part === '.' || part === '..') ||
      seen.has(entry)
    ) fail('archive contains an unsafe or duplicate path');
    seen.add(entry);
    const top = withoutSlash.split('/')[0];
    if (!rootName) rootName = top;
    if (top !== rootName) fail('archive must contain exactly one candidate root');
  }
  if (
    !seen.has(`${rootName}/package.json`) ||
    !seen.has(`${rootName}/scripts/test-matrix.js`) ||
    !seen.has(`${rootName}/scripts/copy-vendor.js`)
  ) {
    fail('archive is missing the candidate qualification entry points');
  }
  return Object.freeze({ rootName });
}

function inventoryArchive(archivePath) {
  const listing = runCommand('unzip', ['-Z1', archivePath], { label: 'archive inventory' });
  if (listing.includes('\0')) fail('archive inventory is invalid');
  const entries = listing.split(/\r?\n/).filter(Boolean);
  const layout = validateArchiveEntries(entries);
  const metadata = runCommand('zipinfo', ['-l', archivePath], { label: 'archive metadata inventory' });
  const rows = metadata.split(/\r?\n/).filter(line => /^[bcdlps-][rwxStTs-]{9}\s/.test(line));
  if (rows.length !== entries.length) fail('archive metadata inventory is ambiguous');
  let expandedBytes = 0;
  for (const row of rows) {
    if (!/^[-d]/.test(row)) fail('archive contains a non-regular entry');
    const fields = row.trim().split(/\s+/);
    const size = Number(fields[3]);
    if (!Number.isSafeInteger(size) || size < 0) fail('archive metadata size is invalid');
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) fail('archive expands beyond the safe size limit');
  }
  return layout;
}

function assertExtractedTree(root) {
  const rootReal = fs.realpathSync(root);
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = fs.lstatSync(absolute);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        fail('extracted archive contains a non-regular entry');
      }
      const real = fs.realpathSync(absolute);
      const relative = path.relative(rootReal, real);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail('extracted archive escapes the candidate root');
      }
      if (metadata.isDirectory()) visit(absolute);
    }
  };
  visit(rootReal);
}

function validateMatrixReport(reportPath, expectedSha256, minimumTests = MINIMUM_MATRIX_TESTS) {
  let report;
  try {
    const metadata = fs.lstatSync(reportPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 64 * 1024 * 1024) throw new Error('unsafe');
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    fail('candidate matrix report is missing or invalid');
  }
  if (
    report.subjectHash !== expectedSha256 ||
    !report.counts ||
    !Number.isInteger(report.counts.total) ||
    report.counts.total < minimumTests ||
    report.counts.passed !== report.counts.total ||
    report.counts.blocked !== 0 ||
    report.counts.failed !== 0 ||
    !SHA256_PATTERN.test(String(report.reportHash || ''))
  ) fail('candidate matrix report does not prove the exact subject');
  return report;
}

function readJsonReport(reportPath, label, maximumBytes = 64 * 1024 * 1024) {
  try {
    const metadata = fs.lstatSync(reportPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
      throw new Error('unsafe');
    }
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    fail(`${label} is missing or invalid`);
  }
}

function validateBrowserReport(reportPath, minimumTests = MINIMUM_BROWSER_TESTS) {
  const report = readJsonReport(reportPath, 'candidate browser report');
  const tests = [];
  const collectTests = suites => {
    if (!Array.isArray(suites)) fail('candidate browser report contains a failed or incomplete run');
    for (const suite of suites) {
      if (!suite || typeof suite !== 'object') fail('candidate browser report contains a failed or incomplete run');
      if (Array.isArray(suite.specs)) {
        for (const spec of suite.specs) {
          if (!spec || spec.ok !== true || !Array.isArray(spec.tests)) {
            fail('candidate browser report contains a failed or incomplete run');
          }
          tests.push(...spec.tests);
        }
      }
      if (suite.suites != null) collectTests(suite.suites);
    }
  };
  collectTests(report.suites);
  const allTestsPassed = tests.every(test =>
    test &&
    test.expectedStatus === 'passed' &&
    test.status === 'expected' &&
    Array.isArray(test.results) &&
    test.results.length > 0 &&
    test.results.every(result => result && result.status === 'passed')
  );
  if (
    !report.stats ||
    !Number.isInteger(report.stats.expected) ||
    !Number.isInteger(report.stats.skipped) ||
    !Number.isInteger(report.stats.unexpected) ||
    !Number.isInteger(report.stats.flaky) ||
    tests.length < minimumTests ||
    report.stats.expected !== tests.length ||
    report.stats.skipped !== 0 ||
    report.stats.unexpected !== 0 ||
    report.stats.flaky !== 0 ||
    !allTestsPassed ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0
  ) fail('candidate browser report contains a failed or incomplete run');
  return report;
}

function validateDevelopmentAudit(output) {
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    fail('candidate development audit output is invalid');
  }
  const counts = report.metadata && report.metadata.vulnerabilities;
  if (
    !counts ||
    !['info', 'low', 'moderate', 'high', 'critical', 'total'].every(key => Number.isInteger(counts[key])) ||
    counts.high !== 0 ||
    counts.critical !== 0
  ) fail('candidate development audit contains a high or critical vulnerability');
  return counts;
}

function writeAutomatedEvidence(options) {
  const completedAt = new Date().toISOString();
  const claims = Object.fromEntries(qualificationCatalog(registry).automated.map(key => [
    `automated.${key}`,
    { status: 'pass', cleanupVerified: true, completedAt }
  ]));
  const evidence = validateEvidenceEnvelope({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    artifactType: 'automated',
    subjectSha256: options.subjectSha256,
    sourceCommit: options.sourceCommit,
    originId: options.originId,
    completedAt,
    cleanupVerified: true,
    claims,
    proof: {
      nodeVersion: process.version,
      deterministicArchives: true,
      freshExtractionCleanInstall: true,
      matrixReportCoreSha256: options.matrixReport.reportHash,
      matrixReportFileSha256: options.matrixReportFileSha256,
      browserReportFileSha256: options.browserReportFileSha256,
      matrixTests: options.matrixReport.counts.total,
      browserTests: options.browserReport.stats.expected,
      developmentAudit: options.developmentAudit
    }
  });
  if (fs.existsSync(options.evidencePath)) fail('automated evidence output must not already exist');
  fs.mkdirSync(path.dirname(options.evidencePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(options.evidencePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  return evidence;
}

function qualifyCandidateArchive(options) {
  assertPinnedNodeVersion();
  const parsed = parseArgs([
    '--archive', options.archivePath,
    '--comparison-archive', options.comparisonArchivePath,
    '--sha256', options.expectedSha256,
    '--extract-dir', options.extractDir,
    '--report', options.reportPath,
    '--browser-report', options.browserReportPath,
    '--evidence', options.evidencePath,
    '--source-commit', options.sourceCommit,
    '--origin-id', options.originId
  ]);
  assertRegularFile(parsed.archivePath, 'candidate archive');
  assertRegularFile(parsed.comparisonArchivePath, 'comparison archive');
  const observedSha256 = hashFile(parsed.archivePath);
  if (observedSha256 !== parsed.expectedSha256) fail('candidate archive SHA-256 does not match');
  if (!filesEqual(parsed.archivePath, parsed.comparisonArchivePath)) {
    fail('candidate archives are not deterministic byte-for-byte');
  }
  const { rootName } = inventoryArchive(parsed.archivePath);
  if (fs.existsSync(parsed.extractDir)) fail('candidate extraction directory must not already exist');
  fs.mkdirSync(parsed.extractDir, { recursive: false, mode: 0o700 });
  runCommand('unzip', ['-q', parsed.archivePath, '-d', parsed.extractDir], { label: 'candidate extraction' });
  const candidateRoot = path.join(parsed.extractDir, rootName);
  assertExtractedTree(candidateRoot);
  const environment = buildQualificationEnvironment(
    options.env || process.env,
    parsed.extractDir,
    parsed.expectedSha256
  );
  runCommand('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate npm ci',
    timeoutMs: COMMAND_TIMEOUTS_MS.install
  });
  runCommand(process.execPath, ['scripts/copy-vendor.js'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate reviewed vendor copy',
    timeoutMs: COMMAND_TIMEOUTS_MS.gate
  });
  runCommand('npm', ['run', 'check:syntax'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate syntax gate',
    timeoutMs: COMMAND_TIMEOUTS_MS.gate
  });
  runCommand('npm', ['run', 'check:secrets'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate secret gate',
    timeoutMs: COMMAND_TIMEOUTS_MS.gate
  });
  runCommand('npm', ['audit', '--omit=dev', '--audit-level=high'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate production audit',
    timeoutMs: COMMAND_TIMEOUTS_MS.gate
  });
  const developmentAudit = validateDevelopmentAudit(runCommand('npm', ['audit', '--json'], {
    cwd: candidateRoot,
    env: environment,
    allowedStatuses: [0, 1],
    label: 'candidate development audit',
    timeoutMs: COMMAND_TIMEOUTS_MS.gate
  }));
  runCommand(process.execPath, [
    'scripts/test-matrix.js',
    '--require-all',
    '--require-subject',
    '--report',
    parsed.reportPath
  ], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate test matrix',
    timeoutMs: COMMAND_TIMEOUTS_MS.matrix
  });
  const report = validateMatrixReport(
    parsed.reportPath,
    parsed.expectedSha256,
    options.minimumMatrixTests == null ? MINIMUM_MATRIX_TESTS : options.minimumMatrixTests
  );
  const matrixReportFileSha256 = hashFile(parsed.reportPath);
  fs.mkdirSync(path.dirname(parsed.browserReportPath), { recursive: true, mode: 0o700 });
  runCommand('npm', ['run', 'test:e2e:evidence'], {
    cwd: candidateRoot,
    env: {
      ...environment,
      PLAYWRIGHT_JSON_OUTPUT_FILE: parsed.browserReportPath,
      NV_STAGING_MATRIX_REPORT_PATH: parsed.reportPath
    },
    label: 'candidate browser matrix',
    timeoutMs: COMMAND_TIMEOUTS_MS.browser
  });
  const browserReport = validateBrowserReport(
    parsed.browserReportPath,
    options.minimumBrowserTests == null ? MINIMUM_BROWSER_TESTS : options.minimumBrowserTests
  );
  if (hashFile(parsed.reportPath) !== matrixReportFileSha256) {
    fail('candidate browser matrix modified the program matrix report');
  }
  const browserReportFileSha256 = hashFile(parsed.browserReportPath);
  writeAutomatedEvidence({
    subjectSha256: parsed.expectedSha256,
    sourceCommit: parsed.sourceCommit,
    originId: parsed.originId,
    evidencePath: parsed.evidencePath,
    matrixReport: report,
    matrixReportFileSha256,
    browserReport,
    browserReportFileSha256,
    developmentAudit
  });
  return Object.freeze({
    ok: true,
    subjectSha256: parsed.expectedSha256,
    candidateRoot,
    reportPath: parsed.reportPath,
    browserReportPath: parsed.browserReportPath,
    evidencePath: parsed.evidencePath,
    matrixReportCoreSha256: report.reportHash,
    matrixReportFileSha256,
    browserReportFileSha256,
    tests: report.counts.total
  });
}

function main() {
  try {
    const result = qualifyCandidateArchive(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  parseArgs,
  assertPinnedNodeVersion,
  MINIMUM_MATRIX_TESTS,
  MINIMUM_BROWSER_TESTS,
  COMMAND_TIMEOUTS_MS,
  runCommand,
  hashFile,
  filesEqual,
  validateArchiveEntries,
  inventoryArchive,
  validateMatrixReport,
  validateBrowserReport,
  validateDevelopmentAudit,
  buildQualificationEnvironment,
  writeAutomatedEvidence,
  qualifyCandidateArchive
});
