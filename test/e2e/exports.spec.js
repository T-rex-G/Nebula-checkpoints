'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * The activity and evidence exports and the security scan, from the
 * Safeguards screen. Each belongs to the repository -- and the scan to the
 * branch -- it was asked of: answered after another was opened, nothing of it
 * is shown over the one open now, and the evidence package is named for the
 * repository it holds.
 */

const at = (repo, name) => url => new URL(url).pathname === `/api/repo/sandbox/${repo}/${name}`;
const section = page => page.getByRole('region', { name: 'Safeguards' });

/* An answer held until the test lets it go, so the moment between asking and answering is observable. */
async function hold(page, matches, answer) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = { asked: false };
  await page.route(matches, async route => { seen.asked = true; await gate; return answer(route); });
  return { release: () => release(), asked: () => seen.asked };
}

/* A second repository, answered at once. */
async function otherRepository(page) {
  await page.route(/\/api\/repo\/sandbox\/other(\/.*)?(\?.*)?$/, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/repo/sandbox/other') return route.fulfill({ json: { full_name: 'sandbox/other', private: false, default_branch: 'main', homepage: '', branches: [{ name: 'main', protected: false, sha: 'd'.repeat(40) }] } });
    if (pathname.endsWith('/tree')) return route.fulfill({ json: [] });
    if (pathname.endsWith('/files')) return route.fulfill({ json: { files: [] } });
    if (pathname.endsWith('/branch-protection')) return route.fulfill({ json: { provider: 'github', branch: 'main', protected: false, access: 'full', sources: [], controls: [], enforced: 0, known: 0, settingsUrl: null } });
    return route.fulfill({ json: {} });
  });
}

/* Every title a dialog is opened with, in order. */
async function watchDialogs(page) {
  await page.evaluate(() => {
    window.__dialogTitles = [];
    const title = document.querySelector('#modalTitle');
    new MutationObserver(() => window.__dialogTitles.push(title.textContent)).observe(title, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => window.__dialogTitles);
}

async function openOther(page) {
  await page.evaluate(() => { location.hash = '#/sandbox/other@main/safeguards'; });
  await expect(section(page).locator('.sg-posture-sub')).toHaveText('sandbox/other · main');
}

test('evidence answered after another repository was opened is named for its own and not described over the other', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await otherRepository(page);
  const evidence = await hold(page, at('demo', 'evidence'), route => route.fulfill({ json: { generatedAt: '2026-11-21T08:00:00Z', events: [{ id: 'e1' }], snapshots: [], chain: { available: true, valid: true } } }));
  await page.goto('/#/sandbox/demo@main/safeguards');
  await expect(section(page).locator('.sg-posture-sub')).toHaveText('sandbox/demo · main');
  const titles = await watchDialogs(page);
  await section(page).locator('#sgEvidence').click();
  await expect.poll(() => evidence.asked()).toBe(true);
  await openOther(page);
  const download = page.waitForEvent('download');
  evidence.release();
  expect((await download).suggestedFilename()).toBe('demo-evidence-2026-11-21.json');
  await expect(page.locator('#scrim')).toBeHidden();
  expect(await titles()).toEqual([]);
});

test('activity answered after another repository was opened is not shown over the other, which exports its own', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await otherRepository(page);
  await page.route(at('demo', 'intelligence/events'), route => route.fulfill({ json: { available: true, events: [], hasMore: false } }));
  const activity = await hold(page, at('demo', 'activity'), route => route.fulfill({ json: { owner: 'sandbox', repo: 'demo', days: 30, commits: [{ sha: 'a'.repeat(40), message: 'Demo only', author: 'ada' }], pulls: [], issues: [], releases: [] } }));
  await page.goto('/#/sandbox/demo@main/safeguards');
  await expect(section(page).locator('.sg-posture-sub')).toHaveText('sandbox/demo · main');
  const titles = await watchDialogs(page);
  await section(page).locator('#sgActivity').click();
  await expect.poll(() => activity.asked()).toBe(true);
  await openOther(page);
  const answered = page.waitForResponse(response => at('demo', 'activity')(response.url()));
  activity.release();
  await (await answered).finished();
  /* The other repository's own export, whose answer carries none of its lists, is counted as none. */
  await section(page).locator('#sgActivity').click({ timeout: 5000 });
  await expect(page.locator('#modalTitle')).toHaveText('Activity export ready');
  await expect(page.locator('#modal')).toContainText('0 commits · 0 PRs · 0 issues · 0 releases · 0 verified event(s).');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Markdown' }).click();
  expect((await download).suggestedFilename()).toBe(`other-activity-${new Date().toISOString().slice(0, 10)}.md`);
  expect(await titles()).toEqual(['Activity export ready']);
});

