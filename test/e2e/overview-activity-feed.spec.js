'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const feed = page => page.locator('#wpFeed');
const rows = page => page.locator('#wpFeed .wp-feed-row');

async function overview(page, scenario = {}) {
  await mockPublicAlphaApi(page, { access: 'active', ...scenario });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(feed(page)).toBeVisible();
}

test('the feed lists what happened, newest first, with its evidence', async ({ page }) => {
  await overview(page);
  await expect(rows(page)).toHaveCount(2);

  const first = rows(page).first();
  await expect(first.locator('.wp-feed-title')).toHaveText('Add a bounded signature gate');
  await expect(first.locator('.wp-feed-repo')).toHaveText('sandbox/demo');
  await expect(first.locator('.wp-feed-kind')).toHaveText('Commit');
  /*
   * The evidence line is the point of this surface. A row that says a commit
   * happened and cannot say which one is a claim the reader has no way to go
   * and check, which is the one thing a trust product must not ship.
   */
  await expect(first.locator('.wp-feed-meta')).toContainText('a1b2c3d4e5');
  await expect(first.locator('.wp-feed-meta')).toContainText('Ada Lovelace');

  /* Newest first, across the whole feed rather than within each repository. */
  await expect(rows(page).nth(1).locator('.wp-feed-title')).toHaveText('Tighten the upload timeout');
});

test('a relative time carries the exact moment it stands for', async ({ page }) => {
  await overview(page);
  const when = rows(page).first().locator('.wp-feed-when');
  await expect(when).toHaveText(/ago|just now/);
  /*
   * "1h ago" means nothing to anything that is not a person reading it at this
   * moment -- not to a screen reader announcing it later, not to a reader who
   * left the tab open overnight. The machine-readable stamp is what makes the
   * words recoverable.
   */
  const stamp = await when.getAttribute('datetime');
  expect(stamp, 'the row shows a relative time with no absolute time behind it').toBeTruthy();
  expect(Number.isFinite(Date.parse(stamp))).toBe(true);
});

test('a repository that could not be read is named, not counted as quiet', async ({ page }) => {
  await overview(page, { activityState: 'partial' });
  await expect(rows(page)).toHaveCount(1);
  /*
   * The failure a card like this normally swallows. Showing the one repository
   * that answered and saying nothing about the one that did not tells the
   * reader the workspace was quiet when it was in fact unreadable -- and a
   * reader who sees "rate limit exceeded" knows to wait, where one who sees
   * nothing concludes there was no work.
   */
  await expect(feed(page)).toContainText('sandbox/other');
  await expect(feed(page)).toContainText('not found');
});

test('a feed nothing could be read from does not claim the workspace was quiet', async ({ page }) => {
  await overview(page, { activityState: 'unreadable' });
  await expect(rows(page)).toHaveCount(0);
  await expect(feed(page)).toContainText('not measured');
  await expect(feed(page)).toContainText('rate limit exceeded');
  /* The distinction this whole card turns on. */
  await expect(feed(page)).not.toContainText('No commits in the last');
});

test('a workspace that answered with nothing says so in those words', async ({ page }) => {
  await overview(page, { activityState: 'quiet' });
  await expect(rows(page)).toHaveCount(0);
  await expect(feed(page)).toContainText('No commits in the last 14 days');
  /* A real quiet week is a measurement, not a failure to measure. */
  await expect(feed(page)).not.toContainText('not measured');
  await expect(feed(page)).not.toContainText('could not be read');
});

test('the feed says how far it reached rather than implying it saw everything', async ({ page }) => {
  await overview(page, { activityState: 'partial' });
  /*
   * The feed reads a bounded set of repositories over a bounded window. A
   * reader not told that reads a short list as a quiet workspace instead of as
   * a window that did not reach far enough -- so the scope is stated on the
   * card, next to the rows it qualifies.
   */
  await expect(feed(page)).toContainText('last 14 days');
  await expect(feed(page)).toContainText('1 of 2 repositories');
});

