'use strict';

/*
 * A rendered website audit's run, without a page
 * (apps/web/src/features/parallax/rendered-audit.ts): started only when the
 * browser is available, polled until it finishes, retried only for an edge
 * hiccup, given up at its deadline, cancelled by its run, and reported as the
 * server measured it -- with every value the audited page supplied kept as
 * text in the exported report.
 */

const assert = require('node:assert/strict');
const audits = require('../apps/web/src/features/parallax/rendered-audit.ts');

const cases = [];
const check = (name, run) => cases.push([name, run]);

/* A server that answers each request from a script, recording what it was asked. */
function server(script) {
  const asked = [];
  const api = async (path, options = {}) => {
    asked.push(`${options.method || 'GET'} ${path}${options.body ? ` ${JSON.stringify(options.body)}` : ''}`);
    const step = script.shift();
    if (!step) throw Object.assign(new Error('unscripted request'), { status: 500 });
    if (step.fail) throw Object.assign(new Error(step.fail), { status: step.status, code: step.code });
    return typeof step.answer === 'function' ? step.answer() : step.answer;
  };
  return { api, asked };
}

const REPORT = {
  run: 'r1',
  state: 'finished',
  url: 'https://example.com/page',
  checkedAt: '2026-11-11T09:00:00.000Z',
  coverage: { complete: true, state: 'complete', reasons: ['Two viewports were rendered.'] },
  limitations: ['Keyboard behaviour needs a person.'],
  viewports: [
    { name: 'Desktop', width: 1440, height: 900, finalUrl: 'https://example.com/page', screenshot: { mimeType: 'image/jpeg', data: 'QUJD' }, facts: { overflowPx: 0, metrics: { lcpMs: 812, cls: 0.02 } } },
    { name: 'Mobile', width: 390, height: 844, finalUrl: '', screenshot: { mimeType: 'image/png', data: 'QUJD' }, facts: { overflowPx: 14, metrics: {} } }
  ],
  findings: [{ severity: 'serious', viewport: 'Mobile', title: 'Horizontal overflow', detail: 'The page scrolls sideways.', targets: [['main', '.hero']] }]
};

const ready = { answer: { available: true } };
const noWait = async () => {};

check('the browser\'s availability decides whether a run can start, and what the panel says', async () => {
  for (const [answer, available, status] of [
    [{ available: true }, true, 'Ready.'],
    [{ available: true, message: 'One browser is free.' }, true, 'One browser is free.'],
    [{ available: false }, false, 'Rendered audits are unavailable.'],
    [{ available: 'yes' }, false, 'Rendered audits are unavailable.']
  ]) {
    const { api, asked } = server([{ answer }]);
    const audit = audits.createAudit({ api, wait: noWait });
    assert.equal(audit.state().status, 'Checking browser availability…');
    await audit.readiness();
    assert.deepEqual([audit.state().available, audit.state().status], [available, status]);
    assert.deepEqual(asked, ['GET /api/site-rendered/status']);
  }
  const { api } = server([{ fail: 'down' }]);
  const audit = audits.createAudit({ api, wait: noWait });
  await audit.readiness();
  assert.deepEqual([audit.state().available, audit.state().status], [false, 'Browser availability could not be checked. Try again.']);
  await audit.start('https://example.com');
  assert.equal(audit.state().busy, false, 'nothing starts while the browser is unavailable');
});

check('a run is started, polled while it runs, and reported when it finishes', async () => {
  const seen = [];
  const { api, asked } = server([ready, { answer: { run: 'r1', state: 'running', stage: 'mobile-viewport' } }, { answer: { run: 'r1', state: 'running', stage: 'metrics' } }, { answer: REPORT }]);
  const audit = audits.createAudit({ api, wait: noWait });
  audit.subscribe(() => seen.push(audit.state().status));
  await audit.readiness();
  const running = audit.start('  https://example.com/page  ');
  assert.equal(audit.state().busy, true);
  await running;
  assert.deepEqual(asked, [
    'GET /api/site-rendered/status',
    'POST /api/site-rendered {"url":"https://example.com/page"}',
    'GET /api/site-rendered?run=r1',
    'GET /api/site-rendered?run=r1'
  ]);
  assert.deepEqual(seen.slice(1), ['Starting isolated browser…', 'Checking mobile viewport…', 'Checking metrics…',
    'Automated checks finished · 1 observations. Review coverage and evidence below.', 'Automated checks finished · 1 observations. Review coverage and evidence below.']);
  const state = audit.state();
  assert.equal(state.busy, false);
  assert.equal(state.report, REPORT, 'the exports carry the report as the server sent it');
  assert.deepEqual(state.view, {
    url: 'https://example.com/page',
    filename: 'website-rendered-2026-11-11',
    scope: ['Two viewports were rendered.', 'Keyboard behaviour needs a person.'],
    viewports: [
      { name: 'Desktop', width: '1440', height: '900', finalUrl: 'https://example.com/page', image: 'data:image/jpeg;base64,QUJD',
        metrics: [['LCP (lab)', '812 ms'], ['CLS (sample)', '0.02'], ['Horizontal overflow', '0 px']] },
      { name: 'Mobile', width: '390', height: '844', finalUrl: '', image: '',
        metrics: [['LCP (lab)', 'Unavailable'], ['CLS (sample)', 'Unavailable'], ['Horizontal overflow', '14 px']] }
    ],
    findings: [{ heading: 'serious · Mobile · Horizontal overflow', detail: 'The page scrolls sideways.', targets: 'main → .hero' }]
  });
  assert.ok(Object.isFrozen(state), 'what the panel shows is changed only by the run');
});

