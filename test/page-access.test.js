'use strict';

/*
 * The sign-in screen and the alpha's privacy actions, asked directly: the
 * guidance and the deployment's limits,
 * the alpha's two panels with the gate on and off
 * (features/access/login-screen.ts); and disconnecting, revoking, ending and
 * deleting, none of which claims more than happened
 * (features/access/alpha-privacy.ts).
 */

const assert = require('assert');
const { runtimeLimitsKnown, loginGuidanceHtml, limitsText, createLoginChrome, ALPHA_PROVIDER_GUIDANCE } = require('../apps/web/src/features/access/login-screen.ts');
const { createAlphaPrivacy, revocationGuidanceBody, DELETE_PHRASE } = require('../apps/web/src/features/access/alpha-privacy.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

/* ---- The sign-in screen ---------------------------------------------------------------- */

check('the deployment\'s limits are said in megabytes, or said to be unknown; zero is a limit', () => {
  const all = { uploadMaxMb: 25, gitDataMaxMb: 100, nativePushMaxMb: 50, contentsMaxMb: 1 };
  assert.strictEqual(runtimeLimitsKnown(all), true);
  assert.strictEqual(runtimeLimitsKnown({ ...all, contentsMaxMb: 0 }), true, 'a ceiling of zero is still a ceiling');
  for (const missing of [{ uploadMaxMb: null }, { gitDataMaxMb: '100' }, { nativePushMaxMb: NaN }, { contentsMaxMb: Infinity }, { contentsMaxMb: undefined }]) {
    assert.strictEqual(runtimeLimitsKnown({ ...all, ...missing }), false, JSON.stringify(missing));
  }
  assert.strictEqual(limitsText(all), 'Deployment limits — Direct upload: 25 MB; Git data: 100 MB; native push: 50 MB. Provider limits also apply. Public alpha: no production service guarantee.');
  assert.strictEqual(limitsText({ ...all, contentsMaxMb: null }), 'Deployment upload limits are unavailable. Retry before uploading; provider limits also apply. Public alpha: no production service guarantee.');
});

check('the guidance asks for a short-lived fine-grained token, and names the App only where it is offered', () => {
  const token = 'Create a short-lived <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained token</a> limited to selected repositories. Start with Contents read access; add Contents write or other permissions only for the actions you need.';
  const storage = ' Sessions use an HttpOnly session cookie stored by your browser. GitHub credentials are encrypted in that cookie or in server-side session storage.';
  assert.strictEqual(loginGuidanceHtml(false), `${token}${storage}`, 'the token page opens without a handle on this one');
  assert.strictEqual(loginGuidanceHtml(true), `${token} After sign-in, open Settings → GitHub App to connect an installation limited to selected repositories.${storage}`);
});

function chromeWorld(gate) {
  const nodes = new Map();
  const log = [];
  const make = tag => {
    const node = { tag, id: '', className: '', textContent: null, dataset: {}, children: [], removed: false,
      append(...children) { this.children.push(...children); },
      remove() { this.removed = true; nodes.delete(`#${this.id}`); log.push(['remove', this.id]); },
      querySelector(selector) { return selector === 'p' ? this.children.find(c => c.tag === 'p') || null : null; } };
    return node;
  };
  const card = { insertBefore: (node, before) => { nodes.set(`#${node.id}`, node); log.push(['insert', node.id, before && before.id]); }, appendChild: node => { nodes.set(`#${node.id}`, node); log.push(['append', node.id]); } };
  const error = { id: 'loginError' };
  let on = gate;
  const chrome = createLoginChrome({ gateEnabled: () => on, card: () => card, find: sel => (sel === '#loginError' ? error : nodes.get(sel) || null), create: make });
  return { chrome, log, nodes, setGate: v => { on = v; } };
}

check('with the gate on, the alpha\'s two panels are built once, in their places, saying what they are for', () => {
  const w = chromeWorld(true);
  const guidance = w.chrome.ensureGuidance();
  assert.deepStrictEqual([guidance.id, guidance.className], ['alphaProviderGuidance', 'set-group alpha-provider-guidance']);
  assert.deepStrictEqual(guidance.children.map(c => [c.tag, c.textContent]), [['h2', 'Provider permission review'], ['p', ALPHA_PROVIDER_GUIDANCE]]);
  assert.deepStrictEqual(w.log, [['insert', 'alphaProviderGuidance', 'loginError']], 'above the sign-in\'s error');
  assert.strictEqual(w.chrome.ensureGuidance(), guidance, 'not built twice');
  const controls = w.chrome.ensureSessionControls();
  assert.deepStrictEqual([controls.id, controls.className], ['loginAlphaSessionControls', 'set-group alpha-privacy-panel']);
  const [heading, copy, end] = controls.children;
  assert.deepStrictEqual([heading.textContent, copy.className, copy.textContent], ['Alpha session', 'hint', 'Provider access is separate from the controlled alpha session.']);
  assert.deepStrictEqual([end.tag, end.type, end.className, end.dataset.alphaPrivacyAction, end.textContent], ['button', 'button', 'btn btn-ghost btn-block', 'end', 'End alpha session']);
  assert.strictEqual(w.chrome.ensureSessionControls(), controls);
});

check('with the gate off, panels built on an earlier load are removed, and none is built', () => {
  const w = chromeWorld(true);
  w.chrome.ensureGuidance();
  w.chrome.ensureSessionControls();
  w.setGate(false);
  assert.strictEqual(w.chrome.ensureGuidance(), null);
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'remove').map(e => e[1]).sort(), ['alphaProviderGuidance', 'loginAlphaSessionControls']);
  assert.strictEqual(w.chrome.ensureSessionControls(), null);
  assert.strictEqual(w.nodes.size, 0);
  const noCard = createLoginChrome({ gateEnabled: () => true, card: () => null, find: () => null, create: () => { throw new Error('nothing to put it in'); } });
  assert.strictEqual(noCard.ensureGuidance(), null);
  assert.strictEqual(noCard.ensureSessionControls(), null);
});

