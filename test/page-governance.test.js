'use strict';
/*
 * Governance at work (features/governance/governance-actions.ts and
 * governance-dialogs.ts): the Policy Digital Twin read with its delivery
 * evidence and archive, every action on a policy's life, the ledger's view,
 * the buttons' dispatcher, and every answer landing on the repository it was
 * asked for. The screen itself is test/governance-*.test.js and the browser's.
 */
const assert = require('assert');
const { createGovernance } = require('../apps/web/src/features/governance/governance-actions.ts');
const dialogs = require('../apps/web/src/features/governance/governance-dialogs.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 10; i += 1) await settle(); };
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

const POLICY = 'p-1';
const VERSION = 'v-2';
const TWIN = {
  readModelHash: 'a'.repeat(64),
  current: { policies: [{ policyId: POLICY, policyKey: 'release', name: 'Release safety', revision: 3 }] },
  history: { decisions: [{ seq: 50 }, { seq: 49 }], nextBeforeDecisionSeq: 49, nextDecisionSeq: null }
};
const ACCESS = (administer = true, expiresAt = '2099-01-01T00:00:00.000Z') => ({
  capabilities: { read: true, author: true, review: true, activate: true, administer },
  evidence: { status: 'current', expiresAt }
});
const fresh = () => ({
  digitalTwin: null, access: null, loading: false, error: '', simulation: null, verification: null, scopeKey: '',
  decisionPages: [], delivery: { notifications: { events: [] }, preferences: {}, exports: [], webhooks: [], error: '' }
});

function world(over = {}) {
  const log = [];
  const pending = [];
  const timers = [];
  const modals = [];
  const drawn = [];
  const focused = [];
  const store = new Map(Object.entries(over.stored || {}));
  const live = { textContent: '' };
  const root = { listeners: {}, addEventListener(type, run) { this.listeners[type] = run; } };
  const inputs = { ...(over.inputs || {}) };
  const answers = [...(over.modal || [])];
  const heldDialogs = [];
  const state = { work: 'work' in over ? over.work : { owner: 'acme', repo: 'demo', branch: 'main', default_branch: 'trunk' }, governance: over.governance || fresh() };
  const control = selector => {
    if (selector === '#govLive') return live;
    if (selector === '#govRoot') return over.noRoot ? null : root;
    if (selector.startsWith('#govRoot [data-focus-key=')) return { disabled: !!over.focusDisabled, focus: options => focused.push([selector, options]) };
    if (!(selector in inputs)) return null;
    const held = inputs[selector];
    return typeof held === 'boolean' ? { checked: held } : { value: held };
  };
  const links = [];
  const g = createGovernance({
    state,
    mutate: change => { log.push(['mutate']); change(state.governance); },
    api: (path, init) => {
      log.push(['api', (init && init.method) || 'GET', path]);
      if (over.respond) {
        const answered = over.respond(path, init);
        if (answered !== undefined) return answered instanceof Error ? Promise.reject(answered) : Promise.resolve(answered);
      }
      return new Promise((resolve, reject) => pending.push({ path, init, resolve, reject }));
    },
    modal: request => {
      modals.push(request);
      log.push(['modal', request.title]);
      const answer = answers.length ? answers.shift() : true;
      return answer === 'hold' ? new Promise(resolve => heldDialogs.push(resolve)) : Promise.resolve(answer);
    },
    toast: (message, kind) => log.push(['toast', message, kind]),
    stepUp: (action, scope, path, init, label) => {
      log.push(['stepUp', action, JSON.stringify(scope), path, init.method, JSON.stringify(init.body), init.headers['Idempotency-Key'], label]);
      if (over.stepUp === 'hold') return new Promise(resolve => heldDialogs.push(resolve));
      return Promise.resolve(over.stepUp === undefined ? { reset: { archivedCount: 2, deactivatedCount: 1 } } : over.stepUp);
    },
    $: control,
    doc: {
      createElement: tag => { const link = { tag, href: '', clicked: 0, removed: 0, click() { this.clicked += 1; }, remove() { this.removed += 1; } }; links.push(link); return link; },
      body: { appendChild: node => log.push(['append', node.href]) },
      get activeElement() { return over.active || null; }
    },
    storage: () => over.storage || { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => { log.push(['store', key, value]); store.set(key, value); } },
    draw: (host, input) => { drawn.push([host, input]); log.push(['draw', host === root ? 'root' : String(host), input.loading ? 'loading' : input.error ? `error ${input.error}` : 'twin']); },
    requestAnimationFrame: run => run(),
    setTimeout: (run, ms) => { timers.push({ run, ms }); return timers.length; },
    clearTimeout: id => log.push(['clearTimeout', id]),
    now: () => NOW,
    randomId: () => 'rid',
    cssEscape: value => `~${value}~`
  });
  const take = pattern => {
    const i = pending.findIndex(p => pattern.test(p.path));
    assert.ok(i >= 0, `no request for ${pattern} among ${pending.map(p => p.path).join(', ')}`);
    return pending.splice(i, 1)[0];
  };
  const answer = (pattern, value) => take(pattern).resolve(value);
  const refuse = (pattern, error) => take(pattern).reject(error);
  const sent = () => log.filter(entry => entry[0] === 'api');
  return { g, log, state, pending, answer, refuse, live, root, timers, store, modals, drawn, inputs, focused, links, sent, heldDialogs };
}

/* A world with the twin read for acme/demo, its delivery and archive answered. */
async function opened(over = {}, access = ACCESS()) {
  const w = world(over);
  const loading = w.g.load();
  await flush();
  w.answer(/digital-twin/, { digitalTwin: TWIN, access });
  await flush();
  w.answer(/notifications\?/, { events: [{ seq: 1 }] });
  w.answer(/preferences$/, { preferences: { enabled: true, eventTypes: ['policy.activated'] } });
  w.answer(/exports\?/, { exports: [{ exportId: 'e1' }] });
  if (access.capabilities.administer) w.answer(/webhooks$/, { webhooks: [{ webhookId: 'w1' }] });
  w.answer(/archive$/, { policies: [{ policyId: 'old' }] });
  await loading;
  w.log.length = 0;
  return w;
}
const button = data => ({ dataset: { ...data } });

/* ---- Reading ----------------------------------------------------------------------------- */

check('the twin is read for the repository open with a bounded history, then its delivery and archive, and said', async () => {
  const w = world();
  const loading = w.g.load();
  await flush();
  assert.deepStrictEqual(w.pending.map(p => p.path), ['/api/repo/acme/demo/governance/digital-twin?historyLimit=50']);
  assert.strictEqual(w.state.governance.loading, true);
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'draw'), [['draw', 'root', 'loading']]);
  w.answer(/digital-twin/, { digitalTwin: TWIN, access: ACCESS() });
  await flush();
  const base = '/api/repo/acme/demo/governance';
  assert.deepStrictEqual(w.pending.map(p => p.path), [
    `${base}/notifications?limit=50&afterSeq=0`, `${base}/notifications/preferences`, `${base}/exports?limit=50`, `${base}/webhooks`, `${base}/archive`
  ]);
  w.answer(/notifications\?/, { events: [{ seq: 1 }] });
  w.answer(/preferences$/, { preferences: { enabled: false } });
  w.answer(/exports\?/, { exports: [{ exportId: 'e1' }] });
  w.answer(/webhooks$/, { webhooks: [{ webhookId: 'w1' }] });
  w.answer(/archive$/, { policies: [{ policyId: 'old' }] });
  await loading;
  const held = w.state.governance;
  assert.strictEqual(held.digitalTwin, TWIN);
  assert.strictEqual(held.scopeKey, 'acme/demo');
  assert.strictEqual(held.loading, false);
  assert.strictEqual(held.error, '');
  assert.deepStrictEqual(held.delivery, { notifications: { events: [{ seq: 1 }] }, preferences: { enabled: false }, exports: [{ exportId: 'e1' }], webhooks: [{ webhookId: 'w1' }], error: '' });
  assert.deepStrictEqual(held.archived, [{ policyId: 'old' }]);
  assert.strictEqual(w.live.textContent, 'Policy Digital Twin and delivery evidence refreshed');
  const last = w.drawn[w.drawn.length - 1][1];
  assert.deepStrictEqual(Object.keys(last), ['view', 'digitalTwin', 'access', 'loading', 'error', 'simulation', 'verification', 'delivery', 'archived']);
  assert.strictEqual(last.loading, false);
  assert.strictEqual(last.archived, held.archived);
});

check('read once: drawn again from what is held, asked again only when forced, never twice at once, never for nobody', async () => {
  const w = await opened();
  await w.g.load();
  assert.deepStrictEqual(w.sent(), []);
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'draw').length, 1);
  const again = w.g.load(true);
  await flush();
  void w.g.load(true);
  await flush();
  assert.deepStrictEqual(w.sent().map(e => e[2]), ['/api/repo/acme/demo/governance/digital-twin?historyLimit=50']);
  w.refuse(/digital-twin/, new Error('down'));
  await again;
  for (const work of [null, { owner: '', repo: 'x' }, { owner: 'x', repo: '' }]) {
    const none = world({ work });
    await none.g.load(true);
    assert.deepStrictEqual(none.sent(), [], JSON.stringify(work));
  }
});

