'use strict';

/*
 * The repository header's controls, asked directly: the branches as the
 * selects and the comparison hold them (features/repositories/repository-branches.ts),
 * the repository read again, the branch chosen and created, the star and the
 * archive (repository-header-controller.ts), and the files card stepping
 * aside on a desk (features/workbench/files-panel.ts).
 */

const assert = require('assert');
const { fillBranchSelect, branchProtected, branchList, compareSides, repositoryChanges } = require('../apps/web/src/features/repositories/repository-branches.ts');
const { createRepositoryHeader } = require('../apps/web/src/features/repositories/repository-header-controller.ts');
const { FILES_HIDDEN_KEY, createFilesPanel } = require('../apps/web/src/features/workbench/files-panel.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const flush = () => new Promise(resolve => setImmediate(resolve));

/* ---- The branches ------------------------------------------------------------------------------ */

function select(value = '') {
  const el = { options: [], value, cleared: 0, appendChild(option) { this.options.push(option); if (option.selected) this.value = option.value; return option; } };
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: html => { assert.strictEqual(html, ''); el.cleared += 1; el.options = []; } });
  return el;
}
const optionDoc = { createElement: tag => { assert.strictEqual(tag, 'option'); return { value: '', textContent: '', selected: false }; } };
const shown = el => el.options.map(option => `${option.value}|${option.textContent}${option.selected ? '*' : ''}`);

check('a select is emptied and filled with the names as the page shows them, the chosen one marked', () => {
  const el = select();
  el.options = [{ value: 'stale' }];
  fillBranchSelect(optionDoc, el, ['main', 'dev', 7, null, undefined], 'dev');
  assert.strictEqual(el.cleared, 1);
  assert.deepStrictEqual(shown(el), ['main|main', 'dev|dev*', '7|7', 'null|', 'undefined|']);
  assert.ok(el.options.every(option => typeof option.value === 'string'), 'an option is handed its value as text');
  const none = select();
  fillBranchSelect(optionDoc, none, ['main'], 'Main');
  assert.deepStrictEqual(shown(none), ['main|main'], 'chosen exactly, not by case');
  fillBranchSelect(optionDoc, none, [], 'main');
  assert.deepStrictEqual(shown(none), []);
});

check('a branch is protected only when the repository says so', () => {
  const work = { branches: [{ name: 'main', protected: true }, { name: 'dev', protected: false }, { name: 'old' }, null] };
  assert.strictEqual(branchProtected(work, 'main'), true);
  for (const name of ['dev', 'old', 'Main', 'missing', undefined]) assert.strictEqual(branchProtected(work, name), false, String(name));
  assert.strictEqual(branchProtected({}, 'main'), false);
  assert.strictEqual(branchProtected(null, 'main'), false);
  assert.strictEqual(branchProtected({ branches: [{ name: 'main', protected: 1 }] }, 'main'), true);
});

check('an answer lists branches the page can hold, or none', () => {
  const branches = [{ name: 'main' }];
  assert.strictEqual(branchList({ branches }), branches);
  assert.deepStrictEqual(branchList({ branches: [] }), []);
  for (const info of [null, 'x', 7, {}, { branches: null }, { branches: 'main' }, { branches: [null] }, { branches: [{ name: 'a' }, 'b'] }, { branches: { 0: {} } }]) {
    assert.strictEqual(branchList(info), null, JSON.stringify(info));
  }
});

check('the comparison keeps its sides while their branches exist, and otherwise sets them apart', () => {
  assert.deepStrictEqual(compareSides(['main', 'dev', 'x'], 'dev', 'x', 'main'), { base: 'dev', head: 'x' });
  assert.deepStrictEqual(compareSides(['main', 'dev'], 'gone', 'gone', 'main'), { base: 'main', head: 'dev' });
  assert.deepStrictEqual(compareSides(['dev', 'main'], '', '', 'main'), { base: 'main', head: 'dev' });
  assert.deepStrictEqual(compareSides(['main'], 'x', 'y', 'main'), { base: 'main', head: 'main' });
  assert.deepStrictEqual(compareSides([], 'x', 'y', 'main'), { base: 'main', head: 'main' });
});

