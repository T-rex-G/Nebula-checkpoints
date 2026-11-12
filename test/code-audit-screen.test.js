'use strict';

/*
 * The code audit's screen: what each card decides, asked of its model, and
 * what the screen draws, rendered to the markup a reader's browser receives
 * first -- over real engine results, real site checks and kept audits in the
 * shapes the server answers with. Nothing of the page's text is read.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { analyse, auditHistory } = require('../apps/api/src/modules/uranus/index.ts');
const { checkSite } = require('../apps/api/src/modules/parallax/index.ts').siteCheck;
const { riskyResult } = require('./e2e/code-audit-risk-fixture.js');
const screen = require('../apps/web/src/features/uranus/audit-screen.ts');
const cards = require('../apps/web/src/features/uranus/audit-cards.ts');
const listing = require('../apps/web/src/features/uranus/audit-findings.ts');
const kept = require('../apps/web/src/features/uranus/audit-history.ts');
const sites = require('../apps/web/src/features/uranus/audit-site.ts');
const { loadPageModule } = require('./helpers/page-module');

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const DAY = 864e5;
const blank = () => ({
  status: 'idle', result: null, diff: null, error: '', progress: null, filter: null, severity: null, verdict: null, exploit: null, owasp: null, query: '', limit: 0,
  history: { status: 'idle' }, watch: { status: 'idle' }, historyOpen: new Set(), historyDetail: new Map(), triage: { status: 'idle' }, metrics: { status: 'idle' }
});

/* The page's screen, run as the browser runs it, against a stand-in window with storage and no motion preference. */
const storage = new Map();
const view = loadPageModule('apps/web/src/features/uranus/AuditScreen.tsx', {
  window: {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, setTimeout, clearTimeout
  },
  document: { documentElement: { dataset: {} } },
  CSS: { escape: value => String(value) }
});
const markup = (input, handlers = {}) => renderToStaticMarkup(createElement(view.AuditScreen, { host: {}, view: input, handlers, now: NOW }));
const siteMarkup = (input, handlers = {}) => renderToStaticMarkup(createElement(view.SiteScreen, { site: input, handlers, now: NOW }));
const all = { onRun() {}, onExport() {}, onCopyAll() {}, onCopy: () => true, onWatchCheck() {}, onHistoryToggle() {}, onHistoryOpen() {}, onHistoryClear() {},
  onHistoryExport() {}, onTriage() {}, onReopen() {}, onTriageHistory() {}, onFilter() {}, onOwasp() {}, onSeverity() {}, onVerdict() {}, onExploit() {}, onReveal() {},
  onQuery() {}, onMore() {}, onOpen() {}, onSiteOpen() {}, onSiteBack() {}, onSiteInput() {}, onSiteCheck() {}, onSiteCopyAll() {} };

