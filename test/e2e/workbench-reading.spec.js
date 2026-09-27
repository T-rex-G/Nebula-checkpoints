'use strict';

/*
 * Reading a medium repository, on a desktop and on a phone: every list here
 * is longer than the screen, which is when these went wrong. A run's jobs
 * closed under a tap on a step; a commit's diff closed when its patch was
 * tapped to select a line; a pull request opened above the list, out of
 * sight of the reader who asked for it; its description arrived as raw
 * Markdown; the palette listed files alphabetically rather than by match;
 * the editor's last lines sat under the phone's bottom navigation; and a tab
 * change on a phone kept the last tab's scroll, landing mid-list.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { mockMediumRepo, LONG_FILE, LONG_FILE_LINES } = require('./medium-repo-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });
test.setTimeout(60000);

async function openRepository(page, tab) {
  await page.addInitScript(() => { localStorage.setItem('nv_settings', JSON.stringify({ fontSize: 14, wrap: false, motion: false })); });
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await mockMediumRepo(page);
  await page.goto(`/#/sandbox/demo@main/${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/* The visible top edge under the fixed top bar, and whether a box is on screen below it. */
const onScreen = (page, selector) => page.evaluate(sel => {
  const box = document.querySelector(sel).getBoundingClientRect();
  const bars = [...document.querySelectorAll('.topbar')].filter(bar => bar.offsetParent !== null);
  const top = bars.length ? Math.max(...bars.map(bar => bar.getBoundingClientRect().bottom)) : 0;
  return { belowBar: box.top >= top - 1, startsOnScreen: box.top < innerHeight - 40 };
}, selector);

const noPageOverflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('a workflow run opens into its jobs, the failed job open, and stays open while it is read', async ({ page }) => {
  await openRepository(page, 'actions');
  const runs = page.locator('#actionsList .run-item');
  await expect(runs).toHaveCount(25);
  const run = runs.nth(2);
  const toggle = run.locator('.run-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const jobs = run.locator('.run-job');
  await expect(jobs).toHaveCount(8);
  /* Eight jobs fold to eight lines; the failed one opens on its failed step. */
  await expect(run.locator('.run-job[open]')).toHaveCount(1);
  await expect(run.locator('.run-job[open] .run-job-head')).toContainText('e2e desktop');
  await expect(run.locator('.run-job[open] .run-job-head')).toContainText('1 failed');
  await expect(run.locator('.run-job[open] .step-row[data-state="failure"] .step-name')).toHaveText('Run tests');

  /* A tap on a step, or opening another job, is reading: the run stays open. */
  await run.locator('.run-job[open] .step-row').nth(3).click();
  await run.locator('.run-job').first().locator('summary').click();
  await expect(run.locator('.run-jobs')).toBeVisible();
  await expect(run.locator('.run-job[open]')).toHaveCount(2);
  await expect(run.locator('.detail-actions')).toBeVisible();
  expect(await onScreen(page, '#actionsList .run-item:nth-child(3) .run-jobs')).toEqual({ belowBar: true, startsOnScreen: true });
  expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);

  /* Only the header closes it, and a second open does not fetch again. */
  let fetched = 0;
  page.on('request', request => { if (/\/actions\/\d+\/jobs$/.test(new URL(request.url()).pathname)) fetched += 1; });
  await toggle.click();
  await expect(run.locator('.run-jobs')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(run.locator('.run-jobs')).toBeVisible();
  expect(fetched).toBe(0);
});

test('a commit diff stays open while its patch is read, and the patch scrolls in its own box', async ({ page }) => {
  await openRepository(page, 'commits');
  const commits = page.locator('#commitList .commit-item');
  await expect(commits).toHaveCount(25);
  await commits.nth(1).click();
  const patch = commits.nth(1).locator('.diff-patch').first();
  await expect(patch).toBeVisible();
  await patch.click({ position: { x: 24, y: 24 } });
  await expect(patch).toBeVisible();
  const widths = await patch.evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
  expect(widths.scroll).toBeGreaterThan(widths.client);
  expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);
});