check('a repository read again changes every field it answered, and keeps the branch while it exists', () => {
  const work = { owner: 'o', repo: 'r', branch: 'dev', starred: true };
  const branches = [{ name: 'main' }, { name: 'dev' }];
  assert.deepStrictEqual(repositoryChanges(work, { default_branch: 'main', private: false, branches }, branches), { default_branch: 'main', private: false, branches, branch: 'dev' });
  assert.strictEqual(repositoryChanges(work, { default_branch: 'main', branches: [{ name: 'main' }] }, [{ name: 'main' }]).branch, 'main');
  assert.strictEqual(repositoryChanges({ branch: 'x' }, { branches: [] }, []).branch, undefined);
  const odd = JSON.parse('{"__proto__": {"polluted": true}, "default_branch": "main", "branches": []}');
  const changes = repositoryChanges(work, odd, []);
  assert.strictEqual(Object.getPrototypeOf(changes), Object.prototype);
  assert.deepStrictEqual(Object.keys(changes), ['__proto__', 'default_branch', 'branches', 'branch']);
  assert.strictEqual({}.polluted, undefined);
});

/* ---- The header at work ------------------------------------------------------------------------ */

function harness({ work = { owner: 'octo', repo: 'repo', branch: 'main', default_branch: 'main', branches: [{ name: 'main', protected: true }, { name: 'dev' }] } } = {}) {
  const state = { work };
  const log = [];
  const pending = [];
  const branchEl = select('main');
  const baseEl = select('main');
  const headEl = select('dev');
  const shield = { hidden: true };
  const links = [];
  const h = { state, log, pending, branchEl, baseEl, headEl, shield, links, name: 'feature/x', dialog: null, haveShield: true };
  const doc = {
    createElement: tag => {
      if (tag === 'option') return { value: '', textContent: '', selected: false };
      const link = { tag, href: '', download: null, click() { log.push(['click', link.href, link.download]); }, remove() { log.push(['remove']); } };
      links.push(link);
      return link;
    },
    body: { appendChild: node => { log.push(['append', node.tag]); return node; } }
  };
  h.header = createRepositoryHeader({
    state,
    api: (path, options) => new Promise((resolve, reject) => { log.push(['api', path, options === undefined ? null : options]); pending.push({ path, resolve, reject }); }),
    mutateWork: change => { change(state.work); log.push(['mutate']); },
    doc,
    branchSelect: () => branchEl,
    compareBase: () => baseEl,
    compareHead: () => headEl,
    shield: () => (h.haveShield ? shield : null),
    modal: request => new Promise(resolve => { h.dialog = { request, resolve }; log.push(['modal', request.title, request.okText]); }),
    newBranchName: () => h.name,
    toast: (message, kind) => log.push(['toast', message, kind === undefined ? null : kind]),
    presentError: error => log.push(['error', error && error.message]),
    haptic: () => log.push(['haptic']),
    closeDrawer: () => log.push(['drawer']),
    closeFile: () => log.push(['closeFile']),
    reloadTree: () => log.push(['tree']),
    reloadView: () => log.push(['view']),
    resetCommits: () => log.push(['commits']),
    branchChanged: () => log.push(['branch']),
    refreshRate: () => log.push(['rate']),
    saveRoute: () => log.push(['route'])
  });
  return h;
}
const INFO = (over = {}) => ({ full_name: 'Octo/Repo', default_branch: 'main', private: true, branches: [{ name: 'main', protected: true }, { name: 'dev', protected: false }, { name: 'next' }], ...over });

check('with nothing open, or a record without its names, nothing is read again', async () => {
  for (const work of [null, {}, { owner: 'o' }, { repo: 'r' }]) {
    const h = harness({ work });
    assert.strictEqual(await h.header.refresh(), null);
    assert.deepStrictEqual(h.log, []);
  }
});

