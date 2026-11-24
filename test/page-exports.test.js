'use strict';

/*
 * A repository's activity and evidence exports, and its security scan, asked
 * directly (features/safeguards/repository-exports.ts, security-scan.ts): the
 * verified events paged once each and in order, the activity offered as
 * Markdown, JSON and CSV from buttons bound as its dialog opens, the evidence
 * package named for its repository; the scan said incomplete rather than
 * clean when OSV could not be reached, and the upload gate's state said
 * whatever the server could say of it. Each belongs to the repository -- and
 * the scan to the branch -- it was asked of.
 */

const assert = require('assert');
const ex = require('../apps/web/src/features/safeguards/repository-exports.ts');
const scan = require('../apps/web/src/features/safeguards/security-scan.ts');
const { createDocument } = require('./helpers/markup-dom');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const read = html => { const doc = createDocument(); const body = doc.createElement('div'); doc.body.appendChild(body); body.innerHTML = html; return body; };
const NOW = Date.parse('2026-11-23T12:00:00Z');
const texts = (body, selector) => body.querySelectorAll(selector).map(node => node.textContent.replace(/\s+/g, ' ').trim());
/* The paragraphs said as hints, in order. */
const hints = body => body.querySelectorAll('p').filter(node => String(node.attributes.get('class') || '').split(' ').includes('hint')).map(node => node.textContent.replace(/\s+/g, ' ').trim());

const ACTIVITY = Object.freeze({
  owner: 'octo', repo: 'demo', days: 30, generatedAt: '2026-11-20T09:00:00Z',
  commits: [{ sha: 'abcdef0123456789', message: 'First light', author: 'Ada' }],
  pulls: [{ number: 7, title: 'Add <b>docs</b>', state: 'open' }],
  issues: [{ number: 9, title: 'Crash', state: 'closed' }, { number: 10, title: 'Slow', state: 'open' }],
  releases: [{ tag: 'v1.0.0', name: 'One' }, { tag: 'v0.9.0' }]
});
const EVENT = (id, createdAt, extra = {}) => ({ id, createdAt, severity: 'high', score: 80, summary: `event ${id}`, actor: 'ada', ...extra });

/* The page's stand-ins: every request, dialog, toast, download and error presented, in order. */
function exportsSetup(options = {}) {
  const log = [];
  const page = { work: { owner: 'octo', repo: 'demo', branch: 'main' } };
  const gates = {};
  const pages = options.pages || [{ available: true, events: [EVENT('e1', '2026-11-19T10:00:00Z')], hasMore: false }];
  let pageIndex = 0;
  let opened = null;
  const tools = ex.createRepositoryExports({
    api: async path => {
      log.push(['api', path]);
      const name = path.split('?')[0].split('/').slice(5).join('/');
      if (gates[name]) await gates[name].promise;
      const answer = options.answers && name in options.answers ? options.answers[name] : undefined;
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return typeof answer === 'function' ? answer(path) : answer;
      if (name === 'activity') return ACTIVITY;
      if (name === 'intelligence/events') {
        const next = pages[Math.min(pageIndex, pages.length - 1)];
        pageIndex += 1;
        if (next instanceof Error) throw next;
        return next;
      }
      if (name === 'evidence') return { generatedAt: '2026-11-21T08:00:00Z', events: [1, 2], snapshots: [1], chain: { available: true, valid: true } };
      throw new Error(`unexpected ${path}`);
    },
    work: () => page.work,
    modal: async dialog => {
      log.push(['modal', dialog.title, dialog.bodyHTML, dialog.okText]);
      opened = read(dialog.bodyHTML);
      if (dialog.onOpen) dialog.onOpen(opened);
      return true;
    },
    toast: (message, kind) => log.push(['toast', String(message), kind]),
    present: error => log.push(['present', error && error.message]),
    download: (name, text, type) => log.push(['download', name, text, type]),
    csv: activity => `csv:${activity.repo}:${(activity.commits || []).length}`,
    now: () => NOW
  });
  const of = kind => log.filter(entry => entry[0] === kind);
  return { tools, page, log, of, sent: () => of('api').map(entry => entry[1]), body: () => opened, gate: name => (gates[name] = held()) };
}

