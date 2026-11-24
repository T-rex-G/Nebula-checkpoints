'use strict';

/*
 * The overview's readings, asked directly: the recent-activity feed
 * (features/overview/activity-feed-controller.ts), the rail's boundary line
 * (features/overview/boundary-line.ts), the workspace posture, the security
 * posture card and upload scanning (features/posture/posture-controller.ts),
 * and the open pull requests across the workspace
 * (features/posture/pull-board-controller.ts).
 */

const assert = require('assert');
const { createActivityFeed, feedReading } = require('../apps/web/src/features/overview/activity-feed-controller.ts');
const { BOUNDARY_COPY, boundaryKey, paintBoundary } = require('../apps/web/src/features/overview/boundary-line.ts');
const { POSTURE_TTL_MS, createPosture } = require('../apps/web/src/features/posture/posture-controller.ts');
const { PULL_BOARD_TTL_MS, WATCH_MARGIN, createPullBoard } = require('../apps/web/src/features/posture/pull-board-controller.ts');
const { REPOSITORY_LIMIT } = require('../apps/web/src/features/posture/pull-board.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const flush = () => new Promise(resolve => setImmediate(resolve));

/* Requests held until a check answers them, in the order it chooses. */
function requests() {
  const pending = [];
  const asked = [];
  const api = path => new Promise((resolve, reject) => { asked.push(path); pending.push({ path, resolve, reject }); });
  const take = path => {
    const i = pending.findIndex(p => p.path === path || (path instanceof RegExp && path.test(p.path)));
    assert.ok(i !== -1, `nothing asked of ${path}; waiting: ${pending.map(p => p.path).join(', ')}`);
    return pending.splice(i, 1)[0];
  };
  return {
    api, asked, pending,
    async answer(path, value) { take(path).resolve(value); await flush(); },
    async refuse(path, error) { take(path).reject(error); await flush(); }
  };
}
const offline = Object.assign(new Error('Failed to fetch'), { offlineMark: true });
const isOffline = error => /failed to fetch/i.test(String(error && error.message));

/* ---- The recent-activity feed ----------------------------------------------------------- */

function feedWorld(over = {}) {
  const r = requests();
  const state = { me: { login: 'ada' }, uiEpoch: 1 };
  const drawn = [];
  const erased = [];
  const refresh = { disabled: false, textContent: 'Refresh' };
  let clock = 1000;
  const feed = createActivityFeed({
    state, api: r.api,
    root: () => ('root' in over ? over.root : 'feed-root'),
    refresh: () => ('refresh' in over ? over.refresh : refresh),
    draw: (root, current) => drawn.push([root, current && JSON.parse(JSON.stringify(current))]),
    erase: root => erased.push(root),
    now: () => clock
  });
  return { r, state, drawn, erased, refresh, feed, tick: ms => { clock += ms; } };
}

check('the feed is read once, drawn while it is read and then from the answer as it arrived', async () => {
  const w = feedWorld();
  const run = w.feed.load();
  assert.deepStrictEqual(w.r.asked, ['/api/activity/recent']);
  assert.deepStrictEqual(w.drawn, [['feed-root', { loading: true }]]);
  assert.deepStrictEqual([w.refresh.disabled, w.refresh.textContent], [true, 'Refreshing\u2026']);
  w.tick(5);
  await w.r.answer('/api/activity/recent', { generatedAt: 't', days: 7, perRepositoryLimit: 5, kinds: ['push'], inventoryCount: 3, measured: 1, events: [{ a: 1 }], truncated: 0, totalEvents: 9, undated: 2, repositories: ['x'], failed: [{ repo: 'b' }] });
  await run;
  assert.deepStrictEqual(w.drawn[1], ['feed-root', {
    loading: false, now: 1005, generatedAt: 't', days: 7, perRepositoryLimit: 5, kinds: ['push'], inventoryCount: 3, measured: true,
    events: [{ a: 1 }], truncated: false, totalEvents: 9, undated: 2, repositories: ['x'], failed: [{ repo: 'b' }]
  }]);
  assert.deepStrictEqual([w.refresh.disabled, w.refresh.textContent], [false, 'Refresh']);
  await w.feed.load();
  assert.deepStrictEqual(w.r.asked, ['/api/activity/recent'], 'a feed already read is drawn again, not read again');
  assert.strictEqual(w.drawn.length, 3);
});

check('an empty answer is an answer with nothing in it, never the script\'s own error', async () => {
  for (const empty of [null, undefined, 'text', 7]) {
    const w = feedWorld();
    const run = w.feed.load();
    await w.r.answer('/api/activity/recent', empty);
    await run;
    const [, drawn] = w.drawn.at(-1);
    assert.deepStrictEqual(drawn, { loading: false, now: 1000, perRepositoryLimit: 20, kinds: [], inventoryCount: 0, measured: false, events: [], truncated: false, totalEvents: 0, undated: 0, repositories: [], failed: [] }, String(empty));
    assert.ok(!('error' in drawn));
  }
  assert.deepStrictEqual(feedReading({ events: 'no', repositories: {}, failed: 3, perRepositoryLimit: 0 }, 4), {
    loading: false, now: 4, generatedAt: undefined, days: undefined, perRepositoryLimit: 20, kinds: [], inventoryCount: 0, measured: false,
    events: [], truncated: false, totalEvents: 0, undated: 0, repositories: [], failed: []
  });
});

check('Refresh reads again, one reading at a time, and says it is reading', async () => {
  const w = feedWorld();
  const first = w.feed.load();
  await w.r.answer('/api/activity/recent', { events: [] });
  await first;
  const again = w.feed.load(true);
  assert.strictEqual(w.r.asked.length, 2);
  await w.feed.load(true);
  assert.strictEqual(w.r.asked.length, 2, 'a Refresh during a reading asks nothing more');
  assert.deepStrictEqual(w.drawn.at(-1).slice(1), [{ loading: true }]);
  assert.deepStrictEqual([w.refresh.disabled, w.refresh.textContent], [true, 'Refreshing\u2026']);
  await w.r.answer('/api/activity/recent', { events: [1] });
  await again;
  assert.deepStrictEqual(w.drawn.at(-1)[1].events, [1]);
});

check('every failure is drawn with its reason', async () => {
  for (const [error, said] of [[new Error('boom'), 'boom'], [{}, 'request failed'], [null, 'request failed'], [{ message: 5 }, '5']]) {
    const w = feedWorld();
    const run = w.feed.load();
    await w.r.refuse('/api/activity/recent', error);
    await run;
    assert.deepStrictEqual(w.drawn.at(-1).slice(1), [{ loading: false, error: `Recent activity could not be read: ${said}` }]);
    assert.deepStrictEqual([w.refresh.disabled, w.refresh.textContent], [false, 'Refresh']);
  }
});

check('an answer for a reader gone, an epoch moved or a feed let go of is never drawn', async () => {
  for (const leave of ['reader', 'epoch', 'cleared']) {
    for (const ending of ['answer', 'refuse']) {
      const w = feedWorld();
      const run = w.feed.load();
      if (leave === 'reader') w.state.me = { login: 'grace' };
      if (leave === 'epoch') w.state.uiEpoch += 1;
      if (leave === 'cleared') w.feed.clear();
      const drawn = w.drawn.length;
      if (ending === 'answer') await w.r.answer('/api/activity/recent', { events: [1] }); else await w.r.refuse('/api/activity/recent', new Error('x'));
      await run;
      assert.strictEqual(w.drawn.length, drawn, `${leave}/${ending}`);
    }
  }
  const w = feedWorld();
  const first = w.feed.load();
  await w.r.answer('/api/activity/recent', { events: [{ mine: 'ada' }] });
  await first;
  w.feed.clear();
  assert.deepStrictEqual(w.erased, ['feed-root']);
  assert.strictEqual(w.refresh.disabled, true);
  assert.strictEqual(w.feed.current(), null);
  const drawn = w.drawn.length;
  void w.feed.load();
  assert.strictEqual(w.r.asked.length, 2, 'a feed let go of is read afresh');
  assert.deepStrictEqual(w.drawn.slice(drawn), [['feed-root', { loading: true }]], 'never drawn again from what was let go of');
});

check('no card or no reader asks nothing; no Refresh is no trouble', async () => {
  const none = feedWorld({ root: null });
  await none.feed.load();
  assert.deepStrictEqual(none.r.asked, []);
  const nobody = feedWorld();
  nobody.state.me = null;
  await nobody.feed.load();
  assert.deepStrictEqual(nobody.r.asked, []);
  const bare = feedWorld({ refresh: null });
  const run = bare.feed.load();
  await bare.r.answer('/api/activity/recent', {});
  await run;
  bare.feed.clear();
  assert.strictEqual(bare.drawn.length, 2);
});

/* ---- The boundary line ------------------------------------------------------------------- */

check('the boundary line says what the server reported, and nothing it did not', () => {
  const cases = [
    [null, 'checking'], [undefined, 'checking'], [{}, 'checking'], ['online', 'checking'],
    [{ state: 'online' }, 'online'], [{ state: 'online', database: 'not-configured' }, 'local'],
    [{ state: 'degraded' }, 'degraded'], [{ state: 'offline' }, 'offline'], [{ state: 'unreachable' }, 'unreachable'],
    [{ state: 'unknown' }, 'unknown'], [{ state: 'online', maintenance: true }, 'maintenance'], [{ maintenance: 1, state: 'degraded' }, 'maintenance'],
    [{ state: 'sideways' }, 'checking'], [{ state: 'toString' }, 'checking'], [{ state: 'constructor' }, 'checking'], [{ state: '__proto__' }, 'checking'],
    [{ state: 'maintenance' }, 'maintenance'], [{ state: 'local' }, 'local'], [{ state: 'checking' }, 'checking']
  ];
  for (const [boundary, key] of cases) assert.strictEqual(boundaryKey(boundary), key, JSON.stringify(boundary));
  const words = {};
  const root = { dataset: {}, querySelector: selector => (words[selector] = words[selector] || { textContent: '' }) };
  for (const [boundary, key] of cases) {
    paintBoundary(root, boundary);
    assert.strictEqual(root.dataset.state, key);
    assert.deepStrictEqual([words['.nv-rail-state-t'].textContent, words['.nv-rail-d'].textContent], [...BOUNDARY_COPY[key]]);
  }
  assert.deepStrictEqual([...BOUNDARY_COPY.local], ['Boundary online', 'Server controls active \u00b7 no database configured']);
  assert.deepStrictEqual([...BOUNDARY_COPY.checking], ['Checking boundary', 'Waiting for the server\u2019s report']);
  assert.deepStrictEqual(Object.keys(BOUNDARY_COPY), ['checking', 'online', 'local', 'degraded', 'maintenance', 'offline', 'unreachable', 'unknown']);
  assert.doesNotThrow(() => paintBoundary(null, { state: 'online' }));
  const half = { dataset: {}, querySelector: () => null };
  paintBoundary(half, { state: 'degraded' });
  assert.strictEqual(half.dataset.state, 'degraded');
});

/* ---- The posture, the security card and scanning ---------------------------------------- */

function postureWorld(over = {}) {
  const r = requests();
  const log = [];
  const state = { me: { login: 'ada' }, uiEpoch: 1, repos: over.repos || [], posture: null, securityPosture: null, scanner: undefined };
  let clock = 10_000;
  const section = { hidden: false };
  let offered = 'offered' in over ? over.offered : 'Supported';
  const posture = createPosture({
    state, api: r.api, now: () => clock, isOffline,
    capability: name => { log.push(['capability', name]); return offered; },
    paintBoundary: boundary => log.push(['boundary', boundary]),
    renderPulse: () => log.push(['pulse', state.posture, state.scanner]),
    clearFindings: () => log.push(['clearFindings']),
    invalidateFindings: () => log.push(['invalidateFindings']),
    clearPullBoard: () => log.push(['clearPullBoard']),
    section: () => ('section' in over ? over.section : section),
    host: () => ('host' in over ? over.host : 'card'),
    draw: (host, view, actions) => log.push(['draw', host, view, actions]),
    openTool: (owner, repo, tab) => log.push(['open', owner, repo, tab]),
    inbox: () => over.inbox || null
  });
  return { r, log, state, section, posture, tick: ms => { clock += ms; }, offer: value => { offered = value; } };
}
const kinds = log => log.map(entry => entry[0]);

check('the posture is read once a minute for the reader, its boundary drawn and the pulse after', async () => {
  const w = postureWorld();
  const run = w.posture.load();
  assert.deepStrictEqual(w.r.asked, ['/api/workspace/posture']);
  await w.r.answer('/api/workspace/posture', { boundary: { state: 'online' }, reach: 1 });
  await run;
  assert.deepStrictEqual(w.state.posture, { boundary: { state: 'online' }, reach: 1 });
  assert.deepStrictEqual(w.log.filter(e => e[0] !== 'capability'), [['boundary', { state: 'online' }], ['pulse', w.state.posture, undefined]]);
  w.tick(POSTURE_TTL_MS - 1);
  await w.posture.load();
  assert.strictEqual(w.r.asked.length, 1, 'held for a minute');
  w.tick(1);
  void w.posture.load();
  assert.strictEqual(w.r.asked.length, 2, 'read again after it');
  void w.posture.load(true);
  assert.strictEqual(w.r.asked.length, 3, 'or when forced');
  const nobody = postureWorld();
  nobody.state.me = null;
  await nobody.posture.load();
  assert.deepStrictEqual(nobody.r.asked, []);
});

check('an answer that is no posture is held as none, and the line says the report could not be read', async () => {
  for (const answer of [null, 'text', 0, true]) {
    const w = postureWorld();
    const run = w.posture.load();
    await w.r.answer('/api/workspace/posture', answer);
    await run;
    assert.strictEqual(w.state.posture, null);
    assert.deepStrictEqual(w.log.find(e => e[0] === 'boundary'), ['boundary', { state: 'unknown' }]);
  }
  const w = postureWorld();
  const run = w.posture.load();
  await w.r.answer('/api/workspace/posture', {});
  await run;
  assert.deepStrictEqual(w.log.find(e => e[0] === 'boundary'), ['boundary', undefined], 'a posture without a boundary is still checking');
});

check('a posture that could not be read is said on the rail and asked again', async () => {
  for (const [error, said] of [[offline, 'offline'], [new Error('500'), 'unreachable']]) {
    const w = postureWorld();
    const run = w.posture.load();
    await w.r.refuse('/api/workspace/posture', error);
    await run;
    assert.deepStrictEqual(w.log.filter(e => e[0] === 'boundary' || e[0] === 'pulse').map(e => e.slice(0, 2)), [['boundary', { state: said }], ['pulse', null]]);
    void w.posture.load();
    assert.strictEqual(w.r.asked.length, 2, 'a failure is not held for a minute');
  }
});

check('a posture reading overtaken, or for a reader gone, is dropped without drawing anything', async () => {
  for (const leave of ['newer', 'reader', 'epoch', 'cleared']) {
    for (const ending of ['answer', 'refuse']) {
      const w = postureWorld();
      const run = w.posture.load();
      if (leave === 'newer') void w.posture.load(true);
      if (leave === 'reader') w.state.me = { login: 'grace' };
      if (leave === 'epoch') w.state.uiEpoch += 1;
      if (leave === 'cleared') w.posture.clear();
      const before = w.log.length;
      const held = w.state.posture;
      if (ending === 'answer') await w.r.answer('/api/workspace/posture', { boundary: { state: 'online' } }); else await w.r.refuse('/api/workspace/posture', new Error('x'));
      await run;
      assert.strictEqual(w.log.length, before, `${leave}/${ending}`);
      assert.strictEqual(w.state.posture, held);
    }
  }
});

check('clearing lets every reading go and marks the posture for reading; invalidating marks both and the inbox', async () => {
  const w = postureWorld();
  const run = w.posture.load();
  await w.r.answer('/api/workspace/posture', { boundary: { state: 'online' } });
  await run;
  const sec = w.posture.loadSecurity();
  await w.r.answer('/api/workspace/security-posture', { available: true });
  await sec;
  w.log.length = 0;
  w.posture.clear();
  assert.deepStrictEqual(w.log, [['boundary', null], ['clearFindings'], ['clearPullBoard']]);
  assert.strictEqual(w.state.posture, null);
  assert.strictEqual(w.state.securityPosture, null);
  void w.posture.load();
  assert.strictEqual(w.r.asked.filter(p => p === '/api/workspace/posture').length, 2, 'read again after clearing');
  const v = postureWorld();
  const first = v.posture.load();
  await v.r.answer('/api/workspace/posture', {});
  await first;
  const s1 = v.posture.loadSecurity();
  await v.r.answer('/api/workspace/security-posture', { available: true });
  await s1;
  v.log.length = 0;
  v.posture.invalidate();
  assert.deepStrictEqual(v.log, [['invalidateFindings']]);
  void v.posture.load();
  void v.posture.loadSecurity();
  assert.deepStrictEqual(v.r.asked.slice(-2), ['/api/workspace/posture', '/api/workspace/security-posture'], 'both read again');
});

check('the security card is drawn while it is read, then from the summary, once a minute', async () => {
  const w = postureWorld({ repos: [{ full_name: 'a/b' }] });
  const run = w.posture.loadSecurity();
  assert.deepStrictEqual(w.r.asked, ['/api/workspace/security-posture']);
  const loading = w.log.find(e => e[0] === 'draw');
  assert.deepStrictEqual(loading.slice(1, 3), ['card', { state: 'loading' }]);
  assert.strictEqual(w.section.hidden, false);
  await w.r.answer('/api/workspace/security-posture', { available: false, reason: 'offline' });
  await run;
  assert.deepStrictEqual(w.state.securityPosture, { available: false, reason: 'offline' });
  assert.strictEqual(w.log.filter(e => e[0] === 'draw').at(-1)[2].state, 'unavailable');
  w.tick(POSTURE_TTL_MS - 1);
  const drawn = w.log.filter(e => e[0] === 'draw').length;
  await w.posture.loadSecurity();
  assert.strictEqual(w.r.asked.length, 1);
  assert.strictEqual(w.log.filter(e => e[0] === 'draw').length, drawn + 1, 'drawn again from what it holds');
  w.tick(1);
  void w.posture.loadSecurity();
  assert.strictEqual(w.r.asked.length, 2);
  assert.strictEqual(w.log.filter(e => e[0] === 'draw').length, drawn + 1, 'a summary already held is not drawn as loading');
});

check('a security summary that is no summary, or that failed, is said as unreadable or offline and asked again', async () => {
  for (const [how, value, expected] of [['answer', null, { available: false, reason: 'unreadable' }], ['answer', 'x', { available: false, reason: 'unreadable' }],
    ['refuse', offline, { available: false, reason: 'offline' }], ['refuse', new Error('500'), { available: false, reason: 'unreadable' }]]) {
    const w = postureWorld();
    const run = w.posture.loadSecurity();
    await w.r[how]('/api/workspace/security-posture', value);
    await run;
    assert.deepStrictEqual(w.state.securityPosture, expected);
    void w.posture.loadSecurity();
    assert.strictEqual(w.r.asked.length, how === 'refuse' ? 2 : 1, `${how} ${String(value)}`);
  }
});

check('a deployment that does not offer the security card hides it and asks nothing', async () => {
  const w = postureWorld({ offered: 'Unavailable' });
  await w.posture.loadSecurity();
  assert.deepStrictEqual(w.r.asked, []);
  assert.strictEqual(w.section.hidden, true);
  assert.ok(!w.log.some(e => e[0] === 'draw'));
  assert.strictEqual(w.posture.securityOffered(), false);
  w.offer('Supported');
  assert.strictEqual(w.posture.securityOffered(), true);
  w.posture.renderSecurity();
  assert.strictEqual(w.section.hidden, false);
  for (const missing of [{ section: null }, { host: null }]) {
    const m = postureWorld(missing);
    m.posture.renderSecurity();
    assert.ok(!m.log.some(e => e[0] === 'draw'));
  }
});

check('the security card\'s two presses open a repository\'s audit and the inbox, when there is one', async () => {
  const inbox = filters => filters;
  const w = postureWorld({ inbox });
  w.posture.renderSecurity();
  const [, , , actions] = w.log.find(e => e[0] === 'draw');
  assert.strictEqual(actions.inbox, inbox);
  actions.audit('octo', 'repo');
  assert.deepStrictEqual(w.log.at(-1), ['open', 'octo', 'repo', 'audit']);
  const none = postureWorld();
  none.posture.renderSecurity();
  assert.strictEqual(none.log.find(e => e[0] === 'draw')[3].inbox, null);
});

check('a security reading overtaken, or for a reader gone, is dropped', async () => {
  for (const leave of ['newer', 'reader', 'epoch', 'cleared']) {
    const w = postureWorld();
    const run = w.posture.loadSecurity();
    if (leave === 'newer') void w.posture.loadSecurity(true);
    if (leave === 'reader') w.state.me = { login: 'grace' };
    if (leave === 'epoch') w.state.uiEpoch += 1;
    if (leave === 'cleared') w.posture.clear();
    const before = w.log.filter(e => e[0] === 'draw').length;
    const held = w.state.securityPosture;
    await w.r.answer('/api/workspace/security-posture', { available: true, mark: 1 });
    await run;
    assert.strictEqual(w.log.filter(e => e[0] === 'draw').length, before, leave);
    assert.strictEqual(w.state.securityPosture, held, leave);
  }
  const nobody = postureWorld();
  nobody.state.me = null;
  await nobody.posture.loadSecurity();
  assert.deepStrictEqual(nobody.r.asked, []);
});

check('upload scanning is asked once; a refusal is an answer, a request that never arrived is asked again', async () => {
  const w = postureWorld();
  const run = w.posture.loadScanner();
  await w.posture.loadScanner();
  assert.deepStrictEqual(w.r.asked, ['/api/security/scanner-status'], 'asked once at a time');
  await w.r.answer('/api/security/scanner-status', { builtin: { available: true }, yara: { configured: false } });
  await run;
  assert.deepStrictEqual(w.state.scanner, { active: true, rulesConfigured: false });
  assert.deepStrictEqual(w.log.at(-1), ['pulse', null, { active: true, rulesConfigured: false }]);
  await w.posture.loadScanner();
  assert.strictEqual(w.r.asked.length, 1, 'and never again once answered');
  for (const [status, scanner] of [[{ yara: { configured: 1 } }, { active: true, rulesConfigured: true }], [{}, { active: false, rulesConfigured: false }],
    ['text', { active: false, rulesConfigured: false }], [{ builtin: 'x', yara: 3 }, { active: false, rulesConfigured: false }], [null, null], [undefined, null]]) {
    const v = postureWorld();
    const answered = v.posture.loadScanner();
    await v.r.answer('/api/security/scanner-status', status);
    await answered;
    assert.deepStrictEqual(v.state.scanner, scanner, JSON.stringify(status));
    await v.posture.loadScanner();
    assert.strictEqual(v.r.asked.length, 1);
  }
  const refused = postureWorld();
  const r1 = refused.posture.loadScanner();
  await refused.r.refuse('/api/security/scanner-status', Object.assign(new Error('Forbidden'), { status: 403 }));
  await r1;
  assert.strictEqual(refused.state.scanner, null);
  await refused.posture.loadScanner();
  assert.strictEqual(refused.r.asked.length, 1, 'a refusal is not asked again');
  const lost = postureWorld();
  const l1 = lost.posture.loadScanner();
  await lost.r.refuse('/api/security/scanner-status', offline);
  await l1;
  assert.strictEqual(lost.state.scanner, null);
  assert.deepStrictEqual(lost.log.at(-1), ['pulse', null, null]);
  const l2 = lost.posture.loadScanner();
  assert.strictEqual(lost.r.asked.length, 2, 'a request that never arrived is asked again');
  await lost.r.answer('/api/security/scanner-status', { builtin: { available: true } });
  await l2;
  assert.deepStrictEqual(lost.state.scanner, { active: true, rulesConfigured: false });
});

/* ---- The pull board ---------------------------------------------------------------------- */

const repo = (name, pushed) => ({ owner: { login: 'octo' }, name, full_name: `octo/${name}`, pushed_at: pushed || '2026-11-01T00:00:00Z' });

function boardWorld(over = {}) {
  const r = requests();
  const log = [];
  const state = { me: { login: 'ada' }, uiEpoch: 1, repos: over.repos || [repo('a'), repo('b')], prState: over.prState || 'open', pendingPull: undefined };
  let clock = 50_000;
  const section = { hidden: false };
  const watchers = [];
  const cache = new Map();
  let drawnList = over.listDrawn !== undefined ? over.listDrawn : true;
  const board = createPullBoard({
    state,
    api: path => { log.push(['api', path]); return r.api(path); },
    cached: (path, ttl) => { log.push(['cached', path, ttl]); return r.api(path); },
    keep: (path, value) => { cache.set(path, value); log.push(['keep', path]); },
    isOffline, now: () => clock,
    capability: name => { log.push(['capability', name]); return 'offered' in over ? over.offered : 'Supported'; },
    section: () => ('section' in over ? over.section : section),
    host: () => 'board',
    draw: (host, view, actions) => log.push(['draw', view, actions]),
    intersection: over.noObserver ? null : (seen, options) => { const w = { seen, options, observed: [] }; watchers.push(w); return { observe: target => w.observed.push(target) }; },
    chooseOpenList: () => log.push(['chooseOpenList']),
    openTool: (owner, name, tab) => { log.push(['open', owner, name, tab]); return Promise.resolve(true); },
    listDrawn: () => drawnList,
    loadPulls: () => log.push(['loadPulls'])
  });
  return { r, log, state, section, board, watchers, cache, tick: ms => { clock += ms; }, setDrawn: v => { drawnList = v; } };
}
const views = log => log.filter(e => e[0] === 'draw').map(e => e[1]);
async function answerAll(w, value = []) {
  while (w.r.pending.length) await w.r.answer(w.r.pending[0].path, value);
}

check('the board is read through the cache, drawn while it is read, and held for five minutes', async () => {
  const w = boardWorld();
  const run = w.board.load();
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'cached').map(e => e.slice(1)), [
    ['/api/repo/octo/a/pulls?state=open', PULL_BOARD_TTL_MS], ['/api/repo/octo/b/pulls?state=open', PULL_BOARD_TTL_MS]]);
  assert.strictEqual(views(w.log)[0].state, 'loading');
  await answerAll(w, [{ number: 1 }]);
  await run;
  assert.notStrictEqual(views(w.log).at(-1).state, 'loading');
  const asked = w.r.asked.length;
  w.tick(PULL_BOARD_TTL_MS - 1);
  await w.board.load();
  assert.strictEqual(w.r.asked.length, asked, 'held');
  w.tick(1);
  void w.board.load();
  assert.strictEqual(w.r.asked.length, asked + 2, 'read again after five minutes');
});