check('a repository read again is laid over the one open, in place, its branch kept and its selects and shield redrawn', async () => {
  const h = harness();
  const work = h.state.work;
  work.branch = 'dev';
  h.baseEl.value = 'dev';
  h.headEl.value = 'gone';
  const asked = h.header.refresh();
  assert.deepStrictEqual(h.log, [['api', '/api/repo/octo/repo', null]]);
  const info = INFO();
  h.pending.shift().resolve(info);
  assert.strictEqual(await asked, info);
  assert.strictEqual(h.state.work, work, 'the same record: every reading that holds it still knows the repository');
  assert.strictEqual(work.full_name, 'Octo/Repo');
  assert.strictEqual(work.branch, 'dev');
  assert.strictEqual(work.branches, info.branches);
  assert.deepStrictEqual(h.log.slice(1), [['mutate']]);
  assert.deepStrictEqual(shown(h.branchEl), ['main|main', 'dev|dev*', 'next|next']);
  assert.deepStrictEqual(shown(h.baseEl), ['main|main', 'dev|dev*', 'next|next'], 'the base kept');
  assert.deepStrictEqual(shown(h.headEl), ['main|main', 'dev|dev*', 'next|next'], 'a head gone becomes the first branch other than the default');
  assert.strictEqual(h.shield.hidden, true, 'dev is not protected');
  const back = harness();
  back.state.work.branch = 'deleted';
  const again = back.header.refresh();
  back.pending.shift().resolve(INFO({ default_branch: 'next' }));
  await again;
  assert.strictEqual(back.state.work.branch, 'next', 'a branch no longer listed falls back to the default');
  assert.deepStrictEqual(shown(back.branchEl), ['main|main', 'dev|dev', 'next|next*']);
  assert.deepStrictEqual(shown(back.baseEl).find(entry => entry.endsWith('*')), 'main|main*', 'the base kept while it exists');
  const moved = harness();
  moved.baseEl.value = 'gone';
  moved.headEl.value = 'gone';
  const reread = moved.header.refresh();
  moved.pending.shift().resolve(INFO({ default_branch: 'next', branches: [{ name: 'next' }, { name: 'main' }] }));
  await reread;
  assert.deepStrictEqual([shown(moved.baseEl), shown(moved.headEl)], [['next|next*', 'main|main'], ['next|next', 'main|main*']], 'sides gone fall back to the default the answer names');
  const shieldUp = harness();
  const read = shieldUp.header.refresh();
  shieldUp.pending.shift().resolve(INFO());
  await read;
  assert.strictEqual(shieldUp.shield.hidden, false, 'main is protected');
});

check('an answer for a repository no longer open changes nothing on the one that is', async () => {
  const h = harness();
  const asked = h.header.refresh();
  const other = { owner: 'someone', repo: 'else', branch: 'trunk', branches: [{ name: 'trunk', protected: true }] };
  h.state.work = other;
  h.pending.shift().resolve(INFO());
  assert.strictEqual(await asked, null);
  assert.deepStrictEqual(other, { owner: 'someone', repo: 'else', branch: 'trunk', branches: [{ name: 'trunk', protected: true }] });
  assert.deepStrictEqual(h.log.slice(1), []);
  assert.deepStrictEqual(shown(h.branchEl), []);
  assert.strictEqual(h.shield.hidden, true);
  const gone = harness();
  const left = gone.header.refresh();
  gone.state.work = null;
  gone.pending.shift().resolve(null);
  assert.strictEqual(await left, null, 'an account gone takes nothing either, even an answer that is no repository');
});

check('an answer without its branches is refused with a plain reason, and nothing is changed', async () => {
  for (const answer of [null, {}, { default_branch: 'main' }, { branches: 'main' }, { branches: [null] }]) {
    const h = harness();
    const before = JSON.stringify(h.state.work);
    const asked = h.header.refresh();
    h.pending.shift().resolve(answer);
    await assert.rejects(asked, { message: 'The repository answered without its branches, so it was not read again.' });
    assert.strictEqual(JSON.stringify(h.state.work), before);
    assert.deepStrictEqual(shown(h.branchEl), []);
  }
});

