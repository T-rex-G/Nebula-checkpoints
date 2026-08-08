'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

for (const label of [
  'Disconnect from Nebulaverse-X',
  'Revoke at provider',
  'End alpha session',
  'Delete alpha data'
]) assert(html.includes(label), `missing distinct privacy action: ${label}`);

const start = app.indexOf('async function purgeLocalData');
const end = app.indexOf('async function doLogout', start);
const block = app.slice(start, end);
assert(start >= 0 && end > start, 'purgeLocalData must remain a discrete account-boundary function');
assert(block.includes("tx.objectStore('queue').clear()"));
assert(block.includes('sessionStorage.clear()'));
assert(block.includes("localStorage.removeItem('nv_me')"));
assert(block.includes('purgePrivateCaches'));
assert(block.includes('state.staged = []'));
assert(block.includes('state.file = null'));
assert(block.includes('state.work = null'));
assert(block.includes('state.repos = []'));
assert(block.includes('state.me = null'));
assert(block.includes('clearCsrfToken'));
assert(block.includes("postMessage({ type: 'NV_PURGE_PRIVATE_DATA' })"));
assert(app.includes('/api/alpha/providers/disconnect-all'));
assert(app.includes('/api/alpha/delete'));
assert(app.includes("confirm: 'DELETE ALPHA DATA'"));
assert(serviceWorker.includes("event.data.type !== 'NV_PURGE_PRIVATE_DATA'"));
assert(serviceWorker.includes("key.startsWith('nv-api-')"));
assert(!/NV_PURGE_PRIVATE_DATA[\s\S]{0,500}nv-static-/.test(serviceWorker),
  'identity purge must preserve the static shell cache');

console.log('alpha browser purge tests passed');
