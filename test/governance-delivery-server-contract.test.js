'use strict';

const assert = require('assert');
const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const coverage = fs.readFileSync('apps/api/src/platform/mutation-gateway/mutation-coverage.ts', 'utf8');
/* The gateway's action catalogue is the mutation contract's (packages/contracts/src/mutation.ts). */
const { MUTATION_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const registered = action => Object.hasOwn(MUTATION_ACTIONS, action);

const kepler = /const \{([^}]*)\} = require\('\.\/apps\/api\/src\/modules\/kepler\/index\.ts'\)/.exec(server);
assert(kepler && /\bstartWebhookWorker\b/.test(kepler[1]), 'server must load the webhook worker through the Kepler index');
assert(server.includes('startWebhookWorker'));
for (const route of [
  "app.get('/api/repo/:owner/:repo/governance/notifications'",
  "app.get('/api/repo/:owner/:repo/governance/notifications/preferences'",
  "app.put('/api/repo/:owner/:repo/governance/notifications/preferences'",
  "app.post('/api/repo/:owner/:repo/governance/notifications/read'",
  "app.get('/api/repo/:owner/:repo/governance/webhooks'",
  "app.post('/api/repo/:owner/:repo/governance/webhooks'",
  "app.patch('/api/repo/:owner/:repo/governance/webhooks/:webhookId'",
  "app.post('/api/repo/:owner/:repo/governance/webhooks/:webhookId/rotate-secret'",
  "app.delete('/api/repo/:owner/:repo/governance/webhooks/:webhookId'",
  "app.get('/api/repo/:owner/:repo/governance/webhooks/:webhookId/deliveries'",
  "app.get('/api/repo/:owner/:repo/governance/exports'",
  "app.post('/api/repo/:owner/:repo/governance/exports'",
  "app.get('/api/repo/:owner/:repo/governance/exports/:exportId'",
  "app.get('/api/repo/:owner/:repo/governance/exports/:exportId/verify'"
]) assert(server.includes(route), `missing ${route}`);
for (const action of [
  'governance.notification.preferences.update', 'governance.notification.read',
  'governance.webhook.create', 'governance.webhook.update', 'governance.webhook.rotate', 'governance.webhook.delete',
  'governance.audit.export.create'
]) {
  assert(registered(action), `gateway missing ${action}`);
  assert(coverage.includes(`'${action}'`), `coverage missing ${action}`);
  assert(server.includes(`governanceMutationContext('${action}')`), `server missing gateway context ${action}`);
}
assert(server.includes("res.setHeader('Content-Disposition'"));
assert(server.includes('governanceWebhookWorker.stop()'));
console.log('governance delivery server contract tests passed');