check('Refresh reads the repository, its tree and the tool open again, and says so; a failure is said and the rest still read', async () => {
  const h = harness();
  const done = h.header.sync();
  assert.deepStrictEqual(h.log, [['haptic'], ['api', '/api/repo/octo/repo', null]]);
  h.pending.shift().resolve(INFO());
  await done;
  assert.deepStrictEqual(h.log.slice(2), [['mutate'], ['tree'], ['view'], ['rate'], ['toast', 'Refreshed \u2726', 'ok']]);
  const failing = harness();
  const failed = failing.header.sync();
  failing.pending.shift().reject(new Error('rate limited'));
  await failed;
  assert.deepStrictEqual(failing.log.slice(2), [['toast', 'rate limited', 'err'], ['tree'], ['view'], ['rate'], ['toast', 'Refreshed \u2726', 'ok']]);
  for (const work of [null, {}, { owner: 'o', repo: '' }]) {
    const none = harness({ work });
    await none.header.sync();
    assert.deepStrictEqual(none.log, [], 'nothing open, nothing read');
  }
});

check('a Refresh overtaken by another repository stops: the one opened was read for itself', async () => {
  const h = harness();
  const done = h.header.sync();
  h.state.work = { owner: 'someone', repo: 'else', branch: 'trunk', branches: [] };
  h.pending.shift().resolve(INFO());
  await done;
  assert.deepStrictEqual(h.log, [['haptic'], ['api', '/api/repo/octo/repo', null]]);
});

check('a branch chosen is held, shielded, and read from the top with its commits and address', () => {
  const h = harness();
  h.state.work.branch = 'dev';
  h.header.changeBranch('main');
  assert.strictEqual(h.state.work.branch, 'main');
  assert.strictEqual(h.shield.hidden, false);
  assert.deepStrictEqual(h.log, [['mutate'], ['closeFile'], ['tree'], ['commits'], ['branch'], ['route']], 'the tool open drawn for the branch before its address is kept');
  h.header.changeBranch('dev');
  assert.strictEqual(h.shield.hidden, true);
  h.haveShield = false;
  assert.doesNotThrow(() => h.header.refreshShield());
});