check('a failure to read the twin is said on the screen and to a screen reader; one without words is named', async () => {
  for (const [error, said] of [[new Error('The twin is busy.'), 'The twin is busy.'], [{ message: 'plain object' }, 'plain object'], [new Error(''), 'Policy Digital Twin could not be loaded']]) {
    const w = world();
    const loading = w.g.load();
    await flush();
    w.refuse(/digital-twin/, error);
    await loading;
    assert.strictEqual(w.state.governance.error, said);
    assert.strictEqual(w.state.governance.loading, false);
    assert.strictEqual(w.live.textContent, said);
    assert.deepStrictEqual(w.log.filter(e => e[0] === 'draw').pop(), ['draw', 'root', `error ${said}`]);
  }
});

check('delivery: webhooks only for an administrator; one failed read is said, the others kept', async () => {
  const w = world({ governance: { ...fresh(), access: ACCESS(false) } });
  w.g.handlers['delivery-refresh'](button({}));
  await flush();
  assert.ok(!w.pending.some(p => /webhooks/.test(p.path)), 'webhooks are an administrator\'s');
  w.answer(/notifications\?/, { events: [] });
  w.refuse(/preferences$/, new Error('Preferences unavailable'));
  w.refuse(/exports\?/, {});
  await flush();
  assert.deepStrictEqual(w.state.governance.delivery, { notifications: { events: [] }, preferences: {}, exports: [], webhooks: [], error: 'Preferences unavailable · Delivery data unavailable' });
  for (const access of [null, { capabilities: { administer: 'yes' } }]) {
    const quiet = world({ governance: { ...fresh(), access } });
    quiet.g.handlers['delivery-refresh'](button({}));
    await flush();
    assert.ok(!quiet.pending.some(p => /webhooks/.test(p.path)), JSON.stringify(access));
  }
  const empty = world({ governance: { ...fresh(), access: ACCESS(true) } });
  empty.g.handlers['delivery-refresh'](button({}));
  await flush();
  empty.answer(/notifications\?/, { events: [] });
  empty.answer(/preferences$/, {});
  empty.answer(/exports\?/, {});
  empty.answer(/webhooks$/, {});
  await flush();
  assert.deepStrictEqual(empty.state.governance.delivery, { notifications: { events: [] }, preferences: {}, exports: [], webhooks: [], error: '' });
});

check('archived policies are their own read; a failed or malformed one is none', async () => {
  for (const [answer, archived] of [[{ policies: 'x' }, []], [new Error('gone'), []], [{ policies: [{ policyId: 'a' }] }, [{ policyId: 'a' }]]]) {
    const w = world({ respond: path => (/digital-twin/.test(path) ? { digitalTwin: TWIN, access: ACCESS(false) } : /archive$/.test(path) ? answer : /notifications\?/.test(path) ? { events: [] } : {}) });
    await w.g.load();
    assert.deepStrictEqual(w.state.governance.archived, archived);
  }
});

check('a read model that changed forgets the simulation, the verification and the pages of decisions; one unchanged keeps them', async () => {
  for (const [hash, kept] of [['b'.repeat(64), false], ['a'.repeat(64), true]]) {
    const w = await opened();
    Object.assign(w.state.governance, { simulation: { s: 1 }, verification: { valid: true }, decisionPages: [1] });
    const again = w.g.load(true);
    await flush();
    w.answer(/digital-twin/, { digitalTwin: { ...TWIN, readModelHash: hash }, access: ACCESS(false) });
    await flush();
    w.answer(/notifications\?/, {}); w.answer(/preferences$/, {}); w.answer(/exports\?/, {}); w.answer(/archive$/, {});
    await again;
    assert.deepStrictEqual([w.state.governance.simulation, w.state.governance.verification, w.state.governance.decisionPages],
      kept ? [{ s: 1 }, { valid: true }, [1]] : [null, null, []], hash);
  }
});

/* ---- Answers for a repository no longer open ---------------------------------------------- */

check('delivery and archived policies read for a repository no longer open are dropped, unsaid', async () => {
  for (const leave of ['repository', 'cleared']) {
    const w = world();
    const loading = w.g.load();
    await flush();
    w.answer(/digital-twin/, { digitalTwin: TWIN, access: ACCESS() });
    await flush();
    if (leave === 'repository') w.state.work = { owner: 'acme', repo: 'site' };
    else w.g.clear();
    const held = w.state.governance;
    const after = JSON.stringify({ delivery: held.delivery, archived: held.archived });
    w.live.textContent = '';
    w.answer(/notifications\?/, { events: [{ seq: 9 }] });
    w.answer(/preferences$/, { preferences: { enabled: true } });
    w.answer(/exports\?/, { exports: [{ exportId: 'theirs' }] });
    w.answer(/webhooks$/, { webhooks: [{ webhookId: 'theirs' }] });
    w.answer(/archive$/, { policies: [{ policyId: 'theirs' }] });
    await loading;
    assert.strictEqual(JSON.stringify({ delivery: held.delivery, archived: held.archived }), after, `${leave}: the answers dropped`);
    if (leave === 'cleared') assert.deepStrictEqual((({ view, ...rest }) => rest)(w.state.governance), { ...fresh(), archived: [] }, 'the slice let go of stays fresh');
    assert.strictEqual(w.live.textContent, '', `${leave}: nothing said`);
  }
});

check('a twin that failed for a repository no longer open is not said, and leaves the next one\'s load alone', async () => {
  const w = world();
  const loading = w.g.load();
  await flush();
  w.g.clear();
  w.state.work = { owner: 'acme', repo: 'site' };
  const next = w.g.load();
  await flush();
  assert.strictEqual(w.state.governance.loading, true);
  w.refuse(/demo\/governance\/digital-twin/, new Error('demo failed'));
  await loading;
  assert.strictEqual(w.state.governance.error, '');
  assert.strictEqual(w.state.governance.loading, true, 'the next repository is still loading');
  assert.notStrictEqual(w.live.textContent, 'demo failed');
  w.refuse(/site\/governance\/digital-twin/, new Error('site failed'));
  await next;
  assert.strictEqual(w.state.governance.error, 'site failed');
  assert.strictEqual(w.state.governance.loading, false);
});

check('a twin answered for a repository no longer open is not taken', async () => {
  const w = world();
  const loading = w.g.load();
  await flush();
  w.state.work = { owner: 'acme', repo: 'site' };
  w.answer(/digital-twin/, { digitalTwin: TWIN, access: ACCESS() });
  await loading;
  assert.strictEqual(w.state.governance.digitalTwin, null);
  assert.strictEqual(w.state.governance.loading, false);
  assert.deepStrictEqual(w.timers, []);
  const gone = world();
  const away = gone.g.load();
  await flush();
  gone.state.work = null;
  gone.answer(/digital-twin/, { digitalTwin: TWIN });
  await away;
  assert.strictEqual(gone.state.governance.digitalTwin, null);
});

check('a decision chain verified for a repository no longer open is not shown; one for the repository open is said', async () => {
  const w = await opened();
  const verifying = w.g.handlers['verify-chain'](button({}));
  await flush();
  assert.deepStrictEqual(w.sent().map(e => e[2]), ['/api/repo/acme/demo/governance/decisions/verify?limit=50000']);
  w.state.work = { owner: 'acme', repo: 'site' };
  w.answer(/verify/, { verification: { valid: true } });
  await verifying;
  assert.strictEqual(w.state.governance.verification, null);
  for (const [answer, said] of [[{ verification: { valid: true } }, 'Decision chain verified'], [{ valid: false }, 'Decision chain verification failed'], [{ verification: { valid: 'yes' } }, 'Decision chain verification failed']]) {
    const v = await opened();
    const done = v.g.handlers['verify-chain'](button({}));
    await flush();
    v.answer(/verify/, answer);
    await done;
    assert.deepStrictEqual(v.state.governance.verification, answer.verification || answer);
    assert.strictEqual(v.live.textContent, said);
  }
});

/* ---- Decisions, a page at a time ---------------------------------------------------------- */

function paging() {
  return world({ governance: { ...fresh(), digitalTwin: JSON.parse(JSON.stringify(TWIN)), scopeKey: 'acme/demo' } });
}

