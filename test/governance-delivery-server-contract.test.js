'use strict';

const assert = require('assert');
const fs = require('fs');
const governanceRoutes = fs.readFileSync('apps/api/src/modules/kepler/http/governance-routes.ts', 'utf8');
/* Every route with its guard chain, as the route policy reads them from the composition root and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(process.cwd()).filter(entry => entry.kind === 'route');
const coverage = fs.readFileSync('apps/api/src/platform/mutation-gateway/mutation-coverage.ts', 'utf8');
/* The gateway's action catalogue is the mutation contract's (packages/contracts/src/mutation.ts). */
const { MUTATION_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const registered = action => Object.hasOwn(MUTATION_ACTIONS, action);

/*
 * Delivery's worker is started by Kepler's governance host. That the server
 * starts it at boot, so a delivery queued before the start is attempted, and
 * waits for its batch before the pool closes, is asked of the server itself by
 * test/composition-lifecycle.test.js.
 */
const host = fs.readFileSync('apps/api/src/modules/kepler/application/governance-host.ts', 'utf8');
assert(host.includes('worker = startWebhookWorker({'));
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
assert(host.includes('return worker ? worker.stop() : null;'), 'stopping delivery hands back the batch in flight');
console.log('governance delivery server contract tests passed');
