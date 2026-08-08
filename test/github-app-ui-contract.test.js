'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

assert(app.includes("api('/api/github-app/status')"), 'settings must load GitHub App connection status');
assert(app.includes("api('/api/github-app/connect'"), 'settings must start the optional connection flow');
assert(app.includes("api('/api/github-app/refresh'"), 'settings must refresh installation health');
assert(app.includes("api('/api/github-app/disconnect'"), 'settings must disconnect a local installation registration');
assert(app.includes('renderGithubAppSettings'), 'settings must render disabled, available, and connected states');
for (const text of ['GitHub App', 'Repository access', 'Authorized by', 'Refresh health', 'Reauthorize', 'Disconnect']) {
  assert(app.includes(text), `settings missing ${text}`);
}
assert(app.includes("githubApp === 'connected'") || app.includes("githubAppResult === 'connected'"), 'callback result must show a connected notification');
assert(app.includes('history.replaceState'), 'callback result query data must be removed from the address bar');
assert(css.includes('.github-app-panel') && css.includes('.github-app-connection'), 'GitHub App management needs scoped styles');
for (const secretName of ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_WEBHOOK_SECRET', 'installationToken', 'access_token']) {
  assert(!app.includes(secretName), `public application must not reference secret field ${secretName}`);
}
assert(app.includes('window._oauthOn'), 'existing OAuth control must remain present');
assert(app.includes('GitHub Personal Access Token'), 'existing PAT login must remain present');
console.log('github app UI contract tests passed');
