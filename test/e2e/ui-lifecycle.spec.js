'use strict';
const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });
const unread = [{ id: 'late', unread: true, repo: 'sandbox/demo', reason: 'mention', type: 'PullRequest', title: 'Delayed notification' }];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function settleResponse(page, response) {
  await (await response).finished();
  // Observe after fetch/JSON continuations and the following paint, not just headers.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function boot(page, motion = true) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(value => {
    if (!localStorage.getItem('nv_settings')) localStorage.setItem('nv_settings', JSON.stringify({ motion: value }));
  }, motion);
  await mockPublicAlphaApi(page);
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
}

test('late notification response cannot restore a purged account badge', async ({ page }) => {
  await mockPublicAlphaApi(page);
  const request = deferred();
  const release = deferred();
  await page.route('**/api/notifications', async route => {
    request.resolve();
    await release.promise;
    await route.fulfill({ json: unread });
  });
  await page.goto('/');
  await request.promise;
  await page.evaluate(() => window.NebulaPwa.purgePrivateData(true));
  const response = page.waitForResponse('**/api/notifications');
  release.resolve();
  await settleResponse(page, response);
  await expect(page.locator('#notifBtn')).toHaveAttribute('aria-label', 'Notifications');
  await expect(page.locator('#notifUnread')).toHaveJSProperty('hidden', true);
});

test('an older unread refresh cannot overwrite a newer inbox result', async ({ page }) => {
  await mockPublicAlphaApi(page);
  const started = deferred();
  const release = deferred();
  let calls = 0;
  await page.route('**/api/notifications', async route => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
      return route.fulfill({ json: unread });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await started.promise;
  await ui.enterRepositories(page);
  await ui.button(page, /^Notifications/).click();
  await expect(ui.dialog(page, 'Notifications')).toContainText('Inbox zero');
  const response = page.waitForResponse('**/api/notifications');
  release.resolve();
  await settleResponse(page, response);
  await expect(ui.button(page, 'Notifications')).toHaveAttribute('aria-label', 'Notifications');
});

test('an account switch cannot inherit the old account unread response', async ({ page }) => {
  await mockPublicAlphaApi(page);
  const started = deferred();
  const release = deferred();
  let switched = false;
  let calls = 0;
  await page.route('**/api/notifications', async route => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
      return route.fulfill({ json: unread });
    }
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/accounts', route => route.fulfill({ json: { active: 0, accounts: [
    { login: 'alpha-tester', provider: 'github' }, { login: 'second-tester', provider: 'github' }
  ] } }));
  await page.route('**/api/accounts/switch-idx', route => {
    switched = true;
    return route.fulfill({ json: { ok: true, login: 'second-tester' } });
  });
  await page.route('**/api/me', route => switched ? route.fulfill({ json: {
    login: 'second-tester', name: 'Second Tester', provider: 'github', authMethod: 'token',
    offlineCacheScope: 'scopeSecond_0123456789abcdefXYZ', caps: { notif: true }
  } }) : route.fallback());
  await page.goto('/');
  await started.promise;
  await ui.button(page, 'Accounts').click();
  await ui.button(ui.dialog(page, 'Accounts'), 'Switch').click();
  await expect(ui.screen(page, 'overview')).toContainText('Second Tester');
  await expect.poll(() => calls).toBe(2);
  const response = page.waitForResponse('**/api/notifications');
  release.resolve();
  await settleResponse(page, response);
  await expect(page.locator('#notifBtn')).toHaveAttribute('aria-label', 'Notifications');
});

for (const source of ['Notifications', 'Accounts']) {
  for (const failure of [false, true]) {
    test(`${source} ${failure ? 'error' : 'result'} cannot overwrite a newer Settings dialog`, async ({ page }) => {
      await boot(page);
      await ui.enterRepositories(page);
      const path = source === 'Notifications' ? '**/api/notifications' : '**/api/accounts';
      const started = deferred();
      const release = deferred();
      await page.route(path, async route => {
        started.resolve();
        await release.promise;
        await route.fulfill({ status: failure ? 500 : 200, json: failure ? { error: 'Delayed failure' }
          : source === 'Notifications' ? unread : { accounts: [], active: 0 } });
      });
      await ui.button(page, new RegExp(`^${source}`)).click();
      await started.promise;
      await ui.dialog(page, source).getByRole('button', { name: 'Close dialog', exact: true }).click();
      await (await ui.action(page, 'Settings')).click();
      const settings = ui.dialog(page, 'Settings');
      await expect(ui.checkbox(settings, 'Animated nebula background')).toBeVisible();
      const response = page.waitForResponse(path);
      release.resolve();
      await settleResponse(page, response);
      await expect(ui.checkbox(settings, 'Animated nebula background')).toBeVisible();
      await expect(settings).not.toContainText('Delayed');
    });
  }
}