check('a day is the answer\u2019s own, or today\u2019s when it does not say one', () => {
  assert.strictEqual(ex.dayOf('2026-11-20T23:59:00Z', NOW), '2026-11-20');
  assert.strictEqual(ex.dayOf(Date.parse('2026-01-02T00:00:00Z'), NOW), '2026-01-02');
  assert.strictEqual(ex.dayOf('1970-01-01T00:00:00Z', NOW), '1970-01-01', 'the first day is a day');
  for (const odd of [undefined, null, '', 'not a time', {}, NaN]) assert.strictEqual(ex.dayOf(odd, NOW), '2026-11-23', String(odd));
});

check('the verified events are paged by their cursor, kept once each and oldest first, up to five pages', async () => {
  const asked = [];
  const answers = [
    { available: true, events: [EVENT('b', '2026-11-02T00:00:00Z'), EVENT('a', '2026-11-03T00:00:00Z'), { summary: 'no id' }, null], hasMore: true, cursor: 'c 1' },
    { available: true, truncatedBefore: true, events: [EVENT('b', '2026-11-02T00:00:00Z', { summary: 'b again' }), EVENT('a2', '2026-11-03T00:00:00Z'), EVENT('a0', '2026-11-03T00:00:00Z'), EVENT(7, '2026-11-01T00:00:00Z')], hasMore: true, cursor: 'c2' },
    { available: true, events: [], hasMore: false, cursor: 'c3' }
  ];
  const got = await ex.intelligenceEvents(async path => { asked.push(path); return answers[asked.length - 1]; }, '/api/repo/octo/demo');
  assert.deepStrictEqual(asked, ['/api/repo/octo/demo/intelligence/events?limit=500', '/api/repo/octo/demo/intelligence/events?limit=500&after=c%201', '/api/repo/octo/demo/intelligence/events?limit=500&after=c2']);
  assert.deepStrictEqual(got.events.map(event => event.id), [7, 'b', 'a', 'a0', 'a2'], 'oldest first, the same time by id');
  assert.strictEqual(got.events[1].summary, 'b again', 'an event seen twice is kept once, as last read');
  assert.deepStrictEqual([got.available, got.truncatedBefore], [true, true]);
  let count = 0;
  const endless = await ex.intelligenceEvents(async () => { count += 1; return { available: true, events: [EVENT(`e${count}`, `2026-11-0${count}T00:00:00Z`)], hasMore: true, cursor: `c${count}` }; }, '/x');
  assert.deepStrictEqual([count, endless.events.length], [5, 5], 'five pages at most');
  let stops = 0;
  await ex.intelligenceEvents(async () => { stops += 1; return { available: true, events: [], hasMore: true, cursor: '' }; }, '/x');
  assert.strictEqual(stops, 1, 'more without a cursor is the end');
  const off = await ex.intelligenceEvents(async () => ({ available: false, events: 'none' }), '/x');
  assert.deepStrictEqual([off.available, off.events], [false, []]);
  for (const odd of [null, 'x', 7]) await assert.rejects(ex.intelligenceEvents(async () => odd, '/x'), { message: ex.EVENTS_UNREADABLE }, String(odd));
});

