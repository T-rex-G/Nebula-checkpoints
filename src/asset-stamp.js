'use strict';

/*
 * The asset stamp names the service-worker shell cache and is the query on
 * every static asset URL, so it decides when a browser stops using the copy it
 * already has.
 *
 * It used to be derived from the version string alone. The release contract
 * already records that failing once -- a literal '530' meant every 5.3.0
 * prerelease shared a stamp -- and deriving from the full version fixed that
 * level while leaving the next one intact: every build of 5.3.0-alpha.17.0
 * still shares a stamp, and an alpha is deployed many times under one version.
 *
 * The effect is not a stale asset here and there. The worker serves navigations
 * from the network and everything else cache-first, so a browser that has
 * visited once gets the new HTML and the old scripts for as long as the version
 * string holds: buttons that exist in the markup with no handler behind them.
 * The worker cannot correct it either, because sw.js is itself templated with
 * the same stamp and so is byte-identical between builds -- the browser sees no
 * new worker and never reinstalls.
 *
 * So the stamp names the bytes rather than the label. The release tree
 * fingerprint is exactly that identity, and the server already computes it.
 */

const { APP_VERSION, deriveAssetVersion } = require('./version');

/*
 * Twelve hex characters of a SHA-256, alongside the version. Collision here
 * means a browser keeps a stale shell, not a security failure, and the version
 * still separates releases on its own.
 */
const TREE_PREFIX_LENGTH = 12;

function assetStampFor(releaseTreeSha256) {
  const tree = String(releaseTreeSha256 == null ? '' : releaseTreeSha256).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(tree)) {
    throw new TypeError('asset stamp requires a release tree fingerprint');
  }
  return deriveAssetVersion(`${APP_VERSION}+${tree.slice(0, TREE_PREFIX_LENGTH)}`);
}

module.exports = Object.freeze({ assetStampFor, TREE_PREFIX_LENGTH });
