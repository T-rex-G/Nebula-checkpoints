'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const identityHttp = path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'http');
/* The access session and its boundary, and the alpha's front-door routes, live in identity and access. */
const alphaSessions = fs.readFileSync(path.join(identityHttp, 'alpha-sessions.ts'), 'utf8');
const alphaAccessRoutes = fs.readFileSync(path.join(identityHttp, 'alpha-access-routes.ts'), 'utf8');
/* A tester's own data -- the notice, feedback, disconnecting every provider and deletion -- is identity and access's too. */
const lifecycle = fs.readFileSync(path.join(identityHttp, 'alpha-lifecycle-routes.ts'), 'utf8');
/* A function's text: a nested one ends at its own indentation, a top-level one at the margin. */
const functionBlock = (text, marker) => {
  const start = text.indexOf(marker);
  assert(start >= 0, `missing ${marker}`);
  const indent = /[ ]*$/.exec(text.slice(text.lastIndexOf('\n', start) + 1, start))[0];
  return text.slice(start, text.indexOf(`\n${indent}}\n`, start) + indent.length + 3);
};

function routeBlock(method, routePath) {
  const marker = `app.${method}('${routePath}'`;
  const start = lifecycle.indexOf(marker);
  assert(start >= 0, `missing ${marker}`);
  const next = lifecycle.slice(start + marker.length).search(/\n\s*app\./);
  return next < 0 ? lifecycle.slice(start) : lifecycle.slice(start, start + marker.length + next);
}

{
  /* The server reaches identity and access through the module's index only; the routes take the privacy policy from its domain. */
  const identityAccess = /const \{([^}]*)\} = require\('\.\/apps\/api\/src\/modules\/identity-access\/index\.ts'\)/.exec(server);
  assert(identityAccess, 'the server must load identity and access through its index');
  for (const name of ['alphaActorLabel', 'providerRevocationGuidance', 'registerAlphaPrivacyRoutes', 'registerAlphaDisconnectRoutes']) {
    assert.match(identityAccess[1], new RegExp(`\\b${name}\\b`), `the server must take ${name} from identity and access`);
  }
  assert(lifecycle.includes("import { alphaRetentionPolicy, sanitizeFeedback } from '../domain/alpha-privacy.ts';"));
  assert.match(server, /registerAlphaPrivacyRoutes\(app, \{ config: ALPHA_CONFIG, privacyStore: alphaPrivacyStore, releaseVersion: APP_VERSION \}\);/);
  assert.match(server, /registerAlphaDisconnectRoutes\(app, \{\s+config: ALPHA_CONFIG, privacyStore: alphaPrivacyStore, accountAuth, fail, sessions: alphaSessions,\s+disconnectProviderAccounts: disconnectAlphaProviderAccount, clearProviderSessionCookie\s+\}\);/);
}

const privacy = routeBlock('get', '/api/alpha/privacy');
assert(privacy.includes("res.setHeader('Cache-Control', 'no-store')"));
assert(privacy.includes('termsVersion: deps.config.termsVersion'));
assert(privacy.includes('retention: alphaRetentionPolicy()'));
assert(privacy.includes('retainedIntegrityMetadata: true'));
assert(privacy.includes('sourceContentUsedForAnalytics: false'));

const feedback = routeBlock('post', '/api/alpha/feedback');
assert(feedback.includes('alphaFeedbackInput'));
assert(feedback.includes('sanitizeFeedback'));
assert(feedback.includes('deps.privacyStore.recordFeedback'));
assert(feedback.indexOf('alphaFeedbackInput') < feedback.indexOf('sanitizeFeedback'));
assert(feedback.indexOf('sanitizeFeedback') < feedback.indexOf('recordFeedback'));
assert(!feedback.includes('description:'));
assert(feedback.includes('testerId: testerOf(req)'));
assert(lifecycle.includes("const testerOf = (req: Request): unknown => member(Reflect.get(req, 'alpha'), 'testerId');"));
assert(feedback.includes('releaseVersion: deps.releaseVersion'));
assert(feedback.includes('occurredAt: sanitized.timestamp'));

