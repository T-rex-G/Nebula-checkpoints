'use strict';

/*
 * The findings inbox, asked directly (features/findings/findings-controller.ts):
 * shown and read, kept for a while and read again when forced; each row's
 * owners read once per repository and kept while the inbox is read again;
 * a finding's record of decisions drawn in place; findings decided together,
 * stopping when the session changes; and everything let go of with the
 * session.
 */

const assert = require('assert');
const fc = require('../apps/web/src/features/findings/findings-controller.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const KEEP = 5 * 60 * 1000;
const ITEM = (key, extra = {}) => ({ key, id: `id-${key}`, owner: 'octo', repo: 'demo', rule: `R-${key}`, path: `src/${key}.js`, source: 'audit', ...extra });
const INBOX = () => ({ available: true, findings: [ITEM('a'), ITEM('b', { repo: 'other' }), ITEM('c', { decision: { disposition: 'accepted-risk' } }), ITEM('d', { source: 'exposure', rule: 'token' })] });

/* A small document for the record of decisions: elements with text, classes, children and data. */
function fakeHost() {
  const make = tag => ({ tag, className: '', textContent: '', dateTime: '', children: [], dataset: {}, append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); return node; } });
  const host = make('div');
  host.ownerDocument = { createElement: make };
  Object.defineProperty(host, 'textContent', { get() { return this._text || ''; }, set(value) { this._text = value; this.children = []; } });
  return host;
}

function setup(options = {}) {
  const log = [];
  const page = { identity: { login: 'ada' }, epoch: 1, now: Date.parse('2026-11-23T12:00:00Z'), offered: options.offered ?? true, showing: true, present: true, focus: null };
  const gates = options.gates || {};
  const answers = { inbox: [INBOX()], codeowners: { demo: { rules: [{ pattern: '*', owners: ['@octo/web'] }] }, other: { rules: [] } }, events: { events: [] }, triage: {}, ...(options.answers || {}) };
  let inboxCalls = 0;
  const controller = fc.createFindingsInbox({
    api: async (path, init) => {
      log.push(['api', path, init ? JSON.stringify(init) : '']);
      if (path === '/api/workspace/findings') {
        inboxCalls += 1;
        if (gates[`inbox${inboxCalls}`]) await gates[`inbox${inboxCalls}`].promise;
        const answer = answers.inbox.length > 1 ? answers.inbox.shift() : answers.inbox[0];
        if (answer instanceof Error) throw answer;
        return typeof answer === 'object' && answer ? JSON.parse(JSON.stringify(answer)) : answer;
      }
      const repo = path.split('/')[4];
      if (path.endsWith('/codeowners')) {
        if (gates[`owners-${repo}`]) await gates[`owners-${repo}`].promise;
        const answer = answers.codeowners[repo];
        if (answer instanceof Error) throw answer;
        return answer;
      }
      if (path.endsWith('/triage-events')) {
        const answer = answers.events;
        if (answer instanceof Error) throw answer;
        return answer;
      }
      if (path.endsWith('/triage')) {
        if (options.duringDecide) options.duringDecide(page, log);
        const answer = typeof answers.triage === 'function' ? answers.triage(path) : answers.triage;
        if (answer instanceof Error) throw answer;
        return answer;
      }
      throw new Error(`unexpected ${path}`);
    },
    identity: () => page.identity,
    epoch: () => page.epoch,
    offered: () => page.offered,
    explain: () => 'The inbox is not offered here.',
    toast: (message, kind) => log.push(['toast', message, kind]),
    showPage: () => log.push(['page']),
    showing: () => page.showing,
    writeRoute: filters => log.push(['route', JSON.stringify(filters)]),
    parseFilters: query => ({ view: 'open', query: String(query || '') }),
    model: (inbox, filters, opts) => {
      const findings = inbox && Array.isArray(inbox.findings) ? inbox.findings : null;
      const shown = findings ? findings.map(item => ({ ...item, label: opts.labelOf(item), owners: opts.ownersOf(item) })) : [];
      return { state: inbox ? (findings ? 'ready' : 'unavailable') : 'loading', shown, filters };
    },
    present: () => page.present,
    render: (view, state, actions) => { page.view = view; page.actions = actions; log.push(['render', view.state, state.progress]); },
    focus: { search: () => page.focus, restore: caret => log.push(['restore', caret]) },
    codeowners: { ownersOf: (rules, path) => rules.length ? [`${rules[0].owners[0]}:${path}`] : ['nobody'], revive: rules => (Array.isArray(rules) ? rules : []) },
    exposureLabel: rule => `Exposure ${rule}`,
    openTool: (owner, repo, tool) => log.push(['tool', owner, repo, tool]),
    invalidatePosture: () => log.push(['posture']),
    offline: error => Boolean(error && error.offline),
    day: at => (at ? `day:${at}` : ''),
    decisionWord: disposition => ({ 'false-positive': 'Marked a false positive', 'accepted-risk': 'Accepted the risk' })[disposition],
    now: () => page.now,
    keepMs: KEEP
  });
  const of = kind => log.filter(entry => entry[0] === kind);
  return { controller, page, log, of, state: controller.state };
}