check('Refresh reads past the cache and keeps what it read there', async () => {
  const w = boardWorld();
  const first = w.board.load();
  await answerAll(w);
  await first;
  const [, , actions] = w.log.filter(e => e[0] === 'draw').at(-1);
  w.log.length = 0;
  actions.refresh();
  await flush();
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'api').map(e => e[1]), ['/api/repo/octo/a/pulls?state=open', '/api/repo/octo/b/pulls?state=open']);
  assert.ok(!w.log.some(e => e[0] === 'cached'));
  await answerAll(w, [{ number: 4 }]);
  await flush();
  assert.deepStrictEqual([...w.cache.keys()], ['/api/repo/octo/a/pulls?state=open', '/api/repo/octo/b/pulls?state=open']);
  assert.deepStrictEqual(w.cache.get('/api/repo/octo/a/pulls?state=open'), [{ number: 4 }]);
});

check('one reading at a time, unless forced; a newer reading or a new reader overtakes it', async () => {
  const w = boardWorld();
  const run = w.board.load();
  await w.board.load();
  assert.strictEqual(w.r.asked.length, 2, 'not doubled');
  const forced = w.board.load(true);
  assert.strictEqual(w.r.asked.length, 4, 'a forced reading goes ahead');
  const drawn = views(w.log).length;
  await w.r.answer('/api/repo/octo/a/pulls?state=open', [{ number: 9 }]);
  await w.r.answer('/api/repo/octo/b/pulls?state=open', [{ number: 9 }]);
  await run;
  assert.strictEqual(views(w.log).length, drawn, 'the overtaken reading draws nothing');
  await answerAll(w, []);
  await forced;
  assert.notStrictEqual(views(w.log).at(-1).state, 'loading');
  for (const leave of ['reader', 'epoch']) {
    const v = boardWorld();
    v.board.watch();
    v.watchers[0].seen([{ isIntersecting: true }]);
    const r1 = Promise.resolve();
    if (leave === 'reader') v.state.me = { login: 'grace' };
    else v.state.uiEpoch += 1;
    const before = views(v.log).length;
    await v.r.answer('/api/repo/octo/a/pulls?state=open', [{ number: 1 }]);
    await v.r.answer('/api/repo/octo/b/pulls?state=open', [{ number: 1 }]);
    await r1;
    const after = views(v.log).slice(before);
    assert.ok(after.length >= 1 && after.every(view => view.state === 'loading'), `${leave}: the answer is dropped and the card drawn as reading again`);
    assert.ok(v.r.asked.length > 2, `${leave}: and read again for whoever is here`);
  }
});

