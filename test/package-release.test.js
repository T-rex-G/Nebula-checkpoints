'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createZipArchive, discoverReleaseManifest } = require('../scripts/package-release');
const { checks: foundationChecks } = require('../scripts/foundation-gate');
const root = path.resolve(__dirname, '..');
const packageScript = path.join(root, 'scripts', 'package-release.js');
function ensureLocalManifestRepository() {
  const current = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (
    current.status === 0 &&
    fs.realpathSync(String(current.stdout).trim()) === fs.realpathSync(root)
  ) return false;
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(initialized.status, 0, initialized.stderr || initialized.stdout);
  const staged = spawnSync('git', ['add', '--all'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(staged.status, 0, staged.stderr || staged.stdout);
  return true;
}
const temporaryManifestRepository = ensureLocalManifestRepository();
const quarantineRoot = fs.mkdtempSync(path.join(path.dirname(root), 'nvx-package-test-quarantine-'));
function cleanupRuntimeState() {
  if (fs.existsSync(quarantineRoot)) fs.rmSync(quarantineRoot, { recursive: true, force: true });
  if (temporaryManifestRepository && fs.existsSync(path.join(root, '.git'))) {
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  }
}
process.once('exit', cleanupRuntimeState);
let quarantineSequence = 0;
const foundationArtifacts = [
  'PUBLIC_ALPHA_PROVENANCE.json', 'config/public-alpha-capabilities.json', 'src/capability-registry.js',
  'docs/current/ROADMAP.md', 'docs/vision/PRODUCT_VISION.md',
  'docs/current/PROVIDER_CAPABILITIES.md', 'docs/architecture/ARCHITECTURE.md',
  'docs/release/RELEASE_SECURITY_GATES.md', 'docs/release/PUBLIC_ALPHA.md',
  'docs/vision/UX_VISION.md', 'docs/release/EVIDENCE_INDEX.md',
  'test/public-alpha-provenance.test.js', 'test/capability-registry.test.js',
  'test/capability-registry-server-contract.test.js', 'test/provider-route-inventory.test.js',
  'test/public-alpha-documentation.test.js'
];
assert.deepStrictEqual(foundationChecks, [
  'scripts/verify.js',
  'test/public-alpha-provenance.test.js',
  'test/capability-registry.test.js',
  'test/capability-registry-server-contract.test.js',
  'test/provider-route-inventory.test.js',
  'test/public-alpha-documentation.test.js'
]);

function runPackager(output, options = {}) {
  return spawnSync(process.execPath, [packageScript, output], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) }
  });
}

function zipMembers(zip) {
  const result = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split('\n').filter(Boolean);
}

function assertZipIntegrity(zip) {
  const result = spawnSync('unzip', ['-t', zip], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /No errors detected/);
}

function quarantineTestPath(target, label) {
  if (!fs.existsSync(target)) return;
  quarantineSequence += 1;
  fs.renameSync(target, path.join(quarantineRoot, `${quarantineSequence}-${label}`));
}

function withArtifact(file, value, callback) {
  const target = path.join(root, file);
  const original = fs.readFileSync(target);
  try {
    if (value === null) fs.rmSync(target);
    else fs.writeFileSync(target, value);
    callback();
  } finally {
    fs.writeFileSync(target, original);
  }
}

