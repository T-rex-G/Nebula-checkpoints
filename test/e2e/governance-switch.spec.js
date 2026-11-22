'use strict';

/*
 * Governance answers belong to the repository they were asked for. A reader
 * who opens another repository while the last one's governance is still on
 * its way must never see that answer on the new one's screen: not its
 * delivery evidence or archived policies, not its failure, not its chain
 * verification.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

function held() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release: () => release() };
}

/* A second repository, sandbox/other, with no archived policies and no signed exports; the rest of its governance is the fixture's. */
async function otherRepository(page) {
  await page.route(/\/api\/repo\/sandbox\/other(\/.*)?(\?.*)?$/, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/repo/sandbox/other') {
      return route.fulfill({ json: { full_name: 'sandbox/other', private: false, default_branch: 'main', homepage: '', permission: 'admin', branches: [{ name: 'main', protected: false, sha: 'd'.repeat(40) }] } });
    }
    if (pathname.endsWith('/governance/archive')) return route.fulfill({ json: { policies: [] } });
    if (pathname.endsWith('/governance/exports') && route.request().method() === 'GET') return route.fulfill({ json: { exports: [] } });
    if (pathname.includes('/governance/')) return route.fallback();
    if (pathname.endsWith('/tree')) return route.fulfill({ json: [] });
    if (pathname.endsWith('/files')) return route.fulfill({ json: { files: [] } });
    return route.fulfill({ json: {} });
  });
}

/* Opens sandbox/other's governance and waits until it has read everything it asks for. */
async function switchToOther(page) {
  const archived = page.waitForResponse(/\/api\/repo\/sandbox\/other\/governance\/archive$/);
  await page.evaluate(() => { location.hash = '#/sandbox/other@main/governance'; });
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/other');
  await archived;
  await expect(page.locator('#govRoot [data-gov-action="deactivate-policy"]').first()).toBeVisible();
}

/* Two frames, so anything an answer just written would draw has been drawn. */
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('delivery evidence and archived policies read for the last repository never land on the next one', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', governance: 'populated' });
  await otherRepository(page);
  const gate = held();
  await page.route(/\/api\/repo\/sandbox\/demo\/governance\/(archive|exports)(\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await gate.promise;
    return route.fallback();
  });
  const asked = page.waitForRequest(/\/api\/repo\/sandbox\/demo\/governance\/archive$/);
  await page.goto('/#/sandbox/demo@main/governance');
  await asked;
  await switchToOther(page);
  expect(await page.locator('#govRoot .gov-archived').count()).toBe(0);
  expect(await page.locator('#govRoot [data-gov-action="download-export"]').count()).toBe(0);

  const landed = Promise.all([
    page.waitForResponse(/\/api\/repo\/sandbox\/demo\/governance\/archive$/),
    page.waitForResponse(/\/api\/repo\/sandbox\/demo\/governance\/exports(\?.*)?$/)
  ]);
  gate.release();
  await landed;
  await settle(page);
  expect(await page.locator('#govRoot .gov-archived').count(), 'the last repository\'s archived policies').toBe(0);
  expect(await page.locator('#govRoot [data-gov-action="download-export"]').count(), 'the last repository\'s signed exports').toBe(0);
  await expect(page.locator('#govRoot [data-gov-action="deactivate-policy"]').first()).toBeVisible();
});

test('a Policy Digital Twin that could not be read for the last repository is not said on the next one', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', governance: 'populated' });
  await otherRepository(page);
  const gate = held();
  await page.route(/\/api\/repo\/sandbox\/demo\/governance\/digital-twin(\?.*)?$/, async route => {
    await gate.promise;
    return route.fulfill({ status: 503, json: { error: 'The demo twin could not be read.', code: 'OPERATION_FAILED' } });
  });
  const asked = page.waitForRequest(/\/api\/repo\/sandbox\/demo\/governance\/digital-twin/);
  await page.goto('/#/sandbox/demo@main/governance');
  await asked;
  await switchToOther(page);

  const landed = page.waitForResponse(/\/api\/repo\/sandbox\/demo\/governance\/digital-twin/);
  gate.release();
  await landed;
  await settle(page);
  expect(await page.locator('#govRoot').textContent()).not.toContain('The demo twin could not be read.');
  expect(await page.locator('#govLive').textContent()).not.toContain('The demo twin could not be read.');
  await expect(page.locator('#govRoot [data-gov-action="deactivate-policy"]').first()).toBeVisible();
});

test('a decision chain verified for the last repository is not shown as the next one\'s', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', governance: 'populated' });
  await otherRepository(page);
  const gate = held();
  await page.route(/\/api\/repo\/sandbox\/demo\/governance\/decisions\/verify(\?.*)?$/, async route => {
    await gate.promise;
    return route.fulfill({ json: { verification: { valid: true, complete: true, checked: 9 } } });
  });
  await page.goto('/#/sandbox/demo@main/governance');
  await expect(page.locator('#govRoot [data-gov-action="verify-chain"]')).toBeVisible();
  const asked = page.waitForRequest(/\/api\/repo\/sandbox\/demo\/governance\/decisions\/verify/);
  await page.locator('#govRoot [data-gov-action="verify-chain"]').click();
  await asked;
  await switchToOther(page);

  const landed = page.waitForResponse(/\/api\/repo\/sandbox\/demo\/governance\/decisions\/verify/);
  gate.release();
  await landed;
  await settle(page);
  expect(await page.locator('#govRoot').textContent()).not.toContain('Decision chain verified');
  await expect(page.locator('#govRoot [data-gov-action="verify-chain"]')).toHaveText('Verify chain');
});

/*
 * A dialog belongs to the repository it was opened on. A reader who opens
 * another repository while it is showing -- the browser's back button, an
 * address typed -- and then confirms it sends nothing: not to the repository
 * the dialog was for, and not to the one open now.
 */
test('a dialog confirmed after another repository was opened sends nothing to either, and says why', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', governance: 'populated' });
  await otherRepository(page);
  const created = [];
  await page.route(/\/api\/repo\/sandbox\/(demo|other)\/governance\/policies$/, route => {
    if (route.request().method() !== 'POST') return route.fallback();
    created.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 201, json: { policy: { policyId: 'p-new' } } });
  });
  await page.goto('/#/sandbox/demo@main/governance');
  const create = page.locator('#govRoot [data-gov-action="create-policy"]');
  await expect(create).toBeVisible();
  await create.click();
  await page.locator('#govPolicyKey').fill('release-safety');
  await page.locator('#govPolicyName').fill('Release safety');
  await switchToOther(page);
  await page.locator('#modalOk').click();
  await expect(page.locator('.toast').last()).toBeVisible();
  expect(created, 'nothing is sent, to either repository').toEqual([]);
  await expect(page.locator('.toast').last()).toContainText('Another repository was opened, so nothing more was sent for the last one.');
});