check('the activity as Markdown names every kind, its items as text, and why there are no verified events', () => {
  const md = ex.activityMarkdown({ ...ACTIVITY, intelligenceAvailable: true, intelligenceEvents: [EVENT('e1', '2026-11-19T10:00:00Z'), { id: 'e2' }] });
  assert.deepStrictEqual(md.split('\n'), [
    '# octo/demo \u2014 last 30 days', '',
    '## Commits (1)', '- `abcdef01` First light \u2014 Ada', '',
    '## Pull requests (1)', '- #7 Add <b>docs</b> (open)', '',
    '## Issues (2)', '- #9 Crash (closed)', '- #10 Slow (open)', '',
    '## Releases (2)', '- v1.0.0 One', '- v0.9.0 ', '',
    '## Verified intelligence events (2)',
    '- 2026-11-19T10:00:00Z [high \u00b7 80] event e1 \u2014 ada',
    '-  [normal \u00b7 0] event \u2014 unknown actor'
  ]);
  const bare = ex.activityMarkdown({ commits: [{}], intelligenceAvailable: false, intelligenceError: 'Neon down' });
  assert.ok(!bare.includes('undefined'), bare);
  assert.ok(bare.startsWith('# / \u2014 last  days\n'), bare);
  assert.ok(ex.activityMarkdown({ owner: 'o', repo: 'r', days: 7 }).startsWith('# o/r \u2014 last 7 days\n'));
  assert.ok(bare.includes('## Commits (1)\n- ``  \u2014 \n') && bare.includes('## Pull requests (0)'), bare);
  assert.ok(bare.endsWith('## Verified intelligence events (0)\n- Unavailable: Neon down'), bare);
  assert.ok(ex.activityMarkdown({ intelligenceAvailable: false }).endsWith('- Unavailable because Neon-backed live intelligence is not enabled.'));
  assert.ok(ex.activityMarkdown({ intelligenceAvailable: true, intelligenceEvents: [EVENT('x', 't', { eventType: 'push', summary: '' })] }).endsWith('[high \u00b7 80] push \u2014 ada'));
});

check('the activity is collected with its verified events, counted, and offered as Markdown, JSON and CSV from its own buttons', async () => {
  const s = exportsSetup();
  await s.tools.activity();
  assert.deepStrictEqual(s.sent(), ['/api/repo/octo/demo/activity?days=30', '/api/repo/octo/demo/intelligence/events?limit=500']);
  assert.deepStrictEqual(s.of('toast'), [['toast', 'Collecting activity and verified events\u2026', 'ok']]);
  const [, title, html, okText] = s.of('modal')[0];
  assert.deepStrictEqual([title, okText], ['Activity export ready', 'Close']);
  assert.deepStrictEqual(texts(read(html), 'p'), ['1 commits \u00b7 1 PRs \u00b7 2 issues \u00b7 2 releases \u00b7 1 verified event(s).']);
  const body = s.body();
  for (const id of ['actMd', 'actJson', 'actCsv']) await body.querySelector('#' + id).click();
  const [md, json, csv] = s.of('download');
  assert.deepStrictEqual([md[1], md[3]], ['demo-activity-2026-11-20.md', 'text/markdown']);
  assert.strictEqual(md[2], ex.activityMarkdown(JSON.parse(json[2])));
  assert.deepStrictEqual([json[1], json[3]], ['demo-activity-2026-11-20.json', undefined]);
  const kept = JSON.parse(json[2]);
  assert.strictEqual(json[2], JSON.stringify(kept, null, 2), 'written to be read');
  assert.deepStrictEqual([kept.repo, kept.commits.length, kept.intelligenceAvailable, kept.intelligenceHistoryTruncated, kept.intelligenceEvents.map(event => event.id), kept.intelligenceError], ['demo', 1, true, false, ['e1'], '']);
  assert.deepStrictEqual(csv.slice(1), ['demo-activity-2026-11-20.csv', 'csv:demo:1', 'text/csv']);
  assert.strictEqual(s.of('download').length, 3, 'nothing is downloaded until asked');
});

check('verified events cut short or unavailable are said; the provider\u2019s activity is exported all the same', async () => {
  const cut = exportsSetup({ pages: [{ available: true, truncatedBefore: true, events: [], hasMore: false }] });
  await cut.tools.activity();
  assert.ok(texts(read(cut.of('modal')[0][2]), 'p')[1].startsWith('Verified-event export contains the latest 500 retained events'));
  await cut.body().querySelector('#actJson').click();
  assert.strictEqual(JSON.parse(cut.of('download')[0][2]).intelligenceHistoryTruncated, true);
  for (const pages of [[{ available: false, events: [] }], [new Error('Neon down')], [null]]) {
    const off = exportsSetup({ pages });
    await off.tools.activity();
    const said = texts(read(off.of('modal')[0][2]), 'p');
    assert.strictEqual(said.length, 2, JSON.stringify(pages));
    assert.ok(said[1].startsWith('Verified-event history is unavailable without Neon-backed live intelligence'));
    await off.body().querySelector('#actJson').click();
    const kept = JSON.parse(off.of('download')[0][2]);
    assert.deepStrictEqual([kept.intelligenceAvailable, kept.intelligenceEvents], [false, []]);
    assert.strictEqual(kept.intelligenceError, pages[0] instanceof Error ? 'Neon down' : pages[0] === null ? ex.EVENTS_UNREADABLE : '');
  }
});

