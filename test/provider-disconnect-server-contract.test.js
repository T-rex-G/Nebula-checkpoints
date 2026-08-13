'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function routeBlock(routePath) {
  const marker = `app.post('${routePath}'`;
  const start = server.indexOf(marker);
  assert(start >= 0, `missing POST ${routePath}`);
  const next = server.indexOf('\napp.', start + marker.length);
  return server.slice(start, next < 0 ? server.length : next);
}

assert.match(server, /const \{ AlphaPrivacyStore \} = require\('\.\/src\/alpha-privacy-store'\)/);
assert.match(server, /const \{[^}]*disconnectProviderAccount[^}]*\} = require\('\.\/src\/provider-disconnect'\)/s);
assert(server.includes('new AlphaPrivacyStore({'), 'invite mode must construct the central privacy lifecycle store');
assert.match(server, /async function disconnectAlphaProviderAccount\(/);
const alphaRequestSessionStart = server.indexOf('async function readAlphaRequestSession(req)');
const alphaRequestSessionEnd = server.indexOf('\n}', alphaRequestSessionStart) + 2;
const alphaRequestSessionBlock = server.slice(alphaRequestSessionStart, alphaRequestSessionEnd);
assert(alphaRequestSessionBlock.includes('testerId'));
assert(alphaRequestSessionBlock.includes('session: { ...alphaSessionView(stored), testerId }'),
  'the private request context must retain tester ownership while public alpha projections stay redacted');

const removalRoutes = [
  '/api/accounts/remove',
  '/api/github-app/disconnect',
  '/api/logout',
  '/api/alpha/providers/disconnect-all',
  '/api/alpha/delete'
];
for (const routePath of removalRoutes) {
  const block = routeBlock(routePath);
  assert(block.includes('await disconnectAlphaProviderAccount('), `${routePath} must use the central disconnect boundary`);
  assert(block.indexOf('await disconnectAlphaProviderAccount(') < block.indexOf('providerDisconnectPending('),
    `${routePath} must return pending cleanup before local completion`);
  assert(!block.includes('.splice('), `${routePath} must not remove local account state before verified provider cleanup`);
  assert(!block.includes('removeGithubAppInstallation('), `${routePath} must not reorder installation deletion outside finalization`);
  assert(!block.includes('markProviderIdentityDisconnected('), `${routePath} must not split the atomic finalization transition`);
}
assert.strictEqual(
  (server.match(/await disconnectAlphaProviderAccount\(/g) || []).length,
  5,
  'only the five approved routes may invoke the central account disconnect helper'
);

const helperStart = server.indexOf('async function disconnectAlphaProviderAccount(');
const helperEnd = server.indexOf('async function addAccount(', helperStart);
const helper = server.slice(helperStart, helperEnd);
assert(helper.includes('disconnectProviderAccount({'));
assert(helper.includes('enumerateProviderWebhooks'));
assert(helper.includes('removeProviderWebhook'));
assert(helper.includes('readProviderWebhook'));
assert(helper.includes('alphaPrivacyStore.prepareProviderDisconnect'));
assert(helper.includes('alphaPrivacyStore.completeProviderWebhookCleanup'));
assert(!helper.includes('removeLocalWebhookRecord'),
  'provider proof and local webhook/evidence completion must not be split across transactions');
assert(helper.includes('alphaPrivacyStore.finalizeProviderDisconnect'));
assert(helper.includes('providerHookId: row.provider_hook_id'),
  'database inventory must be normalized before immutable resource hashing');
assert(helper.includes('return { verifiedAbsent: false };'),
  'a successful provider DELETE must still require the supported readback proof');

const liveConnectBlock = server.slice(
  server.indexOf("app.post('/api/repo/:owner/:repo/live-events/connect'"),
  server.indexOf("app.delete('/api/repo/:owner/:repo/live-events'", server.indexOf("app.post('/api/repo/:owner/:repo/live-events/connect'"))
);
assert(liveConnectBlock.includes('alpha_resource_key_hash'));
assert(liveConnectBlock.includes('alphaPrivacyStore.claimProviderWebhookOwnership'));
const liveDeleteStart = server.indexOf("app.delete('/api/repo/:owner/:repo/live-events'");
const liveDeleteEnd = server.indexOf('\napp.', liveDeleteStart + 10);
const liveDeleteBlock = server.slice(liveDeleteStart, liveDeleteEnd);
assert(liveDeleteBlock.includes('alphaPrivacyStore.createCleanupTask'));
assert(liveDeleteBlock.includes('alphaPrivacyStore.inspectProviderWebhookCleanup'));
assert(liveDeleteBlock.includes('alphaPrivacyStore.completeProviderWebhookCleanup'));
assert(liveDeleteBlock.indexOf('inspectProviderWebhookCleanup')
  < liveDeleteBlock.indexOf("method: 'DELETE'"),
  'shared ownership must be decided under the lifecycle lock before provider deletion');
assert(liveDeleteBlock.includes('verifiedAbsent'),
  'exclusive direct removal must prove provider absence before atomic local completion');

const sessionOfStart = server.indexOf('async function sessionOf(req)');
const sessionOfEnd = server.indexOf('\n}', sessionOfStart) + 2;
const sessionOfBlock = server.slice(sessionOfStart, sessionOfEnd);
assert(sessionOfBlock.includes('readHostedProviderSession({'));
assert(sessionOfBlock.includes('testerId: req.alpha.testerId'));
assert(
  sessionOfBlock.indexOf('readHostedProviderSession({')
    < sessionOfBlock.indexOf("pool().query('SELECT data FROM nv_sessions WHERE sid=$1'"),
  'invite-mode cookie authentication must prove tester ownership and return before the legacy raw SID lookup'
);

const setSessionStart = server.indexOf('async function setSession(req, res, data)');
const setSessionEnd = server.indexOf('\n}', setSessionStart) + 2;
const setSessionBlock = server.slice(setSessionStart, setSessionEnd);
assert(setSessionBlock.includes('mutateHostedProviderSession({'));
assert(setSessionBlock.includes('recomputeHostedSessionMutation('));
assert(setSessionBlock.includes('testerId: req.alpha.testerId'));

const addStart = server.indexOf('async function addAccount(');
const addEnd = server.indexOf('\n}', addStart) + 2;
const addBlock = server.slice(addStart, addEnd);
assert(addBlock.includes('connectHostedProviderAccount({'));
assert(addBlock.includes('? stableProviderIdentityKey(account)'));
assert(addBlock.indexOf('capacity: ACCOUNT_CAP()') < addBlock.indexOf('connectHostedProviderAccount({') + 500,
  'capacity must be part of the atomic connection transaction');

const stableIdentityStart = server.indexOf('function stableProviderIdentityKey(');
const stableIdentityEnd = server.indexOf('\n}', stableIdentityStart) + 2;
const stableIdentityBlock = server.slice(stableIdentityStart, stableIdentityEnd);
assert(stableIdentityBlock.includes('installationId'));
assert(stableIdentityBlock.includes('installationAccountId'));
assert(stableIdentityBlock.includes("domain: 'nv-alpha-provider-identity/github-app/v1'"));
assert(!stableIdentityBlock.includes('authorizedById'),
  'GitHub App identity must be installation-stable across testers and authorizers');

const sessionInventoryStart = server.indexOf('async function sessionsForIdentity(req)');
const sessionInventoryEnd = server.indexOf('\n}', sessionInventoryStart) + 2;
const sessionInventoryBlock = server.slice(sessionInventoryStart, sessionInventoryEnd);
assert(sessionInventoryBlock.includes('nv_alpha_provider_session_ownership'));
assert(sessionInventoryBlock.includes('req.alpha.testerId'));
assert(sessionInventoryBlock.includes('session_key_hash'),
  'hosted-alpha containment must scope sessions through tester-owned session hashes');

for (const routePath of [
  '/api/repo/:owner/:repo/emergency-manifest',
  '/api/security/revoke-others'
]) {
  const block = routeBlock(routePath);
  assert(block.includes('revokeContainedSessions'),
    `${routePath} must release provider-session ownership with hosted session deletion`);
  assert(!block.includes("pool().query('DELETE FROM nv_sessions"),
    `${routePath} must not leave active ownership rows behind`);
}
const containmentStart = server.indexOf('async function revokeContainedSessions(');
const containmentEnd = server.indexOf('\n}', containmentStart) + 2;
const containmentBlock = server.slice(containmentStart, containmentEnd);
assert(containmentBlock.includes('alphaPrivacyStore.revokeOwnedProviderSessions'));
assert(containmentBlock.indexOf('ALPHA_CONFIG.enabled')
  < containmentBlock.indexOf("pool().query('DELETE FROM nv_sessions"),
  'invite-mode containment must return through the ownership-aware store before legacy deletion');

const installationPersistenceStart = server.indexOf('async function persistGithubAppInstallation(');
const installationPersistenceEnd = server.indexOf('\n}', installationPersistenceStart) + 2;
const installationPersistenceBlock = server.slice(installationPersistenceStart, installationPersistenceEnd);
assert(installationPersistenceBlock.includes('if (ALPHA_CONFIG.enabled) return false;'),
  'invite mode must not copy raw GitHub installation metadata into the legacy table');
assert(server.includes('? connectedAccount.identityKey'));
assert(server.includes('? account.identityKey'));

const connectionViewStart = server.indexOf('function githubAppConnectionView(');
const connectionViewEnd = server.indexOf('\n}', connectionViewStart) + 2;
const connectionViewBlock = server.slice(connectionViewStart, connectionViewEnd);
assert(connectionViewBlock.includes('if (ALPHA_CONFIG.enabled)'));
assert(connectionViewBlock.indexOf('connectionKey: identityKey(account)')
  < connectionViewBlock.indexOf('installationId: Number(account.installationId)'),
  'invite-mode App responses must return the stable connection key before the legacy raw provider view');
for (const routePath of ['/api/github-app/refresh', '/api/github-app/disconnect']) {
  const block = routeBlock(routePath);
  assert(block.includes('requestedConnectionKey'));
  assert(block.includes('identityKey(item) === requestedConnectionKey'),
    `${routePath} must address invite-mode App state by the stable hashed connection key`);
}

const ghStart = server.indexOf('async function gh(');
const ghEnd = server.indexOf('\n}', ghStart) + 2;
const ghBlock = server.slice(ghStart, ghEnd);
assert(ghBlock.includes("!ALPHA_CONFIG.enabled && acct.authMethod === 'github-app'"),
  'invite-mode provider fallback must not invalidate shared broker state');
assert(ghBlock.includes("opts.redirect === 'manual' ? 'manual' : 'error'"));
assert(!ghBlock.includes("'follow'"), 'credential-bearing provider requests must never follow redirects');
const oauthCallbackStart = server.indexOf("app.get('/api/oauth/callback'");
const oauthCallbackBlock = server.slice(oauthCallbackStart, server.indexOf('\napp.', oauthCallbackStart + 1));
assert(oauthCallbackStart >= 0, 'missing GET /api/oauth/callback');
assert(oauthCallbackBlock.includes("redirect: 'error'"), 'OAuth token exchange must reject redirects');
assert.strictEqual(
  (server.match(/info\/lfs\/objects\/batch[\s\S]{0,700}redirect: 'error'/g) || []).length,
  2,
  'both authenticated LFS batch negotiations must reject redirects'
);
const refreshBlock = routeBlock('/api/github-app/refresh');
assert(refreshBlock.includes('if (!ALPHA_CONFIG.enabled) githubAppBroker.invalidate(installationId);'),
  'invite-mode refresh must not invalidate shared broker state');

assert.match(
  server,
  /function retainedActor\(req\) \{[\s\S]+ALPHA_CONFIG\.enabled && req\.alpha[\s\S]+alphaActorLabel\(req\.alpha\)[\s\S]+req\.gh && req\.gh\.login/
);
for (const forbidden of [
  'actor: req.gh.login',
  'actorLogin: req.gh.login',
  'created_by_login: req.gh.login'
]) assert(!server.includes(forbidden), `hosted-alpha persistence retains forbidden pattern: ${forbidden}`);

const githubAuditFields = server.slice(
  server.indexOf('function safeGithubAppAuditDetails'),
  server.indexOf('async function persistGithubAppInstallation')
);
assert(!githubAuditFields.includes("'accountLogin'"), 'GitHub App audits must not persist provider login');
assert(githubAuditFields.includes("'actor'"), 'GitHub App audits must retain only a pseudonymous actor when available');
for (const forbidden of [
  'accountLogin: installation.account.login',
  'accountLogin: removed.login',
  'accountLogin: account.login'
]) assert(!server.includes(forbidden), `GitHub App lifecycle audit retains provider login: ${forbidden}`);

assert(server.includes('actor: retainedActor(req)'), 'retained evidence must use the invite actor label');
assert(server.includes('retainedProviderActor('), 'background GitHub App audits need an identity-to-alpha-actor boundary');

console.log('provider disconnect server contract tests passed');