/* ---- The alpha's privacy actions ---------------------------------------------------------- */

check('what to revoke by hand: GitHub\'s links over https, the steps that have none said, and text never markup', () => {
  const html = revocationGuidanceBody([
    { label: 'Revoke the token on GitHub', url: 'https://github.com/settings/tokens' },
    { label: 'Revoke this retired provider credential manually in its account settings', url: null },
    { label: '<img src=x>', url: 'javascript:alert(1)' },
    { label: 'Over plain http', url: 'http://github.com/settings/tokens' },
    { label: '<b>Revoke</b> the App', url: 'https://github.com/settings/apps?x="><script>' },
    { label: 'Sign out of <i>every</i> device', url: null },
    { url: 'https://github.com/settings/installations' },
    null, 'loose'
  ]);
  assert(!html.includes('http://'), 'a link over plain http is not offered');
  assert(html.includes('<a class="btn btn-ghost small" href="https://github.com/settings/apps?x=&quot;&gt;&lt;script&gt;" target="_blank" rel="noopener noreferrer">&lt;b&gt;Revoke&lt;/b&gt; the App</a>'), 'the address and the words stay text');
  assert(html.includes('<li>Sign out of &lt;i&gt;every&lt;/i&gt; device</li>'), 'a step said is text');
  assert(html.includes('<a class="btn btn-ghost small" href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">Revoke the token on GitHub</a>'));
  assert(html.includes('>Open provider settings</a>'), 'a link with no label is still named');
  assert(html.includes('<ul class="hint revocation-steps"><li>Revoke this retired provider credential manually in its account settings</li><li>Sign out of &lt;i&gt;every&lt;/i&gt; device</li></ul>'));
  assert(!html.includes('javascript:') && !html.includes('<img'));
  assert(revocationGuidanceBody([]).includes('No provider revocation link was returned.'));
  assert(revocationGuidanceBody('nothing').includes('No provider revocation link was returned.'));
  assert(!revocationGuidanceBody([{ label: 'Step', url: null }]).includes('No provider revocation link'), 'a step said is something to do');
  assert(revocationGuidanceBody([]).includes('never claimed automatically'));
});

function privacyWorld(over = {}) {
  const log = [];
  const deps = {
    api: async (path, options) => { log.push(['api', path, JSON.stringify(options && options.body)]); if (over.fail === path) throw new Error('refused'); return over.answers && path in over.answers ? over.answers[path] : { ok: true, revocationGuidance: [{ label: 'Revoke the token on GitHub', url: 'https://github.com/settings/tokens' }] }; },
    modal: async request => { log.push(['modal', request.title, !!request.danger]); return 'modal' in over ? over.modal : true; },
    closeModal: confirmed => log.push(['closeModal', confirmed]),
    toast: (message, kind) => log.push(['toast', message, kind || '']),
    presentError: error => log.push(['error', error.message]),
    purgeLocalData: async full => log.push(['purge', full]),
    broadcastIdentityBoundary: () => log.push(['broadcast']),
    restoreLoginChrome: () => log.push(['chrome']),
    showSignIn: () => log.push(['signIn']),
    typedConfirmation: () => ('typed' in over ? over.typed : DELETE_PHRASE),
    attached: () => !over.detached
  };
  return { privacy: createAlphaPrivacy(deps), log };
}
const press = action => { const button = { disabled: false, dataset: { alphaPrivacyAction: action } }; return { button, target: { closest: sel => (sel === '[data-alpha-privacy-action]' ? button : null) } }; };

