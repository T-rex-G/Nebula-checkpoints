'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { locations } = require('./oracles/route-policy');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/* A POST route's registration up to the next one, in whichever file the route policy found it. */
const policyRoutes = locations(path.join(__dirname, '..')).filter(entry => entry.kind === 'route');
function routeBlock(routePath) {
  const entry = policyRoutes.find(item => item.method === 'POST' && item.path === routePath);
  assert(entry, `missing POST ${routePath}`);
  const file = entry.at.split(':')[0];
  const text = file === 'server.js' ? server : fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const marker = `app.post('${routePath}'`;
  const start = text.indexOf(marker);
  assert(start >= 0, `missing POST ${routePath} in ${file}`);
  const next = text.slice(start + marker.length).search(/\n\s*app\./);
  return next < 0 ? text.slice(start) : text.slice(start, start + marker.length + next);
}

/* The server reaches identity and access through the module's index only. */
const identityAccess = /const \{([^}]*)\} = require\('\.\/apps\/api\/src\/modules\/identity-access\/index\.ts'\)/.exec(server);
assert(identityAccess, 'the server must load identity and access through its index');
assert.match(identityAccess[1], /\bAlphaPrivacyStore\b/);
assert.match(identityAccess[1], /\bdisconnectProviderAccount\b/);
assert(server.includes('new AlphaPrivacyStore({'), 'invite mode must construct the central privacy lifecycle store');
assert.match(server, /async function disconnectAlphaProviderAccount\(/);
const alphaSessions = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'http', 'alpha-sessions.ts'), 'utf8');
const alphaRequestSessionStart = alphaSessions.indexOf('async function readRequestSession(req: Request)');
assert(alphaRequestSessionStart >= 0, 'missing the access session reader');
const alphaRequestSessionEnd = alphaSessions.indexOf('\n  }\n', alphaRequestSessionStart) + 4;
const alphaRequestSessionBlock = alphaSessions.slice(alphaRequestSessionStart, alphaRequestSessionEnd);
assert(alphaRequestSessionBlock.includes('testerId'));
assert(alphaRequestSessionBlock.includes('session: { ...sessionView(stored), testerId }'),
  'the private request context must retain tester ownership while public alpha projections stay redacted');

const removalRoutes = [
  '/api/accounts/remove',
  '/api/github-app/disconnect',
  '/api/logout',
  '/api/alpha/providers/disconnect-all',
  '/api/alpha/delete'
];
/* The central disconnect, as the server calls it and as identity and access's routes are handed it. */
const disconnectCall = /await (?:disconnectAlphaProviderAccount|deps\.disconnectProviderAccounts)\(/;
assert.strictEqual((server.match(/disconnectProviderAccounts: disconnectAlphaProviderAccount\b/g) || []).length, 3,
  'identity and access\'s account, alpha and GitHub App disconnect routes must be handed the central disconnect helper');
for (const routePath of removalRoutes) {
  const block = routeBlock(routePath);
  const call = disconnectCall.exec(block);
  assert(call, `${routePath} must use the central disconnect boundary`);
  assert(call.index < block.indexOf('providerDisconnectPending('),
    `${routePath} must return pending cleanup before local completion`);
  assert(!block.includes('.splice('), `${routePath} must not remove local account state before verified provider cleanup`);
  assert(!block.includes('removeGithubAppInstallation('), `${routePath} must not reorder installation deletion outside finalization`);
  assert(!block.includes('markProviderIdentityDisconnected('), `${routePath} must not split the atomic finalization transition`);
}
{
  /* The remove route may call it twice (the account, then retired leftovers); no other route may call it at all. */
  const identityHttp = path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'http');
  let outside = [server, ...fs.readdirSync(identityHttp).map(file => fs.readFileSync(path.join(identityHttp, file), 'utf8'))].join('\n');
  for (const routePath of removalRoutes) outside = outside.replace(routeBlock(routePath), '');
  assert.strictEqual((outside.match(/await (?:disconnectAlphaProviderAccount|deps\.disconnectProviderAccounts)\(/g) || []).length, 0,
    'only the five approved routes may invoke the central account disconnect helper');
}

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
assert(helper.includes('recordPendingEvidence') && helper.includes('alphaPrivacyStore.createCleanupTask'),
  'a retired account leaves recorded manual-cleanup evidence, not silence');
assert(helper.includes("result.reasonCode === RETIRED_CLEANUP"),
  'a retired account does not stop the GitHub accounts after it from being disconnected');
const logoutBlock = routeBlock('/api/logout');
assert(logoutBlock.includes('cleanup.supportedComplete') && logoutBlock.includes('cleanup.manualCleanup'),
  'sign-out completes once supported accounts are disconnected, and names what must be revoked by hand');
assert(!logoutBlock.includes('githubSession('), 'sign-out sees every account in the session, retired ones included');
assert(helper.includes('providerHookId: row.provider_hook_id'),
  'database inventory must be normalized before immutable resource hashing');
assert(helper.includes('return { verifiedAbsent: false };'),
  'a successful provider DELETE must still require the supported readback proof');

/*
 * The live-event webhook's alpha lifecycle -- claimed on connect, and on
 * disconnect ownership decided before any provider deletion, with a read-back
 * proving it gone -- is held by test/pulsar-live-event-routes.test.js.
 */

/* The provider session store is identity and access's (application/provider-sessions.ts). */
const sessions = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'application', 'provider-sessions.ts'), 'utf8');
const nested = (text, start) => {
  const at = text.indexOf(start);
  assert(at >= 0, start);
  return text.slice(at, text.indexOf('\n  }\n', at) + 5);
};
const sessionOfBlock = nested(sessions, 'async function sessionOf(req: SessionRequest,');
assert(sessionOfBlock.includes('readHostedProviderSession({'));
assert(sessionOfBlock.includes('testerId: req.alpha.testerId'));
assert(
  sessionOfBlock.indexOf('readHostedProviderSession({')
    < sessionOfBlock.indexOf("deps.pool().query('SELECT data FROM nv_sessions WHERE sid=$1'"),
  'invite-mode cookie authentication must prove tester ownership and return before the legacy raw SID lookup'
);

