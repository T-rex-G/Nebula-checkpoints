'use strict';

/*
 * A reading that lands late keeps the reader's place on the Overview.
 *
 * The Overview does not let the browser anchor scrolling, so each card that
 * is drawn keeps the place itself (components/held-repaint.ts): a card that
 * begins above the reader's view moves the view by however much it grew, and
 * one that begins in view fills in where it stands. Each is read here as it
 * happens to a reader: the reading held at the server, the reader scrolled
 * to the activity feed below its card, and the reading let go. The phone is
 * given a shorter screen so the feed can be brought to its top while the
 * pull-request board, below it, is still short.
 */
const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/* The two readings whose cards change height when they land, and how a reader sees that they have. */
const LATE = [
  {
    name: 'the security posture',
    path: '/api/workspace/security-posture',
    cards: ['#wpPosture'],
    landed: page => expect(page.locator('#wpPosture')).not.toContainText('Reading the audits and scans', { timeout: 10000 })
  },
  {
    name: 'the repository list',
    path: '/api/repos',
    cards: ['#wpTrust', '#wpActivity'],
    landed: page => expect(page.locator('#wpTrust')).toContainText('From 6 of 6 signals measured', { timeout: 10000 })
  }
];

/*
 * Whether the reader can see none of these cards: each ends above the top of
 * what is on screen -- the Overview's own scrolling region where it has one,
 * or the screen under the bar fixed across its top.
 */
function outOfView(selectors) {
  const first = document.querySelector(selectors[0]);
  let viewTop = 0;
  for (let node = first && first.parentElement; node; node = node.parentElement) {
    if (/^(?:auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) { viewTop = node.getBoundingClientRect().top; break; }
  }
  const bar = first && first.closest('.page') && first.closest('.page').querySelector('.topbar');
  if (!viewTop && bar && getComputedStyle(bar).position === 'fixed') viewTop = bar.getBoundingClientRect().bottom;
  return selectors.every(selector => document.querySelector(selector).getBoundingClientRect().bottom <= viewTop + 0.5);
}

/* Opens the Overview with one reading held at the server; answers how to let it go. */
async function openHolding(page, path) {
  if (page.viewportSize().height > 520) await page.setViewportSize({ width: page.viewportSize().width, height: 520 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route(url => new URL(url).pathname === path, async route => { await gate; await route.fallback(); });
  await page.goto('/#/overview');
  await expect(page.locator('#wpFeed')).toBeVisible();
  /* Every other reading has landed, so the one let go is the only thing that can move. */
  for (const other of LATE) if (other.path !== path) await other.landed(page);
  /* And the screen has arrived: while its transition runs, the page is a picture of itself that takes no press. */
  await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
  return release;
}

const top = locator => locator.evaluate(node => node.getBoundingClientRect().top);
/*
 * The Overview's cards arrive with a scroll-driven animation that moves them
 * a little while they enter the screen, and its frame follows a scroll one
 * frame later: a position read in the frame of the scroll is where the card
 * was drawn before it.
 */
const settle = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

for (const late of LATE) {
  test(`${late.name}, landing above a reader who has scrolled past it, moves nothing they are reading`, async ({ page }) => {
    const release = await openHolding(page, late.path);
    const feed = page.locator('#wpFeed');
    /* The reader has gone down to the activity: the card that is still reading is above their view. */
    await feed.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await expect.poll(() => page.evaluate(outOfView, late.cards), 'the card still reading is out of the reader\'s view').toBe(true);
    await settle(page);
    const before = await top(feed);
    release();
    await late.landed(page);
    expect(Math.abs(await top(feed) - before), 'the feed stays under the reader').toBeLessThanOrEqual(1);
  });
}

test('a card the reader can see fills in where it stands', async ({ page }) => {
  const release = await openHolding(page, '/api/workspace/security-posture');
  const card = page.locator('#wpPosture');
  await card.evaluate(node => node.scrollIntoView({ block: 'center' }));
  await settle(page);
  const before = await card.evaluate(node => ({ top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height }));
  release();
  await LATE[0].landed(page);
  const after = await card.evaluate(node => ({ top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height }));
  expect(Math.abs(after.top - before.top), 'the card the reader is looking at does not move').toBeLessThanOrEqual(1);
  expect(after.height, 'it grows under the reader\'s eyes, where they can see it').toBeGreaterThan(before.height + 100);
});

/*
 * On a phone the page itself scrolls, under a bar fixed across the top of the
 * screen: a card that begins under the bar has begun above what the reader
 * can see, and keeps their place like one scrolled past.
 */
test('a card that begins under the bar across the top keeps the reader\'s place', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'the desktop Overview scrolls its own region, below its bar');
  const release = await openHolding(page, '/api/workspace/security-posture');
  const card = page.locator('#wpPosture');
  await card.evaluate(node => {
    const bar = node.closest('.page').querySelector('.topbar').getBoundingClientRect().bottom;
    window.scrollBy(0, node.getBoundingClientRect().top - (bar - 20));
  });
  await settle(page);
  const under = await card.evaluate(node => node.getBoundingClientRect().top < node.closest('.page').querySelector('.topbar').getBoundingClientRect().bottom && node.getBoundingClientRect().top > 0);
  expect(under, 'the card begins under the bar, on the screen').toBe(true);
  const feed = page.locator('#wpFeed');
  const before = await top(feed);
  release();
  await LATE[0].landed(page);
  expect(Math.abs(await top(feed) - before), 'the feed stays under the reader').toBeLessThanOrEqual(1);
});

/*
 * A card is not drawn while the reader is pressing on its screen; it waits
 * for the press to be delivered (components/held-repaint.ts). Drawn after it,
 * it keeps the reader's place just the same.
 */
test('a card held for a press keeps the reader\'s place when it is drawn after the press', async ({ page }) => {
  const release = await openHolding(page, '/api/workspace/security-posture');
  const feed = page.locator('#wpFeed');
  await feed.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await expect.poll(() => page.evaluate(outOfView, LATE[0].cards)).toBe(true);
  await settle(page);
  const before = await top(feed);
  const box = await feed.locator('.wp-area-head-row').boundingBox();
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  release();
  /* The reading has arrived and waits on the press: the card is still the line that says it is reading. */
  await page.waitForResponse(response => new URL(response.url()).pathname === LATE[0].path);
  await expect(page.locator('#wpPosture')).toContainText('Reading the audits and scans');
  await page.mouse.up();
  await LATE[0].landed(page);
  expect(Math.abs(await top(feed) - before), 'the feed stays under the reader').toBeLessThanOrEqual(1);
});
