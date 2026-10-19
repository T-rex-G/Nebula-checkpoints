'use strict';

const { serverEntry, serverIdentity } = require('./helpers/server-entry');
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

const { APP_VERSION, PRODUCT_NAME } = require('../src/version');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');
const { servedAssetsDigest } = require('../src/web-build');
const expectedReleaseTreeSha256 = computeReleaseFingerprint(root);
const expectedServedAssetsSha256 = servedAssetsDigest(path.join(root, 'dist', 'web'));
assert.strictEqual(APP_VERSION, pkg.version);
assert.strictEqual(PRODUCT_NAME, 'Nebulaverse-X');
assert.deepStrictEqual(Object.keys(require('../src/version')).sort(), ['APP_VERSION', 'PRODUCT_NAME'],
  'no asset stamp is derived from the version any more: the build names files by their content');

const port = 27000 + Math.floor(Math.random() * 1000);
const sessionSecret = ['release-contract', '0123456789abcdef', '0123456789abcdef'].join('-');
const snapKey = ['release-contract-snapshot', 'fedcba9876543210', 'fedcba9876543210'].join('-');
const child = spawn(process.execPath, [serverEntry()], {
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
    /* No version field: this route answers before an invitation, so what it
       says it says to everyone. The fingerprint names the build exactly; the
       semantic version travels on /api/me, behind a session. */
    assert.deepStrictEqual(version, {
      product: PRODUCT_NAME,
      releaseTreeSha256: expectedReleaseTreeSha256,
      servedAssetsSha256: expectedServedAssetsSha256,
      ...serverIdentity()
    });
    assert.ok(!JSON.stringify(version).includes(pkg.version),
      'the anonymous identity route still publishes the semantic version');

    const html = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
    assert(!html.includes('__NV_'), 'release placeholders must be rendered');
    assert(html.includes(PRODUCT_NAME), 'official product name must be rendered');
    assert(!html.includes(APP_VERSION), 'the page publishes the semantic version to anonymous callers');
    /*
     * Named by content, not stamped. Every script and stylesheet the page links
     * is a file of the build whose name carries its digest, so a new build is a
     * new URL and an unchanged file keeps its cache; nothing on a URL derives
     * from the version.
     */
    assert(!/\?v=/.test(html), 'an asset URL still carries a stamp');
    const linked = [...html.matchAll(/(?:src|href)="(\/build\/[^"]+)"/g)].map(match => match[1]);
    assert(linked.length >= 2, 'the page must link its built entry and stylesheet');
    for (const url of linked) {
      assert.match(url, /^\/build\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/, `${url} is not named by its content`);
      assert.strictEqual((await fetch(`http://127.0.0.1:${port}${url}`)).status, 200, `${url} is linked but not served`);
    }

    const sw = await fetch(`http://127.0.0.1:${port}/sw.js`).then(r => r.text());
    assert(!sw.includes('__NV_'), 'service worker placeholders must be rendered');
    /* The shell cache is named by a digest of the files it holds, written in by the build. */
    assert.match(sw, /["'`]nv-static-[0-9a-f]{16}["'`]/, 'the shell cache must be named by the build digest');
    /* /sw.js is fetched without a session; it must not carry the semantic version. */
    assert(!sw.includes(APP_VERSION),
      'the service worker publishes the semantic version to anonymous callers');
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