check('a branch is created from the one shown and switched to, with its shield and its address', async () => {
  const h = harness();
  h.state.work.branch = '<main>&';
  h.state.work.branches.push({ name: '<main>&', protected: true });
  h.shield.hidden = false;
  const done = h.header.createBranch();
  assert.deepStrictEqual(h.log, [['modal', 'New branch', 'Create branch']]);
  assert.ok(h.dialog.request.bodyHTML.includes('Created from <b>&lt;main&gt;&amp;</b>'));
  assert.ok(h.dialog.request.bodyHTML.includes('<input id="nbName" type="text" placeholder="feature/starlight" autocapitalize="off" autocorrect="off" spellcheck="false">'),
    'a branch name is typed exactly: its field declines what a phone keyboard would correct or capitalise');
  h.name = '  feature/x  ';
  /* A branch changed while the dialog was open: it is created from the one the dialog named. */
  h.state.work.branch = 'dev';
  h.dialog.resolve(true);
  await flush();
  assert.deepStrictEqual(h.log[1], ['api', '/api/repo/octo/repo/branches', { method: 'POST', body: { name: 'feature/x', from: '<main>&' } }]);
  h.state.work.branch = '<main>&';
  h.pending.shift().resolve({ sha: 'abc' });
  await done;
  assert.deepStrictEqual(h.state.work.branches.slice(-1), [{ name: 'feature/x', sha: 'abc' }]);
  for (const el of [h.branchEl, h.baseEl, h.headEl]) assert.deepStrictEqual(shown(el), ['feature/x|feature/x']);
  assert.strictEqual(h.branchEl.value, 'feature/x');
  assert.strictEqual(h.state.work.branch, 'feature/x');
  assert.strictEqual(h.shield.hidden, true, 'the new branch is not the protected one it came from');
  assert.deepStrictEqual(h.log.slice(2), [['mutate'], ['mutate'], ['branch'], ['route'], ['toast', 'Branch feature/x created \u2726', 'ok'], ['drawer']],
    'made from the branch on screen, what is shown is the new branch\'s already: only the tool open is drawn for it');
  /* Another branch chosen while the dialog was open: what is on screen is that one's, and is read again for the new branch. */
  const moved = harness();
  const making = moved.header.createBranch();
  moved.name = 'feature/y';
  moved.dialog.resolve(true);
  await flush();
  moved.state.work.branch = 'dev';
  moved.pending.shift().resolve({ sha: 'abc' });
  await making;
  assert.strictEqual(moved.state.work.branch, 'feature/y');
  assert.deepStrictEqual(moved.log.slice(2), [['mutate'], ['mutate'], ['closeFile'], ['tree'], ['commits'], ['branch'], ['route'], ['toast', 'Branch feature/y created \u2726', 'ok'], ['drawer']]);
  const shaless = harness();
  const made = shaless.header.createBranch();
  shaless.dialog.resolve(true);
  await flush();
  shaless.pending.shift().resolve(null);
  await made;
  assert.deepStrictEqual(shaless.state.work.branches.slice(-1), [{ name: 'feature/x', sha: '' }]);
});

check('a new branch dismissed, or unnamed, asks nothing; one refused says why and changes nothing', async () => {
  for (const [ok, name] of [[false, 'feature/x'], [null, 'x'], [true, '   '], [true, '']]) {
    const h = harness();
    const done = h.header.createBranch();
    h.name = name;
    h.dialog.resolve(ok);
    await done;
    assert.deepStrictEqual(h.log, [['modal', 'New branch', 'Create branch']]);
  }
  const refused = harness();
  const done = refused.header.createBranch();
  refused.dialog.resolve(true);
  await flush();
  refused.pending.shift().reject(new Error('Branch already exists'));
  await done;
  assert.deepStrictEqual(refused.log.slice(2), [['toast', 'Branch already exists', 'err']]);
  assert.strictEqual(refused.state.work.branch, 'main');
  const none = harness({ work: null });
  await none.header.createBranch();
  assert.deepStrictEqual(none.log, []);
});

check('a branch created after another repository was opened is said, and the one open is not switched to it', async () => {
  const h = harness();
  const done = h.header.createBranch();
  h.dialog.resolve(true);
  await flush();
  const other = { owner: 'someone', repo: 'else', branch: 'trunk', branches: [{ name: 'trunk' }] };
  h.state.work = other;
  h.pending.shift().resolve({ sha: 'abc' });
  await done;
  assert.deepStrictEqual(other, { owner: 'someone', repo: 'else', branch: 'trunk', branches: [{ name: 'trunk' }] });
  assert.deepStrictEqual(shown(h.branchEl), []);
  assert.deepStrictEqual(h.log.slice(2), [['toast', 'Branch feature/x created \u2726', 'ok'], ['drawer']]);
});

