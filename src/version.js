'use strict';

const pkg = require('../package.json');

const PRODUCT_NAME = 'Nebulaverse-X';
const APP_VERSION = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(APP_VERSION)) {
  throw new Error('package.json contains an invalid application version');
}

/*
 * No asset stamp. Cache busting used to rest on a stamp derived from this
 * version and put on every asset URL; first it collapsed whole prereleases onto
 * one value, then it decoded straight back to the version, then it became a
 * digest -- each step a repair of a URL that carried release information at
 * all. The browser build now names every file by its own content and the
 * service worker names its shell cache by a digest of the files it lists
 * (scripts/build-web.js), so no URL a visitor can read derives from this
 * version, and two builds share a name only when they share the bytes.
 */
module.exports = Object.freeze({ PRODUCT_NAME, APP_VERSION });