check('the inbox shown: its filters written into the address, drawn at once, then read and drawn with its owners', async () => {
  const s = setup();
  s.controller.show({ view: 'new', query: 'sql' });
  assert.deepStrictEqual(s.log.slice(0, 4), [['page'], ['route', '{"view":"new","query":"sql"}'], ['render', 'loading', ''], ['render', 'loading', '']]);
  await settle();
  assert.deepStrictEqual(s.of('api').map(entry => entry[1]), ['/api/workspace/findings', '/api/repo/octo/demo/codeowners', '/api/repo/octo/other/codeowners']);
  assert.strictEqual(s.page.view.state, 'ready');
  assert.deepStrictEqual(s.page.view.shown.map(item => [item.key, item.label, item.owners]), [
    ['a', 'R-a', ['@octo/web:src/a.js']], ['b', 'R-b', ['nobody']], ['c', 'R-c', ['@octo/web:src/c.js']], ['d', 'Exposure token', ['@octo/web:src/d.js']]]);
  assert.strictEqual(s.state.disposition, 'accepted-risk', 'a risk accepted is the decision first offered');
  s.controller.show();
  assert.deepStrictEqual(s.state.filters, { view: 'new', query: 'sql' }, 'shown again: the filters it had');
  const plain = setup();
  plain.controller.show();
  assert.deepStrictEqual(plain.state.filters, { view: 'open', query: '' }, 'no filters: the default ones');
  const odd = setup({ answers: { inbox: [{ available: true, findings: [ITEM('a', { owner: 'My Org', repo: 'Demo' })] }], codeowners: { Demo: { rules: [] } } } });
  await odd.controller.load();
  await settle();
  assert.deepStrictEqual([odd.of('api')[1][1], [...odd.state.owners.keys()]], ['/api/repo/My%20Org/Demo/codeowners', ['my org/demo']]);
  const off = setup({ offered: false });
  off.controller.show();
  assert.deepStrictEqual(off.log, [['toast', 'The inbox is not offered here.', 'err']]);
});

check('a read kept for a while is drawn, not asked again, unless forced; an inbox for another session is dropped', async () => {
  const s = setup();
  await s.controller.load();
  await settle();
  const asked = s.of('api').length;
  const drawn = s.of('render').length;
  await s.controller.load();
  assert.deepStrictEqual([s.of('api').length, s.of('render').length], [asked, drawn + 1], 'kept, and drawn');
  s.page.now += KEEP;
  await s.controller.load();
  assert.strictEqual(s.of('api').length, asked + 1, 'read again once old');
  await s.controller.load(true);
  assert.strictEqual(s.of('api').length, asked + 2, 'forced');
  s.controller.invalidate();
  await s.controller.load();
  assert.strictEqual(s.of('api').length, asked + 3, 'invalidated');
  for (const change of [page => { page.epoch += 1; }, page => { page.identity = { login: 'bo' }; }]) {
    const gate = held();
    const late = setup({ gates: { inbox1: gate } });
    const reading = late.controller.load();
    change(late.page);
    gate.release();
    await reading;
    assert.strictEqual(late.state.inbox, null, 'another session\u2019s inbox dropped');
  }
  const signedOut = setup();
  signedOut.page.identity = null;
  await signedOut.controller.load();
  assert.deepStrictEqual(signedOut.log, []);
  const unoffered = setup({ offered: false });
  await unoffered.controller.load(true);
  assert.deepStrictEqual(unoffered.log, []);
});