check('the star is set or taken away as the repository holds it, and only on the repository it was asked for', async () => {
  const h = harness();
  const put = h.header.toggleStar();
  assert.deepStrictEqual(h.log, [['api', '/api/repo/octo/repo/star', { method: 'PUT' }]]);
  h.pending.shift().resolve({ starred: true });
  await put;
  assert.strictEqual(h.state.work.starred, true);
  assert.deepStrictEqual(h.log.slice(1), [['mutate'], ['toast', '\u2605 Starred', 'ok']]);
  const take = h.header.toggleStar();
  assert.deepStrictEqual(h.log[3], ['api', '/api/repo/octo/repo/star', { method: 'DELETE' }]);
  h.pending.shift().resolve({ starred: false });
  await take;
  assert.strictEqual(h.state.work.starred, false);
  assert.deepStrictEqual(h.log.slice(4), [['mutate'], ['toast', 'Unstarred', 'ok']]);
  const moved = harness();
  const asked = moved.header.toggleStar();
  const other = { owner: 'someone', repo: 'else' };
  moved.state.work = other;
  moved.pending.shift().resolve({ starred: true });
  await asked;
  assert.deepStrictEqual(other, { owner: 'someone', repo: 'else' });
  assert.deepStrictEqual(moved.log.slice(1), [['toast', '\u2605 Starred', 'ok']]);
});

check('a star the answer does not confirm is not said, and a refusal is presented', async () => {
  for (const answer of [null, {}, { starred: 'yes' }, { starred: 1 }]) {
    const h = harness();
    const asked = h.header.toggleStar();
    h.pending.shift().resolve(answer);
    await asked;
    assert.deepStrictEqual(h.log.slice(1), [['error', 'The star could not be confirmed.']], JSON.stringify(answer));
    assert.strictEqual(h.state.work.starred, undefined);
  }
  const refused = harness();
  const asked = refused.header.toggleStar();
  refused.pending.shift().reject(new Error('not allowed'));
  await asked;
  assert.deepStrictEqual(refused.log.slice(1), [['error', 'not allowed']]);
  const none = harness({ work: null });
  await none.header.toggleStar();
  assert.deepStrictEqual(none.log, []);
});

check('the archive is fetched for the branch open, through a link made and let go of', () => {
  const h = harness();
  h.state.work.branch = 'feature/a b';
  h.header.downloadZip();
  assert.deepStrictEqual(h.log, [['append', 'a'], ['click', '/api/repo/octo/repo/zip?ref=feature%2Fa%20b', ''], ['remove'], ['toast', 'Preparing archive\u2026', null]]);
  const none = harness({ work: null });
  none.header.downloadZip();
  assert.deepStrictEqual(none.log, []);
});

/* ---- The files card ---------------------------------------------------------------------------- */

function panel({ stored = null, mobile = false, onWork = true, refuse = null, parts = true } = {}) {
  const log = [];
  const held = stored === null ? {} : { [FILES_HIDDEN_KEY]: stored };
  const classes = new Set();
  const workspace = { classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); } } };
  const inside = { inside: true };
  const side = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; }, contains: node => node === inside };
  const toggle = { title: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, focus: options => log.push(['focus', options]) };
  const p = { log, held, classes, side, toggle, inside, active: null, mobile, onWork, refuse, parts };
  p.panel = createFilesPanel({
    storage: () => ({
      getItem: key => { if (p.refuse === 'read' || p.refuse === 'all') throw new Error('denied'); return Object.hasOwn(held, key) ? held[key] : null; },
      setItem: (key, value) => { if (p.refuse === 'write' || p.refuse === 'all') throw new Error('quota'); held[key] = value; }
    }),
    workspace: () => (p.parts ? workspace : null),
    side: () => (p.parts ? side : null),
    toggle: () => (p.parts ? toggle : null),
    mobile: () => p.mobile,
    onWork: () => p.onWork,
    active: () => p.active
  });
  return p;
}

check('the files card is shown unless this browser kept it aside, and a browser that keeps nothing shows it', () => {
  assert.strictEqual(FILES_HIDDEN_KEY, 'nv_files_hidden');
  assert.strictEqual(panel({ stored: '1' }).panel.hidden(), true);
  for (const stored of [null, '0', 'true', '']) assert.strictEqual(panel({ stored }).panel.hidden(), false, String(stored));
  assert.strictEqual(panel({ stored: '1', refuse: 'read' }).panel.hidden(), false);
});

