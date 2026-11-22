'use strict';

/*
 * Safeguards: the posture in three figures, this app's switches beside the
 * rules the provider enforces, the locked paths with presets that say how
 * many files they cover, and the recovery tools. In the hosted alpha the
 * global switches are the deployment's, so they are shown and not offered.
 *
 * It is a section of the workbench with its own address, not a dialog: a
 * lock redraws it in place, and Back returns to where the reader came from.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function openSafeguards(page) {
  await (await ui.action(page, 'Command palette')).click();
  await page.locator('#paletteInput').fill('Safeguards');
  await page.locator('.pal-item', { hasText: 'Safeguards' }).first().click();
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section).toBeVisible();
  await expect(page).toHaveURL(/#\/sandbox\/demo@main\/safeguards$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return section;
}

test('safeguards show the provider rules, lock paths by preset and unlock them', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  await expect(page.locator('#tab-audit')).toBeVisible();
  const dialog = await openSafeguards(page);
  await expect(page.locator('.tab[data-tab="safeguards"]')).toHaveClass(/active/);

  /* The provider's rules, read for a reader without administration: what rulesets show is on, the rest is unknown, never on. */
  const rules = dialog.locator('.sg-rule');
  await expect(rules).toHaveCount(8);
  await expect(rules.filter({ hasText: 'Pull request review before merging' })).toHaveAttribute('data-state', 'on');
  await expect(rules.filter({ hasText: 'Pull request review before merging' })).toContainText('1 approval');
  await expect(rules.filter({ hasText: 'Force pushes blocked' })).toHaveAttribute('data-state', 'on');
  await expect(rules.filter({ hasText: 'Signed commits required' })).toHaveAttribute('data-state', 'unknown');
  await expect(dialog).toContainText('Some rules need administration access to read');
  await expect(dialog.getByRole('link', { name: /Branch settings/ })).toHaveAttribute('href', 'https://github.com/sandbox/demo/settings/branches');
  await expect(dialog.locator('#sgStatRules')).toHaveText('4 of 8');
  /* No locks and no snapshot yet: the branch is guarded, the workspace not fully. */
  await expect(dialog.locator('#sgPostureWord')).toHaveText('Mostly guarded');

  /* The hosted alpha's global switches are shown as the deployment's, not offered. */
  await expect(dialog.getByRole('switch', { name: /Read-only mode/ })).toBeDisabled();
  await expect(dialog).toContainText('Set by the deployment in the hosted alpha');

  /* Presets say how many files they would cover, and lock in one tap. */
  const workflows = dialog.getByRole('button', { name: /CI workflows/ });
  await expect(workflows).toContainText('2');
  await expect(dialog.getByRole('button', { name: /Environment files/ })).toContainText('1');
  await workflows.click();
  const again = page.getByRole('region', { name: 'Safeguards' });
  await expect(again.locator('.sg-lock-row')).toHaveCount(1);
  await expect(again.locator('.sg-lock-row')).toContainText('.github/workflows/**');
  await expect(again.locator('.sg-lock-row')).toContainText('2 files');
  await expect(again.getByRole('button', { name: /CI workflows/ })).toBeDisabled();

  /* A typed pattern locks too; a root .env is covered by **\/.env* as the server reads it. */
  await again.getByRole('textbox', { name: 'Path or pattern to lock' }).fill('**/.env*');
  await again.getByRole('button', { name: 'Lock', exact: true }).click();
  const third = page.getByRole('region', { name: 'Safeguards' });
  await expect(third.locator('.sg-lock-row')).toHaveCount(2);
  await expect(third.locator('.sg-lock-row', { hasText: '**/.env*' })).toContainText('1 file');

  /* Unlocking removes it. */
  await third.getByRole('button', { name: 'Unlock .github/workflows/**' }).click();
  const fourth = page.getByRole('region', { name: 'Safeguards' });
  await expect(fourth.locator('.sg-lock-row')).toHaveCount(1);
  await expect(fourth.getByRole('button', { name: /CI workflows/ })).toBeEnabled();

  /* The recovery tools are tiles, and each opens its flow. */
  await expect(fourth.locator('.sg-tile')).toHaveCount(5);
  await expect(fourth.locator('#sgSnap')).toContainText('None taken yet');

  /* A section is a step in the history: Back returns to the audit it was opened from. */
  await page.goBack();
  await expect(page.locator('#tab-audit')).toBeVisible();
  await expect(page.locator('#tab-safeguards')).toBeHidden();
});

/*
 * Read-only takes New file away and gives it back. Turning read-only off once
 * cleared the page's read-only state and left New file disabled until the
 * page was loaded again.
 */