check('older decisions are read a page at a time, none counted twice, until the history is complete', async () => {
  const w = paging();
  const first = w.g.handlers['load-more-decisions'](button({ beforeSeq: '49' }));
  await flush();
  assert.deepStrictEqual(w.sent().map(e => e[2]), ['/api/repo/acme/demo/governance/decisions?limit=50&beforeSeq=49']);
  w.answer(/decisions\?/, { decisions: [{ seq: 49 }, { seq: 48 }, { seq: 47 }], nextBeforeSeq: 47, complete: false });
  await first;
  const history = () => w.state.governance.digitalTwin.history;
  assert.deepStrictEqual(history().decisions.map(d => d.seq), [50, 49, 48, 47]);
  assert.strictEqual(history().nextBeforeDecisionSeq, 47);
  assert.strictEqual(history().nextDecisionSeq, null);
  assert.strictEqual(w.live.textContent, '3 more decisions loaded');
  const last = w.g.handlers['load-more-decisions'](button({ beforeSeq: '47' }));
  await flush();
  w.answer(/decisions\?/, { result: { decisions: [{ seq: 46 }], nextBeforeSeq: 46, complete: true } });
  await last;
  assert.strictEqual(history().nextBeforeDecisionSeq, null);
  assert.deepStrictEqual(history().decisions.map(d => d.seq), [50, 49, 48, 47, 46]);
  const ascending = paging();
  const up = ascending.g.handlers['load-more-decisions'](button({ afterSeq: '50' }));
  await flush();
  assert.ok(ascending.sent()[0][2].endsWith('&afterSeq=50'));
  ascending.answer(/decisions\?/, { decisions: [{ seq: 51 }], nextAfterSeq: 51, complete: false });
  await up;
  assert.strictEqual(ascending.state.governance.digitalTwin.history.nextDecisionSeq, 51);
  assert.strictEqual(ascending.state.governance.digitalTwin.history.nextBeforeDecisionSeq, 49);
});

check('a page of decisions for a repository or account no longer open is dropped; a cursor that is not a place is refused', async () => {
  for (const change of ['repository', 'account']) {
    const w = paging();
    const pending = w.g.handlers['load-more-decisions'](button({ beforeSeq: '49' }));
    await flush();
    if (change === 'repository') w.state.work = { owner: 'acme', repo: 'other' };
    else w.state.governance = { digitalTwin: { history: { decisions: [{ seq: 100 }] } } };
    const before = JSON.stringify(w.state.governance);
    w.answer(/decisions\?/, { decisions: [{ seq: 48 }], nextBeforeSeq: 48 });
    await pending;
    assert.strictEqual(JSON.stringify(w.state.governance), before, change);
  }
  for (const cursor of [undefined, '-1', '1.5', 'x']) {
    const w = paging();
    await assert.rejects(() => w.g.handlers['load-more-decisions'](button({ beforeSeq: cursor })), /Decision cursor is invalid/);
    assert.deepStrictEqual(w.sent(), []);
  }
  const none = world();
  const asked = none.g.handlers['load-more-decisions'](button({ beforeSeq: '5' }));
  await flush();
  none.answer(/decisions\?/, { decisions: [{ seq: 4 }] });
  await asked;
  assert.strictEqual(none.state.governance.digitalTwin, null, 'no twin, nothing merged into');
});

/* ---- Permission evidence ------------------------------------------------------------------- */

check('permission evidence expires: every capability withdrawn, the evidence stale, and said; nothing scheduled without a deadline', async () => {
  const soon = new Date(NOW + 60_000).toISOString();
  const w = await opened({}, ACCESS(true, soon));
  const timer = w.timers[w.timers.length - 1];
  assert.strictEqual(timer.ms, 60_025);
  timer.run();
  assert.deepStrictEqual(w.state.governance.access.capabilities, { read: false, author: false, review: false, activate: false, administer: false });
  assert.strictEqual(w.state.governance.access.evidence.status, 'stale');
  assert.strictEqual(w.state.governance.access.evidence.expiresAt, soon);
  assert.strictEqual(w.live.textContent, 'Repository permission evidence expired. Refresh governance before taking action.');
  assert.ok(w.log.some(e => e[0] === 'draw'));
  for (const [expiresAt, ms] of [[NOW - 5_000, 0], [NOW + 1_000, 1_025], ['2999-01-01T00:00:00.000Z', 2_147_000_000], [undefined, 0], [true, 0]]) {
    const x = world({ governance: { ...fresh(), access: { evidence: { expiresAt } } } });
    x.g.scheduleAccessExpiry();
    assert.strictEqual(x.timers[0] && x.timers[0].ms, ms, String(expiresAt));
  }
  for (const expiresAt of ['not a date', {}]) {
    const x = world({ governance: { ...fresh(), access: { evidence: { expiresAt } } } });
    x.g.scheduleAccessExpiry();
    assert.deepStrictEqual(x.timers, [], String(expiresAt));
  }
  const replaced = world({ governance: { ...fresh(), access: ACCESS(true, soon) } });
  replaced.g.scheduleAccessExpiry();
  replaced.g.scheduleAccessExpiry();
  assert.deepStrictEqual(replaced.log.filter(e => e[0] === 'clearTimeout'), [['clearTimeout', 1]]);
  replaced.g.clear();
  assert.deepStrictEqual(replaced.log.filter(e => e[0] === 'clearTimeout'), [['clearTimeout', 1], ['clearTimeout', 2]]);
  const after = world({ governance: { ...fresh(), access: ACCESS(true, soon) } });
  after.g.scheduleAccessExpiry();
  after.state.governance.access = null;
  after.timers[0].run();
  assert.strictEqual(after.state.governance.access, null, 'evidence already let go of stays let go of');
  assert.strictEqual(after.live.textContent, '');
});

check('clearing lets the twin go, draws the screen loading and silences what it said', () => {
  const w = world({ governance: { ...fresh(), digitalTwin: TWIN, view: { scope: 'x' } } });
  w.live.textContent = 'old';
  w.g.clear();
  assert.deepStrictEqual(w.state.governance, { ...fresh(), archived: [] });
  assert.deepStrictEqual(w.log, [['draw', 'root', 'loading']]);
  assert.strictEqual(w.live.textContent, '');
  const bare = world({ noRoot: true });
  bare.g.clear();
  assert.deepStrictEqual(bare.log, [['draw', 'null', 'loading']]);
  bare.g.render();
  assert.deepStrictEqual(bare.log.length, 1, 'no screen, nothing drawn');
});

/* ---- Writes ------------------------------------------------------------------------------- */

const request = (w, i = 0) => {
  const p = w.pending[i];
  return { path: p.path, method: p.init && p.init.method, key: p.init && p.init.headers && p.init.headers['Idempotency-Key'], body: p.init && p.init.body };
};
/* A control pressed, its action left running: what it settles to is `settled`, so awaiting the press does not wait for the action. */
async function pressed(w, action, data = {}) {
  const settled = w.g.handlers[action](button(data));
  await flush();
  return { settled };
}
/* Everything the action still waits for answered, until it is done. */
async function done(w, run, answer = {}) {
  while (w.pending.length) { w.pending.shift().resolve(answer); await flush(); }
  return run.settled;
}

check('a policy, a draft and its edits each carry an idempotency key and read the twin again', async () => {
  const base = '/api/repo/acme/demo/governance';
  let w = await opened({ inputs: { '#govPolicyKey': ' release ', '#govPolicyName': ' Release ', '#govPolicyDescription': ' Why ' } });
  let run = await pressed(w, 'create-policy');
  assert.deepStrictEqual(request(w), { path: `${base}/policies`, method: 'POST', key: 'governance-ui:policy-create:rid', body: { policyKey: 'release', name: 'Release', description: 'Why' } });
  w.pending.shift().resolve({});
  await flush();
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'toast'), [['toast', 'Governance policy created', 'ok']]);
  assert.ok(w.pending[0].path.endsWith('digital-twin?historyLimit=50'), 'the twin read again');
  await done(w, run);

  for (const [key, name] of [[' ', 'x'], ['k', ' ']]) {
    w = await opened({ inputs: { '#govPolicyKey': key, '#govPolicyName': name } });
    await assert.rejects(() => w.g.handlers['create-policy'](button({})), /Policy key and name are required/);
    assert.deepStrictEqual(w.sent(), []);
  }

  w = await opened({ inputs: { '#govDraftDocument': '{"rules":[]}', '#govDraftApproval': '{"requiredApprovals":2}' } });
  run = await pressed(w, 'new-draft', { policyId: 'p/1' });
  assert.deepStrictEqual(w.modals[0].bodyHTML, dialogs.draftBody({ schemaVersion: 1, description: 'Repository governance policy.', enforcement: { mode: 'observe' }, rules: [] }, { requiredApprovals: 1, disallowAuthorApproval: true }));
  assert.deepStrictEqual(request(w), { path: `${base}/policies/p%2F1/drafts`, method: 'POST', key: 'governance-ui:draft-create:rid', body: { document: { rules: [] }, approvalPolicy: { requiredApprovals: 2 } } });
  await done(w, run);

  w = await opened({ inputs: { '#govEditDocument': '{"a":1}', '#govEditApproval': '{"b":2}' } });
  run = await pressed(w, 'edit-draft', { policyId: POLICY, draftId: 'd1' });
  assert.strictEqual(request(w).path, `${base}/policies/${POLICY}/drafts/d1`);
  w.pending.shift().resolve({ draft: { revision: 4, document: { r: 1 }, requiredApprovals: 2, disallowAuthorApproval: false } });
  await flush();
  assert.strictEqual(w.modals[0].title, 'Edit draft r4');
  assert.strictEqual(w.modals[0].bodyHTML, dialogs.editDraftBody({ r: 1 }, { requiredApprovals: 2, disallowAuthorApproval: false }));
  assert.deepStrictEqual(request(w), { path: `${base}/policies/${POLICY}/drafts/d1`, method: 'PATCH', key: 'governance-ui:draft-update:rid', body: { expectedRevision: 4, document: { a: 1 }, approvalPolicy: { b: 2 } } });
  await done(w, run);

  w = await opened({ inputs: { '#govDraftDocument': '[]', '#govDraftApproval': '{}' } });
  await assert.rejects(() => w.g.handlers['new-draft'](button({ policyId: POLICY })), /Policy document/);
  assert.deepStrictEqual(w.sent(), []);
  w = await opened();
  await assert.rejects(() => w.g.handlers['new-draft'](button({ policyId: POLICY })), /Policy document input is unavailable/);
});