test('a scan answered after another branch was opened is not shown there; the scan of the branch open is', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/repo/sandbox/demo', route => route.fulfill({ json: {
    full_name: 'sandbox/demo', private: true, default_branch: 'main',
    branches: [{ name: 'main', protected: true, sha: 'a'.repeat(40) }, { name: 'dev', protected: false, sha: 'b'.repeat(40) }]
  } }));
  await page.route('**/api/repo/sandbox/demo/branch-protection**', route => {
    const branch = new URL(route.request().url()).searchParams.get('branch');
    return route.fulfill({ json: { provider: 'github', branch, protected: false, access: 'full', sources: [], controls: [], enforced: 0, known: 0, settingsUrl: null } });
  });
  const refs = [];
  const clean = { scanned: 1, sources: [{ file: 'package-lock.json' }], vulnerable: [], details: {}, osv: { available: true }, dependabot: { available: false, alerts: [] } };
  /* The branch's own answer; main's, registered after, is answered first and held. */
  await page.route(url => at('demo', 'audit-deps')(url), route => { refs.push(new URL(route.request().url()).searchParams.get('ref')); return route.fulfill({ json: clean }); });
  const onMain = await hold(page, url => at('demo', 'audit-deps')(url) && new URL(url).searchParams.get('ref') === 'main', route => route.fulfill({ json: {
    ...clean, vulnerable: [{ name: 'left-pad', version: '1.0.0', ecosystem: 'npm', ids: ['GHSA-main'] }]
  } }));
  await page.goto('/#/sandbox/demo@main/safeguards');
  await expect(section(page).locator('.sg-posture-sub')).toHaveText('sandbox/demo · main');
  const titles = await watchDialogs(page);
  await section(page).locator('#sgScan').click();
  await expect.poll(() => onMain.asked()).toBe(true);
  await page.locator('#branchSelect').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event('change')); }, 'dev');
  await expect(section(page).locator('.sg-posture-sub')).toHaveText('sandbox/demo · dev');
  const answered = page.waitForResponse(response => at('demo', 'audit-deps')(response.url()));
  onMain.release();
  await (await answered).finished();
  await section(page).locator('#sgScan').click({ timeout: 5000 });
  await expect(page.locator('#modalTitle')).toHaveText('No known vulnerabilities');
  await expect(page.locator('#modal')).not.toContainText('left-pad');
  expect(refs).toEqual(['dev']);
  expect(await titles()).toEqual(['No known vulnerabilities']);
});

test('evidence that cannot be built is presented, and a scan that fails is said', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(at('demo', 'evidence'), route => route.fulfill({ status: 503, json: { error: 'Signed snapshots require the existing Neon DATABASE_URL' } }));
  await page.route(url => at('demo', 'audit-deps')(url), route => route.fulfill({ status: 404, json: { error: 'Not Found' } }));
  await page.goto('/#/sandbox/demo@main/safeguards');
  await expect(section(page).locator('.sg-posture-sub')).toHaveText('sandbox/demo · main');
  await section(page).locator('#sgEvidence').click();
  await expect(page.locator('#trustErrorBackdrop')).toContainText('Signed snapshots require the existing Neon DATABASE_URL');
  await page.keyboard.press('Escape');
  await expect(page.locator('#trustErrorBackdrop')).toHaveCount(0);
  await section(page).locator('#sgScan').click();
  await expect(page.locator('.toast.err', { hasText: 'Not Found' })).toBeVisible();
  await expect(page.locator('#scrim')).toBeHidden();
});
