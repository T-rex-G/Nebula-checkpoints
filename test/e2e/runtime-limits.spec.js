'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/*
 * The client must not state a limit the server never sent it.
 *
 * state.runtime held 2048/64/64 as its starting values -- the ceilings of a
 * self-hosted deployment -- and /api/config was fetched without await and with
 * a swallowed rejection. On the hosted alpha, which enforces 25/16/16, that
 * meant two wrong numbers reached the reader: the per-file refusal named a
 * 2048 MB limit, and a 30 MB file was labelled "Git Data API" when the server
 * would refuse anything over 16 MB. A cold start on a free instance -- the
 * ordinary first request -- made both permanent for the session.
 */
const CONFIG = {
  oauth: false,
  uploadMaxMb: 25,
  gitDataMaxMb: 16,
  nativePushMaxMb: 16,
  contentsMaxMb: 40
};

async function runtime(page) {
  return page.evaluate(() => ({
    uploadMaxMb: state.runtime.uploadMaxMb,
    gitDataMaxMb: state.runtime.gitDataMaxMb,
    nativePushMaxMb: state.runtime.nativePushMaxMb,
    contentsMaxMb: state.runtime.contentsMaxMb,
    /* The label a queued file would carry, at sizes either side of the ceiling. */
    smallLabel: strategyFor(1 * 1048576, 'auto'),
    largeLabel: strategyFor(30 * 1048576, 'auto')
  }));
}

test('the limits the server sent are the limits the interface uses', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/config', route => route.fulfill({ status: 200, json: CONFIG }));
  await page.goto('/');
  await page.locator('#page-repos.active, #page-overview.active').first().waitFor();

  const values = await runtime(page);
  expect(values.uploadMaxMb).toBe(25);
  expect(values.gitDataMaxMb).toBe(16);
  expect(values.nativePushMaxMb).toBe(16);
  expect(values.contentsMaxMb).toBe(40);
  /*
   * 30 MB is over the hosted native-push ceiling and under the self-hosted one.
   * It is the size that told the reader the wrong route before this.
   */
  expect(values.largeLabel).toBe('Git LFS ✦');
  expect(values.smallLabel).toBe('Git Data API');
});

test('an unreachable config leaves the limits unknown rather than guessed', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  /* Every attempt fails, including the retry: a service that never wakes. */
  await page.route('**/api/config', route => route.fulfill({
    status: 503, json: { error: 'unavailable' }
  }));
  await page.goto('/');
  await page.locator('#page-repos.active, #page-overview.active').first().waitFor();

  const values = await runtime(page);
  for (const key of ['uploadMaxMb', 'gitDataMaxMb', 'nativePushMaxMb', 'contentsMaxMb']) {
    expect(values[key], `${key} must stay unknown, not fall back to a self-hosted ceiling`).toBeNull();
  }
  /*
   * Specifically not 2048, 64 or 64. Naming a ceiling nobody sent is worse than
   * naming none: the reader believes a number the server will not honour.
   */
  expect(values.uploadMaxMb).not.toBe(2048);
  expect(values.nativePushMaxMb).not.toBe(64);
  expect(values.largeLabel).toBe('checking limits…');
  expect(values.smallLabel).toBe('checking limits…');
});

test('a slow config is awaited rather than raced', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/config', async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    return route.fulfill({ status: 200, json: CONFIG });
  });
  await page.goto('/');
  await page.locator('#page-repos.active, #page-overview.active').first().waitFor();

  /*
   * Read immediately once a screen is up. Fire-and-forget left a window where
   * the app was usable and the limits were still the starting values; awaiting
   * closes it, so by the time anything is on screen the numbers are the
   * server's.
   */
  const values = await runtime(page);
  expect(values.uploadMaxMb).toBe(25);
  expect(values.nativePushMaxMb).toBe(16);
});

async function queueConfigProbe(page) {
  await page.goto('/');
  await ui.enterRepositories(page);
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
  await page.evaluate(() => window.switchTab('upload'));
  await page.locator('#filePicker').setInputFiles({
    name: 'config-probe.txt', mimeType: 'text/plain', buffer: Buffer.from('config probe\n')
  });
}

test('an incomplete transport config refuses uploads before sending a write', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const partialConfig = { ...CONFIG, contentsMaxMb: undefined };
  await page.route('**/api/config', route => route.fulfill({ json: partialConfig }));
  let writes = 0;
  await page.route('**/api/repo/sandbox/demo/upload?**', route => {
    writes += 1;
    return route.fulfill({ json: { ok: true, commit: 'b'.repeat(40), strategy: 'git-data-api' } });
  });

  await queueConfigProbe(page);
  await expect(page.locator('#uploadQueue .uq-item.error')).toHaveCount(1);
  await expect(page.locator('#uploadQueue .uq-status')).toContainText('upload limits are unavailable');
  await expect(page.locator('#uploadQueue .uq-strategy')).toHaveText('checking limits…');
  expect(await page.evaluate(() => window.runtimeLimitsKnown())).toBe(false);
  expect(writes).toBe(0);
});

test('a recovered config refreshes the queued route before uploading', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let configRequests = 0;
  await page.route('**/api/config', route => {
    configRequests += 1;
    return route.fulfill({ json: configRequests === 1 ? { ...CONFIG, contentsMaxMb: undefined } : CONFIG });
  });
  const heads = [];
  await page.route('**/api/repo/sandbox/demo/upload?**', route => {
    heads.push(new URL(route.request().url()).searchParams.get('expectedHeadSha'));
    return route.fulfill({ json: { ok: true, commit: 'b'.repeat(40), strategy: 'git-data-api' } });
  });

  await queueConfigProbe(page);
  await expect(page.locator('#uploadQueue .uq-item.done')).toHaveCount(1);
  await expect(page.locator('#uploadQueue .uq-strategy')).toHaveText('Git Data API');
  expect(await page.evaluate(() => window.runtimeLimitsKnown())).toBe(true);
  expect(configRequests).toBe(2);
  expect(heads).toEqual(['a'.repeat(40)]);
});
