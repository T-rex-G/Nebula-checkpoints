'use strict';

/*
 * The findings inbox.
 *
 * Every open finding across the workspace, in one list. What these pin is
 * what a person relies on while working through it: the filters live in the
 * address and survive a reload; a finding that came back after a fix, and one
 * only in history, say so; each row names its owner from CODEOWNERS; a row's
 * record opens in place; a bulk decision reaches each finding's own triage
 * route and the list reads itself again; an exposure finding leads to the
 * exposure screen; a database that did not answer is not an empty inbox; and
 * the page fits a phone in both presets and both themes.
 */

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function inbox(page, options = {}, hash = '#/findings') {
  await mockPublicAlphaApi(page, { access: 'active', ...options });
  await page.goto(`/${hash}`);
  await expect(page.locator('#page-findings')).toHaveClass(/active/);
  const root = page.locator('#findingsRoot');
  return root;
}

test('the inbox lists open work first, and says what each finding is', async ({ page }) => {
  const root = await inbox(page);
  const rows = root.locator('.fi-item');
  await expect(rows).toHaveCount(4);
  await expect(root.locator('.fi-count')).toHaveText('4 of 5 findings');
  await expect(rows.nth(0).locator('.fi-title')).toHaveText('Request input is executed as code');
  await expect(rows.nth(0).locator('.fi-state')).toHaveText('New');
  const regressed = root.locator('.fi-item[data-state="regressed"]');
  await expect(regressed.locator('.fi-state')).toHaveText('Seen again');
  const token = root.locator('.fi-item', { hasText: 'GitHub token' });
  await expect(token).toContainText('In history only');
  await expect(token.locator('.fi-select')).toHaveCount(0);
  await expect(root.locator('.fi-item', { hasText: 'jquery' }).first()).toBeAttached();
  await expect(root.locator('.fi-item', { hasText: 'A dependency has a published vulnerability' })).toContainText('Exploited in the wild');
  /* Owners from the repository's CODEOWNERS: the later src/ rule wins for src/ paths. */
  await expect(rows.nth(0).locator('.fi-owner')).toHaveText('Owner @sandbox/web');
  await expect(token.locator('.fi-owner')).toHaveText('Owner @sandbox/everyone');
});

test('filters live in the address and survive a reload', async ({ page }) => {
  const root = await inbox(page);
  await root.getByRole('button', { name: /^Critical 2$/ }).click();
  await expect(page).toHaveURL(/#\/findings\?severity=critical$/);
  await expect(root.locator('.fi-item')).toHaveCount(2);
  await root.locator('.fi-search').fill('github');
  await expect(page).toHaveURL(/#\/findings\?severity=critical&q=github$/);
  await expect(root.locator('.fi-item')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#page-findings')).toHaveClass(/active/);
  await expect(root.locator('.fi-item')).toHaveCount(1);
  await expect(root.locator('.fi-search')).toHaveValue('github');
  await root.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/#\/findings$/);
  await expect(root.locator('.fi-item')).toHaveCount(4);
  await root.getByRole('button', { name: /^Decided 1$/ }).click();
  await expect(root.locator('.fi-item')).toHaveCount(1);
  await expect(root.locator('.fi-item .fi-state')).toHaveText('Risk accepted');
  await root.locator('.fi-kind-select').selectOption('code');
  await expect(page).toHaveURL(/view=decided&kind=code/);
});

test('a finding\'s record opens in place', async ({ page }) => {
  const root = await inbox(page);
  const regressed = root.locator('.fi-item[data-state="regressed"]');
  await regressed.locator('summary').click();
  await expect(regressed.locator('.fi-timeline').first()).toContainText('Fixed');
  await expect(regressed.locator('.fi-timeline').first()).toContainText('Seen again after the fix');
  await expect(regressed.locator('.fi-decisions')).toContainText('Nobody has decided anything about this finding.');
  const dependency = root.locator('.fi-item', { hasText: 'A dependency has a published vulnerability' });
  await dependency.locator('summary').click();
  await expect(dependency.locator('.fi-fact')).toHaveText('jquery 3.4.1, fixed in 3.5.0 · CVE-2020-11023');
});

test('a bulk decision reaches each finding\'s own triage route', async ({ page }) => {
  const root = await inbox(page);
  const posts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/code-audit\/findings\/[0-9a-f]{24}\/triage$/.test(new URL(request.url()).pathname)) posts.push(request.postDataJSON());
  });
  const boxes = root.locator('.fi-select');
  await expect(boxes).toHaveCount(3);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const bar = root.getByRole('region', { name: 'Decide the selected findings' });
  await expect(bar).toBeVisible();
  await expect(bar.locator('.fi-bulk-count')).toHaveText('2 selected');
  await bar.locator('.fi-bulk-disposition').selectOption('accepted-risk');
  await bar.locator('.fi-bulk-reason').selectOption('fix-scheduled');
  await bar.locator('.fi-bulk-days').selectOption('30');
  await bar.getByRole('button', { name: 'Decide' }).click();
  await expect.poll(() => posts.length).toBe(2);
  await expect(root.locator('.fi-bulk-progress')).toHaveText(/^$|2 decided\./);
  expect(posts.every(body => body.disposition === 'accepted-risk' && body.reason === 'fix-scheduled' && body.expiresInDays === 30 && /^SEC-0\d\d$/.test(body.rule))).toBe(true);
  /* The list reads itself again: both now sit under Decided. */
  await expect(root.locator('.fi-item')).toHaveCount(2);
  await expect(root.getByRole('button', { name: /^Decided 3$/ })).toBeVisible();
  await expect(root.locator('.fi-bulk')).toBeHidden();
});