test('read-only turned off gives New file back', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let safety = { readOnly: true, freezeSync: false, protected: {}, globalControls: true };
  await page.route('**/api/safety', route => {
    if (route.request().method() === 'POST') safety = { ...safety, ...route.request().postDataJSON() };
    return route.fulfill({ json: safety });
  });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bread-only\b/);
  await expect(page.locator('#newFileBtn')).toBeDisabled();
  await page.locator('#sgReadOnly').uncheck();
  await expect(page.locator('body')).not.toHaveClass(/\bread-only\b/);
  await expect(page.locator('#newFileBtn')).toBeEnabled();
  await page.locator('#sgReadOnly').check();
  await expect(page.locator('#newFileBtn')).toBeDisabled();
});

/* A lock named with a quote is that lock: its Unlock is named for all of it, and carries nothing more. */
test('a lock named with a quote is unlocked by its whole name', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  const field = section.getByRole('textbox', { name: 'Path or pattern to lock' });
  await field.fill('docs/"draft" autofocus onfocus="x"');
  await field.press('Enter');
  await expect(section.locator('.sg-lock-row')).toHaveCount(1);
  /* Locked from the keyboard: the field keeps focus through the redraw, ready for the next. */
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
  const unlock = section.getByRole('button', { name: 'Unlock docs/"draft" autofocus onfocus="x"', exact: true });
  await expect(unlock).toBeVisible();
  await expect(unlock).not.toHaveAttribute('onfocus');
  await expect(unlock).not.toHaveAttribute('autofocus');
  await unlock.click();
  await expect(section.locator('.sg-lock-row')).toHaveCount(0);
});

/* Rules the screen cannot read are said as such; the posture is not left reading. */
test('rules without a list of controls are said as unreadable', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/repo/sandbox/demo/branch-protection**', route => route.fulfill({ json: { protected: true, sources: [] } }));
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section.locator('#sgRules')).toHaveText('The provider’s answer could not be read.');
  await expect(section.locator('#sgPostureWord')).toHaveText('Branch rules unread');
  await expect(section.locator('#sgStatRules')).toHaveText('—');
});

/*
 * A preset pressed from the keyboard is disabled once locked, and the browser
 * lets go of a disabled control's focus: it lands on the next preset, not
 * the page, and the reader carries on from there.
 */
test('locking a preset from the keyboard keeps focus on the presets', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  const workflows = section.getByRole('button', { name: /CI workflows/ });
  await expect(workflows).toContainText('2');
  await workflows.focus();
  await page.keyboard.press('Enter');
  await expect(section.locator('.sg-lock-row')).toHaveCount(1);
  await expect(section.getByRole('button', { name: /CI workflows/ })).toBeDisabled();
  await expect(section.getByRole('button', { name: /Environment files/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(section.locator('.sg-lock-row')).toHaveCount(2);
  await expect(section.getByRole('button', { name: /Keys and certificates/ })).toBeFocused();
});

/* The screen names the branch open and reads its rules: changed beneath it, or refreshed, it is drawn again. */
test('the branch changed or refreshed draws Safeguards for the branch open now', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/repo/sandbox/demo', route => route.fulfill({ json: {
    full_name: 'sandbox/demo', private: true, default_branch: 'main',
    branches: [{ name: 'main', protected: true, sha: 'a'.repeat(40) }, { name: 'dev', protected: false, sha: 'b'.repeat(40) }]
  } }));
  const asked = [];
  await page.route('**/api/repo/sandbox/demo/branch-protection**', route => {
    const branch = new URL(route.request().url()).searchParams.get('branch');
    asked.push(branch);
    return route.fulfill({ json: {
      provider: 'github', branch, protected: branch === 'main', access: 'full', sources: branch === 'main' ? ['branch protection'] : [],
      controls: [{ id: 'review', label: 'Pull request review before merging', state: branch === 'main' ? 'on' : 'off' }], enforced: branch === 'main' ? 1 : 0, known: 1,
      settingsUrl: 'https://github.com/sandbox/demo/settings/branches'
    } });
  });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section.locator('#sgStatRules')).toHaveText('1 of 1');
  await page.locator('#branchSelect').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event('change')); }, 'dev');
  await expect(section.locator('.sg-posture-sub')).toHaveText('sandbox/demo · dev');
  await expect(section.locator('#sgPostureWord')).toHaveText('Unprotected branch');
  await expect(section.locator('#sgStatRules')).toHaveText('0 of 1');
  expect(asked).toEqual(['main', 'dev']);
  await page.locator('#syncBtn').click();
  await expect.poll(() => asked.length).toBe(3);
  expect(asked[2]).toBe('dev');
  await expect(section.locator('#sgStatRules')).toHaveText('0 of 1');
});

