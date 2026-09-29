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

/*
 * Reading a public repository makes nobody its collaborator. The reader
 * access everyone has on one is accepted only by routes whose data is the
 * reader's own -- their audits and scans, keyed by identity -- and refused by
 * everything the repository's collaborators share.
 */
assert(/if \(isPublicReaderAccess\(context\.authorization\) && options\.publicRepositories !== true\)/.test(server), 'governance access must refuse public readers unless the route opts in');
assert(server.includes("code: 'GOVERNANCE_COLLABORATORS_ONLY'"), 'the refusal must say why');
const ownWork = [...server.matchAll(/^app\.(get|post|put|patch|delete)\('([^']+)'[^\n]*governanceAccess\('reader', OWN_WORK\)/gm)].map(match => `${match[1].toUpperCase()} ${match[2]}`).sort();
assert.deepStrictEqual(ownWork, [
  'GET /api/repo/:owner/:repo/code-audit/history',
  'GET /api/repo/:owner/:repo/code-audit/history/:auditId',
  'GET /api/repo/:owner/:repo/code-audit/watch',
  'GET /api/repo/:owner/:repo/exposure/findings',
  'GET /api/repo/:owner/:repo/exposure/findings/:fingerprint/readability-probes',
  'GET /api/repo/:owner/:repo/exposure/findings/:fingerprint/verifications',
  'GET /api/repo/:owner/:repo/exposure/scans',
  'GET /api/repo/:owner/:repo/exposure/scans/:scanId',
  'GET /api/repo/:owner/:repo/exposure/scans/:scanId/observations',
  'POST /api/repo/:owner/:repo/code-audit/history/clear',
  'POST /api/repo/:owner/:repo/exposure/clear',
  'POST /api/repo/:owner/:repo/exposure/scans',
  'POST /api/repo/:owner/:repo/exposure/scans/:scanId/cancel'
], 'exactly the identity-scoped routes accept a public reader');
assert.strictEqual((server.match(/OWN_WORK/g) || []).length, ownWork.length + 1, 'OWN_WORK is used nowhere else');
for (const line of server.split('\n').filter(text => /^app\.\w+\('\/api\/repo\/:owner\/:repo\/governance/.test(text))) {
  assert(!line.includes('OWN_WORK'), `governance is collaborators' business: ${line.slice(0, 90)}`);
}
for (const action of ['verify', 'probe-readability', 'accept-risk']) {
  const line = server.split('\n').find(text => text.includes(`/exposure/findings/:fingerprint/${action}'`) && text.startsWith('app.post('));
  assert(line && line.includes("governanceAccess('administrator')") && !line.includes('OWN_WORK'), `${action} stays with administrators`);
}

console.log('authorization resolver server contract tests passed');
