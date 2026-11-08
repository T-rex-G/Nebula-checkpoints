'use strict';
/*
 * The GitHub App connection, as the server registers it: its routes and their
 * guards, as the route policy reads them from the composition root and the
 * modules' registrations, and what an installation's account may not do.
 *
 * What each part does is asked of it where it lives:
 *   - the server loads the App's configuration, tells the page, builds the
 *     broker, and resolves an App account to the installation's token
 *     (test/github-app-configured-server.test.js, test/composition.test.js);
 *   - the callbacks accept only a state signed for their purpose, this session
 *     and this identity, spend it once before GitHub is asked anything, and
 *     claim an installation only for an owner the user can see with their own
 *     token; the account they add is an App account and holds no token; the
 *     sign-in answer is where to go and nothing the session holds; a refresh
 *     or a disconnect outside the alpha makes the broker forget the
 *     installation's token (test/identity-security-routes.test.js,
 *     test/account-lifecycle.test.js,
 *     test/provider-disconnect-server-contract.test.js);
 *   - an installation's record and its audit trail, kept outside the alpha
 *     without a login (test/github-app-records.test.js), and the composed
 *     server's, with a database (test/composition-postgres.test.js);
 *   - an installation lists the repositories it was granted, never a
 *     person's (test/workbench-repository-routes.test.js), cannot star or
 *     unstar for a person, refused before GitHub is asked
 *     (test/workbench-collaboration-routes.test.js), and is offered no
 *     notifications (test/capability-access.test.js).
 */
const assert = require('assert');
const path = require('path');
const { locations } = require('./oracles/route-policy');
const { connectionRestriction } = require('../apps/api/src/modules/github-provider/index.ts');

const root = path.resolve(__dirname, '..');
const policyRoutes = locations(root).filter(entry => entry.kind === 'route');
const guardsOf = (method, routePath) => {
  const entry = policyRoutes.find(item => item.method === method && item.path === routePath);
  assert(entry, `missing ${method} ${routePath}`);
  return entry.guards;
};
for (const [method, routePath] of [
  ['POST', '/api/github-app/connect'], ['GET', '/api/github-app/oauth/callback'], ['GET', '/api/github-app/setup'],
  ['GET', '/api/github-app/status'], ['POST', '/api/github-app/refresh'], ['POST', '/api/github-app/disconnect']
]) guardsOf(method, routePath);
assert.deepStrictEqual(guardsOf('GET', '/api/me'), ['accountAuth']);
assert.deepStrictEqual(guardsOf('GET', '/api/notifications'), ['providerSessionAccess', "capabilityAccess('notifications')", 'auth'],
  'notification connection support must be checked before credential resolution');
assert.strictEqual(connectionRestriction({ authMethod: 'github-app' }, 'notifications').code, 'GITHUB_NOTIFICATIONS_CONNECTION_UNSUPPORTED');

console.log('github app server contract tests passed');
