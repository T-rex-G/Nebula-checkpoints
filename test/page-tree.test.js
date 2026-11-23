'use strict';

/*
 * The file tree and an entry's menu, asked directly
 * (features/workbench/file-tree.ts, features/workbench/item-menu.ts): folders
 * read and drawn as text, opened in place and read once; files opened; the
 * editor's resting state; a reading for another repository, branch or a later
 * read dropped; an answer that is not a list said as a failure; the long press
 * and the right click; a menu heard by itself alone and let go of when its
 * dialog closes; every choice, carried out only on the repository the menu
 * was opened on.
 */

const assert = require('assert');
const { createFileTree, TREE_ICON, UNREADABLE } = require('../apps/web/src/features/workbench/file-tree.ts');
const { createItemMenu, UNREAD_ANSWER } = require('../apps/web/src/features/workbench/item-menu.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const flush = () => new Promise(resolve => setImmediate(resolve));

class Node {
  constructor(tag) {
    Object.assign(this, { tag, children: [], parent: null, html: null, _text: '', className: '', hidden: false, listeners: [], style: { animationDelay: '', display: '' } });
    this.classList = {
      add: c => { if (!this.has(c)) this.className = `${this.className} ${c}`.trim(); },
      remove: c => { this.className = this.className.split(' ').filter(x => x && x !== c).join(' '); },
      toggle: (c, on) => { if (on) this.classList.add(c); else this.classList.remove(c); }
    };
  }
  has(c) { return this.className.split(' ').includes(c); }
  set innerHTML(v) {
    this.html = String(v); this.children = []; this._text = '';
    for (const m of this.html.matchAll(/<span class="([^"]*)"/g)) { const stub = new Node('span'); stub.className = m[1]; stub.parent = this; this.children.push(stub); }
  }
  get innerHTML() { return this.html || ''; }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  appendChild(n) { if (n.fragment) { for (const c of n.children) { c.parent = this; this.children.push(c); } n.children = []; return n; } n.parent = this; this.children.push(n); return n; }
  after(n) { const list = this.parent.children; list.splice(list.indexOf(this) + 1, 0, n); n.parent = this.parent; }
  addEventListener(type, fn, opts) { this.listeners.push({ type, fn, opts }); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter(l => !(l.type === type && l.fn === fn)); }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelector(sel) { for (const n of this.walk()) if (n.has(sel.slice(1))) return n; return null; }
  fire(type, event = {}) {
    let stopped = false;
    const e = { target: this, stopImmediatePropagation: () => { stopped = true; }, preventDefault: () => { e.prevented = true; }, ...event };
    for (const l of [...this.listeners]) { if (l.type !== type) continue; if (stopped) break; l.fn(e); }
    return e;
  }
}

function treeSetup({ visiting = false, missing = [] } = {}) {
  const log = [];
  const pending = [];
  const host = new Node('div');
  const parts = {};
  for (const cls of ['editor-empty-pick', 'editor-empty-bare', 'editor-empty-visitor']) if (!missing.includes(cls)) { parts[`.${cls}`] = new Node('div'); }
  const page = { work: { owner: 'octo', repo: 'r p', branch: 'feat/x' } };
  const tree = createFileTree({
    doc: { createElement: tag => new Node(tag), createDocumentFragment: () => Object.assign(new Node('#f'), { fragment: true }) },
    $: sel => parts[sel] || null,
    rows: () => [...host.walk()].filter(n => n.has('tree-item')),
    api: path => new Promise((resolve, reject) => { log.push(['api', path]); pending.push({ path, resolve, reject }); }),
    work: () => page.work,
    visiting: () => visiting,
    size: bytes => `${bytes}B`,
    attachMenu: (row, entry) => { log.push(['menu', entry.name, row.listeners.length]); },
    openFile: path => log.push(['open', path]),
    closeDrawer: () => log.push(['drawer'])
  });
  const answer = async (value, at = 0) => { pending.splice(at, 1)[0].resolve(value); await flush(); };
  const refuse = async (error, at = 0) => { pending.splice(at, 1)[0].reject(error); await flush(); };
  const rows = () => host.children.filter(n => n.has('tree-item'));
  return { tree, host, parts, log, pending, page, answer, refuse, rows };
}

check('a folder is read for the repository and branch open, and drawn as rows whose names are text', async () => {
  const t = treeSetup();
  const done = t.tree.load('', t.host, true);
  assert.strictEqual(t.host.innerHTML, '<div class="skeleton" style="height:160px"></div>');
  assert.deepStrictEqual(t.log, [['api', '/api/repo/octo/r p/tree?ref=feat%2Fx&path=']]);
  const entries = Array.from({ length: 14 }, (_, i) => ({ name: `f${i}`, path: `f${i}`, type: 'file', size: i }));
  entries[0] = { name: '<b>dir</b>', path: 'd', type: 'dir' };
  entries[1] = { name: 'link', path: 'l', type: 'symlink', size: 9 };
  entries[2] = { path: 'nameless', type: 'file', size: 1 };
  await t.answer(entries);
  await done;
  const rows = t.rows();
  assert.strictEqual(rows.length, 14);
  assert.strictEqual(t.host.html, '', 'the skeleton goes before the rows are drawn');
  assert.deepStrictEqual([rows[0].className, rows[1].className, rows[3].className], ['tree-item dir', 'tree-item', 'tree-item']);
  assert.strictEqual(rows[0].html, `<span class="ti-icon">${TREE_ICON.dir}</span><span class="ti-name"></span>\n        `);
  assert.strictEqual(rows[3].html, `<span class="ti-icon">${TREE_ICON.file}</span><span class="ti-name"></span>\n        <span class="tree-size">3B</span>`);
  assert.ok(!rows[1].html.includes('tree-size'), 'only a file shows a size');
  assert.strictEqual(rows[0].querySelector('.ti-name').textContent, '<b>dir</b>', 'a name is text');
  assert.strictEqual(rows[2].querySelector('.ti-name').textContent, '', 'no name, nothing written');
  assert.deepStrictEqual(rows.map(r => r.style.animationDelay).slice(10), ['200ms', '220ms', '240ms', '240ms']);
  assert.deepStrictEqual(t.log.filter(e => e[0] === 'menu').map(e => e[2]), Array(14).fill(0), 'the menu is attached before the row\u2019s own press');
  assert.deepStrictEqual([t.parts['.editor-empty-pick'].hidden, t.parts['.editor-empty-bare'].hidden, t.parts['.editor-empty-visitor'].hidden], [false, true, true]);
  assert.ok(Object.isFrozen(TREE_ICON));
});

check('an empty repository says so, and tells a visitor what there is rather than what to add', async () => {
  for (const [visiting, bare, visitor] of [[false, false, true], [true, true, false]]) {
    const t = treeSetup({ visiting });
    const done = t.tree.load('', t.host, true);
    await t.answer([]);
    await done;
    assert.strictEqual(t.host.innerHTML, '<div class="tree-item">Empty repository</div>');
    assert.deepStrictEqual([t.parts['.editor-empty-pick'].hidden, t.parts['.editor-empty-bare'].hidden, t.parts['.editor-empty-visitor'].hidden], [true, bare, visitor]);
  }
  const partial = treeSetup({ missing: ['editor-empty-visitor'] });
  partial.tree.markEmpty(true);
  assert.deepStrictEqual([partial.parts['.editor-empty-pick'].hidden, partial.parts['.editor-empty-bare'].hidden], [true, false]);
  const none = treeSetup({ missing: ['editor-empty-bare'] });
  none.tree.markEmpty(true);
  assert.strictEqual(none.parts['.editor-empty-pick'].hidden, false, 'nothing changed without both states');
});

check('a folder opens in place beneath its row, is read once, and closes and opens again', async () => {
  const t = treeSetup();
  const done = t.tree.load('', t.host, true);
  await t.answer([{ name: 'my src', path: 'my src&x', type: 'dir' }, { name: 'a', path: 'a', type: 'file' }]);
  await done;
  const folder = t.rows()[0];
  folder.fire('click');
  assert.ok(folder.has('open'));
  const sub = t.host.children[1];
  assert.deepStrictEqual([sub.className, t.log.at(-1)], ['tree-indent', ['api', '/api/repo/octo/r p/tree?ref=feat%2Fx&path=my%20src%26x']]);
  await t.answer([{ name: 'inner.js', path: 'src/inner.js', type: 'file' }]);
  assert.strictEqual(sub.children[0].querySelector('.ti-name').textContent, 'inner.js');
  assert.strictEqual(sub.html, null, 'a folder beneath a row is added to, not replaced');
  folder.fire('click');
  assert.deepStrictEqual([folder.has('open'), sub.style.display], [false, 'none']);
  folder.fire('click');
  assert.deepStrictEqual([folder.has('open'), sub.style.display], [true, '']);
  assert.strictEqual(t.log.filter(e => e[0] === 'api').length, 2, 'read once');
});

check('a file pressed is the one marked, opened, and the drawer closed', async () => {
  const t = treeSetup();
  const done = t.tree.load('', t.host, true);
  await t.answer([{ name: 'a', path: 'x/a', type: 'file' }, { name: 'b', path: 'x/b', type: 'file' }]);
  await done;
  const [a, b] = t.rows();
  a.fire('click');
  b.fire('click');
  assert.deepStrictEqual([a.has('active'), b.has('active')], [false, true]);
  assert.deepStrictEqual(t.log.filter(e => e[0] === 'open' || e[0] === 'drawer'), [['open', 'x/a'], ['drawer'], ['open', 'x/b'], ['drawer']]);
});

check('a reading for another repository, another branch or a later read is dropped, and its failure unsaid', async () => {
  const t = treeSetup();
  void t.tree.load('', t.host, true);
  t.page.work = { owner: 'acme', repo: 'other', branch: 'main' };
  await t.answer([{ name: 'stale', path: 'stale', type: 'file' }]);
  assert.strictEqual(t.host.innerHTML, '<div class="skeleton" style="height:160px"></div>', 'another repository');
  assert.strictEqual(t.parts['.editor-empty-pick'].hidden, false, 'its resting state untouched');
  void t.tree.load('', t.host, true);
  t.page.work.branch = 'dev';
  await t.answer([]);
  assert.strictEqual(t.host.innerHTML, '<div class="skeleton" style="height:160px"></div>', 'another branch, changed in place');
  void t.tree.load('', t.host, true);
  void t.tree.load('', t.host, true);
  await t.answer([{ name: 'older', path: 'older', type: 'file' }], 0);
  assert.strictEqual(t.rows().length, 0, 'a root read overtaken by a later one');
  await t.answer([{ name: 'newer', path: 'newer', type: 'file' }, { name: 'dir', path: 'dir', type: 'dir' }], 0);
  assert.deepStrictEqual(t.rows().map(r => r.querySelector('.ti-name').textContent), ['newer', 'dir']);
  t.rows()[1].fire('click');
  const sub = t.host.children.find(n => n.has('tree-indent'));
  void t.tree.load('', t.host, true);
  await t.answer([{ name: 'late', path: 'dir/late', type: 'file' }], 0);
  assert.strictEqual(sub.children.length, 0, 'a folder read overtaken by the tree read again');
  t.page.work = { owner: 'z', repo: 'z', branch: 'main' };
  await t.refuse(new Error('gone'));
  assert.ok(!t.host.innerHTML.includes('gone'));
});

check('an answer that is not a list is a failure; a failure is said as text at the root and nowhere else', async () => {
  for (const value of [{ entries: [] }, null, 'files', 7]) {
    const t = treeSetup();
    const done = t.tree.load('', t.host, true);
    await t.answer(value);
    await done;
    assert.strictEqual(t.host.innerHTML, `<div class="tree-item">\u26a0 ${UNREADABLE.replace('\u2019', '\u2019')}</div>`, JSON.stringify(value));
    assert.strictEqual(t.parts['.editor-empty-pick'].hidden, false, 'not drawn as an empty repository');
  }
  const t = treeSetup();
  void t.tree.load('', t.host, true);
  await t.refuse(new Error('<i>no</i> & more'));
  assert.strictEqual(t.host.innerHTML, '<div class="tree-item">\u26a0 &lt;i&gt;no&lt;/i&gt; &amp; more</div>');
  const sub = new Node('div');
  void t.tree.load('src', sub, false);
  await t.refuse(new Error('quiet'));
  assert.deepStrictEqual([sub.html, sub.children.length], [null, 0]);
  await assert.doesNotReject(async () => { const n = treeSetup(); const d = n.tree.load('', n.host, true); await n.answer([null]); await d; });
});

function menuSetup({ isProtected = path => String(path).endsWith('.env'), noBody = false } = {}) {
  const log = [];
  const pending = [];
  const timers = [];
  const body = new Node('div');
  const docBody = new Node('body');
  let dialog = null;
  const page = { work: { owner: 'octo', repo: 'repo', branch: 'main' }, file: { path: 'a.txt' }, renameTo: '' };
  const menu = createItemMenu({
    doc: { createElement: () => { const a = new Node('a'); a.click = () => log.push(['anchor', a.href, a.download]); a.remove = () => log.push(['anchor-removed']); return a; }, body: docBody },
    body: () => (noBody ? null : body),
    renameTo: () => page.renameTo,
    modal: request => {
      log.push(['modal', request.title, request.okText, Boolean(request.danger)]);
      if (dialog) dialog.resolve(false);
      body.innerHTML = request.bodyHTML;
      return new Promise(resolve => { dialog = { resolve, request }; });
    },
    closeModal: confirmed => { log.push(['close', confirmed]); if (dialog) { dialog.resolve(confirmed); dialog = null; } },
    capabilities: node => log.push(['capabilities', node === body]),
    isProtected,
    work: () => page.work,
    api: (path, options) => new Promise((resolve, reject) => { log.push(['api', path, options]); pending.push({ resolve, reject }); }),
    guardedWrite: extra => ({ ...extra, guarded: true }),
    rememberHead: commit => log.push(['head', commit]),
    toast: (message, kind) => log.push(['toast', message, kind]),
    openFile: path => log.push(['openFile', path]),
    fileOpen: () => page.file,
    closeFile: () => log.push(['closeFile']),
    reloadTree: () => log.push(['reloadTree']),
    deleteFolder: path => log.push(['deleteFolder', path]),
    moveFolder: path => log.push(['moveFolder', path]),
    toggleProtect: path => log.push(['protect', path]),
    haptic: ms => log.push(['haptic', ms]),
    timers: { set: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clear: id => log.push(['clear', id]) }
  });
  const choose = async mi => { body.fire('click', { target: { closest: () => (mi ? { dataset: { mi } } : null) } }); await flush(); };
  const confirm = async ok => { const d = dialog; dialog = null; d.resolve(ok); await flush(); };
  const answer = async value => { pending.shift().resolve(value); await flush(); };
  const refuse = async error => { pending.shift().reject(error); await flush(); };
  return { menu, log, body, docBody, page, timers, choose, confirm, answer, refuse, dialog: () => dialog };
}
const file = { name: 'a.txt', path: 'dir/a.txt', type: 'file', sha: 's'.repeat(40) };
const folder = { name: 'dir', path: 'dir', type: 'dir' };

check('a right click and a long press open the menu; a long press is not also a press; a second touch starts over', () => {
  const m = menuSetup();
  const row = new Node('div');
  m.menu.attach(row, file);
  assert.deepStrictEqual(row.listeners.map(l => [l.type, l.opts]), [['click', undefined], ['contextmenu', undefined], ['touchstart', { passive: true }],
    ['touchend', { passive: true }], ['touchmove', { passive: true }], ['touchcancel', { passive: true }]]);
  const pressed = [];
  row.addEventListener('click', () => pressed.push('row'));
  const right = row.fire('contextmenu');
  assert.ok(right.prevented);
  assert.deepStrictEqual(m.log[0], ['modal', 'a.txt', 'Close', false]);
  row.fire('touchstart');
  assert.deepStrictEqual([m.timers.length, m.timers[0].ms], [1, 520]);
  row.fire('touchstart');
  assert.deepStrictEqual(m.log.filter(e => e[0] === 'clear'), [['clear', null], ['clear', 1]], 'the first touch\u2019s timer goes');
  row.fire('touchend');
  assert.deepStrictEqual(m.log.at(-1), ['clear', 2]);
  m.timers[1].run();
  assert.deepStrictEqual(m.log.slice(-3).map(e => e[0]), ['haptic', 'modal', 'capabilities']);
  assert.deepStrictEqual(m.log.at(-3), ['haptic', 14]);
  const first = row.fire('click');
  assert.ok(first.prevented);
  assert.deepStrictEqual(pressed, [], 'the press that ended a long press is swallowed');
  row.fire('click');
  assert.deepStrictEqual(pressed, ['row'], 'once');
  row.fire('touchmove');
  row.fire('touchcancel');
  assert.strictEqual(m.log.filter(e => e[0] === 'clear').length, 5);
});

check('a file\u2019s menu offers open, rename, download, protect and delete; a folder\u2019s, move and delete', () => {
  const m = menuSetup();
  m.menu.open({ ...file, path: 'x.env' });
  assert.ok(m.body.html.includes('data-mi="open" style="margin-top:0">Open in editor</button>'));
  assert.ok(m.body.html.includes('data-mi="rename" data-feature="file.rename">Rename / move</button>'));
  assert.ok(m.body.html.includes('data-mi="download">Download</button>'));
  assert.ok(m.body.html.includes('data-mi="protect">Unprotect file</button>'));
  assert.ok(m.body.html.includes('data-mi="delete" >Delete file\u2026</button>'));
  assert.ok(!m.body.html.includes('movedir'));
  m.menu.open(file);
  assert.ok(m.body.html.includes('data-mi="protect">Protect file</button>'));
  m.menu.open(folder);
  assert.deepStrictEqual(m.log.filter(e => e[0] === 'modal').at(-1), ['modal', 'dir/', 'Close', false]);
  assert.ok(m.body.html.includes('data-mi="movedir" data-feature="folder.move">Rename / move folder\u2026</button>'));
  assert.ok(m.body.html.includes('data-mi="delete" style="margin-top:0">Delete folder\u2026</button>'));
  assert.ok(!/data-mi="(open|rename|download|protect)"/.test(m.body.html));
  assert.strictEqual(m.log.filter(e => e[0] === 'capabilities' && e[1]).length, 3, 'what this account may do applied to every menu');
});

check('a choice is heard by its own menu alone, and the menu lets go when its dialog closes', async () => {
  const m = menuSetup();
  m.menu.open({ ...file, path: 'first.txt' });
  await m.choose(null);
  assert.strictEqual(m.body.listeners.length, 1, 'a click on nothing keeps the menu');
  await m.confirm(false);
  assert.strictEqual(m.body.listeners.length, 0);
  m.menu.open({ ...file, path: 'second.txt' });
  m.menu.open({ ...file, path: 'third.txt' });
  await flush();
  assert.strictEqual(m.body.listeners.length, 1, 'a menu replaced lets go');
  await m.choose('protect');
  assert.deepStrictEqual(m.log.filter(e => e[0] === 'protect'), [['protect', 'third.txt']]);
  assert.deepStrictEqual(m.log.filter(e => e[0] === 'close'), [['close', false]]);
  assert.strictEqual(m.body.listeners.length, 0);
  const bare = menuSetup({ noBody: true });
  assert.doesNotThrow(() => bare.menu.open(file));
});

check('open, download, move, delete a folder and protect act on the entry, once', async () => {
  const m = menuSetup();
  for (const [entry, mi] of [[file, 'open'], [file, 'download'], [folder, 'movedir'], [folder, 'delete'], [file, 'protect']]) {
    m.menu.open(entry);
    await m.choose(mi);
  }
  assert.deepStrictEqual(m.log.filter(e => !['modal', 'capabilities', 'close'].includes(e[0])), [
    ['openFile', 'dir/a.txt'], ['anchor', '/api/repo/octo/repo/raw?ref=main&path=dir%2Fa.txt', 'a.txt'], ['anchor-removed'],
    ['moveFolder', 'dir'], ['deleteFolder', 'dir'], ['protect', 'dir/a.txt']]);
  assert.strictEqual(m.docBody.children.length, 1, 'the anchor was put in the page to be pressed');
});

check('a rename asks for the new path with the old one whole, and is carried out, recorded and drawn', async () => {
  const m = menuSetup();
  const quoted = { ...file, path: 'x" data-injected="1" <y>.txt' };
  m.menu.open(quoted);
  await m.choose('rename');
  assert.deepStrictEqual(m.log.filter(e => e[0] === 'modal').at(-1), ['modal', 'Rename / move', 'Rename \u2726', false]);
  assert.ok(m.body.html.includes('value="x&quot; data-injected=&quot;1&quot; &lt;y&gt;.txt" autocapitalize="off" autocorrect="off" spellcheck="false">'), m.body.html);
  m.page.renameTo = '  //moved/a.txt ';
  await m.confirm(true);
  assert.deepStrictEqual(m.log.find(e => e[0] === 'api'), ['api', '/api/repo/octo/repo/rename', { method: 'POST', body: { from: quoted.path, to: 'moved/a.txt', branch: 'main', guarded: true } }]);
  await m.answer({ commit: 'c'.repeat(40) });
  assert.deepStrictEqual(m.log.slice(-3), [['head', 'c'.repeat(40)], ['toast', 'Renamed to moved/a.txt \u2726', 'ok'], ['reloadTree']]);
  for (const [typed, ok] of [['dir/a.txt', true], ['  ', true], ['new.txt', false]]) {
    const n = menuSetup();
    n.menu.open(file);
    await n.choose('rename');
    n.page.renameTo = typed;
    await n.confirm(ok);
    assert.ok(!n.log.some(e => e[0] === 'api'), `${typed} ${ok}`);
  }
  const failing = menuSetup();
  failing.menu.open(file);
  await failing.choose('rename');
  failing.page.renameTo = 'b.txt';
  await failing.confirm(true);
  await failing.refuse(new Error('A file already has that name'));
  assert.deepStrictEqual(failing.log.at(-1), ['toast', 'A file already has that name', 'err']);
  const odd = menuSetup();
  odd.menu.open(file);
  await odd.choose('rename');
  odd.page.renameTo = 'b.txt';
  await odd.confirm(true);
  await odd.answer(null);
  assert.deepStrictEqual(odd.log.at(-1), ['toast', UNREAD_ANSWER, 'err']);
  assert.ok(!odd.log.some(e => e[0] === 'head' || e[0] === 'reloadTree'));
});

check('a file deleted is the one named, its editor closed only if it is open there, and the tree read again', async () => {
  for (const [open, closes] of [['dir/a.txt', true], ['dir/b.txt', false], [null, false]]) {
    const m = menuSetup();
    m.page.file = open ? { path: open } : null;
    m.menu.open({ ...file, path: 'dir/a.txt' });
    await m.choose('delete');
    assert.deepStrictEqual(m.log.filter(e => e[0] === 'modal').at(-1), ['modal', 'Delete file', 'Delete', true]);
    assert.strictEqual(m.body.html, '<p style="font-size:.9rem;line-height:1.5">Delete <b class="mono">dir/a.txt</b> from <b>main</b>?</p>');
    await m.confirm(true);
    assert.deepStrictEqual(m.log.find(e => e[0] === 'api'), ['api', '/api/repo/octo/repo/file', { method: 'DELETE', body: { path: 'dir/a.txt', branch: 'main', sha: 's'.repeat(40), guarded: true } }]);
    await m.answer({ commit: 'd'.repeat(40) });
    assert.deepStrictEqual(m.log.filter(e => ['head', 'toast', 'closeFile', 'reloadTree'].includes(e[0])),
      [['head', 'd'.repeat(40)], ['toast', 'File deleted', 'ok'], ...(closes ? [['closeFile']] : []), ['reloadTree']]);
  }
  const escaped = menuSetup();
  escaped.page.work.branch = '<main>';
  escaped.menu.open({ ...file, path: '<a>&.txt' });
  await escaped.choose('delete');
  assert.ok(escaped.body.html.includes('<b class="mono">&lt;a&gt;&amp;.txt</b> from <b>&lt;main&gt;</b>'));
  await escaped.confirm(false);
  assert.ok(!escaped.log.some(e => e[0] === 'api'));
  const refused = menuSetup();
  refused.menu.open(file);
  await refused.choose('delete');
  await refused.confirm(true);
  await refused.refuse(new Error('Protected'));
  assert.deepStrictEqual(refused.log.at(-1), ['toast', 'Protected', 'err']);
  const odd = menuSetup();
  odd.menu.open(file);
  await odd.choose('delete');
  await odd.confirm(true);
  await odd.answer('ok');
  assert.deepStrictEqual(odd.log.at(-1), ['toast', UNREAD_ANSWER, 'err']);
});

check('nothing a menu does reaches a repository or branch opened after it, and nothing is said there', async () => {
  const moves = [
    page => { page.work = { owner: 'acme', repo: 'other', branch: 'main' }; },
    page => { page.work.branch = 'dev'; }
  ];
  for (const move of moves) {
    const chosen = menuSetup();
    chosen.menu.open(file);
    move(chosen.page);
    await chosen.choose('open');
    await chosen.choose('protect');
    assert.ok(!chosen.log.some(e => e[0] === 'openFile' || e[0] === 'protect'), 'a choice made after');
    assert.deepStrictEqual(chosen.log.filter(e => e[0] === 'close'), [['close', false]], 'the menu still closes, once');
    const renamed = menuSetup();
    renamed.menu.open(file);
    await renamed.choose('rename');
    renamed.page.renameTo = 'z.txt';
    move(renamed.page);
    await renamed.confirm(true);
    assert.ok(!renamed.log.some(e => e[0] === 'api'), 'a rename confirmed after');
    const deleted = menuSetup();
    deleted.menu.open(file);
    await deleted.choose('delete');
    move(deleted.page);
    await deleted.confirm(true);
    assert.ok(!deleted.log.some(e => e[0] === 'api'), 'a deletion confirmed after');
    for (const [act, settle] of [['rename', m => m.answer({ commit: 'e'.repeat(40) })], ['rename', m => m.refuse(new Error('x'))], ['delete', m => m.answer({ commit: 'e'.repeat(40) })], ['delete', m => m.refuse(new Error('x'))]]) {
      const late = menuSetup();
      late.menu.open(file);
      await late.choose(act);
      late.page.renameTo = 'z.txt';
      await late.confirm(true);
      move(late.page);
      await settle(late);
      assert.ok(!late.log.some(e => ['head', 'toast', 'reloadTree', 'closeFile'].includes(e[0])), `an answer after: ${act}`);
    }
  }
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
  console.log(`page tree: ${checks.length} checks passed`);
})();
