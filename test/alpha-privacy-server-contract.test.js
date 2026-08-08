'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function routeBlock(method, routePath) {
  const marker = `app.${method}('${routePath}'`;
  const start = server.indexOf(marker);
  assert(start >= 0, `missing ${marker}`);
  const end = server.indexOf('\napp.', start + marker.length);
  return server.slice(start, end < 0 ? server.length : end);
}

assert.match(
  server,
  /const \{ alphaActorLabel, alphaRetentionPolicy, sanitizeFeedback \} = require\('\.\/src\/alpha-privacy'\)/
);

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
assert(deletion.includes("setAlphaCookie(res, '', 0)"));
assert(deletion.includes('...purge'));
assert(!deletion.includes('providerCleanupVerified: true'));
assert(!deletion.includes('tokenBearingStateRemoved: true'));
assert(deletion.includes('req.alpha.deletionRecovery === true'));
assert(deletion.includes('if (!recovery)'));

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

const recoveryStart = server.indexOf('function readAlphaDeletionRecovery');
assert(recoveryStart >= 0, 'missing encrypted deletion-recovery boundary');
const recovery = server.slice(recoveryStart, server.indexOf('\n}', recoveryStart) + 2);
assert(recovery.includes("alphaRequestKey(req) !== 'POST /api/alpha/delete'"));
assert(recovery.includes("req.body.confirm !== 'DELETE ALPHA DATA'"));
assert(recovery.includes("getCookie(req, ALPHA_COOKIE)"));
assert(recovery.includes('deletionRecovery: true'));

const accessBoundary = server.slice(
  server.indexOf('async function alphaAccessBoundary'),
  server.indexOf('\n}', server.indexOf('async function alphaAccessBoundary')) + 2
);
assert(accessBoundary.includes('readAlphaDeletionRecovery(req)'));
assert(accessBoundary.includes('req.alpha = recovery'));

const redemption = routeBlock('post', '/api/alpha/redeem');
assert(redemption.includes('seal({ alphaSid: redeemed.sessionId, testerId })'));

const deletionAuth = server.slice(
  server.indexOf('function alphaDeletionAuthentication'),
  server.indexOf('\n}', server.indexOf('function alphaDeletionAuthentication')) + 2
);
assert(deletionAuth.includes('req.alpha.deletionRecovery === true'));
assert(deletionAuth.indexOf('deletionRecovery') < deletionAuth.indexOf('accountAuth'));

console.log('alpha privacy server contract tests passed');
