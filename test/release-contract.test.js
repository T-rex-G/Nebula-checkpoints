'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.strictEqual(pkg.name, 'nebulaverse-x');
assert.strictEqual(pkg.version, '5.3.0-alpha.17.0');
assert.strictEqual(pkg.engines.node, '22.23.1');
assert.strictEqual(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'), '22.23.1\n');

const { APP_VERSION, PRODUCT_NAME, ASSET_VERSION, deriveAssetVersion } = require('../src/version');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');
const expectedReleaseTreeSha256 = computeReleaseFingerprint(root);
assert.strictEqual(APP_VERSION, pkg.version);
assert.strictEqual(PRODUCT_NAME, 'Nebulaverse-X');

/*
 * The asset stamp names the service-worker shell cache and carries the
 * week-long max-age on every static asset, so distinct releases must never
 * share one. Assert the property rather than a fixed value: a literal would
 * still have passed while every 5.3.0 prerelease collapsed onto "530".
 */
assert.strictEqual(ASSET_VERSION, deriveAssetVersion(APP_VERSION), 'the stamp must derive from the exact version');
assert.strictEqual(deriveAssetVersion(APP_VERSION), deriveAssetVersion(APP_VERSION), 'the stamp must be stable');
assert.match(ASSET_VERSION, /^[0-9]+$/, 'the shell URL and cache-name contracts require a numeric stamp');
const distinctReleases = [
  '5.3.0-alpha.16.3',
  '5.3.0-alpha.17.0',
  '5.3.0-alpha.1.70',
  '5.3.1-alpha.17.0',
  '5.3.0'
];
assert.strictEqual(
  new Set(distinctReleases.map(deriveAssetVersion)).size,
  distinctReleases.length,
  'each distinct release must produce a distinct asset stamp'
);
for (const version of distinctReleases) {
  assert.match(deriveAssetVersion(version), /^[0-9]+$/, `stamp for ${version} must be numeric`);
}
assert.throws(() => deriveAssetVersion(''), /asset version requires an application version/);

const port = 27000 + Math.floor(Math.random() * 1000);
const sessionSecret = ['release-contract', '0123456789abcdef', '0123456789abcdef'].join('-');
const snapKey = ['release-contract-snapshot', 'fedcba9876543210', 'fedcba9876543210'].join('-');
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    SESSION_SECRET: sessionSecret,
    NV_SNAPSHOT_SIGNING_KEY_ID: 'release-contract-snapshot-key',
    NV_SNAPSHOT_SIGNING_SECRET: snapKey,
    DATABASE_URL: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', c => { logs += c; });
child.stderr.on('data', c => { logs += c; });

async function wait() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited\n${logs}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server timeout\n${logs}`);
}

(async () => {
  try {
    await wait();
    const version = await fetch(`http://127.0.0.1:${port}/api/version`).then(r => r.json());
    assert.deepStrictEqual(version, {
      version: pkg.version,
      product: PRODUCT_NAME,
      releaseTreeSha256: expectedReleaseTreeSha256
    });

    const html = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
    assert(!html.includes('__NV_'), 'release placeholders must be rendered');
    assert(html.includes(`?v=${ASSET_VERSION}`), 'asset stamp must derive from package version');
    assert(html.includes(PRODUCT_NAME), 'official product name must be rendered');

    const sw = await fetch(`http://127.0.0.1:${port}/sw.js`).then(r => r.text());
    assert(!sw.includes('__NV_'), 'service worker placeholders must be rendered');
    assert(sw.includes(`const VER = 'v${ASSET_VERSION}'`));
    assert(sw.includes('const STATIC = `nv-static-${VER}`')); 
    assert(sw.includes(`const RELEASE_VERSION = '${APP_VERSION}'`));
    console.log('release contract tests passed');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
