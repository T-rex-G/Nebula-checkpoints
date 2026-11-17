'use strict';
const assert = require('assert');
const fs = require('fs');
const app = fs.readFileSync(require('path').join(__dirname, '..', 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');
const { createSession } = require('../apps/web/src/features/access/session.ts');
const { createAccountBoundary, IDENTITY_BOUNDARY_CHANNEL } = require('../apps/web/src/features/access/account-boundary.ts');
const { createAccountsDialog } = require('../apps/web/src/features/access/accounts-dialog.ts');

/* The accounts sheet, asked of features/access/accounts-dialog.ts: a press, and what it did in order. */
const sheetPress = async (selector, answers) => {
  const order = [];
  const pressed = new Map();
  const quiet = () => {};
  const sheet = createAccountsDialog({
    api: async route => { order.push(route); return answers[route]; }, modal: quiet, owner: () => () => true, generation: () => 1, closeModal: quiet,
    setBody: html => { for (const match of html.matchAll(/data-(switch|remove)="(\d+)"/g)) pressed.set(`#modalBody [data-${match[1]}]`, { disabled: false, dataset: { [match[1]]: match[2] }, addEventListener(type, listener) { this.listener = listener; } }); },
    controls: chosen => (pressed.has(chosen) ? [pressed.get(chosen)] : []), oauthOn: () => false,
    purge: async full => { order.push(`purge:${full}`); }, broadcast: () => order.push('broadcast'), clearAddress: quiet, restart: async () => { order.push('restart'); },
    forgetRemembered: quiet, showSignIn: quiet, addAccount: quiet, signOut: quiet, toast: quiet, showRevocationGuidance: quiet
  });
  await sheet.open();
  pressed.get(selector).listener();
  await new Promise(resolve => setImmediate(resolve));
  return order;
};

/* Sign-in and sign-out, asked of features/access/session.ts. */
const sessionOn = (order, answers) => {
  const quiet = () => {};
  return createSession({
    api: async route => { order.push(route); if (answers[route] instanceof Error) throw answers[route]; return answers[route]; },
    purge: async full => { order.push(`purge:${full}`); }, broadcast: () => order.push('broadcast'),
    token: () => 'github_pat_x', clearToken: quiet, hideError: quiet, setBusy: quiet, backShown: () => false, showBack: quiet,
    adopt: quiet, adoptCapabilities: quiet, remember: quiet, loadProviderCapabilities: async () => {}, applyCaps: quiet, setAvatar: quiet,
    toast: quiet, presentError: quiet, showRevocationGuidance: quiet, arrive: quiet, showSignIn: () => order.push('sign-in'), showWorkspace: quiet, restart: quiet
  });
};
/* The other tabs, asked of features/access/account-boundary.ts. */
const tabsOn = order => {
  const heard = {};
  const boundary = createAccountBoundary({
    state: { uiEpoch: 0 }, discardHeldRepaints: () => order.push('purge'), clearActivityFeed() {}, clearPosture() {}, paintUnread() {}, clearCsrfToken() {},
    clearGovernanceState() {}, clearExposureState() {}, clearAuditState() {}, clearSiteScanState() {}, forgetRepositoryWork() {},
    cacheNames: async () => [], deleteCache: async () => {}, sessionStorage: () => ({ clear() {} }), localStorage: () => ({ removeItem() {} }),
    serviceWorker: () => null, openQueue: async () => { throw new Error('none'); }, find: () => null, forgetReads: () => order.push('purged-fully'),
    channel: () => ({ postMessage: message => order.push(`posted:${message.type}`), addEventListener: (type, listener) => { heard.channel = listener; } }),
    writeStorage: key => order.push(`stored:${key}`), onStorage: listener => { heard.storage = listener; }, marker: () => 'm', reload: () => order.push('reload')
  });
  boundary.listen();
  return { boundary, heard };
};

/* Unfinished counts as failed: the asked half below ends the run. */
process.exitCode = 1;
(async () => {
  const signIn = [];
  await sessionOn(signIn, { '/api/login': { provider: 'github', login: 'a' }, '/api/me': { provider: 'github', login: 'a' } }).signIn();
  assert.deepStrictEqual(signIn.slice(0, 2), ['purge:true', '/api/login'], 'login must clear prior identity data before authentication');

  const signOut = [];
  await sessionOn(signOut, { '/api/logout': new Error('Network unavailable') }).signOut();
  assert.deepStrictEqual(signOut, ['/api/logout', 'purge:true', 'broadcast', 'sign-in'], 'logout must clear local data even when remote revocation fails');

  const told = [];
  const { boundary, heard } = tabsOn(told);
  boundary.broadcast();
  assert.strictEqual(IDENTITY_BOUNDARY_CHANNEL, 'nv-identity-boundary-v1');
  assert.deepStrictEqual(told, ['posted:NV_IDENTITY_BOUNDARY', 'stored:nv_identity_boundary_event'], 'identity changes must notify other tabs, with storage for a browser that has no channel');
  assert(typeof heard.channel === 'function' && typeof heard.storage === 'function', 'identity changes are heard on the channel and through storage');
  heard.storage({ key: 'nv_identity_boundary_event', newValue: 'x' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(told.slice(2), ['purge', 'purged-fully', 'reload'], 'other tabs must purge identity-bound state before reloading');
  const accounts = { '/api/accounts': { active: 0, accounts: [{ provider: 'github', login: 'a' }, { provider: 'github', login: 'b' }] } };
  assert.deepStrictEqual(await sheetPress('#modalBody [data-switch]', { ...accounts, '/api/accounts/switch-idx': { ok: true, login: 'b' } }),
    ['/api/accounts', 'purge:false', '/api/accounts/switch-idx', 'broadcast', 'restart'], 'account switch must await cache purge before switching, and successful switches must purge other tabs');
  assert.deepStrictEqual((await sheetPress('#modalBody [data-remove]', { ...accounts, '/api/accounts/remove': { ok: true, removed: 'b' } })).slice(0, 3),
    ['/api/accounts', 'purge:false', '/api/accounts/remove'], 'account removal must purge before mutation');
  console.log('account boundary tests passed');
  process.exitCode = 0;
})().catch(error => { console.error(error); process.exitCode = 1; });

assert(!/localStorage\.(?:setItem|getItem)\('nv_me'/.test(app),
  'offline identity fallback must remain tab-scoped so sibling purges cannot delete the active identity');
assert(app.includes("sessionStorage.setItem('nv_me'") && app.includes("sessionStorage.getItem('nv_me'"),
  'offline identity fallback must use sessionStorage');
/* That a read of a repository kept for offline use carries the scoped headers, and no other read does, is test/transport.test.js's (platform/offline-repos.ts) and test/e2e/transport.spec.js's. */
/* Settings offers offline use for the repository in hand, and only with one in hand (features/settings/settings-panel.ts). */
{
  const { settingsBody } = require('../apps/web/src/features/settings/settings-panel.ts');
  const view = offline => ({ settings: { fontSize: 14, wrap: true, motion: true, editorTheme: 'material-ocean', editorFont: 'DM Mono', design: 'nebula' }, dark: true, offline, alphaActions: '', release: '' });
  assert(settingsBody(view(false)).includes('<input type="checkbox" id="setOfflineRepo" > Enable offline access for this repository'), 'settings must expose explicit per-repository opt-in, off until chosen');
  assert(settingsBody(view(true)).includes('id="setOfflineRepo" checked>'), 'and say when it was chosen');
  assert(!settingsBody(view(null)).includes('setOfflineRepo'), 'and offer nothing with no repository in hand');
}
/* A session revoked elsewhere purges this browser's private data before the reload: test/pulsar-reliability.test.js. */
