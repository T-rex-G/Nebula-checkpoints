'use strict';

/*
 * The page publishes nothing on window (ADR-092).
 *
 * As classic scripts, every function of the workbench and every library it
 * used were properties of window, reachable by any script on the page beside
 * a live CSRF token and step-up credentials. As modules they share only what
 * they import. These compare the page's own window properties, after boot and
 * after the module it loads on demand, with a blank page's from the same
 * origin under the same policy: a name the application added is a global of
 * its own.
 *
 * The read-only probe the browser suite reads state through exists only when
 * the harness asked for it before the page's first script; the marker is gone
 * once the page has booted, and what the probe gives is a frozen copy.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const BLANK = '/blank-page-for-the-globals-check';
const ownNames = page => page.evaluate(() => Object.getOwnPropertyNames(window));

/* A page of this origin with nothing in it, served with the page's own policy. */
async function blankNames(page) {
  const served = await page.request.get('/');
  const policy = served.headers()['content-security-policy'];
  expect(policy, 'the page is served with a policy for the blank page to share').toBeTruthy();
  await page.route(`**${BLANK}`, route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': policy },
    body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blank</title></head><body></body></html>'
  }));
  await page.goto(BLANK);
  return new Set(await ownNames(page));
}

const added = (names, blank) => names.filter(name => !blank.has(name)).sort();

test('the booted page defines no globals of its own, before and after sign-in', async ({ page }) => {
  const blank = await blankNames(page);
  expect(blank.size, 'the blank page has the browser\'s own globals to compare with').toBeGreaterThan(100);

  /* The gate, as a visitor first meets it. */
  await page.goto('/');
  await expect(page.locator('#page-alpha-access')).toHaveClass(/active/);
  await expect(page.locator('#alphaWakeState')).not.toHaveText('');
  expect(added(await ownNames(page), blank)).toEqual([]);

  /* Signed in, in a repository, with the module the page loads on demand loaded too. */
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  /* A new document, not a change of fragment on this one: the page boots again, signed in. */
  await page.goto('about:blank');
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await ui.openTab(page, 'neural');
  await expect(page.locator('#neuralCanvas')).toBeVisible();
  /* The graph has read the repository: the module ran, not merely loaded. */
  await expect(page.locator('#neuralRiskHint')).not.toHaveText('Waiting for repository data');
  expect(added(await ownNames(page), blank)).toEqual([]);
  expect(await page.evaluate(() => ['__NV_PROBE__', '__NV_HARNESS__'].filter(name => name in window))).toEqual([]);
});

test('the probe answers only under the harness, read-only and frozen', async ({ page }) => {
  await ui.underHarness(page);
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);

  const shape = await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(window, '__NV_PROBE__');
    return {
      marker: '__NV_HARNESS__' in window,
      writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable,
      frozen: Object.isFrozen(window.__NV_PROBE__),
      members: Object.keys(window.__NV_PROBE__)
    };
  });
  expect(shape).toEqual({ marker: false, writable: false, enumerable: false, configurable: false, frozen: true, members: ['read'] });

  /* A copy of the allowlist, frozen: writing to it changes neither the copy nor the next one. */
  const runtime = await page.evaluate(() => {
    const first = window.__NV_PROBE__.read('runtime');
    let refused = false;
    try { 'use strict'; first.uploadMaxMb = 1; } catch { refused = true; }
    return { first, refused, frozen: Object.isFrozen(first), again: window.__NV_PROBE__.read('runtime') };
  });
  expect(runtime.frozen).toBe(true);
  expect(Object.keys(runtime.first).sort()).toEqual(['contentsMaxMb', 'gitDataMaxMb', 'known', 'nativePushMaxMb', 'uploadMaxMb']);
  expect(runtime.again).toEqual(runtime.first);
  expect(runtime.first.known).toBe(true);

  /* A source the allowlist does not name is refused, and the graph is nothing until its module is loaded. */
  expect(await page.evaluate(() => { try { window.__NV_PROBE__.read('state'); return 'answered'; } catch (error) { return error.name; } })).toBe('TypeError');
  expect(await ui.probe(page, 'neural')).toBeNull();
});

test('a marker that is not exactly true asks for nothing, and is gone after boot', async ({ page }) => {
  await page.addInitScript(() => { window.__NV_HARNESS__ = 'yes'; });
  await page.goto('/');
  await expect(page.locator('#page-alpha-access')).toHaveClass(/active/);
  expect(await page.evaluate(() => ['__NV_PROBE__', '__NV_HARNESS__'].filter(name => name in window))).toEqual([]);
});
