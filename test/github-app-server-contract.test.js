'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert(server.includes('loadGithubAppConfig'), 'server must load optional GitHub App configuration');
assert(server.includes('new GithubAppBroker'), 'server must construct the server-side installation credential broker');
assert(server.includes('resolveProviderAccount'), 'authenticated provider operations must resolve credentials through one boundary');
assert.match(server, /app\.post\('\/api\/github-app\/connect'/);
assert.match(server, /app\.get\('\/api\/github-app\/oauth\/callback'/);
assert.match(server, /app\.get\('\/api\/github-app\/setup'/);
assert.match(server, /app\.get\('\/api\/github-app\/status'/);
assert.match(server, /app\.get\('\/api\/me', accountAuth/);
assert.match(server, /app\.post\('\/api\/github-app\/refresh'/);
assert.match(server, /app\.post\('\/api\/github-app\/disconnect'/);
assert(server.includes('findUserInstallation'), 'setup callback must verify installation ownership with the GitHub App user token');
assert(server.includes('verifyGithubAppState'), 'callbacks must verify signed session and identity-bound state');
assert(server.includes('consumeGithubAppPending'), 'callback state must be consumed once before provider side effects');
assert.match(server, /authMethod:\s*'github-app'/);
assert.match(server, /installationId:/);
assert(!/accounts\.push\(\{[^}]*token[^}]*authMethod:\s*'github-app'/s.test(server), 'GitHub App session accounts must remain tokenless');
assert(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'workbench', 'application', 'repository-list.ts'), 'utf8').includes('/installation/repositories?'), 'GitHub App repository listing must use the installation endpoint');
/* The workbench's collaboration routes: notifications, stars and the rest of a person's GitHub. */
const collaboration = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'workbench', 'http', 'collaboration-routes.ts'), 'utf8');
assert(collaboration.includes('GITHUB_APP_CAPABILITY_UNAVAILABLE'), 'unsupported user-scoped operations must fail explicitly for GitHub App accounts');
assert(server.includes('providerCapabilities'), 'account capabilities must distinguish installation-scoped credentials from user credentials');
assert.match(server, /authMethod === 'github-app'[\s\S]{0,500}notif:\s*false/);
/* Every route with its guard chain, as the route policy reads them from server.js and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
const notifications = locations(root).find(entry => entry.kind === 'route' && entry.method === 'GET' && entry.path === '/api/notifications');
assert.deepStrictEqual(notifications && notifications.guards, ['providerSessionAccess', "capabilityAccess('notifications')", 'auth'],
  'notification connection support must be checked before credential resolution');
const { connectionRestriction } = require('../apps/api/src/modules/github-provider/index.ts');
assert.strictEqual(connectionRestriction({ authMethod: 'github-app' }, 'notifications').code, 'GITHUB_NOTIFICATIONS_CONNECTION_UNSUPPORTED');
assert(collaboration.includes('GitHub App installations cannot manage user stars'), 'user-scoped starring must fail without calling GitHub');
assert(server.includes('githubAppBroker.invalidate'), 'disconnect or provider rejection must invalidate broker state');
assert(server.includes('nv_github_app_installations'), 'server must persist non-secret installation metadata when Neon is available');
assert(server.includes('nv_github_app_audit'), 'server must record non-secret lifecycle events when Neon is available');
assert(!/res\.json\([^\n]*(?:clientSecret|privateKey|webhookSecret|access_token|installationToken)/.test(server), 'server JSON must not expose GitHub App secrets');
console.log('github app server contract tests passed');