const setSessionBlock = nested(sessions, 'async function setSession(req: SessionRequest, res: unknown, input');
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

const accountIdentity = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'domain', 'account-identity.ts'), 'utf8');
const stableIdentityStart = accountIdentity.indexOf('export function stableProviderIdentityKey(');
const stableIdentityEnd = accountIdentity.indexOf('\n}', stableIdentityStart) + 2;
assert(stableIdentityStart >= 0);
const stableIdentityBlock = accountIdentity.slice(stableIdentityStart, stableIdentityEnd);
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
/* The App connection's routes and its view are identity and access's. */
const appRoutes = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'http', 'github-app-routes.ts'), 'utf8');
assert(appRoutes.includes('? connectedAccount.identityKey'));
assert(appRoutes.includes('? account.identityKey'));

const connectionViewStart = appRoutes.indexOf('return function githubAppConnectionView(');
const connectionViewEnd = appRoutes.indexOf('\n  };\n', connectionViewStart) + 5;
assert(connectionViewStart >= 0, 'missing the App connection view');
const connectionViewBlock = appRoutes.slice(connectionViewStart, connectionViewEnd);
assert(connectionViewBlock.includes('if (deps.config.enabled)'));
assert(connectionViewBlock.indexOf('connectionKey: deps.identityKey(account)')
  < connectionViewBlock.indexOf('installationId: Number(account.installationId)'),
  'invite-mode App responses must return the stable connection key before the legacy raw provider view');
assert(server.includes('const githubAppConnectionView = createGithubAppConnectionView({ config: ALPHA_CONFIG, identityKey });'),
  'the server must show App connections through identity and access\'s view');
const addressing = appRoutes.slice(appRoutes.indexOf('const addressed = (req: Request) => {'), appRoutes.indexOf("app.post('/api/github-app/connect'"));
assert(addressing.includes('deps.identityKey(item) === requestedConnectionKey'),
  'invite-mode App state must be addressed by the stable hashed connection key');
for (const routePath of ['/api/github-app/refresh', '/api/github-app/disconnect']) {
  const block = routeBlock(routePath);
  assert(block.includes('addressed(req)'), `${routePath} must address invite-mode App state by the stable hashed connection key`);
}

