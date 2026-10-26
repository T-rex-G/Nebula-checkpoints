'use strict';

const assert = require('assert');
const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const governanceRoutes = fs.readFileSync('apps/api/src/modules/kepler/http/governance-routes.ts', 'utf8');
/* Every route with its guard chain, as the route policy reads them from server.js and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(process.cwd()).filter(entry => entry.kind === 'route');
const coverage = fs.readFileSync('apps/api/src/platform/mutation-gateway/mutation-coverage.ts', 'utf8');
/* The gateway's action catalogue is the mutation contract's (packages/contracts/src/mutation.ts). */
const { MUTATION_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const registered = action => Object.hasOwn(MUTATION_ACTIONS, action);

const kepler = /const \{([^}]*)\} = require\('\.\/apps\/api\/src\/modules\/kepler\/index\.ts'\)/.exec(server);
assert(kepler && /\bstartWebhookWorker\b/.test(kepler[1]), 'server must load the webhook worker through the Kepler index');
assert(server.includes('startWebhookWorker'));
const route = (method, routePath) => {
  const entry = policyRoutes.find(candidate => candidate.method === method && candidate.path === routePath);
  assert(entry, `missing ${method} ${routePath}`);
  assert(entry.at.startsWith('apps/api/src/modules/kepler/http/governance-routes.ts:'), `${method} ${routePath} must be registered by Kepler`);
  return entry;
};
for (const [method, routePath, action] of [
  ['GET', '/api/repo/:owner/:repo/governance/notifications'],
  ['GET', '/api/repo/:owner/:repo/governance/notifications/preferences'],
  ['PUT', '/api/repo/:owner/:repo/governance/notifications/preferences', 'governance.notification.preferences.update'],
  ['POST', '/api/repo/:owner/:repo/governance/notifications/read', 'governance.notification.read'],
  ['GET', '/api/repo/:owner/:repo/governance/webhooks'],
  ['POST', '/api/repo/:owner/:repo/governance/webhooks', 'governance.webhook.create'],
  ['PATCH', '/api/repo/:owner/:repo/governance/webhooks/:webhookId', 'governance.webhook.update'],
  ['POST', '/api/repo/:owner/:repo/governance/webhooks/:webhookId/rotate-secret', 'governance.webhook.rotate'],
  ['DELETE', '/api/repo/:owner/:repo/governance/webhooks/:webhookId', 'governance.webhook.delete'],
  ['GET', '/api/repo/:owner/:repo/governance/webhooks/:webhookId/deliveries'],
  ['GET', '/api/repo/:owner/:repo/governance/exports'],
  ['POST', '/api/repo/:owner/:repo/governance/exports', 'governance.audit.export.create'],
  ['GET', '/api/repo/:owner/:repo/governance/exports/:exportId'],
  ['GET', '/api/repo/:owner/:repo/governance/exports/:exportId/verify']
]) {
  const { guards } = route(method, routePath);
  if (!action) continue;
  assert(registered(action), `gateway missing ${action}`);
  assert(coverage.includes(`'${action}'`), `coverage missing ${action}`);
  assert(guards.includes(`governanceMutationContext('${action}')`), `${method} ${routePath} missing gateway context ${action}`);
}
assert(governanceRoutes.includes("res.setHeader('Content-Disposition'"), 'an export download must name its attachment');
assert(server.includes('governanceWebhookWorker.stop()'));
console.log('governance delivery server contract tests passed');