function withIgnoredSentinels(callback) {
  const sentinels = [
    ['.env.production', 'synthetic ignored environment sentinel\n'],
    ['.superpowers/sdd/release-containment-sentinel.txt', 'synthetic internal-state sentinel\n'],
    ['.cache/release-containment-sentinel.txt', 'synthetic tool-cache sentinel\n']
  ];
  const cacheDirectory = path.join(root, '.cache');
  const cacheExisted = fs.existsSync(cacheDirectory);
  try {
    for (const [file, value] of sentinels) {
      const target = path.join(root, file);
      assert(!fs.existsSync(target), `sentinel already exists: ${file}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value);
    }
    callback(sentinels.map(([file]) => file));
  } finally {
    for (const [file] of sentinels) {
      quarantineTestPath(path.join(root, file), file.replace(/[^a-z0-9]+/gi, '-'));
    }
    if (!cacheExisted) quarantineTestPath(cacheDirectory, 'cache-directory');
  }
}

const archive = createZipArchive();
assert.strictEqual(typeof archive.file, 'function');
assert.strictEqual(typeof archive.finalize, 'function');
assert.strictEqual(typeof archive.abort, 'function');
archive.abort();

const digests = [];
const roots = [];
try {
  for (let index = 0; index < 4; index += 1) {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-package-release-'));
    roots.push(output);
    const result = runPackager(output);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const zip = path.join(output, 'Nebulaverse-X-v5.3.0-alpha.17.0.zip');
    digests.push(crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'));
    if (index === 0) {
      assertZipIntegrity(zip);
      const memberList = zipMembers(zip);
      const expectedMembers = discoverReleaseManifest().map(
        file => `Nebulaverse-X-v5.3.0-alpha.17.0/${file.relative}`
      );
      assert.deepStrictEqual(
        memberList,
        expectedMembers,
        'release ZIP members must exactly match the vetted tracked manifest'
      );
      const members = new Set(memberList);
      for (const artifact of foundationArtifacts) {
        assert(members.has(`Nebulaverse-X-v5.3.0-alpha.17.0/${artifact}`), `release ZIP missing ${artifact}`);
      }
    }
  }
  assert.strictEqual(new Set(digests).size, 1, `release ZIP is nondeterministic: ${digests.join(', ')}`);

  const nestedOutput = fs.mkdtempSync(path.join(root, 'release-output-sentinel-'));
  fs.writeFileSync(path.join(nestedOutput, 'existing-output.txt'), 'synthetic nested-output sentinel\n');
  const nestedResult = runPackager(nestedOutput);
  const nestedZipExists = fs.existsSync(
    path.join(nestedOutput, 'Nebulaverse-X-v5.3.0-alpha.17.0.zip')
  );
  quarantineTestPath(nestedOutput, 'nested-output');
  assert.notStrictEqual(nestedResult.status, 0, 'packager must reject an output directory inside the source root');
  assert.match(nestedResult.stderr, /release output directory must be outside the source root/i);
  assert(!nestedZipExists);

  const noGitBin = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-package-no-git-bin-'));
  roots.push(noGitBin);
  const noGitOutput = path.join(noGitBin, 'release');
  const noGitResult = runPackager(noGitOutput, { env: { PATH: noGitBin } });
  assert.notStrictEqual(noGitResult.status, 0, 'packager must fail when tracked-manifest discovery is unavailable');
  assert.match(noGitResult.stderr, /Release manifest discovery failed: git is unavailable/);
  assert(!fs.existsSync(noGitOutput), 'manifest discovery failure must not create release output');

  const inconsistentOutput = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-package-inconsistent-manifest-')),
    'release'
  );
  roots.push(path.dirname(inconsistentOutput));
  withArtifact('test/fixtures/gitea-provider-fetch.js', null, () => {
    const result = runPackager(inconsistentOutput);
    assert.notStrictEqual(result.status, 0, 'packager must fail when a tracked manifest member is missing');
    assert.match(result.stderr, /Release manifest is inconsistent: tracked file is missing: test\/fixtures\/gitea-provider-fetch\.js/);
    assert(!fs.existsSync(inconsistentOutput), 'inconsistent manifest must not create release output');
  });

  const untrackedOutput = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-package-untracked-manifest-')),
    'release'
  );
  roots.push(path.dirname(untrackedOutput));
  const untrackedSentinel = `release-untracked-sentinel-${process.pid}.txt`;
  const untrackedTarget = path.join(root, untrackedSentinel);
  try {
    fs.writeFileSync(untrackedTarget, 'synthetic untracked releasable member\n');
    const result = runPackager(untrackedOutput);
    assert.notStrictEqual(result.status, 0, 'packager must fail on an untracked releasable path');
    assert.match(result.stderr, new RegExp(
      `Release manifest is inconsistent: untracked releasable path: ${untrackedSentinel}`
    ));
    assert(!fs.existsSync(untrackedOutput), 'untracked releasable paths must not create release output');
  } finally {
    quarantineTestPath(untrackedTarget, 'untracked-release-member');
  }

  const ignoredOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-package-ignored-state-'));
  roots.push(ignoredOutput);
  withIgnoredSentinels(sentinels => {
    const result = runPackager(ignoredOutput);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const zip = path.join(ignoredOutput, 'Nebulaverse-X-v5.3.0-alpha.17.0.zip');
    const members = zipMembers(zip);
    for (const sentinel of sentinels) {
      assert(
        !members.includes(`Nebulaverse-X-v5.3.0-alpha.17.0/${sentinel}`),
        `release ZIP contains ignored sentinel ${sentinel}`
      );
    }
    assert(
      !members.some(member => member.includes('/.superpowers/')),
      'release ZIP contains internal .superpowers state'
    );
    const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    assert.strictEqual(digest, digests[0], 'ignored working-tree state changed release ZIP bytes');
  });

  const missingOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-package-missing-foundation-'));
  roots.push(missingOutput);
  withArtifact('PUBLIC_ALPHA_PROVENANCE.json', null, () => {
    const result = runPackager(missingOutput);
    assert.notStrictEqual(result.status, 0, 'packager must fail when a required foundation artifact is missing');
    assert.match(result.stderr, /Missing PUBLIC_ALPHA_PROVENANCE\.json/);
  });

  const staleOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-package-stale-foundation-'));
  roots.push(staleOutput);
  const staleProvenance = JSON.parse(fs.readFileSync(path.join(root, 'PUBLIC_ALPHA_PROVENANCE.json'), 'utf8'));
  staleProvenance.successorVersion = '5.3.0-alpha.16.3';
  withArtifact('PUBLIC_ALPHA_PROVENANCE.json', JSON.stringify(staleProvenance, null, 2) + '\n', () => {
    const result = runPackager(staleOutput);
    assert.notStrictEqual(result.status, 0, 'packager must fail when a foundation artifact is stale');
    assert.match(result.stderr, /Foundation gate failed: test\/public-alpha-provenance\.test\.js/);
  });
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  cleanupRuntimeState();
}

console.log('package release runtime test passed');
