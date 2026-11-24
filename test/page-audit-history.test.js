'use strict';

/*
 * The audit's kept history, asked directly
 * (features/uranus/audit-history-controller.ts): the kept audits read with
 * the team's decisions, the clocks and the watch; a kept audit's findings;
 * the history cleared on a second press; and every answer for another
 * repository, branch or session dropped, while a read let go of never leaves
 * its part of the page waiting.
 */

const assert = require('assert');
const au = require('../apps/web/src/features/uranus/audit-controller.ts');
const ah = require('../apps/web/src/features/uranus/audit-history-controller.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const NOW = Date.parse('2026-11-23T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const AUDITS = [
  { id: 'k1', auditedAt: '2026-11-22T00:00:00Z', ref: 'main', watch: { checkedAt: new Date(NOW - 7 * HOUR).toISOString() } },
  { id: 'k2', auditedAt: '2026-11-15T00:00:00Z', ref: 'main' }
];

/* Answers by the path asked, each either a value, an Error, or held until released. */
function setup(options = {}) {
  const log = [];
  const page = { work: 'work' in options ? options.work : { owner: 'octo', repo: 'demo', branch: 'main' }, epoch: 1 };
  const key = () => (page.work ? `${page.work.owner}/${page.work.repo}@${page.work.branch}` : '');
  let view = au.blankAuditView(key());
  if (options.view) Object.assign(view, options.view);
  const routes = {
    history: { available: true, audits: structuredClone(AUDITS), branches: [{ ref: 'main', audits: 2 }] },
    watch: { available: true, audit: { id: 'k1', watch: { checkedAt: new Date(NOW).toISOString() } }, alerts: [], fresh: false, checkableAt: new Date(NOW + 5 * 60 * 1000).toISOString() },
    triage: { available: true, canDecide: true, vocabulary: { dispositions: [] }, decisions: [{ findingId: 'a' }] },
    metrics: { available: true, open: { overdue: 0 } },
    'history/k1': { findings: [{ id: 'a' }] },
    'history/clear': { cleared: 2 },
    ...(options.routes || {})
  };
  const held = new Map();
  const timers = [];
  const history = ah.createAuditHistory({
    api: async (path, init) => {
      log.push(['api', path, init && init.method, init && JSON.stringify(init.body)]);
      const name = decodeURIComponent(path.split('/code-audit/')[1].split('?')[0]);
      if (options.hold && options.hold.includes(name) && !held.has(name)) {
        await new Promise(resolve => held.set(name, resolve));
      }
      const answer = typeof routes[name] === 'function' ? routes[name](path) : routes[name];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    work: () => page.work,
    epoch: () => page.epoch,
    key,
    view: () => view,
    repaint: () => log.push(['repaint']),
    toast: (message, kind) => log.push(['toast', message, kind]),
    later: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); log.push(['later', ms]); return timer; },
    cancel: timer => { if (timer) timer.live = false; },
    now: () => NOW
  });
  const release = async name => { held.get(name)(); await settle(); };
  const asked = () => log.filter(entry => entry[0] === 'api').map(entry => entry[1].split('/code-audit/')[1]);
  return { history, page, log, view: () => view, setView: next => { view = next; }, release, asked, timers, key };
}

check('the kept audits are read with the decisions, the clocks and the watch, all for the branch open', async () => {
  const s = setup();
  await s.history.load();
  assert.deepStrictEqual(s.asked(), ['history?ref=main', 'triage', 'metrics?ref=main', 'watch?ref=main']);
  assert.deepStrictEqual([s.view().history.status, s.view().history.audits.map(audit => audit.id), s.view().history.branches], ['ready', ['k1', 'k2'], [{ ref: 'main', audits: 2 }]]);
  assert.deepStrictEqual([s.view().triage.status, s.view().triage.canDecide, s.view().triage.decisions], ['ready', true, [{ findingId: 'a' }]]);
  assert.deepStrictEqual(s.view().metrics, { status: 'ready', data: { available: true, open: { overdue: 0 } } });
  assert.strictEqual(s.view().watch.status, 'ready');
  assert.deepStrictEqual(s.timers.map(timer => timer.ms), [5 * 60 * 1000 + 50], 'drawn again when it may be checked again');
  assert.deepStrictEqual(s.view().history.audits[0].watch, { checkedAt: new Date(NOW).toISOString() }, 'the row says when the watch was checked');
});

