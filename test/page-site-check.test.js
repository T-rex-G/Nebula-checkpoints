'use strict';

/*
 * The deployed-site check, asked directly (features/parallax/site-check.ts):
 * an https address's origin; what a repository's audit shows of its address;
 * a check started, followed, retried through the network's and the edge's
 * failures, ended and remembered, the audit drawn again when it ends; a
 * check dropped when the page or the session let go of it; an answer without
 * its address a failure; the page opened from the audit or the rail; and the
 * page's controls.
 */

const assert = require('assert');
const site = require('../apps/web/src/features/parallax/site-check.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const RESULT = Object.freeze({ origin: 'https://demo.example.com', checkedAt: '2026-11-20T10:00:00Z', grade: 'F', findings: [{ id: 'f1', prompt: 'fix it' }] });
const PREFIX = 'nv_audit:';

function setup(options = {}) {
  const log = [];
  const page = { work: 'work' in options ? options.work : { owner: 'Octo', repo: 'Demo', homepage: 'https://demo.example.com/home' }, epoch: 1, page: options.page || 'site', decision: options.decision || { status: 'Supported' } };
  const kept = new Map(Object.entries(options.kept || {}));
  const answers = [...(options.answers || [{ state: 'running', run: 'r 1', stage: 'page' }, { state: 'running', run: 'r 1', stage: 'scripts' }, RESULT])];
  const gates = options.gates || {};
  let calls = 0;
  let renders = 0;
  const memory = new Map();
  let tool = null;
  tool = site.createSiteCheck({
    api: async path => {
      calls += 1;
      log.push(['api', path]);
      if (gates[calls]) await gates[calls].promise;
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer() : answer;
    },
    work: () => page.work,
    epoch: () => page.epoch,
    stored: name => (kept.has(name) ? kept.get(name) : null),
    store: (name, value) => { if (options.storeThrows) throw new Error('denied'); kept.set(name, value); log.push(['store', name, value]); },
    memory: {
      prefix: PREFIX,
      readPrevious: key => { log.push(['previous', key]); return memory.get(key) || null; },
      remember: (key, value) => { memory.set(key, value); log.push(['remember', key, value.auditedAt]); },
      diff: (result, previous) => ({ against: previous ? 'previous' : 'none' })
    },
    decision: () => page.decision,
    screen: {
      render: (view, handlers) => { renders += 1; (page.renders = page.renders || []).push(view); page.view = view; page.handlers = handlers; log.push(['render', view.status, view.url, view.from]); },
      refuse: reason => log.push(['refuse', reason]),
      clear: () => log.push(['screen-clear'])
    },
    rendered: { mount: () => log.push(['mount']), dispose: () => log.push(['dispose']) },
    page: () => page.page,
    showPage: name => { page.page = name; log.push(['page', name]); },
    showAudit: () => log.push(['audit']),
    repaintAudit: () => log.push(['repaint-audit']),
    copyPrompt: text => log.push(['copy', text]),
    copyText: async text => { if (options.clipboardFails) throw new Error('denied'); log.push(['copy-all', text]); },
    prompts: result => `prompts of ${result && result.origin}`,
    toast: (message, kind) => log.push(['toast', message, kind]),
    download: (name, text, type) => log.push(['download', name, text, type]),
    reports: {
      sarif: (result, s, meta) => `sarif:${result}:${s.origin}:${JSON.stringify(meta)}`,
      csv: (result, s, diff) => `csv:${result}:${s.origin}:${diff}`,
      brief: (result, label, s) => `brief:${result}:${label}:${s.origin}`
    },
    transient: error => Boolean(error && error.transient),
    transientTries: () => options.tries ?? 2,
    pause: async ms => { log.push(['pause', ms]); if (options.duringPause) options.duringPause(page, tool); },
    now: () => Date.parse('2026-11-23T12:00:00Z')
  });
  const of = kind => log.filter(entry => entry[0] === kind);
  return { tool, page, kept, log, of, memory, renders: () => renders };
}

check('an address\u2019s origin is its https origin, and nothing else is one', () => {
  assert.strictEqual(site.siteOriginOf('  https://Demo.example.com:8443/pricing?ref=ad '), 'https://demo.example.com:8443');
  for (const odd of ['http://demo.example.com', 'ftp://x', 'demo.example.com', '', null, undefined, 7, {}]) assert.strictEqual(site.siteOriginOf(odd), null, String(odd));
});

check('the audit shows the address last checked for its repository, else the homepage it declares, and its latest check', async () => {
  const fresh = setup();
  assert.deepStrictEqual(fresh.tool.link(), { link: true, url: 'https://demo.example.com/home', suggested: true, result: null, status: 'idle' });
  assert.strictEqual(fresh.tool.key(), 'Octo/Demo');
  const remembered = setup({ kept: { [`${PREFIX}site-url:octo/demo`]: 'https://shop.example.com' } });
  assert.deepStrictEqual(remembered.tool.link(), { link: true, url: 'https://shop.example.com', suggested: false, result: null, status: 'idle' });
  const none = setup({ work: { owner: 'o', repo: 'r', homepage: 7 } });
  assert.deepStrictEqual(none.tool.link(), { link: true, url: '', suggested: false, result: null, status: 'idle' });
  assert.deepStrictEqual(setup({ work: null }).tool.link(), { link: true, url: '', suggested: false, result: null, status: 'idle' });
  assert.strictEqual(setup({ work: null }).tool.key(), '');
  const s = setup();
  s.tool.open();
  await s.tool.run('https://demo.example.com/home');
  assert.deepStrictEqual(s.tool.link(), { link: true, url: 'https://demo.example.com', suggested: false, result: RESULT, status: 'done' });
  const elsewhere = setup({ gates: { 1: held() } });
  elsewhere.tool.open();
  void elsewhere.tool.run('https://shop.example.com');
  assert.strictEqual(elsewhere.tool.link().status, 'idle', 'a check of another address is not this one running');
  s.kept.set(`${PREFIX}site-url:octo/demo`, 'https://other.example.com');
  assert.deepStrictEqual([s.tool.link().result, s.tool.link().status], [null, 'idle'], 'a check of another address is not this one\u2019s');
});

check('a check is followed stage by stage, ended, remembered for the page and its repository, and the audit drawn again', async () => {
  const s = setup();
  s.tool.open();
  assert.deepStrictEqual(s.of('render').at(-1), ['render', 'idle', 'https://demo.example.com/home', 'Octo/Demo']);
  const running = s.tool.run('  https://demo.example.com/home  ');
  assert.deepStrictEqual(s.of('render').at(-1), ['render', 'running', 'https://demo.example.com/home', 'Octo/Demo']);
  assert.strictEqual(s.tool.link().status, 'running');
  await running;
  assert.deepStrictEqual(s.of('api').map(entry => entry[1]), [
    '/api/site-check?url=https%3A%2F%2Fdemo.example.com%2Fhome',
    '/api/site-check?url=https%3A%2F%2Fdemo.example.com%2Fhome&run=r%201',
    '/api/site-check?url=https%3A%2F%2Fdemo.example.com%2Fhome&run=r%201'
  ]);
  assert.deepStrictEqual(s.of('pause').map(entry => entry[1]), [700, 875], 'asked again a little later each time');
  assert.deepStrictEqual(s.of('store'), [['store', `${PREFIX}site-url:standalone`, 'https://demo.example.com'], ['store', `${PREFIX}site-url:octo/demo`, 'https://demo.example.com']]);
  assert.deepStrictEqual(s.of('remember'), [['remember', 'site:https://demo.example.com', '2026-11-20T10:00:00Z']]);
  assert.deepStrictEqual([s.page.view.status, s.page.view.url, s.page.view.result, s.page.view.diff, s.page.view.from], ['done', 'https://demo.example.com', RESULT, { against: 'none' }, 'Octo/Demo']);
  assert.deepStrictEqual(s.log.slice(-2).map(entry => entry[0]), ['render', 'repaint-audit']);
  const progress = s.log.filter(entry => entry[0] === 'render' && entry[1] === 'running').length;
  assert.strictEqual(progress, 3, 'drawn as it starts and at each stage heard');
});

check('a check that ends while the reader is elsewhere draws the audit again, and not the page', async () => {
  const s = setup();
  s.tool.open();
  const gate = held();
  const elsewhere = setup({ gates: { 2: gate } });
  elsewhere.tool.open();
  const running = elsewhere.tool.run('https://demo.example.com');
  await settle();
  elsewhere.page.page = 'work';
  const before = elsewhere.renders();
  gate.release();
  await running;
  assert.strictEqual(elsewhere.renders(), before + 1, 'the stage heard before the reader left is the last drawn');
  assert.deepStrictEqual(elsewhere.log.at(-1), ['repaint-audit']);
  assert.strictEqual(elsewhere.tool.link().status, 'done');
});

check('the network\u2019s and the edge\u2019s failures are asked again a few times, waiting as long as asked; any other is said', async () => {
  const blip = Object.assign(new Error('offline'), { transient: true, retryAfter: 3 });
  const s = setup({ answers: [{ state: 'running', run: 'r' }, blip, blip, RESULT] });
  s.tool.open();
  await s.tool.run('https://demo.example.com');
  assert.deepStrictEqual(s.of('pause').map(entry => entry[1]), [700, 4000, 4000]);
  assert.strictEqual(s.page.view.status, 'done');
  const many = setup({ answers: [{ state: 'running', run: 'r' }, blip, blip, blip, RESULT], tries: 2 });
  many.tool.open();
  await many.tool.run('https://demo.example.com');
  assert.deepStrictEqual([many.page.view.status, many.page.view.error], ['error', 'offline']);
  const refused = setup({ answers: [Object.assign(new Error('A site check ran moments ago. Wait a few seconds and try again.'), { status: 429 })] });
  refused.tool.open();
  await refused.tool.run('https://demo.example.com');
  assert.deepStrictEqual([refused.page.view.status, refused.page.view.error, refused.page.view.url], ['error', 'A site check ran moments ago. Wait a few seconds and try again.', 'https://demo.example.com']);
  assert.deepStrictEqual(refused.log.at(-1), ['repaint-audit']);
  const wordless = setup({ answers: [new Error('')] });
  wordless.tool.open();
  await wordless.tool.run('https://demo.example.com');
  assert.strictEqual(wordless.page.view.error, 'The site could not be checked.');
  const spaced = setup({ answers: [{ state: 'running', run: 'r' }, blip, { state: 'running', run: 'r' }, blip, blip, RESULT], tries: 2 });
  spaced.tool.open();
  await spaced.tool.run('https://demo.example.com');
  assert.strictEqual(spaced.page.view.status, 'done', 'an answer heard between failures starts their count again');
  const later = setup({ answers: [{ state: 'running', run: 'r' }, Object.assign(new Error('late'), { transient: true, retryAfter: '5' }), RESULT] });
  later.tool.open();
  await later.tool.run('https://demo.example.com');
  assert.deepStrictEqual(later.of('pause').map(entry => entry[1]), [700, 1050]);
});

check('an answer without the address it checked is a failure, not a check left running', async () => {
  for (const answer of [null, {}, { origin: '' }, { origin: 7 }, 'done']) {
    const s = setup({ answers: [answer] });
    s.tool.open();
    await s.tool.run('https://demo.example.com');
    assert.deepStrictEqual([s.page.view.status, s.page.view.error], ['error', site.UNREADABLE], JSON.stringify(answer));
    assert.deepStrictEqual(s.of('store'), [], 'nothing remembered');
  }
});

check('a check let go of by the page, or by the session, is dropped where it is', async () => {
  for (const leave of [s => s.tool.clear(), s => { s.page.epoch = 2; }]) {
    const gate = held();
    const s = setup({ gates: { 2: gate } });
    s.tool.open();
    const running = s.tool.run('https://demo.example.com');
    await settle();
    leave(s);
    const logged = s.log.length;
    gate.release();
    await running;
    assert.deepStrictEqual(s.log.slice(logged).filter(entry => entry[0] !== 'api'), [], String(leave));
  }
  const failing = held();
  const s = setup({ answers: [{ state: 'running', run: 'r' }, new Error('gone')], gates: { 2: failing } });
  s.tool.open();
  const running = s.tool.run('https://demo.example.com');
  await settle();
  s.tool.clear();
  failing.release();
  await running;
  assert.ok(!s.log.some(entry => entry[0] === 'render' && entry[1] === 'error'), 'its failure unsaid');
  for (const leave of [t => t.tool.clear(), t => { t.page.epoch = 4; }]) {
    const last = held();
    const t = setup({ gates: { 3: last } });
    t.tool.open();
    const ending = t.tool.run('https://demo.example.com');
    await settle();
    leave(t);
    const logged = t.log.length;
    last.release();
    await ending;
    assert.deepStrictEqual(t.log.slice(logged), [], 'a result heard after it was let go of is neither kept nor drawn');
  }
  const leftWaiting = setup({ duringPause: page => { page.epoch = 9; } });
  leftWaiting.tool.open();
  await leftWaiting.tool.run('https://demo.example.com');
  assert.deepStrictEqual(leftWaiting.of('api').length, 1, 'a session left while waiting asks nothing more');
  const leftFailing = held();
  const failed = setup({ answers: [{ state: 'running', run: 'r' }, new Error('gone')], gates: { 2: leftFailing } });
  failed.tool.open();
  const failingRun = failed.tool.run('https://demo.example.com');
  await settle();
  failed.page.epoch = 3;
  leftFailing.release();
  await failingRun;
  assert.ok(!failed.log.some(entry => entry[0] === 'render' && entry[1] === 'error'), 'a failure heard after the session left is not said');
  const before = setup({ answers: [{ state: 'running', run: 'r' }, RESULT] });
  before.tool.open();
  const early = before.tool.run('https://demo.example.com');
  before.page.epoch = 2;
  await early;
  assert.deepStrictEqual(before.of('api').length, 1, 'the next stage is not asked once the session has gone');
});

check('one check at a time; with nothing on the page, nothing is checked', async () => {
  const gate = held();
  const s = setup({ gates: { 1: gate } });
  s.tool.open();
  const first = s.tool.run('https://a.example.com');
  await s.tool.run('https://b.example.com');
  assert.deepStrictEqual(s.of('api').length, 1);
  gate.release();
  await first;
  const blank = setup();
  await blank.tool.run('https://a.example.com');
  assert.deepStrictEqual(blank.log, []);
});

check('opened from the audit, the page is for its address and repository, and with check, checks it', async () => {
  const s = setup({ page: 'work' });
  s.tool.open({ check: true });
  assert.deepStrictEqual(s.log.slice(0, 3), [['page', 'site'], ['mount'], ['render', 'idle', 'https://demo.example.com/home', 'Octo/Demo']]);
  assert.strictEqual(s.page.renders[0].suggested, true, 'offered as the repository\u2019s declared homepage');
  await settle();
  assert.strictEqual(s.of('api')[0][1], '/api/site-check?url=https%3A%2F%2Fdemo.example.com%2Fhome');
  const failed = setup({ answers: [new Error('refused')] });
  failed.tool.open();
  await failed.tool.run('https://demo.example.com');
  failed.tool.open();
  assert.deepStrictEqual([failed.page.view.status, failed.page.view.error], ['error', ''], 'opened again, the last failure is not said again');
  const bare = setup({ work: { owner: 'o', repo: 'r' } });
  bare.tool.open({ check: true });
  await settle();
  assert.deepStrictEqual(bare.of('api'), [], 'without an address there is nothing to check');
  const gate = held();
  const busy = setup({ gates: { 1: gate } });
  busy.tool.open();
  void busy.tool.run('https://first.example.com');
  busy.page.work = { owner: 'x', repo: 'y', homepage: 'https://y.example.com' };
  busy.tool.open({ check: true });
  assert.deepStrictEqual([busy.page.view.url, busy.page.view.from, busy.of('api').length], ['https://first.example.com', null, 1], 'a check running is left as it is, and leads back to no other repository');
  gate.release();
  await settle();
  busy.page.work = { owner: 'Octo', repo: 'Demo' };
  busy.tool.open();
  assert.deepStrictEqual([busy.page.view.status, busy.page.view.error], ['done', '']);
});

check('from the rail the page is for any address; a check running keeps the repository it was sent from', async () => {
  const s = setup();
  s.tool.open();
  s.tool.openFromRail();
  assert.deepStrictEqual(s.of('render').at(-1), ['render', 'idle', 'https://demo.example.com/home', null]);
  assert.strictEqual(s.page.handlers.onSiteBack, null);
  const gate = held();
  const busy = setup({ gates: { 1: gate } });
  busy.tool.open();
  void busy.tool.run('https://demo.example.com');
  busy.tool.openFromRail();
  assert.strictEqual(busy.of('render').at(-1)[3], 'Octo/Demo');
  gate.release();
  await settle();
  const first = setup({ kept: { [`${PREFIX}site-url:standalone`]: 'https://last.example.com' } });
  first.tool.openFromRail();
  assert.deepStrictEqual(first.of('render').at(-1), ['render', 'idle', 'https://last.example.com', null], 'the last address checked on the page is offered');
});

check('the page leads back to the audit only for the repository open, and says why it cannot check when it cannot', () => {
  const s = setup();
  s.tool.open();
  s.page.handlers.onSiteBack();
  assert.deepStrictEqual(s.log.at(-1), ['audit']);
  s.page.work = { owner: 'other', repo: 'repo' };
  s.tool.paint();
  assert.deepStrictEqual([s.page.view.from, s.page.handlers.onSiteBack], [null, null]);
  const off = setup({ decision: { status: 'Unavailable', reason: 'Site checks are off on this deployment.' } });
  off.tool.show();
  assert.deepStrictEqual(off.log, [['page', 'site'], ['dispose'], ['refuse', 'Site checks are off on this deployment.']]);
  const reasonless = setup({ decision: { status: 'Unavailable' } });
  reasonless.tool.paint();
  assert.deepStrictEqual(reasonless.log.at(-1), ['refuse', '']);
});

check('the page\u2019s controls: an address typed is kept, checked, its prompts copied, and the result exported by its host and day', async () => {
  const s = setup();
  s.tool.open();
  s.page.handlers.onSiteInput('https://typed.example.com');
  s.tool.paint();
  assert.strictEqual(s.page.view.url, 'https://typed.example.com', 'an address typed is kept when the page is drawn again');
  s.page.handlers.onSiteCheck('https://typed.example.com');
  await settle();
  assert.strictEqual(s.of('api')[0][1], '/api/site-check?url=https%3A%2F%2Ftyped.example.com');
  await settle();
  const h = s.page.handlers;
  h.onCopy({ prompt: 'fix it' });
  assert.deepStrictEqual(s.log.at(-1), ['copy', 'fix it']);
  await h.onSiteCopyAll();
  assert.deepStrictEqual(s.log.slice(-2), [['copy-all', 'prompts of https://demo.example.com'], ['toast', 'Every site fix prompt copied', 'ok']]);
  h.onExport('sarif');
  h.onExport('csv');
  h.onExport('md');
  assert.deepStrictEqual(s.of('download'), [
    ['download', 'demo.example.com-site-check-2026-11-20.sarif', 'sarif:null:https://demo.example.com:{}', 'application/sarif+json'],
    ['download', 'demo.example.com-site-check-2026-11-20.csv', 'csv:null:https://demo.example.com:null', 'text/csv'],
    ['download', 'demo.example.com-site-check-2026-11-20.md', 'brief:null:demo.example.com:https://demo.example.com', 'text/markdown']
  ]);
  const undated = setup({ answers: [{ origin: 'https://x.example.com' }] });
  undated.tool.open();
  await undated.tool.run('https://x.example.com');
  undated.page.handlers.onExport('csv');
  assert.strictEqual(undated.of('download')[0][1], 'x.example.com-site-check-2026-11-23.csv');
  const blank = setup();
  blank.tool.open();
  blank.page.handlers.onExport('md');
  assert.deepStrictEqual(blank.of('download'), [], 'nothing to export before a check');
  const clipboard = setup({ clipboardFails: true });
  clipboard.tool.open();
  await clipboard.page.handlers.onSiteCopyAll();
  assert.deepStrictEqual(clipboard.log.at(-1), ['toast', 'The clipboard is not available here', 'err']);
});

check('the remembered address is a convenience: a browser that keeps nothing still checks, and the page lets go of everything when cleared', async () => {
  const s = setup({ storeThrows: true });
  s.tool.open();
  await s.tool.run('https://demo.example.com');
  assert.strictEqual(s.page.view.status, 'done');
  s.tool.clear();
  assert.deepStrictEqual(s.log.slice(-2), [['dispose'], ['screen-clear']]);
  assert.deepStrictEqual(s.tool.link().result, null);
  s.tool.paint();
  assert.deepStrictEqual(s.of('render').at(-1), ['render', 'idle', '', null]);
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
  console.log(`page site check: ${checks.length} checks passed`);
})();
