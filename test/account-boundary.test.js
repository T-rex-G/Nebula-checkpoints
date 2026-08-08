'use strict';
const assert = require('assert');
const fs = require('fs');
const app = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
const neural = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'neural.js'), 'utf8');

assert(/await purgeLocalData\(true\);[\s\S]{0,500}api\('\/api\/login'/.test(app), 'login must clear prior identity data before authentication');
assert(/data-switch[\s\S]{0,1200}await purgeLocalData\(false\);[\s\S]{0,500}accounts\/switch-idx/.test(app), 'account switch must await cache purge before switching');
assert(/data-remove[\s\S]{0,1200}await purgeLocalData\(false\);[\s\S]{0,500}accounts\/remove/.test(app), 'account removal must purge before mutation');
assert(/async function doLogout\(\)[\s\S]+finally[\s\S]+await purgeLocalData\(true\)/.test(app), 'logout must clear local data even when remote revocation fails');
assert(app.includes('x-nv-offline-scope') && app.includes('x-nv-offline-repo'), 'eligible API reads must carry scoped offline headers');
assert(app.includes('Enable offline access for this repository'), 'settings must expose explicit per-repository opt-in');
assert(neural.includes("addEventListener('session-revoked'") && neural.includes('purgePrivateData'), 'remote session revocation must purge private local data');
console.log('account boundary tests passed');
