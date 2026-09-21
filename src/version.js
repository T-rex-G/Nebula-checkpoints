'use strict';

const { createHash } = require('crypto');
const pkg = require('../package.json');

const PRODUCT_NAME = 'Nebulaverse-X';
const APP_VERSION = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(APP_VERSION)) {
  throw new Error('package.json contains an invalid application version');
}

/*
 * The asset stamp busts the browser HTTP cache and names the service-worker
 * shell cache, so two releases must never share one.
 *
 * Deriving it from the release-numeric prefix discarded the prerelease tag, so
 * every 5.3.0 build collapsed onto "530": alpha.16.3, alpha.17.0 and the
 * eventual 5.3.0 were indistinguishable. Static assets are served with a
 * week-long max-age on the strength of that stamp, and the service-worker
 * shell cache is named from it, so a returning tester kept running the
 * previously cached bundle against a freshly deployed server.
 *
 * The fix for that was an injective encoding -- each UTF-8 byte as three
 * decimal digits -- which guaranteed distinctness by construction. It also
 * meant the stamp decoded straight back to the version, and the stamp is the
 * query on every asset URL in a page that needs no invitation to read. Three
 * lines turned 053046051046048045... back into 5.3.0-alpha.17.0, so the build
 * number was published to every visitor by the cache-busting mechanism itself.
 *
 * So the derivation is a digest now: the first ten bytes of a SHA-256, each
 * rendered as three decimal digits. It stays numeric, which the shell URL and
 * cache-name contracts rely on, and it stays deterministic, which release
 * verification relies on -- but it cannot be read backwards.
 *
 * What that costs is worth naming. Distinctness stops being structural and
 * becomes probabilistic: two releases share a stamp only on an eighty-bit
 * digest collision, where before it was impossible by counting. The failure
 * that guarantee was bought to prevent -- a returning browser reusing a shell
 * cache across releases -- now has a likelihood rather than a proof, and at
 * this size that likelihood is far below the chance of the deployment itself
 * going wrong. A disclosure on every public URL is the larger defect.
 *
 * Two shorter derivations were rejected. Concatenating the version's digits
 * collides: 5.3.0-alpha.1.70 and 5.3.0-alpha.17.0 both render as 530170. The
 * raw byte encoding is the one this replaces, for the reason above.
 */
const DIGEST_BYTES = 10;

function deriveAssetVersion(version) {
  const value = String(version == null ? '' : version).trim();
  if (!value) throw new Error('asset version requires an application version');
  return Array.from(
    createHash('sha256').update(value, 'utf8').digest().subarray(0, DIGEST_BYTES),
    byte => String(byte).padStart(3, '0')
  ).join('');
}

const ASSET_VERSION = deriveAssetVersion(APP_VERSION);

module.exports = Object.freeze({ PRODUCT_NAME, APP_VERSION, ASSET_VERSION, deriveAssetVersion, DIGEST_BYTES });
