'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const neural = fs.readFileSync(path.join(root, 'public', 'neural.js'), 'utf8');

assert(server.includes("require('./src/security-foundation')"), 'server must use the centralized security foundation module');
assert(server.includes("req.headers['sec-fetch-site']") && server.includes("req.headers.origin"), 'unsafe API requests must reject cross-site browser origins');
assert(server.includes("app.get('/api/security/csrf'"), 'authenticated clients need a CSRF token endpoint');
assert(server.includes("app.post('/api/security/step-up'"), 'sensitive actions need a step-up grant endpoint');
assert(/async function auth[\s\S]+verifyRequestCsrf[\s\S]+sensitiveOperationFor[\s\S]+consumeStepUpAuthorization/.test(server), 'auth must centrally enforce CSRF and single-use step-up grants');
assert(server.includes("authMethod: 'token'") && server.includes("authMethod: 'oauth'"), 'session accounts must preserve the authentication method');
assert(/app\.post\('\/api\/logout', (?:auth|accountAuth)/.test(server), 'logout must be an authenticated CSRF-protected mutation');

assert(app.includes("'x-nv-csrf': csrfToken"), 'JSON mutations must carry the CSRF token');
assert(app.includes("opts.headers"), 'API helper must support action-specific authorization headers');
assert(app.includes('async function requestStepUp'), 'client must request action-scoped step-up authorization');
assert(app.includes("'x-nv-step-up': grant"), 'sensitive mutations must carry the one-time step-up grant');
assert((app.match(/setRequestHeader\('x-nv-csrf'/g) || []).length >= 2, 'raw upload paths must carry CSRF tokens');
assert(/repository\.delete[\s\S]+method: 'DELETE'/.test(app), 'repository deletion must use step-up authorization');
assert(/branch\.reset[\s\S]+\/reset/.test(app), 'hard reset must use step-up authorization');
assert(/pull\.merge[\s\S]+pulls\/\$\{p\.number\}\/merge/.test(app), 'PR merge must use step-up authorization');
assert(/sessions\.revoke-others[\s\S]+revoke-others/.test(neural), 'revoking other sessions must use step-up authorization');
assert(/sessions\.revoke-others[\s\S]+emergency-manifest/.test(neural), 'Emergency Shield must not bypass session-revocation step-up authorization');

console.log('security foundation contract tests passed');
