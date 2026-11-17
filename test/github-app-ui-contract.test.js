'use strict';

/*
 * The GitHub App in Settings, as the page reaches it: the four endpoints it
 * uses, the states it draws, GitHub's answer taken out of the address, and
 * no secret field anywhere in what the page ships. The modules are asked
 * (features/settings/github-app.ts, github-app-controller.ts); the built
 * page is read for the names of secrets, so every module it bundles is
 * covered, not only the one file that once held them all.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { githubAppBody, callbackNotice } = require('../apps/web/src/features/settings/github-app.ts');
const { createGithubApp } = require('../apps/web/src/features/settings/github-app-controller.ts');
const { createSession } = require('../apps/web/src/features/access/session.ts');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'apps', 'web', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'styles', 'style.css'), 'utf8');

(async () => {
  const asked = [];
  const settings = { innerHTML: '' };
  const control = (action, data = {}) => {
    const node = { disabled: false, textContent: '', dataset: { githubAppAction: action, ...data } };
    return { closest: () => node };
  };
  const githubApp = createGithubApp({
    api: async (route, options) => {
      asked.push([route, options && options.method || 'GET']);
      if (route === '/api/github-app/connect') return { url: 'https://github.com/login/oauth/authorize?client_id=x' };
      if (route === '/api/github-app/disconnect') return { ok: true, installationId: 42 };
      return { enabled: true, connections: [] };
    },
    toast: () => {}, presentError: error => { throw error; }, confirm: () => true, configured: () => true,
    me: () => ({ provider: 'github', authMethod: 'token' }), body: () => settings, formatDate: date => date.toISOString(),
    navigate: () => {}, attached: () => true, purgeLocalData: async () => {}, broadcastIdentityBoundary: () => {}, signedOut: () => {},
    identityChanged: async () => {}, address: () => ({ pathname: '/', search: '', hash: '' }), replaceAddress: () => {}
  });
  await githubApp.status();
  await githubApp.onClick(control('connect'));
  await githubApp.onClick(control('refresh', { installationId: '42' }));
  await githubApp.onClick(control('disconnect', { installationId: '42' }));
  for (const [route, method] of [['/api/github-app/status', 'GET'], ['/api/github-app/connect', 'POST'], ['/api/github-app/refresh', 'POST'], ['/api/github-app/disconnect', 'POST']]) {
    assert(asked.some(call => call[0] === route && call[1] === method), `settings must reach ${method} ${route}`);
  }

  const connected = githubAppBody({ enabled: true, connections: [{ installationId: 42, accountLogin: 'acme', authorizedByLogin: 'octo', status: 'connected', repositorySelection: 'selected' }] },
    { provider: 'github', authMethod: 'token' }, date => date.toISOString());
  for (const text of ['Repository access', 'Authorized by', 'Refresh health', 'Reauthorize', 'Disconnect']) assert(connected.includes(text), `settings missing ${text}`);
  assert(githubAppBody({ enabled: false }, null, String).includes('GitHub App is optional'), 'a deployment without the App says it is optional');
  assert(githubAppBody({ enabled: true, connections: [] }, null, String).includes('No installation connected'));
  assert.strictEqual(callbackNotice('?githubApp=connected').tone, 'ok', 'callback result must show a connected notification');
  assert.strictEqual(callbackNotice('?githubApp=connected&code=x').query, '', 'callback result query data must be removed from the address bar');

  assert(css.includes('.github-app-panel') && css.includes('.github-app-connection'), 'GitHub App management needs scoped styles');
  const built = fs.readdirSync(path.join(root, 'dist', 'web', 'build')).filter(file => file.endsWith('.js'));
  assert(built.length, 'the page is built before this test runs');
  for (const file of built) {
    const shipped = fs.readFileSync(path.join(root, 'dist', 'web', 'build', file), 'utf8');
    for (const secretName of ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_WEBHOOK_SECRET', 'installationToken', 'access_token']) {
      assert(!shipped.includes(secretName), `the shipped page (${file}) must not reference secret field ${secretName}`);
    }
  }
  /* The OAuth controls -- sign-in, and the wider grant from Accounts -- follow /api/config: test/e2e/github-only.spec.js. */
  assert(html.includes('GitHub Personal Access Token'), 'existing PAT login must remain present');
  assert(html.includes('id="tokenInput"') && html.includes('id="loginBtn"'), 'PAT login controls must remain present');
  {
    /* The token sign-in names GitHub and nothing else, and takes nothing else for an answer (features/access/session.ts). */
    const signInAnswered = async provider => {
      const sent = []; const adopted = []; const refused = [];
      const quiet = () => {};
      await createSession({
        api: async (route, options) => { sent.push([route, options && options.body]); return { provider, login: 'a' }; },
        purge: async () => {}, broadcast: quiet, token: () => 'github_pat_x', clearToken: quiet, hideError: quiet, setBusy: quiet, backShown: () => false, showBack: quiet,
        adopt: me => adopted.push(me), adoptCapabilities: quiet, remember: quiet, loadProviderCapabilities: async () => {}, applyCaps: quiet, setAvatar: quiet, toast: quiet,
        presentError: error => refused.push(error.message), showRevocationGuidance: quiet, arrive: quiet, showSignIn: quiet, showWorkspace: quiet, restart: quiet
      }).signIn();
      return { sent, adopted, refused };
    };
    const github = await signInAnswered('github');
    assert.deepStrictEqual(github.sent[0], ['/api/login', { token: 'github_pat_x', provider: 'github' }], 'PAT login must use GitHub without a custom authority');
    assert.deepStrictEqual(github.refused, []);
    const other = await signInAnswered('gitlab');
    assert.deepStrictEqual([other.adopted, other.refused], [[], ['Connect a GitHub account to continue.']], 'PAT response must validate the supported identity');
  }
  console.log('github app UI contract tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