check('a partial report says so', async () => {
  const { api } = server([ready, { answer: { ...REPORT, coverage: { ...REPORT.coverage, complete: false }, findings: [] } }]);
  const audit = audits.createAudit({ api, wait: noWait });
  await audit.readiness();
  await audit.start('https://example.com');
  assert.equal(audit.state().status, 'Partial report · 0 observations. Review coverage and evidence below.');
});

check('an incomplete report is refused, and its run released', async () => {
  const { api, asked } = server([ready, { answer: { run: 'r9', state: 'finished', viewports: [] } }, { answer: {} }]);
  const audit = audits.createAudit({ api, wait: noWait });
  await audit.readiness();
  await audit.start('https://example.com');
  assert.equal(audit.state().status, 'The audit returned an incomplete report. Try again.');
  assert.equal(asked.at(-1), 'DELETE /api/site-rendered?run=r9');
  assert.equal(audit.state().busy, false);
  assert.equal(audit.state().view, null);
});

check('a poll that hits an edge hiccup is tried again, up to three times; a coded answer is final', async () => {
  const hiccups = [{ fail: 'Bad gateway', status: 502 }, { fail: 'offline' }, { fail: 'Busy', status: 429 }];
  const { api, asked } = server([ready, { answer: { run: 'r2', state: 'running' } }, ...hiccups, { answer: REPORT }]);
  const audit = audits.createAudit({ api, wait: noWait });
  await audit.readiness();
  await audit.start('https://example.com');
  assert.equal(asked.filter(line => line === 'GET /api/site-rendered?run=r2').length, 4);
  assert.match(audit.state().status, /^Automated checks finished/);

  const four = server([ready, { answer: { run: 'r3', state: 'running' } }, ...[1, 2, 3, 4].map(() => ({ fail: 'Gateway timeout', status: 504 })), { answer: {} }]);
  const tired = audits.createAudit({ api: four.api, wait: noWait });
  await tired.readiness();
  await tired.start('https://example.com');
  assert.equal(tired.state().status, 'Gateway timeout', 'a fourth hiccup in a row ends the run');
  assert.equal(four.asked.at(-1), 'DELETE /api/site-rendered?run=r3');

  const coded = server([ready, { answer: { run: 'r4', state: 'running' } }, { fail: 'The page refused the browser.', status: 422, code: 'SITE_REFUSED' }, { answer: {} }]);
  const told = audits.createAudit({ api: coded.api, wait: noWait });
  await told.readiness();
  await told.start('https://example.com');
  assert.equal(told.state().status, 'The page refused the browser.', 'the run\'s own outcome is told once');
  assert.equal(coded.asked.filter(line => line === 'GET /api/site-rendered?run=r4').length, 1);
  for (const [error, failures, again] of [[{ status: 503 }, 1, true], [{}, 3, true], [{}, 4, false], [{ status: 500 }, 1, false], [{ status: 503, code: 'X' }, 1, false]]) {
    assert.equal(audits.pollAgain(error, failures), again, JSON.stringify([error, failures]));
  }
});

check('a run past its deadline is cancelled and said to have taken too long', async () => {
  let clock = 0;
  const running = { answer: () => { clock += 60000; return { run: 'r5', state: 'running' }; } };
  const { api, asked } = server([ready, { answer: { run: 'r5', state: 'running' } }, running, running, { answer: {} }, { answer: {} }]);
  const audit = audits.createAudit({ api, wait: noWait, now: () => clock });
  await audit.readiness();
  await audit.start('https://example.com');
  assert.equal(audit.state().status, 'The audit took too long. Try again.');
  assert.equal(asked.filter(line => line === 'DELETE /api/site-rendered?run=r5').length, 1, 'cancelled once, by its run');
  assert.equal(audit.state().busy, false);
});

check('a cancelled run is released by its run; a cancellation the server did not confirm can be tried again', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { api, asked } = server([ready, { answer: { run: 'r6', state: 'running' } }, { fail: 'Bad gateway', status: 502 }, { answer: {} }]);
  const audit = audits.createAudit({ api, wait: () => held });
  await audit.readiness();
  const running = audit.start('https://example.com');
  await new Promise(resolve => setImmediate(resolve));
  await audit.cancel();
  assert.deepEqual([audit.state().status, audit.state().cancelDisabled], ['Cancellation could not be confirmed. Try cancelling again.', false]);
  assert.equal(audit.state().busy, true, 'still running until the server confirms');
  await audit.cancel();
  assert.deepEqual([audit.state().status, audit.state().busy], ['Audit cancelled.', false]);
  assert.deepEqual(asked.slice(2), ['DELETE /api/site-rendered?run=r6', 'DELETE /api/site-rendered?run=r6']);
  release();
  await running;
  assert.equal(audit.state().status, 'Audit cancelled.', 'the poll that wakes after a cancellation says nothing more');
  const gone = server([ready, { answer: { run: 'r7', state: 'running' } }, { fail: 'Not found', status: 404 }]);
  const finished = audits.createAudit({ api: gone.api, wait: () => new Promise(() => {}) });
  await finished.readiness();
  void finished.start('https://example.com');
  await new Promise(resolve => setImmediate(resolve));
  await finished.cancel();
  assert.equal(finished.state().status, 'Audit cancelled.', 'a run the server no longer has is already stopped');
});

