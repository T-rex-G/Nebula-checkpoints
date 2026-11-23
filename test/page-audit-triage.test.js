'use strict';

/*
 * The audit's decisions, asked directly
 * (features/uranus/audit-triage-controller.ts): a finding triaged from its
 * dialog, a decision taken back, a finding's decisions read back, the audit
 * re-scored after each, and a finding opened at its line; and every answer
 * for an audit the reader has left changing nothing.
 */

const assert = require('assert');
const au = require('../apps/web/src/features/uranus/audit-controller.ts');
const at = require('../apps/web/src/features/uranus/audit-triage-controller.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const NOW = Date.parse('2026-11-23T12:00:00Z');
const VOCABULARY = {
  dispositions: [{ id: 'false-positive', label: 'False positive', hint: 'Not a flaw' }, { id: 'accepted-risk', label: 'Accept <risk>' }, { id: 'BAD id', label: 'x' }],
  reasons: [{ id: 'validated', disposition: 'false-positive', label: 'Checked before use' }, { id: 'test-only', disposition: 'false-positive', label: 'Test code' },
    { id: 'mitigated', disposition: 'accepted-risk', label: 'Mitigated & watched' }, { id: 'Bad Reason', disposition: 'false-positive', label: 'x' }],
  acceptDays: { choices: [30, 90, 1.5], default: 90 }
};
const finding = (id, extra = {}) => ({ id, rule: 'SEC-001', category: 'injection', severity: 'critical', verdict: 'confirmed', title: `Finding <${id}>`, path: 'src/a.js', line: 12, ...extra });
const RESULT = () => ({ grade: 'F', score: 40, findings: [finding('a', { triage: { lapsed: true }, clock: { due: 1 }, reach: { auth: 'open' }, detail: { intel: { exploited: true }, usage: { tier: 'runtime' }, risk: { score: 7.5 }, direct: true } }), finding('b', { detail: { direct: 'yes', risk: { score: 'high' } } })],
  suppressed: [{ ...finding('c'), suppression: { triage: { disposition: 'false-positive' } } }], ledger: [{ id: 'SEC-001', confirmed: 2, toConfirm: 0 }, { id: 'SEC-009', confirmed: 1 }], categories: [{ id: 'injection' }], priorities: ['a'] });

function setup(options = {}) {
  const log = [];
  let view = au.blankAuditView('octo/demo@main');
  Object.assign(view, { status: 'done', result: RESULT(), triage: { status: 'ready', canDecide: true, vocabulary: VOCABULARY, decisions: [{ findingId: 'b' }] } }, options.view || {});
  const routes = {
    triage: { decision: { findingId: 'a', disposition: 'false-positive', reason: 'validated', decidedBy: 'ada', decidedAt: '2026-11-23T12:00:00Z', expiresAt: null } },
    reopen: {},
    'triage-events': { events: [{ event: 'decided', disposition: 'accepted-risk', reason: 'mitigated', expiresAt: '2027-02-21T00:00:00Z', actor: 'ada <a>', at: '2026-11-20T10:00:00Z' }, { event: 'reopened', actor: 'bo', at: '2026-11-21T09:30:00Z"><b' }] },
    score: { score: 55, grade: 'D', capped: false, capReason: null, ledger: [{ id: 'SEC-001', confirmed: 1, toConfirm: 0 }], categories: [{ id: 'x' }], priorities: 'none' },
    ...(options.routes || {})
  };
  const page = { opened: null, editor: 'editor' in options ? options.editor : { calls: [] } };
  const triage = at.createAuditTriage({
    api: async (path, init) => {
      log.push(['api', path, init ? JSON.stringify(init) : '']);
      const name = path === '/api/code-audit/score' ? 'score' : path.split('/').pop();
      if (options.during && options.during[name]) options.during[name]({ setView: next => { view = next; } });
      const answer = routes[name];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer() : answer;
    },
    work: () => ({ owner: 'octo', repo: 'demo', branch: 'main' }),
    view: () => view,
    modal: async request => {
      log.push(['modal', request.title]);
      page.request = request;
      if (options.duringModal) options.duringModal({ setView: next => { view = next; } });
      return 'answer' in options ? options.answer : true;
    },
    chosen: () => options.chosen || { disposition: 'false-positive', reason: 'validated', days: '' },
    paint: () => log.push(['paint']),
    metrics: () => log.push(['metrics']),
    toast: (message, kind) => log.push(['toast', message, kind]),
    now: () => NOW,
    showEditor: () => log.push(['editor']),
    openFile: async path => { log.push(['open', path]); },
    editor: () => (page.editor ? { setCursor: c => page.editor.calls.push(['cursor', c]), scrollIntoView: (c, m) => page.editor.calls.push(['scroll', c, m]), focus: () => page.editor.calls.push(['focus']) } : null)
  });
  const of = kind => log.filter(entry => entry[0] === kind);
  return { triage, log, of, page, view: () => view };
}

check('the audit\u2019s words for days and decisions, and the reasons offered for a decision', () => {
  assert.strictEqual(at.auditDay('2027-01-02T12:00:00Z'), new Date('2027-01-02T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
  assert.strictEqual(at.auditDay('soon'), '');
  assert.strictEqual(at.auditMoment(null), new Date(null).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
  assert.strictEqual(at.auditMoment('x'), '');
  assert.deepStrictEqual(at.TRIAGE_EVENT_WORD, { 'false-positive': 'Marked a false positive', 'accepted-risk': 'Accepted the risk' });
  assert.strictEqual(at.reasonOptions(VOCABULARY, 'false-positive'), '<option value="validated" selected>Checked before use</option><option value="test-only">Test code</option>');
  assert.strictEqual(at.reasonOptions(VOCABULARY, 'accepted-risk'), '<option value="mitigated" selected>Mitigated &amp; watched</option>');
  assert.strictEqual(at.reasonOptions({}, 'accepted-risk'), '');
});

check('a finding triaged: its dialog, the decision recorded, the audit re-scored and drawn, and the clocks read again', async () => {
  const s = setup();
  const target = s.view().result.findings[0];
  await s.triage.decide(target);
  const body = s.page.request.bodyHTML;
  assert.ok(body.includes('<b>Finding &lt;a&gt;</b><span class="mono">src/a.js:12 \u00b7 SEC-001</span>'), body.slice(0, 200));
  assert.ok(body.includes('value="false-positive" checked') && body.includes('value="accepted-risk">') && !body.includes('BAD id'));
  assert.ok(body.includes('<b>Accept &lt;risk&gt;</b><small></small>') && body.includes('<b>False positive</b><small>Not a flaw</small>'));
  assert.ok(body.includes(`<option value="90" selected>90 days, until ${at.auditDay(NOW + 90 * 864e5)}</option>`) && !body.includes('1.5 days'));
  assert.deepStrictEqual(s.log.filter(entry => entry[0] === 'api').map(entry => [entry[1], entry[2]]), [
    ['/api/repo/octo/demo/code-audit/findings/a/triage', JSON.stringify({ method: 'POST', body: { rule: 'SEC-001', disposition: 'false-positive', reason: 'validated' } })],
    ['/api/code-audit/score', JSON.stringify({ method: 'POST', body: { findings: [{ id: 'b', rule: 'SEC-001', category: 'injection', severity: 'critical', verdict: 'confirmed', open: false, exploited: false, tier: null, risk: null, direct: false }] } })]
  ]);
  const result = s.view().result;
  assert.deepStrictEqual(result.findings.map(item => item.id), ['b']);
  const moved = result.suppressed.at(-1);
  assert.deepStrictEqual([moved.id, moved.triage, moved.clock, moved.suppression], ['a', undefined, undefined,
    { triage: { disposition: 'false-positive', reason: 'validated', decidedBy: 'ada', decidedAt: '2026-11-23T12:00:00Z', expiresAt: null } }]);
  assert.deepStrictEqual(s.view().triage.decisions.map(item => item.findingId), ['a', 'b']);
  assert.deepStrictEqual([result.score, result.grade, result.categories, result.priorities, result.ledger],
    [55, 'D', [{ id: 'x' }], ['a'], [{ id: 'SEC-001', confirmed: 1, toConfirm: 0 }, { id: 'SEC-009', confirmed: 1 }]]);
  assert.deepStrictEqual(s.log.slice(-3), [['toast', 'Recorded as a false positive', 'ok'], ['paint'], ['metrics']]);
});

check('the dialog keeps the reasons and the days to the decision chosen', async () => {
  const s = setup({ answer: false });
  await s.triage.decide(s.view().result.findings[1]);
  const listeners = [];
  const nodes = { reason: { innerHTML: '' }, wrap: { hidden: true } };
  let checked = { value: 'accepted-risk' };
  s.page.request.onOpen({
    querySelector: selector => (selector.includes(':checked') ? checked : selector === '#triageReason' ? nodes.reason : nodes.wrap),
    querySelectorAll: () => [{ addEventListener: (type, run) => listeners.push([type, run]) }, { addEventListener: (type, run) => listeners.push([type, run]) }]
  });
  assert.deepStrictEqual(listeners.map(entry => entry[0]), ['change', 'change']);
  listeners[0][1]();
  assert.deepStrictEqual([nodes.reason.innerHTML, nodes.wrap.hidden], ['<option value="mitigated" selected>Mitigated &amp; watched</option>', false]);
  checked = null;
  listeners[1][1]();
  assert.deepStrictEqual([nodes.reason.innerHTML, nodes.wrap.hidden], ['', true]);
  assert.deepStrictEqual(s.of('api'), [], 'dismissed: nothing recorded');
  const where = setup({ answer: false });
  await where.triage.decide({ id: 'z', rule: 'R', title: 't', where: 'package.json' });
  assert.ok(where.page.request.bodyHTML.includes('<span class="mono">package.json \u00b7 R</span>'));
  const whole = setup({ answer: false });
  await whole.triage.decide({ id: 'z', rule: 'R', title: 't', path: 'a.js' });
  assert.ok(whole.page.request.bodyHTML.includes('<span class="mono">a.js \u00b7 R</span>'));
  const none = setup({ answer: false });
  await none.triage.decide({ id: 'z', rule: 'R', title: 't' });
  assert.ok(none.page.request.bodyHTML.includes('<span class="mono">whole repository \u00b7 R</span>'));
  const odd = setup({ routes: {}, view: { triage: { status: 'ready', vocabulary: VOCABULARY, decisions: [{ findingId: 'a', disposition: 'accepted-risk' }, { findingId: 'b' }] } } });
  await odd.triage.decide(finding('a b'));
  assert.strictEqual(odd.of('api')[0][1], '/api/repo/octo/demo/code-audit/findings/a%20b/triage');
  assert.deepStrictEqual(odd.view().triage.decisions.map(item => [item.findingId, item.disposition]), [['a', 'false-positive'], ['b', undefined]], 'the earlier decision about it replaced');
  const usual = setup({ answer: false, view: { triage: { status: 'ready', vocabulary: { ...VOCABULARY, acceptDays: null } } } });
  await usual.triage.decide(finding('b'));
  assert.ok(usual.page.request.bodyHTML.includes('<option value="30">30 days') && usual.page.request.bodyHTML.includes('<option value="180">180 days'));
});

check('a risk accepted for the days chosen; nothing offered without a vocabulary or an audit', async () => {
  const s = setup({ chosen: { disposition: 'accepted-risk', reason: 'mitigated', days: '30' }, routes: { triage: { decision: { findingId: 'b', disposition: 'accepted-risk', reason: 'mitigated', expiresAt: '2026-12-23T00:00:00Z' } } } });
  await s.triage.decide(finding('b'));
  assert.deepStrictEqual(JSON.parse(s.of('api')[0][2]).body, { rule: 'SEC-001', disposition: 'accepted-risk', reason: 'mitigated', expiresInDays: 30 });
  assert.deepStrictEqual(s.of('toast').at(-1), ['toast', `Risk accepted until ${at.auditDay('2026-12-23T00:00:00Z')}`, 'ok']);
  for (const view of [{ triage: { status: 'ready' } }, { triage: { status: 'ready', vocabulary: { dispositions: [] } } }, { result: null }]) {
    const off = setup({ view });
    await off.triage.decide(finding('a'));
    assert.deepStrictEqual(off.log, [], JSON.stringify(view));
  }
  const nothing = setup();
  await nothing.triage.decide(null);
  assert.deepStrictEqual(nothing.log, []);
});

check('a decision for an audit the reader has left changes nothing; a decision not said back is said so; a failure said', async () => {
  const left = setup({ duringModal: page => page.setView(au.blankAuditView('octo/demo@dev')) });
  await left.triage.decide(finding('a'));
  assert.deepStrictEqual(left.of('api'), [], 'not recorded for an audit no longer shown');
  const ran = setup({ during: { triage: page => page.setView({ ...au.blankAuditView('octo/demo@main'), result: RESULT() }) } });
  const before = ran.view;
  await ran.triage.decide(finding('a'));
  assert.deepStrictEqual([ran.of('api').length, ran.of('toast'), ran.of('paint')], [1, [], []]);
  void before;
  for (const answer of [{}, null, { decision: { disposition: 3 } }]) {
    const bare = setup({ routes: { triage: answer } });
    await bare.triage.decide(finding('a'));
    assert.deepStrictEqual([bare.of('toast'), bare.view().result.findings.length, bare.of('api').length], [[['toast', 'The decision was recorded. Refresh to see it.', 'ok']], 2, 1], JSON.stringify(answer));
  }
  for (const [error, said] of [[new Error('Not a reviewer'), 'Not a reviewer'], [new Error(''), 'The decision could not be recorded.']]) {
    const failed = setup({ routes: { triage: error } });
    await failed.triage.decide(finding('a'));
    assert.deepStrictEqual(failed.of('toast'), [['toast', said, 'err']]);
  }
  const unread = setup({ view: { triage: { status: 'forbidden', vocabulary: VOCABULARY } } });
  await unread.triage.decide(finding('a'));
  assert.deepStrictEqual(unread.view().triage.decisions, undefined, 'decisions not read are not invented');
});

check('a scoring that fails or answers without a score leaves the grade and says so; one for another audit changes nothing', async () => {
  for (const score of [new Error('x'), { grade: 'B' }, { score: 70 }, { score: NaN, grade: 'B' }]) {
    const s = setup({ routes: { score } });
    await s.triage.decide(finding('a'));
    assert.deepStrictEqual([s.view().result.grade, s.view().result.score], ['F', 40], JSON.stringify(score));
    assert.deepStrictEqual(s.of('toast')[0], ['toast', 'The grade will reflect this decision on the next audit', 'ok']);
  }
  const quiet = setup({ routes: { score: null } });
  await quiet.triage.decide(finding('a'));
  assert.deepStrictEqual([quiet.view().result.grade, quiet.of('toast').length], ['F', 1], 'no scoring answer: the grade kept, nothing said of it');
  const plain = setup({ routes: { score: { score: 60, grade: 'D', ledger: 'x' } }, view: { result: { ...RESULT(), ledger: null } } });
  await plain.triage.decide(finding('a'));
  assert.deepStrictEqual([plain.view().result.grade, plain.view().result.ledger, plain.view().result.categories], ['D', null, [{ id: 'injection' }]]);
  const left = setup({ during: { score: page => page.setView({ ...au.blankAuditView('octo/demo@main'), result: RESULT() }) } });
  await left.triage.decide(finding('a'));
  assert.deepStrictEqual([left.view().result.grade, left.of('paint'), left.of('metrics')], ['F', [], []]);
  assert.deepStrictEqual(left.of('toast'), [['toast', 'Recorded as a false positive', 'ok']]);
});

check('a decision taken back: the finding counts again, or it already did; a failure said', async () => {
  const s = setup();
  await s.triage.reopen({ id: 'c' });
  assert.deepStrictEqual(s.of('api')[0].slice(1), ['/api/repo/octo/demo/code-audit/findings/c/reopen', JSON.stringify({ method: 'POST', body: {} })]);
  const result = s.view().result;
  assert.deepStrictEqual([result.suppressed.length, result.findings.map(item => item.id), result.findings.at(-1).suppression], [0, ['a', 'b', 'c'], undefined]);
  assert.deepStrictEqual(s.view().triage.decisions, [{ findingId: 'b' }]);
  assert.deepStrictEqual(s.log.slice(-3), [['toast', 'Reopened: the finding counts again', 'ok'], ['paint'], ['metrics']]);
  /* What the scoring is told of each finding: never its code. */
  assert.deepStrictEqual(JSON.parse(s.of('api')[1][2]).body.findings.slice(0, 2), [
    { id: 'a', rule: 'SEC-001', category: 'injection', severity: 'critical', verdict: 'confirmed', open: true, exploited: true, tier: 'runtime', risk: 7.5, direct: true },
    { id: 'b', rule: 'SEC-001', category: 'injection', severity: 'critical', verdict: 'confirmed', open: false, exploited: false, tier: null, risk: null, direct: false }]);
  const taken = setup({ routes: { reopen: Object.assign(new Error('gone'), { code: 'CODE_AUDIT_TRIAGE_NOT_FOUND' }) } });
  await taken.triage.reopen({ id: 'c' });
  assert.deepStrictEqual([taken.view().result.findings.map(item => item.id), taken.of('toast')], [['a', 'b', 'c'], [['toast', 'That decision was already taken back', 'ok']]], 'already taken back: it counts again here too');
  for (const [error, said] of [[new Error('No'), 'No'], [new Error(''), 'The finding could not be reopened.']]) {
    const failed = setup({ routes: { reopen: error } });
    await failed.triage.reopen({ id: 'c' });
    assert.deepStrictEqual([failed.of('toast'), failed.view().result.suppressed.length], [[['toast', said, 'err']], 1]);
  }
  const left = setup({ during: { reopen: page => page.setView(au.blankAuditView('octo/demo@dev')) } });
  await left.triage.reopen({ id: 'c' });
  assert.deepStrictEqual([left.of('toast'), left.of('paint')], [[], []]);
  const nothing = setup({ view: { result: null } });
  await nothing.triage.reopen({ id: 'c' });
  assert.deepStrictEqual(nothing.log, []);
});

check('a finding\u2019s decisions read back with who made them, their reasons in words; not shown over another audit', async () => {
  const s = setup();
  await s.triage.history({ id: 'a b', title: 'T & <x>', rule: 'R1' });
  assert.deepStrictEqual(s.of('api')[0][1], '/api/repo/octo/demo/code-audit/findings/a%20b/triage-events');
  const body = s.page.request.bodyHTML;
  assert.deepStrictEqual([s.page.request.title, s.page.request.okText, s.page.request.cancel], ['Decisions about this finding', 'Done', false]);
  assert.ok(body.includes('<b>T &amp; &lt;x&gt;</b><span class="mono">R1</span>'));
  assert.ok(body.includes(`Accepted the risk \u2014 Mitigated &amp; watched, until ${at.auditDay('2027-02-21T00:00:00Z')}</span>`), body);
  assert.ok(body.includes('ada &lt;a&gt; \u00b7 <time datetime="2026-11-20T10:00:00Z">'));
  assert.ok(body.includes('data-event="reopened"') && body.includes('>Reopened</span>'));
  assert.ok(body.includes('<time datetime="2026-11-21T09:30:00Z&quot;&gt;&lt;b">'), 'a time is an attribute\u2019s quoted text, never markup');
  const empty = setup({ routes: { 'triage-events': { events: 'x' } } });
  await empty.triage.history({ id: 'a' });
  assert.ok(empty.page.request.bodyHTML.includes('<p class="hint">No decisions recorded.</p>'));
  const unknown = setup({ routes: { 'triage-events': { events: [{ event: 'decided', disposition: 'other', reason: 'mystery', actor: 'x' }] } } });
  await unknown.triage.history({ id: 'a' });
  assert.ok(unknown.page.request.bodyHTML.includes('Decided \u2014 mystery'));
  const left = setup({ during: { 'triage-events': page => page.setView(au.blankAuditView('other/thing@main')) } });
  await left.triage.history({ id: 'a' });
  assert.deepStrictEqual(left.of('modal'), [], 'read for an audit since left');
  const failed = setup({ routes: { 'triage-events': new Error('') } });
  await failed.triage.history({ id: 'a' });
  assert.deepStrictEqual(failed.of('toast'), [['toast', 'The decisions could not be read.', 'err']]);
  const nothing = setup();
  await nothing.triage.history(null);
  assert.deepStrictEqual(nothing.log, []);
});

check('a finding opened in the editor at its line', async () => {
  const s = setup();
  await s.triage.open({ path: 'src/a.js', line: 12 });
  assert.deepStrictEqual(s.log, [['editor'], ['open', 'src/a.js']]);
  assert.deepStrictEqual(s.page.editor.calls, [['cursor', { line: 11, ch: 0 }], ['scroll', { line: 11, ch: 0 }, 120], ['focus']]);
  const top = setup();
  await top.triage.open({ path: 'a.js', line: 0 });
  assert.deepStrictEqual(top.page.editor.calls, [], 'no line, no cursor');
  const bare = setup({ editor: null });
  await bare.triage.open({ path: 'a.js', line: 3 });
  assert.deepStrictEqual(bare.log, [['editor'], ['open', 'a.js']]);
  const nowhere = setup();
  await nowhere.triage.open({ where: 'package.json' });
  await nowhere.triage.open(null);
  assert.deepStrictEqual(nowhere.log, []);
});

async function main() {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  if (failed) { console.error(`page audit triage: ${failed} of ${checks.length} checks failed`); process.exit(1); }
  console.log(`page audit triage: ${checks.length} checks passed`);
}
main();