check('disconnect: the session left, the sign-in shown with its alpha panels, and nothing said revoked', async () => {
  const w = privacyWorld();
  await w.privacy.disconnectProviders(false);
  assert.deepStrictEqual(w.log, [['api', '/api/alpha/providers/disconnect-all', '{}'], ['purge', true], ['broadcast'], ['chrome'], ['signIn'], ['toast', 'Disconnected from Nebulaverse-X. Provider credentials were not claimed as revoked.', 'ok']]);
  const r = privacyWorld();
  await r.privacy.disconnectProviders(true);
  assert.deepStrictEqual(r.log.at(-1), ['modal', 'Revoke at provider', false], 'revoke: what to revoke by hand');
});

check('a clean-up the server has not finished leaves everything as it was, and says so', async () => {
  const pending = { ok: false, status: 'pending', results: [] };
  const w = privacyWorld({ answers: { '/api/alpha/providers/disconnect-all': pending } });
  await w.privacy.disconnectProviders(true);
  assert.deepStrictEqual(w.log.slice(1), [['toast', 'Provider cleanup is pending. Keep this session open and retry shortly.', '']]);
  const d = privacyWorld({ answers: { '/api/alpha/delete': pending } });
  await d.privacy.deleteData();
  assert.deepStrictEqual(d.log.slice(-1), [['toast', 'Alpha data deletion is pending provider cleanup. Keep this session open and retry shortly.', '']]);
  assert(!d.log.some(e => e[0] === 'purge'));
});

check('deleting is typed out in full, and declined or mistyped sends nothing', async () => {
  const w = privacyWorld();
  await w.privacy.deleteData();
  assert.deepStrictEqual(w.log, [['modal', 'Delete alpha data', true], ['api', '/api/alpha/delete', JSON.stringify({ confirm: DELETE_PHRASE })], ['purge', true], ['broadcast'], ['signIn'], ['toast', 'Alpha data deletion completed ✦', 'ok']]);
  const declined = privacyWorld({ modal: false });
  await declined.privacy.deleteData();
  assert.deepStrictEqual(declined.log, [['modal', 'Delete alpha data', true]]);
  for (const typed of ['delete alpha data', 'DELETE ALPHA DATA ', '', 'DELETE']) {
    const wrong = privacyWorld({ typed });
    await wrong.privacy.deleteData();
    assert.deepStrictEqual(wrong.log.slice(1), [['toast', `Type ${DELETE_PHRASE} exactly to confirm deletion.`, 'err']], JSON.stringify(typed));
  }
});

check('ending the alpha session leaves this browser and tells the other tabs', async () => {
  const w = privacyWorld();
  await w.privacy.endSession();
  assert.deepStrictEqual(w.log, [['api', '/api/alpha/end', '{}'], ['purge', true], ['broadcast'], ['signIn'], ['toast', 'Alpha session ended ✦', 'ok']]);
});

check('a privacy control closes the dialog it sits in, is busy while it works, and says what failed', async () => {
  for (const [action, first] of [['disconnect', '/api/alpha/providers/disconnect-all'], ['revoke', '/api/alpha/providers/disconnect-all'], ['end', '/api/alpha/end']]) {
    const w = privacyWorld();
    const { button, target } = press(action);
    const working = w.privacy.onClick(target);
    assert.strictEqual(button.disabled, true);
    await working;
    assert.deepStrictEqual(w.log.slice(0, 2), [['closeModal', false], ['api', first, '{}']], action);
    assert.strictEqual(button.disabled, false);
  }
  const del = privacyWorld();
  await del.privacy.onClick(press('delete').target);
  assert.deepStrictEqual(del.log[1], ['modal', 'Delete alpha data', true]);
  const failing = privacyWorld({ fail: '/api/alpha/end' });
  const { button, target } = press('end');
  await failing.privacy.onClick(target);
  assert.deepStrictEqual(failing.log.at(-1), ['error', 'refused']);
  assert.strictEqual(button.disabled, false);
  const busy = privacyWorld();
  const b = press('end');
  b.button.disabled = true;
  await busy.privacy.onClick(b.target);
  await busy.privacy.onClick({ closest: () => null });
  await busy.privacy.onClick(null);
  assert.deepStrictEqual(busy.log, []);
  const gone = privacyWorld({ detached: true });
  const g = press('end');
  await gone.privacy.onClick(g.target);
  assert.strictEqual(g.button.disabled, true, 'a control no longer in the page is left as it is');
});

check('guidance after an account left is shown only when there is something to revoke', async () => {
  const w = privacyWorld();
  assert.strictEqual(w.privacy.showRevocationGuidance([]), null);
  assert.strictEqual(w.privacy.showRevocationGuidance(undefined), null);
  assert.strictEqual(w.privacy.showRevocationGuidance('x'), null);
  await w.privacy.showRevocationGuidance([{ label: 'Step', url: null }]);
  assert.deepStrictEqual(w.log, [['modal', 'Revoke at provider', false]]);
});

process.exitCode = 1;
(async () => {
  for (const [name, run] of checks) {
    try { await run(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  }
  console.log(`page access tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