check('a run whose start is answered after the panel was taken away is cancelled by its run alone', async () => {
  let answer;
  const started = new Promise(resolve => { answer = resolve; });
  const { api, asked } = server([ready, { answer: () => started }, { answer: {} }]);
  const audit = audits.createAudit({ api, wait: noWait });
  await audit.readiness();
  const seen = [];
  audit.subscribe(() => seen.push(audit.state().status));
  const running = audit.start('https://example.com');
  audit.dispose();
  answer({ run: 'r8', state: 'running' });
  await running;
  assert.deepEqual(asked.slice(1), ['POST /api/site-rendered {"url":"https://example.com"}', 'DELETE /api/site-rendered?run=r8']);
  assert.deepEqual(seen, ['Starting isolated browser…'], 'nothing is drawn for a panel that is gone');
  assert.equal(audit.state().status, 'Starting isolated browser…', 'and what it shows does not change');
});

check('a panel taken away while its run is polled cancels the run, and polls no more', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { api, asked } = server([ready, { answer: { run: 'r9', state: 'running', stage: 'desktop' } }, { answer: {} }]);
  const audit = audits.createAudit({ api, wait: () => held });
  await audit.readiness();
  const running = audit.start('https://example.com');
  await new Promise(resolve => setImmediate(resolve));
  const shown = audit.state().status;
  assert.equal(shown, 'Checking desktop…');
  audit.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(asked.slice(2), ['DELETE /api/site-rendered?run=r9']);
  release();
  await running;
  assert.equal(asked.length, 3, 'the poll that wakes after it asks nothing');
  assert.equal(audit.state().status, shown, 'what a gone panel shows does not change');
});

check('a second start while a run is going starts nothing', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { api, asked } = server([ready, { answer: { run: 'r10', state: 'running' } }, { answer: REPORT }]);
  const audit = audits.createAudit({ api, wait: () => held });
  await audit.readiness();
  const running = audit.start('https://example.com');
  await audit.start('https://example.org');
  release();
  await running;
  assert.deepEqual(asked.filter(line => line.startsWith('POST')), ['POST /api/site-rendered {"url":"https://example.com"}']);
  assert.equal(audit.state().view.url, 'https://example.com/page');
});

check('the exported report keeps every value the audited page supplied as text, and loads nothing', () => {
  const html = audits.reportHtml({
    ...REPORT,
    url: 'https://example.com/?q=<script>alert(1)</script>',
    viewports: [{ name: '"><img src=x onerror=alert(1)>', width: 1, height: 1, screenshot: { mimeType: 'image/jpeg', data: 'QUJD' }, facts: { title: '</pre><script>alert(2)</script>' } }],
    findings: [{ severity: 'serious', viewport: 'x', title: '<b>bold</b>', detail: "it's & <i>" }]
  });
  assert.ok(!/<script>alert|<img src=x|<b>bold|<i>/.test(html), 'no supplied markup survives as markup');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /it&#39;s &amp; &lt;i&gt;/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">/);
  assert.match(html, /<img alt="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt; viewport capture" src="data:image\/jpeg;base64,QUJD">/);
  assert.match(audits.reportHtml({ ...REPORT, findings: [] }), /No automated issues observed within this sample\./);
  assert.match(audits.reportHtml({ ...REPORT, viewports: [{ name: 'M', screenshot: { mimeType: 'image/jpeg', data: 'not base64!' } }] }), /Screenshot unavailable/);
});

check('only an encoded JPEG of a size a page can hold is shown as a screenshot', () => {
  assert.equal(audits.imageUrl({ mimeType: 'image/jpeg', data: 'QUJD' }), 'data:image/jpeg;base64,QUJD');
  for (const shot of [null, {}, { mimeType: 'image/png', data: 'QUJD' }, { mimeType: 'image/jpeg', data: 'a b' }, { mimeType: 'image/jpeg', data: 'A'.repeat(2200000) }, { mimeType: 'image/jpeg', data: 42 }]) {
    assert.equal(audits.imageUrl(shot), '', JSON.stringify(shot)?.slice(0, 60));
  }
});

(async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}\n${error.stack}`);
    }
  }
  if (failed) {
    console.error(`${failed} of ${cases.length} rendered audit checks failed`);
    process.exit(1);
  }
  console.log(`rendered audit panel: ${cases.length} checks passed`);
})();