test('Settings opens before optional connection status finishes, and ignores its late result after close', async ({ page }) => {
  await boot(page);
  const started = deferred();
  const release = deferred();
  await page.route('**/api/github-app/status', async route => {
    started.resolve();
    await release.promise;
    await route.fulfill({ json: { enabled: true, connections: [] } });
  });
  await (await ui.action(page, 'Settings')).click();
  await started.promise;
  const settings = ui.dialog(page, 'Settings');
  await expect(ui.checkbox(settings, 'Animated nebula background')).toBeVisible();
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await ui.button(page, 'Accounts').click();
  await expect(ui.dialog(page, 'Accounts')).toBeVisible();
  const response = page.waitForResponse('**/api/github-app/status');
  release.resolve();
  await settleResponse(page, response);
  await expect(ui.dialog(page, 'Accounts')).toBeVisible();
  await expect(settings).toHaveCount(0);
});

test('mobile scroll effects obey the live Settings switch and system preference', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const art = page.locator('#page-overview .ov-core-art');
  const supports = await page.evaluate(() => CSS.supports('animation-timeline: view()'));
  await expect(art).toHaveCSS('animation-name', supports ? 'nv-drift' : 'none');
  await (await ui.action(page, 'Settings')).click();
  const settings = ui.dialog(page, 'Settings');
  await ui.checkbox(settings, 'Animated nebula background').uncheck();
  await ui.button(settings, 'Done').click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await expect(art).toHaveCSS('animation-name', 'none');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(art).toHaveCSS('transform', 'none');
  await page.reload();
  await expect(art).toHaveCSS('animation-name', 'none');
  await (await ui.action(page, 'Settings')).click();
  await ui.checkbox(settings, 'Animated nebula background').check();
  await ui.button(settings, 'Done').click();
  await expect(art).toHaveCSS('animation-name', supports ? 'nv-drift' : 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(art).toHaveCSS('animation-name', 'none');
});

test('overview shortcut opens the repository browser without replacing workbench shortcuts', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Control+k');
  await expect(ui.screen(page, 'repos')).toBeVisible();
  await ui.button(page, /^Open repository /).first().click();
  await expect(ui.screen(page, 'work')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(ui.palette(page)).toBeVisible();
});

for (const motion of [true, false]) {
  test(`keyboard palette selection stays dismissed with motion ${motion ? 'on' : 'off'}`, async ({ page }) => {
    await boot(page, motion);
    await ui.enterRepositories(page);
    await ui.button(page, /^Open repository /).first().click();
    await expect(ui.screen(page, 'work')).toBeVisible();
    const trigger = await ui.action(page, 'Command palette');
    const dock = page.getByRole('button', { name: 'Workspace actions', exact: true });
    const returnFocus = await dock.isVisible() ? dock : trigger;
    await trigger.focus();
    await page.keyboard.press('Enter');
    await ui.palette(page).fill('Settings');
    await page.keyboard.press('Enter');
    const settings = ui.dialog(page, 'Settings');
    await expect(settings).toBeVisible();
    // Enter must not activate the button that closePalette restores focus to.
    // Otherwise it reopens the palette behind Settings and its autofocus
    // steals the next keyboard action from the dialog.
    await expect(ui.palette(page)).toBeHidden();
    const disconnect = page.locator('[data-alpha-privacy-action="disconnect"]');
    await ui.focusAndConfirm(expect, disconnect);
    await page.keyboard.press('Tab');
    await expect.poll(() => settings.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(returnFocus).toBeFocused();
  });
}

test('a skipped native page transition still navigates without an unhandled rejection', async ({ page }) => {
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  await page.addInitScript(() => {
    const start = document.startViewTransition.bind(document);
    window.skippedTransitions = 0;
    document.startViewTransition = callback => {
      const transition = start(callback);
      transition.skipTransition();
      window.skippedTransitions++;
      return transition;
    };
  });
  await boot(page);
  await page.keyboard.press('Control+k');
  await expect(ui.screen(page, 'repos')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.skippedTransitions)).toBeGreaterThan(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(failures).toEqual([]);
});

test('each popup opening animates, including replacement and reopening during dismissal', async ({ page }) => {
  await page.addInitScript(() => {
    window.popupEntries = [];
    document.addEventListener('animationstart', event => {
      if (event.target.id === 'modal') window.popupEntries.push(event.animationName);
    });
  });
  await boot(page);
  await ui.button(page, 'Accounts').click();
  await expect.poll(() => page.evaluate(() => window.popupEntries.filter(name => name === 'modalIn').length)).toBe(1);
  await page.locator('#modal').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  await expect(page.locator('#modal')).toHaveCSS('opacity', '1');
  await page.evaluate(() => document.getElementById('notifBtn').click());
  await expect(ui.dialog(page, 'Notifications')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.popupEntries.filter(name => name === 'modalIn').length)).toBe(2);
  await page.locator('#modal').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  // Keyboard/programmatic invocations can share a frame. Exercise that actual
  // event path without mocking the overlay controller or its animations.
  await page.evaluate(() => {
    document.getElementById('modalClose').click();
    document.getElementById('accountBtnOv').click();
  });
  await expect.poll(() => page.evaluate(() => window.popupEntries.filter(name => name === 'modalIn').length)).toBe(3);
  await expect(ui.dialog(page, 'Accounts')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#modal')).toHaveCSS('animation-name', 'none');
});
