'use strict';

/*
 * An audit is a run the page follows, not a request it waits on. The first
 * request starts it and answers with a stage; the page shows the step it is
 * on and how many files are read, updating the card in place rather than
 * redrawing it; a poll lost to the hosting edge is asked again without
 * troubling the reader; a run the server no longer holds is started once
 * more; and an edge failure the page cannot ride out is told in words, in a
 * row of its own on a phone.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

const AUDIT = /\/api\/repo\/sandbox\/demo\/code-audit(\?|$)/;

async function openAudit(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await expect(pane).toBeVisible();
  return pane;
}

test('a running audit shows its step and count, rides out an edge failure, and lands on the result', async ({ page }) => {
  const pane = await openAudit(page);
  const calls = [];
  await page.route(AUDIT, async route => {
    const url = new URL(route.request().url());
    const run = url.searchParams.get('run');
    calls.push(run ? 'poll' : 'start');
    const polls = calls.filter(call => call === 'poll').length;
    /* The start and the last poll go to the fixture, which runs the real engine. */
    if (!run || polls >= 3) return route.fallback();
    if (polls === 1) {
      return route.fulfill({ status: 202, json: { state: 'running', run, stage: 'analysing', done: 7, total: 7, position: null, limit: null, elapsedMs: 1400 } });
    }
    /* The edge answers for a server it could not reach: HTML, not the server's JSON. */
    return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad gateway</body></html>' });
  });

  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  const progress = pane.locator('.audit-summary .audit-progress');
  await expect(progress.locator('.audit-progress-line')).toHaveText('Reading files · 3 of 7');
  await expect(progress.locator('.audit-step[aria-current="step"]')).toHaveText('Read');
  await expect(progress.locator('.audit-step[data-step="resolve"]')).toHaveAttribute('data-state', 'done');
  const bar = progress.getByRole('progressbar', { name: 'Files read' });
  await expect(bar).toHaveAttribute('aria-valuenow', '3');
  await expect(bar).toHaveAttribute('aria-valuetext', '3 of 7 files read');
  await expect(pane.getByRole('button', { name: 'Auditing…' })).toBeDisabled();

  /* The next answer is painted into the same card: the loader is the node it was. */
  const loader = await pane.locator('.audit-summary .uranus-loader').elementHandle();
  await expect(progress.locator('.audit-progress-line')).toHaveText('Mapping endpoints and tracing each value to what uses it');
  await expect(progress.locator('.audit-step[aria-current="step"]')).toHaveText('Trace');
  await expect(bar).toHaveAttribute('aria-valuenow', '7');
  await expect(bar).toHaveAttribute('data-busy', 'true');
  expect(await loader.evaluate(node => node.isConnected)).toBe(true);

  /* The 502 in between is asked again, not shown; the result arrives. */
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade F, \d{1,2} out of 100$/, { timeout: 15000 });
  await expect(pane.locator('.audit-error')).toHaveCount(0);
  await expect(pane.locator('.audit-progress')).toHaveCount(0);
  expect(calls).toEqual(['start', 'poll', 'poll', 'poll']);
});

test('a run the server no longer holds is started once more', async ({ page }) => {
  const pane = await openAudit(page);
  const calls = [];
  await page.route(AUDIT, async route => {
    const run = new URL(route.request().url()).searchParams.get('run');
    calls.push(run ? 'poll' : 'start');
    if (run && calls.filter(call => call === 'poll').length === 1) {
      return route.fulfill({ status: 404, json: { error: 'This audit is no longer held by the server. It may have restarted. Run the audit again.', code: 'AUDIT_RUN_GONE' } });
    }
    return route.fallback();
  });
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade F, \d{1,2} out of 100$/, { timeout: 15000 });
  expect(calls).toEqual(['start', 'poll', 'start', 'poll']);
});

test('an edge failure is told in words, in its own row on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pane = await openAudit(page);
  await page.route(AUDIT, route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad gateway</body></html>' }));
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  const error = pane.locator('.audit-summary .audit-error');
  await expect(error).toHaveText('The server did not answer in time: it may be waking up or restarting. Wait a few seconds, then try again.');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(pane.getByRole('button', { name: 'Audit this branch' })).toBeEnabled();

  /* The error and the list of what the audit checks no longer share a grid cell. */
  const scope = pane.locator('.audit-summary .audit-scope');
  await expect(scope).toBeVisible();
  const [errorBox, scopeBox, verdictBox] = await Promise.all([error.boundingBox(), scope.boundingBox(), pane.locator('.audit-summary .audit-verdict').boundingBox()]);
  expect(errorBox.y).toBeGreaterThanOrEqual(verdictBox.y + verdictBox.height);
  expect(scopeBox.y).toBeGreaterThanOrEqual(errorBox.y + errorBox.height);

  /* The edge limiting the connection is told apart from the server's own refusal. */
  await page.unroute(AUDIT);
  await page.route(AUDIT, route => route.fulfill({ status: 429, contentType: 'text/html', body: 'Too Many Requests' }));
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(error).toHaveText('The hosting edge is limiting requests from this connection. Wait a minute, then try again.');
});