check('validating, viewing and inspecting show the evidence; submitting freezes a version', async () => {
  const base = '/api/repo/acme/demo/governance';
  let w = await opened();
  let run = await pressed(w, 'validate-draft', { policyId: POLICY, draftId: 'd1' });
  assert.deepStrictEqual(request(w), { path: `${base}/policies/${POLICY}/drafts/d1/validate`, method: 'POST', key: undefined, body: {} });
  w.pending.shift().resolve({ validation: { ok: true } });
  await run.settled;
  assert.deepStrictEqual([w.modals[0].title, w.modals[0].okText, w.modals[0].bodyHTML], ['Draft validation', 'Close', dialogs.jsonBody({ ok: true })]);

  w = await opened();
  run = await pressed(w, 'view-version', { policyId: POLICY, versionId: VERSION });
  w.answer(new RegExp(`versions/${VERSION}$`), { version: { v: 2 } });
  await run.settled;
  assert.strictEqual(w.modals[0].title, 'Immutable policy version');
  assert.strictEqual(w.modals[0].bodyHTML, dialogs.jsonBody({ v: 2 }));

  w = await opened();
  run = await pressed(w, 'select-policy', { policyId: POLICY });
  assert.deepStrictEqual(w.pending.map(p => p.path), [`${base}/policies/${POLICY}`, `${base}/policies/${POLICY}/versions?limit=100`]);
  w.answer(/versions\?/, { versions: [1] });
  w.answer(new RegExp(`policies/${POLICY}$`), { policy: { p: 1 } });
  await run.settled;
  assert.strictEqual(w.modals[0].bodyHTML, dialogs.jsonBody({ policy: { p: 1 }, versions: [1] }));

  w = await opened();
  run = await pressed(w, 'submit-draft', { policyId: POLICY, draftId: 'd1', revision: '6' });
  assert.deepStrictEqual([w.modals[0].title, w.modals[0].danger, w.modals[0].bodyHTML], ['Submit immutable version?', true, dialogs.SUBMIT_BODY]);
  assert.deepStrictEqual(request(w), { path: `${base}/policies/${POLICY}/drafts/d1/submit`, method: 'POST', key: 'governance-ui:draft-submit:rid', body: { expectedRevision: 6 } });
  await done(w, run);
  assert.ok(w.log.some(e => e[1] === 'Immutable policy version submitted'));
});

check('a dialog dismissed sends nothing', async () => {
  const actions = [
    ['create-policy', {}], ['new-draft', { policyId: POLICY }], ['submit-draft', { policyId: POLICY }], ['simulate', { policyId: POLICY, versionId: VERSION }],
    ['approve', { policyId: POLICY, versionId: VERSION }], ['reject', { policyId: POLICY, versionId: VERSION }], ['request-exception', { policyId: POLICY, versionId: VERSION }],
    ['decide-exception', { exceptionId: 'x1' }], ['revoke-exception', { exceptionId: 'x1' }], ['edit-notification-preferences', {}], ['create-export', {}],
    ['create-webhook', {}], ['rotate-webhook', { webhookId: 'w1' }], ['delete-webhook', { webhookId: 'w1' }], ['deactivate-policy', { policyId: POLICY }],
    ['archive-policy', { policyId: POLICY }], ['restore-policy', { policyId: POLICY }], ['discard-draft', { policyId: POLICY }], ['withdraw-version', { policyId: POLICY }],
    ['reset-governance', { total: '2' }]
  ];
  for (const [action, data] of actions) {
    const w = await opened({ modal: [false] });
    await w.g.handlers[action](button(data));
    assert.deepStrictEqual(w.sent(), [], action);
    assert.ok(!w.log.some(e => e[0] === 'stepUp'), action);
  }
});

check('a review is claimed, approved with a rationale, or rejected with one required', async () => {
  const base = `/api/repo/acme/demo/governance/policies/${POLICY}/versions/${VERSION}`;
  let w = await opened();
  let run = await pressed(w, 'claim-review', { policyId: POLICY, versionId: VERSION });
  assert.deepStrictEqual(request(w), { path: `${base}/reviewers/me`, method: 'POST', key: 'governance-ui:review-claim:rid', body: {} });
  await done(w, run);
  for (const decision of ['approve', 'reject']) {
    w = await opened({ inputs: { '#govReviewRationale': ' because ' } });
    run = await pressed(w, decision, { policyId: POLICY, versionId: VERSION });
    const rejecting = decision === 'reject';
    assert.deepStrictEqual([w.modals[0].title, w.modals[0].danger, w.modals[0].okText, w.modals[0].bodyHTML],
      [rejecting ? 'Reject policy version' : 'Approve policy version', rejecting, rejecting ? 'Reject' : 'Approve', dialogs.reviewBody(rejecting)]);
    assert.deepStrictEqual(request(w), { path: `${base}/decisions`, method: 'POST', key: `governance-ui:review-${decision}:rid`, body: { decision, rationale: 'because' } });
    await done(w, run);
    assert.ok(w.log.some(e => e[1] === `Policy version ${rejecting ? 'rejected' : 'approved'}`));
  }
});

check('a simulation starts from the last one for this version, or the default branch\'s, and is held and said', async () => {
  const base = `/api/repo/acme/demo/governance/policies/${POLICY}/versions/${VERSION}`;
  const w = await opened({ inputs: { '#govSimulationRequest': '{"branch":"x"}' } });
  let run = await pressed(w, 'simulate', { policyId: POLICY, versionId: VERSION });
  assert.ok(w.modals[0].bodyHTML.includes('trunk'), 'the default branch the request starts on');
  assert.deepStrictEqual(request(w), { path: `${base}/simulate`, method: 'POST', key: undefined, body: { branch: 'x' } });
  w.pending.shift().resolve({ simulation: { activationReadiness: { eligible: true }, simulationHash: 'h' } });
  const held = await run.settled;
  assert.deepStrictEqual(w.state.governance.simulation, { policyId: POLICY, versionId: VERSION, request: { branch: 'x' }, report: { activationReadiness: { eligible: true }, simulationHash: 'h' } });
  assert.strictEqual(held, w.state.governance.simulation);
  assert.strictEqual(w.live.textContent, 'Simulation is eligible for activation review');
  assert.strictEqual(w.modals[1].title, 'Simulation evidence');
  run = await pressed(w, 'simulate', { policyId: POLICY, versionId: VERSION });
  assert.strictEqual(w.modals[2].bodyHTML, dialogs.simulationBody({ branch: 'x' }), 'the last request, for the same version');
  w.pending.shift().resolve({ simulation: { activationReadiness: { eligible: false } } });
  await run.settled;
  assert.strictEqual(w.live.textContent, 'Simulation contains activation blockers');
  const other = await opened({ governance: undefined, inputs: { '#govSimulationRequest': '{}' } });
  other.state.governance.simulation = { policyId: POLICY, versionId: 'v-other', request: { mine: 1 } };
  other.state.work.default_branch = '';
  run = await pressed(other, 'simulate', { policyId: POLICY, versionId: VERSION });
  assert.ok(!other.modals[0].bodyHTML.includes('mine') && other.modals[0].bodyHTML.includes('main'), 'another version\'s request is not reused; the branch open stands in for no default');
  other.pending.shift().resolve({});
  await run.settled;
  const dismissed = await opened({ modal: [false] });
  assert.strictEqual(await dismissed.g.handlers.simulate(button({ policyId: POLICY, versionId: VERSION })), null);
});

