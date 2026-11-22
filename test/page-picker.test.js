'use strict';

/*
 * The repository picker, asked directly: what it lists for what is typed and
 * what is known (features/repositories/repository-picker.ts), and the dialog
 * at work -- the listing read a page at a time, the keyboard and pointer
 * moving through it, and the chosen repository opened into the tool
 * (repository-picker-controller.ts).
 */

const assert = require('assert');
const { PICK_TOOLS, PICK_GLOBE, PICK_LOCK, PICK_PAGE, pickTool, pickBody, pickView, pickMeta, pickVisibility } = require('../apps/web/src/features/repositories/repository-picker.ts');
const { createRepositoryPicker } = require('../apps/web/src/features/repositories/repository-picker-controller.ts');
const { repositoryReference } = require('../apps/web/src/features/repositories/repository-reference.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const flush = () => new Promise(resolve => setImmediate(resolve));

/* ---- What the picker lists -------------------------------------------------------------------- */

const repo = (owner, name, more = {}) => ({ owner, name, full_name: `${owner}/${name}`, description: null, private: false, pushed_at: null, ...more });
const view = (over = {}) => pickView({ query: '', repos: [], recent: [], own: false, reference: null, loading: false, failed: '', more: false, host: 'github.com', ...over });
const names = list => list.groups.map(group => [group.label, group.repos.map(item => `${item.owner}/${item.name}${item.any ? ' (any)' : ''}`)]);

check('the picker serves its own five tools and nothing a name inherits', () => {
  assert.deepStrictEqual(Object.keys(PICK_TOOLS), ['neural', 'governance', 'exposure', 'audit', 'safeguards']);
  assert.ok(Object.isFrozen(PICK_TOOLS) && Object.values(PICK_TOOLS).every(Object.isFrozen));
  assert.strictEqual(pickTool('audit').title, 'Audit');
  for (const target of ['editor', 'constructor', 'toString', '__proto__', '', 'Neural']) assert.strictEqual(pickTool(target), null, target);
  assert.strictEqual(PICK_PAGE, 30);
});

check('the dialog asks for the tool with the rail\'s own mark, and an own picker searches only your repositories', () => {
  const body = pickBody('neural', PICK_TOOLS.neural, '<svg class="nv-rail-i"></svg>', false);
  assert.ok(body.includes('data-tool="neural"'));
  assert.ok(body.includes('<span class="rp-pick-mark"><svg class="nv-rail-i"></svg></span>'));
  assert.ok(body.includes('<span class="rp-pick-tool-name">Neural</span>'));
  assert.ok(body.includes(PICK_TOOLS.neural.lede));
  assert.ok(body.includes('placeholder="Search, or paste any public repository"'));
  assert.ok(body.includes('aria-label="Search repositories, or paste any public repository address"'));
  assert.ok(body.includes('id="rpPickQuery" type="search" role="combobox" aria-expanded="true" aria-controls="rpPickList"'));
  assert.ok(body.includes('id="rpPickList" role="listbox" aria-label="Repositories"') && body.includes('id="rpPickFoot"'));
  const own = pickBody('safeguards', PICK_TOOLS.safeguards, '', true);
  assert.ok(own.includes('placeholder="Search your repositories"') && own.includes('aria-label="Search your repositories"'));
  assert.ok(own.includes('<span class="rp-pick-mark"></span>'));
  const odd = pickBody('a"<b>', { title: '<i>T</i>', lede: 'a & b' }, '', false);
  assert.ok(odd.includes('data-tool="a&quot;&lt;b&gt;"') && odd.includes('&lt;i&gt;T&lt;/i&gt;') && odd.includes('a &amp; b'));
});

check('recent repositories come first, as the list knows them, then the rest; an own picker leaves visitors out', () => {
  const repos = [repo('a', 'one', { description: 'first', private: true, pushed_at: 'T1' }), repo('b', 'two'), repo('c', 'three')];
  const recent = [{ owner: 'c', name: 'three' }, { owner: 'z', name: 'gone' }, { owner: 'v', name: 'visit', visitor: true }];
  const list = view({ repos, recent });
  assert.deepStrictEqual(names(list), [['Recent', ['c/three', 'z/gone', 'v/visit']], ['All repositories', ['a/one', 'b/two']]]);
  assert.deepStrictEqual(list.groups[1].repos[0], { owner: 'a', name: 'one', description: 'first', private: true, pushed_at: 'T1' });
  assert.strictEqual(list.groups[0].repos[0].description, null, 'a recent repository the list holds is drawn as the list knows it');
  assert.deepStrictEqual(list.groups[0].repos[1], { owner: 'z', name: 'gone' });
  assert.deepStrictEqual(names(view({ repos, recent, own: true })), [['Recent', ['c/three', 'z/gone']], ['All repositories', ['a/one', 'b/two']]]);
  assert.deepStrictEqual(names(view({ repos: [], recent: [] })), []);
  assert.deepStrictEqual(names(view({ repos: 'not a list', recent: [] })), []);
});

check('typing filters by every word, in the name or the description, whatever the case', () => {
  const repos = [repo('acme', 'Payments', { description: 'Card RAILS' }), repo('acme', 'web'), repo('other', 'rails-app')];
  const recent = [{ owner: 'acme', name: 'web' }];
  assert.deepStrictEqual(names(view({ repos, recent, query: '  RAILS ' })), [['Matches', ['acme/Payments', 'other/rails-app']]]);
  assert.deepStrictEqual(names(view({ repos, recent, query: 'acme card' })), [['Matches', ['acme/Payments']]]);
  assert.deepStrictEqual(names(view({ repos, recent, query: 'acme' })), [['Matches', ['acme/web']], ['More matches', ['acme/Payments']]]);
  assert.deepStrictEqual(names(view({ repos, recent, query: 'acme/web' })), [['Matches', ['acme/web']]]);
});

check('a pasted address is the only thing listed; a typed owner/name is also a search, with that repository offered after', () => {
  const repos = [repo('Octo', 'Repo', { description: 'held' }), repo('octo', 'repository')];
  const address = names(view({ repos, query: 'https://github.com/octo/repo/blob/main/x', reference: repositoryReference('https://github.com/octo/repo/blob/main/x') }));
  assert.deepStrictEqual(address, [['Any repository', ['Octo/Repo']]], 'listed in any case, as the list spells it');
  const unknown = view({ repos, query: 'github.com/someone/else', reference: repositoryReference('github.com/someone/else') });
  assert.deepStrictEqual(names(unknown), [['Any repository', ['someone/else (any)']]]);
  assert.deepStrictEqual(unknown.groups[0].repos[0], { owner: 'someone', name: 'else', any: true });
  assert.deepStrictEqual(names(view({ repos, query: 'octo/repo', reference: repositoryReference('octo/repo') })), [['Matches', ['Octo/Repo', 'octo/repository']]]);
  assert.deepStrictEqual(names(view({ repos, query: 'octo/rep', reference: repositoryReference('octo/rep') })), [['Matches', ['Octo/Repo', 'octo/repository']], ['Any repository', ['octo/rep (any)']]]);
  assert.deepStrictEqual(names(view({ repos, query: 'someone/else', own: true, reference: repositoryReference('someone/else') })), [], 'an own picker offers nothing pasted');
});

check('the list says why it lists nothing: a failure first, another host, no match, or no repositories yet', () => {
  const wrong = view({ query: 'https://gitlab.com/a/b', reference: repositoryReference('https://gitlab.com/a/b') });
  assert.strictEqual(wrong.empty, 'That address is on gitlab.com; this session reads repositories on github.com.');
  assert.deepStrictEqual(wrong.groups, []);
  assert.strictEqual(view({ query: 'https://gitlab.com/a/b', reference: repositoryReference('https://gitlab.com/a/b'), failed: 'Repositories could not be listed.' }).empty, 'Repositories could not be listed.');
  assert.strictEqual(view({ repos: [repo('a', 'b')], query: ' zzz ' }).empty, 'No repository matches \u201czzz\u201d.');
  assert.strictEqual(view({ repos: [repo('a', 'b')], query: 'zzz', more: true }).empty, 'No repository matches \u201czzz\u201d in those loaded.');
  assert.strictEqual(view().empty, 'No repositories yet.');
  assert.strictEqual(view({ repos: [repo('a', 'b')] }).empty, null);
  assert.strictEqual(view({ recent: [{ owner: 'a', name: 'b' }] }).empty, null);
});

check('rows stand in while the first page is read, and the foot counts what is loaded and offers more when there is', () => {
  const first = view({ loading: true, recent: [{ owner: 'a', name: 'b' }] });
  assert.strictEqual(first.ghosts, 4);
  assert.strictEqual(first.empty, null);
  assert.deepStrictEqual(names(first), [['Recent', ['a/b']]]);
  assert.strictEqual(view({ loading: true }).empty, null);
  assert.strictEqual(view({ loading: true, repos: [repo('a', 'b')] }).ghosts, 0);
  assert.strictEqual(view().count, '');
  assert.strictEqual(view({ repos: [repo('a', 'b')] }).count, '1 repository loaded');
  assert.strictEqual(view({ repos: [repo('a', 'b'), repo('a', 'c')] }).count, '2 repositories loaded');
  assert.strictEqual(view({ more: true }).more, true);
  assert.strictEqual(view({ more: true, loading: true }).more, false);
  assert.strictEqual(view({ more: false }).more, false);
});

check('the line under a name says where any repository lives, or what the list knows', () => {
  const ago = iso => `ago(${iso})`;
  assert.strictEqual(pickMeta({ owner: 'a', name: 'b', any: true, description: 'x' }, 'github.com', ago), 'github.com \u00b7 read-only unless you can push to it');
  assert.strictEqual(pickMeta({ owner: 'a', name: 'b', description: 'Card rails', pushed_at: 'T' }, 'h', ago), 'Card rails \u00b7 updated ago(T)');
  assert.strictEqual(pickMeta({ owner: 'a', name: 'b', pushed_at: 'T' }, 'h', ago), 'updated ago(T)');
  assert.strictEqual(pickMeta({ owner: 'a', name: 'b', description: 'only' }, 'h', ago), 'only');
  assert.strictEqual(pickMeta({ owner: 'a', name: 'b' }, 'h', ago), 'Recently opened');
});

check('who can see a repository is said only when the list states it', () => {
  assert.deepStrictEqual(pickVisibility({ private: true }), { state: 'private', mark: PICK_LOCK, word: 'Private' });
  assert.deepStrictEqual(pickVisibility({ private: false }), { state: 'public', mark: PICK_GLOBE, word: 'Public' });
  for (const unknown of [undefined, null, 'yes', 0, 1]) assert.deepStrictEqual(pickVisibility({ private: unknown }), { state: 'unknown', mark: '', word: '' }, String(unknown));
});

/* ---- The dialog at work ----------------------------------------------------------------------- */

function element(tag) {
  const el = {
    tag, className: '', id: '', textContent: null, innerHTML: '', title: '', dataset: {}, attrs: {}, children: [], listeners: {}, classes: [], scrolled: 0, value: '',
    classList: { add: name => el.classes.push(name) },
    setAttribute(name, value) { el.attrs[name] = value; },
    removeAttribute(name) { delete el.attrs[name]; },
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    replaceChildren(...nodes) { el.children = nodes; },
    addEventListener(type, listener) { (el.listeners[type] = el.listeners[type] || []).push(listener); },
    fire(type, event) { for (const listener of el.listeners[type] || []) listener(event); },
    scrollIntoView(options) { el.scrolled += 1; el.scrollOptions = options; }
  };
  return el;
}
const doc = { createElement: element, createTextNode: text => ({ text }) };
const key = name => { const event = { key: name, prevented: false, preventDefault() { event.prevented = true; } }; return event; };

function harness({ repos = [], repoPage = 1, recent = [], coarse = false, opens = true } = {}) {
  const state = { repos, repoPage, repoSort: 'updated' };
  const log = [];
  const pending = [];
  const ok = { disabled: true };
  const h = { state, log, pending, ok, dialog: null, owned: true };
  h.deps = {
    state,
    api: path => new Promise((resolve, reject) => { log.push(['api', path]); pending.push({ path, resolve, reject }); }),
    modal: request => new Promise(resolve => {
      const input = element('input');
      const list = element('div');
      const foot = element('div');
      h.dialog = { request, resolve, input, list, foot };
      log.push(['modal', request.title, request.okText, request.autofocus]);
      request.onOpen({ querySelector: selector => ({ '#rpPickQuery': input, '#rpPickList': list, '#rpPickFoot': foot })[selector] });
    }),
    owner: () => () => h.owned,
    closeModal: confirmed => { log.push(['close', confirmed]); h.dialog.resolve(confirmed); },
    okButton: () => ok,
    railMark: target => `<svg data-rail="${target}"></svg>`,
    coarse: () => coarse,
    doc,
    sigil: fullName => (fullName.startsWith('bare/') ? null : { sigil: fullName }),
    timeAgo: iso => `ago(${iso})`,
    host: () => 'github.com',
    recent: () => recent,
    reference: text => repositoryReference(text),
    append: fresh => { log.push(['append', fresh.map(item => item.full_name)]); state.repos = [...state.repos, ...fresh]; },
    open: async (owner, name) => { log.push(['open', owner, name]); return opens; },
    switchTab: tool => log.push(['tab', tool])
  };
  h.picker = createRepositoryPicker(h.deps);
  return h;
}
const rows = h => h.dialog.list.children.filter(child => child.attrs && child.attrs.role === 'option');
const listed = h => h.dialog.list.children.map(child => {
  if (child.className === 'rp-pick-group') return `# ${child.textContent}`;
  if (child.className === 'rp-pick-ghost') return '~';
  if (child.className === 'rp-pick-empty') return `! ${child.textContent}`;
  const [, text] = child.children;
  const [name] = text.children;
  return `${name.children[0].textContent}${name.children[1].text}`;
});
const lit = h => rows(h).map(row => row.attrs['aria-selected']);
const footText = h => h.dialog.foot.children.map(child => child.textContent);
const press = (h, name) => { const event = key(name); h.dialog.input.fire('keydown', event); return event; };
const type = (h, text) => { h.dialog.input.value = text; h.dialog.input.fire('input'); };

check('a tool the picker does not serve asks nothing', async () => {
  const h = harness();
  await h.picker.pick('editor');
  await h.picker.pick('constructor');
  assert.deepStrictEqual(h.log, []);
});

check('the dialog names the tool, and on a touch device the search field is not focused', async () => {
  const h = harness({ repos: [repo('a', 'one')], coarse: true });
  void h.picker.pick('governance');
  assert.deepStrictEqual(h.log[0], ['modal', 'Choose a repository', 'Open Governance', false]);
  assert.ok(h.dialog.request.bodyHTML.includes('<svg data-rail="governance"></svg>'));
  assert.ok(h.dialog.request.bodyHTML.includes('placeholder="Search, or paste any public repository"'));
  const fine = harness({ repos: [repo('a', 'one')] });
  void fine.picker.pick('safeguards', { own: true });
  assert.deepStrictEqual(fine.log[0], ['modal', 'Choose a repository', 'Open Safeguards', true]);
  assert.ok(fine.dialog.request.bodyHTML.includes('placeholder="Search your repositories"'));
});

check('a page that holds repositories is drawn at once, the first lit and the button offered', async () => {
  const repos = Array.from({ length: 30 }, (_, at) => repo('o', `r${at}`));
  const h = harness({ repos, recent: [{ owner: 'o', name: 'r3' }] });
  void h.picker.pick('neural');
  assert.ok(!h.log.some(entry => entry[0] === 'api'), 'nothing is read');
  const shown = listed(h);
  assert.deepStrictEqual(shown.slice(0, 4), ['# Recent', 'o/r3', '# All repositories', 'o/r0']);
  assert.strictEqual(shown.length, 32);
  assert.deepStrictEqual(lit(h).slice(0, 3), ['true', 'false', 'false']);
  assert.strictEqual(h.dialog.input.attrs['aria-activedescendant'], 'rpPick-0');
  assert.strictEqual(rows(h)[0].id, 'rpPick-0');
  assert.strictEqual(rows(h)[29].id, 'rpPick-29');
  assert.strictEqual(h.ok.disabled, false);
  assert.deepStrictEqual(footText(h), ['30 repositories loaded', 'Load more'], 'a full page may have more after it');
  const short = harness({ repos: [repo('o', 'only')], repoPage: 1 });
  void short.picker.pick('neural');
  assert.deepStrictEqual(footText(short), ['1 repository loaded']);
  const paged = harness({ repos: Array.from({ length: 45 }, (_, at) => repo('o', `r${at}`)), repoPage: 2 });
  void paged.picker.pick('neural');
  assert.deepStrictEqual(footText(paged), ['45 repositories loaded'], 'a second page shorter than a page is the last');
});

check('a row is drawn as its owner apart, what is known of it, and who can see it', async () => {
  const h = harness({ repos: [repo('o', 'secret', { private: true, description: 'Vault', pushed_at: 'T' }), repo('bare', 'open', { private: false })], recent: [{ owner: 'r', name: 'recent' }] });
  void h.picker.pick('exposure');
  const [recent, secret, open] = rows(h);
  const [sigil, text, vis] = secret.children;
  assert.strictEqual(secret.className, 'rp-pick-item');
  assert.deepStrictEqual(sigil.children, [{ sigil: 'o/secret' }]);
  assert.strictEqual(sigil.className, 'rp-pick-sigil');
  assert.strictEqual(text.className, 'rp-pick-text');
  assert.strictEqual(text.children[0].className, 'rp-pick-name');
  assert.strictEqual(text.children[0].children[0].className, 'rp-pick-owner');
  assert.strictEqual(text.children[1].className, 'rp-pick-meta');
  assert.strictEqual(text.children[1].textContent, 'Vault \u00b7 updated ago(T)');
  assert.strictEqual(vis.className, 'rp-pick-vis');
  assert.strictEqual(vis.dataset.visibility, 'private');
  assert.strictEqual(vis.innerHTML, PICK_LOCK);
  assert.strictEqual(vis.title, 'Private');
  assert.deepStrictEqual(vis.children.map(child => [child.className, child.textContent]), [['sr-only', 'Private']]);
  assert.deepStrictEqual(open.children[0].children, [], 'no sigil drawn is no sigil appended');
  assert.strictEqual(open.children[2].innerHTML, PICK_GLOBE);
  assert.strictEqual(recent.children[2].dataset.visibility, 'unknown');
  assert.strictEqual(recent.children[2].innerHTML, '');
  assert.deepStrictEqual(recent.children[2].children, []);
  assert.strictEqual(recent.children[1].children[1].textContent, 'Recently opened');
  assert.deepStrictEqual(recent.classes, []);
  type(h, 'github.com/far/away');
  const [any] = rows(h);
  assert.deepStrictEqual(any.classes, ['rp-pick-any']);
  assert.strictEqual(any.children[1].children[1].textContent, 'github.com \u00b7 read-only unless you can push to it');
  assert.deepStrictEqual(listed(h), ['# Any repository', 'far/away']);
  const groups = h.dialog.list.children.filter(child => child.className === 'rp-pick-group');
  assert.ok(groups.every(group => group.attrs.role === 'presentation'));
});

check('an empty page reads the listing from its first page, rows standing in, and adds only repositories not yet held', async () => {
  const h = harness({ recent: [{ owner: 'r', name: 'recent' }] });
  h.state.repoSort = 'pushed';
  void h.picker.pick('audit');
  assert.deepStrictEqual(h.log.filter(entry => entry[0] === 'api'), [['api', '/api/repos?page=1&sort=pushed']]);
  assert.deepStrictEqual(listed(h), ['# Recent', 'r/recent', '~', '~', '~', '~']);
  assert.deepStrictEqual(footText(h), [''], 'nothing counted, nothing more offered while reading');
  const page = Array.from({ length: 30 }, (_, at) => repo('o', `r${at}`));
  h.state.repos = [repo('o', 'r0')];
  h.pending.shift().resolve(page);
  await flush();
  assert.deepStrictEqual(h.log.find(entry => entry[0] === 'append'), ['append', page.slice(1).map(item => item.full_name)]);
  assert.deepStrictEqual(footText(h), ['30 repositories loaded', 'Load more']);
  assert.ok(!listed(h).includes('~'));
  h.dialog.foot.children[1].fire('click');
  assert.deepStrictEqual(h.log.filter(entry => entry[0] === 'api').pop(), ['api', '/api/repos?page=2&sort=pushed']);
  assert.deepStrictEqual(footText(h), ['30 repositories loaded'], 'no second press while a page is read');
  assert.ok(!listed(h).includes('~'), 'rows stand in only for the first page');
  h.pending.shift().resolve([repo('o', 'last')]);
  await flush();
  assert.deepStrictEqual(footText(h), ['31 repositories loaded'], 'a short page is the last');
});

check('a listing that fails says so, a page that is not a list of repositories is refused whole and asked for again', async () => {
  const h = harness();
  void h.picker.pick('neural');
  h.pending.shift().reject(new Error('rate limited'));
  await flush();
  assert.deepStrictEqual(listed(h), ['! Repositories could not be listed: rate limited']);
  assert.strictEqual(h.ok.disabled, true, 'nothing to open');
  const bare = harness();
  void bare.picker.pick('neural');
  bare.pending.shift().reject('no message');
  await flush();
  assert.deepStrictEqual(listed(bare), ['! Repositories could not be listed.']);
  for (const answer of [{ items: [] }, null, [repo('a', 'b'), null], ['a/b']]) {
    const odd = harness({ repos: Array.from({ length: 30 }, (_, at) => repo('o', `r${at}`)) });
    void odd.picker.pick('neural');
    odd.dialog.foot.children[1].fire('click');
    odd.pending.shift().resolve(answer);
    await flush();
    assert.ok(!odd.log.some(entry => entry[0] === 'append'), JSON.stringify(answer));
    assert.deepStrictEqual(listed(odd).slice(0, 2), ['# All repositories', 'o/r0'], 'the rows already held stay');
    odd.dialog.foot.children[1].fire('click');
    assert.deepStrictEqual(odd.log.filter(entry => entry[0] === 'api').map(entry => entry[1]), ['/api/repos?page=2&sort=updated', '/api/repos?page=2&sort=updated'], 'the refused page is asked for again');
    odd.pending.shift().resolve([repo('o', 'r30')]);
    await flush();
    assert.deepStrictEqual(odd.log.find(entry => entry[0] === 'append'), ['append', ['o/r30']]);
  }
  const typed = harness();
  void typed.picker.pick('neural');
  typed.pending.shift().resolve({ not: 'a list' });
  await flush();
  assert.deepStrictEqual(listed(typed), ['! Repositories could not be listed: the answer was not a list of repositories']);
  const retry = harness({ repos: Array.from({ length: 30 }, (_, at) => repo('o', `r${at}`)) });
  void retry.picker.pick('neural');
  retry.dialog.foot.children[1].fire('click');
  retry.pending.shift().reject(new Error('down'));
  await flush();
  type(retry, 'zzz');
  assert.deepStrictEqual(listed(retry), ['! Repositories could not be listed: down'], 'a failure is said where nothing is listed, until the list is read again');
  type(retry, '');
  retry.dialog.foot.children[1].fire('click');
  retry.pending.shift().resolve([repo('o', 'r30')]);
  await flush();
  type(retry, 'zzz');
  assert.deepStrictEqual(listed(retry), ['! No repository matches \u201czzz\u201d.']);
  const failedAfter = harness();
  void failedAfter.picker.pick('neural');
  failedAfter.pending.shift().reject(new Error('down'));
  await flush();
  type(failedAfter, 'something');
  assert.deepStrictEqual(listed(failedAfter), ['! Repositories could not be listed: down'], 'the failure is said until something is listed');
});

check('a dialog left or replaced while the listing was read takes nothing from it and draws nothing', async () => {
  const h = harness();
  void h.picker.pick('neural');
  const before = h.dialog.list.children;
  h.owned = false;
  h.pending.shift().resolve([repo('a', 'b')]);
  await flush();
  assert.ok(!h.log.some(entry => entry[0] === 'append'));
  assert.strictEqual(h.dialog.list.children, before);
  type(h, 'b');
  assert.strictEqual(h.dialog.list.children, before, 'typing into a dialog no longer this one draws nothing');
  const failing = harness();
  void failing.picker.pick('neural');
  const held = failing.dialog.list.children;
  failing.owned = false;
  failing.pending.shift().reject(new Error('late'));
  await flush();
  assert.strictEqual(failing.dialog.list.children, held);
});

check('the keyboard moves through the rows within their bounds, and Enter opens the one lit', async () => {
  const h = harness({ repos: [repo('o', 'a'), repo('o', 'b'), repo('o', 'c')] });
  const done = h.picker.pick('neural');
  assert.strictEqual(press(h, 'ArrowUp').prevented, true);
  assert.deepStrictEqual(lit(h), ['true', 'false', 'false']);
  press(h, 'ArrowDown');
  assert.deepStrictEqual(lit(h), ['false', 'true', 'false']);
  assert.strictEqual(h.dialog.input.attrs['aria-activedescendant'], 'rpPick-1');
  assert.ok(rows(h)[1].scrolled >= 1);
  assert.deepStrictEqual(rows(h)[1].scrollOptions, { block: 'nearest' });
  press(h, 'ArrowDown');
  press(h, 'ArrowDown');
  assert.deepStrictEqual(lit(h), ['false', 'false', 'true']);
  press(h, 'Home');
  assert.deepStrictEqual(lit(h), ['true', 'false', 'false']);
  press(h, 'End');
  assert.deepStrictEqual(lit(h), ['false', 'false', 'true']);
  press(h, 'ArrowUp');
  assert.deepStrictEqual(lit(h), ['false', 'true', 'false']);
  assert.strictEqual(press(h, 'a').prevented, false, 'other keys are the field\'s');
  assert.strictEqual(press(h, 'Enter').prevented, true);
  await done;
  assert.deepStrictEqual(h.log.slice(1), [['close', true], ['open', 'o', 'b'], ['tab', 'neural']]);
  assert.strictEqual(h.ok.disabled, false, 'the dialog\'s button is offered again once it has closed');
});

check('with nothing listed the keyboard lights nothing and Enter opens nothing', async () => {
  const h = harness({ repos: [repo('o', 'a')] });
  const done = h.picker.pick('neural');
  type(h, 'nothing here');
  assert.deepStrictEqual(listed(h), ['! No repository matches \u201cnothing here\u201d.']);
  assert.strictEqual(h.ok.disabled, true);
  assert.strictEqual(h.dialog.input.attrs['aria-activedescendant'], undefined);
  assert.strictEqual(press(h, 'Home').prevented, false);
  assert.strictEqual(press(h, 'End').prevented, false);
  press(h, 'ArrowDown');
  press(h, 'Enter');
  assert.ok(!h.log.some(entry => entry[0] === 'close'));
  h.dialog.resolve(true);
  await done;
  assert.ok(!h.log.some(entry => entry[0] === 'open'), 'confirming with nothing lit opens nothing');
  assert.strictEqual(h.ok.disabled, false, 'the dialog\'s button is offered again for the next dialog');
});

check('the pointer lights the row it moves over and a press opens it; the dialog\'s own button opens the row lit', async () => {
  const h = harness({ repos: [repo('o', 'a'), repo('o', 'b')] });
  const done = h.picker.pick('audit');
  rows(h)[1].fire('mousemove');
  assert.deepStrictEqual(lit(h), ['false', 'true']);
  const scrolled = rows(h)[1].scrolled;
  rows(h)[1].fire('mousemove');
  assert.strictEqual(rows(h)[1].scrolled, scrolled, 'moving over the row already lit lights nothing again');
  rows(h)[0].fire('click');
  await done;
  assert.deepStrictEqual(h.log.slice(1), [['close', true], ['open', 'o', 'a'], ['tab', 'audit']]);
  const confirm = harness({ repos: [repo('o', 'a'), repo('o', 'b')] });
  const confirmed = confirm.picker.pick('audit');
  press(confirm, 'ArrowDown');
  confirm.dialog.resolve(true);
  await confirmed;
  assert.deepStrictEqual(confirm.log.slice(1), [['open', 'o', 'b'], ['tab', 'audit']]);
  const cancel = harness({ repos: [repo('o', 'a')] });
  const canceled = cancel.picker.pick('audit');
  cancel.dialog.resolve(false);
  await canceled;
  assert.deepStrictEqual(cancel.log.slice(1), []);
  assert.strictEqual(cancel.ok.disabled, false);
});

check('a repository that does not open leaves the tool unswitched', async () => {
  const h = harness({ repos: [repo('o', 'a')], opens: null });
  const done = h.picker.pick('governance');
  press(h, 'Enter');
  await done;
  assert.deepStrictEqual(h.log.slice(1), [['close', true], ['open', 'o', 'a']]);
});

check('typing redraws the rows and lights the first; a pasted address opens that repository', async () => {
  const h = harness({ repos: [repo('o', 'alpha'), repo('o', 'beta')] });
  const done = h.picker.pick('neural');
  type(h, 'BETA');
  assert.deepStrictEqual(listed(h), ['# Matches', 'o/beta']);
  assert.deepStrictEqual(lit(h), ['true']);
  type(h, 'https://github.com/far/away.git');
  assert.deepStrictEqual(listed(h), ['# Any repository', 'far/away']);
  press(h, 'Enter');
  await done;
  assert.deepStrictEqual(h.log.slice(1), [['close', true], ['open', 'far', 'away'], ['tab', 'neural']]);
  const own = harness({ repos: [repo('o', 'alpha')], recent: [{ owner: 'v', name: 'visited', visitor: true }] });
  void own.picker.pick('safeguards', { own: true });
  assert.deepStrictEqual(listed(own), ['# All repositories', 'o/alpha']);
  type(own, 'https://github.com/far/away');
  assert.deepStrictEqual(listed(own), ['! No repository matches \u201chttps://github.com/far/away\u201d.']);
});

check('the listing\'s place is kept between pickers: an empty page starts again from the first', async () => {
  const h = harness();
  void h.picker.pick('neural');
  h.pending.shift().resolve(Array.from({ length: 30 }, (_, at) => repo('o', `r${at}`)));
  await flush();
  h.dialog.resolve(false);
  await flush();
  h.state.repoPage = 1;
  void h.picker.pick('neural');
  h.dialog.foot.children[1].fire('click');
  assert.deepStrictEqual(h.log.filter(entry => entry[0] === 'api').map(entry => entry[1]), ['/api/repos?page=1&sort=updated', '/api/repos?page=2&sort=updated']);
  h.dialog.resolve(false);
  h.state.repos = [];
  void h.picker.pick('neural');
  assert.deepStrictEqual(h.log.filter(entry => entry[0] === 'api').pop(), ['api', '/api/repos?page=1&sort=updated']);
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
  console.log(`page picker: ${checks.length} checks passed`);
})();