/* GitHub's REST client is the provider's (github-provider/client/github-rest.ts); the server says whether this is the alpha. */
const rest = fs.readFileSync(path.join(__dirname, '..', 'apps/api/src/modules/github-provider/client/github-rest.ts'), 'utf8');
const ghStart = rest.indexOf('  async function gh(');
const ghEnd = rest.indexOf('\n  }\n', ghStart) + 4;
assert(ghStart >= 0);
const ghBlock = rest.slice(ghStart, ghEnd);
assert(ghBlock.includes("!deps.alphaEnabled && acct.authMethod === 'github-app'") && server.includes('alphaEnabled: ALPHA_CONFIG.enabled'),
  'invite-mode provider fallback must not invalidate shared broker state');
assert(ghBlock.includes("options.redirect === 'manual' ? 'manual' : 'error'"));
assert(!ghBlock.includes("'follow'"), 'credential-bearing provider requests must never follow redirects');
/* OAuth sign-in is identity and access's; its callback is the last route in its file. */
const oauthRoutes = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'http', 'oauth-routes.ts'), 'utf8');
const oauthCallbackStart = oauthRoutes.indexOf("app.get('/api/oauth/callback'");
assert(oauthCallbackStart >= 0, 'missing GET /api/oauth/callback');
const oauthCallbackBlock = oauthRoutes.slice(oauthCallbackStart);
assert(oauthCallbackBlock.includes("redirect: 'error'"), 'OAuth token exchange must reject redirects');
/* Both LFS exchanges, the URL validator, the download and the upload are the workbench's LFS transfer. */
const lfsTransfer = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'workbench', 'application', 'lfs.ts'), 'utf8');
assert(!server.includes('info/lfs/objects/batch'), 'LFS negotiations belong to the workbench, not server.js');
assert.strictEqual(
  (lfsTransfer.match(/info\/lfs\/objects\/batch[\s\S]{0,700}redirect: 'error'/g) || []).length,
  2,
  'both authenticated LFS batch negotiations must reject redirects'
);
const lfsUrlHelperStart = lfsTransfer.indexOf('export function requireHttpsLfsActionUrl(');
const lfsUrlHelperEnd = lfsTransfer.indexOf('\n}', lfsUrlHelperStart) + 2;
assert(lfsUrlHelperStart >= 0, 'missing HTTPS-only LFS action URL validator');
const lfsUrlHelper = lfsTransfer.slice(lfsUrlHelperStart, lfsUrlHelperEnd);
assert(lfsUrlHelper.includes("target.protocol !== 'https:'"));
assert(lfsUrlHelper.includes('target.username || target.password'));
const lfsBlock = (start, label) => {
  const at = lfsTransfer.indexOf(start);
  assert(at >= 0, `missing the LFS ${label}`);
  return lfsTransfer.slice(at, lfsTransfer.indexOf('\n  }', at) + 4);
};
const lfsDownloadBlock = lfsBlock('async function downloadStream(', 'download');
assert(lfsDownloadBlock.includes("requireHttpsLfsActionUrl(member(act, 'href'), 'download')"));
assert(lfsDownloadBlock.includes('deps.fetch(downloadUrl,'));
const lfsUploadBlock = lfsBlock('async function upload(', 'upload');
for (const expected of [
  "requireHttpsLfsActionUrl(member(uploadAction, 'href'), 'upload')",
  "requireHttpsLfsActionUrl(member(verify, 'href'), 'verification')",
  'deps.fetch(uploadUrl,',
  'deps.fetch(verifyUrl,'
]) assert(lfsUploadBlock.includes(expected), `LFS upload boundary missing ${expected}`);
const refreshBlock = routeBlock('/api/github-app/refresh');
assert(refreshBlock.includes('if (!deps.config.enabled) broker().invalidate(installationId);'),
  'invite-mode refresh must not invalidate shared broker state');

/* The ledger's actor is identity and access's repository access, composed by the server with the alpha's flag. */
assert.match(
  fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'application', 'repository-access.ts'), 'utf8'),
  /function retainedActor\(req[^)]*\)[^{]*\{[\s\S]+deps\.alphaEnabled && req\.alpha[\s\S]+alphaActorLabel\(req\.alpha\)[\s\S]+req\.gh && req\.gh\.login/
);
assert(server.includes('createRepositoryAccess({\n  alphaEnabled: ALPHA_CONFIG.enabled,'), 'the server gives the guards the alpha\'s flag');
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