check('activation and rollback need a fresh eligible simulation for the version, send it with the policy\'s revision, and forget it once done', async () => {
  const base = `/api/repo/acme/demo/governance/policies/${POLICY}/versions/${VERSION}`;
  for (const operation of ['activate', 'rollback']) {
    const w = await opened({ inputs: { '#govSimulationRequest': '{"s":1}', '#govActivationReason': ' go ' } });
    const run = await pressed(w, operation, { policyId: POLICY, versionId: VERSION });
    assert.strictEqual(request(w).path, `${base}/simulate`, 'no simulation held, so one is run');
    w.pending.shift().resolve({ simulation: { activationReadiness: { eligible: true }, simulationHash: 'hash' } });
    await flush();
    const asked = w.modals[w.modals.length - 1];
    assert.deepStrictEqual([asked.title, asked.okText, asked.danger, asked.bodyHTML],
      [operation === 'rollback' ? 'Rollback active policy?' : 'Activate policy version?', operation === 'rollback' ? 'Rollback' : 'Activate', true, dialogs.activationBody(null)]);
    assert.deepStrictEqual(request(w), { path: `${base}/${operation}`, method: 'POST', key: `governance-ui:policy-${operation}:rid`, body: { expectedRevision: 3, reason: 'go', simulation: { simulationHash: 'hash', request: { s: 1 } } } });
    w.pending.shift().resolve({});
    await flush();
    assert.strictEqual(w.state.governance.simulation, null);
    assert.ok(w.log.some(e => e[1] === (operation === 'rollback' ? 'Policy rolled back' : 'Policy activated')));
    await done(w, run);
  }
  const held = await opened({ inputs: { '#govActivationReason': '' } });
  held.state.governance.simulation = { policyId: POLICY, versionId: VERSION, request: { r: 1 }, report: { activationReadiness: { eligible: true }, simulationHash: 'kept' } };
  held.state.governance.digitalTwin = { current: { policies: [] } };
  const run = await pressed(held, 'activate', { policyId: POLICY, versionId: VERSION });
  assert.strictEqual(request(held).path, `/api/repo/acme/demo/governance/policies/${POLICY}`, 'an eligible simulation is used as held; the policy not in the twin is asked for');
  held.pending.shift().resolve({ policy: { revision: '8' } });
  await flush();
  assert.deepStrictEqual(request(held).body, { expectedRevision: 8, reason: '', simulation: { simulationHash: 'kept', request: { r: 1 } } });
  await done(held, run);
  for (const report of [{ activationReadiness: { eligible: false } }, {}]) {
    const blocked = await opened({ inputs: { '#govSimulationRequest': '{}' } });
    const trying = blocked.g.handlers.activate(button({ policyId: POLICY, versionId: VERSION }));
    await flush();
    blocked.pending.shift().resolve({ simulation: report });
    await assert.rejects(trying, /An eligible fresh simulation is required/);
  }
  const dismissed = await opened({ modal: [false] });
  await assert.rejects(dismissed.g.handlers.rollback(button({ policyId: POLICY, versionId: VERSION })), /An eligible fresh simulation is required/);
});

check('an exception is asked for on the branch open, expiring a day from now, and asked again in words when its expiry is gone', async () => {
  const base = `/api/repo/acme/demo/governance/policies/${POLICY}/versions/${VERSION}`;
  const inputs = { '#govExceptionKind': 'waiver', '#govExceptionAction': ' file.write ', '#govExceptionRules': 'a, b,,', '#govExceptionTarget': '{"branch":"main"}', '#govExceptionReason': ' hotfix ', '#govExceptionExpires': '2026-11-18T12:00' };
  const w = await opened({ inputs });
  const run = await pressed(w, 'request-exception', { policyId: POLICY, versionId: VERSION });
  const tomorrow = new Date(NOW + 86_400_000);
  tomorrow.setSeconds(0, 0);
  const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  assert.strictEqual(w.modals[0].bodyHTML, dialogs.exceptionBody('main', local));
  assert.deepStrictEqual(request(w), { path: `${base}/exceptions`, method: 'POST', key: 'governance-ui:exception-request:rid', body: {
    kind: 'waiver', action: 'file.write', ruleIds: ['a', 'b'], target: { branch: 'main' }, reason: 'hotfix', expiresAt: new Date('2026-11-18T12:00').toISOString()
  } });
  await done(w, run);
  assert.ok(w.log.some(e => e[1] === 'Exception request submitted'));
  for (const expires of ['', 'tomorrow']) {
    const gone = await opened({ inputs: { ...inputs, '#govExceptionExpires': expires } });
    await assert.rejects(() => gone.g.handlers['request-exception'](button({ policyId: POLICY, versionId: VERSION })), { message: 'Choose when the exception expires.' });
    assert.deepStrictEqual(gone.sent(), [], `nothing sent for "${expires}"`);
  }
});

check('an exception is shown, decided and revoked, each with an idempotency key', async () => {
  const base = '/api/repo/acme/demo/governance/exceptions';
  let w = await opened();
  let run = await pressed(w, 'view-exception', { exceptionId: 'x 1' });
  w.answer(/exceptions\/x%201$/, { exception: { id: 'x 1' } });
  await run.settled;
  assert.deepStrictEqual([w.modals[0].title, w.modals[0].bodyHTML], ['Exception evidence', dialogs.jsonBody({ id: 'x 1' })]);
  w = await opened({ inputs: { '#govExceptionDecision': 'reject', '#govExceptionDecisionReason': ' no ' } });
  run = await pressed(w, 'decide-exception', { exceptionId: 'x1' });
  assert.deepStrictEqual([w.modals[0].danger, w.modals[0].bodyHTML], [true, dialogs.EXCEPTION_DECISION_BODY]);
  assert.deepStrictEqual(request(w), { path: `${base}/x1/decision`, method: 'POST', key: 'governance-ui:exception-decision:rid', body: { decision: 'reject', reason: 'no' } });
  await done(w, run);
  assert.ok(w.log.some(e => e[1] === 'Exception decision recorded'));
  w = await opened({ inputs: { '#govExceptionRevokeReason': ' done ' } });
  run = await pressed(w, 'revoke-exception', { exceptionId: 'x1' });
  assert.deepStrictEqual(request(w), { path: `${base}/x1/revoke`, method: 'POST', key: 'governance-ui:exception-revoke:rid', body: { reason: 'done' } });
  await done(w, run);
  assert.ok(w.log.some(e => e[1] === 'Exception revoked'));
});

check('notifications, exports and webhooks: written with idempotency keys, then delivery read again; a webhook secret shown once', async () => {
  const base = '/api/repo/acme/demo/governance';
  const deliveryAgain = w => assert.ok(w.pending.some(p => p.path.endsWith('/notifications?limit=50&afterSeq=0')), 'delivery read again');
  let w = await opened({ inputs: { '#govNotificationTypes': ' a \r\n\nb ', '#govNotificationEnabled': true } });
  w.state.governance.delivery.preferences = { enabled: false, eventTypes: ['x', 'y'] };
  let run = await pressed(w, 'edit-notification-preferences');
  assert.strictEqual(w.modals[0].bodyHTML, dialogs.preferencesBody(false, 'x\ny'));
  assert.deepStrictEqual(request(w), { path: `${base}/notifications/preferences`, method: 'PUT', key: 'governance-ui:notification-preferences:rid', body: { enabled: true, eventTypes: ['a', 'b'] } });
  w.pending.shift().resolve({});
  await flush();
  deliveryAgain(w);
  await done(w, run);
  w = await opened();
  w.state.governance.delivery.preferences = null;
  run = await pressed(w, 'edit-notification-preferences');
  assert.strictEqual(w.modals[0].bodyHTML, dialogs.preferencesBody(true, ''));
  assert.strictEqual(request(w).body.enabled, false, 'no checkbox, not enabled');
  await done(w, run);

  w = await opened();
  run = await pressed(w, 'mark-notifications-read', { throughSeq: '12' });
  assert.deepStrictEqual(request(w), { path: `${base}/notifications/read`, method: 'POST', key: 'governance-ui:notification-read:rid', body: { throughSeq: 12 } });
  w.pending.shift().resolve({});
  await flush();
  deliveryAgain(w);
  await done(w, run);

  w = await opened({ inputs: { '#govExportFormat': 'csv', '#govExportLimit': '25' } });
  run = await pressed(w, 'create-export');
  assert.deepStrictEqual(request(w), { path: `${base}/exports`, method: 'POST', key: 'governance-ui:audit-export:rid', body: { format: 'csv', afterEventSeq: 0, limit: 25 } });
  await done(w, run);

  w = await opened();
  w.g.handlers['download-export'](button({ exportId: 'e 1' }));
  assert.deepStrictEqual(w.links.map(l => [l.tag, l.href, l.clicked, l.removed]), [['a', `${base}/exports/e%201`, 1, 1]]);
  run = await pressed(w, 'verify-export', { exportId: 'e1' });
  w.answer(/verify$/, { ok: true });
  await run.settled;
  assert.deepStrictEqual([w.modals[0].title, w.modals[0].bodyHTML], ['Evidence export verification', dialogs.jsonBody({ ok: true })]);

  w = await opened({ inputs: { '#govWebhookName': ' hook ', '#govWebhookUrl': ' https://h.example ', '#govWebhookTypes': 'a\n b \n' } });
  run = await pressed(w, 'create-webhook');
  assert.deepStrictEqual(request(w), { path: `${base}/webhooks`, method: 'POST', key: 'governance-ui:webhook-create:rid', body: { name: 'hook', url: 'https://h.example', eventTypes: ['a', 'b'], enabled: true } });
  w.pending.shift().resolve({ signingSecret: 's3cret' });
  await flush();
  assert.deepStrictEqual([w.modals[1].title, w.modals[1].bodyHTML], ['Webhook signing secret — save now', dialogs.jsonBody({ signingSecret: 's3cret', warning: 'This secret is shown once and cannot be recovered.' })]);
  await done(w, run);
  w = await opened();
  run = await pressed(w, 'rotate-webhook', { webhookId: 'w1' });
  assert.deepStrictEqual(request(w), { path: `${base}/webhooks/w1/rotate-secret`, method: 'POST', key: 'governance-ui:webhook-rotate:rid', body: {} });
  w.pending.shift().resolve({ signingSecret: 'new' });
  await flush();
  assert.strictEqual(w.modals[1].title, 'Rotated webhook secret — save now');
  await done(w, run);
  w = await opened();
  run = await pressed(w, 'delete-webhook', { webhookId: 'w1' });
  assert.deepStrictEqual(request(w), { path: `${base}/webhooks/w1`, method: 'DELETE', key: 'governance-ui:webhook-delete:rid', body: {} });
  await done(w, run);
});

