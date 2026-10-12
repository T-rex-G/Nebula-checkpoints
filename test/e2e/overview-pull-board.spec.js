'use strict';

/*
 * The open pull requests across the workspace, on the Overview.
 *
 * What these pin is what a reader relies on: nothing is asked of the provider
 * until the card is in view; the three columns hold what the list route said,
 * in an order that puts the longest wait first; it sits last on the page, so
 * its arrival moves nothing a reader is looking at; a card opens its pull request
 * in its own repository; a repository that could not be read is named rather
 * than drawn as one with nothing open, and the card says how many it read;
 * the lists are read a few at a time and read again on request; the card
 * fits a phone in both presets and both themes; and a deployment that does
 * not offer pull-request reads draws none of it and asks for none of it.
 */

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

function countPulls(page) {
  const seen = [];
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'GET' && /^\/api\/repo\/[^/]+\/[^/]+\/pulls$/.test(pathname)) seen.push(pathname);
  });
  return seen;
}

async function board(page, options = {}) {
  await page.setViewportSize({ width: page.viewportSize().width, height: 700 });
  await mockPublicAlphaApi(page, { access: 'active', ...options });
  await page.goto('/#/overview');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await expect(page.locator('#wpPullsSection')).toBeVisible();
  const card = page.locator('#wpPulls');
  await card.scrollIntoViewIfNeeded();
  return card;
}

test('the board waits until it is in view, then lays the open pull requests in three columns', async ({ page }) => {
  const asked = countPulls(page);
  await page.setViewportSize({ width: page.viewportSize().width, height: 700 });
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/#/overview');
  await expect(page.locator('#wpFeed')).toBeAttached();
  await page.waitForTimeout(400);
  expect(asked, 'nothing is asked of the provider for a card below the fold').toEqual([]);
  const card = page.locator('#wpPulls');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.pb-sentence')).toHaveText('4 open pull requests in 1 repository: 2 waiting on review, the longest for 9 days.');
  expect(asked).toEqual(['/api/repo/sandbox/demo/pulls']);
  const columns = card.locator('.pb-col');
  await expect(columns.locator('.pb-col-title')).toHaveText(['Waiting on review', 'No review requested', 'Drafts']);
  await expect(columns.locator('.pb-col-count')).toHaveText(['2', '1', '1']);
  const waiting = columns.nth(0).locator('.pb-item');
  await expect(waiting.locator('.pb-where')).toHaveText(['sandbox/demo #42', 'sandbox/demo #38']);
  await expect(waiting.first()).toContainText('maya · opened 9 days ago · 2 reviewers asked');
  await expect(waiting.first().locator('.pb-chip')).toHaveText(['security', 'ci']);
  const draft = columns.nth(2).locator('.pb-item');
  await expect(draft.locator('.pb-chip')).toHaveText(['Idle 18 days', 'database', 'migration', 'needs-design', '+1']);
});

test('the board is last on the Overview, so its arrival moves nothing a reader is looking at', async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize().width, height: 700 });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/repo/sandbox/demo/pulls?*', async route => { await held; await route.fallback(); });
  await page.goto('/#/overview');
  const last = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('#page-overview .container > section')];
    return sections[sections.length - 1] && sections[sections.length - 1].id;
  });
  expect(last).toBe('wpPullsSection');
  const feed = page.locator('#wpFeed');
  await feed.scrollIntoViewIfNeeded();
  await expect(page.locator('#wpPulls')).toContainText('Reading the open pull requests');
  const before = await feed.evaluate(node => node.getBoundingClientRect().top);
  release();
  await expect(page.locator('#wpPulls .pb-item')).toHaveCount(4);
  const after = await feed.evaluate(node => node.getBoundingClientRect().top);
  expect(Math.abs(after - before), 'the feed stays where the reader left it').toBeLessThanOrEqual(1);
});

test('a card opens its pull request in its own repository', async ({ page }) => {
  const card = await board(page);
  await card.getByRole('button', { name: /Open pull request #42 in sandbox\/demo/ }).click();
  await expect(page.locator('#tab-pulls')).toBeVisible();
  await expect(page).toHaveURL(/#\/sandbox\/demo@main\/pulls$/);
  await expect(page.locator('#prDetail')).toContainText('Pin the release workflow\'s actions to commits');
});

test('repositories it could not read are named, and it says how many it read, a few at a time', async ({ page }) => {
  const names = Array.from({ length: 14 }, (_, i) => `repo-${i}`);
  await page.setViewportSize({ width: page.viewportSize().width, height: 700 });
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/repos?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(names.map((name, i) => ({ full_name: `acme/${name}`, name, owner: 'acme', private: false, pushed_at: new Date(Date.now() - i * 3600000).toISOString() })))
  }));
  let inflight = 0;
  let peak = 0;
  const asked = [];
  await page.route('**/api/repo/acme/*/pulls*', async route => {
    const name = new URL(route.request().url()).pathname.split('/')[4];
    asked.push(name);
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise(resolve => setTimeout(resolve, 60));
    inflight -= 1;
    if (name === 'repo-1') return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'outside', code: 'ALPHA_REPOSITORY_NOT_ALLOWED' }) });
    if (name === 'repo-2') return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'GitHub did not answer', code: 'PROVIDER_UNAVAILABLE' }) });
    const pulls = name === 'repo-0'
      ? Array.from({ length: 7 }, (_, i) => ({ number: 100 + i, title: `Change ${i}`, state: 'open', draft: false, user: 'maya', head: `f/${i}`, base: 'main',
        created_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(), updated_at: new Date().toISOString(), reviewers: 1, labels: [] }))
      : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pulls) });
  });
  await page.goto('/#/overview');
  const card = page.locator('#wpPulls');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.pb-sentence')).toHaveText('7 open pull requests in 1 repository: 7 waiting on review, the longest for 7 days.');
  expect(asked.length, 'the twelve most recently pushed are read').toBe(12);
  expect(asked).not.toContain('repo-12');
  expect(peak, 'never more than four at once').toBeLessThanOrEqual(4);
  await expect(card.locator('.pb-notes li')).toHaveText([
    'Read from the 12 most recently pushed of 14 repositories.',
    '1 repository is outside this session\'s repository scope: acme/repo-1.',
    '1 repository could not be read just now: acme/repo-2.'
  ]);
  const waiting = card.locator('.pb-col-review');
  await expect(waiting.locator('.pb-item')).toHaveCount(5);
  await waiting.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(waiting.locator('.pb-item')).toHaveCount(7);
  await expect(waiting.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
});

