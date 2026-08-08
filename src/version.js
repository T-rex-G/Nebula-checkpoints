'use strict';

const pkg = require('../package.json');

const PRODUCT_NAME = 'Nebulaverse-X';
const APP_VERSION = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(APP_VERSION)) {
  throw new Error('package.json contains an invalid application version');
}
const ASSET_VERSION = APP_VERSION.split(/[+-]/, 1)[0].replace(/\D/g, '');

module.exports = Object.freeze({ PRODUCT_NAME, APP_VERSION, ASSET_VERSION });