test('the card names itself and does not interrupt the reader when it arrives', async ({ page }) => {
  await overview(page);
  /*
   * The heading is the card's accessible name and lives outside the body the
   * renderer clears, so a repaint cannot leave a region with no name.
   */
  await expect(page.locator('#ovFeedTitle')).toHaveText('Recent activity');
  await expect(feed(page)).toHaveAttribute('aria-labelledby', /ovFeedTitle/);
  /*
   * And it is not a live region. The feed lands once, on its own, and
   * announcing a screenful of commits over whatever a screen-reader user was
   * already reading is an interruption nobody asked for.
   */
  const section = page.locator('.wp-feed-section');
  await expect(section).not.toHaveAttribute('aria-live', /.*/);
  await expect(feed(page)).not.toHaveAttribute('aria-live', /.*/);
});

test('a failed request leaves a drawn card rather than a permanent loading line', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  /*
   * Registered after the fixture so this route wins. A feed that stays on
   * "Reading recent activity…" forever is worse than one that admits it
   * failed: the reader cannot tell a slow network from a broken surface.
   */
  await page.route('**/api/activity/recent*', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Activity is unavailable', code: 'OPERATION_FAILED' })
  }));
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(feed(page)).toContainText('could not be read');
  await expect(feed(page)).not.toContainText('Reading recent activity');
});

test('the feed does not displace the activity chart it sits beneath', async ({ page }) => {
  await overview(page);
  /*
   * Two surfaces answering two questions. The chart says how much -- a trailing
   * count of repositories pushed -- and the feed says what. Replacing one with
   * the other loses a real measurement; this is the guard that catches a later
   * tidy-up deciding they are duplicates.
   */
  await expect(page.locator('#wpActivity')).toBeVisible();
  await expect(page.locator('#wpActivity')).toContainText('REPOSITORY ACTIVITY');
  await expect(feed(page)).toContainText('RECENT ACTIVITY');

  const chart = await page.locator('#wpActivity').boundingBox();
  const list = await feed(page).boundingBox();
  expect(chart, 'the activity chart is gone').toBeTruthy();
  expect(list, 'the feed is gone').toBeTruthy();
  expect(list.y).toBeGreaterThan(chart.y);
});

test('one commit subject per row, however long the message', async ({ page, isMobile }) => {
  await overview(page);
  const title = rows(page).first().locator('.wp-feed-title');
  const box = await title.boundingBox();
  const lineHeight = await title.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
  /*
   * The fixture's subjects are short, so this is about the row not being given
   * a height it cannot use rather than about wrapping. On a phone a subject
   * legitimately takes two lines; past that the feed has become a wall of text
   * and the list stops being scannable.
   */
  expect(box.height).toBeLessThanOrEqual(lineHeight * (isMobile ? 2 : 1) + 4);
});

test('the feed is read once per visit, not once per glance', async ({ page }) => {
  let reads = 0;
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/activity/recent*', async route => { reads += 1; await route.fallback(); });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  expect(reads).toBe(1);

  /*
   * Each repository in the feed is a provider round trip against someone's
   * rate limit. A reader moving between the overview and the repository list
   * must not spend a fresh handful of requests every time they come back.
   */
  /* By id, not by name: "Repositories" is both the rail entry and the
     overview's own action, and a role query matches them both. */
  await page.locator('#ovGoRepos').click();
  await expect(ui.screen(page, 'repos')).toBeVisible();

  /*
   * Back via the rail rather than the topbar brand. #homeBtn is the obvious
   * control and it cannot be clicked: on the repositories screen it computes
   * to zero width, so Playwright waits for a stable, visible target forever.
   * That is a real defect in that button and not this feed's to fix, but a
   * test that drives it would be measuring the bug rather than the feed.
   */
  const rail = page.locator('.nv-rail-item[data-rail="overview"]');
  /* The menu button on the screen that is actually showing: every page
     carries one, and the copies on the hidden pages are unclickable. */
  if (!(await rail.isVisible())) await page.locator('.page.active .nav-menu-btn').click();
  await rail.click();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  expect(reads, 'returning to the overview re-read the feed and spent the requests again').toBe(1);
});