check('an activity answer without its lists is counted as none, and named for the repository asked of', async () => {
  for (const answer of [{}, null, { repo: 7, commits: 'x', pulls: null, generatedAt: 'never' }]) {
    const s = exportsSetup({ answers: { activity: answer } });
    await s.tools.activity();
    assert.deepStrictEqual(texts(read(s.of('modal')[0][2]), 'p')[0], '0 commits \u00b7 0 PRs \u00b7 0 issues \u00b7 0 releases \u00b7 1 verified event(s).', JSON.stringify(answer));
    await s.body().querySelector('#actMd').click();
    assert.strictEqual(s.of('download')[0][1], 'demo-activity-2026-11-23.md', JSON.stringify(answer));
  }
});

check('an activity failure is said; one answered after another repository was opened is neither shown nor said there', async () => {
  const failed = exportsSetup({ answers: { activity: new Error('Not Found') } });
  await failed.tools.activity();
  assert.deepStrictEqual(failed.of('toast').at(-1), ['toast', 'Not Found', 'err']);
  assert.strictEqual(failed.of('modal').length, 0);
  const late = exportsSetup();
  const gate = late.gate('activity');
  const running = late.tools.activity();
  await settle();
  late.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  gate.release();
  await running;
  assert.deepStrictEqual([late.of('modal').length, late.of('download').length], [0, 0]);
  assert.deepStrictEqual(late.sent(), ['/api/repo/octo/demo/activity?days=30', '/api/repo/octo/demo/intelligence/events?limit=500']);
  const lateEvents = exportsSetup({ pages: [{ available: true, events: [], hasMore: true, cursor: 'c1' }, { available: true, events: [], hasMore: false }] });
  const eventsGate = lateEvents.gate('intelligence/events');
  const runningEvents = lateEvents.tools.activity();
  await settle();
  lateEvents.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  eventsGate.release();
  await runningEvents;
  assert.deepStrictEqual(lateEvents.sent().slice(1), ['/api/repo/octo/demo/intelligence/events?limit=500', '/api/repo/octo/demo/intelligence/events?limit=500&after=c1'], 'every page from the repository asked of');
  assert.strictEqual(lateEvents.of('modal').length, 0);
  const lateFailure = exportsSetup({ answers: { activity: new Error('Not Found') } });
  const failureGate = lateFailure.gate('activity');
  const failing = lateFailure.tools.activity();
  await settle();
  lateFailure.page.work = null;
  failureGate.release();
  await failing;
  assert.deepStrictEqual(lateFailure.of('toast').map(entry => entry[2]), ['ok'], 'a failure answered after is not said there');
  const closed = exportsSetup();
  closed.page.work = null;
  await closed.tools.activity();
  assert.deepStrictEqual(closed.log, []);
});

