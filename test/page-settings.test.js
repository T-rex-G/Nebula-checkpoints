'use strict';

/*
 * Settings, asked directly: the GitHub App's part of it -- what each shape of
 * connection the server sends is drawn as, how a connection is addressed,
 * and what each control does (features/settings/github-app.ts and
 * github-app-controller.ts) -- and the panel itself, its controls and what
 * each one changes (features/settings/settings-panel.ts).
 *
 * The server sends a connection in two shapes. Open deployments name it by
 * installation number, account and who authorized it; the invite-only alpha
 * sends its stable key and nothing that names a person. A control reaches a
 * connection by the key when there is one, so the alpha's refresh and
 * disconnect are not refused for want of a number the page was never sent.
 */

const assert = require('assert');
const githubApp = require('../apps/web/src/features/settings/github-app.ts');
const { createGithubApp } = require('../apps/web/src/features/settings/github-app-controller.ts');
const { createSettingsPanel, settingsBody, settingChange } = require('../apps/web/src/features/settings/settings-panel.ts');
const { DESIGN_LABELS, DESIGNS } = require('../apps/web/src/features/shell/appearance.ts');

const { addressOf, addressFrom, addressAttributes, connectionView, githubAppBody, canAuthorize, callbackNotice, verifiedText, isGithubUrl } = githubApp;
const checks = [];
const check = (name, run) => checks.push([name, run]);
const KEY = 'a'.repeat(64);
const format = date => `on ${date.toISOString()}`;
const tokenUser = { provider: 'github', authMethod: 'token' };
const appUser = { provider: 'github', authMethod: 'github-app' };

/* The connection as each kind of deployment sends it. */
const OPEN = Object.freeze({
  installationId: 42, accountLogin: 'acme', accountType: 'Organization', avatar: 'https://avatars.githubusercontent.com/u/1',
  repositorySelection: 'selected', permissions: {}, authorizedByLogin: 'octo', status: 'connected',
  lastVerifiedAt: '2026-11-01T10:00:00.000Z', installationUrl: 'https://github.com/settings/installations/42', active: true
});
const ALPHA = Object.freeze({ connectionKey: KEY, accountType: 'User', repositorySelection: 'all', status: 'suspended', lastVerifiedAt: '', active: true });

/* ---- How a connection is addressed ----------------------------------------------------- */

