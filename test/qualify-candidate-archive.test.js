'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  assertPinnedNodeVersion,
  assertTrustedQualificationPrograms,
  AUTOMATED_CLAIM_REQUIREMENTS,
  buildPackageManagerEnvironment,
  buildQualificationEnvironment,
  deriveTrustedAutomatedClaims,
  MINIMUM_MATRIX_TESTS,
  parseArgs,
  qualifyCandidateArchive,
  runCommand,
  validateArchiveEntries,
  validateBrowserReport,
  validateMatrixReport
} = require('../scripts/qualify-candidate-archive');
const leakProbe = ['must-not', 'reach-candidate'].join('-');
const registry = require('../config/public-alpha-capabilities.json');
const { qualificationCatalog } = require('../src/public-alpha-qualification');
const { validateEvidenceEnvelope } = require('../src/qualification-evidence');
const repositoryRoot = path.join(__dirname, '..');

assert.doesNotThrow(() => assertPinnedNodeVersion('v22.23.1'));
assert.strictEqual(MINIMUM_MATRIX_TESTS, 141);
assert.throws(() => assertPinnedNodeVersion('v22.23.0'), /requires Node v22\.23\.1/);
assert.throws(
  () => runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    label: 'synthetic stalled qualifier command',
    timeoutMs: 50
  }),
  /synthetic stalled qualifier command timed out after 50 ms/,
  'every qualifier child process must have an explicit finite timeout'
);
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

