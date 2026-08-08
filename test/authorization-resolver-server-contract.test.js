'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const gateway = fs.readFileSync(path.join(root, 'src', 'mutation-gateway.js'), 'utf8');

assert(server.includes("require('./src/authorization-resolver')"), 'server must load the authorization resolver');
assert(server.includes('createAuthorizationResolver({'), 'server must create one authorization resolver');
assert(server.includes('async function resolveMutationAuthorization('), 'server must expose one mutation authorization boundary');
assert(server.includes('req.authorization = await resolveMutationAuthorization(req, action)'), 'mutation context must resolve trusted authorization evidence');
assert(server.includes('authorization: req.authorization'), 'mutation descriptor must carry the credential-free authorization snapshot');
assert(server.includes("provider === 'gitlab' ? glFetch(account, apiPath) : gh(account, apiPath)"), 'resolver requests must use server-side provider credentials');
assert(!server.includes('req.body.governanceRoles'), 'browser-supplied governance roles must never be trusted');
assert(!server.includes('req.body.repositoryAccess'), 'browser-supplied repository access must never be trusted');

assert(gateway.includes("require('./authorization-resolver')"), 'mutation gateway must validate authorization snapshots');
assert(gateway.includes('const authorization = normalizeAuthorizationSnapshot(input.authorization)'), 'gateway descriptor must normalize authorization evidence');
assert(gateway.includes('security: normalizeSecurity(input.security, definition),\n    authorization'), 'gateway descriptor must retain normalized authorization evidence');

console.log('authorization resolver server contract tests passed');
