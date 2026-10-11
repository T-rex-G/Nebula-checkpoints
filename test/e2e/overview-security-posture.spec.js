'use strict';

/*
 * The security posture on the Overview.
 *
 * It reads what the audits, exposure scans and governance already hold and
 * draws it between the trust cards and the recent-activity feed. What these
 * pin is what a reader relies on: the figures are the server's, the chart can
 * be read without colour and without a pointer, every repository named leads
 * to its audit, a repository nothing has read is named as such, a store that
 * did not answer is never drawn as a clean workspace, the card fits a phone in
 * both presets and both themes, and a deployment that does not offer it draws
 * nothing at all.
 */

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function overview(page, options = {}) {
  await mockPublicAlphaApi(page, { access: 'active', ...options });
  await page.goto('/#/overview');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  const card = page.locator('#wpPosture');
  await expect(card).toBeVisible();
  return card;
}

async function settled(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const entrances = document.getAnimations().filter(animation => animation.timeline === document.timeline &&
      animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime));
    await Promise.all(entrances.map(animation => animation.finished.catch(() => {})));
  });
}

test('the posture sits between the trust cards and the feed, and says what moved this week', async ({ page }) => {
  const card = await overview(page);
  const order = await page.evaluate(() => {
    const grid = document.querySelector('#page-overview .wp-grid');
    const posture = document.querySelector('#wpPosture');
    const feed = document.querySelector('#wpFeed');
    return {
      afterGrid: Boolean(grid.compareDocumentPosition(posture) & Node.DOCUMENT_POSITION_FOLLOWING),
      beforeFeed: Boolean(posture.compareDocumentPosition(feed) & Node.DOCUMENT_POSITION_FOLLOWING)
    };
  });
  expect(order).toEqual({ afterGrid: true, beforeFeed: true });
  await expect(card.getByRole('heading', { name: 'Security posture' })).toBeAttached();
  await expect(card.locator('.pp-week')).toHaveText('This week: 3 new findings, 1 fixed and 2 merge attempts gated.');
  const tiles = card.locator('.pp-tile');
  await expect(tiles).toHaveCount(4);
  await expect(tiles.nth(0).locator('.pp-tile-figure')).toHaveText('6');
  await expect(tiles.nth(0)).toContainText('1 critical · 3 serious · 2 warning');
  await expect(tiles.nth(1)).toContainText('2 accepted risks · 1 not a problem');
  await expect(tiles.nth(2).locator('.pp-tile-figure')).toHaveText('4.5 days');
  await expect(tiles.nth(3).locator('.pp-tile-figure')).toHaveText('1 of 1');
});

test('the weekly chart reads by hover, by its legend and by its table', async ({ page }) => {
  const card = await overview(page);
  const chart = card.locator('.pp-chart-svg');
  await expect(chart).toHaveAttribute('aria-label', /12 weeks: 9 opened and 5 fixed in all\./);
  await expect(card.locator('.pp-legend')).toContainText('Opened');
  await expect(card.locator('.pp-legend')).toContainText('Fixed');
  await expect(card.locator('.pp-hit')).toHaveCount(12);
  await expect(card.locator('.pp-bar-opened').first()).toBeAttached();
  await expect(card.locator('.pp-bar-fixed').first()).toBeAttached();
  /* Every bar stands on the baseline and stays inside the plot. */
  const inside = await chart.evaluate(svg => {
    const box = svg.getBoundingClientRect();
    return [...svg.querySelectorAll('.pp-bar')].every(bar => {
      const b = bar.getBoundingClientRect();
      return b.left >= box.left - 0.5 && b.right <= box.right + 0.5 && b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5 && b.height > 0;
    });
  });
  expect(inside).toBe(true);
  if (page.viewportSize().width > 760) {
    await card.locator('.pp-hit[data-week="0"]').hover();
    await expect(card.locator('.pp-tip')).toHaveText('This week: 3 opened, 1 fixed');
    await card.locator('.pp-hit[data-week="2"]').hover();
    await expect(card.locator('.pp-tip')).toHaveText('2 weeks ago: 4 opened, 2 fixed');
  }
  const numbers = card.locator('.pp-trend .wp-numbers');
  await numbers.locator('summary').click();
  const rows = numbers.locator('tbody tr');
  await expect(rows).toHaveCount(12);
  await expect(rows.first()).toHaveText(/This week\s*3\s*1/);
});