function passingBrowserReport(count = 2) {
  return {
    stats: { expected: count, skipped: 0, unexpected: 0, flaky: 0 },
    errors: [],
    suites: [{
      title: 'fixture suite',
      specs: Array.from({ length: count }, (_, index) => ({
        title: `fixture browser test ${index + 1}`,
        ok: true,
        tests: [{
          expectedStatus: 'passed',
          status: 'expected',
          results: [{ status: 'passed' }]
        }]
      }))
    }]
  };
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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const args = process.argv.slice(2);
const reportIndex = args.indexOf('--report');
if (!args.includes('--require-all') || !args.includes('--require-subject') || reportIndex < 0) process.exit(9);
const reportPath = path.resolve(args[reportIndex + 1]);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const reportCore = {
  schemaVersion: '1.0.0',
  mode: 'require-all',
  subjectHash: process.env.NV_STAGING_SUBJECT_SHA256,
  nodeVersion: process.version,
  platform: process.platform + '-' + process.arch,
  counts: { total: 1, passed: 1, blocked: 0, failed: 0 },
  tests: [{ path: 'test/from-archive.test.js', status: 'pass' }]
};
fs.writeFileSync(reportPath, JSON.stringify({
  ...reportCore,
  generatedAt: new Date().toISOString(),
  observedEnvironment: {
    cwd: process.cwd(),
    home: process.env.HOME,
    ignoreScripts: process.env.NPM_CONFIG_IGNORE_SCRIPTS,
    leakedToken: process.env.GITHUB_TOKEN || process.env.NPM_TOKEN || process.env.NV_FAKE_SECRET || null,
    nodeOptions: process.env.NODE_OPTIONS || null
  },
  reportHash: ${options.forgeReportHash
    ? "'f'.repeat(64)"
    : "crypto.createHash('sha256').update(stableJson(reportCore)).digest('hex')"}
}) + '\\n');
`);
  fs.writeFileSync(path.join(candidate, 'scripts', 'fake-browser.js'), `'use strict';
const fs = require('fs');
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
  stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
  errors: [],
  suites: [{
    title: 'fixture suite',
    specs: [1, 2].map(index => ({
      title: 'fixture browser test ' + index,
      ok: true,
      tests: [{
        expectedStatus: 'passed',
        status: 'expected',
        results: [{ status: 'passed' }]
      }]
    }))
  }]
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

const fixtureTrustedProgramPaths = Object.freeze([
  'package.json',
  'package-lock.json',
  'scripts/test-matrix.js',
  'scripts/fake-browser.js',
  'scripts/copy-vendor.js'
]);

function fixtureClaimRequirements() {
  return Object.fromEntries(
    qualificationCatalog(registry).automated.map(key => [key, { direct: ['cleanInstall'] }])
  );
}

{
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-trusted-programs-'));
  const candidateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-candidate-programs-'));
  const requiredFiles = [
    'package.json',
    'package-lock.json',
    'playwright.config.js',
    'scripts/test-matrix.js',
    'scripts/copy-vendor.js',
    'scripts/check-secrets.js',
    'src/test-matrix.js',
    'src/governance-model.js',
    'test/example.test.js'
  ];
  try {
    for (const relativePath of requiredFiles) {
      const contents = `'use strict'; // ${relativePath}\n`;
      for (const root of [trustedRoot, candidateRoot]) {
        const absolutePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, contents);
      }
    }
    assert.doesNotThrow(() => assertTrustedQualificationPrograms(candidateRoot, trustedRoot));
    assert.throws(
      () => assertTrustedQualificationPrograms(candidateRoot, trustedRoot, ['/etc/passwd']),
      /trusted qualification program path is invalid/,
      'the trusted-program inventory must remain relative to the reviewed checkout'
    );
    fs.appendFileSync(path.join(candidateRoot, 'src', 'test-matrix.js'), '// forged pass\n');
    assert.throws(
      () => assertTrustedQualificationPrograms(candidateRoot, trustedRoot),
      /does not match trusted source: src\/test-matrix\.js/,
      'the candidate must not replace the matrix implementation behind the trusted launcher'
    );
    fs.copyFileSync(
      path.join(trustedRoot, 'src', 'test-matrix.js'),
      path.join(candidateRoot, 'src', 'test-matrix.js')
    );
    fs.appendFileSync(path.join(candidateRoot, 'src', 'governance-model.js'), '// forged hash\n');
    assert.throws(
      () => assertTrustedQualificationPrograms(candidateRoot, trustedRoot),
      /does not match trusted source: src\/governance-model\.js/,
      'the candidate must not replace the matrix report canonicalizer'
    );
  } finally {
    fs.rmSync(trustedRoot, { recursive: true, force: true });
    fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
}

{
  const matrixPaths = [...new Set(Object.values(AUTOMATED_CLAIM_REQUIREMENTS)
    .flatMap(requirement => requirement.matrix || []))];
  const browserProofs = Object.values(AUTOMATED_CLAIM_REQUIREMENTS)
    .flatMap(requirement => requirement.browser || []);
  for (const matrixPath of matrixPaths) {
    const resolvedMatrixPath = path.join(repositoryRoot, matrixPath);
    assert(fs.existsSync(resolvedMatrixPath) && fs.lstatSync(resolvedMatrixPath).isFile(),
      `automated matrix proof must name a repository file: ${matrixPath}`);
  }
  const playwrightList = JSON.parse(execFileSync(
    process.execPath,
    [require.resolve('@playwright/test/cli'), 'test', '--list', '--reporter=json'],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60 * 1000 }
  ));
  const listedBrowserProofs = new Set();
  const collectListedBrowserProofs = (suites, inheritedFile = '') => {
    for (const suite of suites || []) {
      const file = path.posix.basename(String(suite.file || inheritedFile || '').replaceAll('\\', '/'));
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          listedBrowserProofs.add(`${file}\u0000${String(spec.title || '')}\u0000${String(test.projectName || '')}`);
        }
      }
      collectListedBrowserProofs(suite.suites, file);
    }
  };
  collectListedBrowserProofs(playwrightList.suites);
  for (const proof of browserProofs) {
    const browserPath = path.join(repositoryRoot, 'test', 'e2e', proof.file);
    assert(fs.existsSync(browserPath) && fs.lstatSync(browserPath).isFile(),
      `automated browser proof must name a repository spec: ${proof.file}`);
    assert(listedBrowserProofs.has(`${proof.file}\u0000${proof.title}\u0000${proof.project}`),
      `automated browser proof must match Playwright's exact file, title, and project: ${JSON.stringify(proof)}`);
  }
  const directOutcomes = Object.fromEntries(
    [...new Set(Object.values(AUTOMATED_CLAIM_REQUIREMENTS)
      .flatMap(requirement => requirement.direct || []))].map(key => [key, true])
  );
  const matrixReport = { tests: matrixPaths.map(testPath => ({ path: testPath, status: 'pass' })) };
  const browserReport = {
    suites: browserProofs.map(proof => ({
      file: proof.file,
      specs: [{
        title: proof.title,
        ok: true,
        tests: [{
          projectName: proof.project,
          expectedStatus: 'passed',
          status: 'expected',
          results: [{ status: 'passed' }]
        }]
      }]
    }))
  };
  const completedAt = '2026-08-13T00:00:00.000Z';
  const claims = deriveTrustedAutomatedClaims({
    directOutcomes,
    matrixReport,
    browserReport,
    completedAt
  });
  assert.deepStrictEqual(
    Object.keys(claims).sort(),
    qualificationCatalog(registry).automated.map(key => `automated.${key}`).sort()
  );
  assert.throws(
    () => deriveTrustedAutomatedClaims({
      directOutcomes,
      matrixReport: {
        tests: matrixReport.tests.filter(test => test.path !== 'test/alpha-repository-boundary.test.js')
      },
      browserReport,
      completedAt
    }),
    /repository-allowlist is missing an exact matrix proof/,
    'a passing aggregate report must not imply a missing claim-specific proof'
  );
  assert.throws(
    () => deriveTrustedAutomatedClaims({
      directOutcomes: { ...directOutcomes, syntax: false },
      matrixReport,
      browserReport,
      completedAt
    }),
    /syntax is missing a trusted runner outcome/,
    'a candidate cannot blanket-pass a failed trusted runner outcome'
  );
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
assert.throws(
  () => parseArgs([
    '--archive', '/tmp/a.zip',
    '--comparison-archive', '/tmp/b.zip',
    '--sha256', 'a'.repeat(64),
    '--extract-dir', '/tmp/subject',
    '--report', '/tmp/report.json',
    '--browser-report', '/tmp/browser.json',
    '--evidence', '/tmp/automated.json',
    '--source-commit', 'b'.repeat(40),
    '--origin-id'
  ]),
  /arguments are invalid/,
  'a trailing --origin-id must not become the literal string undefined'
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
  const validBrowserReportPath = path.join(temporaryRoot, 'valid-browser-report.json');
  fs.writeFileSync(validBrowserReportPath, `${JSON.stringify(passingBrowserReport())}\n`);
  assert.doesNotThrow(() => validateBrowserReport(validBrowserReportPath, 2));
  for (const [name, mutate] of [
    ['expected failure', report => { report.suites[0].specs[0].tests[0].expectedStatus = 'failed'; }],
    ['skipped result', report => { report.suites[0].specs[0].tests[0].results[0].status = 'skipped'; }],
    ['flaky run', report => { report.stats.flaky = 1; }],
    ['skipped run', report => { report.stats.skipped = 1; }],
    ['failed spec', report => { report.suites[0].specs[0].ok = false; }]
  ]) {
    const report = passingBrowserReport();
    mutate(report);
    const rejectedPath = path.join(temporaryRoot, `${name.replace(/\s+/g, '-')}.json`);
    fs.writeFileSync(rejectedPath, `${JSON.stringify(report)}\n`);
    assert.throws(
      () => validateBrowserReport(rejectedPath, 2),
      /failed or incomplete run/i,
      `${name} must not qualify as passing browser evidence`
    );
  }

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
    trustedRoot: path.join(fixtureParent, 'candidate-fixture'),
    trustedProgramPaths: fixtureTrustedProgramPaths,
    claimRequirements: fixtureClaimRequirements(),
    useFixtureCommands: true,
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
  const forgedReportPath = path.join(temporaryRoot, 'evidence', 'forged-matrix.json');
  fs.writeFileSync(forgedReportPath, `${JSON.stringify({ ...report, reportHash: 'f'.repeat(64) })}\n`);
  assert.throws(
    () => validateMatrixReport(forgedReportPath, expectedSha256, 1),
    /does not prove the exact subject/,
    'a syntactically valid but forged matrix core hash must be rejected'
  );
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
      trustedRoot: path.join(tamperedFixtureParent, 'candidate-fixture'),
      trustedProgramPaths: fixtureTrustedProgramPaths,
      claimRequirements: fixtureClaimRequirements(),
      useFixtureCommands: true,
      env: { ...process.env, NV_FAKE_SECRET: leakProbe }
    }),
    /modified the program matrix report/
  );
  assert.strictEqual(fs.existsSync(path.join(temporaryRoot, 'tampered-evidence.json')), false);

  const forgedFixtureParent = path.join(temporaryRoot, 'forged-report-source');
  fs.mkdirSync(forgedFixtureParent);
  writeFixture(forgedFixtureParent, { forgeReportHash: true });
  const forgedArchivePath = path.join(temporaryRoot, 'forged-report-a.zip');
  const forgedComparisonPath = path.join(temporaryRoot, 'forged-report-b.zip');
  execFileSync('zip', ['-q', '-X', '-r', forgedArchivePath, 'candidate-fixture'], {
    cwd: forgedFixtureParent
  });
  fs.copyFileSync(forgedArchivePath, forgedComparisonPath);
  const forgedEvidencePath = path.join(temporaryRoot, 'forged-report-evidence.json');
  assert.throws(
    () => qualifyCandidateArchive({
      archivePath: forgedArchivePath,
      comparisonArchivePath: forgedComparisonPath,
      expectedSha256: sha256(forgedArchivePath),
      extractDir: path.join(temporaryRoot, 'forged-report-extract'),
      reportPath: path.join(temporaryRoot, 'forged-report-matrix.json'),
      browserReportPath: path.join(temporaryRoot, 'forged-report-browser.json'),
      evidencePath: forgedEvidencePath,
      sourceCommit: 'b'.repeat(40),
      originId: 'workflow-2048-automated',
      minimumMatrixTests: 1,
      minimumBrowserTests: 2,
      trustedRoot: path.join(forgedFixtureParent, 'candidate-fixture'),
      trustedProgramPaths: fixtureTrustedProgramPaths,
      claimRequirements: fixtureClaimRequirements(),
      useFixtureCommands: true,
      env: process.env
    }),
    /does not prove the exact subject/,
    'the full qualifier must reject a candidate-authored forged matrix reportHash'
  );
  assert.strictEqual(fs.existsSync(forgedEvidencePath), false);

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

    /*
     * The candidate's suite applies the migrations to a real server, so a
     * loopback test database is passed through -- otherwise that program
     * refuses and the candidate matrix reports a failure it cannot fix.
     *
     * It is the only allowlisted variable that can name something outside the
     * runner, so it is the only one whose value is checked. A variable of this
     * name pointing at a real database must stop the qualification rather than
     * hand candidate code a live connection string.
     */
    const withDatabase = buildQualificationEnvironment({
      PATH: process.env.PATH,
      NV_TEST_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres'
    }, environmentRoot, 'a'.repeat(64));
    assert.strictEqual(
      withDatabase.NV_TEST_DATABASE_URL,
      'postgresql://postgres:postgres@localhost:5432/postgres',
      'the candidate matrix needs the loopback database its migration program looks for'
    );
    for (const elsewhere of [
      'postgresql://user:secret@db.example.com:5432/production',
      'postgresql://user:secret@10.0.0.5:5432/postgres'
    ]) {
      assert.throws(
        () => buildQualificationEnvironment(
          { PATH: process.env.PATH, NV_TEST_DATABASE_URL: elsewhere },
          environmentRoot,
          'a'.repeat(64)
        ),
        /loopback test server/,
        `a database at ${elsewhere} must never reach candidate code`
      );
    }
    const packageManagerEnvironment = buildPackageManagerEnvironment({
      HTTP_PROXY: 'http://127.0.0.1:3128/',
      HTTPS_PROXY: 'https://proxy.example.test',
      NO_PROXY: 'localhost,127.0.0.1'
    }, environment);
    assert.strictEqual(Object.hasOwn(environment, 'HTTP_PROXY'), false,
      'candidate programs must not inherit the package-manager proxy');
    assert.strictEqual(packageManagerEnvironment.HTTP_PROXY, 'http://127.0.0.1:3128');
    assert.strictEqual(packageManagerEnvironment.HTTPS_PROXY, 'https://proxy.example.test');
    assert.strictEqual(packageManagerEnvironment.NO_PROXY, 'localhost,127.0.0.1');
    assert.throws(
      () => buildPackageManagerEnvironment({
        HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example.test'
      }, environment),
      /credential-free HTTP\(S\) origin/,
      'proxy credentials must never cross into candidate package-manager execution'
    );
  } finally {
    fs.rmSync(environmentRoot, { recursive: true, force: true });
  }
}

console.log('candidate archive qualification tests passed');