test('the decision bar stays in view while the selection grows down the list', async ({ page }) => {
  const root = await inbox(page);
  await root.locator('.fi-select').first().check();
  const bar = root.getByRole('region', { name: 'Decide the selected findings' });
  await expect(bar).toBeVisible();
  await root.locator('.fi-item').last().scrollIntoViewIfNeeded();
  await root.locator('.fi-select').last().check();
  await expect(bar.locator('.fi-bulk-count')).toHaveText('2 selected');
  const placement = await bar.evaluate(node => {
    const box = node.getBoundingClientRect();
    const topbar = document.querySelector('#page-findings .topbar').getBoundingClientRect();
    const controls = [...node.querySelectorAll('select, button')].filter(control => control.getBoundingClientRect().width > 0);
    return {
      inView: box.top >= 0 && box.bottom <= window.innerHeight,
      clearOfTopbar: box.top >= topbar.bottom - 1,
      controlsInside: controls.every(control => {
        const b = control.getBoundingClientRect();
        return b.left >= box.left - 0.5 && b.right <= box.right + 0.5;
      })
    };
  });
  expect(placement).toEqual({ inView: true, clearOfTopbar: true, controlsInside: true });
});

test('an exposure finding opens the exposure screen; an audit finding opens the audit', async ({ page }) => {
  const root = await inbox(page);
  await root.locator('.fi-item', { hasText: 'GitHub token' }).getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('#tab-exposure')).toBeVisible();
  await page.goBack();
  await page.goto('/#/findings');
  await root.locator('.fi-item').first().getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('#tab-audit')).toBeVisible();
});

test('the rail and the Overview both lead to the inbox', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/#/overview');
  await expect(page.locator('#wpPosture')).toBeVisible();
  await page.locator('#wpPosture .pp-inbox-link').click();
  await expect(page.locator('#page-findings')).toHaveClass(/active/);
  await expect(page).toHaveURL(/#\/findings$/);
  if (page.viewportSize().width >= 1140) {
    await expect(page.locator('.nv-rail-item[data-rail="findings"]')).toHaveAttribute('aria-current', 'page');
  }
});

test('an unanswered database is not an empty inbox', async ({ page }) => {
  const root = await inbox(page, { findingsInbox: 'unavailable' });
  await expect(root).toContainText('The server database did not answer');
  await expect(root.locator('.fi-item')).toHaveCount(0);
});

test('an empty inbox says so, and says how to fill it', async ({ page }) => {
  const root = await inbox(page, { findingsInbox: 'empty' });
  await expect(root.locator('.fi-empty-title')).toHaveText('No findings');
  await expect(root.locator('.fi-empty-text')).toContainText('Audit or scan a repository');
});

test('the inbox fits a phone in both presets and both themes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const root = await inbox(page);
  await expect(root.locator('.fi-item')).toHaveCount(4);
  for (const design of ['nebula', 'obsidian']) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(([d, t]) => { document.documentElement.dataset.design = d; document.documentElement.dataset.theme = t; }, [design, theme]);
      const faults = await root.evaluate(host => {
        const box = host.getBoundingClientRect();
        const problems = [];
        if (document.documentElement.scrollWidth > window.innerWidth) problems.push('page scrolls sideways');
        for (const node of host.querySelectorAll('.fi-item, .fi-filter, .fi-selects > *, .fi-title, .fi-where, .fi-chip, .fi-open')) {
          const b = node.getBoundingClientRect();
          if (b.width === 0) continue;
          if (b.left < box.left - 1 || b.right > box.right + 1) problems.push(`${node.className} leaves the list`);
        }
        return problems;
      });
      expect(faults, `${design} ${theme}`).toEqual([]);
    }
  }
});

test('the inbox has no critical or serious accessibility violations', async ({ page }) => {
  const root = await inbox(page);
  await expect(root.locator('.fi-item')).toHaveCount(4);
  await root.locator('.fi-select').first().check();
  const result = await new AxeBuilder({ page })
    .include('#page-findings')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations
    .filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
    .map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target.join(' ')) }));
  expect(violations).toEqual([]);
});