check('the board let go of drops its reading and reads again', async () => {
  const w = boardWorld();
  const run = w.board.load();
  w.board.clear();
  const before = views(w.log).length;
  await answerAll(w, [{ number: 1 }]);
  await run;
  assert.strictEqual(views(w.log).length, before, 'a reading let go of draws nothing');
  void w.board.load();
  assert.strictEqual(w.r.asked.length, 4, 'and the next reading is asked afresh');
  const read = boardWorld();
  const done = read.board.load();
  await answerAll(read, [{ number: 1, title: 'mine' }]);
  await done;
  read.board.clear();
  read.board.render();
  assert.strictEqual(views(read.log).at(-1).state, 'loading', 'a board let go of is never drawn again from what it read');
});

check('a read that never arrived is marked offline; nothing to read or nobody to read for asks nothing', async () => {
  const w = boardWorld({ repos: [repo('a')] });
  const run = w.board.load();
  const error = new Error('Failed to fetch');
  await w.r.refuse('/api/repo/octo/a/pulls?state=open', error);
  await run;
  assert.strictEqual(error.offline, true);
  assert.strictEqual(views(w.log).at(-1).state === 'loading', false);
  const empty = boardWorld({ repos: [] });
  await empty.board.load();
  assert.deepStrictEqual(empty.r.asked, []);
  assert.strictEqual(views(empty.log).length, 1, 'drawn with nothing to read');
  const nobody = boardWorld();
  nobody.state.me = null;
  await nobody.board.load();
  assert.deepStrictEqual(nobody.r.asked, []);
  const unoffered = boardWorld({ offered: 'Unavailable' });
  await unoffered.board.load();
  assert.deepStrictEqual(unoffered.r.asked, []);
  assert.strictEqual(unoffered.section.hidden, true);
  assert.strictEqual(views(unoffered.log).length, 0);
});