check('an inbox that cannot be read is said as offline or unreadable, and read again next time', async () => {
  const offline = setup({ answers: { inbox: [Object.assign(new Error('Failed to fetch'), { offline: true })] } });
  await offline.controller.load();
  assert.deepStrictEqual([offline.state.inbox, offline.state.at], [{ available: false, reason: 'offline' }, 0]);
  const broken = setup({ answers: { inbox: [new Error('500')] } });
  await broken.controller.load();
  assert.deepStrictEqual(broken.state.inbox, { available: false, reason: 'unreadable' });
  for (const answer of [null, 'x', { available: true, findings: 'x' }]) {
    const odd = setup({ answers: { inbox: [answer] } });
    await odd.controller.load();
    assert.deepStrictEqual(odd.state.inbox, { available: false, reason: 'unreadable' }, JSON.stringify(answer));
  }
});

check('owners are read once per repository, and kept while the inbox is read again', async () => {
  const gate = held();
  const s = setup({ gates: { 'owners-demo': gate } });
  await s.controller.load();
  await settle();
  assert.strictEqual(s.state.owners.get('octo/demo'), 'pending');
  assert.deepStrictEqual(s.page.view.shown[0].owners, [], 'no owners named while they are read');
  /* Refresh while the owners are read: they belong to the repository, not to the read. */
  await s.controller.load(true);
  gate.release();
  await settle();
  assert.deepStrictEqual(s.state.owners.get('octo/demo'), [{ pattern: '*', owners: ['@octo/web'] }]);
  assert.deepStrictEqual(s.page.view.shown[0].owners, ['@octo/web:src/a.js']);
  assert.strictEqual(s.of('api').filter(entry => entry[1].endsWith('/codeowners')).length, 2, 'once per repository');
  const hidden = setup();
  hidden.page.showing = false;
  await hidden.controller.load();
  const drawn = hidden.of('render').length;
  await settle();
  assert.strictEqual(hidden.of('render').length, drawn, 'not drawn when the inbox is not showing');
  const failing = setup({ answers: { codeowners: { demo: new Error('x'), other: new Error('x') } } });
  await failing.controller.load();
  await settle();
  assert.deepStrictEqual(failing.state.owners.get('octo/demo'), [], 'no owners, not pending for good');
  const cleared = held();
  const left = setup({ gates: { 'owners-demo': cleared } });
  await left.controller.load();
  await settle();
  left.controller.clear();
  cleared.release();
  await settle();
  assert.strictEqual(left.state.owners.has('octo/demo'), false, 'owners read for a session let go of are not kept');
});

check('filters, selection and rows changed from the inbox; a finding opened in its own tool', async () => {
  const s = setup();
  s.controller.show();
  await settle();
  const a = s.actions = s.page.actions;
  a.filter({ query: 'token' }, { keepFocus: true });
  assert.deepStrictEqual(s.state.filters, { view: 'open', query: 'token' });
  assert.deepStrictEqual(s.of('route').at(-1), ['route', '{"view":"open","query":"token"}']);
  a.select({ key: 'a', id: 'id-a' }, true);
  a.select({ key: 'b' }, true);
  a.select({ key: 'b' }, false);
  assert.deepStrictEqual([...s.state.selected.keys()], ['a']);
  s.state.progress = 'old';
  a.clearSelection();
  assert.deepStrictEqual([s.state.selected.size, s.state.progress], [0, '']);
  a.expand({ key: 'a' }, true);
  a.expand({ key: 'b' }, true);
  a.expand({ key: 'b' }, false);
  assert.deepStrictEqual([...s.state.expanded], ['a']);
  a.open({ owner: 'octo', repo: 'demo', source: 'exposure' });
  a.open({ owner: 'octo', repo: 'demo', source: 'audit' });
  assert.deepStrictEqual(s.of('tool'), [['tool', 'octo', 'demo', 'exposure'], ['tool', 'octo', 'demo', 'audit']]);
});

check('the search keeps its focus and caret across a redraw; nothing is drawn without the inbox\u2019s place', async () => {
  const s = setup();
  s.page.focus = { caret: 3 };
  s.controller.paint({ keepFocus: true });
  assert.deepStrictEqual(s.log.slice(-1), [['restore', 3]]);
  s.controller.paint();
  assert.strictEqual(s.of('restore').length, 1, 'kept only when asked');
  const gone = setup();
  gone.page.present = false;
  gone.controller.paint();
  assert.deepStrictEqual(gone.log, []);
});