check('the evidence package is downloaded as signed, named for its repository and day, and its chain said', async () => {
  const s = exportsSetup();
  await s.tools.evidence();
  assert.deepStrictEqual(s.sent(), ['/api/repo/octo/demo/evidence']);
  const [, name, text, type] = s.of('download')[0];
  assert.deepStrictEqual([name, JSON.parse(text).chain, type], ['demo-evidence-2026-11-21.json', { available: true, valid: true }, undefined]);
  assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2));
  const [, title, html, okText] = s.of('modal')[0];
  assert.deepStrictEqual([title, okText], ['Evidence package exported', 'Done']);
  assert.strictEqual(read(html).querySelector('p').textContent, '2 verified event(s), 1 signed snapshot(s). Evidence chain: valid.');
  assert.deepStrictEqual(s.of('toast'), [['toast', 'Building verifiable evidence package\u2026', 'ok']]);
  for (const [chain, word] of [[{ available: true, valid: false }, 'verification failed'], [{ available: false }, 'unavailable without Neon'], [undefined, 'unavailable without Neon']]) {
    const other = exportsSetup({ answers: { evidence: { events: 'x', chain } } });
    await other.tools.evidence();
    assert.strictEqual(read(other.of('modal')[0][2]).querySelector('p').textContent, `0 verified event(s), 0 signed snapshot(s). Evidence chain: ${word}.`);
    assert.strictEqual(other.of('download')[0][1], 'demo-evidence-2026-11-23.json');
  }
});

check('evidence answered after another repository was opened is named for its own and not described there; a failure is presented only where asked', async () => {
  const late = exportsSetup();
  const gate = late.gate('evidence');
  const running = late.tools.evidence();
  await settle();
  late.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  gate.release();
  await running;
  assert.deepStrictEqual(late.of('download').map(entry => entry[1]), ['demo-evidence-2026-11-21.json']);
  assert.strictEqual(late.of('modal').length, 0);
  const failed = exportsSetup({ answers: { evidence: new Error('Signed snapshots require the existing Neon DATABASE_URL') } });
  await failed.tools.evidence();
  assert.deepStrictEqual(failed.of('present'), [['present', 'Signed snapshots require the existing Neon DATABASE_URL']]);
  const lateFailure = exportsSetup({ answers: { evidence: new Error('Not Found') } });
  const failureGate = lateFailure.gate('evidence');
  const failing = lateFailure.tools.evidence();
  await settle();
  lateFailure.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  failureGate.release();
  await failing;
  assert.deepStrictEqual([lateFailure.of('present').length, lateFailure.of('download').length], [0, 0]);
  const closed = exportsSetup();
  closed.page.work = null;
  await closed.tools.evidence();
  assert.deepStrictEqual(closed.log, []);
});

/* The scan's stand-ins. */
function scanSetup(options = {}) {
  const log = [];
  const page = { work: { owner: 'octo', repo: 'demo', branch: options.branch || 'main' } };
  const gates = {};
  const tools = scan.createSecurityScan({
    api: async path => {
      log.push(['api', path]);
      const name = path.startsWith('/api/security/') ? 'scanner' : 'audit';
      if (gates[name]) await gates[name].promise;
      const answer = options[name];
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer;
      if (name === 'scanner') return { builtin: { available: true }, yara: { configured: false, required: false } };
      return { scanned: 3, sources: [{ file: 'package-lock.json' }], vulnerable: [], details: {}, osv: { available: true }, dependabot: { available: true, alerts: [] } };
    },
    work: () => page.work,
    modal: async dialog => { log.push(['modal', dialog.title, dialog.bodyHTML, dialog.okText]); return true; },
    toast: (message, kind) => log.push(['toast', String(message), kind])
  });
  const of = kind => log.filter(entry => entry[0] === kind);
  return { tools, page, log, of, gate: name => (gates[name] = held()) };
}
const gateLine = body => body.querySelectorAll('.neural-report-banner').map(node => `${node.querySelector('b').textContent} ${node.querySelector('p').textContent}`).find(line => line.startsWith('Upload malware gate'));