test('a pull request opens under its row, in view, its description rendered and inert', async ({ page }) => {
  await openRepository(page, 'pulls');
  const rows = page.locator('#prList .list-item');
  await expect(rows).toHaveCount(30);
  await rows.nth(20).click();
  const detail = page.locator('#prDetail');
  await expect(detail.locator('.detail-title')).toHaveText('Pull request 70');
  expect(await detail.evaluate(box => box.previousElementSibling && box.previousElementSibling.textContent.includes('Pull request 70'))).toBe(true);
  await expect.poll(() => onScreen(page, '#prDetail')).toEqual({ belowBar: true, startsOnScreen: true });

  const body = detail.locator('#prBody');
  await expect(body.locator('h3')).toHaveCount(30);
  await expect(body.locator('pre code').first()).toBeVisible();
  const code = await body.locator('pre').first().evaluate(pre => ({ scroll: pre.scrollWidth, client: pre.clientWidth }));
  expect(code.scroll).toBeGreaterThan(code.client);
  expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);

  /* Nothing a hostile author wrote runs, frames, restyles or submits. */
  await expect(body.locator('script, iframe, form, style, [onerror], [onclick], [style]')).toHaveCount(0);
  await expect(body.locator('a[href^="javascript:"]')).toHaveCount(0);
  for (const link of await body.locator('a[href]').all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  }
  await expect(page.locator('#prComments .comment-body').first().locator('script, iframe, [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__mdPwned)).toBeUndefined();
});

test('an issue opens under its row with its comments rendered', async ({ page }) => {
  await openRepository(page, 'issues');
  const rows = page.locator('#issueList .list-item');
  await expect(rows).toHaveCount(30);
  await rows.nth(12).click();
  const detail = page.locator('#issueDetail');
  await expect(detail.locator('.detail-title')).toHaveText('Issue 288');
  expect(await detail.evaluate(box => box.previousElementSibling && box.previousElementSibling.textContent.includes('Issue 288'))).toBe(true);
  await expect.poll(() => onScreen(page, '#issueDetail')).toEqual({ belowBar: true, startsOnScreen: true });
  await expect(detail.locator('.comment')).toHaveCount(12);
  await expect(detail.locator('.comment-body strong').first()).toHaveText('bold');
  await expect(detail.locator('script, iframe, form, [onerror], [onclick]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__mdPwned)).toBeUndefined();
});

test('the palette ranks files by how well they match, not by name', async ({ page }) => {
  await openRepository(page, 'editor');
  await (await ui.action(page, 'Command palette')).click();
  const input = page.locator('#paletteInput');
  const first = page.locator('#paletteList .pal-item').first();
  for (const [query, expected] of [['app', 'public/app.js'], ['style', 'public/style.css'], ['branchprot', 'src/branch-protection.js'], ['matrix', 'scripts/test-matrix.js']]) {
    await input.fill(query);
    await expect(first).toContainText(expected);
  }
  /* A broad query lists thirty files rather than fourteen, so a medium repository's match is not cut off. */
  await input.fill('test');
  await expect.poll(() => page.locator('#paletteList .pal-item').count()).toBeGreaterThanOrEqual(30);
});

test('the editor scrolls a long file and its last line clears the navigation', async ({ page }) => {
  await openRepository(page, 'editor');
  await page.evaluate(path => openFile(path), LONG_FILE);
  await expect(page.locator('.CodeMirror')).toBeVisible();
  /*
   * Two ways a reader reaches the end, each repeated on every look: the
   * editor refreshes itself just after a file opens and re-measures its lines
   * when the web font arrives, and a gesture made before either lands short.
   */
  await page.evaluate(() => document.fonts && document.fonts.ready);
  const last = page.locator('.CodeMirror-code > div:last-child');
  /* What a finger on the last line touches is the line, not the bottom navigation or the action button over it. */
  const reachable = () => last.evaluate(line => {
    const box = line.getBoundingClientRect();
    const nav = document.getElementById('bottomNav');
    const floor = nav && nav.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight;
    const hit = document.elementFromPoint(Math.min(innerWidth - 4, box.left + 40), box.top + box.height / 2);
    return box.bottom <= floor && !!hit && line.contains(hit);
  });
  /* Dragged to the end: the room after the last line lifts it clear. */
  await expect.poll(async () => {
    await page.evaluate(() => { const scroller = document.querySelector('.CodeMirror-scroll'); scroller.scrollTop = scroller.scrollHeight; });
    return reachable();
  }).toBe(true);
  await expect(last).toContainText(`line ${LONG_FILE_LINES}`);
  /*
   * The cursor sent to the end the way a search hit or a jump to a line sends
   * it -- focus stays where it was, so nothing scrolls the page for it: it
   * stops above the navigation, not under it.
   */
  await page.evaluate(() => { document.querySelector('.CodeMirror-scroll').scrollTop = 0; window.scrollTo(0, 0); });
  await expect.poll(async () => {
    await page.evaluate(() => { const cm = document.querySelector('.CodeMirror').CodeMirror; cm.setCursor(cm.lineCount() - 1, 0); });
    return page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      const at = cm.cursorCoords(null, 'window');
      /* Above the navigation, not in whatever strip of screen happens to be left beneath it. */
      const nav = document.getElementById('bottomNav');
      const floor = nav && nav.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight;
      const hit = document.elementFromPoint(Math.max(4, at.left + 2), (at.top + at.bottom) / 2);
      return at.bottom <= floor && !!hit && !!hit.closest('.CodeMirror');
    });
  }).toBe(true);
});

test('each tab keeps its own place in a long list', async ({ page }) => {
  await openRepository(page, 'commits');
  await expect(page.locator('#commitList .commit-item')).toHaveCount(25);
  /* Rows rise into place as they come into view, and a moving row stretches the scrollable height until it lands. */
  const settle = () => page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect && animation.effect.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  const scrollDeep = () => page.evaluate(() => {
    document.scrollingElement.scrollTop = 1e6;
    document.querySelector('.tabpane.active').scrollTop = 1e6;
    return document.scrollingElement.scrollTop + document.querySelector('.tabpane.active').scrollTop;
  });
  await scrollDeep();
  await settle();
  const deep = await scrollDeep();
  expect(deep).toBeGreaterThan(400);
  await page.evaluate(() => switchTab('issues'));
  await expect(page.locator('#issueList .list-item')).toHaveCount(30);
  /* The next tab starts at its top, not at the last tab's offset. */
  await expect.poll(() => onScreen(page, '#issueList .list-item')).toEqual({ belowBar: true, startsOnScreen: true });
  await page.evaluate(() => switchTab('commits'));
  const back = await page.evaluate(() => document.scrollingElement.scrollTop + document.querySelector('.tabpane.active').scrollTop);
  expect(Math.abs(back - deep)).toBeLessThanOrEqual(2);
});