check('Refresh while the watch is being checked leaves it checked, not checking for good', async () => {
  const s = setup({ hold: ['watch'] });
  const first = s.history.load();
  await settle();
  assert.strictEqual(s.view().watch.status, 'checking');
  const again = s.history.load();
  await settle();
  await s.release('watch');
  await Promise.all([first, again]);
  assert.strictEqual(s.asked().filter(path => path.startsWith('watch')).length, 2, 'the watch checked again for the history read again');
  assert.strictEqual(s.view().watch.status, 'ready');
});

check('Check now while the decisions and the clocks are being read leaves them read', async () => {
  const s = setup({ hold: ['triage', 'metrics'] });
  const loading = s.history.load();
  await settle();
  await s.history.watch({ force: true });
  await s.release('triage');
  await s.release('metrics');
  await loading;
  assert.deepStrictEqual([s.view().triage.status, s.view().metrics.status], ['ready', 'ready']);
});

check('a history read again keeps what it shows; the decisions once read are not read again; no history says so', async () => {
  const s = setup();
  await s.history.load();
  const before = s.asked().length;
  const again = s.history.load();
  assert.strictEqual(s.view().history.refreshing, true, 'what it shows kept while it is read again');
  await again;
  assert.deepStrictEqual(s.asked().slice(before), ['history?ref=main', 'metrics?ref=main', 'watch?ref=main']);
  const none = setup({ routes: { history: { available: true, audits: [], branches: [] } } });
  await none.history.load();
  assert.deepStrictEqual(none.asked(), ['history?ref=main', 'triage']);
  assert.deepStrictEqual([none.view().watch, none.view().metrics], [{ status: 'none' }, { status: 'idle' }]);
  for (const answer of [null, { available: false }]) {
    const off = setup({ routes: { history: answer } });
    await off.history.load();
    assert.deepStrictEqual([off.view().history, off.view().watch, off.asked()], [{ status: 'unavailable' }, { status: 'unavailable' }, ['history?ref=main']]);
    assert.deepStrictEqual(off.log.at(-1), ['repaint'], 'and drawn');
  }
  const failed = setup({ routes: { history: new Error('Rate limited') } });
  await failed.history.load();
  assert.deepStrictEqual(failed.view().history, { status: 'error', error: 'Rate limited' });
  const quiet = setup({ routes: { history: new Error('') } });
  await quiet.history.load();
  assert.deepStrictEqual(quiet.view().history, { status: 'error', error: 'The audit history could not be read.' });
  const odd = setup({ routes: { history: { available: true, audits: 'x' } } });
  await odd.history.load();
  assert.deepStrictEqual([odd.view().history, odd.asked()], [{ status: 'error', error: 'The audit history could not be read.' }, ['history?ref=main']], 'a history without its list is not an empty one');
  const bare = setup({ routes: { history: { available: true, audits: [], branches: null } } });
  await bare.history.load();
  assert.deepStrictEqual(bare.view().history.branches, []);
  const closed = setup({ work: null });
  await closed.history.load();
  assert.deepStrictEqual(closed.asked(), []);
  const branch = setup({ work: { owner: 'octo', repo: 'demo', branch: 'feature/x' } });
  await branch.history.load();
  assert.deepStrictEqual(branch.asked()[0], 'history?ref=feature%2Fx');
});