check('a scan reports each vulnerable package with its advisories, the first that is described, and where versions came from', () => {
  const report = scan.scanReport({
    scanned: 4, approximate: true, sources: [{ file: 'package.json' }, { file: '<b>requirements.txt</b>' }],
    vulnerable: [{ name: '<i>lodash</i>', version: '4.17.20', ecosystem: 'npm', ids: ['GHSA-1', 'CVE-2'] }, { name: 'flask', version: '0.12', ecosystem: 'PyPI', ids: ['PYSEC-9'] }],
    details: { 'CVE-2': { severity: 'HIGH', summary: 'Prototype <pollution>' }, 'PYSEC-9': {} },
    osv: { available: true }, dependabot: { available: true, alerts: [1, 2, 3] }
  }, { builtin: { available: true }, yara: { configured: true, required: true } });
  assert.strictEqual(report.title, '2 vulnerable package(s)');
  const body = read(report.bodyHTML);
  assert.strictEqual(body.querySelectorAll('i').length + body.querySelectorAll('b').filter(node => node.textContent === 'requirements.txt').length, 0, 'names are text');
  assert.deepStrictEqual(texts(body, '.glass p'), ['<i>lodash</i>@4.17.20 (npm)', 'GHSA-1, CVE-2 \u2014 HIGH', 'Prototype <pollution>', 'flask@0.12 (PyPI)', 'PYSEC-9']);
  const said = hints(body);
  assert.strictEqual(said[0], '4 package(s) checked against the OSV database from package.json, <b>requirements.txt</b>.');
  assert.ok(said.includes('Versions came from package.json ranges \u2014 commit a lockfile for exact results.'));
  assert.ok(said.includes('Dependabot: 3 open alert(s).'));
  assert.ok(!said.some(line => line.startsWith('No supported manifest')));
  assert.strictEqual(gateLine(body), 'Upload malware gate Built-in whole-file signature scan: active. Optional YARA adapter: configured and required.');
  assert.ok(!body.textContent.includes('OSV could not be reached'));
});

check('a scan whose OSV check could not be reached is incomplete, never clean, and says why', () => {
  for (const osv of [{ available: false, error: 'OSV <timeout>' }, { available: false }, null, undefined]) {
    const report = scan.scanReport({ scanned: 9, sources: [], vulnerable: [], details: {}, osv, dependabot: {} }, {});
    assert.strictEqual(report.title, 'Dependency scan incomplete', JSON.stringify(osv));
    const body = read(report.bodyHTML);
    const banner = body.querySelector('.neural-report-banner');
    assert.strictEqual(banner.querySelector('b').textContent, 'OSV could not be reached.');
    assert.strictEqual(banner.querySelector('p').textContent, `${(osv && osv.error) || 'The vulnerability database did not return a usable response.'} No clean result is claimed; retry the scan later.`);
    assert.strictEqual(hints(body)[0], '9 package(s) resolved from manifests.');
  }
  const vulnerableOffline = scan.scanReport({ scanned: 2, vulnerable: [{ name: 'x', ids: [] }], osv: { available: false } }, {});
  assert.strictEqual(vulnerableOffline.title, 'Dependency scan incomplete');
  const clean = scan.scanReport({ scanned: 2, vulnerable: [], osv: { available: true }, sources: [] }, {});
  assert.strictEqual(clean.title, 'No known vulnerabilities');
  const none = read(scan.scanReport({ scanned: 0, vulnerable: [], osv: null, sources: [] }, {}).bodyHTML);
  assert.strictEqual(scan.scanReport({ scanned: 0, osv: null }, {}).title, 'No known vulnerabilities', 'nothing to check is not an incomplete check');
  assert.deepStrictEqual(hints(none).slice(0, 2), ['0 package(s) checked against the OSV database.', 'No supported manifest found (package-lock.json, package.json, requirements.txt, go.mod, Cargo.lock, Gemfile.lock).']);
});

check('the upload gate is said as the server says it, and as unavailable with why when it cannot say', () => {
  const gate = scanner => gateLine(read(scan.scanReport({ scanned: 0 }, scanner).bodyHTML));
  assert.strictEqual(gate({ builtin: { available: false }, yara: { configured: true } }), 'Upload malware gate Built-in whole-file signature scan: unavailable. Optional YARA adapter: configured.');
  assert.strictEqual(gate(scan.scannerUnknown(new Error('Forbidden <x>'))), 'Upload malware gate Built-in whole-file signature scan: unavailable. Optional YARA adapter: not configured \u2014 Forbidden <x>.');
  assert.deepStrictEqual(scan.scannerUnknown('x'), { builtin: { available: false }, yara: { configured: false, required: false }, error: undefined });
  assert.strictEqual(gate(null), 'Upload malware gate Built-in whole-file signature scan: unavailable. Optional YARA adapter: not configured.');
  const dependabot = db => hints(read(scan.scanReport({ scanned: 0, dependabot: db }, {}).bodyHTML)).filter(line => line.startsWith('Dependabot'));
  assert.deepStrictEqual(dependabot({ available: false, note: 'needs <b>security_events</b>' }), ['Dependabot unavailable \u2014 needs <b>security_events</b>.']);
  assert.deepStrictEqual(dependabot({ available: true, alerts: 'x' }), ['Dependabot: 0 open alert(s).']);
  assert.deepStrictEqual(dependabot(undefined), []);
});

