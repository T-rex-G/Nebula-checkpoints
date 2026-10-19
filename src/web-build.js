'use strict';
/*
 * The built browser application, as the server serves it.
 *
 * The page, its modules and the service worker are produced by
 * scripts/build-web.js into dist/web. The server reads that build once at
 * start and refuses to start without it: a deployment whose build step did not
 * run would otherwise answer every visitor with a page whose scripts 404.
 *
 * servedAssetsSha256 names exactly the bytes served -- every file of the
 * build, by its path and its SHA-256, in byte order of the path. It sits beside
 * the release fingerprint in /api/version: the fingerprint names the source,
 * this names what was built from it, and qualification compares both.
 */
const fs = require('fs');
const path = require('path');
const { directoryDigest } = require('./directory-digest');

function servedAssetsDigest(root) {
  return directoryDigest(root, 'the browser build');
}

function loadWebBuild(root) {
  const indexFile = path.join(root, 'index.html');
  const workerFile = path.join(root, 'sw.js');
  if (!fs.existsSync(indexFile) || !fs.existsSync(workerFile)) {
    throw new Error(`The browser application is not built (${path.relative(process.cwd(), root) || root}); run npm run build:web`);
  }
  return Object.freeze({
    root,
    index: fs.readFileSync(indexFile, 'utf8'),
    serviceWorker: fs.readFileSync(workerFile, 'utf8'),
    servedAssetsSha256: servedAssetsDigest(root)
  });
}

/* Content-hashed files never change under their names; everything else is revalidated. */
function webCacheControl(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  return relative.startsWith('build/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

module.exports = { loadWebBuild, servedAssetsDigest, webCacheControl };