check('the board is watched once, from 200px away, and read when it comes into view', async () => {
  const w = boardWorld();
  w.board.watch();
  w.board.watch();
  assert.strictEqual(w.watchers.length, 1, 'watched once');
  assert.deepStrictEqual(w.watchers[0].options, { rootMargin: WATCH_MARGIN });
  assert.strictEqual(WATCH_MARGIN, '200px 0px');
  assert.deepStrictEqual(w.watchers[0].observed, [w.section]);
  assert.strictEqual(w.board.visible(), false);
  w.watchers[0].seen([{ isIntersecting: false }]);
  assert.deepStrictEqual(w.r.asked, []);
  w.watchers[0].seen([{ isIntersecting: false }, { isIntersecting: true }]);
  assert.strictEqual(w.board.visible(), true);
  assert.strictEqual(w.r.asked.length, 2);
  w.watchers[0].seen([{ isIntersecting: false }]);
  assert.strictEqual(w.board.visible(), false, 'out of sight again');
  const late = boardWorld({ repos: [] });
  late.board.watch();
  late.watchers[0].seen([{ isIntersecting: true }]);
  late.watchers[0].seen([{ isIntersecting: false }]);
  late.state.repos = [repo('late')];
  late.board.render();
  assert.deepStrictEqual(late.r.asked, [], 'an inventory arriving once the card is out of sight waits for it');
  const blind = boardWorld({ noObserver: true });
  blind.board.watch();
  assert.strictEqual(blind.board.visible(), true, 'where nothing can tell, the card counts as seen');
  const none = boardWorld({ section: null });
  none.board.watch();
  assert.strictEqual(none.watchers.length, 0);
});

