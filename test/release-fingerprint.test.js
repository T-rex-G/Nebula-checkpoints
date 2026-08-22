'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  computeReleaseFingerprint,
  shouldIncludeReleasePath
} = require('../src/release-fingerprint');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-release-fingerprint-'));
try {
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(root, 'nested', 'b.txt'), Buffer.from([0, 1, 2, 3, 255]));

  const initial = computeReleaseFingerprint(root);
  assert.strictEqual(
    initial,
    'f4bf32fd5cf55442954310f908b47356d28f331eada3c6b5a1c46238f2173153',
    'the release fingerprint serialization must remain byte-for-byte stable'
  );

  fs.mkdirSync(path.join(root, 'node_modules', 'dependency'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dependency', 'index.js'), 'ignored dependency\n');
  fs.mkdirSync(path.join(root, 'staging', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(root, 'staging', 'evidence', 'hosted.json'), '{"ignored":true}\n');
  const runtimeSecretName = ['SESSION', 'SECRET'].join('_');
  const runtimeSecretValue = ['synthetic', 'runtime', 'only', 'value'].join('-');
  fs.writeFileSync(path.join(root, '.env'), `${runtimeSecretName}=${runtimeSecretValue}\n`);
  fs.writeFileSync(path.join(root, 'runtime.log'), 'ignored runtime log\n');
  assert.strictEqual(
    computeReleaseFingerprint(root),
    initial,
    'dependency, evidence, environment, and log state must not alter release identity'
  );

  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  assert.notStrictEqual(computeReleaseFingerprint(root), initial, 'a releasable byte change must alter identity');

  fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'linked.js'));
  assert.throws(
    () => computeReleaseFingerprint(root),
    /symbolic link/i,
    'a releasable symbolic link must fail closed'
  );

  assert.strictEqual(shouldIncludeReleasePath('.env.example'), true);
  assert.strictEqual(shouldIncludeReleasePath('.env.production'), false);
  assert.strictEqual(shouldIncludeReleasePath('src/server.js'), true);
  assert.strictEqual(shouldIncludeReleasePath('node_modules/pkg/index.js'), false);
  assert.strictEqual(shouldIncludeReleasePath('staging/evidence/live.json'), false);
  assert.strictEqual(shouldIncludeReleasePath('dist/release.js'), false);
  assert.strictEqual(shouldIncludeReleasePath('../escape.js'), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('release fingerprint tests passed');