check('the watch: asked of OSV when stale or pressed, else answered from what was kept; its failures said', async () => {
  const fresh = setup({ view: { history: { status: 'ready', audits: [{ id: 'k1', watch: { checkedAt: new Date(NOW - HOUR).toISOString() } }] } } });
  const quiet = fresh.history.watch();
  assert.strictEqual(fresh.view().watch.status, 'loading');
  assert.strictEqual(fresh.log.filter(entry => entry[0] === 'repaint').length, 0, 'a check answered from what was kept is quiet');
  await quiet;
  const pressed = fresh.history.watch({ force: true });
  assert.deepStrictEqual([fresh.view().watch.status, fresh.log.at(-2)[0], fresh.log.at(-1)[0]], ['checking', 'repaint', 'api'], 'a press is said as it is asked');
  await pressed;
  assert.deepStrictEqual(fresh.asked(), ['watch?ref=main', 'watch?ref=main&refresh=1']);
  assert.deepStrictEqual(fresh.timers.map(timer => timer.live), [false, true], 'the redraw waited for is the latest check\u2019s');
  const closed = setup({ work: null, view: { history: { status: 'ready', audits: structuredClone(AUDITS) } } });
  await closed.history.watch({ force: true });
  assert.deepStrictEqual(closed.asked(), [], 'no repository, no watch');
  const past = setup({ view: { history: { status: 'ready', audits: structuredClone(AUDITS) } }, routes: { watch: { available: true, audit: { id: 'k1' }, alerts: [{}], fresh: false, checkableAt: new Date(NOW - 1000).toISOString() } } });
  await past.history.watch();
  assert.deepStrictEqual([past.timers, past.log.filter(entry => entry[0] === 'toast')], [[], []], 'checkable now: no redraw waited for; alerts already told: no toast');
  const single = setup({ view: { history: { status: 'ready', audits: structuredClone(AUDITS) } }, routes: { watch: { available: true, audit: { id: 'k1' }, alerts: [{}], fresh: true } } });
  await single.history.watch({ force: true });
  assert.deepStrictEqual(single.log.filter(entry => entry[0] === 'toast'), [['toast', '1 new item for demo since its last audit', 'ok']]);
  const unknown = setup({ view: { history: { status: 'ready', audits: [{ id: 'k1', watch: {} }] } } });
  const asking = unknown.history.watch();
  assert.strictEqual(unknown.view().watch.status, 'checking', 'a check of no known time is asked of OSV');
  await asking;
  const none = setup({ view: { history: { status: 'ready', audits: AUDITS } }, routes: { watch: { available: true, audit: null } } });
  await none.history.watch();
  assert.deepStrictEqual(none.view().watch, { status: 'none' });
  for (const [error, said] of [[Object.assign(new Error('x'), { status: 429 }), 'Checked moments ago. Try again in a few minutes.'], [new Error('x'), 'The watch could not be checked. Nothing is marked new, and nothing is marked clear.']]) {
    const s = setup({ view: { history: { status: 'ready', audits: structuredClone(AUDITS) }, watch: { status: 'ready', data: { kept: true } } }, routes: { watch: error } });
    await s.history.watch({ force: true });
    assert.deepStrictEqual(s.view().watch, { status: 'error', data: { kept: true }, error: said });
    assert.deepStrictEqual(s.log.at(-1), ['repaint'], 'the failure drawn');
  }
  const alerts = setup({ view: { history: { status: 'ready', audits: structuredClone(AUDITS) } }, routes: { watch: { available: true, audit: { id: 'k1' }, alerts: [{}, {}], fresh: true, checkableAt: null } } });
  await alerts.history.watch({ force: true });
  assert.deepStrictEqual(alerts.log.filter(entry => entry[0] === 'toast'), [['toast', '2 new items for demo since its last audit', 'ok']]);
  assert.deepStrictEqual(alerts.timers, [], 'no time to be checked again, no redraw waiting');
  const far = setup({ view: { history: { status: 'ready', audits: structuredClone(AUDITS) } }, routes: { watch: { available: true, audit: { id: 'k1' }, alerts: [], checkableAt: new Date(NOW + 2 * HOUR).toISOString() } } });
  await far.history.watch();
  assert.deepStrictEqual(far.timers, [], 'a redraw hours away is not waited for');
  const empty = setup();
  await empty.history.watch({ force: true });
  assert.deepStrictEqual(empty.asked(), [], 'no kept audit, no watch');
});

check('the redraw waiting for the watch is let go of with the watch, and draws nothing for another branch', async () => {
  const s = setup();
  await s.history.load();
  const [timer] = s.timers;
  s.page.work.branch = 'dev';
  const drawn = s.log.filter(entry => entry[0] === 'repaint').length;
  timer.run();
  assert.strictEqual(s.log.filter(entry => entry[0] === 'repaint').length, drawn);
  s.history.forgetWatch();
  assert.strictEqual(timer.live, false);
});

