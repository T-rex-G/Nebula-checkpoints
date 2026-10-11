'use strict';

/*
 * Test-only. Loaded with `-r` by server tests that exercise the routes of a
 * capability still awaiting live qualification -- repository creation and
 * deletion, notifications, live events -- so the route behaviour stays covered
 * while the registry keeps the capability out of the product. The listed
 * capabilities read as Supported with Deterministic evidence; nothing else
 * changes, and the production server never loads this file.
 */
const fs = require('fs');
const path = require('path');

const registryPath = path.resolve(__dirname, '..', '..', 'config', 'public-alpha-capabilities.json');
const promote = String(process.env.NV_TEST_PROMOTE_CAPABILITIES || '').split(',').map(item => item.trim()).filter(Boolean);
const readFileSync = fs.readFileSync;

fs.readFileSync = function promotedReadFileSync(file, ...rest) {
  const value = readFileSync.call(this, file, ...rest);
  if (!promote.length || typeof file !== 'string' || path.resolve(file) !== registryPath) return value;
  const document = JSON.parse(String(value));
  const features = document.providers.github['hosted-alpha'];
  for (const feature of promote) {
    if (!Array.isArray(features[feature])) throw new Error(`cannot promote unknown capability ${feature}`);
    features[feature] = ['Supported', 'Deterministic', features[feature][2]];
  }
  const text = JSON.stringify(document);
  return typeof value === 'string' ? text : Buffer.from(text);
};
