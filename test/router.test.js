'use strict';

/*
 * The page's addresses, read and written in one place
 * (apps/web/src/platform/router.ts, ADR-092).
 *
 * Every address the page wrote before the router must be the address it
 * writes now, byte for byte, and must open the same thing. The workbench
 * built its address and parsed it again with the expressions kept below as
 * the oracle; the router is held to them over a corpus of awkward names and
 * over generated ones. The module runs whole in a stand-in browser: a
 * location and history that behave as the browser's do, and a window that
 * dispatches popstate and hashchange.
 */

const assert = require('assert');
const { loadPageModule } = require('./helpers/page-module');

/* The workbench's own expressions before the router, as the oracle. */
const legacy = Object.freeze({
  format(owner, repo, branch, tab, file) {
    return `#/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
      `@${encodeURIComponent(branch)}/${tab}` +
      (file ? '/' + encodeURIComponent(file) : '');
  },
  parse(hash) {
    if (/^#\/findings(\?.*)?$/.test(hash)) {
      const match = /^#\/findings(\?.*)?$/.exec(hash);
      return { kind: 'findings', query: match && match[1] ? match[1] : '' };
    }
    const m = /^#\/([^/]+)\/([^/@]+)@([^/]+)\/([a-z]+)(?:\/(.+))?$/.exec(hash);
    if (!m) return { kind: 'none' };
    try {
      return {
        kind: 'workbench', owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]),
        branch: decodeURIComponent(m[3]), tab: m[4], file: m[5] ? decodeURIComponent(m[5]) : null
      };
    } catch {
      return { kind: 'none' };
    }
  }
});

function browser(start = 'https://nebula.example/') {
  let url = new URL(start);
  const listeners = new Map();
  const entries = [];
  const location = {
    get hash() { return url.hash; },
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    get href() { return url.href; },
    get origin() { return url.origin; }
  };
  const history = {
    pushState(_state, _title, next) { url = new URL(next, url); entries.push(['push', url.href]); },
    replaceState(_state, _title, next) { url = new URL(next, url); entries.push(['replace', url.href]); }
  };
  const window = {
    location,
    history,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      if (listeners.has(type)) listeners.get(type).delete(listener);
    }
  };
  const router = loadPageModule('apps/web/src/platform/router.ts', { window, URL });
  return {
    router,
    entries,
    /* The reader edits the address, or the browser moves through its history. */
    visit(next, type) {
      url = new URL(next, url);
      for (const listener of listeners.get(type) || []) listener({ type });
    },
    listening: type => (listeners.get(type) || new Set()).size
  };
}

const plain = route => JSON.parse(JSON.stringify(route));

const OWNERS = ['sandbox', 'T-rex-G', 'org.with.dots', 'name_with_underscores', 'a', 'Zürich', 'ünïcödé', 'space name', 'pct%20lit'];
const REPOS = ['demo', 'Nebula-checkpoints', 'repo.js', 'r@at', 'hash#repo', 'q?mark', 'emoji-🚀', 'amp&er=sand', '+plus+'];
const BRANCHES = ['main', 'feature/x', 'release/2026.11', 'fix#12', 'a@b', 'with space', '%25already', 'ブランチ', 'v1.0+build', '..'];
const TABS = ['editor', 'upload', 'commits', 'pulls', 'issues', 'releases', 'actions', 'compare', 'neural', 'governance', 'exposure', 'audit', 'safeguards'];
const FILES = [null, 'README.md', 'docs/security.md', 'src/a b/c.js', 'deep/er/nested/path/file.ts', '.env.example', 'weird#name?.txt', 'ünï/cödé.md', '100%.txt', '@scope/pkg/index.js'];

const cases = [];
const check = (name, run) => cases.push([name, run]);

check('every address the workbench wrote is the address it writes now, and opens the same thing', () => {
  const { router } = browser();
  let compared = 0;
  for (const owner of OWNERS) for (const repo of REPOS) for (const branch of BRANCHES) {
    for (const file of FILES) {
      const tab = TABS[(owner.length + repo.length + branch.length) % TABS.length];
      const address = legacy.format(owner, repo, branch, tab, file);
      const route = { kind: 'workbench', owner, repo, branch, tab, file };
      assert.strictEqual(router.formatRoute(route), address, `${owner}/${repo}@${branch}/${tab}/${file}`);
      assert.deepStrictEqual(plain(router.parseRoute(address)), legacy.parse(address));
      assert.deepStrictEqual(plain(router.parseRoute(address)), route);
      compared += 1;
    }
  }
  assert(compared > 7000, `compared ${compared} addresses`);
});

check('generated names, any character the encoder meets, write and open as before', () => {
  const { router } = browser();
  /* A fixed generator, so a failure names an input that can be replayed. */
  let seed = 0x2f6e2b1;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  const alphabet = [...'abcXYZ019-_.~!*\'()/@#?&=+,;:$% '].concat(['é', 'ß', '中', '🚀', ' ']);
  const word = (min, max) => {
    const length = min + (next() % (max - min + 1));
    return Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');
  };
  for (let i = 0; i < 3000; i += 1) {
    const owner = word(1, 12);
    const repo = word(1, 12);
    const branch = word(1, 16);
    const tab = TABS[next() % TABS.length];
    const file = next() % 3 ? word(1, 30) : null;
    const address = legacy.format(owner, repo, branch, tab, file);
    assert.strictEqual(router.formatRoute({ kind: 'workbench', owner, repo, branch, tab, file }), address);
    assert.deepStrictEqual(plain(router.parseRoute(address)), legacy.parse(address), `case ${i}: ${address}`);
  }
});

check('the findings address carries its filters as written', () => {
  const { router } = browser();
  for (const query of ['', '?severity=critical', '?repo=sandbox%2Fdemo&state=open', '?q=a%20b', '?']) {
    const address = `#/findings${query}`;
    assert.deepStrictEqual(plain(router.parseRoute(address)), { kind: 'findings', query: query || '' });
    assert.deepStrictEqual(plain(router.parseRoute(address)), legacy.parse(address));
    assert.strictEqual(router.formatRoute({ kind: 'findings', query }), address);
  }
  /* An owner named "findings" is a repository, not the inbox. */
  assert.strictEqual(router.parseRoute('#/findings/demo@main/editor').kind, 'workbench');
  /* An address both patterns would read -- filters holding "/" and "@" -- is the inbox's, as it always was. */
  const either = '#/findings?q=a/b@c/editor';
  assert.deepStrictEqual(plain(router.parseRoute(either)), { kind: 'findings', query: '?q=a/b@c/editor' });
  assert.deepStrictEqual(plain(router.parseRoute(either)), legacy.parse(either));
});

