'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  parseArgs,
  qualifyCandidateArchive,
  validateArchiveEntries
} = require('../scripts/qualify-candidate-archive');
const registry = require('../config/public-alpha-capabilities.json');
const { qualificationCatalog } = require('../src/public-alpha-qualification');
const { validateEvidenceEnvelope } = require('../src/qualification-evidence');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeFixture(root) {
  const candidate = path.join(root, 'candidate-fixture');
  fs.mkdirSync(path.join(candidate, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'package.json'), `${JSON.stringify({
    name: 'candidate-fixture',
    version: '1.0.0',
    private: true,
    scripts: {
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
fs.writeFileSync(process.env.NV_TEST_CWD_MARKER, process.cwd() + '\\n');
const reportPath = path.resolve(args[reportIndex + 1]);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  schemaVersion: '1.0.0',
  subjectHash: process.env.NV_STAGING_SUBJECT_SHA256,
  nodeVersion: process.version,
  counts: { total: 1, passed: 1, blocked: 0, failed: 0 },
  tests: [{ path: 'test/from-archive.test.js', status: 'pass' }],
  reportHash: 'a'.repeat(64)
}) + '\\n');
`);
  fs.writeFileSync(path.join(candidate, 'scripts', 'fake-browser.js'), `'use strict';
const fs = require('fs');
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
  stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
  errors: []
}) + '\\n');
if (process.env.NV_TEST_TAMPER_MATRIX_REPORT) {
  fs.appendFileSync(process.env.NV_TEST_TAMPER_MATRIX_REPORT, ' ');
}
`);
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
  validateArchiveEntries(['candidate/', 'candidate/package.json', 'candidate/scripts/test-matrix.js']),
  { rootName: 'candidate' }
);
for (const entries of [
  ['../escape'],
  ['/absolute/file'],
  ['candidate\\windows-path'],
  ['candidate/package.json', 'other/package.json'],
  ['candidate/link -> /tmp/target']
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
  const markerPath = path.join(temporaryRoot, 'candidate-cwd.txt');
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
    env: { ...process.env, NV_TEST_CWD_MARKER: markerPath }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.subjectSha256, expectedSha256);
  assert.strictEqual(result.candidateRoot, path.join(extractDir, 'candidate-fixture'));
  assert.strictEqual(fs.readFileSync(markerPath, 'utf8').trim(), result.candidateRoot);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.strictEqual(report.subjectHash, expectedSha256);
  assert.deepStrictEqual(report.counts, { total: 1, passed: 1, blocked: 0, failed: 0 });
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
      env: { ...process.env, NV_TEST_CWD_MARKER: path.join(temporaryRoot, 'must-not-exist') }
    }),
    /SHA-256/i
  );
  assert.strictEqual(fs.existsSync(rejectedExtractDir), false);
  assert.strictEqual(fs.existsSync(path.join(temporaryRoot, 'must-not-exist')), false);

  const tamperedReportPath = path.join(temporaryRoot, 'tampered-matrix.json');
  assert.throws(
    () => qualifyCandidateArchive({
      archivePath,
      comparisonArchivePath,
      expectedSha256,
      extractDir: path.join(temporaryRoot, 'tampered-extract'),
      reportPath: tamperedReportPath,
      browserReportPath: path.join(temporaryRoot, 'tampered-browser.json'),
      evidencePath: path.join(temporaryRoot, 'tampered-evidence.json'),
      sourceCommit: 'b'.repeat(40),
      originId: 'workflow-2048-automated',
      minimumMatrixTests: 1,
      minimumBrowserTests: 2,
      env: {
        ...process.env,
        NV_TEST_CWD_MARKER: path.join(temporaryRoot, 'tampered-cwd.txt'),
        NV_TEST_TAMPER_MATRIX_REPORT: tamperedReportPath
      }
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

console.log('candidate archive qualification tests passed');
