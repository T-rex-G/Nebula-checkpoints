'use strict';

/*
 * The repository audit's page, asked directly (features/uranus/audit-controller.ts):
 * its view drawn for the branch open and started again for another, its
 * controls narrowing and revealing findings, its exports, an audit run
 * followed, retried, restarted once, compared and kept, and every answer for
 * another repository, branch or session dropped.
 */

const assert = require('assert');
const au = require('../apps/web/src/features/uranus/audit-controller.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const FINDINGS = [
  { id: 'a', category: 'injection', severity: 'critical', standards: { owasp: 'A03:2021' }, prompt: 'fix a' },
  { id: 'b', category: 'secrets', severity: 'high', standards: { owasp: 'A07:2021' }, prompt: 'fix b' },
  { id: 'c', category: 'secrets', severity: 'low', prompt: 'fix c' }
];
const RESULT = Object.freeze({ auditedAt: '2026-11-20T10:00:00Z', grade: 'F', findings: FINDINGS });

function setup(options = {}) {
  const log = [];
  const page = {
    work: 'work' in options ? options.work : { owner: 'octo', repo: 'demo', branch: 'main' },
    epoch: 1, shown: options.shown ?? true, root: options.root ?? true, provider: options.provider || 'github',
    decisions: { 'code-audit': { status: 'Supported' }, 'site-check': { status: 'Supported' }, ...(options.decisions || {}) },
    siteLink: options.siteLink || { link: true, url: 'https://demo.example.com', result: null, status: 'idle' }
  };
  let view = au.blankAuditView(options.viewKey ?? 'octo/demo@main');
  if (options.view) Object.assign(view, options.view);
  const answers = [...(options.answers || [{ state: 'running', run: 'r 1', stage: 'files' }, RESULT])];
  const gates = options.gates || {};
  let calls = 0;
  const memory = new Map(Object.entries(options.memory || {}));
  const controller = au.createAuditController({
    api: async path => {
      calls += 1;
      log.push(['api', path]);
      if (gates[calls]) await gates[calls].promise;
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    work: () => page.work,
    epoch: () => page.epoch,
    provider: () => page.provider,
    view: { get: () => view, set: next => { view = next; log.push(['set', next.key, next.status]); } },
    forgetHistory: () => log.push(['forget-history']),
    forgetWatch: () => log.push(['forget-watch']),
    decision: feature => page.decisions[feature],
    screen: {
      render: (shown, handlers) => { page.rendered = shown; page.handlers = handlers; log.push(['render', shown.key, shown.status]); },
      clear: () => log.push(['screen-clear']),
      present: () => page.root
    },
    shown: () => page.shown,
    site: { link: () => page.siteLink, open: o => log.push(['site-open', JSON.stringify(o)]) },
    history: {
      load: () => { view.history = { status: 'loading' }; log.push(['history']); },
      watch: o => log.push(['watch', o.force]),
      detail: id => log.push(['detail', id]),
      clear: () => log.push(['history-clear']),
      reveal: id => log.push(['reveal', id])
    },
    triage: { decide: f => log.push(['triage', f.id]), reopen: f => log.push(['reopen', f.id]), history: f => log.push(['triage-history', f.id]) },
    openFinding: f => log.push(['open', f.id]),
    copyPrompt: text => log.push(['copy', text]),
    copyText: async text => { if (options.clipboardFails) throw new Error('denied'); log.push(['copy-all', text]); },
    toast: (m, k) => log.push(['toast', m, k]),
    download: (name, text, type) => log.push(['download', name, text, type]),
    reports: {
      allPrompts: r => `prompts:${r && r.grade}`,
      sarif: (r, s, m) => `sarif:${r && r.grade}:${s && s.origin}:${JSON.stringify(m)}`,
      csv: (r, s, d) => `csv:${r && r.grade}:${s && s.origin}:${JSON.stringify(d)}`,
      brief: (r, l, s) => `brief:${r && r.grade}:${l}:${s && s.origin}`,
      keptSarif: (a, f, m) => `ksarif:${a.id}:${f.length}:${JSON.stringify(m)}`,
      keptCsv: (a, f) => `kcsv:${a.id}:${f.length}`,
      keptBrief: (a, f, l) => `kbrief:${a.id}:${f.length}:${l}`
    },
    sbom: { cyclonedx: (r, m) => `cdx:${JSON.stringify(m)}`, spdx: (r, m) => `spdx:${JSON.stringify(m)}` },
    memory: {
      readPrevious: key => memory.get(key) || null,
      remember: (key, value) => { memory.set(key, value); log.push(['remember', key]); },
      diff: (result, previous) => ({ local: true, previous: Boolean(previous) })
    },
    offline: error => Boolean(error && error.offline),
    pause: async ms => { log.push(['pause', ms]); if (options.duringPause) options.duringPause(page, controller); },
    now: () => Date.parse('2026-11-23T12:00:00Z')
  });
  const of = kind => log.filter(entry => entry[0] === kind);
  return { controller, page, log, of, view: () => view, memory };
}

check('a blank view and the failures asked again', () => {
  const blank = au.blankAuditView('k');
  assert.deepStrictEqual([blank.key, blank.status, blank.query, blank.limit, blank.history, blank.watch, blank.triage, blank.metrics, blank.historyArmed],
    ['k', 'idle', '', 0, { status: 'idle' }, { status: 'idle' }, { status: 'idle' }, { status: 'idle' }, false]);
  assert.ok(blank.historyOpen instanceof Set && blank.historyDetail instanceof Map);
  assert.deepStrictEqual([blank.historyOpen.size, blank.historyDetail.size], [0, 0], 'no row open or read');
  assert.notStrictEqual(au.blankAuditView().historyOpen, au.blankAuditView().historyOpen, 'each view its own');
  const offline = () => true;
  for (const status of [429, 502, 503, 504, 520, 527]) assert.strictEqual(au.transientAuditError({ edge: true, status }, () => false), true, String(status));
  assert.strictEqual(au.transientAuditError({ status: 503 }, () => false), false, 'not from the edge');
  assert.strictEqual(au.transientAuditError({ edge: true, status: 500 }, () => false), false);
  assert.strictEqual(au.transientAuditError({ message: 'Failed to fetch' }, offline), true, 'offline, with no status');
  assert.strictEqual(au.transientAuditError({ status: 404 }, offline), false);
  assert.strictEqual(au.transientAuditError(null, offline), false);
  assert.deepStrictEqual(au.AUDIT_POLL, { firstMs: 1200, maxMs: 5000, growth: 1.35, transientTries: 6 });
});

check('the view is drawn for the branch open, started again for another, and its history read when it can be', () => {
  const s = setup();
  assert.strictEqual(s.controller.key(), 'octo/demo@main');
  s.controller.paint();
  assert.deepStrictEqual(s.log, [['history'], ['render', 'octo/demo@main', 'idle']]);
  assert.deepStrictEqual([s.page.rendered.unavailable, s.page.rendered.site, s.page.rendered.history], [null, s.page.siteLink, { status: 'loading' }]);
  s.page.work.branch = 'dev';
  s.log.length = 0;
  s.controller.paint();
  assert.deepStrictEqual(s.log, [['forget-history'], ['set', 'octo/demo@dev', 'idle'], ['history'], ['render', 'octo/demo@dev', 'idle']]);
  const off = setup({ decisions: { 'code-audit': { status: 'Unavailable', reason: 'Audits are off here.' }, 'site-check': { status: 'Unavailable' } } });
  off.controller.paint();
  assert.deepStrictEqual(off.log, [['render', 'octo/demo@main', 'idle']]);
  assert.deepStrictEqual([off.page.rendered.unavailable, off.page.rendered.site], ['Audits are off here.', null]);
  const ready = setup({ view: { history: { status: 'ready', audits: [] } } });
  ready.controller.paint();
  assert.deepStrictEqual(ready.of('history'), [], 'a history read is not read again by drawing');
  const none = setup({ work: null, viewKey: '' });
  none.controller.paint();
  assert.deepStrictEqual(none.log, [['render', '', 'idle']]);
  assert.strictEqual(none.controller.key(), '');
  const rootless = setup({ root: false });
  rootless.controller.paint();
  assert.deepStrictEqual(rootless.log, []);
  const hidden = setup({ shown: false });
  hidden.controller.repaint();
  assert.deepStrictEqual(hidden.log, [], 'drawn again only when it is the tool showing');
  const visible = setup();
  visible.controller.repaint();
  assert.strictEqual(visible.of('render').length, 1);
});

check('the findings are narrowed by category, OWASP class, severity, verdict, exploitation and words, each from the top', () => {
  const s = setup({ view: { result: RESULT, limit: 40, severity: 'high', verdict: 'confirmed', exploit: 'kev', owasp: 'A03' } });
  s.controller.paint();
  const h = s.page.handlers;
  h.onFilter('secrets');
  assert.deepStrictEqual([s.view().filter, s.view().severity, s.view().verdict, s.view().exploit, s.view().owasp, s.view().limit], ['secrets', null, null, null, null, 0]);
  Object.assign(s.view(), { severity: 'high', limit: 9, filter: 'secrets' });
  h.onOwasp('A07');
  assert.deepStrictEqual([s.view().owasp, s.view().filter, s.view().severity, s.view().limit], ['A07', 'secrets', null, 0], 'the class narrows within the category');
  s.view().limit = 9;
  h.onSeverity('critical');
  assert.deepStrictEqual([s.view().severity, s.view().limit], ['critical', 0]);
  s.view().limit = 9;
  h.onVerdict('lead');
  assert.deepStrictEqual([s.view().verdict, s.view().limit], ['lead', 0]);
  h.onExploit('kev');
  assert.strictEqual(s.view().exploit, 'kev');
  h.onExploit('anything else');
  assert.strictEqual(s.view().exploit, null);
  s.view().limit = 9;
  h.onQuery('x'.repeat(200));
  assert.deepStrictEqual([s.view().query.length, s.view().limit], [120, 0]);
  h.onQuery(null);
  assert.strictEqual(s.view().query, '');
  h.onMore(60);
  assert.strictEqual(s.view().limit, 60);
  assert.strictEqual(s.of('render').length, 10, 'drawn again after each');
});

check('a finding the list hides is revealed: what hides it cleared, and the list paged to it', () => {
  const s = setup({ view: { result: RESULT, filter: 'injection', owasp: 'A03', severity: 'critical', verdict: 'lead', exploit: 'kev', query: 'q', limit: 0 } });
  s.controller.paint();
  s.page.handlers.onReveal('c');
  assert.deepStrictEqual([s.view().filter, s.view().owasp, s.view().severity, s.view().verdict, s.view().exploit, s.view().query, s.view().limit], [null, null, null, null, null, '', 3]);
  const inside = setup({ view: { result: RESULT, filter: 'secrets', severity: 'high', limit: 1 } });
  inside.controller.paint();
  inside.page.handlers.onReveal('c');
  assert.deepStrictEqual([inside.view().filter, inside.view().severity, inside.view().limit], ['secrets', null, 2], 'a finding in the category keeps it');
  const kept = setup({ view: { result: RESULT, limit: 50 } });
  kept.controller.paint();
  kept.page.handlers.onReveal('a');
  assert.strictEqual(kept.view().limit, 50, 'a longer page is kept');
  const missing = setup({ view: { result: RESULT, filter: 'secrets' } });
  missing.controller.paint();
  const drawn = missing.of('render').length;
  missing.page.handlers.onReveal('zzz');
  assert.deepStrictEqual([missing.view().filter, missing.of('render').length], ['secrets', drawn]);
  const owasp = setup({ view: { result: RESULT, owasp: 'A07' } });
  owasp.controller.paint();
  owasp.page.handlers.onReveal('b');
  assert.strictEqual(owasp.view().owasp, 'A07', 'a finding of the class keeps it');
  const tenth = { result: { ...RESULT, findings: [...FINDINGS, { id: 'd', category: 'ssrf', standards: { owasp: 'A10:2021' } }] }, owasp: 'A1' };
  const classes = setup({ view: tenth });
  classes.controller.paint();
  classes.page.handlers.onReveal('d');
  assert.strictEqual(classes.view().owasp, null, 'A10 is not of the class A1');
});

check('the history\u2019s rows open, read and reveal; a redraw restoring a row is not a press', () => {
  const s = setup();
  s.controller.paint();
  const h = s.page.handlers;
  h.onHistoryToggle('k1', true);
  h.onHistoryToggle('k1', true);
  assert.deepStrictEqual(s.of('detail'), [['detail', 'k1']]);
  const drawn = s.of('render').length;
  h.onHistoryToggle('k1', false);
  assert.deepStrictEqual([s.view().historyOpen.has('k1'), s.of('render').length], [false, drawn + 1]);
  h.onHistoryOpen('k2', { reveal: true });
  h.onHistoryOpen('k3');
  assert.deepStrictEqual(s.log.slice(-3), [['detail', 'k2'], ['reveal', 'k2'], ['detail', 'k3']]);
  assert.deepStrictEqual([s.view().historyOpen.has('k2'), s.view().historyOpen.has('k3')], [true, true], 'a row opened from elsewhere is kept open');
  h.onHistoryClear();
  h.onWatchCheck();
  h.onSiteOpen({ check: true });
  h.onTriage({ id: 'a' });
  h.onReopen({ id: 'a' });
  h.onTriageHistory({ id: 'a' });
  h.onOpen({ id: 'b' });
  h.onCopy({ prompt: 'fix b' });
  assert.deepStrictEqual(s.log.slice(-8), [['history-clear'], ['watch', true], ['site-open', '{"check":true}'], ['triage', 'a'], ['reopen', 'a'], ['triage-history', 'a'], ['open', 'b'], ['copy', 'fix b']]);
});

check('a kept audit is exported on its own, named for its repository, day and commit, only once read', () => {
  const audit = { id: 'k1', auditedAt: '2026-11-19T08:00:00Z', commitSha: 'abcdef0123', ref: 'main' };
  const s = setup({ view: { history: { status: 'ready', audits: [audit] } } });
  s.view().historyDetail.set('k1', { status: 'ready', findings: [1, 2] });
  s.controller.paint();
  for (const kind of ['sarif', 'csv', 'md']) s.page.handlers.onHistoryExport('k1', kind);
  assert.deepStrictEqual(s.of('download'), [
    ['download', 'demo-audit-2026-11-19-abcdef0.sarif', 'ksarif:k1:2:{"repositoryUri":"https://github.com/octo/demo"}', 'application/sarif+json'],
    ['download', 'demo-audit-2026-11-19-abcdef0.csv', 'kcsv:k1:2', 'text/csv'],
    ['download', 'demo-audit-2026-11-19-abcdef0.md', 'kbrief:k1:2:octo/demo (main)', 'text/markdown']
  ]);
  s.view().historyDetail.set('k1', { status: 'loading' });
  s.page.handlers.onHistoryExport('k1', 'csv');
  s.page.handlers.onHistoryExport('missing', 'csv');
  assert.strictEqual(s.of('download').length, 3);
  const other = setup({ provider: 'gitlab', view: { history: { status: 'ready', audits: [{ id: 'k2' }] } } });
  other.view().historyDetail.set('k2', { status: 'ready', findings: 'none' });
  other.controller.paint();
  other.page.handlers.onHistoryExport('k2', 'sarif');
  assert.deepStrictEqual(other.of('download')[0].slice(1, 3), ['demo-audit--.sarif', 'ksarif:k2:0:{"repositoryUri":""}'], 'no GitHub address for another provider; nothing undefined in the name');
});

check('the audit is exported with the latest site check, as a brief, SARIF, CSV and two SBOMs', () => {
  const site = { origin: 'https://demo.example.com', checkedAt: '2026-11-21T00:00:00Z' };
  const s = setup({ view: { result: RESULT, diff: { newIds: [] } }, siteLink: { link: true, result: site } });
  s.controller.paint();
  for (const kind of ['sarif', 'csv', 'cyclonedx', 'spdx', 'md']) s.page.handlers.onExport(kind);
  assert.deepStrictEqual(s.of('download'), [
    ['download', 'demo-audit-2026-11-20.sarif', 'sarif:F:https://demo.example.com:{"ref":"main","repositoryUri":"https://github.com/octo/demo"}', 'application/sarif+json'],
    ['download', 'demo-audit-2026-11-20.csv', 'csv:F:https://demo.example.com:{"newIds":[]}', 'text/csv'],
    ['download', 'demo-sbom-2026-11-20.cdx.json', 'cdx:{"name":"octo/demo","ref":"main","repositoryUri":"https://github.com/octo/demo"}', 'application/vnd.cyclonedx+json'],
    ['download', 'demo-sbom-2026-11-20.spdx.json', 'spdx:{"name":"octo/demo","ref":"main","repositoryUri":"https://github.com/octo/demo"}', 'application/spdx+json'],
    ['download', 'demo-audit-2026-11-20.md', 'brief:F:octo/demo (main):https://demo.example.com', 'text/markdown']
  ]);
  const siteOnly = setup({ siteLink: { link: true, result: site } });
  siteOnly.controller.paint();
  siteOnly.page.handlers.onExport('cyclonedx');
  siteOnly.page.handlers.onExport('csv');
  assert.deepStrictEqual(siteOnly.of('download').map(entry => entry[1]), ['demo-audit-2026-11-21.md', 'demo-audit-2026-11-21.csv'], 'no SBOM without an audit; the brief instead');
  const undated = setup({ view: { result: { findings: [] } } });
  undated.controller.paint();
  undated.page.handlers.onExport('md');
  assert.strictEqual(undated.of('download')[0][1], 'demo-audit-2026-11-23.md');
  const nothing = setup();
  nothing.controller.paint();
  nothing.page.handlers.onExport('md');
  assert.deepStrictEqual(nothing.of('download'), []);
});

check('every fix prompt is copied at once, or the clipboard\u2019s refusal said', async () => {
  const s = setup({ view: { result: RESULT } });
  s.controller.paint();
  await s.page.handlers.onCopyAll();
  assert.deepStrictEqual(s.log.slice(-2), [['copy-all', 'prompts:F'], ['toast', 'Every fix prompt copied', 'ok']]);
  const refused = setup({ view: { result: RESULT }, clipboardFails: true });
  refused.controller.paint();
  await refused.page.handlers.onCopyAll();
  assert.deepStrictEqual(refused.log.at(-1), ['toast', 'The clipboard is not available here', 'err']);
});

check('an audit is followed stage by stage, a little less often each time, then kept and compared', async () => {
  const s = setup({ answers: [{ state: 'running', run: 'r 1' }, { state: 'running', run: 'r 1' }, { state: 'running', run: 'r 1' }, RESULT] });
  s.controller.paint();
  await s.page.handlers.onRun();
  assert.deepStrictEqual(s.of('api').map(entry => entry[1]), [
    '/api/repo/octo/demo/code-audit?ref=main',
    '/api/repo/octo/demo/code-audit?ref=main&run=r%201',
    '/api/repo/octo/demo/code-audit?ref=main&run=r%201',
    '/api/repo/octo/demo/code-audit?ref=main&run=r%201'
  ]);
  assert.deepStrictEqual(s.of('pause').map(entry => entry[1]), [1200, 1620, 2187]);
  assert.deepStrictEqual([s.view().status, s.view().result, s.view().diff], ['done', RESULT, { local: true, previous: false }]);
  assert.deepStrictEqual(s.of('remember'), [['remember', 'octo/demo']]);
  const staged = setup({ answers: [{ state: 'running', run: 'r', stage: 'rules', done: 3, total: 9 }, RESULT], duringPause: page => { page.heard = page.rendered.progress; } });
  await staged.controller.run();
  assert.deepStrictEqual(staged.page.heard, { state: 'running', run: 'r', stage: 'rules', done: 3, total: 9 }, 'the stage heard is drawn');
  const fresh = setup({ view: { result: RESULT, status: 'done', filter: 'secrets', owasp: 'A07', severity: 'high', verdict: 'lead', exploit: 'kev', query: 'q', limit: 40 }, answers: [RESULT] });
  await fresh.controller.run();
  assert.deepStrictEqual([fresh.view().filter, fresh.view().owasp, fresh.view().severity, fresh.view().verdict, fresh.view().exploit, fresh.view().query, fresh.view().limit], [null, null, null, null, null, '', 0], 'a new audit is read from the top');
  const progress = s.log.filter(entry => entry[0] === 'render' && entry[2] === 'running').length;
  assert.strictEqual(progress, 4, 'drawn as it starts and at each stage heard');
  assert.deepStrictEqual(s.log.at(-1), ['render', 'octo/demo@main', 'done']);
  const kept = setup({ answers: [{ ...RESULT, history: { saved: true, newIds: ['a'], previousAt: '2026-11-01', resolved: 2 } }], view: { history: { status: 'ready', audits: [] }, watch: { status: 'ready' }, triage: { status: 'ready' }, metrics: { status: 'ready' } } });
  const open = kept.view().historyOpen;
  kept.controller.paint();
  await kept.controller.run();
  assert.deepStrictEqual(kept.view().diff, { previousAt: '2026-11-01', newIds: new Set(['a']), resolved: 2 });
  assert.strictEqual(kept.view().historyOpen, open, 'the history\u2019s open rows carried over');
  assert.deepStrictEqual([kept.view().watch, kept.view().triage, kept.view().metrics], [{ status: 'ready' }, { status: 'ready' }, { status: 'ready' }]);
  assert.strictEqual(kept.of('history').length, 1, 'the history read again to list it');
  for (const history of [{ saved: true }, { saved: true, newIds: 'x' }]) {
    const odd = setup({ answers: [{ ...RESULT, history }], view: { history: { status: 'ready' } } });
    await odd.controller.run();
    assert.strictEqual(odd.view().diff, null, JSON.stringify(history));
  }
  const fuzzy = setup({ answers: [{ ...RESULT, history: { saved: true, newIds: [], resolved: 1.5 } }], view: { history: { status: 'ready' } } });
  await fuzzy.controller.run();
  assert.deepStrictEqual(fuzzy.view().diff, { previousAt: null, newIds: new Set(), resolved: null });
  const unsaved = setup({ answers: [{ ...RESULT, history: { saved: false, newIds: ['x'] } }], memory: { 'octo/demo': { old: true } } });
  await unsaved.controller.run();
  assert.deepStrictEqual(unsaved.view().diff, { local: true, previous: true }, 'this browser\u2019s fingerprints when the server kept nothing');
});

check('a run the server no longer holds is started once more; the network\u2019s failures are asked again a few times', async () => {
  const gone = Object.assign(new Error('gone'), { code: 'AUDIT_RUN_GONE' });
  const s = setup({ answers: [{ state: 'running', run: 'r' }, gone, { state: 'running', run: 'r2' }, RESULT] });
  await s.controller.run();
  assert.deepStrictEqual(s.of('api').map(entry => entry[1].split('code-audit')[1]), ['?ref=main', '?ref=main&run=r', '?ref=main', '?ref=main&run=r2']);
  assert.strictEqual(s.view().status, 'done');
  const twice = setup({ answers: [{ state: 'running', run: 'r' }, gone, { state: 'running', run: 'r2' }, gone] });
  await twice.controller.run();
  assert.deepStrictEqual([twice.view().status, twice.view().error], ['error', 'gone'], 'started once more, not twice');
  const blip = Object.assign(new Error('Bad gateway'), { edge: true, status: 502, retryAfter: 4 });
  const retried = setup({ answers: [{ state: 'running', run: 'r' }, blip, { state: 'running', run: 'r' }, blip, RESULT] });
  await retried.controller.run();
  assert.deepStrictEqual(retried.of('pause').map(entry => entry[1]), [1200, 6000, 5000, 7500], 'the asked wait honoured, then the usual one, bounded');
  assert.strictEqual(retried.view().status, 'done');
  const words = setup({ answers: [{ state: 'running', run: 'r' }, Object.assign(new Error('x'), { edge: true, status: 503, retryAfter: '9' }), RESULT] });
  await words.controller.run();
  assert.deepStrictEqual(words.of('pause').map(entry => entry[1]), [1200, 1800], 'a wait asked for in words is none');
  const long = setup({ answers: [{ state: 'running', run: 'r' }, Object.assign(new Error('x'), { edge: true, status: 429, retryAfter: 30 }), RESULT] });
  await long.controller.run();
  assert.deepStrictEqual(long.of('pause').map(entry => entry[1]), [1200, 10000], 'a long wait asked for is bounded');
  const many = setup({ answers: [{ state: 'running', run: 'r' }, blip, blip, blip, blip, blip, blip, blip, RESULT] });
  await many.controller.run();
  assert.deepStrictEqual([many.view().status, many.view().error], ['error', 'Bad gateway'], 'six tries, then said');
  const spaced = setup({ answers: [{ state: 'running', run: 'r' }, blip, blip, blip, blip, blip, blip, { state: 'running', run: 'r' }, blip, RESULT] });
  await spaced.controller.run();
  assert.strictEqual(spaced.view().status, 'done', 'an answer between failures starts their count again');
});

check('a failure is said in words a reader can act on; an answer that is not an audit is a failure', async () => {
  for (const [error, said] of [
    [Object.assign(new Error('Failed to fetch'), { offline: true }), 'The server could not be reached. Check the connection, then try again.'],
    [Object.assign(new Error('Branch not found'), { status: 404 }), 'Branch not found'],
    [new Error(''), 'The audit could not be completed.'],
    [Object.assign(new Error('Server error'), { offline: true, status: 500 }), 'Server error']
  ]) {
    const s = setup({ answers: [error] });
    await s.controller.run();
    assert.deepStrictEqual([s.view().status, s.view().error, s.view().progress], ['error', said, null], said);
  }
  const midway = setup({ answers: [{ state: 'running', run: 'r', stage: 'files' }, Object.assign(new Error('Branch not found'), { status: 404 })] });
  await midway.controller.run();
  assert.deepStrictEqual([midway.view().status, midway.view().progress], ['error', null], 'the stage last heard is let go of');
  for (const answer of [null, {}, { findings: 'none' }, 'done', { state: 'failed' }]) {
    const s = setup({ answers: [answer] });
    await s.controller.run();
    assert.deepStrictEqual([s.view().status, s.view().error], ['error', au.UNREADABLE], JSON.stringify(answer));
    assert.deepStrictEqual(s.of('remember'), [], 'nothing kept');
  }
});

check('an audit belongs to the repository, branch and session it was asked in; one at a time', async () => {
  for (const leave of [t => { t.page.work = { owner: 'other', repo: 'thing', branch: 'main' }; }, t => { t.page.work.branch = 'dev'; }, t => { t.page.epoch = 2; }, t => t.controller.clear()]) {
    for (const at of [1, 2]) {
      const gate = held();
      const t = setup({ gates: { [at]: gate } });
      const running = t.controller.run();
      await settle();
      leave(t);
      const before = t.log.length;
      gate.release();
      await running;
      assert.deepStrictEqual(t.log.slice(before).filter(entry => entry[0] !== 'api'), [], String(leave) + at);
    }
  }
  const waiting = setup({ duringPause: page => { page.epoch = 5; } });
  await waiting.controller.run();
  assert.strictEqual(waiting.of('api').length, 1, 'nothing more asked once the session has gone');
  const failing = held();
  const t = setup({ answers: [new Error('late')], gates: { 1: failing } });
  const running = t.controller.run();
  await settle();
  t.page.epoch = 3;
  failing.release();
  await running;
  assert.ok(!t.log.some(entry => entry[0] === 'set' && entry[2] === 'error'), 'its failure unsaid');
  const busy = setup({ gates: { 1: held() } });
  void busy.controller.run();
  await busy.controller.run();
  assert.strictEqual(busy.of('api').length, 1);
  const none = setup({ work: null });
  await none.controller.run();
  assert.deepStrictEqual(none.log, []);
  const hidden = setup({ shown: false, answers: [RESULT] });
  await hidden.controller.run();
  assert.deepStrictEqual(hidden.of('render').map(entry => entry[2]), ['running'], 'drawn as it starts; its end drawn when the audit is shown');
});

check('Refresh reads the history again, or draws the view afresh when it was another branch\u2019s; clearing lets go of everything', () => {
  const s = setup();
  s.controller.reread();
  assert.deepStrictEqual(s.log, [['history']]);
  const off = setup({ decisions: { 'code-audit': { status: 'Unavailable' } } });
  off.controller.reread();
  assert.deepStrictEqual(off.log, []);
  const moved = setup({ viewKey: 'octo/demo@old' });
  moved.controller.reread();
  assert.deepStrictEqual(moved.log.slice(0, 2), [['forget-history'], ['set', 'octo/demo@main', 'idle']]);
  const c = setup({ view: { result: RESULT, status: 'done' } });
  c.controller.clear();
  assert.deepStrictEqual(c.log, [['forget-history'], ['forget-watch'], ['set', '', 'idle'], ['screen-clear']]);
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
  console.log(`page audit: ${checks.length} checks passed`);
})();