/*
 * The palette and Safeguards share one file list. A list that could not be
 * read was once kept as an empty repository, and Safeguards then counted
 * every lock and preset as covering no file.
 */
test('a file list that could not be read is asked again, not counted as none', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let reads = 0;
  await page.route('**/api/repo/sandbox/demo/files**', route => {
    reads += 1;
    return reads === 1 ? route.fulfill({ status: 503, json: { error: 'The provider is unavailable', code: 'PROVIDER_UNAVAILABLE' } }) : route.fallback();
  });
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#tab-editor')).toBeVisible();
  const section = await openSafeguards(page);
  await expect(section.locator('#sgFilesNote')).toHaveText('7 files on main');
  await expect(section.getByRole('button', { name: /CI workflows/ })).toContainText('2');
  expect(reads).toBe(2);
});

/* A preset the server refuses is given back, with the focus the browser took from it when it was disabled. */
test('a refused preset is given back with its focus', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/safety', route => {
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    if (body && body.protect && body.protect.path === '**/yarn.lock') {
      return route.fulfill({ status: 413, json: { error: 'Up to 100 protected paths or patterns per repository', code: 'SAFETY_INPUT_INVALID' } });
    }
    return route.fallback();
  });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  const lockfiles = section.getByRole('button', { name: /Lockfiles/ });
  await expect(lockfiles).toBeEnabled();
  await lockfiles.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast', { hasText: 'Up to 100 protected paths or patterns per repository' })).toBeVisible();
  await expect(lockfiles).toBeEnabled();
  await expect(lockfiles).toBeFocused();
});

/*
 * Another repository opened onto Safeguards: the last one's screen is gone
 * at once, not left showing its name, locks and rules while the new one's
 * are read.
 */
test('another repository opens onto its own Safeguards, never the last one\u2019s', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(/\/api\/repo\/sandbox\/other(\/.*)?(\?.*)?$/, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/repo/sandbox/other') return route.fulfill({ json: { full_name: 'sandbox/other', private: false, default_branch: 'main', homepage: '', branches: [{ name: 'main', protected: false, sha: 'd'.repeat(40) }] } });
    if (pathname.endsWith('/tree')) return route.fulfill({ json: [] });
    if (pathname.endsWith('/files')) return route.fulfill({ json: { files: ['README.md'] } });
    if (pathname.endsWith('/branch-protection')) return route.fulfill({ json: { provider: 'github', branch: 'main', protected: false, access: 'full', sources: [], controls: [], enforced: 0, known: 0, settingsUrl: null } });
    return route.fulfill({ json: {} });
  });
  let release = null;
  let holding = false;
  await page.route('**/api/safety', async route => {
    if (holding && route.request().method() === 'GET') { holding = false; await new Promise(resolve => { release = resolve; }); }
    return route.fallback();
  });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section.locator('.sg-posture-sub')).toHaveText('sandbox/demo \u00b7 main');
  holding = true;
  await page.evaluate(() => { location.hash = '#/sandbox/other@main/safeguards'; });
  await expect.poll(() => release !== null).toBe(true);
  await expect(page.locator('#safeguardsRoot')).not.toContainText('sandbox/demo');
  release();
  await expect(section.locator('.sg-posture-sub')).toHaveText('sandbox/other \u00b7 main');
  await expect(section.locator('#sgPostureWord')).toHaveText('Unprotected branch');
  await expect(section.locator('#sgFilesNote')).toHaveText('1 file on main');
});

/* The last snapshot this browser kept for the repository is named on its tile and in the posture's figures. */
test('the last snapshot kept is named with its age', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.addInitScript(() => {
    localStorage.setItem('nv_snap_sandbox/demo', JSON.stringify({ repo: 'demo', capturedAt: new Date(Date.now() - 5 * 60000).toISOString() }));
  });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section.locator('#sgSnap')).toContainText('Last 5m ago');
  await expect(section.locator('.sg-stats')).toContainText('5m ago');
});

/* Each recovery tile names the capability that gates it: one held back is not drawn, and the rest are. */
test('a tile whose capability is held back is not drawn', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', demote: ['governance'] });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section.locator('#sgSnap')).toBeVisible();
  await expect(section.locator('#sgScan')).toBeVisible();
  await expect(section.locator('#sgActivity')).toBeHidden();
  await expect(section.locator('#sgEvidence')).toBeHidden();
  await expect(section.getByRole('button', { name: /Export (activity|evidence)/ })).toHaveCount(0);
});
