'use strict';
/*
 * Builds the browser application into dist/web:
 *
 *  1. the page and its modules, with Vite (apps/web/vite.config.js);
 *  2. theme-boot.js, the one classic script, without its source comments;
 *  3. the service worker at /sw.js, its shell list written in from the files
 *     step 1 produced, and its version a digest of what that list names.
 *
 * dist/ is never committed and never part of the release fingerprint. What
 * the server serves from it is attested separately, as servedAssetsSha256 in
 * /api/version, so the build must be deterministic: the same tree builds the
 * same bytes. `node scripts/build-web.js --check-determinism` builds twice and
 * fails if the digests differ.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stripJsComments } = require('../src/public-assets');
const { servedAssetsDigest } = require('../src/web-build');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'apps', 'web');
const OUT = path.join(ROOT, 'dist', 'web');

/* Content-hashed output of the application build. */
const BUILD_DIR = 'build';
/* Built on first use instead of on install: see apps/web/src/offline/sw.js. */
const NOT_PRECACHED = /^(three\.module|nebula-galaxy|nebula-singularity)-.+\.js$|\.woff2$/;
const WARMED_FACES = /^(archivo-latin-standard-normal|public-sans-latin-wght-normal|jetbrains-mono-latin-wght-normal)-.+\.woff2$/;

async function buildApplication(vite) {
  await vite.build({ configFile: path.join(WEB, 'vite.config.js'), mode: 'production' });
}

function stripThemeBoot() {
  const file = path.join(OUT, 'theme-boot.js');
  fs.writeFileSync(file, stripJsComments(fs.readFileSync(file, 'utf8')));
}

function shellLists() {
  const built = fs.readdirSync(path.join(OUT, BUILD_DIR)).sort();
  const precache = [
    '/', '/theme-boot.js', '/manifest.webmanifest', '/assets/icon.svg', '/assets/icon-192.png',
    ...built.filter(name => !NOT_PRECACHED.test(name)).map(name => `/${BUILD_DIR}/${name}`)
  ];
  const warm = built.filter(name => WARMED_FACES.test(name)).map(name => `/${BUILD_DIR}/${name}`);
  if (warm.length !== 3) throw new Error(`expected the three interface faces in the build, found ${warm.length}`);
  const digest = crypto.createHash('sha256');
  for (const url of [...precache, ...warm]) {
    digest.update(url).update('\0');
    const file = url === '/' ? path.join(OUT, 'index.html') : path.join(OUT, url.slice(1));
    digest.update(fs.readFileSync(file)).update('\0');
  }
  return { precache, warm, version: digest.digest('hex').slice(0, 16) };
}

async function buildServiceWorker(vite, lists) {
  await vite.build({
    configFile: false,
    root: WEB,
    /* The application build has already copied apps/web/public; copying it again would undo step 2. */
    publicDir: false,
    logLevel: 'warn',
    define: {
      __NV_SHELL_VERSION__: JSON.stringify(lists.version),
      __NV_PRECACHE__: JSON.stringify(lists.precache),
      __NV_WARM__: JSON.stringify(lists.warm)
    },
    build: {
      outDir: OUT,
      emptyOutDir: false,
      sourcemap: false,
      target: 'es2022',
      reportCompressedSize: false,
      lib: {
        entry: path.join(WEB, 'src', 'offline', 'sw.js'),
        formats: ['iife'],
        name: 'NebulaServiceWorker',
        fileName: () => 'sw.js'
      }
    }
  });
}

async function build() {
  const vite = await import('vite');
  await buildApplication(vite);
  stripThemeBoot();
  const lists = shellLists();
  await buildServiceWorker(vite, lists);
  return servedAssetsDigest(OUT);
}

async function main() {
  const first = await build();
  if (process.argv.includes('--check-determinism')) {
    const second = await build();
    if (second !== first) {
      console.error(`the browser build is not deterministic: ${first} then ${second}`);
      process.exit(1);
    }
    console.log(`browser build is deterministic: servedAssetsSha256 ${first}`);
    return;
  }
  console.log(`built dist/web: servedAssetsSha256 ${first}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
