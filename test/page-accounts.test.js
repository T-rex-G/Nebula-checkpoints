'use strict';

/*
 * The accounts sheet, asked directly (features/access/accounts-dialog.ts):
 * what it lists and offers, and switching, removing, adding and signing out,
 * each crossing the account boundary in its order.
 */

const assert = require('assert');
const { accountsBody, createAccountsDialog, GITHUB_MARK, REMOVAL_PENDING } = require('../apps/web/src/features/access/accounts-dialog.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

const github = (login, extra = {}) => ({ provider: 'github', login, ...extra });

/* ---- What the sheet shows ---------------------------------------------------------------- */

check('each GitHub account is a row: the one in use marked, the others offered, each removable; avatars only over https', () => {
  const html = accountsBody({ accounts: [github('alpha', { avatar: 'https://avatars.example/a' }), github('beta', { avatar: 'http://plain.example/b' }), github('<b>x</b>')], active: 0, oauthOn: false });
  assert.ok(html.includes('<div class="acct-row active">'), 'the account in use');
  assert.strictEqual((html.match(/<span class="br-tag">active<\/span>/g) || []).length, 1);
  assert.ok(html.includes('<button class="btn btn-ghost small" data-switch="1">Switch</button>') && html.includes('data-switch="2"'));
  assert.ok(!html.includes('data-switch="0"'), 'the account in use is not offered');
  for (const index of [0, 1, 2]) assert.ok(html.includes(`data-remove="${index}" title="Sign out this account only">Remove</button>`), String(index));
  assert.ok(html.includes('<img class="avatar" src="https://avatars.example/a" alt="">'));
  assert.ok(!html.includes('plain.example'), 'a picture over plain http is not drawn');
  assert.strictEqual((html.match(/acct-avatar-empty/g) || []).length, 2);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), 'a login is text');
  const quoted = accountsBody({ accounts: [github('q', { avatar: 'https://a.example/x"onerror="y' })], active: 0, oauthOn: false });
  assert.ok(quoted.includes('src="https://a.example/x&quot;onerror=&quot;y"'), 'a picture\'s address stays inside its attribute');
  assert.strictEqual((html.match(new RegExp(GITHUB_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 3);
  assert.ok(html.includes('<button class="btn btn-ghost small" id="accAdd">Add account</button>') && html.includes('id="accOut">Sign out (all)</button>'));
  assert.ok(!html.includes('acct-lead') && !html.includes('repository-delete'));
});

check('a retired account is listed only to be removed, and the sheet says what to do about its token', () => {
  const one = accountsBody({ accounts: [github('alpha'), { provider: 'gitlab', login: 'old' }], active: 0, oauthOn: false });
  assert.ok(one.includes('<p class="hint acct-lead">GitLab and Gitea accounts are no longer supported. Remove it, then revoke its token in that provider\'s settings.</p>'));
  assert.ok(one.includes('<div class="acct-row retired">') && one.includes('GitLab · no longer supported'));
  assert.ok(one.includes('data-remove="1" title="Remove this account and its stored token">Remove</button>') && !one.includes('data-switch="1"'), 'never switched to');
  const two = accountsBody({ accounts: [{ provider: 'gitea', login: 'g' }, { provider: 'gitlab', login: 'l' }, github('alpha')], active: 0, oauthOn: false });
  assert.ok(two.includes('<p class="hint acct-lead">Choose a GitHub account to continue. GitLab and Gitea accounts are no longer supported. Remove them, then revoke their tokens in that provider\'s settings.</p>'),
    'a retired account in use asks for a GitHub one first');
  assert.ok(two.includes('Gitea · no longer supported') && two.includes('data-switch="2"'));
});

check('the wider grant is offered only to an OAuth GitHub account in use, where the deployment offers OAuth', () => {
  const grant = '<a class="btn btn-ghost small" href="/api/oauth/login?permission=repository-delete">Allow repository deletion on GitHub</a>';
  assert.ok(accountsBody({ accounts: [github('a', { authMethod: 'oauth' })], active: 0, oauthOn: true }).includes(grant));
  assert.ok(!accountsBody({ accounts: [github('a', { authMethod: 'oauth' })], active: 0, oauthOn: false }).includes(grant));
  assert.ok(!accountsBody({ accounts: [github('a', { authMethod: 'token' })], active: 0, oauthOn: true }).includes(grant));
  assert.ok(!accountsBody({ accounts: [{ provider: 'gitlab', authMethod: 'oauth' }], active: 0, oauthOn: true }).includes(grant));
  assert.ok(accountsBody({ accounts: [github('a'), github('b', { authMethod: 'oauth' })], active: '1', oauthOn: true }).includes(grant), 'the position the server names, as the list reads it');
});

/* ---- The sheet at work -------------------------------------------------------------------- */

function sheetWorld(over = {}) {
  const log = [];
  let generation = 1;
  let owned = true;
  const controls = new Map();
  const control = (selector, data = {}) => {
    const node = { disabled: !!data.disabled, dataset: data, listeners: [], addEventListener(type, listener) { this.listeners.push(listener); } };
    controls.set(selector, [...(controls.get(selector) || []), node]);
    return node;
  };
  let body = '';
  const answers = {
    '/api/accounts': { active: 0, accounts: [github('alpha'), github('beta')] },
    '/api/accounts/switch-idx': { ok: true, login: 'beta' },
    '/api/accounts/remove': { ok: true, removed: 'beta', active: 0, revocationGuidance: [{ label: 'Revoke', url: 'https://github.com/settings/tokens' }] },
    ...(over.answers || {})
  };
  const deps = {
    api: async (path, options) => {
      log.push(['api', path, options ? JSON.stringify(options.body) : '']);
      const answer = answers[path];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer() : answer;
    },
    modal: request => log.push(['modal', request.title, request.okText]),
    owner: () => () => owned,
    generation: () => generation,
    closeModal: confirmed => { log.push(['close', confirmed]); generation += 1; },
    setBody: html => {
      body = html;
      controls.clear();
      for (const match of html.matchAll(/data-(switch|remove)="(\d+)"/g)) control(`#modalBody [data-${match[1]}]`, { [match[1]]: match[2] });
      if (html.includes('id="accAdd"')) control('#accAdd');
      if (html.includes('id="accOut"')) control('#accOut');
      if (over.heldElsewhere) control('#modalBody button', { disabled: true });
    },
    controls: selector => (selector === '#modalBody button'
      ? [...controls.entries()].filter(([s]) => s.startsWith('#modalBody') || s === '#accAdd' || s === '#accOut').flatMap(([, list]) => list)
      : controls.get(selector) || []),
    oauthOn: () => false,
    purge: async full => log.push(['purge', full]),
    broadcast: () => log.push(['broadcast']),
    clearAddress: () => log.push(['clear-address']),
    restart: async () => { log.push(['restart', heldNow()]); if (over.restart === 'throw') throw new Error('start failed'); },
    forgetRemembered: () => log.push(['forget']),
    showSignIn: () => log.push(['sign-in']),
    addAccount: () => log.push(['add']),
    signOut: () => log.push(['sign-out']),
    toast: (message, kind) => log.push(['toast', message, kind || '']),
    showRevocationGuidance: guidance => log.push(['guidance', JSON.stringify(guidance)])
  };
  const heldNow = () => [...controls.values()].flat().filter(node => node.disabled).length;
  const press = async (selector, index = 0) => { for (const listener of controls.get(selector)[index].listeners) listener(); await new Promise(resolve => setImmediate(resolve)); };
  return { dialog: createAccountsDialog(deps), log, body: () => body, press, controls, heldNow, setOwned: v => { owned = v; }, bump: () => { generation += 1; } };
}

check('the sheet opens at once, and draws what the server lists only while it is still the sheet open', async () => {
  const world = sheetWorld();
  await world.dialog.open();
  assert.deepStrictEqual(world.log.slice(0, 2), [['modal', 'Accounts', 'Done'], ['api', '/api/accounts', '']]);
  assert.ok(world.body().includes('data-switch="1"'));
  const overtaken = sheetWorld({ answers: { '/api/accounts': () => { overtaken.setOwned(false); return { active: 0, accounts: [github('a')] }; } } });
  await overtaken.dialog.open();
  assert.strictEqual(overtaken.body(), '', 'another dialog has the page: nothing is drawn into it');
  const refused = sheetWorld({ answers: { '/api/accounts': new Error('Service waking <now>') } });
  await refused.dialog.open();
  assert.strictEqual(refused.body(), '<p class="hint">⚠ Service waking &lt;now&gt;</p>');
  const refusedLate = sheetWorld({ answers: { '/api/accounts': () => { refusedLate.setOwned(false); throw new Error('Service waking'); } } });
  await refusedLate.dialog.open();
  assert.strictEqual(refusedLate.body(), '', 'a refusal is not drawn into a dialog that is another\'s now');
});

check('a switch crosses the boundary before the server is asked, holds the sheet until the page has started again, then says so', async () => {
  const world = sheetWorld();
  await world.dialog.open();
  await world.press('#modalBody [data-switch]');
  assert.deepStrictEqual(world.log.slice(2), [
    ['purge', false], ['api', '/api/accounts/switch-idx', JSON.stringify({ idx: 1 })], ['broadcast'], ['clear-address'],
    ['restart', 5], ['close', true], ['toast', 'Switched to beta ✦', 'ok']
  ], 'every control held while the page starts again as the new account');
  assert.strictEqual(world.heldNow(), 0, 'and released after');
});

check('a refused switch starts the page again as who is still signed in, and announces nothing', async () => {
  const world = sheetWorld({ answers: { '/api/accounts/switch-idx': new Error('The account could not be switched.') } });
  await world.dialog.open();
  await world.press('#modalBody [data-switch]');
  assert.deepStrictEqual(world.log.slice(2), [
    ['purge', false], ['api', '/api/accounts/switch-idx', JSON.stringify({ idx: 1 })], ['toast', 'The account could not be switched.', 'err'], ['restart', 5]
  ]);
  assert.strictEqual(world.heldNow(), 0);
});

check('a removal lets go before asking, then fully if nobody is left, tells the other tabs, and says what to revoke', async () => {
  const world = sheetWorld();
  await world.dialog.open();
  await world.press('#modalBody [data-remove]', 1);
  assert.deepStrictEqual(world.log.slice(2), [
    ['purge', false], ['api', '/api/accounts/remove', JSON.stringify({ idx: 1 })], ['purge', false], ['broadcast'], ['clear-address'],
    ['restart', 5], ['close', true], ['toast', 'beta signed out ✦', 'ok'], ['guidance', JSON.stringify([{ label: 'Revoke', url: 'https://github.com/settings/tokens' }])]
  ]);
  const last = sheetWorld({ answers: { '/api/accounts/remove': { ok: true, removed: 'alpha', empty: true } } });
  await last.dialog.open();
  await last.press('#modalBody [data-remove]');
  assert.deepStrictEqual(last.log.slice(2), [
    ['purge', false], ['api', '/api/accounts/remove', JSON.stringify({ idx: 0 })], ['purge', true], ['broadcast'], ['forget'], ['sign-in'],
    ['close', true], ['toast', 'alpha signed out ✦', 'ok'], ['guidance', undefined]
  ], 'the last account gone, there is nobody to start as: the sign-in, and this tab forgets who it was');
});

check('a removal the provider has not finished is not a removal: nothing more let go of, no tab told, and it says so', async () => {
  const world = sheetWorld({ answers: { '/api/accounts/remove': { ok: false, status: 'pending', results: [] } } });
  await world.dialog.open();
  await world.press('#modalBody [data-remove]', 1);
  assert.deepStrictEqual(world.log.slice(2), [
    ['purge', false], ['api', '/api/accounts/remove', JSON.stringify({ idx: 1 })], ['toast', REMOVAL_PENDING, ''], ['restart', 5]
  ], 'the page starts again as the account still signed in; the sheet stays, with its controls back');
  assert.strictEqual(world.heldNow(), 0);
  assert.ok(!world.log.some(entry => entry[0] === 'close' || (entry[0] === 'toast' && /signed out/.test(entry[1]))));
  const other = sheetWorld({ answers: { '/api/accounts/remove': { ok: false, status: 'unknown' } } });
  await other.dialog.open();
  await other.press('#modalBody [data-remove]', 1);
  assert.ok(other.log.some(entry => entry[0] === 'broadcast'), 'only "pending" holds a removal back, as the server sends no other');
});

check('a refused removal, and a start that fails, release the sheet all the same', async () => {
  const refused = sheetWorld({ answers: { '/api/accounts/remove': new Error('Removal refused') } });
  await refused.dialog.open();
  await refused.press('#modalBody [data-remove]');
  assert.deepStrictEqual(refused.log.slice(-2), [['toast', 'Removal refused', 'err'], ['restart', 5]]);
  assert.strictEqual(refused.heldNow(), 0);
  const failing = sheetWorld({ restart: 'throw' });
  await failing.dialog.open();
  await failing.press('#modalBody [data-switch]');
  assert.strictEqual(failing.heldNow(), 0, 'released even when the start throws');
  assert.ok(failing.log.some(entry => entry[0] === 'toast' && entry[1] === 'Switched to beta ✦'));
});

check('only the controls the sheet held are released, and a sheet another dialog replaced is not closed', async () => {
  const world = sheetWorld({ heldElsewhere: true });
  await world.dialog.open();
  await world.press('#modalBody [data-switch]');
  assert.strictEqual(world.heldNow(), 1, 'a control that was already held stays held');
  const replaced = sheetWorld({ answers: { '/api/accounts/switch-idx': () => { replaced.bump(); return { ok: true, login: 'beta' }; } } });
  await replaced.dialog.open();
  await replaced.press('#modalBody [data-switch]');
  assert.ok(!replaced.log.some(entry => entry[0] === 'close'), 'the dialog is another\'s now');
  assert.ok(replaced.log.some(entry => entry[0] === 'toast' && entry[1] === 'Switched to beta ✦'));
});

check('adding an account and signing out of all close the sheet first', async () => {
  const world = sheetWorld();
  await world.dialog.open();
  await world.press('#accAdd');
  await world.press('#accOut');
  assert.deepStrictEqual(world.log.slice(2), [['close', true], ['add'], ['close', true], ['sign-out']]);
});

/* Unfinished counts as failed. */
process.exitCode = 1;
(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`  ok  ${name}`); } catch (error) { failed += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
  }
  if (failed) { console.error(`${failed} of ${checks.length} accounts checks failed`); return; }
  console.log(`page accounts tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})();
