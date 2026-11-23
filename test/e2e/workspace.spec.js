'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * The workspace read again. Refresh reads the tool open -- Exposure's
 * findings, the audit's history -- and says so only once it has; another
 * branch, chosen or created, draws again the tools that belong to a branch,
 * so none is left showing the last branch's reading under the new one's name.
 */

/* The sandbox with a second branch, and branch rules read for whichever is asked. */
async function twoBranches(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/repo/sandbox/demo', route => route.fulfill({ json: {
    full_name: 'sandbox/demo', private: true, default_branch: 'main',
    branches: [{ name: 'main', protected: true, sha: 'a'.repeat(40) }, { name: 'dev', protected: false, sha: 'b'.repeat(40) }]
  } }));
  await page.route('**/api/repo/sandbox/demo/branch-protection**', route => {
    const branch = new URL(route.request().url()).searchParams.get('branch');
    return route.fulfill({ json: { provider: 'github', branch, protected: branch === 'main', access: 'full', sources: [], controls: [], enforced: 0, known: 0, settingsUrl: null } });
  });
}
const choose = (page, branch) => page.locator('#branchSelect').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event('change')); }, branch);

test('another branch chosen on the audit draws that branch’s audit, not the last one’s grade', async ({ page }) => {
  await twoBranches(page);
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade F/, { timeout: 15000 });
  await choose(page, 'dev');
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', 'Not audited');
  await choose(page, 'main');
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade F/);
});

test('Refresh reads the audit’s history again', async ({ page }) => {
  await twoBranches(page);
  const asked = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/repo/sandbox/demo/code-audit/history') asked.push(new URL(request.url()).searchParams.get('ref')); });
  await page.goto('/#/sandbox/demo@main/audit');
  await expect(page.locator('#tab-audit .audit-grade')).toHaveAttribute('aria-label', 'Not audited');
  await expect.poll(() => asked.length).toBe(1);
  await page.locator('#syncBtn').click();
  await expect(page.locator('.toast', { hasText: 'Refreshed' })).toBeVisible();
  await expect.poll(() => asked).toEqual(['main', 'main']);
});

test('Exposure’s findings that could not be loaded are read again by Refresh, as the screen says', async ({ page }) => {
  await twoBranches(page);
  let findings = 0;
  await page.route('**/api/repo/sandbox/demo/exposure/**', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('/exposure/findings')) {
      findings += 1;
      return findings === 1 ? route.abort('failed') : route.fulfill({ json: { findings: [], verifications: {}, probes: {} } });
    }
    if (pathname.endsWith('/exposure/scans')) return route.fulfill({ json: { scans: [] } });
    return route.fallback();
  });
  await page.goto('/#/sandbox/demo@main/exposure');
  const pane = page.locator('#tab-exposure');
  await expect(pane).toContainText('Findings could not be loaded for this repository. Refresh to try again.');
  await page.locator('#syncBtn').click();
  await expect.poll(() => findings).toBe(2);
  await expect(pane).not.toContainText('Findings could not be loaded');
});

test('a branch created on Safeguards is the branch Safeguards then shows', async ({ page }) => {
  await twoBranches(page);
  await page.route('**/api/repo/sandbox/demo/branches', route => route.fulfill({ status: 201, json: { name: 'feature/x', sha: 'a'.repeat(40) } }));
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section.locator('.sg-posture-sub')).toHaveText('sandbox/demo · main');
  await page.locator('#newBranchBtn').evaluate(button => button.click());
  await page.locator('#nbName').fill('feature/x');
  await page.locator('#modalOk').click();
  await expect(page.locator('.toast', { hasText: 'Branch feature/x created' })).toBeVisible();
  await expect(section.locator('.sg-posture-sub')).toHaveText('sandbox/demo · feature/x');
  await expect(section.locator('#sgPostureWord')).toHaveText('Unprotected branch');
});

test('another branch chosen on the Neural map reads the map for that branch', async ({ page }) => {
  await twoBranches(page);
  const refs = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/repo/sandbox/demo/activity' && url.searchParams.get('ref')) refs.push(url.searchParams.get('ref'));
  });
  await page.goto('/#/sandbox/demo@main/neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => refs).toEqual(['main']);
  await choose(page, 'dev');
  await expect.poll(() => refs).toEqual(['main', 'dev']);
});