check('an address that names nothing opens nothing', () => {
  const { router } = browser();
  for (const hash of [
    '', '#', '#/', '#/overview', '#/findingsx', '#/sandbox/demo', '#/sandbox/demo@main',
    '#/sandbox/demo@main/', '#/sandbox/demo@main/Editor', '#/sandbox/demo@main/editor2',
    '#/sandbox@main/editor', '#sandbox/demo@main/editor',
    /* Not valid percent-encoding: a link mangled in transit. */
    '#/sandbox/demo@main/editor/%E0%A4%A', '#/%zz/demo@main/editor', '#/sandbox/demo@%/editor'
  ]) {
    assert.deepStrictEqual(plain(router.parseRoute(hash)), { kind: 'none' }, hash);
    assert.deepStrictEqual(plain(router.parseRoute(hash)), legacy.parse(hash), hash);
  }
  assert.strictEqual(router.formatRoute(router.NO_ROUTE), '');
  /* A repository name ends at its first "@"; what follows, "@" and all, is the branch. */
  assert.deepStrictEqual(plain(router.parseRoute('#/sandbox/de@mo@main/editor')),
    { kind: 'workbench', owner: 'sandbox', repo: 'de', branch: 'mo@main', tab: 'editor', file: null });
});

check('a route read from an address cannot be changed by its reader', () => {
  const { router } = browser();
  const route = router.parseRoute('#/sandbox/demo@main/editor/README.md');
  assert(Object.isFrozen(route));
  assert(Object.isFrozen(router.parseRoute('#/findings?x=1')));
  assert(Object.isFrozen(router.NO_ROUTE));
});

check('writing a route replaces the entry, or adds one the reader can step back from', () => {
  const b = browser('https://nebula.example/?keep=1');
  const work = { kind: 'workbench', owner: 'sandbox', repo: 'demo', branch: 'main', tab: 'audit', file: null };
  assert.strictEqual(b.router.writeRoute(work), true);
  assert.deepStrictEqual(b.entries.at(-1), ['replace', 'https://nebula.example/?keep=1#/sandbox/demo@main/audit']);
  assert.strictEqual(b.router.writeRoute({ ...work, tab: 'commits' }, { push: true }), true);
  assert.deepStrictEqual(b.entries.at(-1), ['push', 'https://nebula.example/?keep=1#/sandbox/demo@main/commits']);
  /* The same address again is no change, and no history entry. */
  assert.strictEqual(b.router.writeRoute({ ...work, tab: 'commits' }, { push: true }), false);
  assert.strictEqual(b.entries.length, 2);
  assert.deepStrictEqual(plain(b.router.currentRoute()), { ...work, tab: 'commits' });
});

check('a screen with no address clears the fragment, a bare "#" included, and keeps the path and query', () => {
  const b = browser('https://nebula.example/app?keep=1#/sandbox/demo@main/editor');
  assert.strictEqual(b.router.writeRoute(b.router.NO_ROUTE), true);
  assert.deepStrictEqual(b.entries.at(-1), ['replace', 'https://nebula.example/app?keep=1']);
  assert.strictEqual(b.router.writeRoute(b.router.NO_ROUTE), false, 'nothing left to clear');
  const bare = browser('https://nebula.example/#');
  assert.strictEqual(bare.router.writeRoute(bare.router.NO_ROUTE), true);
  assert.deepStrictEqual(bare.entries.at(-1), ['replace', 'https://nebula.example/']);
});

check('Back, Forward and an edited address are each heard once, until the listener stops', () => {
  const b = browser();
  const heard = [];
  const stop = b.router.onRouteChange(route => heard.push(plain(route)));
  b.visit('#/sandbox/demo@main/governance', 'hashchange');
  b.visit('#/findings?state=open', 'popstate');
  assert.deepStrictEqual(heard, [
    { kind: 'workbench', owner: 'sandbox', repo: 'demo', branch: 'main', tab: 'governance', file: null },
    { kind: 'findings', query: '?state=open' }
  ]);
  stop();
  assert.strictEqual(b.listening('hashchange'), 0);
  assert.strictEqual(b.listening('popstate'), 0);
  b.visit('#/sandbox/demo@main/audit', 'hashchange');
  assert.strictEqual(heard.length, 2);
});

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}\n${error.stack}`);
  }
}
if (failed) {
  console.error(`${failed} of ${cases.length} router checks failed`);
  process.exit(1);
}
console.log(`router: ${cases.length} checks passed`);
