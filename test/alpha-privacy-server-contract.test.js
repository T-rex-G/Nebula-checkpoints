'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const identityHttp = path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'identity-access', 'http');
/* The access session and its boundary, and the alpha's front-door routes, live in identity and access. */
const alphaSessions = fs.readFileSync(path.join(identityHttp, 'alpha-sessions.ts'), 'utf8');
const alphaAccessRoutes = fs.readFileSync(path.join(identityHttp, 'alpha-access-routes.ts'), 'utf8');
const functionBlock = (text, marker) => {
  const start = text.indexOf(marker);
  assert(start >= 0, `missing ${marker}`);
  return text.slice(start, text.indexOf('\n  }\n', start) + 4);
};

function routeBlock(method, routePath) {
  const marker = `app.${method}('${routePath}'`;
  const start = server.indexOf(marker);
  assert(start >= 0, `missing ${marker}`);
  const end = server.indexOf('\napp.', start + marker.length);
  return server.slice(start, end < 0 ? server.length : end);
}

{
  /* The server reaches identity and access through the module's index only. */
  const identityAccess = /const \{([^}]*)\} = require\('\.\/apps\/api\/src\/modules\/identity-access\/index\.ts'\)/.exec(server);
  assert(identityAccess, 'the server must load identity and access through its index');
  for (const name of ['alphaActorLabel', 'alphaRetentionPolicy', 'sanitizeFeedback', 'providerRevocationGuidance']) {
    assert.match(identityAccess[1], new RegExp(`\\b${name}\\b`), `the server must take ${name} from identity and access`);
  }
}

const privacy = routeBlock('get', '/api/alpha/privacy');
assert(privacy.includes("res.setHeader('Cache-Control', 'no-store')"));
assert(privacy.includes('termsVersion: ALPHA_CONFIG.termsVersion'));
assert(privacy.includes('retention: alphaRetentionPolicy()'));
assert(privacy.includes('retainedIntegrityMetadata: true'));
assert(privacy.includes('sourceContentUsedForAnalytics: false'));

const feedback = routeBlock('post', '/api/alpha/feedback');
assert(feedback.includes('alphaFeedbackInput'));
assert(feedback.includes('sanitizeFeedback'));
assert(feedback.includes('alphaPrivacyStore.recordFeedback'));
assert(feedback.indexOf('alphaFeedbackInput') < feedback.indexOf('sanitizeFeedback'));
assert(feedback.indexOf('sanitizeFeedback') < feedback.indexOf('recordFeedback'));
assert(!feedback.includes('description:'));
assert(feedback.includes('testerId: req.alpha.testerId'));
assert(feedback.includes('releaseVersion: APP_VERSION'));
assert(feedback.includes('occurredAt: sanitized.timestamp'));

const disconnectAll = routeBlock('post', '/api/alpha/providers/disconnect-all');
assert(disconnectAll.includes('disconnectAlphaProviderAccount'));
assert(disconnectAll.includes('revocationGuidance'));
assert(!disconnectAll.includes('installationId'));
assert(!disconnectAll.includes('providerHookId'));
assert(!disconnectAll.includes('token:'));

const deletion = routeBlock('post', '/api/alpha/delete');
assert.match(
  deletion,
  /^app\.post\('\/api\/alpha\/delete', alphaDeletionConfirmation, alphaDeletionAuthentication,/
);
assert(deletion.includes('disconnectAlphaProviderAccount'));
assert(deletion.includes('alphaPrivacyStore.createDeletionRequest'));
assert(deletion.includes('alphaPrivacyStore.purgeTester'));
assert(deletion.includes('alphaDeletionBlocked'));
assert(deletion.includes('clearProviderSessionCookie'));
assert(deletion.includes("alphaSessions.setCookie(res, '', 0)"));
assert(deletion.includes('...purge'));
assert(!deletion.includes('providerCleanupVerified: true'));
assert(!deletion.includes('tokenBearingStateRemoved: true'));
assert(deletion.includes('req.alpha.deletionRecovery === true'));
assert(deletion.includes('if (!recovery)'));
assert(deletion.indexOf('if (!recovery)') < deletion.indexOf('alphaPrivacyStore.purgeTester'),
  'terminal recovery must still enter the store purge/scrub path');
assert(deletion.indexOf('alphaPrivacyStore.purgeTester') < deletion.indexOf('clearProviderSessionCookie'),
  'owned token-bearing state must be scrubbed before the provider cookie is cleared');
assert(deletion.indexOf('clearProviderSessionCookie') < deletion.indexOf("alphaSessions.setCookie(res, '', 0)"),
  'terminal recovery must clear both provider and alpha cookies after the store succeeds');
assert(deletion.includes("res.setHeader('Set-Cookie', [providerCookie, alphaCookie])"));

const confirmation = server.slice(
  server.indexOf('function alphaDeletionConfirmation'),
  server.indexOf('\n}', server.indexOf('function alphaDeletionConfirmation')) + 2
);
assert(confirmation.includes("req.body.confirm !== 'DELETE ALPHA DATA'"));
assert(confirmation.includes("code: 'ALPHA_DELETION_CONFIRMATION_REQUIRED'"));

const blocked = server.slice(
  server.indexOf('function alphaDeletionBlocked'),
  server.indexOf('\n}', server.indexOf('function alphaDeletionBlocked')) + 2
);
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

const deletionAuth = server.slice(
  server.indexOf('function alphaDeletionAuthentication'),
  server.indexOf('\n}', server.indexOf('function alphaDeletionAuthentication')) + 2
);
assert(deletionAuth.includes('req.alpha.deletionRecovery === true'));
assert(deletionAuth.indexOf('deletionRecovery') < deletionAuth.indexOf('accountAuth'));

console.log('alpha privacy server contract tests passed');