check('a connection is addressed by its key when it has one, by its number otherwise, and not at all when it has neither', () => {
  assert.deepStrictEqual(addressOf(ALPHA), { connectionKey: KEY });
  assert.deepStrictEqual(addressOf(OPEN), { installationId: 42 });
  assert.deepStrictEqual(addressOf({ ...OPEN, connectionKey: KEY }), { connectionKey: KEY }, 'the key wins: the alpha server matches by nothing else');
  for (const id of [0, -1, 1.5, NaN, '', ' ', 'x', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual(addressOf({ installationId: id }), null, `${String(id)} is no installation`);
  }
  assert.deepStrictEqual(addressOf({ installationId: '7' }), { installationId: 7 });
  for (const key of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`, 42]) assert.strictEqual(addressOf({ connectionKey: key }), null);
  assert.deepStrictEqual(addressFrom({ connectionKey: KEY }), { connectionKey: KEY });
  assert.deepStrictEqual(addressFrom({ installationId: '42' }), { installationId: 42 });
  assert.deepStrictEqual(addressFrom({ installationId: 'NaN' }), null);
  assert.strictEqual(addressAttributes({ connectionKey: KEY }), `data-connection-key="${KEY}"`);
  assert.strictEqual(addressAttributes({ installationId: 42 }), 'data-installation-id="42"');
});

/* ---- What Settings draws ----------------------------------------------------------------- */

check('an open deployment\'s connection: its account, number, access, who authorized it, health and where to manage it', () => {
  const view = connectionView(OPEN, format);
  assert.deepStrictEqual({ ...view }, {
    address: { installationId: 42 }, account: 'acme', accountType: 'Organization', installation: 42,
    avatar: 'https://avatars.githubusercontent.com/u/1', access: 'Selected repositories only', authorizedBy: 'octo',
    healthy: true, health: 'Healthy', verifiedAt: 'on 2026-11-01T10:00:00.000Z', manageUrl: 'https://github.com/settings/installations/42'
  });
  const html = githubAppBody({ enabled: true, connections: [OPEN] }, tokenUser, format);
  for (const text of ['acme', 'Organization · Installation #42', 'Selected repositories only', '<dt>Authorized by</dt><dd>octo</dd>', 'Healthy', 'Manage on GitHub',
    'data-github-app-action="refresh" data-installation-id="42"', 'data-github-app-action="disconnect" data-installation-id="42"']) {
    assert(html.includes(text), `missing ${text}`);
  }
  assert(/data-github-app-action="reauthorize" >/.test(html), 'a token user may reauthorize');
  assert(html.includes('data-github-app-action="connect" >Connect GitHub App'), 'and connect another installation');
});

check('the alpha\'s connection is drawn from what it was sent: no "#NaN", no "Unknown", and its controls carry the key', () => {
  const html = githubAppBody({ enabled: true, connections: [ALPHA] }, tokenUser, format);
  assert(!/NaN|Unknown|undefined|null/.test(html), html);
  assert(html.includes('<b>GitHub installation</b><span>User</span>'), 'the account the server did not name, and no installation number');
  assert(!html.includes('Authorized by'), 'who authorized it is not shown as unknown');
  assert(html.includes('All repositories approved for this installation'));
  assert(html.includes('class="github-app-health warning">Suspended<'), 'the health word as a word');
  assert(html.includes('<dd>Not verified yet</dd>'));
  assert(html.includes(`data-github-app-action="refresh" data-connection-key="${KEY}"`));
  assert(html.includes(`data-github-app-action="disconnect" data-connection-key="${KEY}"`));
  assert(!html.includes('data-installation-id'));
  assert(!html.includes('Manage on GitHub'), 'nowhere to manage it was sent');
});

check('a connection with no address offers nothing the server would refuse', () => {
  const html = githubAppBody({ enabled: true, connections: [{ status: 'connected' }] }, tokenUser, format);
  assert(!html.includes('data-github-app-action="refresh"') && !html.includes('data-github-app-action="disconnect"'));
  assert(html.includes('data-github-app-action="reauthorize"'), 'it can still be authorized again');
});

check('what a connection says is text, and links go only to GitHub', () => {
  const hostile = { ...OPEN, accountLogin: '<img src=x onerror=alert(1)>', accountType: '"><b>', authorizedByLogin: '<script>', avatar: 'javascript:alert(1)', installationUrl: 'https://evil.example/github.com/' };
  const html = githubAppBody({ enabled: true, connections: [hostile], error: '<b>bad</b>' }, tokenUser, format);
  assert(!/<img src=x|<script>|<b>bad|"><b>/.test(html), html);
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('⚠ &lt;b&gt;bad&lt;/b&gt;'));
  assert(!html.includes('javascript:') && !html.includes('evil.example'));
  assert(isGithubUrl('https://github.com/x') && isGithubUrl('HTTPS://GITHUB.COM/x') && !isGithubUrl('https://github.com.evil/x') && !isGithubUrl('http://github.com/x') && !isGithubUrl(null));
});

check('a date the server garbled is not shown as "Invalid Date"', () => {
  assert.strictEqual(verifiedText('', format), 'Not verified yet');
  assert.strictEqual(verifiedText('yesterday-ish', format), 'Not verified yet');
  assert.strictEqual(verifiedText(undefined, format), 'Not verified yet');
  assert.strictEqual(verifiedText('2026-11-01T10:00:00.000Z', format), 'on 2026-11-01T10:00:00.000Z');
});

check('unavailable, nothing connected, and who may authorize', () => {
  for (const status of [null, undefined, {}, { enabled: false }, { enabled: 'yes' }, 'enabled']) {
    assert(githubAppBody(status, tokenUser, format).includes('GitHub App is optional'), `${JSON.stringify(status)} is not an offered App`);
  }
  const empty = githubAppBody({ enabled: true, connections: [] }, tokenUser, format);
  assert(empty.includes('No installation connected') && empty.includes('GitHub will ask you to authorize your identity') && empty.includes('data-github-app-action="connect" >'));
  const viaApp = githubAppBody({ enabled: true, connections: [] }, appUser, format);
  assert(viaApp.includes('Switch to a GitHub PAT or OAuth account') && viaApp.includes('data-github-app-action="connect" disabled'));
  const listedViaApp = githubAppBody({ enabled: true, connections: [OPEN] }, appUser, format);
  assert(listedViaApp.includes('data-github-app-action="reauthorize" disabled') && !listedViaApp.includes('data-github-app-action="connect"'), 'no connect control beside a list the reader cannot add to');
  assert(!githubAppBody({ enabled: true, connections: 'many' }, tokenUser, format).includes('github-app-connection"'), 'connections that are not a list are none');
  assert.deepStrictEqual([canAuthorize(tokenUser), canAuthorize({ provider: 'github', authMethod: 'oauth' }), canAuthorize(appUser), canAuthorize({ provider: 'gitlab' }), canAuthorize(null)], [true, true, false, false, false]);
});

check('GitHub\'s answer, read and taken out of the address', () => {
  assert.strictEqual(callbackNotice('?tab=1'), null);
  assert.deepStrictEqual({ ...callbackNotice('?githubApp=connected&tab=1') }, { query: 'tab=1', message: 'GitHub App installation connected securely ✦', tone: 'ok' });
  assert.deepStrictEqual({ ...callbackNotice('?githubApp=error&code=STATE_MISMATCH') }, { query: '', message: 'GitHub App connection was not completed (state mismatch)', tone: 'err' });
  assert.deepStrictEqual({ ...callbackNotice('?githubApp=error') }, { query: '', message: 'GitHub App connection was not completed', tone: 'err' });
});

/* ---- What the controls do ----------------------------------------------------------------- */

function harness(over = {}) {
  const calls = [];
  const body = { innerHTML: '' };
  const deps = {
    api: async (path, options) => {
      calls.push(['api', path, options ? JSON.stringify(options.body) : '']);
      if (over.api) return over.api(path, options);
      if (path === '/api/github-app/status') return { enabled: true, connections: [ALPHA] };
      return { ok: true };
    },
    toast: (message, kind) => calls.push(['toast', message, kind || '']),
    presentError: error => calls.push(['error', error.message]),
    confirm: () => (over.confirm ? over.confirm() : true),
    configured: () => true,
    me: () => ('me' in over ? over.me : tokenUser),
    body: () => ('body' in over ? over.body : body),
    formatDate: format,
    navigate: url => calls.push(['navigate', url]),
    attached: () => true,
    purgeLocalData: async full => calls.push(['purge', full]),
    broadcastIdentityBoundary: () => calls.push(['broadcast']),
    signedOut: () => calls.push(['signedOut']),
    identityChanged: async () => calls.push(['identityChanged']),
    address: () => over.address || { pathname: '/', search: '', hash: '' },
    replaceAddress: url => calls.push(['replace', url])
  };
  return { app: createGithubApp(deps), calls, body };
}
const button = (action, data = {}) => {
  const node = { disabled: false, textContent: 'idle', dataset: { githubAppAction: action, ...data } };
  return { node, target: { closest: selector => (selector === '[data-github-app-action]' ? node : null) } };
};

check('the alpha\'s refresh and disconnect reach the connection by its key', async () => {
  const { app, calls, body } = harness();
  await app.onClick(button('refresh', { connectionKey: KEY }).target);
  assert.deepStrictEqual(calls[0], ['api', '/api/github-app/refresh', JSON.stringify({ connectionKey: KEY })]);
  assert.deepStrictEqual(calls[1], ['toast', 'GitHub App installation health refreshed ✦', 'ok']);
  assert.deepStrictEqual(calls[2], ['api', '/api/github-app/status', ''], 'and the panel is read again');
  assert(body.innerHTML.includes('Suspended'));
  const second = harness();
  await second.app.onClick(button('disconnect', { connectionKey: KEY }).target);
  assert.deepStrictEqual(second.calls[0], ['api', '/api/github-app/disconnect', JSON.stringify({ connectionKey: KEY })]);
  const third = harness();
  await third.app.onClick(button('refresh', { installationId: '42' }).target);
  assert.deepStrictEqual(third.calls[0], ['api', '/api/github-app/refresh', JSON.stringify({ installationId: 42 })], 'an open deployment by the number');
});

check('a control with no address sends nothing', async () => {
  for (const action of ['refresh', 'disconnect']) {
    const { app, calls } = harness();
    const { node, target } = button(action, { installationId: 'NaN' });
    await app.onClick(target);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(node.disabled, false);
  }
});

check('a disconnect the server has not finished leaves everything the page holds', async () => {
  const { app, calls } = harness({ api: async path => (path === '/api/github-app/disconnect' ? { ok: false, status: 'pending', results: [] } : { enabled: true, connections: [ALPHA] }) });
  const { node, target } = button('disconnect', { connectionKey: KEY });
  await app.onClick(target);
  assert.deepStrictEqual(calls.slice(1), [['toast', 'Provider cleanup is pending. Keep this session open and retry shortly.', '']]);
  assert.deepStrictEqual([node.disabled, node.textContent], [false, 'Disconnect']);
});

check('a finished disconnect: the last account signs the reader out; another account takes its place', async () => {
  const last = harness({ api: async path => (path === '/api/github-app/disconnect' ? { ok: true, empty: true } : {}) });
  await last.app.onClick(button('disconnect', { connectionKey: KEY }).target);
  assert.deepStrictEqual(last.calls.slice(1), [['purge', true], ['broadcast'], ['toast', 'GitHub App installation disconnected ✦', 'ok'], ['signedOut']]);
  const other = harness({ api: async path => (path === '/api/github-app/disconnect' ? { ok: true, active: 0 } : { enabled: true, connections: [] }) });
  await other.app.onClick(button('disconnect', { installationId: '42' }).target);
  assert.deepStrictEqual(other.calls.slice(1).map(call => call[0] === 'api' ? call.slice(0, 2) : call),
    [['purge', false], ['broadcast'], ['toast', 'GitHub App installation disconnected ✦', 'ok'], ['identityChanged'], ['api', '/api/github-app/status']]);
  assert(other.body.innerHTML.includes('No installation connected'), 'and the panel is read again');
});

check('a declined disconnect sends nothing', async () => {
  const { app, calls } = harness({ confirm: () => false });
  const { node, target } = button('disconnect', { connectionKey: KEY });
  await app.onClick(target);
  assert.deepStrictEqual([calls, node.disabled, node.textContent], [[], false, 'idle']);
});

check('a connection on its way to GitHub keeps its control busy; one GitHub would not take is said, and the control is back', async () => {
  const going = harness({ api: async () => ({ url: 'https://github.com/login/oauth/authorize?x=1' }) });
  const { node, target } = button('connect');
  await going.app.onClick(target);
  assert.deepStrictEqual(going.calls.at(-1), ['navigate', 'https://github.com/login/oauth/authorize?x=1']);
  assert.deepStrictEqual([node.disabled, node.textContent], [true, 'Opening GitHub…'], 'the page is leaving: a second press would start a second authorization');
  const wrong = harness({ api: async () => ({ url: 'https://evil.example/authorize' }) });
  const again = button('reauthorize');
  await wrong.app.onClick(again.target);
  assert.deepStrictEqual(wrong.calls.at(-1), ['error', 'GitHub returned an invalid authorization destination']);
  assert.deepStrictEqual([again.node.disabled, again.node.textContent], [false, 'Reauthorize']);
});

check('a busy or unknown control does nothing, and a press elsewhere is not a control', async () => {
  const { app, calls } = harness();
  const busy = button('refresh', { connectionKey: KEY });
  busy.node.disabled = true;
  await app.onClick(busy.target);
  await app.onClick(button('uninstall', { connectionKey: KEY }).target);
  await app.onClick({ closest: () => null });
  await app.onClick(null);
  assert.deepStrictEqual(calls, []);
});

check('the status is read only for someone signed in, and a failed read is shown as one', async () => {
  const out = harness({ me: null });
  assert.deepStrictEqual(await out.app.status(), { enabled: true, webhookConfigured: false, connections: [] });
  assert.deepStrictEqual(out.calls, []);
  const failing = harness({ api: async () => { throw new Error('GitHub did not answer'); } });
  assert.deepStrictEqual(await failing.app.status(), { enabled: true, webhookConfigured: false, connections: [], error: 'GitHub did not answer' });
});

check('only the latest read draws: an earlier answer arriving late does not replace it', async () => {
  const answers = [];
  const { app, body } = harness({ api: () => new Promise(resolve => answers.push(resolve)) });
  const first = app.reload();
  const second = app.reload();
  answers[1]({ enabled: true, connections: [ALPHA] });
  await second;
  answers[0]({ enabled: true, connections: [] });
  await first;
  assert(body.innerHTML.includes('Suspended') && !body.innerHTML.includes('No installation connected'), body.innerHTML);
  let open = true;
  const late = harness({ api: () => new Promise(resolve => answers.push(resolve)) });
  const shown = late.app.show(() => open);
  open = false;
  answers.at(-1)({ enabled: true, connections: [ALPHA] });
  await shown;
  assert.strictEqual(late.body.innerHTML, '', 'Settings closed before the status arrived');
});

check('GitHub\'s answer is said once and taken out of the address', () => {
  const { app, calls } = harness({ address: { pathname: '/app', search: '?githubApp=connected&tab=2', hash: '#/repos' } });
  app.notice();
  assert.deepStrictEqual(calls, [['replace', '/app?tab=2#/repos'], ['toast', 'GitHub App installation connected securely ✦', 'ok']]);
  const quiet = harness();
  quiet.app.notice();
  assert.deepStrictEqual(quiet.calls, []);
});

/* ---- The panel ---------------------------------------------------------------------------------- */

const SETTINGS = Object.freeze({ fontSize: 15, wrap: false, motion: true, editorTheme: 'nord', editorFont: 'Fira Code', design: 'obsidian' });

check('the panel shows each setting as it is', () => {
  const html = settingsBody({ settings: SETTINGS, dark: false, offline: null, alphaActions: '', release: '' });
  assert(html.includes('data-design-choice="obsidian" aria-checked="true" tabindex="0"') && html.includes('data-design-choice="nebula" aria-checked="false" tabindex="-1"'));
  for (const name of DESIGNS) assert(html.includes(`<span class="design-name">${DESIGN_LABELS[name].name}</span>`) && html.includes(DESIGN_LABELS[name].note));
  assert(html.includes('role="switch" aria-checked="false"'), 'the theme switch is off in light');
  assert(html.includes('<option value="nord" selected>Nord</option>') && html.includes('<option selected>Fira Code</option>'));
  assert(html.includes('<span id="setFsVal">15px</span>') && html.includes('min="11" max="20" value="15" id="setFs"'));
  assert(html.includes('id="setWrap" >') && html.includes('id="setMotion" checked>'));
  assert(!html.includes('setOfflineRepo') && !html.includes('setBuild'), 'no repository in hand, no build said');
  assert(html.includes('<div id="githubAppSettingsBody"><p class="hint" role="status">Loading connection details…</p></div>'));
  const full = settingsBody({ settings: SETTINGS, dark: true, offline: true, alphaActions: '<div id="alphaActionsCopy"></div>', release: '<v1>' });
  assert(full.includes('id="setOfflineRepo" checked') && full.includes('<div id="alphaActionsCopy"></div>') && full.includes('Build &lt;v1&gt;') && full.includes('aria-checked="true" aria-label="Toggle dark'));
  assert(settingsBody({ settings: SETTINGS, dark: true, offline: false, alphaActions: '', release: '' }).includes('id="setOfflineRepo" >'));
});

check('each control changes its own setting', () => {
  assert.deepStrictEqual(settingChange({ id: 'setFs', value: '17', checked: false }), { fontSize: 17 });
  assert.deepStrictEqual(settingChange({ id: 'setWrap', value: 'on', checked: true }), { wrap: true });
  assert.deepStrictEqual(settingChange({ id: 'setWrap', value: 'on', checked: false }), { wrap: false });
  assert.deepStrictEqual(settingChange({ id: 'setMotion', value: 'on', checked: true }), { motion: true });
  assert.deepStrictEqual(settingChange({ id: 'setMotion', value: 'on', checked: false }), { motion: false });
  assert.deepStrictEqual(settingChange({ id: 'setEdTheme', value: 'dracula', checked: false }), { editorTheme: 'dracula' });
  assert.deepStrictEqual(settingChange({ id: 'setEdFont', value: 'IBM Plex Mono', checked: false }), { editorFont: 'IBM Plex Mono' });
  assert.strictEqual(settingChange({ id: 'setOfflineRepo', value: 'on', checked: true }), null);
  assert.strictEqual(settingChange({ id: 'tokenInput', value: 'x', checked: false }), null);
});

function panelHarness(over = {}) {
  const calls = [];
  const settings = { ...SETTINGS };
  const elements = {};
  let closeDialog;
  let owner = 0;
  const deps = {
    modal: request => { calls.push(['modal', request.title, request.okText]); owner += 1; return new Promise(resolve => { closeDialog = resolve; }); },
    modalOwner: () => { const mine = owner; return () => mine === owner; },
    view: () => ({ settings, dark: true, offline: null, alphaActions: '', release: '' }),
    mutateSettings: change => { change(settings); calls.push(['mutate', JSON.stringify(settings)]); },
    apply: () => calls.push(['apply']),
    element: selector => {
      elements[selector] = elements[selector] || { textContent: '', listeners: [], addEventListener(type, listener) { this.listeners.push([type, listener]); } };
      return elements[selector];
    },
    setOffline: async enabled => { calls.push(['offline', enabled]); if (over.offlineFails) throw new Error('Sign in and open a repository first'); },
    purgeLocalData: async full => calls.push(['purge', full]),
    toast: (message, kind) => calls.push(['toast', message, kind || '']),
    githubApp: { show: async stillOpen => calls.push(['show', stillOpen()]) }
  };
  return { panel: createSettingsPanel(deps), calls, settings, elements, close: () => closeDialog(true) };
}

check('the panel opens at once, draws the App when it can, wires its clear control, and applies the look as it closes', async () => {
  const { panel, calls, elements, close } = panelHarness();
  const opened = panel.open();
  assert.deepStrictEqual(calls, [['modal', 'Settings', 'Done'], ['show', true]]);
  const [[type, clear]] = elements['#clearLocalBtn'].listeners;
  assert.strictEqual(type, 'click');
  clear();
  await null; await null;
  assert.deepStrictEqual(calls.slice(2), [['purge', true], ['toast', 'Offline caches and queued commits cleared ✦', 'ok']]);
  close();
  await opened;
  assert.deepStrictEqual(calls.at(-1), ['apply']);
});

check('the slider changes the size as it moves; the other controls as they settle', async () => {
  const { panel, calls, settings, elements } = panelHarness();
  panel.onInput({ id: 'setFs', value: '18', checked: false });
  assert.strictEqual(settings.fontSize, 18);
  assert.strictEqual(elements['#setFsVal'].textContent, '18px');
  assert.deepStrictEqual(calls.map(call => call[0]), ['mutate', 'apply']);
  panel.onInput({ id: 'setWrap', value: 'on', checked: true });
  await panel.onChange({ id: 'setFs', value: '12', checked: false });
  assert.strictEqual(calls.length, 2, 'a size settles with nothing more to do; a box is not an input');
  await panel.onChange({ id: 'setWrap', value: 'on', checked: true });
  await panel.onChange({ id: 'setEdFont', value: 'JetBrains Mono', checked: false });
  assert.deepStrictEqual([settings.wrap, settings.editorFont], [true, 'JetBrains Mono']);
  await panel.onChange({ id: 'somethingElse', value: '', checked: true });
  await panel.onChange(null);
  panel.onInput(null);
  assert.deepStrictEqual(calls.map(call => call[0]), ['mutate', 'apply', 'mutate', 'apply', 'mutate', 'apply']);
});

check('offline use of the repository is kept, or the box goes back and says why', async () => {
  const ok = panelHarness();
  const box = { id: 'setOfflineRepo', value: 'on', checked: true };
  await ok.panel.onChange(box);
  assert.deepStrictEqual(ok.calls, [['offline', true], ['toast', 'Offline access enabled for this repository ✦', 'ok']]);
  box.checked = false;
  await ok.panel.onChange(box);
  assert.deepStrictEqual(ok.calls.slice(2), [['offline', false], ['toast', 'Offline repository cache removed ✦', 'ok']]);
  const failing = panelHarness({ offlineFails: true });
  const refused = { id: 'setOfflineRepo', value: 'on', checked: true };
  await failing.panel.onChange(refused);
  assert.strictEqual(refused.checked, false);
  assert.deepStrictEqual(failing.calls.at(-1), ['toast', 'Sign in and open a repository first', 'err']);
});

process.exitCode = 1;
(async () => {
  for (const [name, run] of checks) {
    try { await run(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  }
  console.log(`page settings tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