check('an inventory arriving after the card came into view is read then, and only once', async () => {
  const w = boardWorld({ repos: [] });
  w.board.watch();
  w.watchers[0].seen([{ isIntersecting: true }]);
  assert.deepStrictEqual(w.r.asked, []);
  w.state.repos = [repo('late')];
  w.board.render();
  assert.deepStrictEqual(w.r.asked, ['/api/repo/octo/late/pulls?state=open']);
  w.board.render();
  assert.strictEqual(w.r.asked.length, 1, 'not again while it is read');
  const hidden = boardWorld();
  hidden.board.render();
  assert.deepStrictEqual(hidden.r.asked, [], 'not read before it is in view');
});

check('a card opens its pull request on the open list, reading it when the list is already drawn', async () => {
  for (const [prState, drawn] of [['closed', true], ['open', true], ['open', false]]) {
    const w = boardWorld({ prState, listDrawn: drawn });
    w.board.render();
    const [, , actions] = w.log.find(e => e[0] === 'draw');
    w.log.length = 0;
    actions.open('Octo', 'Repo', '12');
    await flush();
    assert.deepStrictEqual(w.state.pendingPull, { key: 'octo/repo', number: 12 });
    assert.strictEqual(w.state.prState, 'open');
    assert.deepStrictEqual(w.log, [
      ...(prState === 'open' ? [] : [['chooseOpenList']]), ['open', 'Octo', 'Repo', 'pulls'], ...(drawn ? [['loadPulls']] : [])
    ], `${prState} ${drawn}`);
  }
  const w = boardWorld();
  w.board.render();
  const [, , actions] = w.log.find(e => e[0] === 'draw');
  actions.open('a', 'b', 1);
  w.state.pendingPull = undefined;
  await flush();
  assert.ok(!w.log.some(e => e[0] === 'loadPulls'), 'a pull request no longer waited for is not read');
});