test('a repository outside the scope is said, not drawn as nothing open', async ({ page }) => {
  const card = await board(page, { pullBoard: 'refused' });
  await expect(card).toContainText('Every repository asked is outside this session\'s repository scope.');
  await expect(card.locator('.pb-columns')).toHaveCount(0);
  await expect(card.locator('.pb-notes')).toContainText('sandbox/demo');
});

test('a provider that did not answer is not an empty workspace', async ({ page }) => {
  const card = await board(page, { pullBoard: 'error' });
  await expect(card).toContainText('The pull requests could not be read just now.');
  await expect(card.locator('.pb-sentence')).toHaveCount(0);
});

test('a workspace with nothing open says so', async ({ page }) => {
  const card = await board(page, { pullBoard: 'empty' });
  await expect(card.locator('.pb-sentence')).toHaveText('No open pull requests in the 1 repository read.');
  await expect(card.locator('.pb-columns')).toHaveCount(0);
});

test('Read again reads the lists again rather than the cache', async ({ page }) => {
  const asked = countPulls(page);
  const card = await board(page);
  await expect(card.locator('.pb-item')).toHaveCount(4);
  expect(asked.length).toBe(1);
  await card.getByRole('button', { name: 'Read the pull requests again' }).click();
  await expect.poll(() => asked.length).toBe(2);
  await expect(card.locator('.pb-item')).toHaveCount(4);
});

test('an inventory with nothing readable draws the card once and asks nothing', async ({ page }) => {
  const asked = countPulls(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: page.viewportSize().width, height: 700 });
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/repos?*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([{ full_name: '', name: '', owner: '', private: false }])
  }));
  await page.goto('/#/overview');
  const card = page.locator('#wpPulls');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toContainText('No repositories in this inventory yet');
  expect(await page.evaluate(() => 1 + 1), 'the page still answers').toBe(2);
  expect(errors).toEqual([]);
  expect(asked).toEqual([]);
});

test('an empty inventory says there is nothing to read', async ({ page }) => {
  const card = await board(page, { repositoryState: 'empty' });
  await expect(card).toContainText('No repositories in this inventory yet, so there is nothing to read.');
  await expect(card.getByRole('button', { name: 'Read the pull requests again' })).toHaveCount(0);
});

test('a deployment that does not offer pull-request reads draws none of it', async ({ page }) => {
  const asked = countPulls(page);
  await mockPublicAlphaApi(page, { access: 'active', demote: ['pulls.read'] });
  await page.goto('/#/overview');
  await expect(page.locator('#wpFeed')).toBeVisible();
  await page.locator('#wpFeed').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await expect(page.locator('#wpPullsSection')).toBeHidden();
  expect(asked).toEqual([]);
});

test('the board fits a phone in both presets and both themes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/#/overview');
  const card = page.locator('#wpPulls');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.pb-item')).toHaveCount(4);
  for (const design of ['nebula', 'obsidian']) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(([d, t]) => { document.documentElement.dataset.design = d; document.documentElement.dataset.theme = t; }, [design, theme]);
      const faults = await card.evaluate(root => {
        const box = root.getBoundingClientRect();
        const problems = [];
        if (document.documentElement.scrollWidth > window.innerWidth) problems.push('page scrolls sideways');
        for (const node of root.querySelectorAll('.pb-col, .pb-item, .pb-chip, .pb-title, .pb-where, .pb-branch, .pb-sentence, .pb-refresh')) {
          const b = node.getBoundingClientRect();
          if (b.width === 0) continue;
          if (b.left < box.left - 1 || b.right > box.right + 1) problems.push(`${node.className} leaves the card`);
          if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible') problems.push(`${node.className} overflows`);
        }
        const title = getComputedStyle(root.querySelector('.pb-title')).color;
        if (!title || title === 'rgba(0, 0, 0, 0)') problems.push('a title has no ink');
        return problems;
      });
      expect(faults, `${design} ${theme}`).toEqual([]);
    }
  }
});

test('the board has no critical or serious accessibility violations', async ({ page }) => {
  const card = await board(page);
  await expect(card.locator('.pb-item')).toHaveCount(4);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})));
  });
  const result = await new AxeBuilder({ page })
    .include('#wpPulls')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations
    .filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
    .map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target.join(' ')) }));
  expect(violations).toEqual([]);
});