test('a repository named on the card opens its audit', async ({ page }) => {
  const card = await overview(page);
  const top = card.locator('.pp-repos .pp-repo-name').first();
  await expect(top).toHaveText('sandbox/demo');
  await expect(card.locator('.pp-repo-count').first()).toHaveAttribute('aria-label', '6 open: 1 critical · 3 serious · 2 warning');
  await expect(card.locator('.pp-cats .pp-cat-name')).toHaveText(['Dependencies', 'Leaked credentials', 'Code security']);
  await top.click();
  await expect(page.locator('#tab-audit')).toBeVisible();
  await expect(page).toHaveURL(/#\/sandbox\/demo@main\/audit$/);
});

test('repositories nothing has read are named, and lead to their audit', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', securityPosture: 'empty' });
  await page.route('**/api/repos?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { full_name: 'sandbox/demo', name: 'demo', owner: 'sandbox', private: true, pushed_at: new Date().toISOString() },
      ...Array.from({ length: 8 }, (_, index) => ({
        full_name: `sandbox/repo-${index}`, name: `repo-${index}`, owner: 'sandbox', private: false,
        pushed_at: new Date(Date.now() - (index + 1) * 86400000).toISOString()
      }))
    ])
  }));
  await page.goto('/#/overview');
  const card = page.locator('#wpPosture');
  await expect(card.locator('.pp-empty-title')).toHaveText('Nothing audited or scanned yet');
  const chips = card.locator('.pp-unread .pp-chip');
  await expect(chips).toHaveCount(6);
  await expect(chips.first()).toHaveText('sandbox/demo');
  await expect(card.locator('.pp-chip-more')).toHaveText('+3 more');
  await chips.first().click();
  await expect(page.locator('#tab-audit')).toBeVisible();
});

test('a database that did not answer is never drawn as a clean workspace', async ({ page }) => {
  const card = await overview(page, { securityPosture: 'unavailable' });
  await expect(card).toContainText('The server database did not answer');
  await expect(card.locator('.pp-tile')).toHaveCount(0);
});

test('governance that could not be read is said, and its count left out', async ({ page }) => {
  const card = await overview(page, { securityPosture: 'partial' });
  await expect(card.locator('.pp-week')).toHaveText('This week: 3 new findings and 1 fixed.');
  await expect(card).toContainText('Governance decisions could not be read; gated merges are not counted.');
});

test('a failed request is said, not drawn as nothing open', async ({ page }) => {
  const card = await overview(page, { securityPosture: 'error' });
  await expect(card).toContainText('could not be read');
  await expect(card.locator('.pp-tile')).toHaveCount(0);
});

test('a deployment that does not offer the posture draws none of it', async ({ page }) => {
  let asked = 0;
  page.on('request', request => { if (request.url().includes('/api/workspace/security-posture')) asked += 1; });
  await mockPublicAlphaApi(page, { access: 'active', demote: ['workspace.posture'] });
  await page.goto('/#/overview');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await expect(page.locator('#wpFeed')).toBeVisible();
  await expect(page.locator('#wpPostureSection')).toBeHidden();
  expect(asked).toBe(0);
});

test('the card fits a phone in both presets and both themes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const card = await overview(page);
  for (const design of ['nebula', 'obsidian']) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(([d, t]) => { document.documentElement.dataset.design = d; document.documentElement.dataset.theme = t; }, [design, theme]);
      await settled(page);
      const faults = await card.evaluate(root => {
        const box = root.getBoundingClientRect();
        const problems = [];
        if (document.documentElement.scrollWidth > window.innerWidth) problems.push('page scrolls sideways');
        for (const node of root.querySelectorAll('.pp-tile, .pp-week, .pp-repo, .pp-cat, .pp-legend, .pp-chip, .pp-chart-svg')) {
          const b = node.getBoundingClientRect();
          if (b.width === 0) continue;
          if (b.left < box.left - 1 || b.right > box.right + 1) problems.push(`${node.className} leaves the card`);
          if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible') problems.push(`${node.className} overflows`);
        }
        const bars = [...root.querySelectorAll('.pp-bar-opened, .pp-bar-fixed')].map(bar => getComputedStyle(bar).fill);
        if (new Set(bars).size < 2) problems.push('opened and fixed share one colour');
        const text = getComputedStyle(root.querySelector('.pp-week')).color;
        if (!text || text === 'rgba(0, 0, 0, 0)') problems.push('the headline has no ink');
        return problems;
      });
      expect(faults, `${design} ${theme}`).toEqual([]);
    }
  }
});

test('the card has no critical or serious accessibility violations', async ({ page }) => {
  await overview(page);
  await settled(page);
  const result = await new AxeBuilder({ page })
    .include('#wpPosture')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations
    .filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
    .map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target.join(' ')) }));
  expect(violations).toEqual([]);
});
