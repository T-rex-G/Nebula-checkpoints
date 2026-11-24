'use strict';

/*
 * The Exposure screen at work, asked directly
 * (features/exposure/exposure-controller.ts): findings read and paged,
 * history and reports, a running scan followed, scans requested and
 * canceled, the two-press checks, the history cleared, and exports collected
 * whole -- each kept to the repository it was asked for.
 */

const assert = require('assert');
const { createExposure, freshExposureState } = require('../apps/web/src/features/exposure/exposure-controller.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const flush = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const NOW = Date.parse('2026-11-22T12:00:00Z');

function harness({ work = { owner: 'octo', repo: 'repo', branch: 'main' }, shown = true, hidden = false, readsHistory = true, me = { provider: 'github' } } = {}) {
  const state = { work, me, exposure: null };
  const log = [];
  const pending = [];
  const timers = [];
  const h = { state, log, pending, timers, shown, hidden, readsHistory, renders: 0, downloads: [] };
  const key = () => (state.work ? `github:${state.work.owner}/${state.work.repo}` : '');
  h.x = createExposure({
    state,
    api: (path, options) => new Promise((resolve, reject) => { log.push(['api', path, options === undefined ? null : options]); pending.push({ path, resolve, reject }); }),
    mutate: change => { change(state.exposure); log.push(['mutate']); },
    render: () => { h.renders += 1; },
    announce: message => log.push(['say', message]),
    invalidatePosture: () => log.push(['posture']),
    scopeKey: key,
    path: () => `${state.work.owner}/${state.work.repo}`,
    shown: () => h.shown,
    hidden: () => h.hidden,
    readsHistory: () => h.readsHistory,
    timers: { set: (run, ms) => { const t = { run, ms, cleared: false }; timers.push(t); return t; }, clear: t => { if (t) t.cleared = true; log.push(['clear-timer']); } },
    now: () => NOW,
    download: (name, text, type) => h.downloads.push([name, text, type]),
    reports: { exposureSarif: (rows, meta) => JSON.stringify({ sarif: rows.length, meta }), exposureCsv: rows => `csv:${rows.length}` }
  });
  h.answer = async (pattern, value) => {
    const at = pending.findIndex(p => pattern.test(p.path));
    assert.ok(at >= 0, `nothing asked for ${pattern}`);
    const [p] = pending.splice(at, 1);
    p.resolve(value);
    await flush();
  };
  h.refuse = async (pattern, error) => {
    const at = pending.findIndex(p => pattern.test(p.path));
    assert.ok(at >= 0, `nothing asked for ${pattern}`);
    const [p] = pending.splice(at, 1);
    p.reject(error);
    await flush();
  };
  h.says = () => log.filter(entry => entry[0] === 'say').map(entry => entry[1]);
  h.asked = () => log.filter(entry => entry[0] === 'api').map(entry => entry[1]);
  h.switch = () => { state.work = { owner: 'acme', repo: 'other', branch: 'main' }; state.exposure = freshExposureState('github:acme/other'); };
  return h;
}
const scan = (over = {}) => ({ scanId: 's1', state: 'running', coverage: 'unknown', createdAt: '2026-11-22T11:00:00Z', ...over });
const finding = (fingerprint, over = {}) => ({ fingerprint, rule: 'github-token', narration: { severity: 'critical' }, ...over });
const coded = (code, message = 'refused') => Object.assign(new Error(message), { code });

check('a fresh state holds nothing, and every reset gets every field', () => {
  const fresh = freshExposureState('k');
  assert.strictEqual(fresh.scopeKey, 'k');
  assert.deepStrictEqual(fresh.view, { severity: null, status: 'all', where: 'all', query: '' });
  assert.ok(fresh.expanded instanceof Set && fresh.openScans instanceof Set);
  assert.deepStrictEqual([fresh.scan, fresh.findings, fresh.history, fresh.historyDone, fresh.requestId, fresh.paged], [null, [], [], false, 0, false]);
  assert.notStrictEqual(freshExposureState().view, freshExposureState().view);
  assert.strictEqual(freshExposureState().scopeKey, '');
  const h = harness();
  const made = h.x.current();
  assert.strictEqual(h.state.exposure, made);
  assert.strictEqual(h.x.current(), made, 'made once');
  made.scopeKey = 'github:octo/repo';
  made.scan = scan();
  h.x.schedulePoll(made);
  h.x.clear();
  assert.notStrictEqual(h.state.exposure, made);
  assert.strictEqual(h.renders, 1);
  assert.strictEqual(h.timers[0].cleared, true, 'a screen let go of follows its scan no more');
});

check('findings are read for the open repository and its view, with the history beside them', async () => {
  const h = harness();
  h.x.current().scopeKey = 'stale';
  const done = h.x.load();
  const now = h.state.exposure;
  assert.strictEqual(now.scopeKey, 'github:octo/repo', 'another repository\u2019s state is replaced');
  assert.strictEqual(now.loading, true);
  assert.deepStrictEqual(h.asked(), ['/api/repo/octo/repo/exposure/scans?limit=20', '/api/repo/octo/repo/exposure/findings?limit=50'], 'the history asked first, beside the findings');
  await h.answer(/findings/, { findings: [finding('a')], total: 3, counts: { all: 3 }, nextCursor: 'c2', verifications: { a: { state: 'verified' } }, probes: { a: { state: 'denied' } } });
  await done;
  assert.deepStrictEqual(now.findings.map(f => f.fingerprint), ['a']);
  assert.deepStrictEqual([now.paged, now.total, now.counts, now.nextCursor, now.loading, now.error], [true, 3, { all: 3 }, 'c2', false, '']);
  assert.deepStrictEqual(now.verifications, { a: { state: 'verified' } });
  const more = h.x.load({ append: true });
  assert.strictEqual(h.asked().pop(), '/api/repo/octo/repo/exposure/findings?limit=50&cursor=c2');
  await h.answer(/findings\?limit=50&cursor/, { findings: [finding('b')], total: 3, counts: { all: 3 }, nextCursor: null, verifications: { b: { state: 'rejected' } } });
  await more;
  assert.deepStrictEqual(now.findings.map(f => f.fingerprint), ['a', 'b']);
  assert.deepStrictEqual(Object.keys(now.verifications), ['a', 'b'], 'answers already held are kept when paging on');
  assert.deepStrictEqual(now.probes, { a: { state: 'denied' } });
  await h.x.load({ append: true });
  assert.strictEqual(h.asked().length, 3, 'no next page, nothing asked');
  const unpaged = harness();
  const read = unpaged.x.load({ filterOnly: true });
  assert.deepStrictEqual(unpaged.asked(), ['/api/repo/octo/repo/exposure/findings?limit=50'], 'a view narrowed reads no history');
  await unpaged.answer(/findings/, { findings: [finding('a'), finding('b')], total: 2 });
  await read;
  assert.deepStrictEqual([unpaged.state.exposure.paged, unpaged.state.exposure.total, unpaged.state.exposure.counts], [false, 2, null]);
  const none = harness({ work: null });
  await none.x.load();
  assert.deepStrictEqual(none.log, []);
});

check('a failed read empties the list and says so; a changed cursor reads the view again; a list that is no page is a failure', async () => {
  const h = harness();
  const done = h.x.load({ filterOnly: true });
  await h.refuse(/findings/, new Error('down'));
  await done;
  assert.deepStrictEqual([h.state.exposure.findings, h.state.exposure.error, h.state.exposure.loading], [[], 'Findings could not be loaded for this repository. Refresh to try again.', false]);
  const again = h.x.load({ filterOnly: true });
  await h.answer(/findings/, { findings: [] });
  await again;
  assert.deepStrictEqual(h.says(), ['Findings loaded.'], 'recovery is said');
  assert.strictEqual(h.state.exposure.error, '');
  const stale = harness();
  const read = stale.x.load({ filterOnly: true });
  await stale.refuse(/findings/, coded('EXPOSURE_CURSOR_STALE'));
  assert.deepStrictEqual(stale.says(), ['Findings changed. Loading the current view.']);
  assert.strictEqual(stale.asked().length, 2, 'read again');
  await stale.answer(/findings/, { findings: [finding('z')] });
  await read;
  assert.deepStrictEqual(stale.state.exposure.findings.map(f => f.fingerprint), ['z']);
  const odd = harness();
  const nothing = odd.x.load({ filterOnly: true });
  await odd.answer(/findings/, null);
  await nothing;
  assert.strictEqual(odd.state.exposure.error, 'Findings could not be loaded for this repository. Refresh to try again.');
  const kept = harness();
  const first = kept.x.load({ filterOnly: true });
  await kept.answer(/findings/, { findings: [finding('a')], total: 1, counts: {}, nextCursor: 'n' });
  await first;
  const page = kept.x.load({ append: true });
  await kept.refuse(/cursor/, new Error('down'));
  await page;
  assert.deepStrictEqual(kept.state.exposure.findings.map(f => f.fingerprint), ['a'], 'a page more that fails keeps those shown');
});

check('a read overtaken by a newer one, or by another repository, is dropped', async () => {
  const h = harness();
  const first = h.x.load({ filterOnly: true });
  const second = h.x.load({ filterOnly: true });
  await h.answer(/findings/, { findings: [finding('old')] });
  await first;
  assert.deepStrictEqual(h.state.exposure.findings, []);
  assert.strictEqual(h.state.exposure.loading, true, 'the newer read is still on its way');
  await h.answer(/findings/, { findings: [finding('new')] });
  await second;
  assert.deepStrictEqual(h.state.exposure.findings.map(f => f.fingerprint), ['new']);
  const moved = harness();
  const read = moved.x.load({ filterOnly: true });
  const left = moved.state.exposure;
  moved.switch();
  await moved.answer(/findings/, { findings: [finding('a')] });
  await read;
  assert.deepStrictEqual(left.findings, []);
  assert.deepStrictEqual(moved.state.exposure.findings, []);
  const failing = harness();
  const failed = failing.x.load({ filterOnly: true });
  const gone = failing.state.exposure;
  failing.switch();
  await failing.refuse(/findings/, new Error('down'));
  await failed;
  assert.deepStrictEqual(failing.says(), []);
  assert.strictEqual(gone.error, '', 'a failure for a repository left is not written on its screen');
});

check('a running scan is followed every two seconds while the screen shows it, and its history entry with it', async () => {
  const h = harness();
  const held = h.x.current();
  held.scopeKey = 'github:octo/repo';
  held.scan = scan();
  held.history = [scan({ state: 'queued', findingCount: 0 }), scan({ scanId: 's0', state: 'complete' })];
  h.x.schedulePoll(held);
  assert.strictEqual(h.timers.length, 1);
  assert.strictEqual(h.timers[0].ms, 2000);
  h.timers[0].run();
  assert.deepStrictEqual(h.asked(), ['/api/repo/octo/repo/exposure/scans/s1']);
  await h.answer(/scans\/s1$/, { scan: scan({ state: 'running', filesScanned: 4 }) });
  assert.strictEqual(held.history[0].state, 'running');
  assert.strictEqual(held.history[0].findingCount, 0, 'the entry keeps what only the history holds');
  assert.strictEqual(h.timers.length, 2, 'followed again');
  h.timers[1].run();
  await h.answer(/scans\/s1$/, { scan: scan({ state: 'complete', coverage: 'complete' }) });
  await flush();
  assert.deepStrictEqual(h.says(), ['Scan Complete. Updating findings.']);
  assert.ok(h.log.some(entry => entry[0] === 'posture'));
  assert.ok(h.asked().some(path => path.startsWith('/api/repo/octo/repo/exposure/findings')), 'findings read again');
  for (const [over, label] of [[{ shown: false }, 'off screen'], [{}, 'settled']]) {
    const quiet = harness(over);
    const s = quiet.x.current();
    s.scopeKey = 'github:octo/repo';
    s.scan = label === 'settled' ? scan({ state: 'complete' }) : scan();
    quiet.x.schedulePoll(s);
    assert.strictEqual(quiet.timers.length, 0, label);
  }
  const elsewhere = harness();
  const other = elsewhere.x.current();
  other.scopeKey = 'github:someone/else';
  other.scan = scan();
  elsewhere.x.schedulePoll(other);
  assert.strictEqual(elsewhere.timers.length, 0, 'another repository\u2019s scan is not followed');
  const stopped = harness();
  const s2 = stopped.x.current();
  s2.scopeKey = 'github:octo/repo';
  s2.scan = scan();
  stopped.x.schedulePoll(s2);
  stopped.x.stopPoll();
  assert.strictEqual(stopped.timers[0].cleared, true, 'leaving the screen stops following the scan');
});

check('a hidden page waits; a status answer that is no scan, or fails, is said; a canceled scan is not resurrected', async () => {
  const h = harness({ hidden: true });
  const held = h.x.current();
  held.scopeKey = 'github:octo/repo';
  held.scan = scan();
  await h.x.refreshScan(held);
  assert.deepStrictEqual(h.asked(), [], 'nothing read while the page is hidden');
  assert.strictEqual(h.timers.length, 1);
  h.hidden = false;
  const failing = h.x.refreshScan(held);
  await h.answer(/scans\/s1$/, {});
  await failing;
  assert.strictEqual(held.error, 'The status check failed. Your scan may still be running. Retry the status check.');
  assert.deepStrictEqual(h.says(), [held.error]);
  const raced = harness();
  const r = raced.x.current();
  r.scopeKey = 'github:octo/repo';
  r.scan = scan();
  const reading = raced.x.refreshScan(r);
  r.scan = scan({ state: 'canceled' });
  await raced.answer(/scans\/s1$/, { scan: scan({ state: 'running' }) });
  await reading;
  assert.strictEqual(r.scan.state, 'canceled');
  const refusedAfterCancel = harness();
  const c = refusedAfterCancel.x.current();
  c.scopeKey = 'github:octo/repo';
  c.scan = scan();
  const read = refusedAfterCancel.x.refreshScan(c);
  c.scan = scan({ state: 'canceled' });
  await refusedAfterCancel.refuse(/scans\/s1$/, new Error('down'));
  await read;
  assert.deepStrictEqual([c.error, refusedAfterCancel.says()], ['', []]);
  const another = harness();
  const a = another.x.current();
  a.scopeKey = 'github:octo/repo';
  a.scan = scan();
  const asked = another.x.refreshScan(a);
  a.scan = scan({ scanId: 's2' });
  await another.answer(/scans\/s1$/, { scan: scan({ state: 'complete' }) });
  await asked;
  assert.strictEqual(a.scan.scanId, 's2', 'an answer for a scan no longer shown is dropped');
  const nothing = harness();
  await nothing.x.refreshScan(nothing.x.current());
  assert.deepStrictEqual(nothing.asked(), []);
});

check('the history is read a page at a time, the newest scan shown when this session started none', async () => {
  const h = harness();
  const held = h.x.current();
  const done = h.x.loadHistory();
  assert.strictEqual(held.historyLoading, true);
  await h.answer(/scans\?limit=20$/, { scans: Array.from({ length: 20 }, (_, i) => scan({ scanId: `s${i}`, createdAt: `t${i}`, state: 'complete' })) });
  await done;
  assert.deepStrictEqual([held.history.length, held.historyDone, held.historyLoading, held.scan.scanId], [20, false, false, 's0']);
  const more = h.x.loadHistory({ more: true });
  assert.strictEqual(h.asked().pop(), '/api/repo/octo/repo/exposure/scans?limit=20&beforeAt=t19&beforeId=s19');
  await h.answer(/beforeId/, { scans: [scan({ scanId: 'old', state: 'complete' })] });
  await more;
  assert.deepStrictEqual([held.history.length, held.historyDone, held.scan.scanId], [21, true, 's0']);
  const busy = harness();
  busy.x.current().historyLoading = true;
  await busy.x.loadHistory();
  assert.deepStrictEqual(busy.asked(), []);
  const own = harness();
  own.x.current().scan = scan({ scanId: 'mine' });
  const read = own.x.loadHistory();
  await own.answer(/scans/, { scans: [scan({ scanId: 'other', state: 'complete' })] });
  await read;
  assert.strictEqual(own.state.exposure.scan.scanId, 'mine', 'a scan this session started stays');
  const failed = harness();
  const f = failed.x.loadHistory();
  await failed.refuse(/scans/, new Error('down'));
  await f;
  assert.strictEqual(failed.state.exposure.historyError, 'Scan history could not be loaded.');
  const odd = harness();
  const o = odd.x.loadHistory();
  await odd.answer(/scans/, { scans: 'none' });
  await o;
  assert.deepStrictEqual([odd.state.exposure.history, odd.state.exposure.historyDone], [[], true]);
  const moved = harness();
  const m = moved.x.loadHistory();
  const left = moved.state.exposure;
  moved.switch();
  await moved.answer(/scans/, { scans: [scan()] });
  await m;
  assert.deepStrictEqual(left.history, []);
  assert.strictEqual(left.historyLoading, true, 'a state let go of is left as it was');
});

check('a scan\u2019s report is read whole, bounded, and read once', async () => {
  const h = harness();
  const held = h.x.current();
  const done = h.x.loadReport('s 1');
  assert.deepStrictEqual(held.reports['s 1'], { loading: true, entries: null, error: '' });
  await h.answer(/observations\?limit=100$/, { observations: [{ finding: { fingerprint: 'a' }, occurrences: [1], occurrenceCount: 1 }, { nothing: true }, null], complete: false, nextCursor: 'c1' });
  assert.strictEqual(h.asked().pop(), '/api/repo/octo/repo/exposure/scans/s%201/observations?limit=100&cursor=c1');
  await h.answer(/cursor=c1/, { observations: [{ finding: { fingerprint: 'b' } }], complete: true });
  await done;
  assert.deepStrictEqual(held.reports['s 1'], { loading: false, error: '', complete: true,
    entries: [{ fingerprint: 'a', occurrences: [1], occurrenceCount: 1 }, { fingerprint: 'b', occurrences: undefined, occurrenceCount: undefined }] });
  await h.x.loadReport('s 1');
  assert.strictEqual(h.asked().length, 2, 'a report held is not read again');
  const looping = harness();
  const l = looping.x.loadReport('s');
  for (let page = 0; page < 5; page += 1) await looping.answer(/observations/, { observations: [], complete: false, nextCursor: `c${page}` });
  await l;
  assert.strictEqual(looping.asked().length, 5, 'five pages at most');
  assert.strictEqual(looping.state.exposure.reports.s.complete, false);
  const repeat = harness();
  const r = repeat.x.loadReport('s');
  await repeat.answer(/observations/, { observations: [], nextCursor: 'same' });
  await repeat.answer(/observations/, { observations: [], nextCursor: 'same' });
  await r;
  assert.strictEqual(repeat.asked().length, 2, 'a continuation that repeats itself ends the report');
  const broken = harness();
  const b = broken.x.loadReport('s');
  await broken.answer(/observations/, { observations: 'x' });
  await b;
  assert.deepStrictEqual(broken.state.exposure.reports.s, { loading: false, entries: null, error: 'This scan\u2019s report could not be loaded.' });
  const inherited = harness();
  const i = inherited.x.loadReport('constructor');
  await inherited.answer(/observations/, { observations: [], complete: true });
  await i;
  assert.strictEqual(inherited.asked().length, 1, 'a scan named like a property every object has is read like any other');
  const capped = harness();
  const cap = capped.x.loadReport('s');
  await capped.answer(/observations/, { observations: Array.from({ length: 101 }, (_, n) => ({ finding: { fingerprint: `f${n}` } })), complete: true });
  await cap;
  assert.deepStrictEqual([capped.state.exposure.reports.s.entries.length, capped.state.exposure.reports.s.complete], [100, false], 'an over-long page is cut and not complete');
});

check('every irreversible control takes two presses, and arming one disarms the others', () => {
  const h = harness();
  assert.strictEqual(h.x.arm('verify', 'a', 'Press again?'), true);
  assert.strictEqual(h.state.exposure.confirming, 'verify:a');
  assert.deepStrictEqual(h.says(), ['Press again?']);
  assert.strictEqual(h.x.arm('accept', 'a', 'Other?'), true);
  assert.strictEqual(h.state.exposure.confirming, 'accept:a');
  assert.strictEqual(h.x.arm('accept', 'a', 'Other?'), false, 'the second press acts');
});

check('a credential is checked with its issuer on the second press, and the answer said as the server narrates it', async () => {
  const h = harness();
  h.x.current().findings = [finding('a', { disposition: 'open' }), finding('b')];
  await h.x.verify('a');
  assert.deepStrictEqual(h.asked(), [], 'the first press arms');
  const done = h.x.verify('a');
  assert.deepStrictEqual([h.state.exposure.confirming, h.state.exposure.verifying], ['', 'a']);
  assert.deepStrictEqual(h.log.find(entry => entry[0] === 'api'), ['api', '/api/repo/octo/repo/exposure/findings/a/verify', { method: 'POST', body: { confirm: 'use-this-credential', authorized: true } }]);
  await h.answer(/verify$/, { verification: { state: 'verified', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z' }, narration: 'It is live.', finding: { disposition: 'open', verifiedAt: 'now' } });
  await done;
  assert.deepStrictEqual(h.state.exposure.verifications.a, { state: 'verified', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z', narration: 'It is live.' });
  assert.strictEqual(h.state.exposure.findings[0].verifiedAt, 'now');
  assert.strictEqual(h.state.exposure.findings[1].verifiedAt, undefined);
  assert.strictEqual(h.state.exposure.verifying, '');
  assert.strictEqual(h.says().pop(), 'It is live.');
  const order = h.log.filter(entry => ['posture', 'say'].includes(entry[0])).map(entry => entry[0]);
  assert.deepStrictEqual(order.slice(-2), ['posture', 'say']);
  const plain = async (answer) => {
    const p = harness();
    p.x.arm('verify', 'a', '');
    const run = p.x.verify('a');
    await p.answer(/verify$/, answer);
    await run;
    return p.says().pop();
  };
  assert.strictEqual(await plain({ verification: { state: 'rejected', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z' } }), 'The provider refused this credential, so it no longer works.');
  assert.strictEqual(await plain({ verification: { state: 'verified' } }), 'Previous verification expired or has no check time. Check again for current evidence.');
  assert.strictEqual(await plain({ verification: { state: 'constructor', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z' } }), 'The check finished.');
  assert.strictEqual(await plain({}), 'The check finished.');
  const role = harness();
  role.x.arm('verify', 'a', '');
  const r = role.x.verify('a');
  await role.refuse(/verify$/, coded('GOVERNANCE_ROLE_REQUIRED'));
  await r;
  assert.strictEqual(role.says().pop(), 'A governance administrator with permission from the credential owner must run this check.');
  const other = harness();
  other.x.arm('verify', 'a', '');
  const o = other.x.verify('a');
  await other.refuse(/verify$/, null);
  await o;
  assert.strictEqual(other.says().pop(), 'That credential could not be checked.');
  const none = harness({ work: null });
  await none.x.verify('a');
  assert.deepStrictEqual(none.log, []);
});

check('an answer or a refusal for a repository the reader has left is neither applied nor said', async () => {
  for (const action of ['verify', 'accept', 'probe']) {
    for (const outcome of ['answer', 'refuse']) {
      const h = harness();
      h.x.current().findings = [finding('a')];
      h.x.current().probeDrafts = { a: { relation: 'profiles', columns: 'id' } };
      h.x.arm(action, 'a', '');
      const before = h.says().length;
      const run = h.x[action]('a');
      const left = h.state.exposure;
      h.switch();
      if (outcome === 'answer') await h.answer(/findings\/a\//, { verification: { state: 'verified' }, probe: { state: 'readable' }, finding: { disposition: 'accepted-risk' }, narration: 'Said.' });
      else await h.refuse(/findings\/a\//, coded('GOVERNANCE_ROLE_REQUIRED'));
      await run;
      assert.strictEqual(h.says().length, before, `${action} ${outcome}`);
      assert.strictEqual(left.error, '', `${action} ${outcome}`);
      assert.deepStrictEqual(left.findings, [finding('a')], `${action} ${outcome}`);
      if (action !== 'probe' && outcome === 'answer') assert.ok(h.log.some(entry => entry[0] === 'posture'), 'the repository it was checked on is read again');
    }
  }
});

check('accepting an exposure records the name, says the credential is still there, and a refusal names the role', async () => {
  const h = harness();
  h.x.current().findings = [finding('a')];
  h.x.current().error = 'old';
  await h.x.accept('a');
  assert.deepStrictEqual([h.asked(), h.state.exposure.confirming], [[], 'accept:a'], 'the first press arms');
  const done = h.x.accept('a');
  assert.strictEqual(h.state.exposure.accepting, 'a');
  assert.deepStrictEqual(h.log.filter(entry => entry[0] === 'api')[0], ['api', '/api/repo/octo/repo/exposure/findings/a/accept-risk', { method: 'POST' }]);
  await h.answer(/accept-risk$/, { finding: { disposition: 'accepted-risk', dispositionBy: 'alice' } });
  await done;
  assert.deepStrictEqual([h.state.exposure.findings[0].disposition, h.state.exposure.error, h.state.exposure.accepting], ['accepted-risk', '', '']);
  assert.strictEqual(h.says().pop(), 'Recorded. The credential is still in the repository.');
  const order = h.log.filter(entry => ['posture', 'say'].includes(entry[0])).map(entry => entry[0]);
  assert.deepStrictEqual(order.slice(-2), ['posture', 'say']);
  for (const [error, said] of [[coded('GOVERNANCE_ROLE_REQUIRED'), 'Accepting an exposure needs a governance administrator. Yours is recorded as a lower role.'], [new Error('x'), 'That finding could not be accepted.']]) {
    const r = harness();
    r.x.arm('accept', 'a', '');
    const run = r.x.accept('a');
    await r.refuse(/accept-risk$/, error);
    await run;
    assert.strictEqual(r.says().pop(), said);
    assert.strictEqual(r.state.exposure.accepting, '');
  }
});

check('a project is asked only with a table and columns typed, as typed, on the second press', async () => {
  const h = harness();
  await h.x.probe('a');
  assert.deepStrictEqual(h.says(), ['Name a table and at least one column before asking.']);
  h.x.current().probeDrafts = { a: { relation: '  profiles ', columns: ' id, , email ' } };
  await h.x.probe('a');
  assert.deepStrictEqual(h.asked(), [], 'armed');
  const done = h.x.probe('a');
  assert.deepStrictEqual(h.log.filter(entry => entry[0] === 'api')[0], ['api', '/api/repo/octo/repo/exposure/findings/a/probe-readability', { method: 'POST', body: { confirm: 'contact-this-project', authorized: true, relation: 'profiles', projection: ['id', 'email'] } }]);
  await h.answer(/probe-readability$/, { probe: { state: 'denied', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z' } });
  await done;
  assert.deepStrictEqual(h.state.exposure.probes.a.state, 'denied');
  assert.strictEqual(h.says().pop(), 'That request was refused, which is evidence about that request and not about the whole table.');
  assert.ok(!h.log.some(entry => entry[0] === 'posture'));
  const inherited = harness();
  inherited.x.current().probeDrafts = {};
  await inherited.x.probe('constructor');
  assert.deepStrictEqual(inherited.says(), ['Name a table and at least one column before asking.'], 'a draft is read by its own fingerprint only');
  for (const [code, said] of [['GOVERNANCE_ROLE_REQUIRED', 'A governance administrator with permission from the project owner must run this probe.'],
    ['EXPOSURE_PROBE_NOT_ANONYMOUS', 'Only an anonymous key can be used to ask what the public can read.'],
    ['EXPOSURE_PROBE_NO_PROJECT', 'No project reference was found beside that key, so there is nothing to ask.'], [undefined, 'That project could not be asked.']]) {
    const r = harness();
    r.x.current().probeDrafts = { a: { relation: 't', columns: 'c' } };
    r.x.arm('probe', 'a', '');
    const run = r.x.probe('a');
    await r.refuse(/probe/, coded(code));
    await run;
    assert.strictEqual(r.says().pop(), said);
  }
  const stale = harness();
  stale.x.current().probeDrafts = { a: { relation: 't', columns: 'c' } };
  stale.x.arm('probe', 'a', '');
  const s = stale.x.probe('a');
  await stale.answer(/probe/, { probe: { state: 'readable' }, narration: '' });
  await s;
  assert.strictEqual(stale.says().pop(), 'Previous readability result expired or has no check time. Check again for current evidence.');
});

check('a finding\u2019s fingerprint is one segment of every address it goes into', async () => {
  const odd = 'x/../y?z#w';
  for (const [act, tail] of [['verify', 'verify'], ['accept', 'accept-risk'], ['probe', 'probe-readability']]) {
    const h = harness();
    h.x.current().findings = [finding(odd)];
    h.x.current().probeDrafts = { [odd]: { relation: 'profiles', columns: 'id' } };
    await h.x[act](odd);
    const done = h.x[act](odd);
    assert.deepStrictEqual(h.asked(), [`/api/repo/octo/repo/exposure/findings/x%2F..%2Fy%3Fz%23w/${tail}`], act);
    await h.answer(new RegExp(`${tail}$`), {});
    await done;
  }
});

check('a scan is requested for the branch open, with history as chosen, and shown first in the history', async () => {
  const h = harness({ readsHistory: false });
  h.x.current().scopeKey = 'github:octo/repo';
  h.x.current().history = [scan({ scanId: 'older', state: 'complete' })];
  const done = h.x.request();
  assert.strictEqual(h.state.exposure.loading, true);
  assert.deepStrictEqual(h.log.find(entry => entry[0] === 'api'), ['api', '/api/repo/octo/repo/exposure/scans', { method: 'POST', body: { ref: 'main', history: false } }]);
  await h.answer(/scans$/, { scan: scan({ state: 'queued' }) });
  await done;
  assert.deepStrictEqual(h.state.exposure.history.map(item => item.scanId), ['s1', 'older']);
  assert.deepStrictEqual(h.state.exposure.history[0].severityCounts, { critical: 0, serious: 0, warning: 0 });
  assert.strictEqual(h.state.exposure.history[0].findingCount, 0);
  assert.strictEqual(h.says().pop(), 'Scan requested. Nothing is proven until it finishes.');
  assert.strictEqual(h.timers.length, 1, 'followed');
  await h.x.request();
  assert.strictEqual(h.asked().length, 1, 'not while one runs');
  const noBranch = harness({ work: { owner: 'o', repo: 'r' } });
  const nb = noBranch.x.request();
  assert.deepStrictEqual(noBranch.log.find(entry => entry[0] === 'api')[2].body, { ref: 'HEAD', history: true });
  await noBranch.answer(/scans$/, {});
  await nb;
  assert.strictEqual(noBranch.state.exposure.scan, null);
  for (const [code, said] of [['EXPOSURE_AUTHORIZATION_MISSING', 'Reconnect GitHub, then try the scan again.'], ['EXPOSURE_READ_FAILED', 'GitHub could not be reached or refused this read. Try again shortly; if it persists, check your GitHub connection.'],
    ['toString', 'The scan could not be started for this repository. Try again or check your repository access.'], [undefined, 'The scan could not be started for this repository. Try again or check your repository access.']]) {
    const r = harness();
    const run = r.x.request();
    await r.refuse(/scans$/, coded(code));
    await run;
    assert.strictEqual(r.says().pop(), said, String(code));
    assert.strictEqual(r.state.exposure.loading, false);
  }
  const moved = harness();
  const m = moved.x.request();
  moved.switch();
  await moved.refuse(/scans$/, coded('EXPOSURE_READ_FAILED'));
  await m;
  assert.deepStrictEqual(moved.says(), []);
  const again = harness();
  again.x.current().history = [scan({ scanId: 's1', state: 'queued', findingCount: 2 })];
  const twice = again.x.request();
  await again.answer(/scans$/, { scan: scan({ scanId: 's1', state: 'queued' }) });
  await twice;
  assert.deepStrictEqual(again.state.exposure.history.map(item => [item.scanId, item.findingCount]), [['s1', 2]], 'a scan the history holds is not listed twice');
  const loading = harness();
  loading.x.current().loading = true;
  await loading.x.request();
  assert.deepStrictEqual(loading.asked(), []);
});

check('a scan canceled is canceled in the proof card and in the history, and is followed no more', async () => {
  const h = harness();
  const held = h.x.current();
  held.scopeKey = 'github:octo/repo';
  held.scan = scan({ scanId: 'a/b' });
  held.history = [scan({ scanId: 'a/b', findingCount: 0 }), scan({ scanId: 'other', state: 'complete' })];
  const done = h.x.cancel();
  assert.deepStrictEqual(h.log.find(entry => entry[0] === 'api'), ['api', '/api/repo/octo/repo/exposure/scans/a%2Fb/cancel', { method: 'POST' }]);
  await h.answer(/cancel$/, { scan: scan({ scanId: 'a/b', state: 'canceled', coverage: 'partial' }) });
  await done;
  assert.strictEqual(held.scan.state, 'canceled');
  assert.deepStrictEqual(held.history.map(item => [item.scanId, item.state, item.findingCount]), [['a/b', 'canceled', 0], ['other', 'complete', undefined]]);
  assert.ok(h.log.some(entry => entry[0] === 'clear-timer'));
  assert.strictEqual(h.says().pop(), 'Scan canceled. Its coverage is partial.');
  const empty = harness();
  const e = empty.x.current();
  e.scopeKey = 'github:octo/repo';
  e.scan = scan();
  const run = empty.x.cancel();
  await empty.answer(/cancel$/, {});
  await run;
  assert.strictEqual(e.scan.state, 'running', 'an answer with no scan leaves the scan as it was');
  const refused = harness();
  const r = refused.x.current();
  r.scopeKey = 'github:octo/repo';
  r.scan = scan();
  const c = refused.x.cancel();
  await refused.refuse(/cancel$/, new Error('down'));
  await c;
  assert.strictEqual(refused.says().pop(), 'The scan could not be canceled.');
  const moved = harness();
  moved.x.current().scopeKey = 'github:octo/repo';
  moved.x.current().scan = scan();
  const m = moved.x.cancel();
  moved.switch();
  await moved.refuse(/cancel$/, new Error('down'));
  await m;
  assert.deepStrictEqual(moved.says(), [], 'a refusal for a repository left is not said on the next');
  const nothing = harness();
  await nothing.x.cancel();
  assert.deepStrictEqual(nothing.asked(), []);
});

check('clearing takes two presses, empties the screen on success, and says what went', async () => {
  const h = harness();
  h.x.current().scopeKey = 'github:octo/repo';
  h.x.current().findings = [finding('a')];
  await h.x.clearHistory();
  assert.deepStrictEqual(h.asked(), []);
  const done = h.x.clearHistory();
  assert.strictEqual(h.state.exposure.clearing, true);
  assert.deepStrictEqual(h.log.find(entry => entry[0] === 'api'), ['api', '/api/repo/octo/repo/exposure/clear', { method: 'POST', body: { confirm: 'clear-exposure-history' } }]);
  await h.answer(/clear$/, { cleared: { scans: 2, findings: '3' } });
  await done;
  assert.deepStrictEqual([h.state.exposure.findings, h.state.exposure.historyDone, h.state.exposure.scopeKey, h.state.exposure.clearing], [[], true, 'github:octo/repo', false]);
  assert.strictEqual(h.says().pop(), 'Cleared 2 scans and 3 findings.');
  const odd = harness();
  odd.x.arm('clear', 'history', '');
  const o = odd.x.clearHistory();
  await odd.answer(/clear$/, null);
  await o;
  assert.strictEqual(odd.says().pop(), 'Cleared 0 scans and 0 findings.');
  for (const [error, said] of [[coded('EXPOSURE_SCAN_ACTIVE'), 'A scan is still running. Cancel it before clearing the history.'], [new Error('x'), 'The history could not be cleared.']]) {
    const r = harness();
    r.x.arm('clear', 'history', '');
    const run = r.x.clearHistory();
    await r.refuse(/clear$/, error);
    await run;
    assert.deepStrictEqual([r.says().pop(), r.state.exposure.clearing], [said, false]);
  }
  const moved = harness();
  moved.x.arm('clear', 'history', '');
  const m = moved.x.clearHistory();
  moved.switch();
  await moved.answer(/clear$/, { cleared: {} });
  await m;
  assert.strictEqual(moved.state.exposure.scopeKey, 'github:acme/other', 'the repository opened meanwhile keeps its own screen');
});

check('all findings open or close together, and a narrowed paged view is read again', async () => {
  const h = harness();
  h.x.current().findings = [finding('a'), finding('b')];
  h.x.toggleAll();
  assert.deepStrictEqual([...h.state.exposure.expanded], ['a', 'b']);
  assert.strictEqual(h.says().pop(), 'All findings expanded.');
  h.x.toggleAll();
  assert.deepStrictEqual([...h.state.exposure.expanded], []);
  assert.strictEqual(h.says().pop(), 'All findings collapsed.');
  const empty = harness();
  empty.x.toggleAll();
  assert.strictEqual(empty.says().pop(), 'All findings expanded.');
  const local = harness();
  local.x.current().findings = [finding('a')];
  local.x.filter();
  assert.deepStrictEqual(local.asked(), []);
  assert.strictEqual(local.renders, 1);
  const paged = harness();
  Object.assign(paged.x.current(), { paged: true, findings: [finding('a')], nextCursor: 'x', scopeKey: 'github:octo/repo' });
  paged.x.filter();
  assert.deepStrictEqual(paged.asked(), ['/api/repo/octo/repo/exposure/findings?limit=50']);
});

check('an export is collected whole or not at all, and never carries a raw path', async () => {
  const h = harness();
  Object.assign(h.x.current(), { findings: [finding('a', { path: 'raw/x.env', displayPath: 'x.env' })], scan: { commitSha: 'c'.repeat(40) } });
  await h.x.exportFindings('csv');
  assert.deepStrictEqual(h.downloads, [['repo-exposure-2026-11-22.csv', 'csv:1', 'text/csv']]);
  assert.strictEqual(h.says().pop(), '1 finding exported.');
  await h.x.exportFindings('sarif');
  const [name, text, type] = h.downloads[1];
  assert.deepStrictEqual([name, type], ['repo-exposure-2026-11-22.sarif', 'application/sarif+json']);
  assert.deepStrictEqual(JSON.parse(text), { sarif: 1, meta: { ref: 'main', commitSha: 'c'.repeat(40), repositoryUri: 'https://github.com/octo/repo' } });
  const gitlab = harness({ me: { provider: 'gitlab' } });
  gitlab.x.current().findings = [finding('a')];
  await gitlab.x.exportFindings('sarif');
  assert.strictEqual(JSON.parse(gitlab.downloads[0][1]).meta.repositoryUri, '');
  const empty = harness();
  await empty.x.exportFindings('csv');
  assert.deepStrictEqual([empty.downloads, empty.state.exposure.exporting], [[], false]);
  const paged = harness();
  Object.assign(paged.x.current(), { paged: true, view: { severity: 'critical', status: 'all', where: 'all', query: '' } });
  const run = paged.x.exportFindings('csv');
  assert.strictEqual(paged.asked()[0], '/api/repo/octo/repo/exposure/findings?limit=200&severity=critical');
  await paged.answer(/limit=200/, { findings: [finding('a')], total: 2, nextCursor: 'n', verifications: { a: { state: 'verified' } } });
  await paged.answer(/cursor=n/, { findings: [finding('b')], total: 2 });
  await run;
  assert.deepStrictEqual(paged.downloads[0].slice(1), ['csv:2', 'text/csv']);
  assert.deepStrictEqual(Object.keys(paged.state.exposure.verifications), ['a']);
  for (const [pages, said] of [
    [[{ findings: [finding('a')], total: 3 }], 'A complete export could not be collected. Narrow the filters or try again.'],
    [[{ findings: [], total: 1, nextCursor: 'n' }], 'A complete export could not be collected. Narrow the filters or try again.'],
    [[{ findings: 'x', total: 1 }], 'A complete export could not be collected. Narrow the filters or try again.']
  ]) {
    const r = harness();
    Object.assign(r.x.current(), { paged: true });
    const e = r.x.exportFindings('csv');
    for (const page of pages) await r.answer(/limit=200/, page);
    await e;
    assert.deepStrictEqual([r.downloads, r.says().pop(), r.state.exposure.exporting], [[], said, false]);
  }
  const huge = harness();
  Object.assign(huge.x.current(), { paged: true });
  const big = huge.x.exportFindings('csv');
  await huge.answer(/limit=200/, { findings: Array.from({ length: 10001 }, (_, n) => finding(`f${n}`)), total: 20000, nextCursor: 'more' });
  await big;
  assert.deepStrictEqual([huge.downloads, huge.asked().length, huge.says().pop()], [[], 1, 'A complete export could not be collected. Narrow the filters or try again.'], 'an export is bounded');
  const stale = harness();
  Object.assign(stale.x.current(), { paged: true });
  const s = stale.x.exportFindings('csv');
  await stale.refuse(/limit=200/, coded('EXPOSURE_CURSOR_STALE'));
  await s;
  assert.strictEqual(stale.says().pop(), 'Findings changed during export. Refresh and export again.');
  const moved = harness();
  Object.assign(moved.x.current(), { paged: true });
  const m = moved.x.exportFindings('csv');
  moved.switch();
  await moved.refuse(/limit=200/, new Error('down'));
  await m;
  assert.deepStrictEqual(moved.says(), [], 'a failed export for a repository left is not said on the next');
  const busy = harness();
  busy.x.current().exporting = true;
  busy.x.current().findings = [finding('a')];
  await busy.x.exportFindings('csv');
  assert.deepStrictEqual(busy.downloads, []);
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
  console.log(`page exposure: ${checks.length} checks passed`);
})();
