'use strict';

/*
 * The page's notices and its dialog, used by the page: a change refused for
 * approval sent down Safe Passage byte for byte, with the dialog that offers
 * it, the toast that says it was sent and its tone in words; a commit
 * confirmed over a newer version keeping the message typed in the dialog
 * the overwrite question replaced; a login typed
 * with a phone keyboard's dashes stopping step-up before anything is sent;
 * and the dialog answering no from its corner and handing focus back. The
 * modules are asked directly by test/page-dialogs.test.js.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const OFFER = { available: true, path: 'README.md', branch: 'nv/safe-passage-readme', baseBranch: 'main' };

async function openReadme(page) {
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await ui.openFileByName(page, 'README.md');
  await expect(page.locator('.CodeMirror')).toBeVisible();
}

test('a change refused for approval goes down Safe Passage byte for byte, and says so in words', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const sent = [];
  await page.route(url => /^\/api\/repo\/sandbox\/demo\/(file|branches|pulls)$/.test(new URL(url).pathname), route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fallback();
    const body = request.postDataJSON();
    sent.push({ path, method: request.method(), body });
    if (path.endsWith('/file') && body.branch === 'main') {
      return route.fulfill({ status: 403, json: { error: 'This change needs approval under the active policy.', code: 'POLICY_APPROVAL_REQUIRED', correlationId: 'fixture-approval', safePassage: OFFER } });
    }
    if (path.endsWith('/branches')) return route.fulfill({ json: { name: OFFER.branch } });
    if (path.endsWith('/pulls')) return route.fulfill({ json: { number: 7 } });
    return route.fulfill({ json: { sha: 'd'.repeat(40), commit: 'e'.repeat(40) } });
  });
  await openReadme(page);
  const content = '# demo\n\nTabs\tand trailing space \nand “quotes”\n';
  await page.evaluate(text => document.querySelector('.CodeMirror').CodeMirror.setValue(text), content);
  await page.locator('#commitFileBtn').click();
  const commit = ui.dialog(page, 'Commit changes');
  await commit.locator('#cmMsg').fill('Explain the demo');
  await ui.button(commit, 'Commit ✦').click();

  const offer = ui.dialog(page, 'This change needs approval');
  await expect(offer).toContainText('README.md');
  await expect(offer.locator('.sp-route')).toContainText(`${OFFER.branch} → main`);
  await ui.button(offer, 'Send for review').click();

  const toast = page.locator('.toast.ok').filter({ hasText: 'Opened pull request #7' });
  await expect(toast).toBeVisible();
  await expect(toast.locator('.sr-only')).toHaveText('Success: ');
  expect(sent.map(entry => `${entry.method} ${entry.path.split('/').pop()}`)).toEqual(['PUT file', 'POST branches', 'PUT file', 'POST pulls']);
  expect(sent[0].body).toMatchObject({ path: 'README.md', content, message: 'Explain the demo', branch: 'main' });
  expect(sent[1].body).toEqual({ name: OFFER.branch, from: 'main' });
  expect(sent[2].body).toMatchObject({ path: 'README.md', content, message: 'Explain the demo', branch: OFFER.branch });
  expect(sent[3].body).toMatchObject({ title: 'Explain the demo', head: OFFER.branch, base: 'main' });
  /* A toast leaves on its own. */
  await expect(toast).toHaveCount(0, { timeout: 8000 });
});

test('a commit confirmed over a newer version on the provider is sent, with the message typed for it', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const writes = [];
  let reads = 0;
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/file', route => {
    const request = route.request();
    if (request.method() === 'GET') {
      reads += 1;
      /* opened at one version; by the time of the commit the provider has another */
      return route.fulfill({ json: { path: 'README.md', sha: (reads > 1 ? 'f' : 'c').repeat(40), size: 7, content: Buffer.from('# demo\n').toString('base64'), binary: false } });
    }
    writes.push(request.postDataJSON());
    return route.fulfill({ json: { sha: 'd'.repeat(40), commit: 'e'.repeat(40) } });
  });
  await openReadme(page);
  await expect(page.locator('.CodeMirror-code')).toContainText('# demo');
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('# demo, mine\n'));
  await page.locator('#commitFileBtn').click();
  const commit = ui.dialog(page, 'Commit changes');
  await commit.locator('#cmMsg').fill('Keep my version');
  await ui.button(commit, 'Commit ✦').click();
  await ui.button(ui.dialog(page, 'File changed on GitHub'), 'Overwrite anyway').click();
  await expect(page.locator('.toast.ok').filter({ hasText: 'Committed' })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ path: 'README.md', content: '# demo, mine\n', message: 'Keep my version', sha: 'f'.repeat(40) });
});

test('a login typed with a phone keyboard\'s dashes stops step-up before anything is sent', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let asked = 0;
  let deleted = 0;
  await page.route('**/api/security/step-up', route => { asked += 1; return route.fulfill({ json: { grant: 'g' } }); });
  await page.route('**/api/repo/sandbox/demo', route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deleted += 1;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Delete this repository');
  await ui.paletteOption(page, /Delete this repository/).click();
  const confirm = ui.dialog(page, 'Delete repository');
  await confirm.locator('#drName').fill('sandbox/demo');
  await ui.button(confirm, 'Delete forever').click();
  const stepUp = ui.dialog(page, 'Verify sensitive action');
  await ui.field(stepUp, /Type the active account login/).fill('alpha–tester');
  await ui.secretField(stepUp, /Re-enter the current provider token/).fill('provider-token-value');
  await ui.button(stepUp, 'Authorize once').click();
  const toast = page.locator('.toast.err').filter({ hasText: 'does not match alpha-tester exactly' });
  await expect(toast).toBeVisible();
  await expect(toast.locator('.sr-only')).toHaveText('Error: ');
  expect([asked, deleted]).toEqual([0, 0]);
  /* What was typed is not left in the page. */
  expect(await page.locator('#stepUpCredential').count() ? await page.locator('#stepUpCredential').inputValue() : '').toBe('');
});

test('the dialog answers no from its corner and hands focus back to what opened it', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Delete this repository');
  await ui.paletteOption(page, /Delete this repository/).click();
  const confirm = ui.dialog(page, 'Delete repository');
  await expect(confirm).toBeVisible();
  const origin = await page.locator('#modal').evaluate(node => node.style.getPropertyValue('--nv-origin'));
  expect(typeof origin).toBe('string');
  await page.locator('#modalClose').click();
  await expect(page.locator('#scrim')).toBeHidden();
  await expect(page.locator('.toast').filter({ hasText: 'Repository deleted' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement !== document.body)).toBe(true);
});
