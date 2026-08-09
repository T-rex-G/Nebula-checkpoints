#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const registry = require('../config/public-alpha-capabilities.json');
const { qualificationCatalog } = require('../src/public-alpha-qualification');
const { validateEvidenceEnvelope } = require('../src/qualification-evidence');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_PATH_BYTES = 1024;
const MINIMUM_MATRIX_TESTS = 137;
const MINIMUM_BROWSER_TESTS = 56;

function fail(message) {
  throw new TypeError(message);
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
  try {
    let offset = 0;
    while (offset < left.size) {
      const length = Math.min(leftBuffer.length, left.size - offset);
      const leftRead = fs.readSync(leftDescriptor, leftBuffer, 0, length, offset);
      const rightRead = fs.readSync(rightDescriptor, rightBuffer, 0, length, offset);
      if (
        leftRead !== rightRead ||
        !crypto.timingSafeEqual(leftBuffer.subarray(0, leftRead), rightBuffer.subarray(0, rightRead))
      ) return false;
      offset += leftRead;
    }
    return true;
  } finally {
    fs.closeSync(leftDescriptor);
    fs.closeSync(rightDescriptor);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  const allowedStatuses = new Set(options.allowedStatuses || [0]);
  if (result.error || !allowedStatuses.has(result.status)) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 4000);
    fail(`${options.label || command} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
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
  if (!seen.has(`${rootName}/package.json`) || !seen.has(`${rootName}/scripts/test-matrix.js`)) {
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
  if (
    !report.stats ||
    !Number.isInteger(report.stats.expected) ||
    report.stats.expected < minimumTests ||
    report.stats.unexpected !== 0 ||
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
    schemaVersion: '1.1.0',
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
  const environment = {
    ...(options.env || process.env),
    NV_STAGING_SUBJECT_SHA256: parsed.expectedSha256
  };
  runCommand('npm', ['ci'], { cwd: candidateRoot, env: environment, label: 'candidate npm ci' });
  if (process.version !== 'v22.23.1') fail('candidate qualification requires Node v22.23.1');
  runCommand('npm', ['run', 'check:syntax'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate syntax gate'
  });
  runCommand('npm', ['run', 'check:secrets'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate secret gate'
  });
  runCommand('npm', ['audit', '--omit=dev', '--audit-level=high'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate production audit'
  });
  const developmentAudit = validateDevelopmentAudit(runCommand('npm', ['audit', '--json'], {
    cwd: candidateRoot,
    env: environment,
    allowedStatuses: [0, 1],
    label: 'candidate development audit'
  }));
  runCommand(process.execPath, [
    'scripts/test-matrix.js',
    '--require-all',
    '--require-subject',
    '--report',
    parsed.reportPath
  ], { cwd: candidateRoot, env: environment, label: 'candidate test matrix' });
  const report = validateMatrixReport(
    parsed.reportPath,
    parsed.expectedSha256,
    options.minimumMatrixTests == null ? MINIMUM_MATRIX_TESTS : options.minimumMatrixTests
  );
  const matrixReportFileSha256 = hashFile(parsed.reportPath);
  fs.mkdirSync(path.dirname(parsed.browserReportPath), { recursive: true, mode: 0o700 });
  runCommand('npm', ['run', 'test:e2e:evidence'], {
    cwd: candidateRoot,
    env: { ...environment, PLAYWRIGHT_JSON_OUTPUT_FILE: parsed.browserReportPath },
    label: 'candidate browser matrix'
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
  MINIMUM_MATRIX_TESTS,
  MINIMUM_BROWSER_TESTS,
  hashFile,
  filesEqual,
  validateArchiveEntries,
  inventoryArchive,
  validateMatrixReport,
  validateBrowserReport,
  validateDevelopmentAudit,
  writeAutomatedEvidence,
  qualifyCandidateArchive
});