/* What a drawn screen must never say: a value read from nothing, or a time that is no time. */
function clean(html, label) {
  for (const word of ['undefined', 'NaN', '[object Object]', 'Invalid Date', 'null of', 'of null']) assert(!html.includes(word), `${label}: says ${word}`);
}
/* Every section names its heading, and every fold controls a body that is there. */
function wired(html, label) {
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]));
  for (const [, id] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert(ids.has(id), `${label}: aria-labelledby ${id} names nothing`);
  for (const [, id] of html.matchAll(/aria-controls="([^"]+)"/g)) assert(ids.has(id), `${label}: aria-controls ${id} names nothing`);
  const keys = [...html.matchAll(/data-key="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(keys).size, keys.length, `${label}: a control key is used twice, so focus could return to the wrong one: ${keys.filter((key, index) => keys.indexOf(key) !== index)}`);
}

(async () => {
  /* ---- Real readings ----------------------------------------------------------- */
  const files = [
    { path: 'package.json', text: JSON.stringify({ name: 'demo', dependencies: { express: '*' } }) },
    { path: 'api/users.js', text: "app.get('/u/:id', async (req, res) => {\n  await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);\n});\napp.post('/u', async (req, res) => { await User.create(req.body); });\n" },
    { path: 'src/nonce.js', text: 'const token = Math.random(); // nv-audit-ignore SEC-005 -- display nonce\n' }
  ];
  const code = { ...analyse({ files, paths: files.map(file => file.path) }), commitSha: 'c'.repeat(40), ref: 'main', auditedAt: new Date(NOW - 60000).toISOString(),
    coverage: { read: 3, eligible: 3, packages: { declared: 1, checked: 1, unknown: 0, notChecked: 0 }, skipped: {} } };
  const risky = { ...riskyResult(), auditedAt: new Date(NOW - 60000).toISOString() };
  const site = {
    ...(await checkSite({
      url: 'https://demo.example.com', txt: async () => [],
      transport: async input => new URL(input.url).pathname === '/.env'
        ? { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'SECRET_KEY=canary-value\n' }
        : new URL(input.url).pathname === '/'
          ? { statusCode: 200, headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' }, body: '<!doctype html>', tls: { protocol: 'TLSv1.3', validTo: '2099-01-01T00:00:00.000Z' } }
          : { statusCode: 404, headers: {}, body: '' }
    })),
    checkedAt: new Date(NOW - 120000).toISOString()
  };
  /* Kept audits in the server's own shape, newest first. */
  const rows = [risky, { ...risky, findings: risky.findings.slice(1), score: 64, grade: 'D', capped: false, capReason: null }, code].map((result, index) => {
    const compact = auditHistory.compactAudit({ ...result, commitSha: String(index + 1).repeat(40), ref: 'main', auditedAt: new Date(NOW - (index * 7 + 1) * DAY).toISOString() });
    return auditHistory.serialize.audit({ ...compact.audit, audit_id: crypto.randomUUID(), new_count: index ? 1 : null, resolved_count: index ? 2 : null });
  });
  const history = { status: 'ready', audits: rows, branches: [{ ref: 'main', audits: 3, lastAt: rows[0].auditedAt }, { ref: 'next', audits: 1, lastAt: rows[1].auditedAt }] };

  /* ---- The summary ---------------------------------------------------------------- */
  {
    const idle = screen.summary(blank(), NOW);
    assert.equal(idle.body.kind, 'scope');
    assert.equal(idle.ring.label, 'Not audited');
    assert.equal(idle.run.label, 'Audit this branch');
    assert.equal(idle.exports, null);
    const stored = screen.summary({ ...blank(), history }, NOW);
    assert.equal(stored.body.kind, 'stored');
    assert.equal(stored.ring.label, `Grade ${rows[0].grade}, ${rows[0].score} out of 100, from the last audit`);
    assert.equal(stored.ringId, null, 'a kept grade is not a reading the ring grows for');
    assert.match(stored.verdict, /^Last audited /);
    assert.match(stored.body.note, /at 1111111\. Audit again for the full report/);
    assert.equal(stored.run.label, 'Audit again');
    const running = screen.summary({ ...blank(), history, status: 'running', progress: { stage: 'reading', done: 3, total: 7 } }, NOW);
    assert.equal(running.body.kind, 'progress', 'a running audit shows its progress, not the kept grade');
    assert.equal(running.ring.label, 'Auditing');
    assert.equal(running.stored, false);
    assert.equal(running.run.disabled, true);
    const done = screen.summary({ ...blank(), status: 'done', result: risky, diff: { previousAt: rows[1].auditedAt, newIds: new Set([risky.findings[0].id]), resolved: 2 } }, NOW);
    assert.equal(done.body.kind, 'result');
    assert.equal(done.ringId, risky.findings.length ? done.ringId : null);
    assert.match(done.body.diff, /^1 new finding, 2 resolved since the audit of /);
    assert.deepEqual(done.exports.kinds, null, 'a bill of materials offers every format');
    assert.equal(done.prompts, true);
    /* A result that does not say how many files it read says so, rather than "undefined of undefined". */
    const counted = screen.summary({ ...blank(), status: 'done', result: { ...code, coverage: {} } }, NOW);
    assert.equal(counted.evidence.items[0].value, 'Not recorded');
    assert.match(counted.evidence.label, /was not recorded/);
    const failed = screen.summary({ ...blank(), status: 'error', error: '' }, NOW);
    assert.equal(failed.error, 'The audit could not be completed.');
  }

  /* ---- A running audit and a running site check ---------------------------------------- */
  {
    const said = stage => screen.auditProgress(stage);
    assert.equal(said(null).line, 'Resolving the branch to a commit');
    assert.equal(said({ stage: 'reading', done: 0, total: 0 }).line, 'Listing the files to read');
    const reading = said({ stage: 'reading', done: 9, total: 7 });
    assert.deepEqual(reading.value, { max: 7, now: 7, said: '7 of 7 files read' }, 'a count past its total is held at the total');
    assert.deepEqual(reading.announce, { key: 'Read:reading', said: 'Reading files' }, 'the running count is not announced');
    assert.equal(said({ stage: 'rules', done: 2, total: 40 }).value.said, '2 of 40 more files read for the rules');
    assert.equal(said({ stage: 'queued', position: 3 }).line, 'Waiting for 3 audits ahead of this one');
    assert.equal(said({ stage: 'queued', position: 1 }).line, 'Waiting for another audit to finish');
    assert.match(said({ stage: 'patterns', limit: 'memory' }).line, /more memory than this server gives/);
    assert.equal(said({ stage: 'analysing' }).busy, true);
    assert.deepEqual(said({ stage: 'analysing' }).steps.map(step => step.state), ['done', 'done', 'done', 'active']);
    const fractions = ['page', 'transport', 'paths', 'pages', 'scripts', 'libraries', 'email'].map(stage => sites.siteProgress({ stage, done: 1, total: 2 }).fraction);
    assert.deepEqual([...fractions].sort((a, b) => a - b), fractions, 'the site bar never runs backwards');
    assert.equal(sites.siteProgress({ stage: 'scripts', done: 2, total: 5 }).line, 'Reading the site’s JavaScript for secrets and libraries · 2 of 5');
    assert.equal(sites.siteProgress({ stage: 'scripts', done: 2, total: 5 }).announce.key, 'crawl');
    assert.equal(sites.siteProgress({ stage: 'paths', done: 1, total: 4 }).fraction, (1 + 1 / 4) / 4, 'the bar moves within a step by its count');
    assert.equal(sites.siteProgress({ stage: 'paths' }).fraction, (1 + 0.5) / 4, 'a step without a count stands half done');
    assert.deepEqual(sites.siteProgress({ stage: 'libraries' }).value, { max: 100, now: 88, said: 'Asking OSV about the libraries found' });
  }

  /* ---- Cards ----------------------------------------------------------------------------- */
  {
    const result = { ...blank(), status: 'done', result: risky, history, triage: { status: 'ready', canDecide: true, decisions: [] } };
    const ranked = cards.risk(result);
    assert(ranked.rows.length > 0);
    assert.equal(cards.risk(result).rows.map(row => row.places).join(), ranked.rows.map(row => row.places).join(), 'a ranking twice says the same places');
    /* A band the screen does not know is neither counted nor allowed to stop it. */
    const odd = { ...risky, findings: risky.findings.map(finding => (finding.detail && finding.detail.risk ? { ...finding, detail: { ...finding.detail, risk: { ...finding.detail.risk, band: 'constructor' } } } : finding)) };
    const unknown = cards.risk({ ...result, result: odd });
    assert.deepEqual(unknown.bands.map(band => band.band), ['urgent', 'high', 'moderate', 'low']);
    assert.equal(unknown.bands.reduce((sum, band) => sum + band.count, 0), 0, 'a band it does not know is counted in none');
    assert(unknown.rows.every(row => row.bandWord === 'constructor'), 'and is said as sent');
    assert.equal(cards.risk({ ...result, filter: 'code' }), null, 'a family filter hides the dependency risk');
    assert.deepEqual(cards.priorities({ ...result, severity: 'critical' }), [], 'a severity filter hides fix first');
    const watching = cards.watch({ ...result, watch: { status: 'checking' } }, NOW, { run: true });
    assert.equal(watching.state.state, 'checking');
    assert.equal(watching.check.disabled, true);
    assert.equal(cards.watch({ ...result, watch: { status: 'error' } }, NOW, { run: true }).state.said, 'The watch could not be checked. Nothing is marked new, and nothing is marked clear.');
    assert.equal(cards.watch({ ...blank(), watch: { status: 'ready', data: {} } }, NOW, { run: true }), null, 'no audit, no watch');
    const alerting = { ...result, status: 'idle', result: null, watch: { status: 'ready', data: { audit: { ...rows[0], watch: { checkedAt: new Date(NOW - 60000).toISOString(), state: 'ok', kev: 'ok' } },
      alerts: [{ kind: 'advisory', name: 'express', version: '4.17.1', id: 'GHSA-rv95-896h-c2vc', cve: 'CVE-2024-29041', severity: 'warning', fixed: '4.19.2' }], components: 4,
      checkableAt: new Date(NOW + 9 * 60000).toISOString() } } };
    const held = cards.watch(alerting, NOW, { run: true });
    assert.equal(held.check.disabled, true, 'asked moments ago: not asked again yet');
    assert.match(held.check.title, /it can be asked again in 9 minutes/);
    assert.equal(held.again, true, 'new items offer an audit that ranks them');
    assert.equal(cards.watch(alerting, NOW, { run: false }).again, false, 'not without a way to run one');
    assert.equal(cards.watch({ ...alerting, status: 'running' }, NOW, { run: true }).again, false, 'not while one runs');
    assert.equal(cards.watch({ ...alerting, watch: { ...alerting.watch, data: { ...alerting.watch.data, checkableAt: new Date(NOW - 1000).toISOString() } } }, NOW, { run: true }).check.disabled, false);
  }

  /* ---- The findings list --------------------------------------------------------------- */
  {
    const base = { ...blank(), status: 'done', result: code };
    const listed = listing.findings(base, NOW, { open: true, triage: false, history: false, reopen: false });
    assert.equal(listed.rows.length, code.findings.length);
    assert.equal(listed.waived.length, code.suppressed.length);
    const nothing = listing.findings({ ...base, query: 'zzzz-not-a-word' }, NOW, { open: true, triage: false, history: false, reopen: false });
    assert.equal(nothing.empty, 'Nothing matches “zzzz-not-a-word”.');
    const paged = listing.findings({ ...base, result: { ...code, findings: Array.from({ length: 95 }, (_, index) => ({ ...code.findings[0], id: `f${index}` })) } }, NOW, { open: false, triage: false, history: false, reopen: false });
    assert.equal(paged.rows.length, 40);
    assert.deepEqual(paged.more, { limit: 40, next: 80, said: 'Show 40 more', of: '40 of 95' });
    /* A severity the screen does not know is listed as found, and searched without stopping the list. */
    const strange = { ...base, query: 'odd', result: { ...code, findings: [{ ...code.findings[0], id: 'odd', severity: 'odd' }, ...code.findings] } };
    const strangeList = listing.findings(strange, NOW, { open: false, triage: false, history: false, reopen: false });
    assert.deepEqual(strangeList.rows.map(row => row.id), ['odd']);
    assert.equal(strangeList.rows[0].pill, null);
    /* A place opens its file, and a finding is triaged, only where the page offers it. */
    const decided = { ...base, triage: { status: 'ready', canDecide: true, decisions: [] } };
    assert(listing.findings(decided, NOW, { open: false, triage: false, history: false, reopen: false }).rows.every(row => !row.openable && !row.triage));
    const offeredRows = listing.findings(decided, NOW, { open: true, triage: true, history: false, reopen: false }).rows;
    assert(offeredRows.some(row => row.openable) && offeredRows.every(row => row.triage && row.triage.label === 'Triage'));
    assert(listing.findings({ ...decided, triage: { ...decided.triage, canDecide: false } }, NOW, { open: true, triage: true, history: false, reopen: false }).rows.every(row => !row.triage), 'a reader who may not decide is offered no decision');
    /* Three findings need no search; a search typed stays while it narrows. */
    const few = { ...base, result: { ...code, findings: code.findings.slice(0, 3) } };
    assert.equal(listing.findings(few, NOW, { open: false, triage: false, history: false, reopen: false }).search, null);
    assert.deepEqual(listing.findings({ ...few, query: 'q' }, NOW, { open: false, triage: false, history: false, reopen: false }).search, { query: 'q' });
  }

  /* ---- The kept history ------------------------------------------------------------------ */
  {
    const drawn = kept.history({ ...blank(), history }, NOW);
    assert.equal(drawn.rows.length, 3);
    assert.equal(drawn.trend.points.length, 3);
    assert.match(drawn.others, /next/);
    const odd = kept.history({ ...blank(), history: { ...history, audits: [{ ...rows[0], auditedAt: 'not a time' }, ...rows.slice(1)] } }, NOW);
    clean(JSON.stringify(odd), 'a kept audit with no time');
  }

  /* ---- The deployed site -------------------------------------------------------------------- */
  {
    const reading = sites.siteReading({ result: site, diff: { previousAt: 'garbage', newIds: new Set([site.findings[0].id]), resolved: 1 } }, NOW);
    assert.equal(reading.diff, '1 new finding, 1 resolved.', 'a comparison with no time says no time');
    assert.equal(reading.rows.length, site.findings.length);
    assert.equal(reading.rows.every(row => !row.openable && !row.triage), true, 'a site finding is shown, never opened or triaged');
    const placed = sites.siteReading({ result: { ...site, findings: site.findings.map(finding => ({ ...finding, path: '/.env', line: 1 })) } }, NOW);
    assert.equal(placed.rows.some(row => row.openable), false, 'not even one that names a path');
    const partial = sites.siteReading({ result: { ...site, coverage: { state: 'partial', complete: false, reasons: ['scripts: One script could not be read.'] } }, diff: { previousAt: site.checkedAt, newIds: new Set(), resolved: 3 } }, NOW);
    assert.equal(partial.ring.grade, 'none', 'an incomplete check keeps no grade');
    assert.match(partial.diff, /Resolution cannot be established from this incomplete check\.$/);
    assert.equal(sites.siteReading({ result: site, diff: { previousAt: null, newIds: new Set(), resolved: null } }, NOW).diff, '0 new findings.');
    const link = sites.siteLink({ link: true, url: 'https://demo.example.com/', result: site, status: 'running' }, NOW);
    assert.equal(link.reading, null);
    assert.equal(link.held, true, 'a check held while another runs keeps the way to it');
    assert.equal(link.host, 'demo.example.com');
    const card = sites.site({ standalone: true, url: 'x', status: 'running', progress: { stage: 'paths', done: 1, total: 4 } }, { export: true }, NOW);
    assert.equal(card.submit, 'Checking…');
    assert.equal(card.progress.line, 'Asking for files that should never be served · 1 of 4');
    /* Within the audit, a site with the repository's own result rides in the audit's exports, not its own. */
    assert.equal(sites.site({ result: site, status: 'done', hasRepositoryResult: true }, { export: true }, NOW).exportable, false);
    assert.equal(sites.site({ result: site, status: 'done', hasRepositoryResult: false }, { export: true }, NOW).exportable, true);
    assert.equal(sites.site({ result: site, status: 'done' }, { export: false }, NOW).exportable, false);
  }

  /* ---- The screen, drawn ------------------------------------------------------------------------ */
  {
    const full = markup({ ...blank(), status: 'done', result: risky, history, triage: { status: 'ready', canDecide: true, decisions: [] },
      watch: { status: 'ready', data: { audit: rows[0], alerts: [], components: 4 } }, site: { link: true, url: 'https://demo.example.com', suggested: true, result: site, status: 'done' } }, all);
    clean(full, 'a full screen');
    wired(full, 'a full screen');
    const headings = [...full.matchAll(/<h2 class="[^"]*" id="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(headings, ['auditSummaryHeading', 'auditWatchHeading', 'auditFirstHeading', 'auditRiskHeading', 'auditFamiliesHeading', 'auditLicencesHeading',
      'auditLedgerHeading', 'auditControlsHeading', 'auditOwaspHeading', 'auditFindingsHeading', 'auditHistoryHeading', 'auditSiteHeading'].filter(id => headings.includes(id)));
    assert(full.includes('aria-label="Grade '));
    assert(full.includes('data-fold="site"'));
    /* Without a way to open files or triage, the screen offers neither. */
    const bare = markup({ ...blank(), status: 'done', result: code, history }, {});
    assert(!bare.includes('audit-triage-btn') && !bare.includes('class="audit-location"'));
    assert(!bare.includes('data-key="export"'), 'no export without a way to export');
    const unavailable = markup({ ...blank(), unavailable: 'Repository audit needs a GitHub account.', site: { link: true, url: '', result: null, status: 'idle' } }, all);
    assert(unavailable.includes('Repository audit is unavailable.') && unavailable.includes('Repository audit needs a GitHub account.'));
    assert(unavailable.includes('The repository declares no homepage; add the address on the Website page.'));
    const standalone = siteMarkup({ status: 'done', url: site.origin, result: site, diff: null, from: 'sandbox/demo' }, all);
    clean(standalone, 'the site page');
    wired(standalone, 'the site page');
    assert(standalone.includes('<label class="audit-site-label" for="standaloneSiteUrl">Site address</label>'));
    assert(standalone.includes('For sandbox/demo') && standalone.includes('data-key="site-back"'));
    assert.equal([...standalone.matchAll(/class="exposure-item audit-item"/g)].length, Math.min(5, site.findings.length), 'past five, the site findings fold');
    /* While a check runs on the Website page, the audit's card keeps the way to the last one and holds the rest. */
    const checking = markup({ ...blank(), site: { link: true, url: site.origin, result: site, status: 'running' } }, all);
    assert.match(checking, /<button type="button" class="btn btn-primary" data-key="site-open">Open in Parallax<\/button>/);
    assert.match(checking, /<button type="button" class="btn btn-ghost" data-key="site-again" disabled="">Check again<\/button>/);
    assert(checking.includes('Checking on the Website page…'));
  }

  /* ---- Shapes no server sends -------------------------------------------------------------- */
  {
    const shapes = [null, 0, '', 'text', [], {}, { findings: 'x' }, { findings: [null, 1, 'x', {}] }, { findings: [{ severity: 'odd', detail: { risk: { band: 'odd' }, intel: { exploited: true } } }] }];
    for (const shape of shapes) {
      for (const status of ['idle', 'running', 'done', 'error']) {
        const html = markup({ ...blank(), status, result: shape, progress: shape, history: { status: 'ready', audits: Array.isArray(shape) ? shape : [shape] }, watch: { status: 'ready', data: shape }, metrics: { status: 'ready', data: shape }, site: shape && typeof shape === 'object' ? { link: true, ...shape } : null }, all);
        clean(html.replace(/>[^<]*text[^<]*</g, '><'), `${JSON.stringify(shape)} ${status}`);
      }
      siteMarkup({ status: 'done', result: shape }, all);
    }
  }

  console.log('code audit screen tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
