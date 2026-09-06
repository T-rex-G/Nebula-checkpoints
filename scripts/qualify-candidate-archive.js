#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const registry = require('../config/public-alpha-capabilities.json');
const { stableJson } = require('../src/governance-model');
const { qualificationCatalog } = require('../src/public-alpha-qualification');
const { run: runSecretScan } = require('./check-secrets');
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
/*
 * NV_TEST_DATABASE_URL is here because the candidate's own suite includes a
 * program that applies the migrations to a real server, and a migration proven
 * in one gate and excused in another is not proven. Without it that program
 * refuses and the candidate matrix reports a failure.
 *
 * It is the one entry that could name something outside the runner, so it is
 * the one entry that is checked: only a loopback server is passed through. A
 * variable of this name pointing at a real database stops the qualification
 * rather than handing candidate code a live connection string.
 */
const SAFE_AMBIENT_ENV_KEYS = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'PLAYWRIGHT_BROWSERS_PATH', 'NV_TEST_DATABASE_URL'
]);

const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]']);

function assertLoopbackTestDatabase(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('NV_TEST_DATABASE_URL is not a valid connection URL');
  }
  if (!LOOPBACK_HOSTS.includes(parsed.hostname)) {
    fail('NV_TEST_DATABASE_URL must name a loopback test server, never a real database');
  }
}
const AUTOMATED_CLAIM_REQUIREMENTS = Object.freeze({
  'node22-clean-install': Object.freeze({ direct: Object.freeze(['nodePinned', 'cleanInstall']) }),
  'node22-runtime-matrix': Object.freeze({
    direct: Object.freeze(['nodePinned']),
    matrix: Object.freeze(['test/test-matrix.test.js'])
  }),
  syntax: Object.freeze({ direct: Object.freeze(['syntax']) }),
  'secret-scan': Object.freeze({ direct: Object.freeze(['secretScan']) }),
  'deterministic-double-package': Object.freeze({ direct: Object.freeze(['deterministicArchives']) }),
  'fresh-extraction-clean-install': Object.freeze({ direct: Object.freeze(['freshExtraction', 'cleanInstall']) }),
  'production-audit': Object.freeze({ direct: Object.freeze(['productionAudit']) }),
  'development-audit-classification': Object.freeze({ direct: Object.freeze(['developmentAudit']) }),
  'desktop-golden-path': Object.freeze({ browser: Object.freeze([Object.freeze({
    file: 'public-alpha-golden-path.spec.js',
    title: 'invited tester completes the GitHub sandbox golden path and cleanup',
    project: 'desktop'
  })]) }),
  'mobile-golden-path': Object.freeze({ browser: Object.freeze([Object.freeze({
    file: 'public-alpha-golden-path.spec.js',
    title: 'invited tester completes the GitHub sandbox golden path and cleanup',
    project: 'mobile'
  })]) }),
  'capability-ui-server-consistency': Object.freeze({ matrix: Object.freeze([
    'test/capability-registry-server-contract.test.js',
    'test/capability-ui-behavior.test.js',
    'test/capability-ui-contract.test.js'
  ]) }),
  'invite-security': Object.freeze({ matrix: Object.freeze([
    'test/alpha-access-persistence-contract.test.js',
    'test/alpha-access-server-contract.test.js',
    'test/alpha-access-store.test.js',
    'test/alpha-access.test.js'
  ]) }),
  'repository-allowlist': Object.freeze({ matrix: Object.freeze(['test/alpha-repository-boundary.test.js']) }),
  'credential-browser-purge': Object.freeze({
    matrix: Object.freeze(['test/alpha-browser-purge.test.js']),
    browser: Object.freeze([Object.freeze({
      file: 'pwa.spec.js',
      title: 'offline repository access is opt-in and account switching purges scoped caches first',
      project: 'desktop'
    })])
  }),
  cleanup: Object.freeze({ matrix: Object.freeze([
    'test/provider-disconnect.test.js',
    'test/alpha-privacy-store.test.js'
  ]) }),
  'retention-purge': Object.freeze({ matrix: Object.freeze([
    'test/alpha-privacy-persistence-contract.test.js',
    'test/alpha-privacy-store.test.js'
  ]) }),
  'cold-start-degraded-ui': Object.freeze({ browser: Object.freeze([
    Object.freeze({
      file: 'public-alpha-states.spec.js',
      title: 'cold start shows a waking state and a safe access action',
      project: 'desktop'
    }),
    Object.freeze({
      file: 'public-alpha-states.spec.js',
      title: 'cold start shows a waking state and a safe access action',
      project: 'mobile'
    })
  ]) }),
  'backup-format': Object.freeze({ matrix: Object.freeze(['test/backup-format.test.js']) }),
  'rate-abuse': Object.freeze({ matrix: Object.freeze([
    'test/alpha-load.test.js',
    'test/alpha-access-store.test.js'
  ]) }),
  'accessibility-axe': Object.freeze({ browser: Object.freeze([
    Object.freeze({
      file: 'public-alpha-accessibility.spec.js',
      title: 'required alpha screens have no critical or serious axe violations',
      project: 'desktop'
    }),
    Object.freeze({
      file: 'public-alpha-accessibility.spec.js',
      title: 'required alpha screens have no critical or serious axe violations',
      project: 'mobile'
    })
  ]) }),
  'accessibility-keyboard': Object.freeze({ browser: Object.freeze([
    Object.freeze({
      file: 'public-alpha-accessibility.spec.js',
      title: 'keyboard-only tester path exposes visible focus and status announcements',
      project: 'desktop'
    }),
    Object.freeze({
      file: 'public-alpha-accessibility.spec.js',
      title: 'keyboard-only tester path exposes visible focus and status announcements',
      project: 'mobile'
    })
  ]) }),
  'accessibility-reflow': Object.freeze({ browser: Object.freeze([
    Object.freeze({
      file: 'public-alpha-accessibility.spec.js',
      title: 'reduced motion, 320 CSS-pixel reflow, and mobile navigation remain usable',
      project: 'desktop'
    }),
    Object.freeze({
      file: 'public-alpha-accessibility.spec.js',
      title: 'reduced motion, 320 CSS-pixel reflow, and mobile navigation remain usable',
      project: 'mobile'
    })
  ]) })
});