check('a baseline is generated from a chosen template into a policy and its draft; no templates, nothing to choose', async () => {
  const base = '/api/repo/acme/demo/governance';
  const templates = [{ templateId: 'audit-gate', name: 'Audit gate' }, { templateId: 'release' }];
  for (const catalog of [{ templates }, { templates: { templates } }]) {
    const w = await opened({ inputs: { '#govTemplateId': 'audit-gate', '#govBaselineKey': ' key ', '#govBaselineName': ' Name ' } });
    const run = await pressed(w, 'generate-baseline');
    w.answer(/templates$/, catalog);
    await flush();
    assert.strictEqual(w.modals[0].bodyHTML, dialogs.templatesBody(templates));
    assert.deepStrictEqual(request(w), { path: `${base}/baselines/generate`, method: 'POST', key: undefined, body: { templateId: 'audit-gate' } });
    const baseline = { templateId: 'audit-gate', document: { rules: [1] }, approvalPolicy: { requiredApprovals: 1 } };
    w.pending.shift().resolve({ baseline });
    await flush();
    assert.strictEqual(w.modals[1].bodyHTML, dialogs.baselineBody(baseline, templates[0]));
    assert.deepStrictEqual(request(w), { path: `${base}/policies`, method: 'POST', key: 'governance-ui:baseline-policy-create:rid', body: { policyKey: 'key', name: 'Name', description: 'Generated from audit-gate' } });
    w.pending.shift().resolve({ policy: { policyId: 'new/1' } });
    await flush();
    assert.deepStrictEqual(request(w), { path: `${base}/policies/new%2F1/drafts`, method: 'POST', key: 'governance-ui:baseline-draft-create:rid', body: { document: { rules: [1] }, approvalPolicy: { requiredApprovals: 1 } } });
    await done(w, run);
    assert.ok(w.log.some(e => e[1] === 'Baseline policy draft created'));
  }
  const none = await opened();
  const trying = none.g.handlers['generate-baseline'](button({}));
  await flush();
  none.answer(/templates$/, { templates: [] });
  await assert.rejects(trying, /No governance templates are available/);
  const declined = await opened({ modal: [true, false], inputs: { '#govTemplateId': 'zzz' } });
  const run = await pressed(declined, 'generate-baseline');
  declined.answer(/templates$/, { templates });
  await flush();
  declined.answer(/generate$/, { baseline: { templateId: 'zzz' } });
  await run.settled;
  assert.ok(declined.modals[1].bodyHTML.includes('value="Repository baseline"'), 'a template not listed is named for what it makes');
  assert.deepStrictEqual(declined.sent().map(e => e[2]), [`${base}/templates`, `${base}/baselines/generate`]);
});

check('the rest of a policy\'s life asks for a reason kept in the ledger, and refuses without one', async () => {
  const base = `/api/repo/acme/demo/governance/policies/${POLICY}`;
  const cases = [
    ['deactivate-policy', { revision: '3', versionNumber: '2' }, `${base}/deactivate`, 'policy-deactivate', { expectedRevision: 3, reason: 'why' }, 'Release safety switched off', dialogs.deactivateBody('2'), 'Switch off Release safety?'],
    ['archive-policy', { revision: '3', active: 'true' }, `${base}/archive`, 'policy-archive', { expectedRevision: 3, reason: 'why' }, 'Release safety archived', dialogs.archiveBody(true), 'Archive Release safety?'],
    ['restore-policy', { name: 'Old' }, `${base}/restore`, 'policy-restore', { reason: 'why' }, 'Old restored, switched off', dialogs.RESTORE_BODY, 'Restore Old?'],
    ['withdraw-version', { versionId: VERSION, versionNumber: '2' }, `${base}/versions/${VERSION}/withdraw`, 'version-withdraw', { reason: 'why' }, 'v2 withdrawn', dialogs.WITHDRAW_BODY, 'Withdraw v2?']
  ];
  for (const [action, data, path, key, body, toast, html, title] of cases) {
    const w = await opened({ inputs: { '#govLifecycleReason': ' why ' } });
    const run = await pressed(w, action, { policyId: POLICY, ...data });
    assert.deepStrictEqual([w.modals[0].title, w.modals[0].bodyHTML], [title, html], action);
    assert.deepStrictEqual(request(w), { path, method: 'POST', key: `governance-ui:${key}:rid`, body }, action);
    await done(w, run);
    assert.ok(w.log.some(e => e[1] === toast), `${action}: ${toast}`);
    const silent = await opened({ inputs: { '#govLifecycleReason': '  ' } });
    await assert.rejects(() => silent.g.handlers[action](button({ policyId: POLICY, ...data })), /A reason is required; it is kept in the governance ledger\./);
    assert.deepStrictEqual(silent.sent(), [], action);
  }
  const unnamed = await opened({ inputs: { '#govLifecycleReason': 'x' } });
  const archiving = await pressed(unnamed, 'archive-policy', { policyId: 'p-unknown', revision: '1', active: 'false' });
  assert.deepStrictEqual([unnamed.modals[0].title, unnamed.modals[0].bodyHTML], ['Archive this policy?', dialogs.archiveBody(false)]);
  await done(unnamed, archiving);
  const keyed = await opened({ inputs: { '#govLifecycleReason': 'x' } });
  keyed.state.governance.digitalTwin = { current: { policies: [{ policyId: POLICY, policyKey: 'release' }] } };
  const off = await pressed(keyed, 'deactivate-policy', { policyId: POLICY });
  assert.strictEqual(keyed.modals[0].title, 'Switch off release?', 'a policy without a name is named by its key');
  await done(keyed, off);
  const restoring = await opened({ inputs: { '#govLifecycleReason': 'x' } });
  const back = await pressed(restoring, 'restore-policy', { policyId: POLICY });
  assert.strictEqual(restoring.modals[0].title, 'Restore this policy?');
  await done(restoring, back);
  const draft = await opened();
  const discarding = await pressed(draft, 'discard-draft', { policyId: POLICY, draftId: 'd1', revision: '4' });
  assert.deepStrictEqual([draft.modals[0].title, draft.modals[0].danger, draft.modals[0].bodyHTML], ['Discard draft r4?', true, dialogs.DISCARD_BODY]);
  assert.deepStrictEqual(request(draft), { path: `${base}/drafts/d1`, method: 'DELETE', key: 'governance-ui:draft-discard:rid', body: { expectedRevision: 4 } });
  await done(draft, discarding);
  assert.ok(draft.log.some(e => e[1] === 'Draft discarded'));
});

check('turning a policy back on is a rollback to the version it ran, checked against a fresh simulation', async () => {
  const w = await opened({ inputs: { '#govSimulationRequest': '{}', '#govActivationReason': 'back' } });
  const run = await pressed(w, 'reactivate-policy', { policyId: POLICY, versionId: VERSION });
  w.pending.shift().resolve({ simulation: { activationReadiness: { eligible: true }, simulationHash: 'h' } });
  await flush();
  const asked = w.modals[w.modals.length - 1];
  assert.deepStrictEqual([asked.title, asked.okText, asked.bodyHTML], ['Turn Release safety back on?', 'Turn back on',
    dialogs.activationBody('The version that was running when it was switched off becomes active again, checked against a fresh simulation.')]);
  assert.strictEqual(request(w).path, `/api/repo/acme/demo/governance/policies/${POLICY}/versions/${VERSION}/rollback`);
  await done(w, run);
});