check('a finding\u2019s record of decisions drawn in place, read once; a record not answered is said so and can be read again', async () => {
  const s = setup({ answers: { events: { events: [
    { event: 'decided', disposition: 'accepted-risk', reason: 'compensating-control', actor: 'ada', at: '2026-11-20T10:00:00Z' },
    { event: 'reopened', actor: '', at: null },
    { event: 'decided', disposition: 'other', actor: 'bo', at: '2026-11-21' }] } } });
  s.controller.show();
  await settle();
  const host = fakeHost();
  s.page.actions.events({ owner: 'octo', repo: 'demo', id: 'a b' }, host);
  await settle();
  assert.strictEqual(s.of('api').at(-1)[1], '/api/repo/octo/demo/code-audit/findings/a%20b/triage-events');
  const [list] = host.children;
  assert.strictEqual(list.className, 'fi-timeline');
  assert.deepStrictEqual(list.children.map(entry => [entry.children[0].className, entry.children[0].dateTime, entry.children[0].textContent, entry.children[1].textContent]), [
    ['fi-when', '2026-11-20T10:00:00Z', 'day:2026-11-20T10:00:00Z', 'Accepted the risk by ada \u2014 compensating control'],
    ['fi-when', '', '', 'Reopened by someone'],
    ['fi-when', '2026-11-21', 'day:2026-11-21', 'Decided by bo']]);
  s.page.actions.events({ owner: 'octo', repo: 'demo', id: 'a b' }, host);
  await settle();
  assert.strictEqual(s.of('api').filter(entry => entry[1].endsWith('/triage-events')).length, 1, 'read once');
  const none = setup({ answers: { events: { events: [] } } });
  none.controller.show();
  await settle();
  const empty = fakeHost();
  none.page.actions.events({ owner: 'octo', repo: 'demo', id: 'a' }, empty);
  await settle();
  assert.deepStrictEqual(empty.children.map(node => [node.tag, node.textContent]), [['p', 'Nobody has decided anything about this finding.']]);
  for (const answer of [new Error('x'), null, { events: 'x' }]) {
    const failed = setup({ answers: { events: answer } });
    failed.controller.show();
    await settle();
    const box = fakeHost();
    failed.page.actions.events({ owner: 'octo', repo: 'demo', id: 'a' }, box);
    await settle();
    assert.deepStrictEqual([box.children.map(node => node.textContent), box.dataset.loaded], [['The team\u2019s decisions about this finding could not be read here.'], ''], JSON.stringify(answer));
  }
});

check('findings decided together through each one\u2019s own route; failures named; the inbox read again', async () => {
  const s = setup({ answers: { triage: path => (path.includes('/other/') ? Promise.reject(new Error('Not a reviewer')) : {}) } });
  s.controller.show();
  await settle();
  s.page.actions.select(ITEM('a'), true);
  s.page.actions.select(ITEM('b', { repo: 'other' }), true);
  s.page.actions.decide({ disposition: 'accepted-risk', reason: 'mitigated', expiresInDays: 30 });
  await settle();
  const posts = s.of('api').filter(entry => entry[2]);
  assert.deepStrictEqual(posts.map(entry => [entry[1], JSON.parse(entry[2]).body]), [
    ['/api/repo/octo/demo/code-audit/findings/id-a/triage', { rule: 'R-a', disposition: 'accepted-risk', reason: 'mitigated', expiresInDays: 30 }],
    ['/api/repo/octo/other/code-audit/findings/id-b/triage', { rule: 'R-b', disposition: 'accepted-risk', reason: 'mitigated', expiresInDays: 30 }]]);
  assert.ok(s.log.some(entry => entry[0] === 'render' && entry[2] === 'Deciding 1 of 2\u2026') && s.log.some(entry => entry[0] === 'render' && entry[2] === 'Deciding 2 of 2\u2026'));
  assert.strictEqual(s.state.progress, '1 decided; 1 could not be: octo/other: Not a reviewer');
  assert.deepStrictEqual([...s.state.selected.keys()], ['b'], 'the one that failed stays selected');
  assert.deepStrictEqual([s.of('toast'), s.of('posture').length], [[['toast', '1 finding decided', 'ok']], 1]);
  assert.strictEqual(s.of('api').filter(entry => entry[1] === '/api/workspace/findings').length, 2, 'read again');
  const none = setup({ answers: { triage: new Error('') } });
  none.controller.show();
  await settle();
  for (const key of ['a', 'b', 'c', 'd', 'e']) none.page.actions.select(ITEM(key), true);
  none.page.actions.decide({ disposition: 'false-positive', reason: 'validated' });
  await settle();
  assert.strictEqual(none.state.progress, '0 decided; 5 could not be: octo/demo: refused; octo/demo: refused; octo/demo: refused\u2026');
  assert.deepStrictEqual(none.of('render').at(-1), ['render', 'ready', none.state.progress], 'the failures drawn');
  assert.strictEqual(JSON.parse(none.of('api').filter(entry => entry[2])[0][2]).body.expiresInDays, undefined, 'no days for a false positive');
  assert.deepStrictEqual(none.of('toast'), []);
  const empty = setup();
  empty.controller.show();
  await settle();
  const before = empty.log.length;
  empty.page.actions.decide({ disposition: 'false-positive', reason: 'validated' });
  await settle();
  assert.deepStrictEqual([empty.log.length, empty.state.progress], [before, ''], 'nothing selected, nothing decided or said');
});