function fail(message) {
  throw new TypeError(message);
}

function assertPinnedNodeVersion(version = process.version) {
  if (version !== 'v22.23.1') fail('candidate qualification requires Node v22.23.1');
  return version;
}

function parseArgs(argv) {
  const values = Array.isArray(argv) ? argv : [];
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
    const name = String(values[index]);
    const target = names.get(name);
    const rawValue = values[index + 1];
    if (!target || rawValue == null || rawValue === '' || Object.hasOwn(output, target)) {
      fail('candidate qualifier arguments are invalid');
    }
    output[target] = String(rawValue);
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
    if (key === 'NV_TEST_DATABASE_URL') assertLoopbackTestDatabase(value);
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

function packageManagerProxyUrl(value, label) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.length > 2048 || /[\u0000\r\n]/.test(raw)) fail(`${label} is invalid`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} is invalid`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname && parsed.pathname !== '/')
  ) fail(`${label} must be a credential-free HTTP(S) origin`);
  return parsed.origin;
}

function buildPackageManagerEnvironment(baseEnv, qualificationEnvironment) {
  const source = baseEnv && typeof baseEnv === 'object' ? baseEnv : {};
  const output = { ...qualificationEnvironment };
  for (const [target, upper, lower] of [
    ['HTTP_PROXY', 'HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'HTTPS_PROXY', 'https_proxy']
  ]) {
    const raw = [source[upper], source[lower]].find(value => value != null && String(value).trim());
    const normalized = packageManagerProxyUrl(raw, target);
    if (normalized) output[target] = normalized;
  }
  const noProxyRaw = [source.NO_PROXY, source.no_proxy]
    .find(value => value != null && String(value).trim());
  if (noProxyRaw != null) {
    const noProxy = String(noProxyRaw).trim();
    if (noProxy.length > 4096 || /[\u0000\r\n\s]/.test(noProxy)) fail('NO_PROXY is invalid');
    output.NO_PROXY = noProxy;
  }
  return Object.freeze(output);
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

function regularRelativeFiles(root, relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  const output = [];
  const visit = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) output.push(relative);
      else fail('trusted qualification program inventory contains a non-regular entry');
    }
  };
  visit(directory, relativeDirectory);
  return output.sort();
}

/*
 * The qualification programs compared byte-for-byte between the trusted tree
 * and the candidate. Hoisted out of the function so a guard can read it: the
 * list was previously inline, and the test supplies its own list, so nothing
 * checked that a program the runner EXECUTES from the candidate was actually
 * in it. Adding the audit gate without noticing that would have left it
 * running unverified from an archive that could have rewritten it.
 */
const DEFAULT_TRUSTED_PROGRAM_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'playwright.config.js',
  'scripts/test-matrix.js',
  'scripts/copy-vendor.js',
  'scripts/check-secrets.js',
  /*
   * The production audit gate runs from the candidate, so it has to be
   * compared against the trusted copy like every other qualification program.
   * Without this a tampered archive could ship an audit gate that exits zero
   * unconditionally and qualify itself clean -- the gate would still run, and
   * would still prove nothing.
   */
  'scripts/audit-production.js',
  'src/test-matrix.js',
  'src/governance-model.js'
]);

function assertTrustedQualificationPrograms(candidateRoot, trustedRoot, explicitPaths) {
  const trusted = path.resolve(trustedRoot || path.join(__dirname, '..'));
  const paths = explicitPaths || [
    ...DEFAULT_TRUSTED_PROGRAM_PATHS,
    ...regularRelativeFiles(trusted, 'test')
  ];
  if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length) {
    fail('trusted qualification program inventory is invalid');
  }
  const hashes = {};
  for (const relative of [...paths].sort()) {
    if (
      !relative || relative.includes('\\') ||
      path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      path.posix.normalize(relative) !== relative || relative.startsWith('../')
    ) {
      fail('trusted qualification program path is invalid');
    }
    const trustedPath = path.join(trusted, relative);
    const candidatePath = path.join(candidateRoot, relative);
    let trustedMetadata;
    let candidateMetadata;
    try {
      trustedMetadata = fs.lstatSync(trustedPath);
      candidateMetadata = fs.lstatSync(candidatePath);
    } catch {
      fail(`candidate qualification program is missing: ${relative}`);
    }
    if (
      trustedMetadata.isSymbolicLink() || candidateMetadata.isSymbolicLink() ||
      !trustedMetadata.isFile() || !candidateMetadata.isFile() ||
      trustedMetadata.size !== candidateMetadata.size
    ) fail(`candidate qualification program does not match trusted source: ${relative}`);
    const trustedHash = hashFile(trustedPath);
    if (trustedHash !== hashFile(candidatePath)) {
      fail(`candidate qualification program does not match trusted source: ${relative}`);
    }
    hashes[relative] = trustedHash;
  }
  return crypto.createHash('sha256').update(stableJson(hashes), 'utf8').digest('hex');
}

function trustedSyntaxTargets(trustedRoot) {
  let packageRecord;
  try {
    packageRecord = JSON.parse(fs.readFileSync(path.join(trustedRoot, 'package.json'), 'utf8'));
  } catch {
    fail('trusted syntax command catalog is invalid');
  }
  const commands = [
    packageRecord.scripts?.['precheck:syntax'],
    packageRecord.scripts?.['check:syntax'],
    packageRecord.scripts?.['postcheck:syntax']
  ].filter(Boolean).flatMap(command => String(command).split(/\s*&&\s*/));
  const targets = commands.map(command => {
    const match = /^node --check ([A-Za-z0-9._/-]+)$/.exec(command);
    const target = match && match[1];
    if (
      !target || target.includes('\\') ||
      path.posix.isAbsolute(target) || path.win32.isAbsolute(target) ||
      path.posix.normalize(target) !== target || target.startsWith('../')
    ) {
      fail('trusted syntax command catalog contains an unsupported command');
    }
    return target;
  });
  if (!targets.length || new Set(targets).size !== targets.length) {
    fail('trusted syntax command catalog is empty or ambiguous');
  }
  return targets;
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
  const tests = Array.isArray(report.tests) ? report.tests : [];
  const reportCore = {
    schemaVersion: report.schemaVersion,
    mode: report.mode,
    subjectHash: report.subjectHash,
    nodeVersion: report.nodeVersion,
    platform: report.platform,
    counts: report.counts,
    tests: tests.map(test => {
      if (!test || typeof test !== 'object' || Array.isArray(test)) return test;
      const { durationMs, ...deterministicTest } = test;
      return deterministicTest;
    })
  };
  const observedReportHash = crypto.createHash('sha256')
    .update(stableJson(reportCore), 'utf8')
    .digest('hex');
  if (
    report.schemaVersion !== '1.0.0' ||
    report.mode !== 'require-all' ||
    report.subjectHash !== expectedSha256 ||
    report.nodeVersion !== process.version ||
    report.platform !== `${process.platform}-${process.arch}` ||
    !report.counts ||
    !Number.isInteger(report.counts.total) ||
    report.counts.total < minimumTests ||
    report.counts.passed !== report.counts.total ||
    report.counts.blocked !== 0 ||
    report.counts.failed !== 0 ||
    tests.length !== report.counts.total ||
    tests.some(test => !test || test.status !== 'pass') ||
    !SHA256_PATTERN.test(String(report.reportHash || '')) ||
    report.reportHash !== observedReportHash
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
  /*
   * A skip is not a failure here, and demanding zero of them made this gate
   * unsatisfiable.
   *
   * The suite runs every spec under two projects, desktop and mobile, and a
   * good number of them declare a viewport they do not apply to -- a phone
   * dock has nothing to assert at 1280px, a desktop rail nothing at 393px.
   * Playwright reports those as skipped, nineteen of them, and this function
   * required `stats.skipped` to be zero, `stats.expected` to equal every test
   * in the tree, and every test to carry `expectedStatus: 'passed'`. Three
   * conditions, each of which the real report contradicts. It had never run
   * before the first live dispatch reached it, so nothing had ever said so.
   *
   * What the gate is actually for is: enough of the suite ran, and nothing
   * that ran failed. Skips are counted rather than forbidden, and the count
   * has to agree with the tree, so a report cannot claim fewer than it holds.
   *
   * The minimum now applies to the tests that ACTUALLY EXECUTED rather than to
   * the size of the tree, which is stricter than what it replaced: a candidate
   * can no longer reach the floor by declaring skips. And the named proofs the
   * capability contract depends on are pinned separately, by
   * browserProofInventory, which counts a test only when it genuinely passed --
   * so a skipped proof still fails the contract that requires it.
   */
  const executed = [];
  const skipped = [];
  for (const test of tests) {
    if (test && test.status === 'skipped' && test.expectedStatus === 'skipped') {
      skipped.push(test);
      continue;
    }
    executed.push(test);
  }
  const everyExecutedTestPassed = executed.every(test =>
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
    report.stats.expected < minimumTests ||
    report.stats.expected !== executed.length ||
    report.stats.skipped !== skipped.length ||
    report.stats.unexpected !== 0 ||
    report.stats.flaky !== 0 ||
    !everyExecutedTestPassed ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0
  ) fail('candidate browser report contains a failed or incomplete run');
  return report;
}

function browserProofKey(proof) {
  return `${proof.file}\u0000${proof.title}\u0000${proof.project}`;
}

function browserProofInventory(report) {
  const proofs = new Set();
  const visit = (suites, inheritedFile = '') => {
    for (const suite of suites || []) {
      const file = String(suite.file || inheritedFile || '');
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          if (
            spec.ok === true &&
            test.expectedStatus === 'passed' &&
            test.status === 'expected' &&
            Array.isArray(test.results) &&
            test.results.length > 0 &&
            test.results.every(result => result && result.status === 'passed')
          ) {
            proofs.add(browserProofKey({
              file: path.posix.basename(file),
              title: String(spec.title || ''),
              project: String(test.projectName || '')
            }));
          }
        }
      }
      visit(suite.suites, file);
    }
  };
  visit(report.suites);
  return proofs;
}

function deriveTrustedAutomatedClaims(options) {
  const catalog = qualificationCatalog(registry).automated;
  const requirements = options.requirements || AUTOMATED_CLAIM_REQUIREMENTS;
  if (
    !requirements || typeof requirements !== 'object' || Array.isArray(requirements) ||
    JSON.stringify(Object.keys(requirements).sort()) !== JSON.stringify([...catalog].sort())
  ) fail('automated claim requirements do not match the qualification catalog');
  const direct = options.directOutcomes || {};
  const matrixPasses = new Set(
    options.matrixReport.tests
      .filter(test => test && test.status === 'pass')
      .map(test => String(test.path || ''))
  );
  const browserPasses = browserProofInventory(options.browserReport);
  const claims = {};
  for (const key of catalog) {
    const requirement = requirements[key];
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      fail(`automated claim ${key} has no trusted requirement`);
    }
    const directKeys = requirement.direct || [];
    const matrixPaths = requirement.matrix || [];
    const browserProofs = requirement.browser || [];
    if (![directKeys, matrixPaths, browserProofs].every(Array.isArray) ||
        directKeys.length + matrixPaths.length + browserProofs.length === 0) {
      fail(`automated claim ${key} has an invalid trusted requirement`);
    }
    if (directKeys.some(outcome => direct[outcome] !== true)) {
      fail(`automated claim ${key} is missing a trusted runner outcome`);
    }
    if (matrixPaths.some(testPath => !matrixPasses.has(testPath))) {
      fail(`automated claim ${key} is missing an exact matrix proof`);
    }
    if (browserProofs.some(proof => !proof || !browserPasses.has(browserProofKey(proof)))) {
      fail(`automated claim ${key} is missing an exact browser proof`);
    }
    claims[`automated.${key}`] = {
      status: 'pass',
      cleanupVerified: true,
      completedAt: options.completedAt
    };
  }
  return Object.freeze(claims);
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
  const completedAt = options.completedAt || new Date().toISOString();
  const expectedClaims = qualificationCatalog(registry).automated.map(key => `automated.${key}`).sort();
  if (
    !options.claims || typeof options.claims !== 'object' || Array.isArray(options.claims) ||
    JSON.stringify(Object.keys(options.claims).sort()) !== JSON.stringify(expectedClaims) ||
    Object.values(options.claims).some(claim =>
      !claim || claim.status !== 'pass' || claim.cleanupVerified !== true || claim.completedAt !== completedAt
    )
  ) fail('automated evidence requires independently derived passing claims');
  const evidence = validateEvidenceEnvelope({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    artifactType: 'automated',
    subjectSha256: options.subjectSha256,
    sourceCommit: options.sourceCommit,
    originId: options.originId,
    completedAt,
    cleanupVerified: true,
    claims: options.claims,
    proof: {
      nodeVersion: process.version,
      deterministicArchives: true,
      freshExtractionCleanInstall: true,
      matrixReportCoreSha256: options.matrixReport.reportHash,
      matrixReportFileSha256: options.matrixReportFileSha256,
      browserReportFileSha256: options.browserReportFileSha256,
      trustedProgramsSha256: options.trustedProgramsSha256,
      claimRequirementsSha256: crypto.createHash('sha256')
        .update(stableJson(options.claimRequirements || AUTOMATED_CLAIM_REQUIREMENTS), 'utf8')
        .digest('hex'),
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
  const trustedRoot = path.resolve(options.trustedRoot || path.join(__dirname, '..'));
  const trustedProgramsSha256 = assertTrustedQualificationPrograms(
    candidateRoot,
    trustedRoot,
    options.trustedProgramPaths
  );
  const environment = buildQualificationEnvironment(
    options.env || process.env,
    parsed.extractDir,
    parsed.expectedSha256
  );
  const packageManagerEnvironment = buildPackageManagerEnvironment(
    options.env || process.env,
    environment
  );
  runCommand('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: candidateRoot,
    env: packageManagerEnvironment,
    label: 'candidate npm ci',
    timeoutMs: COMMAND_TIMEOUTS_MS.install
  });
  runCommand(process.execPath, ['scripts/copy-vendor.js'], {
    cwd: candidateRoot,
    env: environment,
    label: 'candidate reviewed vendor copy',
    timeoutMs: COMMAND_TIMEOUTS_MS.gate
  });
  if (options.useFixtureCommands === true) {
    runCommand('npm', ['run', 'check:syntax'], {
      cwd: candidateRoot,
      env: environment,
      label: 'fixture syntax gate',
      timeoutMs: COMMAND_TIMEOUTS_MS.gate
    });
  } else {
    for (const target of trustedSyntaxTargets(trustedRoot)) {
      runCommand(process.execPath, ['--check', target], {
        cwd: candidateRoot,
        env: environment,
        label: `trusted syntax gate ${target}`,
        timeoutMs: COMMAND_TIMEOUTS_MS.gate
      });
    }
  }
  const secretFindings = runSecretScan(candidateRoot);
  if (secretFindings.length) fail('trusted candidate secret gate found potential embedded material');
  /*
   * Both audits go through the trusted gate script. A bare `npm audit` cannot
   * distinguish a high advisory from a registry it could not reach, so an
   * outage would otherwise be recorded as a failed security finding. The
   * development mode returns only sanitized counts for qualification evidence.
   */
  runCommand(process.execPath, ['scripts/audit-production.js'], {
    cwd: candidateRoot,
    env: packageManagerEnvironment,
    label: 'candidate production audit',
    timeoutMs: COMMAND_TIMEOUTS_MS.gate
  });
  const developmentAudit = validateDevelopmentAudit(runCommand(process.execPath, [
    'scripts/audit-production.js',
    '--include-dev',
    '--json'
  ], {
    cwd: candidateRoot,
    env: packageManagerEnvironment,
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
  const browserEnvironment = {
    ...environment,
    PLAYWRIGHT_JSON_OUTPUT_FILE: parsed.browserReportPath,
    NV_STAGING_MATRIX_REPORT_PATH: parsed.reportPath
  };
  if (options.useFixtureCommands === true) {
    runCommand('npm', ['run', 'test:e2e:evidence'], {
      cwd: candidateRoot,
      env: browserEnvironment,
      label: 'fixture browser matrix',
      timeoutMs: COMMAND_TIMEOUTS_MS.browser
    });
  } else {
    runCommand(process.execPath, [
      path.join(candidateRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '--config', path.join(candidateRoot, 'playwright.config.js'),
      '--reporter=json'
    ], {
      cwd: candidateRoot,
      env: browserEnvironment,
      label: 'trusted browser matrix',
      timeoutMs: COMMAND_TIMEOUTS_MS.browser
    });
  }
  const browserReport = validateBrowserReport(
    parsed.browserReportPath,
    options.minimumBrowserTests == null ? MINIMUM_BROWSER_TESTS : options.minimumBrowserTests
  );
  if (hashFile(parsed.reportPath) !== matrixReportFileSha256) {
    fail('candidate browser matrix modified the program matrix report');
  }
  const browserReportFileSha256 = hashFile(parsed.browserReportPath);
  const completedAt = new Date().toISOString();
  const claimRequirements = options.claimRequirements || AUTOMATED_CLAIM_REQUIREMENTS;
  const claims = deriveTrustedAutomatedClaims({
    requirements: claimRequirements,
    directOutcomes: {
      nodePinned: true,
      cleanInstall: true,
      syntax: true,
      secretScan: true,
      deterministicArchives: true,
      freshExtraction: true,
      productionAudit: true,
      developmentAudit: true
    },
    matrixReport: report,
    browserReport,
    completedAt
  });
  writeAutomatedEvidence({
    subjectSha256: parsed.expectedSha256,
    sourceCommit: parsed.sourceCommit,
    originId: parsed.originId,
    evidencePath: parsed.evidencePath,
    matrixReport: report,
    matrixReportFileSha256,
    browserReport,
    browserReportFileSha256,
    developmentAudit,
    trustedProgramsSha256,
    claimRequirements,
    claims,
    completedAt
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
  DEFAULT_TRUSTED_PROGRAM_PATHS,
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
  AUTOMATED_CLAIM_REQUIREMENTS,
  assertTrustedQualificationPrograms,
  trustedSyntaxTargets,
  deriveTrustedAutomatedClaims,
  buildQualificationEnvironment,
  buildPackageManagerEnvironment,
  writeAutomatedEvidence,
  qualifyCandidateArchive
});
