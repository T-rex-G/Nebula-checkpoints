'use strict';

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
 * The stamp encodes the version's own UTF-8 bytes as fixed-width decimal
 * groups. Every byte becomes exactly three digits, so the mapping is injective
 * by construction: two versions share a stamp only when their bytes are
 * identical. It stays numeric, which the shell URL and cache-name contracts
 * rely on.
 *
 * Two shorter derivations were rejected. Concatenating the version's digits
 * collides: 5.3.0-alpha.1.70 and 5.3.0-alpha.17.0 both render as 530170. A
 * truncated SHA-256 is collision-resistant but not injective — the version
 * validator accepts unbounded distinct strings, so collisions exist by
 * counting, and a collision here silently reuses an already deployed cache.
 */
function deriveAssetVersion(version) {
  const value = String(version == null ? '' : version).trim();
  if (!value) throw new Error('asset version requires an application version');
  return Array.from(
    Buffer.from(value, 'utf8'),
    byte => String(byte).padStart(3, '0')
  ).join('');
}

const ASSET_VERSION = deriveAssetVersion(APP_VERSION);

module.exports = Object.freeze({ PRODUCT_NAME, APP_VERSION, ASSET_VERSION, deriveAssetVersion });