check('an answer without its parts is reported as none rather than stopping at a script error', () => {
  for (const answer of [null, {}, 'x', { scanned: '5', vulnerable: 'x', sources: 'y' }, { scanned: 1, osv: { available: true }, vulnerable: [null, { ids: 'x' }], details: null }]) {
    const report = scan.scanReport(answer, undefined);
    assert.ok(typeof report.title === 'string' && !report.bodyHTML.includes('undefined'), JSON.stringify(answer));
  }
  const unnumbered = read(scan.scanReport({ scanned: '5', osv: null }, {}).bodyHTML);
  assert.deepStrictEqual(hints(unnumbered).slice(0, 2), ['0 package(s) checked against the OSV database.', 'No supported manifest found (package-lock.json, package.json, requirements.txt, go.mod, Cargo.lock, Gemfile.lock).'], 'a count that is not a number is none');
});

check('the scan asks for the branch open and the upload gate at once, and shows its report there', async () => {
  const s = scanSetup({ branch: 'feature/a b' });
  await s.tools.scan();
  assert.deepStrictEqual(s.of('api').map(entry => entry[1]), ['/api/repo/octo/demo/audit-deps?ref=feature%2Fa%20b', '/api/security/scanner-status']);
  assert.deepStrictEqual(s.of('toast'), [['toast', 'Scanning dependencies and checking upload defenses\u2026', 'ok']]);
  const [, title, html, okText] = s.of('modal')[0];
  assert.deepStrictEqual([title, okText], ['No known vulnerabilities', 'Done']);
  assert.strictEqual(gateLine(read(html)), 'Upload malware gate Built-in whole-file signature scan: active. Optional YARA adapter: not configured.');
  const refused = scanSetup({ scanner: Object.assign(new Error('Forbidden'), { status: 403 }) });
  await refused.tools.scan();
  assert.strictEqual(gateLine(read(refused.of('modal')[0][2])), 'Upload malware gate Built-in whole-file signature scan: unavailable. Optional YARA adapter: not configured \u2014 Forbidden.');
  const closed = scanSetup();
  closed.page.work = null;
  await closed.tools.scan();
  assert.deepStrictEqual(closed.log, []);
});

check('a scan answered after another branch or repository was opened is neither shown nor its failure said there', async () => {
  for (const move of [page => { page.work.branch = 'dev'; }, page => { page.work = { owner: 'octo', repo: 'other', branch: 'main' }; }, page => { page.work = null; }]) {
    for (const audit of [undefined, new Error('Not Found')]) {
      const s = scanSetup({ audit });
      const gate = s.gate('audit');
      const running = s.tools.scan();
      await settle();
      move(s.page);
      gate.release();
      await running;
      assert.deepStrictEqual([s.of('modal').length, s.of('toast').length], [0, 1], String(move) + String(audit));
    }
  }
  const back = scanSetup();
  const gate = back.gate('audit');
  const running = back.tools.scan();
  await settle();
  back.page.work.branch = 'dev';
  back.page.work.branch = 'main';
  gate.release();
  await running;
  assert.strictEqual(back.of('modal').length, 1, 'back on the branch asked of, the report is shown');
  const failed = scanSetup({ audit: new Error('Not Found') });
  await failed.tools.scan();
  assert.deepStrictEqual(failed.of('toast').at(-1), ['toast', 'Not Found', 'err']);
  assert.strictEqual(failed.of('modal').length, 0);
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
  console.log(`page exports: ${checks.length} checks passed`);
})();