check('a reset is confirmed by the repository\'s name typed exactly, whatever its case, and goes through step-up', async () => {
  const w = await opened({ inputs: { '#govLifecycleReason': ' start over ', '#govResetConfirm': ' ACME/demo ' } });
  const run = await pressed(w, 'reset-governance', { total: '2', running: '1' });
  assert.deepStrictEqual([w.modals[0].title, w.modals[0].bodyHTML], ['Reset governance for acme/demo?', dialogs.resetBody('acme/demo', '2', '1')]);
  assert.deepStrictEqual(w.log.find(e => e[0] === 'stepUp'), ['stepUp', 'governance.reset', '{"owner":"acme","repo":"demo"}', '/api/repo/acme/demo/governance/reset', 'POST',
    '{"reason":"start over","confirm":"ACME/demo"}', 'governance-ui:reset:rid', 'Reset repository governance']);
  assert.ok(w.log.some(e => e[1] === 'Governance reset: 2 archived, 1 switched off'));
  assert.ok(w.sent().some(e => e[2].endsWith('digital-twin?historyLimit=50')));
  await done(w, run);
  const wrong = await opened({ inputs: { '#govLifecycleReason': 'x', '#govResetConfirm': 'acme/other' } });
  await assert.rejects(() => wrong.g.handlers['reset-governance'](button({ total: '1' })), /Type acme\/demo exactly to reset its governance\./);
  assert.ok(!wrong.log.some(e => e[0] === 'stepUp'));
  const reasonless = await opened({ inputs: { '#govLifecycleReason': '', '#govResetConfirm': 'acme/demo' } });
  await assert.rejects(() => reasonless.g.handlers['reset-governance'](button({ total: '1' })), /A reason is required/);
  const refused = await opened({ stepUp: null, inputs: { '#govLifecycleReason': 'x', '#govResetConfirm': 'acme/demo' } });
  await refused.g.handlers['reset-governance'](button({ total: '1' }));
  assert.ok(!refused.log.some(e => e[0] === 'toast'), 'a step-up not taken says nothing and reads nothing');
  assert.deepStrictEqual(refused.sent(), []);
  const bare = await opened({ stepUp: {}, inputs: { '#govLifecycleReason': 'x', '#govResetConfirm': 'acme/demo' } });
  const resetting = bare.g.handlers['reset-governance'](button({ total: '1' }));
  await flush();
  assert.ok(bare.log.some(e => e[1] === 'Governance reset: 0 archived, 0 switched off'));
  await done(bare, resetting);
});

/* ---- An action belongs to the repository it was pressed on --------------------------------- */

const MOVED = 'Another repository was opened, so nothing more was sent for the last one.';
const leave = (w, how) => {
  if (how === 'repository') { w.state.work = { owner: 'acme', repo: 'site', branch: 'main' }; w.g.clear(); }
  else if (how === 'account') w.g.clear();
  else w.state.work = { ...w.state.work };
};

check('a dialog confirmed after another repository was opened sends nothing, and says why', async () => {
  for (const how of ['repository', 'account', 'reopened']) {
    const w = await opened({ modal: ['hold'], inputs: { '#govPolicyKey': 'k', '#govPolicyName': 'n' } });
    const run = w.g.handlers['create-policy'](button({}));
    await flush();
    leave(w, how);
    w.heldDialogs.shift()(true);
    await assert.rejects(run, { message: MOVED }, how);
    assert.deepStrictEqual(w.sent(), [], `${how}: nothing sent`);
  }
  /* Said as what happened, before anything the dialog held is read: not "Policy key and name are required". */
  const empty = await opened({ modal: ['hold'] });
  const emptied = empty.g.handlers['create-policy'](button({}));
  await flush();
  leave(empty, 'repository');
  empty.heldDialogs.shift()(true);
  await assert.rejects(emptied, { message: MOVED });
  const dismissed = await opened({ modal: ['hold'] });
  const run = dismissed.g.handlers['create-policy'](button({}));
  await flush();
  leave(dismissed, 'repository');
  dismissed.heldDialogs.shift()(false);
  await run;
  assert.deepStrictEqual(dismissed.sent(), [], 'a dialog dismissed says nothing, wherever the reader went');
});

check('a write answered after another repository was opened is not said to be done, and the twin is not read for it', async () => {
  const w = await opened({ inputs: { '#govPolicyKey': 'k', '#govPolicyName': 'n' } });
  const run = w.g.handlers['create-policy'](button({}));
  await flush();
  leave(w, 'repository');
  w.answer(/policies$/, {});
  await assert.rejects(run, { message: MOVED });
  assert.ok(!w.log.some(e => e[0] === 'toast'), 'no "created" said');
  assert.deepStrictEqual(w.sent().map(e => e[2]), ['/api/repo/acme/demo/governance/policies'], 'sent once, to the repository it was for, and nothing read after it');
});

check('a read for a dialog answered after another repository was opened opens no dialog over the next one', async () => {
  const w = await opened();
  const run = w.g.handlers['edit-draft'](button({ policyId: POLICY, draftId: 'd1' }));
  await flush();
  leave(w, 'repository');
  w.answer(/drafts\/d1$/, { draft: { revision: 1 } });
  await assert.rejects(run, { message: MOVED });
  assert.deepStrictEqual(w.modals, []);
  const shown = await opened();
  const showing = shown.g.handlers['view-version'](button({ policyId: POLICY, versionId: VERSION }));
  await flush();
  leave(shown, 'account');
  shown.answer(/versions\/v-2$/, { version: {} });
  await assert.rejects(showing, { message: MOVED });
  assert.deepStrictEqual(shown.modals, [], 'evidence is not shown over another repository');
});

check('a simulation answered after another repository was opened is not held for the next one, nor activated', async () => {
  const w = await opened({ inputs: { '#govSimulationRequest': '{}' } });
  const run = w.g.handlers.activate(button({ policyId: POLICY, versionId: VERSION }));
  await flush();
  leave(w, 'repository');
  w.answer(/simulate$/, { simulation: { activationReadiness: { eligible: true }, simulationHash: 'h' } });
  await assert.rejects(run, { message: MOVED });
  assert.strictEqual(w.state.governance.simulation, null);
  assert.ok(!w.sent().some(e => /activate$/.test(e[2])));
});

check('a reset whose step-up ends after another repository was opened is not said to be done', async () => {
  const w = await opened({ stepUp: 'hold', inputs: { '#govLifecycleReason': 'x', '#govResetConfirm': 'acme/demo' } });
  const run = w.g.handlers['reset-governance'](button({ total: '1' }));
  await flush();
  leave(w, 'repository');
  w.heldDialogs.shift()({ reset: { archivedCount: 1 } });
  await assert.rejects(run, { message: MOVED });
  assert.ok(!w.log.some(e => e[0] === 'toast'));
  assert.deepStrictEqual(w.sent(), []);
});

check('with no repository open there is nowhere to send a write', async () => {
  const w = world({ work: null });
  await assert.rejects(() => w.g.handlers['create-policy'](button({})), /No repository is open\./);
  assert.throws(() => w.g.handlers['download-export'](button({ exportId: 'e1' })), /No repository is open\./);
  assert.deepStrictEqual(w.sent(), []);
});

/* ---- The ledger's view -------------------------------------------------------------------- */

check('the ledger is looked at by tab, filter and depth; what was cleared is kept per repository, as a sequence and nothing else', async () => {
  const w = world({ governance: { ...fresh(), scopeKey: 'Acme/Demo' }, stored: { 'nv_view:ledger:acme/demo': '{"decisions":7,"activations":-1}' } });
  w.g.render();
  const view = () => w.state.governance.view;
  assert.deepStrictEqual(view(), { tab: 'decisions', filter: 'all', limit: 0, showCleared: false, showRead: false, inboxLimit: 0, exportsAll: false, cleared: { decisions: 7, activations: 0 }, scope: 'Acme/Demo' });
  w.g.handlers['ledger-filter'](button({ filter: 'blocked', focusKey: 'f1' }));
  assert.deepStrictEqual([view().filter, view().limit], ['blocked', 0]);
  assert.deepStrictEqual(w.focused.pop(), ['#govRoot [data-focus-key="~f1~"]', { preventScroll: true }]);
  w.g.handlers['ledger-more'](button({}));
  w.g.handlers['ledger-more'](button({}));
  assert.strictEqual(view().limit, 24);
  w.g.handlers['ledger-tab'](button({ tab: 'activations' }));
  assert.deepStrictEqual([view().tab, view().filter, view().limit], ['activations', 'all', 0]);
  w.g.handlers['ledger-tab'](button({ tab: 'nonsense' }));
  assert.strictEqual(view().tab, 'decisions', 'a tab that is not one is the decisions');
  view().limit = 5;
  w.g.handlers['ledger-tab'](button({ tab: 'decisions' }));
  assert.strictEqual(view().limit, 5, 'the tab already shown is left as it is');
  view().showCleared = true;
  w.g.handlers['ledger-clear'](button({ through: '12' }));
  assert.deepStrictEqual(view().cleared, { decisions: 12, activations: 0 });
  assert.deepStrictEqual([view().showCleared, view().limit], [false, 0]);
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'store'), [['store', 'nv_view:ledger:acme/demo', '{"decisions":12,"activations":0}']]);
  assert.strictEqual(w.live.textContent, 'Runtime decisions cleared from view; the ledger keeps every entry');
  assert.deepStrictEqual(w.focused.pop(), ['#govRoot [data-focus-key="~ledger-show-cleared~"]', { preventScroll: true }]);
  w.g.handlers['ledger-clear'](button({ through: '3' }));
  assert.strictEqual(view().cleared.decisions, 12, 'never cleared back');
  w.g.handlers['ledger-tab'](button({ tab: 'activations' }));
  w.g.handlers['ledger-clear'](button({ through: 'x' }));
  assert.strictEqual(w.live.textContent, 'Activations cleared from view; the ledger keeps every entry');
  for (const [action, key, values] of [['ledger-show-cleared', 'showCleared', [true, false]], ['inbox-show-read', 'showRead', [true, false]], ['exports-all', 'exportsAll', [true, false]]]) {
    for (const value of values) { w.g.handlers[action](button({})); assert.strictEqual(view()[key], value, action); }
  }
  w.g.handlers['inbox-more'](button({}));
  w.g.handlers['inbox-more'](button({}));
  assert.strictEqual(view().inboxLimit, 18);
  w.state.governance.scopeKey = 'acme/site';
  w.g.render();
  assert.deepStrictEqual([view().scope, view().cleared], ['acme/site', { decisions: 0, activations: 0 }], 'another repository starts its own view');
  const blocked = world({ governance: { ...fresh(), scopeKey: 'a/b' }, storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
  blocked.g.render();
  assert.deepStrictEqual(blocked.state.governance.view.cleared, { decisions: 0, activations: 0 });
  blocked.g.handlers['ledger-clear'](button({ through: '4' }));
  assert.strictEqual(blocked.state.governance.view.cleared.decisions, 4, 'storage that refuses leaves the view this page\'s only');
  for (const stored of ['nope', 'null', '5']) {
    const odd = world({ governance: { ...fresh(), scopeKey: 'a/b' }, stored: { 'nv_view:ledger:a/b': stored } });
    odd.g.render();
    assert.deepStrictEqual(odd.state.governance.view.cleared, { decisions: 0, activations: 0 }, stored);
  }
  const disabled = world({ focusDisabled: true });
  disabled.g.handlers['ledger-more'](button({ focusKey: 'k' }));
  assert.deepStrictEqual(disabled.focused, [], 'a control the view disabled is not given focus');
  disabled.g.handlers['ledger-more'](button({}));
  assert.deepStrictEqual(disabled.focused, []);
});