check('a decision for several findings stops when the session changes, and one at a time', async () => {
  const s = setup({ duringDecide: (page, log) => { if (log.filter(entry => entry[0] === 'api' && entry[2]).length === 1) page.epoch += 1; } });
  s.controller.show();
  await settle();
  for (const key of ['a', 'b', 'd']) s.page.actions.select(ITEM(key), true);
  s.page.actions.decide({ disposition: 'false-positive', reason: 'validated' });
  await settle();
  assert.strictEqual(s.of('api').filter(entry => entry[2]).length, 1, 'the rest not decided as whoever is signed in now');
  assert.strictEqual(s.state.progress, '1 decided; the session changed, so the rest were not.');
  assert.deepStrictEqual([s.of('toast'), s.state.deciding], [[], false]);
  const other = setup({ duringDecide: page => { page.identity = { login: 'mallory' }; } });
  other.controller.show();
  await settle();
  for (const key of ['a', 'b']) other.page.actions.select(ITEM(key), true);
  other.page.actions.decide({ disposition: 'false-positive', reason: 'validated' });
  await settle();
  assert.strictEqual(other.of('api').filter(entry => entry[2]).length, 1);
  const gate = held();
  const busy = setup({ answers: { triage: () => gate.promise } });
  busy.controller.show();
  await settle();
  busy.page.actions.select(ITEM('a'), true);
  busy.page.actions.decide({ disposition: 'false-positive', reason: 'validated' });
  busy.page.actions.decide({ disposition: 'false-positive', reason: 'validated' });
  await settle();
  assert.strictEqual(busy.of('api').filter(entry => entry[2]).length, 1, 'one decision at a time');
  gate.release();
  await settle();
});

check('what was decided elsewhere or is no longer listed does not stay selected; clearing lets go of everything', async () => {
  const s = setup({ answers: { inbox: [INBOX(), { available: true, findings: [ITEM('a', { decision: { disposition: 'false-positive' } }), ITEM('b')] }] } });
  s.controller.show();
  await settle();
  for (const key of ['a', 'b', 'd']) s.page.actions.select(ITEM(key), true);
  await s.controller.load(true);
  assert.deepStrictEqual([...s.state.selected.keys()], ['b']);
  s.state.expanded.add('a');
  s.state.progress = 'x';
  s.controller.clear();
  assert.deepStrictEqual([s.state.inbox, s.state.selected.size, s.state.expanded.size, s.state.owners.size, s.state.at, s.state.progress], [null, 0, 0, 0, 0, '']);
  const gate = held();
  const late = setup({ gates: { inbox1: gate } });
  const reading = late.controller.load();
  late.controller.clear();
  gate.release();
  await reading;
  assert.strictEqual(late.state.inbox, null, 'a read from before clearing is dropped');
});

(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  if (failed) { console.error(`page findings: ${failed} of ${checks.length} checks failed`); process.exit(1); }
  console.log(`page findings: ${checks.length} checks passed`);
})();