check('the clocks read again after a decision while the history is read, and a run ending mid-read, leave every part read', async () => {
  const s = setup({ hold: ['history'] });
  const reading = s.history.load();
  await settle();
  await s.history.metrics();
  await s.release('history');
  await reading;
  assert.deepStrictEqual([s.view().history.status, s.view().triage.status, s.view().watch.status], ['ready', 'ready', 'ready']);
  const ran = setup({ hold: ['triage', 'metrics'] });
  const loading = ran.history.load();
  await settle();
  /* A run ends: its view carries the history, the decisions and the clocks over, as they stand. */
  const held = ran.view();
  ran.setView({ ...au.blankAuditView(ran.key()), history: held.history, watch: held.watch, historyOpen: held.historyOpen, historyDetail: held.historyDetail, triage: held.triage, metrics: held.metrics, status: 'done' });
  await ran.release('triage');
  await ran.release('metrics');
  await loading;
  assert.deepStrictEqual([ran.view().triage.status, ran.view().metrics.status], ['ready', 'ready']);
});

check('the decisions: forbidden to a reader who is not a collaborator, otherwise failed or unavailable', async () => {
  for (const [answer, status] of [
    [Object.assign(new Error('x'), { code: 'GOVERNANCE_COLLABORATORS_ONLY' }), 'forbidden'],
    [Object.assign(new Error('x'), { status: 403 }), 'forbidden'],
    [new Error('x'), 'error'],
    [{ available: false }, 'unavailable'],
    [null, 'unavailable']
  ]) {
    const s = setup({ routes: { triage: answer } });
    await s.history.load();
    assert.strictEqual(s.view().triage.status, status, JSON.stringify(answer));
  }
  const odd = setup({ routes: { triage: { available: true, canDecide: 'yes', decisions: 'x' } } });
  await odd.history.load();
  assert.deepStrictEqual(odd.view().triage, { status: 'ready', canDecide: false, vocabulary: null, decisions: [] });
});

check('the clocks: read again on asking, their failure said, kept while read again', async () => {
  const s = setup();
  await s.history.load();
  const reading = s.history.metrics();
  assert.deepStrictEqual(s.view().metrics, { status: 'loading', data: { available: true, open: { overdue: 0 } } });
  await reading;
  assert.strictEqual(s.view().metrics.status, 'ready');
  const failed = setup({ routes: { metrics: new Error('x') } });
  await failed.history.load();
  assert.deepStrictEqual(failed.view().metrics, { status: 'error', error: 'The clocks could not be read.' });
  const off = setup({ routes: { metrics: { available: false } } });
  await off.history.load();
  assert.deepStrictEqual(off.view().metrics, { status: 'unavailable' });
});

check('a kept audit\u2019s findings: read once, said when gone, and kept by the view a finished run drew', async () => {
  const s = setup({ hold: ['history/k1'] });
  const reading = s.history.detail('k1');
  await settle();
  assert.deepStrictEqual(s.view().historyDetail.get('k1'), { status: 'loading' });
  await s.history.detail('k1');
  assert.strictEqual(s.asked().length, 1, 'one read at a time');
  /* A run ends while the row is read: the new view carries the history over. */
  s.setView({ ...au.blankAuditView(s.key()), historyDetail: s.view().historyDetail, status: 'done' });
  await s.release('history/k1');
  await reading;
  assert.deepStrictEqual(s.view().historyDetail.get('k1'), { status: 'ready', findings: [{ id: 'a' }] });
  const drawn = s.log.filter(entry => entry[0] === 'repaint').length;
  await s.history.detail('k1');
  assert.deepStrictEqual([s.asked().length, s.log.filter(entry => entry[0] === 'repaint').length], [1, drawn + 1], 'read once, drawn again');
  const named = setup({ routes: { 'history/a b': { findings: [] } } });
  await named.history.detail('a b');
  assert.deepStrictEqual(named.asked(), ['history/a%20b']);
  const gone = setup({ routes: { 'history/k1': Object.assign(new Error('x'), { code: 'CODE_AUDIT_NOT_FOUND' }) } });
  await gone.history.detail('k1');
  assert.deepStrictEqual(gone.view().historyDetail.get('k1'), { status: 'error', error: 'This audit is no longer kept.' });
  const failed = setup({ routes: { 'history/k1': new Error('x') } });
  await failed.history.detail('k1');
  assert.deepStrictEqual(failed.view().historyDetail.get('k1'), { status: 'error', error: 'This audit could not be read.' });
  for (const answer of [{ findings: 'x' }, {}, null]) {
    const odd = setup({ routes: { 'history/k1': answer } });
    await odd.history.detail('k1');
    assert.deepStrictEqual(odd.view().historyDetail.get('k1'), { status: 'error', error: 'This audit could not be read.' }, `${JSON.stringify(answer)} did not find nothing`);
  }
});

