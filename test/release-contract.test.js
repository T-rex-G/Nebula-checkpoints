'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.strictEqual(pkg.name, 'nebulaverse-x');
assert.strictEqual(pkg.version, '5.3.0-alpha.17.0');
assert.strictEqual(pkg.engines.node, '22.23.1');
assert.strictEqual(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'), '22.23.1\n');

const { APP_VERSION, PRODUCT_NAME, ASSET_VERSION, deriveAssetVersion } = require('../src/version');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');
const { assetStampFor, TREE_PREFIX_LENGTH } = require('../src/asset-stamp');
const expectedReleaseTreeSha256 = computeReleaseFingerprint(root);
const servedStamp = assetStampFor(expectedReleaseTreeSha256);
assert.strictEqual(APP_VERSION, pkg.version);
assert.strictEqual(PRODUCT_NAME, 'Nebulaverse-X');

/*
 * The asset stamp names the service-worker shell cache and carries the
 * week-long max-age on every static asset, so distinct releases must never
 * share one.
 *
 * Both kinds of assertion are needed here. The property assertions below catch
 * a derivation that collides, which a fixed value cannot: the previous literal
 * '530' passed happily while every 5.3.0 prerelease shared one stamp. The
 * fixed values further down catch a derivation that silently changes shape,
 * which the property assertions cannot, and which would orphan every already
 * deployed cache.
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
/*
 * The version-only derivation separated releases but not builds, and an alpha
 * ships many builds under one version. Two trees must not share a shell cache:
 * a returning browser takes navigations from the network and everything else
 * cache-first, so a shared stamp hands it new markup and older scripts.
 *
 * What the stamp actually carries is a prefix of the tree fingerprint, not the
 * whole of it, so the fixtures are real digests rather than a pair contrived
 * to agree across that prefix -- which is what they were, and which asserted a
 * separation the design does not offer and does not need. Changing one byte of
 * the tree changes the whole digest, so the prefix moves with it.
 */
const digest = value => createHash('sha256').update(value).digest('hex');
const treeA = digest('one release tree');
const treeB = digest('a different release tree');
assert.notStrictEqual(
  treeA.slice(0, TREE_PREFIX_LENGTH),
  treeB.slice(0, TREE_PREFIX_LENGTH),
  'the fixtures must differ within the prefix the stamp is built from, or this proves nothing'
);
assert.notStrictEqual(
  assetStampFor(treeA),
  assetStampFor(treeB),
  'two release trees must not share an asset stamp'
);
assert.strictEqual(assetStampFor(treeA), assetStampFor(treeA), 'the stamp must be stable for one tree');
assert.match(assetStampFor(treeA), /^[0-9]+$/, 'the shell URL and cache-name contracts require a numeric stamp');
assert.throws(() => assetStampFor(''), /release tree fingerprint/, 'a stamp must refuse to name nothing');
assert.throws(() => assetStampFor('not-a-fingerprint'), /release tree fingerprint/);

for (const version of distinctReleases) {
  assert.match(deriveAssetVersion(version), /^[0-9]+$/, `stamp for ${version} must be numeric`);
}
assert.throws(() => deriveAssetVersion(''), /asset version requires an application version/);

/*
 * Pin the encoding itself. The property assertions above prove distinctness;
 * these prove the stamp cannot silently change shape, which would orphan every
 * already deployed service-worker shell cache.
 */
assert.strictEqual(deriveAssetVersion('5.3.0'), '053046051046048');
assert.strictEqual(deriveAssetVersion('5.3.0-alpha.17.0'),
  '053046051046048045097108112104097046049055046048');
assert.strictEqual(deriveAssetVersion('5.3.0-alpha.1.70'),
  '053046051046048045097108112104097046049046055048');
assert.strictEqual(ASSET_VERSION, '053046051046048045097108112104097046049055046048');

/*
 * Injectivity is structural rather than probabilistic: every byte occupies
 * exactly three digits, so the stamp decodes back to the exact version it came
 * from. A truncated hash could not support this assertion.
 */
function decodeAssetVersion(stamp) {
  assert.match(stamp, /^(?:[0-9]{3})+$/, 'the stamp must be whole three-digit byte groups');
  const bytes = stamp.match(/.{3}/g).map(Number);
  assert(bytes.every(byte => byte <= 255), 'each group must be a byte value');
  return Buffer.from(bytes).toString('utf8');
}
for (const version of [...distinctReleases, APP_VERSION, '9.9.9+build.1']) {
  assert.strictEqual(decodeAssetVersion(deriveAssetVersion(version)), version,
    `the stamp for ${version} must decode back to it`);
}


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
    /* No version field: this route answers before an invitation, so what it
       says it says to everyone. The fingerprint names the build exactly; the
       semantic version travels on /api/me, behind a session. */
    assert.deepStrictEqual(version, {
      product: PRODUCT_NAME,
      releaseTreeSha256: expectedReleaseTreeSha256
    });
    assert.ok(!JSON.stringify(version).includes(pkg.version),
      'the anonymous identity route still publishes the semantic version');

    const html = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
    assert(!html.includes('__NV_'), 'release placeholders must be rendered');
    /*
     * Read as a whole stamp rather than as a substring. The tree-derived stamp
     * begins with the version-derived one -- it is the same encoding of the
     * same version string with the tree appended -- so `includes` finds the
     * version-only stamp inside every correct URL, and asserting its absence
     * that way could never hold.
     */
    const servedStamps = new Set([...html.matchAll(/\?v=([0-9]+)/g)].map(match => match[1]));
    assert.deepStrictEqual([...servedStamps], [servedStamp],
      'every asset must carry the stamp derived from the release tree');
    assert(!servedStamps.has(ASSET_VERSION),
      'a version-only stamp cannot separate two builds of one version');
    assert(html.includes(PRODUCT_NAME), 'official product name must be rendered');

    const sw = await fetch(`http://127.0.0.1:${port}/sw.js`).then(r => r.text());
    assert(!sw.includes('__NV_'), 'service worker placeholders must be rendered');
    assert(sw.includes(`const VER = 'v${servedStamp}'`));
    assert(sw.includes('const STATIC = `nv-static-${VER}`')); 
    /* /sw.js is fetched without a session. It names the shell cache by the
       asset stamp, which is a content hash; it must not also carry the
       semantic version, which is the half that lines up against a CVE list. */
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
