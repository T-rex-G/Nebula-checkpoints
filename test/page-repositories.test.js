'use strict';

/*
 * The repository list, asked directly: what a pasted text names
 * (features/repositories/repository-reference.ts); a card, the filter and the
 * card for a repository the list does not hold (repository-list.ts); and the
 * list at work -- listed, a page more, sorted, filtered, opened
 * (repository-list-controller.ts).
 */

const assert = require('assert');
const { repositoryReference, sessionHost, REPO_PART } = require('../apps/web/src/features/repositories/repository-reference.ts');
const { repoCardHtml, filterQuery, cardShown, openAnyView, EMPTY_LIST_HTML, LOADING_LIST_HTML, PAGE_SIZE, REPO_VIS_PRIVATE, REPO_VIS_PUBLIC } = require('../apps/web/src/features/repositories/repository-list.ts');
const { createRepositoryList } = require('../apps/web/src/features/repositories/repository-list-controller.ts');
const { EMPTY_ICON, META_ICON } = require('../apps/web/src/components/icons.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

/* ---- What a pasted text names ------------------------------------------------------------ */

check('a repository is named as owner/name, by any address inside it on this host, or by its clone address', () => {
  const named = text => { const r = repositoryReference(text); return r && (r.wrongHost !== undefined ? { wrongHost: r.wrongHost } : { owner: r.owner, name: r.name, kind: r.kind }); };
  assert.deepStrictEqual(named('octo/repo'), { owner: 'octo', name: 'repo', kind: 'name' });
  assert.deepStrictEqual(named('  octo/repo  '), { owner: 'octo', name: 'repo', kind: 'name' });
  for (const address of ['https://github.com/octo/repo', 'http://github.com/octo/repo/', 'https://www.github.com/octo/repo/blob/main/a.js', 'github.com/octo/repo/issues/4', 'https://github.com/octo/repo.git', 'https://GitHub.com/octo/repo/tree/feature']) {
    assert.deepStrictEqual(named(address), { owner: 'octo', name: 'repo', kind: 'address' }, address);
  }
  for (const clone of ['git@github.com:octo/repo.git', 'ssh://git@github.com/octo/repo.git', 'git@GITHUB.com:octo/repo']) {
    assert.deepStrictEqual(named(clone), { owner: 'octo', name: 'repo', kind: 'address' }, clone);
  }
  assert.deepStrictEqual(named('https://gitlab.com/octo/repo'), { wrongHost: 'gitlab.com' });
  assert.deepStrictEqual(named('git@gitlab.example:octo/repo.git'), { wrongHost: 'gitlab.example' });
  assert.deepStrictEqual(named('https://github.com/octo%2Dx/re%2Epo'), { owner: 'octo-x', name: 're.po', kind: 'address' }, 'an escaped address is read');
  assert.strictEqual(sessionHost(), 'github.com');
});

check('anything else names nothing -- a malformed escape included, which used to throw out of the filter box', () => {
  for (const text of ['', '   ', 'octo', 'octo/repo/extra', 'https://github.com/octo/repo/blob/main/a b.js', 'github.com/octo', 'a b/c', 'octo/..', 'octo/.', 'oc to/repo', 'https://github.com/octo', 'https://github.com/', 'https://[bad', `${'a'.repeat(200)}/${'b'.repeat(201)}`, 'octo/re$po', null, undefined]) {
    assert.strictEqual(repositoryReference(text), null, String(text));
  }
  for (const text of ['a/%zz', 'https://github.com/octo/%E0%A4%A', 'octo/%']) {
    assert.doesNotThrow(() => repositoryReference(text), text);
    assert.strictEqual(repositoryReference(text), null, text);
  }
  assert.ok(REPO_PART.test('octo') && REPO_PART.test('a.b-c_d') && !REPO_PART.test('a b') && !REPO_PART.test(''));
});

/* ---- A card, the filter, the card for a repository not listed ---------------------------- */

check('a card says who can see the repository in words and a mark, and keeps a language as text', () => {
  const priv = repoCardHtml({ private: true, language: '<b>Go</b>', stars: 3, forks: 1 }, '2h ago');
  assert.ok(priv.includes('data-visibility="private" title="Private repository">') && priv.includes(REPO_VIS_PRIVATE) && priv.includes('<span class="sr-only">Private</span>'));
  assert.ok(priv.includes('<span><span class="lang-dot"></span>&lt;b&gt;Go&lt;/b&gt;</span>'));
  assert.ok(priv.includes(`<span>${META_ICON.star} 3</span><span>${META_ICON.fork} 1</span><span>2h ago</span>`));
  const pub = repoCardHtml({ private: false, stars: 0, forks: 0 }, '');
  assert.ok(pub.includes('data-visibility="public" title="Public repository">') && pub.includes(REPO_VIS_PUBLIC) && pub.includes('<span class="sr-only">Public</span>'));
  assert.ok(!pub.includes('lang-dot'), 'no language, no dot');
  assert.ok(pub.includes('<span class="repo-name"></span>') && pub.includes('<p class="desc"></p>'), 'the name and description are set as text, not markup');
  assert.ok(EMPTY_LIST_HTML.includes(EMPTY_ICON.repos) && EMPTY_LIST_HTML.includes('No repositories yet.'));
  assert.strictEqual(LOADING_LIST_HTML, '<div class="skeleton"></div>'.repeat(6));
  assert.strictEqual(PAGE_SIZE, 30);
});

check('the filter narrows by what was typed, or to the one repository an address names', () => {
  assert.strictEqual(filterQuery('Demo'), 'demo');
  assert.strictEqual(filterQuery('https://github.com/Octo/Repo/blob/main/x'), 'octo/repo');
  assert.strictEqual(filterQuery('octo/repo'), 'octo/repo', 'a name is matched as typed, not taken for an address');
  assert.strictEqual(filterQuery(' Octo/Repo '), ' octo/repo ', 'as typed, spaces and all');
  assert.strictEqual(filterQuery('a/%zz'), 'a/%zz', 'what cannot be read as an address is matched as typed');
  assert.ok(cardShown('Sandbox/Demo  JavaScript', 'demo') && !cardShown('sandbox/other', 'demo') && cardShown('anything', ''));
});

check('the card above the list offers only a repository the list does not hold, and an address elsewhere says so', () => {
  const repos = [{ owner: 'Sandbox', name: 'Demo' }];
  assert.deepStrictEqual({ ...openAnyView('', repos) }, { cardHidden: true, hintHidden: true, hint: '' });
  assert.deepStrictEqual({ ...openAnyView('sandbox/demo', repos) }, { cardHidden: true, hintHidden: true, hint: '' }, 'listed, whatever the case');
  assert.deepStrictEqual({ ...openAnyView('https://gitlab.com/a/b', repos) }, { cardHidden: true, hintHidden: false, hint: 'That address is on gitlab.com; this session reads repositories on github.com.' });
  assert.deepStrictEqual({ ...openAnyView('octo/repo', repos) }, {
    cardHidden: false, hintHidden: true, hint: '', owner: 'octo', name: 'repo', title: 'octo/repo', sub: 'Open from github.com — read-only unless you can push to it'
  });
});

/* ---- The list at work --------------------------------------------------------------------- */

const repo = (i, extra = {}) => ({ full_name: `sandbox/repo-${i}`, owner: 'sandbox', name: `repo-${i}`, private: false, description: `About ${i}`, stars: 0, forks: 0, pushed_at: 'then', ...extra });

function listWorld(over = {}) {
  const log = [];
  const state = { repoPage: 1, repoSort: 'pushed', repos: [], uiEpoch: 0 };
  const grid = { innerHTML: '', children: [], appendChild(node) { this.children.push(node); } };
  Object.defineProperty(grid, 'innerHTML', { get() { return this._html || ''; }, set(html) { this._html = html; this.children = []; log.push(['grid', html.length > 40 ? `${html.slice(0, 40)}…` : html]); } });
  const more = { hidden: true };
  const filterBox = { value: over.filter || '' };
  const offer = { input: filterBox, card: { hidden: true }, hint: { hidden: true, textContent: '' }, title: { textContent: '' }, sub: { textContent: '' }, button: { dataset: {} } };
  const pages = over.pages || {};
  const held = [];
  const deps = {
    api: async path => {
      log.push(['api', path]);
      if (over.hold && path.includes(`page=${over.hold}`)) await new Promise(resolve => { held.push(resolve); });
      const page = Number(/page=(\d+)/.exec(path)[1]);
      const answer = pages[page];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer();
      return answer || [];
    },
    state,
    appendRepos: batch => { state.repos = [...state.repos, ...batch]; },
    grid: () => grid,
    moreButton: () => more,
    cards: () => grid.children,
    createCard: () => {
      const node = {
        className: '', tabIndex: -1, attributes: {}, listeners: {}, style: { display: '' }, slot: [], name: { textContent: '' }, desc: { textContent: '' },
        set innerHTML(html) { this.html = html; }, get innerHTML() { return this.html; },
        get textContent() { return `${this.name.textContent} ${this.desc.textContent}`; },
        setAttribute(key, value) { this.attributes[key] = value; },
        querySelector(selector) { return selector === 'h3 .repo-name' ? this.name : selector === '.desc' ? this.desc : selector === '.repo-sigil-slot' ? { appendChild: n => this.slot.push(n) } : null; },
        addEventListener(type, listener) { this.listeners[type] = listener; }
      };
      return node;
    },
    sigil: fullName => (over.noSigil ? null : { sigil: fullName }),
    timeAgo: iso => `ago:${iso}`,
    open: (owner, name) => log.push(['open', owner, name]),
    filterText: () => filterBox.value,
    openAny: () => offer,
    renderGalaxyPulse: repos => log.push(['galaxy', repos.length]),
    renderWorkspacePulse: repos => log.push(['workspace', repos === undefined ? 'list' : repos.length]),
    toast: (message, kind) => log.push(['toast', message, kind])
  };
  return { list: createRepositoryList(deps), log, state, grid, more, offer, filterBox, release: () => { while (held.length) held.shift()(); } };
}

check('a fresh listing shows the skeleton, then a card for each repository, and says whether there may be more', async () => {
  const world = listWorld({ pages: { 1: Array.from({ length: 30 }, (_, i) => repo(i + 1)) } });
  world.state.repoPage = 4;
  world.state.repos = [repo(99)];
  await world.list.load(true);
  assert.deepStrictEqual(world.log.slice(0, 3), [['grid', LOADING_LIST_HTML.slice(0, 40) + '…'], ['api', '/api/repos?page=1&sort=pushed'], ['grid', '']]);
  assert.strictEqual(world.grid.children.length, 30);
  assert.strictEqual(world.state.repos.length, 30, 'the old list is replaced, not added to');
  assert.strictEqual(world.more.hidden, false, 'a full page: there may be more');
  assert.deepStrictEqual(world.log.slice(-2), [['galaxy', 30], ['workspace', 'list']]);
  const card = world.grid.children[0];
  assert.deepStrictEqual([card.className, card.tabIndex, card.attributes.role, card.attributes['aria-label']], ['card repo-card pressable', 0, 'button', 'Open repository sandbox/repo-1']);
  assert.deepStrictEqual([card.name.textContent, card.desc.textContent], ['sandbox/repo-1', 'About 1']);
  assert.ok(card.html.includes('<span>ago:then</span>'));
  assert.deepStrictEqual(card.slot, [{ sigil: 'sandbox/repo-1' }]);
  const short = listWorld({ pages: { 1: [repo(1, { description: '' })] }, noSigil: true });
  short.more.hidden = false;
  await short.list.load(true);
  assert.strictEqual(short.more.hidden, true, 'less than a page: nothing more');
  assert.strictEqual(short.grid.children[0].desc.textContent, 'No description');
  assert.deepStrictEqual(short.grid.children[0].slot, [], 'no mark drawn, nothing lost but the picture');
  const none = listWorld();
  await none.list.load(true);
  assert.strictEqual(none.grid.innerHTML, EMPTY_LIST_HTML);
});

check('a listing repaints the card above the list: a repository it now holds is no longer offered', async () => {
  const world = listWorld({ pages: { 1: [repo(5)] } });
  world.filterBox.value = 'sandbox/repo-5';
  world.list.filter(world.filterBox.value);
  assert.strictEqual(world.offer.card.hidden, false, 'not listed yet: offered');
  await world.list.load(true);
  assert.strictEqual(world.offer.card.hidden, true, 'listed now');
});

check('a fresh listing does not wait on a page more of the listing it replaced', async () => {
  const world = listWorld({ pages: { 1: Array.from({ length: 30 }, (_, i) => repo(i + 1)), 2: Array.from({ length: 30 }, (_, i) => repo(i + 31)) }, hold: 2 });
  await world.list.load(true);
  const stale = world.list.more();
  world.list.load(true);
  await new Promise(resolve => setImmediate(resolve));
  const fresh = world.list.more();
  assert.notStrictEqual(fresh, stale, 'a page more of the new listing is asked for');
  world.release();
  await Promise.all([stale, fresh]);
  assert.strictEqual(world.log.filter(entry => entry[0] === 'api' && entry[1].includes('page=2')).length, 2);
  assert.strictEqual(world.grid.children.length, 60, 'and only the new listing\'s pages are drawn');
});

check('a card opens its repository on a press, Enter or Space, and nothing else', async () => {
  const world = listWorld({ pages: { 1: [repo(7)] } });
  await world.list.load(true);
  const card = world.grid.children[0];
  card.listeners.click();
  const keys = [];
  for (const key of ['Enter', ' ', 'a', 'Escape']) card.listeners.keydown({ key, preventDefault: () => keys.push(key) });
  assert.deepStrictEqual(world.log.filter(entry => entry[0] === 'open'), [['open', 'sandbox', 'repo-7'], ['open', 'sandbox', 'repo-7'], ['open', 'sandbox', 'repo-7']]);
  assert.deepStrictEqual(keys, ['Enter', ' ']);
});

check('a listing overtaken by a newer one, or by an account change, draws nothing', async () => {
  const world = listWorld({ hold: 1, pages: { 1: [repo(1)] } });
  const first = world.list.load(true);
  world.list.load(true);
  world.release();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(world.grid.children.length, 1, 'drawn once, by the newer listing');
  assert.strictEqual(world.state.repos.length, 1);
  const changed = listWorld({ pages: { 1: () => { changed.state.uiEpoch += 1; return [repo(1)]; } } });
  await changed.list.load(true);
  assert.strictEqual(changed.grid.children.length, 0);
  assert.ok(!changed.log.some(entry => entry[0] === 'galaxy'));
  const refusedLate = listWorld({ pages: { 1: () => { refusedLate.state.uiEpoch += 1; throw new Error('gone'); } } });
  await refusedLate.list.load(true);
  assert.ok(!refusedLate.log.some(entry => entry[0] === 'toast'), 'a refusal for an account that has gone says nothing');
});

check('a fresh listing that cannot be read says why and draws an empty list and pulses', async () => {
  const world = listWorld({ pages: { 1: new Error('Service waking') } });
  await world.list.load(true);
  assert.deepStrictEqual(world.log.slice(-4), [['toast', 'Service waking', 'err'], ['grid', ''], ['galaxy', 0], ['workspace', 0]]);
});

check('a page more is the next page, one at a time, added to the list and narrowed by the filter', async () => {
  const world = listWorld({ pages: { 1: Array.from({ length: 30 }, (_, i) => repo(i + 1)), 2: Array.from({ length: 30 }, (_, i) => repo(i + 31)) }, hold: 2 });
  await world.list.load(true);
  world.filterBox.value = 'repo-1';
  world.list.filter('repo-1');
  const shown = () => world.grid.children.filter(card => card.style.display !== 'none').length;
  assert.strictEqual(shown(), 11);
  const first = world.list.more();
  const second = world.list.more();
  assert.strictEqual(first, second, 'a second press while a page is on its way is the same page');
  world.release();
  await first;
  assert.deepStrictEqual(world.log.filter(entry => entry[0] === 'api'), [['api', '/api/repos?page=1&sort=pushed'], ['api', '/api/repos?page=2&sort=pushed']]);
  assert.strictEqual(world.grid.children.length, 60);
  assert.strictEqual(shown(), 11, 'the next page is narrowed by what the filter holds');
  assert.strictEqual(world.state.repos.length, 60);
});

check('a page more that cannot be read leaves the list as it was, says why, and the next press asks for it again', async () => {
  let refuse = true;
  const world = listWorld({ pages: { 1: Array.from({ length: 30 }, (_, i) => repo(i + 1)), 2: () => { if (refuse) throw new Error('Service waking'); return [repo(31)]; } } });
  await world.list.load(true);
  await world.list.more();
  assert.strictEqual(world.grid.children.length, 30, 'the cards drawn stay');
  assert.strictEqual(world.state.repos.length, 30);
  assert.strictEqual(world.more.hidden, false, 'and more can be asked for again');
  assert.deepStrictEqual(world.log.slice(-1), [['toast', 'Service waking', 'err']]);
  assert.ok(!world.log.slice(-3).some(entry => entry[0] === 'galaxy' || entry[0] === 'grid'), 'nothing emptied, no pulse drawn as nothing');
  refuse = false;
  await world.list.more();
  assert.deepStrictEqual(world.log.filter(entry => entry[0] === 'api').slice(-1), [['api', '/api/repos?page=2&sort=pushed']], 'the same page');
  assert.strictEqual(world.grid.children.length, 31);
});

check('a new order lists afresh, and the filter narrows a fresh listing too', async () => {
  const world = listWorld({ pages: { 1: [repo(1), repo(22)] } });
  world.filterBox.value = 'repo-22';
  await world.list.sort('stars');
  assert.strictEqual(world.state.repoSort, 'stars');
  assert.deepStrictEqual(world.log.filter(entry => entry[0] === 'api'), [['api', '/api/repos?page=1&sort=stars']]);
  assert.deepStrictEqual(world.grid.children.map(card => card.style.display), ['none', '']);
});

check('typing narrows the list and paints the card above it; Enter opens what the card offers; pressing it clears the filter first', async () => {
  const world = listWorld({ pages: { 1: [repo(1), repo(2)] } });
  await world.list.load(true);
  world.filterBox.value = 'octo/unlisted';
  world.list.filter('octo/unlisted');
  assert.deepStrictEqual(world.grid.children.map(card => card.style.display), ['none', 'none']);
  assert.strictEqual(world.offer.card.hidden, false);
  assert.deepStrictEqual([world.offer.title.textContent, world.offer.button.dataset.owner, world.offer.button.dataset.name], ['octo/unlisted', 'octo', 'unlisted']);
  assert.strictEqual(world.list.enter(), true);
  await world.list.openAny('octo', 'unlisted');
  assert.strictEqual(world.filterBox.value, '');
  assert.deepStrictEqual(world.grid.children.map(card => card.style.display), ['', '']);
  assert.strictEqual(world.offer.card.hidden, true);
  assert.deepStrictEqual(world.log.slice(-1), [['open', 'octo', 'unlisted']]);
  assert.strictEqual(world.list.enter(), false, 'nothing offered, Enter does nothing');
  await world.list.openAny(undefined, 'x');
  assert.deepStrictEqual(world.log.slice(-1), [['open', 'octo', 'unlisted']], 'a card with no repository opens nothing');
  world.filterBox.value = 'https://gitlab.com/a/b';
  world.list.filter(world.filterBox.value);
  assert.deepStrictEqual([world.offer.card.hidden, world.offer.hint.hidden], [true, false]);
  world.filterBox.value = 'a/%zz';
  assert.doesNotThrow(() => world.list.filter(world.filterBox.value), 'a malformed escape no longer stops the filter');
  assert.deepStrictEqual([world.offer.card.hidden, world.offer.hint.hidden], [true, true]);
});

/* Unfinished counts as failed. */
process.exitCode = 1;
(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`  ok  ${name}`); } catch (error) { failed += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
  }
  if (failed) { console.error(`${failed} of ${checks.length} repository checks failed`); return; }
  console.log(`page repositories tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})();