check('aside on a desk the card is out of sight and inert, and its toggle says how to bring it back; on a phone it is the drawer', () => {
  const p = panel({ stored: '1' });
  p.panel.apply();
  assert.deepStrictEqual([...p.classes], ['files-hidden']);
  assert.deepStrictEqual(p.side.attrs, { inert: '' });
  assert.deepStrictEqual(p.toggle.attrs, { 'aria-expanded': 'false', 'aria-label': 'Show files' });
  assert.strictEqual(p.toggle.title, 'Show files (Ctrl+B)');
  p.mobile = true;
  p.panel.apply();
  assert.deepStrictEqual([...p.classes], []);
  assert.deepStrictEqual(p.side.attrs, {});
  assert.deepStrictEqual(p.toggle.attrs, { 'aria-expanded': 'true', 'aria-label': 'Hide files' });
  assert.strictEqual(p.toggle.title, 'Hide files (Ctrl+B)');
  assert.strictEqual(p.panel.hidden(), true, 'the preference outlives the phone');
  const bare = panel({ stored: '1', parts: false });
  assert.doesNotThrow(() => bare.panel.apply());
});

check('setting the card aside is kept in this browser; focus inside it goes to the toggle, and only then', () => {
  const p = panel();
  p.active = p.inside;
  p.panel.set(true);
  assert.strictEqual(p.held[FILES_HIDDEN_KEY], '1');
  assert.deepStrictEqual(p.side.attrs, { inert: '' });
  assert.deepStrictEqual(p.log, [['focus', { preventScroll: true }]]);
  p.panel.set(false);
  assert.strictEqual(p.held[FILES_HIDDEN_KEY], '0');
  assert.deepStrictEqual(p.side.attrs, {});
  assert.strictEqual(p.log.length, 1, 'bringing it back moves no focus');
  p.active = { elsewhere: true };
  p.panel.set(true);
  assert.strictEqual(p.log.length, 1, 'focus elsewhere stays where it is');
  const refusing = panel({ refuse: 'write' });
  refusing.panel.set(1);
  assert.strictEqual(refusing.panel.hidden(), true);
  assert.deepStrictEqual(refusing.side.attrs, { inert: '' }, 'kept for this page when the browser keeps nothing');
  const bare = panel({ parts: false });
  bare.active = bare.inside;
  assert.doesNotThrow(() => bare.panel.set(true));
});

check('Ctrl+B or Cmd+B on the workbench at a desk toggles the card, but not with other keys, on a phone, or while typing', () => {
  const press = (p, over = {}) => {
    const event = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'b', target: null, prevented: false, preventDefault() { this.prevented = true; }, ...over };
    p.panel.shortcut(event);
    return event.prevented;
  };
  const p = panel();
  assert.strictEqual(press(p), true);
  assert.strictEqual(p.panel.hidden(), true);
  assert.strictEqual(press(p, { ctrlKey: false, metaKey: true, key: 'B' }), true);
  assert.strictEqual(p.panel.hidden(), false);
  for (const over of [{ ctrlKey: false }, { altKey: true }, { shiftKey: true }, { key: 'k' }, { key: undefined },
    { target: { closest: selector => (selector === '.CodeMirror, textarea, [contenteditable="true"]' ? {} : null) } }]) {
    assert.strictEqual(press(p, over), false, JSON.stringify(over));
    assert.strictEqual(p.panel.hidden(), false);
  }
  assert.strictEqual(press(p, { target: { closest: () => null } }), true, 'a target outside anything typed into');
  assert.strictEqual(press(p, { target: { notAnElement: true } }), true);
  p.onWork = false;
  assert.strictEqual(press(p), false);
  p.onWork = true;
  p.mobile = true;
  assert.strictEqual(press(p), false);
});

(async () => {
  let failed = 0;
  let finished = false;
  process.on('exit', () => { if (!finished) { console.error('not ok - a check never settled'); process.exitCode = 1; } });
  for (const [name, run] of checks) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  finished = true;
  if (failed) process.exit(1);
  console.log(`page header: ${checks.length} checks passed`);
})();