check('a repository\'s owner and name are escaped in the address the board asks', async () => {
  const w = boardWorld({ repos: [{ owner: { login: 'o w' }, name: 'r#1', full_name: 'o w/r#1', pushed_at: '2026-11-01T00:00:00Z' }] });
  void w.board.load();
  assert.deepStrictEqual(w.r.asked, ['/api/repo/o%20w/r%231/pulls?state=open']);
});

check('the board model reads at most a dozen repositories', async () => {
  const many = Array.from({ length: 20 }, (_, i) => repo(`r${i}`, `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  const w = boardWorld({ repos: many });
  void w.board.load();
  assert.strictEqual(new Set(w.r.asked).size, Math.min(REPOSITORY_LIMIT, 4), 'four at a time');
  await answerAll(w);
  assert.strictEqual(w.r.asked.length, REPOSITORY_LIMIT);
  assert.ok(w.r.asked.includes('/api/repo/octo/r19/pulls?state=open') && !w.r.asked.includes('/api/repo/octo/r0/pulls?state=open'), 'the most recently pushed');
});

/* ---- What the cards are handed --------------------------------------------------------- */

check('what the cards are handed of the page\'s state is read and never changed', async () => {
  const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); } return value; };
  const repos = deepFreeze([repo('a'), repo('b')]);
  const summary = deepFreeze({ available: true, generatedAt: '2026-11-20T00:00:00Z', repositories: [{ owner: 'octo', repo: 'a', open: { critical: 1, high: 0, medium: 0, low: 0, total: 1 } }], open: { critical: 1, high: 0, medium: 0, low: 0, total: 1 } });
  const w = postureWorld({ repos });
  w.state.securityPosture = summary;
  assert.doesNotThrow(() => w.posture.renderSecurity());
  const b = boardWorld({ repos });
  b.board.watch();
  b.watchers[0].seen([{ isIntersecting: true }]);
  await answerAll(b, deepFreeze([{ number: 1, title: 't', user: { login: 'u' }, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', labels: [] }]));
  await flush();
  assert.ok(views(b.log).at(-1).state !== 'loading');
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
  console.log(`page overview: ${checks.length} checks passed`);
})();
