'use strict';

/*
 * The page's chrome, used by the page: Magnetar Sec on a rail narrowed to
 * its marks, across the window's breakpoint. Narrowed, the rail shows only
 * marks at the wide width, and the fold's tools are always shown there --
 * so they must be reachable there, and folded away out of the tab order
 * below it, whichever width the page was opened at. The rail and the dock
 * are asked directly by test/page-shell.test.js; test/e2e/shell-chrome.spec.js
 * drives the rest of the chrome.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/* Whether a press at the middle of Magnetar Sec's first mark lands on it, and how the fold is laid out. */
const foldState = page => page.evaluate(() => {
  const fold = document.querySelector('#railSecurityFold');
  const mark = fold.querySelector('.nv-rail-item');
  const box = mark.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return { inert: fold.inert, reachable: !!hit && (hit === mark || mark.contains(hit)), headingTab: document.querySelector('#railSecurityLabel').tabIndex };
});

test('a narrowed rail\'s security marks are reachable once the window is wide, and folded away once it is narrow again', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'a phone never reaches the wide width');
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('nv_rail_collapsed', '1');
    localStorage.setItem('nv_ui:rail-security', '0');
  });
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  expect(await foldState(page)).toMatchObject({ inert: true, headingTab: 0 });

  await page.setViewportSize({ width: 1300, height: 800 });
  await expect.poll(() => foldState(page)).toEqual({ inert: false, reachable: true, headingTab: -1 });
  await expect(page.locator('#railSecurityFold')).toHaveAttribute('data-open', 'false');

  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(() => foldState(page).then(state => [state.inert, state.headingTab])).toEqual([true, 0]);
  expect(await page.evaluate(() => localStorage.getItem('nv_ui:rail-security'))).toBe('0');
});