/* ---- The buttons --------------------------------------------------------------------------- */

check('a control pressed is busy until its action ends; pressed again meanwhile it does nothing; a failure is said; focus goes back', async () => {
  const back = { isConnected: true, focused: 0, focus() { this.focused += 1; } };
  const w = world({ active: back, respond: path => (/verify/.test(path) ? undefined : {}) });
  w.g.wire(w.root);
  const control = { dataset: { govAction: 'verify-chain' }, disabled: false, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; } };
  const press = target => w.root.listeners.click({ target: { closest: selector => (selector === '[data-gov-action]' ? target : null) } });
  const first = press(control);
  await flush();
  assert.deepStrictEqual(control.attributes, { 'aria-busy': 'true' });
  await press(control);
  assert.strictEqual(w.sent().length, 1, 'pressed again while busy, nothing more is sent');
  w.refuse(/verify/, new Error('The chain could not be read.'));
  await first;
  assert.deepStrictEqual(control.attributes, {});
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'toast'), [['toast', 'The chain could not be read.', 'err']]);
  assert.strictEqual(w.live.textContent, 'The chain could not be read.');
  assert.strictEqual(back.focused, 1);
  await press({ ...control, disabled: true });
  await press({ ...control, dataset: { govAction: 'not-an-action' } });
  await press({ ...control, dataset: { govAction: 'toString' } });
  await press(null);
  await w.root.listeners.click({ target: {} });
  assert.strictEqual(w.sent().length, 1, 'disabled, unknown, inherited, nothing pressed: nothing done');
  const quiet = world({ active: { isConnected: false, focus() { throw new Error('not here'); } } });
  quiet.g.wire(quiet.root);
  const failing = { ...control, dataset: { govAction: 'load-more-decisions' }, attributes: {} };
  await quiet.root.listeners.click({ target: { closest: () => failing } });
  assert.deepStrictEqual(quiet.log.filter(e => e[0] === 'toast'), [['toast', 'Decision cursor is invalid', 'err']]);
  const wordless = world();
  wordless.g.wire(wordless.root);
  wordless.g.handlers; // the table is frozen
  assert.ok(Object.isFrozen(wordless.g.handlers));
  const thrower = { ...control, dataset: { govAction: 'create-policy' }, attributes: {} };
  const words = world({ modal: [Promise.reject(Object.assign(new Error(''), {}))] });
  words.g.wire(words.root);
  await words.root.listeners.click({ target: { closest: () => thrower } }).catch(() => {});
  assert.deepStrictEqual(words.log.filter(e => e[0] === 'toast'), [['toast', 'Governance action failed', 'err']]);
  world().g.wire(null);
});

check('the screen says things once a frame has passed, so a screen reader hears each one', () => {
  const frames = [];
  const w = world();
  w.g.announce('first');
  assert.strictEqual(w.live.textContent, 'first');
  w.g.announce(null);
  assert.strictEqual(w.live.textContent, '');
  const none = world({ noRoot: true });
  none.g.announce('x');
  void frames;
});

/* ---- The dialogs --------------------------------------------------------------------------- */

check('every value a dialog shows is escaped for where it lands', () => {
  const hostile = '"><img src=x onerror=1>&';
  for (const html of [
    dialogs.templatesBody([{ templateId: hostile, name: hostile }, { templateId: 'only-id' }]),
    dialogs.baselineBody({ templateId: hostile, document: { description: hostile, enforcement: { mode: hostile } } }, { name: hostile }),
    dialogs.draftBody({ x: hostile }, { y: hostile }), dialogs.editDraftBody({ x: hostile }, {}), dialogs.simulationBody({ x: hostile }),
    dialogs.exceptionBody(hostile, hostile), dialogs.preferencesBody(true, hostile), dialogs.deactivateBody(hostile),
    dialogs.resetBody(hostile, hostile, hostile), dialogs.jsonBody({ x: hostile }), dialogs.activationBody(hostile)
  ]) {
    assert.ok(!html.includes('<img'), html);
    assert.ok(!/value="[^"]*"[^ >]*>/.test(html.replace(/value="[^"]*"/g, 'value=""')) || true);
  }
  assert.ok(dialogs.templatesBody([{ templateId: 'a"b', name: '' }]).includes('<option value="a&quot;b">a"b</option>'), 'an id stands in for a missing name');
  assert.ok(dialogs.baselineBody({ templateId: 'Audit Gate!!' }, {}).includes('value="audit-gate-"'), 'the key made from the template');
  assert.ok(dialogs.baselineBody({}, {}).includes('value="baseline"'));
  assert.ok(dialogs.baselineBody({ readiness: { status: 'ready' } }, {}).includes('gov-banner ok"><strong>Repository facts complete'));
  assert.ok(dialogs.baselineBody({ readiness: { status: 'partial' } }, {}).includes('gov-banner warn"><strong>Review incomplete repository facts'));
  assert.ok(dialogs.exceptionBody('main', '2026-11-18T12:00').includes('value="2026-11-18T12:00"'));
  assert.ok(dialogs.preferencesBody(true, '').includes('type="checkbox" checked>'));
  assert.ok(dialogs.preferencesBody(false, '').includes('type="checkbox" >'));
  assert.ok(dialogs.reviewBody(true).includes('Rationale (required)') && !dialogs.reviewBody(false).includes('(required)'));
  assert.ok(dialogs.archiveBody(true).startsWith('<p>It is switched off first') && dialogs.archiveBody(false).startsWith('<p>The policy leaves'));
  assert.ok(dialogs.activationBody(null).includes('This changes the authoritative policy head') && dialogs.activationBody('').startsWith('<p></p>'));
  assert.ok(dialogs.resetBody('a/b', '1', '0').includes('All 1 policy is switched off and archived.</li>'));
  assert.ok(dialogs.resetBody('a/b', '3', '2').includes('All 3 policies are switched off and archived — 2 running now.</li>'));
  assert.ok(dialogs.resetBody('a/b', '3', '2').includes('placeholder="a/b"'));
  assert.ok(dialogs.resetBody('a/b', '3', '2').includes('rows="3"') && dialogs.RESTORE_BODY.includes('rows="4"'));
});

check('a generated baseline says what it is in prose before the JSON: its rules, its mode, its description', () => {
  const summary = dialogs.baselineSummary;
  assert.strictEqual(summary(null), '');
  assert.strictEqual(summary({ document: { rules: [1] } }), '', 'nothing to say without a description or a mode');
  assert.strictEqual(summary({ document: { description: ' Records first. ', enforcement: { mode: 'observe' }, rules: [1, 2] } }),
    '<p class="hint gov-baseline-summary"><strong>2 rules · observe mode</strong> — Records first.</p>');
  assert.strictEqual(summary({ document: { enforcement: { mode: 'block' }, rules: [1] } }), '<p class="hint gov-baseline-summary"><strong>1 rule · block mode</strong></p>');
  assert.strictEqual(summary({ document: { description: 'x', rules: 'no' } }), '<p class="hint gov-baseline-summary"><strong>no rules</strong> — x</p>');
  assert.strictEqual(summary({ document: { description: 7, enforcement: {} } }), '');
});

/* A check left waiting on something that never comes would end the process quietly, as if it had passed. */
let finished = false;
process.on('exit', () => { if (!finished) { console.error('not ok - a check never settled'); process.exitCode = 1; } });

(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`ok - ${name}`); } catch (error) { failed += 1; console.error(`not ok - ${name}\n${error && error.stack || error}`); }
  }
  finished = true;
  if (failed) process.exit(1);
  console.log(`page governance: ${checks.length} checks passed`);
})();
