'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  MAX_DIRECTORY_DEPTH,
  discoverReleasableTextFiles,
  scanFiles
} = require('../src/secret-scanner');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-secret-scanner-'));
try {
  const secrets = {
    privateKey: `-----BEGIN ${'PRIVATE'} KEY-----`,
    github: `gh${'p'}_${'A'.repeat(36)}`,
    gitlabPat: `gl${'pat'}-${'B'.repeat(24)}`,
    gitlabOauth: `gl${'oas'}-${'C'.repeat(24)}`,
    aws: `AK${'IA'}${'D'.repeat(16)}`,
    slack: `xo${'xb'}-${'E'.repeat(24)}`,
    authenticatedUrl: ['https://', 'fixture:', 'F'.repeat(24), '@example.invalid/repository'].join(''),
    gitea: `${'G'.repeat(40)}`,
    npm: `${'a1'.repeat(18)}`,
    neon: `${'H'.repeat(40)}`,
    oauth: `${'I'.repeat(40)}`,
    session: `${'J'.repeat(40)}`,
    githubClient: `${'K'.repeat(40)}`,
    githubPrivateKey: `${'L'.repeat(80)}`,
    githubWebhook: `${'M'.repeat(40)}`,
    snapshotSigning: `${'N'.repeat(40)}`,
    snapshotRetired: `${'O'.repeat(40)}`,
    snapshotLegacy: `${'P'.repeat(40)}`
  };
  const snapshotRetiredName = ['NV', 'SNAPSHOT', 'RETIRED', 'KEYS', 'JSON'].join('_');
  const snapshotLegacyName = ['NV', 'SNAPSHOT', 'LEGACY', 'KEYS', 'JSON'].join('_');
  const files = {
    README: secrets.github,
    'private-key.md': secrets.privateKey,
    'gitlab-pat.md': secrets.gitlabPat,
    'gitlab-oauth.md': secrets.gitlabOauth,
    'cloud.txt': `${secrets.aws}\n${secrets.slack}\n${secrets.authenticatedUrl}\n`,
    'gitea.conf': `GITEA_TOKEN=${secrets.gitea}`,
    'npm.conf': `NPM_TOKEN=${secrets.npm}`,
    'neon.conf': `NEON_API_KEY=${secrets.neon}`,
    'oauth.conf': `OAUTH_CLIENT_SECRET=${secrets.oauth}`,
    'session.conf': `SESSION_SECRET=${secrets.session}`,
    'github-client.conf': `GITHUB_APP_CLIENT_SECRET=${secrets.githubClient}`,
    'github-private-key.conf': `GITHUB_APP_PRIVATE_KEY_BASE64=${secrets.githubPrivateKey}`,
    'github-webhook.conf': `GITHUB_APP_WEBHOOK_SECRET=${secrets.githubWebhook}`,
    'snapshot-signing.conf': `NV_SNAPSHOT_SIGNING_SECRET=${secrets.snapshotSigning}`,
    'snapshot-retired.conf': `${snapshotRetiredName}={"retired-key":"${secrets.snapshotRetired}"}`,
    'snapshot-legacy.conf': `${snapshotLegacyName}=["${secrets.snapshotLegacy}"]`,
    'harmless.js': [
      'const GITEA_TOKEN = process.env.GITEA_TOKEN;',
      'const NPM_TOKEN = process.env.NPM_TOKEN;',
      'const SESSION_SECRET = process.env.SESSION_SECRET;',
      'const GITHUB_APP_CLIENT_SECRET = ${GITHUB_APP_CLIENT_SECRET};',
      'const NV_SNAPSHOT_SIGNING_SECRET = process.env.NV_SNAPSHOT_SIGNING_SECRET;',
      'const NV_SNAPSHOT_RETIRED_KEYS_JSON = JSON.stringify(retiredKeys);',
      'const url = "https://example.invalid/repository";'
    ].join('\n')
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(temporaryRoot, relative), `${content}\n`);
  }
  fs.writeFileSync(
    path.join(temporaryRoot, 'binary.data'),
    Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(secrets.github)])
  );
  fs.symlinkSync(path.join(temporaryRoot, 'README'), path.join(temporaryRoot, 'linked-secret'));

  const findings = scanFiles({
    root: temporaryRoot,
    files: [...Object.keys(files), 'binary.data', 'linked-secret']
  });
  const rules = findings.map(item => item.rule).sort();
  assert.deepStrictEqual(rules, [
    'authenticated-url',
    'aws-access-key',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'github-token',
    'gitlab-token',
    'gitlab-token',
    'private-key',
    'slack-token'
  ].sort());
  assert(!findings.some(item => item.path === 'binary.data'));
  assert(!findings.some(item => item.path === 'linked-secret'));
  assert(!findings.some(item => item.path === 'harmless.js'));
  assert(findings.every(item => Number.isInteger(item.line) && item.line >= 1),
    'findings must identify a safe 1-based source line');
  assert.deepStrictEqual(
    findings.filter(item => item.path === 'cloud.txt').map(item => [item.rule, item.line]),
    [['aws-access-key', 1], ['slack-token', 2], ['authenticated-url', 3]],
    'line reporting must identify each rule without echoing its matched value'
  );
  const serializedFindings = JSON.stringify(findings);
  for (const value of Object.values(secrets)) {
    assert(!serializedFindings.includes(value), 'findings must never echo the matched secret');
  }

  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-secret-archive-'));
  try {
    fs.mkdirSync(path.join(archiveRoot, 'src'));
    fs.mkdirSync(path.join(archiveRoot, 'node_modules', 'ignored'), { recursive: true });
    fs.mkdirSync(path.join(archiveRoot, 'build'), { recursive: true });
    fs.mkdirSync(path.join(archiveRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, 'README.md'), 'archive\n');
    fs.writeFileSync(path.join(archiveRoot, 'src', 'index.js'), "'use strict';\n");
    fs.writeFileSync(path.join(archiveRoot, '._metadata'), 'ignored\n');
    fs.writeFileSync(path.join(archiveRoot, 'node_modules', 'ignored', 'secret.txt'), secrets.github);
    fs.writeFileSync(path.join(archiveRoot, 'build', 'secret.txt'), secrets.github);
    fs.writeFileSync(path.join(archiveRoot, '.git', 'secret.txt'), secrets.github);
    assert.deepStrictEqual(
      discoverReleasableTextFiles(archiveRoot),
      ['README.md', 'src/index.js'],
      'non-Git release archives must use the bounded walk and exclude dependency/build metadata'
    );
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }

  const deeplyNestedArchive = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-secret-depth-'));
  try {
    let directory = deeplyNestedArchive;
    for (let depth = 0; depth <= MAX_DIRECTORY_DEPTH; depth += 1) {
      directory = path.join(directory, `d${depth}`);
      fs.mkdirSync(directory);
    }
    assert.throws(
      () => discoverReleasableTextFiles(deeplyNestedArchive),
      /directory nesting exceeds the safe limit/i
    );
  } finally {
    fs.rmSync(deeplyNestedArchive, { recursive: true, force: true });
  }

  execFileSync('git', ['init', '--initial-branch=main'], { cwd: temporaryRoot, stdio: 'ignore' });
  execFileSync('git', ['add', 'README', 'harmless.js'], { cwd: temporaryRoot, stdio: 'ignore' });
  const discovered = discoverReleasableTextFiles(temporaryRoot);
  assert.deepStrictEqual(discovered, ['README', 'harmless.js']);
  assert(!discovered.includes('private-key.md'), 'untracked files are not part of a Git release manifest');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('secret scanner tests passed');