test('a failed read can be retried without reloading the workspace', async ({ page }) => {
  let reads = 0;
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/activity/recent*', route => {
    reads++;
    return reads === 1 ? route.fulfill({ status: 503, json: { error: 'Activity unavailable' } }) : route.fallback();
  });
  await page.goto('/');
  await expect(feed(page)).toContainText('could not be read');
  await page.getByRole('button', { name: 'Refresh recent activity' }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(feed(page)).not.toContainText('could not be read');
  expect(reads).toBe(2);
});

test('a pending read is shared when the reader revisits the overview', async ({ page }) => {
  let reads = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/activity/recent*', async route => {
    reads++;
    await pending;
    await route.fallback();
  });
  await page.goto('/');
  await expect(feed(page)).toContainText('Reading recent activity');
  await expect(page.locator('#wpFeedRefresh')).toBeDisabled();
  await page.locator('#ovGoRepos').click();
  const rail = page.locator('.nv-rail-item[data-rail="overview"]');
  if (!(await rail.isVisible())) await page.locator('.page.active .nav-menu-btn').click();
  await rail.click();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  release();
  await expect(rows(page)).toHaveCount(2);
  expect(reads).toBe(1);
});

test('privacy cleanup clears the feed and rejects a response that arrives afterwards', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/activity/recent*', async route => { await pending; await route.fallback(); });
  await page.goto('/');
  await expect(feed(page)).toContainText('Reading recent activity');
  await page.evaluate(() => window.NebulaPwa.purgePrivateData(true));
  const received = page.waitForResponse(response => response.url().includes('/api/activity/recent'));
  release();
  await received;
  await page.waitForTimeout(100);
  await expect(rows(page)).toHaveCount(0);
  await expect(feed(page).locator('.wp-body')).toBeEmpty();
});

test('signing in again reads a new feed instead of reusing the previous identity', async ({ page }) => {
  let reads = 0;
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/activity/recent*', async route => { reads++; await route.fallback(); });
  await page.goto('/');
  await expect(rows(page)).toHaveCount(2);
  await page.locator('#logoutBtnOv').click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await page.locator('#tokenInput').fill('fixture-second-session');
  await page.locator('#loginBtn').click();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  expect(reads).toBe(2);
});

test('the sample bounds and snapshot time are visible, including an empty inventory', async ({ page }) => {
  await overview(page);
  await expect(feed(page)).toContainText('first inventory page');
  await expect(feed(page)).toContainText('Up to 20 commits per repository');
  await expect(feed(page).locator('.wp-feed-updated')).toHaveAttribute('datetime', /T/);
  await page.route('**/api/activity/recent*', route => route.fulfill({ json: {
    days: 14, inventoryCount: 0, measured: false, events: [], repositories: [], failed: []
  } }));
  await page.locator('#wpFeedRefresh').click();
  await expect(feed(page)).toContainText('No repositories are available to this session yet');
  await expect(feed(page)).not.toContainText('could be read');
});

test('provider text stays text, long evidence fits, and an actor is not deduplicated as a hash', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/activity/recent*', route => route.fulfill({ json: {
    days: 14, inventoryCount: 1, measured: true, repositories: ['sandbox/demo'], failed: [],
    events: [{ kind: 'commit', repo: 'sandbox/' + 'x'.repeat(90), title: '<img src=x onerror=alert(1)>',
      ref: 'abc' + 'd'.repeat(37), detail: 'abcdddd', actor: 'abc', at: Date.now() }]
  } }));
  await page.goto('/');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).locator('.wp-feed-title')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(rows(page).locator('img')).toHaveCount(0);
  await expect(rows(page).locator('.wp-feed-meta')).toContainText(' · abc');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