const disconnectAll = routeBlock('post', '/api/alpha/providers/disconnect-all');
assert(disconnectAll.includes('deps.disconnectProviderAccounts'));
assert(disconnectAll.includes('revocationGuidance'));
assert(!disconnectAll.includes('installationId'));
assert(!disconnectAll.includes('providerHookId'));
assert(!disconnectAll.includes('token:'));

const deletion = routeBlock('post', '/api/alpha/delete');
assert.match(
  deletion,
  /^app\.post\('\/api\/alpha\/delete', alphaDeletionConfirmation, alphaDeletionAuthentication,/
);
assert(deletion.includes('deps.disconnectProviderAccounts'));
assert(deletion.includes('privacyStore().createDeletionRequest'));
assert(deletion.includes('deps.privacyStore.purgeTester'));
assert(deletion.includes('alphaDeletionBlocked'));
assert(deletion.includes('clearProviderSessionCookie'));
assert(deletion.includes("deps.sessions.setCookie(res, '', 0)"));
assert(deletion.includes('...Object(purge)'));
assert(!deletion.includes('providerCleanupVerified: true'));
assert(!deletion.includes('tokenBearingStateRemoved: true'));
assert(deletion.includes("member(Reflect.get(req, 'alpha'), 'deletionRecovery') === true"));
assert(deletion.includes('if (!recovery)'));
assert(deletion.indexOf('if (!recovery)') < deletion.indexOf('deps.privacyStore.purgeTester'),
  'terminal recovery must still enter the store purge/scrub path');
assert(deletion.indexOf('deps.privacyStore.purgeTester') < deletion.indexOf('clearProviderSessionCookie'),
  'owned token-bearing state must be scrubbed before the provider cookie is cleared');
assert(deletion.indexOf('clearProviderSessionCookie') < deletion.indexOf("deps.sessions.setCookie(res, '', 0)"),
  'terminal recovery must clear both provider and alpha cookies after the store succeeds');
assert(deletion.includes("res.setHeader('Set-Cookie', [providerCookie, alphaCookie] as string[])"));

const confirmation = functionBlock(lifecycle, 'function alphaDeletionConfirmation(');
assert(confirmation.includes("member(req.body, 'confirm') !== 'DELETE ALPHA DATA'"));
assert(confirmation.includes("code: 'ALPHA_DELETION_CONFIRMATION_REQUIRED'"));

const blocked = functionBlock(lifecycle, 'function alphaDeletionBlocked(');
assert(blocked.includes('.status(409)'));
assert(blocked.includes("code: 'ALPHA_DELETION_BLOCKED'"));
assert(!blocked.includes('blockedCleanupIds'));
assert(!blocked.includes('cleanupId'));

const recovery = functionBlock(alphaSessions, 'function readDeletionRecovery(req: Request)');
assert(recovery.includes("requestKey(req) !== 'POST /api/alpha/delete'"), 'missing encrypted deletion-recovery boundary');
assert(recovery.includes("member(req.body, 'confirm') !== 'DELETE ALPHA DATA'"));
assert(recovery.includes('deps.getCookie(req, ALPHA_COOKIE)'));
assert(recovery.includes('deletionRecovery: true'));

const accessBoundary = functionBlock(alphaSessions, 'async function alphaAccessBoundary(');
assert(accessBoundary.includes('readDeletionRecovery(req)'));
assert(accessBoundary.includes("Reflect.set(req, 'alpha', recovery)"));
assert.match(server, /registerAlphaAccessRoutes\(app, \{ sessions: alphaSessions,/, 'the server must register the alpha boundary from identity and access');

const redemptionStart = alphaAccessRoutes.indexOf("app.post('/api/alpha/redeem'");
assert(redemptionStart >= 0, 'missing the redemption route');
const redemption = alphaAccessRoutes.slice(redemptionStart, alphaAccessRoutes.indexOf("app.post('/api/alpha/end'", redemptionStart));
assert(redemption.includes('deps.seal({ alphaSid: sessionId, testerId })'));

const deletionAuth = functionBlock(lifecycle, 'function alphaDeletionAuthentication(');
assert(deletionAuth.includes("member(alpha, 'deletionRecovery') === true"));
assert(deletionAuth.indexOf('deletionRecovery') < deletionAuth.indexOf('accountAuth'));

console.log('alpha privacy server contract tests passed');
