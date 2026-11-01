'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
/* The App connection's routes are identity and access's; the server builds the broker and hands it in. */
const appRoutes = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'identity-access', 'http', 'github-app-routes.ts'), 'utf8');

assert(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'platform', 'config', 'server-settings.ts'), 'utf8').includes('loadGithubAppConfig(env, { production })')
  && server.includes('githubApp: GITHUB_APP_CONFIG'), 'server must load optional GitHub App configuration');
assert(server.includes('new GithubAppBroker'), 'server must construct the server-side installation credential broker');
assert(server.includes('resolveProviderAccount'), 'authenticated provider operations must resolve credentials through one boundary');
/* Every route with its guard chain, as the route policy reads them from server.js and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
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
assert(appRoutes.includes('findUserInstallation(pending.userToken'), 'setup callback must verify installation ownership with the GitHub App user token');
assert(appRoutes.includes('client.verifyState(') && server.includes('verifyState: verifyGithubAppState'), 'callbacks must verify signed session and identity-bound state');
assert(appRoutes.includes('consumeGithubAppPending'), 'callback state must be consumed once before provider side effects');
assert(appRoutes.indexOf("consumeGithubAppPending(sessionOn(req), 'installation'") < appRoutes.indexOf('broker().findUserInstallation('), 'the installation state is spent before GitHub is asked about the installation');
assert.match(appRoutes, /authMethod:\s*'github-app'/);
assert.match(appRoutes, /installationId:/);
assert(appRoutes.includes("await deps.addAccount(req, res, '', {"), 'GitHub App session accounts must remain tokenless');
assert(!/accounts\.push\(\{[^}]*token[^}]*authMethod:\s*'github-app'/s.test(server + appRoutes), 'GitHub App session accounts must remain tokenless');
assert(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'workbench', 'application', 'repository-list.ts'), 'utf8').includes('/installation/repositories?'), 'GitHub App repository listing must use the installation endpoint');
/* The workbench's collaboration routes: notifications, stars and the rest of a person's GitHub. */
const collaboration = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'workbench', 'http', 'collaboration-routes.ts'), 'utf8');
assert(collaboration.includes('GITHUB_APP_CAPABILITY_UNAVAILABLE'), 'unsupported user-scoped operations must fail explicitly for GitHub App accounts');
assert(server.includes('providerCapabilities'), 'account capabilities must distinguish installation-scoped credentials from user credentials');
/* The capability map is the platform's capability access, composed by the server. */
assert.match(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'platform', 'authorization', 'capability-access.ts'), 'utf8'), /authMethod === 'github-app'[\s\S]{0,500}notif:\s*false/);
const notifications = policyRoutes.find(entry => entry.kind === 'route' && entry.method === 'GET' && entry.path === '/api/notifications');
assert.deepStrictEqual(notifications && notifications.guards, ['providerSessionAccess', "capabilityAccess('notifications')", 'auth'],
  'notification connection support must be checked before credential resolution');
const { connectionRestriction } = require('../apps/api/src/modules/github-provider/index.ts');
assert.strictEqual(connectionRestriction({ authMethod: 'github-app' }, 'notifications').code, 'GITHUB_NOTIFICATIONS_CONNECTION_UNSUPPORTED');
assert(collaboration.includes('GitHub App installations cannot manage user stars'), 'user-scoped starring must fail without calling GitHub');
/* Disconnecting is identity and access's account lifecycle, handed the server's App broker. */
const accountLifecycle = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'identity-access', 'application', 'account-lifecycle.ts'), 'utf8');
assert(accountLifecycle.includes('deps.appBroker.invalidate(account.installationId)') && server.includes('appBroker: githubAppBroker,')
  && appRoutes.includes('broker().invalidate(installationId)'), 'disconnect or provider rejection must invalidate broker state');
assert(server.includes('nv_github_app_installations'), 'server must persist non-secret installation metadata when Neon is available');
assert(server.includes('nv_github_app_audit'), 'server must record non-secret lifecycle events when Neon is available');
assert(!/res\.json\([^\n]*(?:clientSecret|privateKey|webhookSecret|access_token|installationToken|userToken)/.test(server + appRoutes), 'server JSON must not expose GitHub App secrets');
console.log('github app server contract tests passed');
