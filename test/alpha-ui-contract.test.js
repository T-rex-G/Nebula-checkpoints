'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const alpha = fs.readFileSync(path.join(root, 'public', 'alpha-ui.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

for (const id of [
  'page-alpha-access', 'alphaInviteInput', 'alphaTermsAccept',
  'alphaRedeemBtn', 'alphaAccessError', 'alphaWakeState'
]) assert(html.includes(`id="${id}"`), `missing #${id}`);
assert(html.includes('sandbox/test repository'));
assert(html.includes('/alpha-ui.js?v=__NV_ASSET_VERSION__'));
assert(/id="page-alpha-access"[^>]*class="[^"]*active/.test(html)
  || /class="[^"]*active[^"]*"[^>]*id="page-alpha-access"/.test(html),
'the access gate must be the only initial page');
assert(!/class="[^"]*active[^"]*"[^>]*id="page-login"/.test(html));

assert(alpha.includes('/api/alpha/status'));
assert(alpha.includes('/api/alpha/redeem'));
assert(alpha.includes('/readyz'));
assert(alpha.includes('acceptedTermsVersion'));
assert(alpha.includes('1000, 2000, 4000, 8000'));
assert(alpha.includes("new CustomEvent('nebula:alpha-access-granted')"));
assert(alpha.includes('Object.freeze'));
assert(sw.includes('/alpha-ui.js?v='));

assert(app.includes('window.NebulaAlphaUI.boot().then'));
assert(app.includes("window.addEventListener('nebula:alpha-access-granted'"));
assert(app.includes("['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED']"));
assert(app.includes('NebulaAlphaUI.showExpired(error.code)'));
const expiryStart = app.indexOf("if (['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED'].includes(error.code))");
const expiryEnd = app.indexOf('throw error;', expiryStart);
const expiryBlock = app.slice(expiryStart, expiryEnd);
assert(expiryBlock.includes('alphaBootStarted = false;'),
  'a new invitation must be able to restart the app after expiry or revocation');
assert(expiryBlock.indexOf('await purgeLocalData(true)') < expiryBlock.indexOf('alphaBootStarted = false;'),
  'private browser state must be purged before app restart is re-enabled');

const safeguardsStart = app.indexOf('async function openSafeguards()');
const safeguardsEnd = app.indexOf('\nasync function moveFolderFlow', safeguardsStart);
const safeguardsBlock = app.slice(safeguardsStart, safeguardsEnd);
assert(app.includes("if (typeof onOpen === 'function') onOpen($('#modalBody'));"),
  'modal controls must support synchronous open-time binding');
assert(safeguardsBlock.includes('onOpen: () => {'),
  'Safeguards controls must bind as part of modal rendering');
assert(!safeguardsBlock.includes('setTimeout(() => {'),
  'Safeguards must not expose clickable controls before their handlers are bound');

console.log('alpha UI contract tests passed');
