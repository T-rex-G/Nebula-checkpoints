'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  assertPinnedNodeVersion,
  buildQualificationEnvironment,
  MINIMUM_MATRIX_TESTS,
  parseArgs,
  qualifyCandidateArchive,
  validateArchiveEntries
} = require('../scripts/qualify-candidate-archive');
const leakProbe = ['must-not', 'reach-candidate'].join('-');
const registry = require('../config/public-alpha-capabilities.json');
const { qualificationCatalog } = require('../src/public-alpha-qualification');
const { validateEvidenceEnvelope } = require('../src/qualification-evidence');

assert.doesNotThrow(() => assertPinnedNodeVersion('v22.23.1'));
assert.strictEqual(MINIMUM_MATRIX_TESTS, 141);
assert.throws(() => assertPinnedNodeVersion('v22.23.0'), /requires Node v22\.23\.1/);
const processVersionDescriptor = Object.getOwnPropertyDescriptor(process, 'version');
try {
  Object.defineProperty(process, 'version', { ...processVersionDescriptor, value: 'v22.23.0' });
  assert.throws(
    () => qualifyCandidateArchive(undefined),
    /requires Node v22\.23\.1/,
    'the runtime pin must fail before qualifier arguments or archive paths are read'
  );
} finally {
  Object.defineProperty(process, 'version', processVersionDescriptor);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeFixture(root, options = {}) {
  const candidate = path.join(root, 'candidate-fixture');
  fs.mkdirSync(path.join(candidate, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'package.json'), `${JSON.stringify({
    name: 'candidate-fixture',
    version: '1.0.0',
    private: true,
    scripts: {
      postinstall: 'node scripts/forbidden-postinstall.js',
      'check:syntax': 'node -e "process.exit(0)"',
      'check:secrets': 'node -e "process.exit(0)"',
      'test:e2e:evidence': 'node scripts/fake-browser.js'
    }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(candidate, 'package-lock.json'), `${JSON.stringify({
    name: 'candidate-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'candidate-fixture', version: '1.0.0' }
    }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(candidate, 'scripts', 'test-matrix.js'), `'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const reportIndex = args.indexOf('--report');
if (!args.includes('--require-all') || !args.includes('--require-subject') || reportIndex < 0) process.exit(9);
const reportPath = path.resolve(args[reportIndex + 1]);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  schemaVersion: '1.0.0',
  subjectHash: process.env.NV_STAGING_SUBJECT_SHA256,
  nodeVersion: process.version,
  counts: { total: 1, passed: 1, blocked: 0, failed: 0 },
  tests: [{ path: 'test/from-archive.test.js', status: 'pass' }],
  observedEnvironment: {
    cwd: process.cwd(),
    home: process.env.HOME,
    ignoreScripts: process.env.NPM_CONFIG_IGNORE_SCRIPTS,
    leakedToken: process.env.GITHUB_TOKEN || process.env.NPM_TOKEN || process.env.NV_FAKE_SECRET || null,
    nodeOptions: process.env.NODE_OPTIONS || null
  },
  reportHash: 'a'.repeat(64)
}) + '\\n');
`);
  fs.writeFileSync(path.join(candidate, 'scripts', 'fake-browser.js'), `'use strict';
const fs = require('fs');
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
  stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
  errors: []
}) + '\\n');
if (fs.existsSync(require('path').join(__dirname, 'tamper-matrix'))) {
  fs.appendFileSync(process.env.NV_STAGING_MATRIX_REPORT_PATH, ' ');
}
`);
  fs.writeFileSync(path.join(candidate, 'scripts', 'copy-vendor.js'), `'use strict';
require('fs').writeFileSync(require('path').join(__dirname, '..', 'vendor-copy.marker'), 'copied\\n');
`);
  fs.writeFileSync(path.join(candidate, 'scripts', 'forbidden-postinstall.js'), `'use strict';
require('fs').writeFileSync(require('path').join(__dirname, '..', 'lifecycle.marker'), 'ran\\n');
`);
  if (options.tamperMatrix) fs.writeFileSync(path.join(candidate, 'scripts', 'tamper-matrix'), 'enabled\n');
  return candidate;
}

assert.deepStrictEqual(parseArgs([
  '--archive', '/tmp/a.zip',
  '--comparison-archive', '/tmp/b.zip',
  '--sha256', 'a'.repeat(64),
  '--extract-dir', '/tmp/subject',
  '--report', '/tmp/report.json',
  '--browser-report', '/tmp/browser.json',
  '--evidence', '/tmp/automated.json',
  '--source-commit', 'b'.repeat(40),
  '--origin-id', 'workflow-2048-automated'
]), {
  archivePath: '/tmp/a.zip',
  comparisonArchivePath: '/tmp/b.zip',
  expectedSha256: 'a'.repeat(64),
  extractDir: '/tmp/subject',
  reportPath: '/tmp/report.json',
  browserReportPath: '/tmp/browser.json',
  evidencePath: '/tmp/automated.json',
  sourceCommit: 'b'.repeat(40),
  originId: 'workflow-2048-automated'
});
assert.throws(
  () => parseArgs([
    '--archive', 'relative.zip',
    '--comparison-archive', '/tmp/b.zip',
    '--sha256', 'a'.repeat(64),
    '--extract-dir', '/tmp/subject',
    '--report', '/tmp/report.json',
    '--browser-report', '/tmp/browser.json',
    '--evidence', '/tmp/automated.json',
    '--source-commit', 'b'.repeat(40),
    '--origin-id', 'workflow-2048-automated'
  ]),
  /absolute/
);
assert.deepStrictEqual(
  validateArchiveEntries([
    'candidate/',
    'candidate/package.json',
    'candidate/scripts/test-matrix.js',
    'candidate/scripts/copy-vendor.js'
  ]),
  { rootName: 'candidate' }
);
for (const entries of [
  ['../escape'],
  ['/absolute/file'],
  ['candidate\\windows-path'],
  ['candidate/package.json', 'other/package.json'],
  ['candidate/link -> /tmp/target'],
  ['candidate/', 'candidate/package.json', 'candidate/scripts/test-matrix.js']
]) {
  assert.throws(() => validateArchiveEntries(entries), /archive/i);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-candidate-runner-'));
try {
  const fixtureParent = path.join(temporaryRoot, 'source');
  fs.mkdirSync(fixtureParent);
  writeFixture(fixtureParent);
  const archivePath = path.join(temporaryRoot, 'candidate-a.zip');
  const comparisonArchivePath = path.join(temporaryRoot, 'candidate-b.zip');
  execFileSync('zip', ['-q', '-X', '-r', archivePath, 'candidate-fixture'], { cwd: fixtureParent });
  fs.copyFileSync(archivePath, comparisonArchivePath);
  const zeroReadProbe = spawnSync(process.execPath, [
    '-e',
    `'use strict';
const fs = require('fs');
const { filesEqual } = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'qualify-candidate-archive.js'))});
fs.readSync = () => 0;
try {
  filesEqual(process.argv[1], process.argv[2]);
  process.stderr.write('comparison accepted an incomplete read\\n');
  process.exit(3);
} catch (error) {
  if (!/changed|short read|incomplete read/i.test(error.message)) {
    process.stderr.write(error.message + '\\n');
    process.exit(4);
  }
}`,
    archivePath,
    comparisonArchivePath
  ], { encoding: 'utf8', timeout: 1000 });
  assert.strictEqual(
    zeroReadProbe.status,
    0,
    zeroReadProbe.error?.message || zeroReadProbe.stderr || 'archive comparison hung on an incomplete read'
  );
  const expectedSha256 = sha256(archivePath);
  const extractDir = path.join(temporaryRoot, 'extracted');
  const reportPath = path.join(temporaryRoot, 'evidence', 'matrix.json');
  const browserReportPath = path.join(temporaryRoot, 'evidence', 'browser.json');
  const evidencePath = path.join(temporaryRoot, 'evidence', 'automated.json');

  const result = qualifyCandidateArchive({
    archivePath,
    comparisonArchivePath,
    expectedSha256,
    extractDir,
    reportPath,
    browserReportPath,
    evidencePath,
    sourceCommit: 'b'.repeat(40),
    originId: 'workflow-2048-automated',
    minimumMatrixTests: 1,
    minimumBrowserTests: 2,
    env: {
      ...process.env,
      GITHUB_TOKEN: leakProbe,
      NPM_TOKEN: leakProbe,
      NV_FAKE_SECRET: leakProbe,
      NODE_OPTIONS: '--require=/must/not/load.js'
    }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.subjectSha256, expectedSha256);
  assert.strictEqual(result.candidateRoot, path.join(extractDir, 'candidate-fixture'));
  assert.strictEqual(fs.existsSync(path.join(result.candidateRoot, 'vendor-copy.marker')), true);
  assert.strictEqual(fs.existsSync(path.join(result.candidateRoot, 'lifecycle.marker')), false);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.strictEqual(report.subjectHash, expectedSha256);
  assert.deepStrictEqual(report.counts, { total: 1, passed: 1, blocked: 0, failed: 0 });
  assert.strictEqual(report.observedEnvironment.cwd, result.candidateRoot);
  assert(report.observedEnvironment.home.startsWith(extractDir));
  assert.strictEqual(report.observedEnvironment.ignoreScripts, 'true');
  assert.strictEqual(report.observedEnvironment.leakedToken, null);
  assert.strictEqual(report.observedEnvironment.nodeOptions, null);
  const automatedEvidence = validateEvidenceEnvelope(JSON.parse(fs.readFileSync(evidencePath, 'utf8')));
  assert.strictEqual(automatedEvidence.artifactType, 'automated');
  assert.strictEqual(automatedEvidence.subjectSha256, expectedSha256);
  assert.strictEqual(automatedEvidence.sourceCommit, 'b'.repeat(40));
  assert.strictEqual(automatedEvidence.originId, 'workflow-2048-automated');
  assert.deepStrictEqual(
    Object.keys(automatedEvidence.claims).sort(),
    qualificationCatalog(registry).automated.map(key => `automated.${key}`).sort()
  );
  assert.strictEqual(automatedEvidence.proof.matrixTests, 1);
  assert.strictEqual(automatedEvidence.proof.browserTests, 2);
  assert.strictEqual(automatedEvidence.proof.matrixReportCoreSha256, report.reportHash);
  assert.strictEqual(automatedEvidence.proof.matrixReportFileSha256, sha256(reportPath));
  assert.strictEqual(automatedEvidence.proof.browserReportFileSha256, sha256(browserReportPath));
  assert.strictEqual(Object.hasOwn(automatedEvidence.proof, 'matrixReportSha256'), false);

  const rejectedExtractDir = path.join(temporaryRoot, 'wrong-hash-extract');
  assert.throws(
    () => qualifyCandidateArchive({
      archivePath,
      comparisonArchivePath,
      expectedSha256: 'f'.repeat(64),
      extractDir: rejectedExtractDir,
      reportPath: path.join(temporaryRoot, 'wrong-hash.json'),
      browserReportPath: path.join(temporaryRoot, 'wrong-hash-browser.json'),
      evidencePath: path.join(temporaryRoot, 'wrong-hash-evidence.json'),
      sourceCommit: 'b'.repeat(40),
      originId: 'workflow-2048-automated',
      minimumMatrixTests: 1,
      minimumBrowserTests: 2,
      env: { ...process.env, GITHUB_TOKEN: leakProbe }
    }),
    /SHA-256/i
  );
  assert.strictEqual(fs.existsSync(rejectedExtractDir), false);

  const tamperedFixtureParent = path.join(temporaryRoot, 'tampered-source');
  fs.mkdirSync(tamperedFixtureParent);
  writeFixture(tamperedFixtureParent, { tamperMatrix: true });
  const tamperedArchivePath = path.join(temporaryRoot, 'tampered-a.zip');
  const tamperedComparisonPath = path.join(temporaryRoot, 'tampered-b.zip');
  execFileSync('zip', ['-q', '-X', '-r', tamperedArchivePath, 'candidate-fixture'], {
    cwd: tamperedFixtureParent
  });
  fs.copyFileSync(tamperedArchivePath, tamperedComparisonPath);
  const tamperedReportPath = path.join(temporaryRoot, 'tampered-matrix.json');
  assert.throws(
    () => qualifyCandidateArchive({
      archivePath: tamperedArchivePath,
      comparisonArchivePath: tamperedComparisonPath,
      expectedSha256: sha256(tamperedArchivePath),
      extractDir: path.join(temporaryRoot, 'tampered-extract'),
      reportPath: tamperedReportPath,
      browserReportPath: path.join(temporaryRoot, 'tampered-browser.json'),
      evidencePath: path.join(temporaryRoot, 'tampered-evidence.json'),
      sourceCommit: 'b'.repeat(40),
      originId: 'workflow-2048-automated',
      minimumMatrixTests: 1,
      minimumBrowserTests: 2,
      env: { ...process.env, NV_FAKE_SECRET: leakProbe }
    }),
    /modified the program matrix report/
  );
  assert.strictEqual(fs.existsSync(path.join(temporaryRoot, 'tampered-evidence.json')), false);

  fs.appendFileSync(comparisonArchivePath, 'different');
  assert.throws(
    () => qualifyCandidateArchive({
      archivePath,
      comparisonArchivePath,
      expectedSha256,
      extractDir: path.join(temporaryRoot, 'mismatch-extract'),
      reportPath: path.join(temporaryRoot, 'mismatch.json'),
      browserReportPath: path.join(temporaryRoot, 'mismatch-browser.json'),
      evidencePath: path.join(temporaryRoot, 'mismatch-evidence.json'),
      sourceCommit: 'b'.repeat(40),
      originId: 'workflow-2048-automated',
      minimumMatrixTests: 1,
      minimumBrowserTests: 2,
      env: process.env
    }),
    /deterministic/i
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

{
  const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-qualifier-env-'));
  try {
    const environment = buildQualificationEnvironment({
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      GITHUB_TOKEN: 'hidden',
      DATABASE_URL: 'hidden',
      NODE_OPTIONS: '--require=/hidden.js',
      NPM_CONFIG_USERCONFIG: '/hidden/.npmrc'
    }, environmentRoot, 'a'.repeat(64));
    assert.strictEqual(environment.LANG, 'C.UTF-8');
    assert.strictEqual(environment.NV_STAGING_SUBJECT_SHA256, 'a'.repeat(64));
    assert.strictEqual(environment.NPM_CONFIG_IGNORE_SCRIPTS, 'true');
    for (const key of ['GITHUB_TOKEN', 'DATABASE_URL', 'NODE_OPTIONS']) {
      assert.strictEqual(Object.hasOwn(environment, key), false, `${key} must be removed`);
    }
    assert.notStrictEqual(environment.NPM_CONFIG_USERCONFIG, '/hidden/.npmrc');
    assert(environment.HOME.startsWith(environmentRoot));
  } finally {
    fs.rmSync(environmentRoot, { recursive: true, force: true });
  }
}

console.log('candidate archive qualification tests passed');
