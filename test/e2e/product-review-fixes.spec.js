'use strict';
const { test, expect } = require('@playwright/test');
const { HEAD_SHA, mockPublicAlphaApi, openConnectedRepository } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function stageNewFile(page, path) {
  await (await ui.action(page, 'Command palette')).click();
  await page.locator('#paletteInput').fill('New file');
  await page.locator('.pal-item', { hasText: 'New file' }).first().click();
  await page.locator('#nfPath').fill(path);
  await page.locator('#modalOk').click();
}

test('new file stays local until its target and diff are reviewed and confirmed', async ({ page }) => {
  const fixture = await openConnectedRepository(page);
  await stageNewFile(page, 'reviewed-new.txt');
  expect(fixture.mutationRequests, 'staging must never call the provider write endpoint').toHaveLength(0);
  await expect(page.locator('#stagePanel')).toBeVisible();
  await expect(page.locator('#stageList')).toContainText('reviewed-new.txt');
  await page.getByRole('button', { name: 'Review staged changes', exact: true }).click();
  const dialog = ui.dialog(page, 'Review staged changes');
  await expect(dialog).toContainText('sandbox/demo');
  await expect(dialog).toContainText('main');
  await expect(dialog).toContainText(HEAD_SHA);
  await expect(dialog).toContainText('Create empty file');
  expect(fixture.mutationRequests).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(fixture.mutationRequests).toHaveLength(0);
  await page.getByRole('button', { name: 'Review staged changes', exact: true }).click();
  await ui.dialog(page, 'Review staged changes').getByRole('button', { name: 'Commit 1 change', exact: true }).click();
  await expect.poll(() => fixture.mutationRequests.length).toBe(1);
  expect(fixture.mutationRequests[0]).toMatchObject({ path: 'reviewed-new.txt', content: '', branch: 'main', expectedHeadSha: HEAD_SHA });
});

for (const width of [320, 390]) {
  test(`repository selection is visible before scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockPublicAlphaApi(page, { access: 'active' });
    await page.goto('/');
    await ui.enterRepositories(page);
    const filter = page.locator('#repoFilter');
    const first = page.locator('.repo-card').first();
    await expect(first).toBeVisible();
    for (const design of ['nebula', 'obsidian']) for (const theme of ['dark', 'light']) {
      await page.evaluate(({ design, theme }) => {
        document.documentElement.dataset.design = design;
        document.documentElement.dataset.theme = theme;
      }, { design, theme });
      await expect(filter).toBeInViewport({ ratio: 1 });
      await expect(first).toBeInViewport({ ratio: 0.75 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    const summary = page.getByRole('button', { name: 'Repository summary', exact: true });
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#reposPulse')).toBeVisible();
    await summary.click();
    await filter.fill('demo');
    await first.click();
    await expect(page.locator('#page-work.active')).toBeVisible();
  });
}

test('connection screen states deployment limits and a coherent least-privilege path', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.route('**/api/config', route => route.fulfill({ json: {
    oauth: false, uploadMaxMb: 25, gitDataMaxMb: 16, nativePushMaxMb: 16,
    contentsMaxMb: 40, githubApp: { enabled: true }
  } }));
  await page.goto('/');
  await ui.secretField(page, 'One-time invitation').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(ui.screen(page, 'access'), 'Continue').click();
  const login = ui.screen(page, 'login');
  await expect(login).toContainText('Direct upload: 25 MB');
  await expect(login).toContainText('native push: 16 MB');
  await expect(login).toContainText('fine-grained');
  await expect(login).toContainText('selected repositories');
  await expect(login).toContainText('Settings → GitHub App');
  await expect(login).toContainText('HttpOnly session cookie stored by your browser');
  await expect(login).not.toContainText(/pushes of any size|never stored in the browser|Tokens \(classic\)/i);
});

test('an existing path or unreadable original never becomes a reviewed new-file write', async ({ page }) => {
  const fixture = await openConnectedRepository(page);
  await stageNewFile(page, 'README.md');
  await page.getByRole('button', { name: 'Review staged changes', exact: true }).click();
  await expect(page.locator('#trustErrorBackdrop')).toContainText('already exists');
  expect(fixture.mutationRequests).toHaveLength(0);
  await page.locator('#trustErrorBackdrop').getByRole('button', { name: 'Close', exact: true }).click();
  await page.route('**/api/repo/sandbox/demo/file?**', route => route.fulfill({ status: 503, json: { error: 'Original file unavailable' } }));
  await page.getByRole('button', { name: 'Review staged changes', exact: true }).click();
  await expect(page.locator('#trustErrorBackdrop')).toContainText('Original file unavailable');
  expect(fixture.mutationRequests).toHaveLength(0);
});

test('changing staged content during a pending preview refuses the old review', async ({ page }) => {
  const fixture = await openConnectedRepository(page);
  await stageNewFile(page, 'pending-review.txt');
  let release;
  let requested;
  const pending = new Promise(resolve => { requested = resolve; });
  await page.route('**/api/repo/sandbox/demo/file?**', async route => {
    requested();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.getByRole('button', { name: 'Review staged changes', exact: true }).click();
  await pending;
  await page.locator('#stageList').getByRole('button', { name: 'Unstage', exact: true }).click();
  release();
  await expect(page.locator('#trustErrorBackdrop')).toContainText('changed');
  await expect(ui.dialog(page, 'Review staged changes')).not.toBeVisible();
  expect(fixture.mutationRequests).toHaveLength(0);
});