check('the history cleared on a second press within five seconds; its failure said and what it showed kept', async () => {
  const s = setup();
  await s.history.load();
  await s.history.clear();
  assert.strictEqual(s.view().historyArmed, true);
  const arm = s.timers.at(-1);
  assert.strictEqual(arm.ms, 5000);
  arm.run();
  assert.strictEqual(s.view().historyArmed, false, 'not pressed again in time');
  await s.history.clear();
  s.view().historyOpen.add('k1');
  await s.history.clear();
  assert.deepStrictEqual(s.log.filter(entry => entry[0] === 'api').at(-1), ['api', '/api/repo/octo/demo/code-audit/history/clear', 'POST', '{"confirm":"clear-audit-history"}']);
  assert.deepStrictEqual([s.view().history, s.view().watch, s.view().historyOpen.size, s.view().historyArmed], [{ status: 'ready', audits: [], branches: [] }, { status: 'none' }, 0, false]);
  assert.deepStrictEqual(s.log.filter(entry => entry[0] === 'toast').at(-1), ['toast', 'Cleared 2 kept audits of demo', 'ok']);
  const one = setup({ routes: { 'history/clear': { cleared: 1 } } });
  await one.history.load();
  await one.history.clear();
  await one.history.clear();
  assert.deepStrictEqual(one.log.filter(entry => entry[0] === 'toast').at(-1), ['toast', 'Cleared 1 kept audit of demo', 'ok']);
  const failed = setup({ routes: { 'history/clear': new Error('Not allowed') } });
  await failed.history.load();
  await failed.history.clear();
  await failed.history.clear();
  assert.deepStrictEqual([failed.view().history.clearing, failed.view().history.audits.length], [false, 2]);
  assert.deepStrictEqual(failed.log.filter(entry => entry[0] === 'toast').at(-1), ['toast', 'Not allowed', 'err']);
  const early = setup();
  await early.history.clear();
  assert.strictEqual(early.view().historyArmed, false, 'nothing to clear before the history is read');
});

check('every answer is dropped for another repository, branch or session, and a history let go of reads nothing more', async () => {
  for (const change of [page => { page.work.branch = 'dev'; }, page => { page.work = { owner: 'other', repo: 'thing', branch: 'main' }; }, page => { page.epoch += 1; }]) {
    const s = setup({ hold: ['history'] });
    const reading = s.history.load();
    await settle();
    change(s.page);
    await s.release('history');
    await reading;
    assert.deepStrictEqual([s.view().history, s.asked().length], [{ status: 'loading' }, 1]);
  }
  const s = setup({ hold: ['triage', 'watch'] });
  const reading = s.history.load();
  await settle();
  s.history.forget();
  await s.release('triage');
  await s.release('watch');
  await reading;
  assert.deepStrictEqual([s.view().triage.status, s.view().watch.status], ['loading', 'checking'], 'let go of, as the view that held them is');
  const armed = setup();
  await armed.history.load();
  await armed.history.clear();
  armed.history.forget();
  assert.strictEqual(armed.timers.at(-1).live, false);
});

async function main() {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  if (failed) { console.error(`page audit history: ${failed} of ${checks.length} checks failed`); process.exit(1); }
  console.log(`page audit history: ${checks.length} checks passed`);
}
main();
