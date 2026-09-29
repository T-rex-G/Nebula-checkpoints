'use strict';

/*
 * Any repository the account can read, not only its own. A pasted address or
 * owner/name opens it -- from the inventory's filter or from the picker a
 * security tool raises -- and somebody else's repository opens read-only: it
 * is browsed, audited and scanned, nothing that would change it is offered,
 * and what belongs to its collaborators asks for one of the reader's own.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { enterRepositories } = require('./semantic');

test.use({ serviceWorkers: 'block' });

/* The rail is standing chrome on a desk and a drawer on a phone. */
async function rail(page, name) {
  const item = page.locator(`#navRail [data-rail="${name}"]`);
  if (!(await item.isVisible())) await page.locator('.page.active .nav-menu-btn').click();
  await item.click();
}

async function signedIn(page) {
  const state = await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await enterRepositories(page);
  await expect(page.locator('#repoGrid .repo-card')).toHaveCount(1);
  return state;
}

test('a pasted address opens somebody else’s repository read-only, and it audits', async ({ page, isMobile }) => {
  const state = await signedIn(page);
  const filter = page.locator('#repoFilter');
  await expect(filter).toHaveAttribute('placeholder', 'Filter, or paste any public repository…');

  /* An address inside the repository -- a file on a branch -- names the repository. */
  await filter.fill('https://github.com/octo/spoon-knife/blob/main/README.md');
  const card = page.locator('#repoOpenAny');
  await expect(card).toBeVisible();
  await expect(card.locator('#repoOpenAnyName')).toHaveText('octo/spoon-knife');
  await expect(card.locator('#repoOpenAnySub')).toHaveText('Open from github.com — read-only unless you can push to it');
  await expect(page.locator('#repoGrid .repo-card').first()).toBeHidden();

  await filter.press('Enter');
  await page.locator('#page-work.active').waitFor();

  /* The provider's spelling of the name, and a badge that says what the account may do. */
  await expect(page.locator('#workRepoName')).toHaveText('Octo/Spoon-Knife');
  await expect(page.locator('#workVisitorBadge')).toBeVisible();
  await expect(page.locator('#workVisitorBadge')).toHaveAttribute('title', 'You can read this repository but not change it');
  /* An empty branch is described, not offered to be filled. */
  await expect(page.locator('.editor-empty-visitor')).toBeVisible();
  await expect(page.locator('.editor-empty-bare')).toBeHidden();
  await expect(page.locator('#workPrivateBadge')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/repo-visitor/);

  /* Nothing that would change it, and nothing its collaborators share. */
  for (const id of ['#newFileBtn', '#newBranchBtn', '#commitFileBtn', '#stagedBtn']) await expect(page.locator(id)).toBeHidden();
  for (const tab of ['upload', 'governance', 'safeguards']) await expect(page.locator(`.tab[data-tab="${tab}"]`)).toBeHidden();
  if (isMobile) {
    /* A phone reaches the tabs through the bottom bar and its sheet: the same things are put away there. */
    await expect(page.locator('#bottomNav button[data-nav="upload"]')).toBeHidden();
    await page.locator('#bottomNav button[data-nav="more"]').click();
    for (const act of ['governance', 'safeguards', 'branches', 'delrepo']) await expect(page.locator(`.sheet-item[data-act="${act}"]`)).toBeHidden();
    for (const act of ['exposure', 'audit', 'neural', 'issues']) await expect(page.locator(`.sheet-item[data-act="${act}"]`)).toBeVisible();
    await page.locator('.sheet-item[data-act="audit"]').click();
  } else {
    for (const tab of ['editor', 'commits', 'exposure', 'audit']) await expect(page.locator(`.tab[data-tab="${tab}"]`)).toBeVisible();
    await page.locator('.tab[data-tab="audit"]').click();
  }

  /* The audit runs as it does on the reader's own, under the provider's spelling. */
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade [A-F], \d+ out of 100$/, { timeout: 15000 });
  expect(state.visitRequests).toContain('GET /api/repo/Octo/Spoon-Knife/code-audit');
  expect(state.visitRequests.some(entry => entry.startsWith('GET /api/repo/Octo/Spoon-Knife/code-audit/history'))).toBe(true);
  expect(state.mutationRequests).toEqual([]);

  /* A deep link to a collaborator's tab lands in the editor, not on a hidden pane. */
  await page.evaluate(() => { location.hash = '#/Octo/Spoon-Knife@main/governance'; });
  await expect(page.locator('.tab[data-tab="editor"]')).toHaveClass(/active/);
});

test('with somebody else’s repository open, Governance and Safeguards ask which of yours', async ({ page }) => {
  await signedIn(page);
  await page.locator('#repoFilter').fill('octo/spoon-knife');
  await page.locator('#repoOpenAnyBtn').click();
  await expect(page.locator('#workVisitorBadge')).toBeVisible();

  await rail(page, 'governance');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const query = dialog.locator('#rpPickQuery');
  await expect(query).toHaveAttribute('placeholder', 'Search your repositories');
  /* Your own only: an address is a search here, not a way in. */
  await query.fill('https://github.com/octo/spoon-knife');
  await expect(dialog.locator('.rp-pick-group', { hasText: 'Any repository' })).toHaveCount(0);
  await query.fill('');
  /* The repository just visited is not among yours. */
  await expect(dialog.locator('.rp-pick-item', { hasText: 'Spoon-Knife' })).toHaveCount(0);
  await dialog.locator('.rp-pick-item', { hasText: 'demo' }).click();
  await expect(page.locator('#workVisitorBadge')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/repo-visitor/);
  await expect(page.locator('.tab[data-tab="governance"]')).toHaveClass(/active/);
  await expect(page.locator('body')).not.toHaveClass(/repo-visitor/);
});

test('a security tool’s picker opens any repository by name or address, and says when an address is elsewhere', async ({ page }) => {
  await signedIn(page);
  await rail(page, 'audit');
  const dialog = page.getByRole('dialog');
  const query = dialog.locator('#rpPickQuery');
  await expect(query).toHaveAttribute('placeholder', 'Search, or paste any public repository');

  await query.fill('https://gitlab.com/octo/spoon-knife');
  await expect(dialog.locator('.rp-pick-empty')).toHaveText('That address is on gitlab.com; this session reads repositories on github.com.');

  /* A typed owner/name is also a search: nothing listed matches it, so it is offered as any repository. */
  await query.fill('octo/spoon-knife');
  const any = dialog.locator('.rp-pick-group', { hasText: 'Any repository' });
  await expect(any).toBeVisible();
  const row = dialog.locator('.rp-pick-item.rp-pick-any');
  await expect(row).toContainText('octo/spoon-knife');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await query.press('Enter');
  await expect(page.locator('#workRepoName')).toHaveText('Octo/Spoon-Knife');
  await expect(page.locator('.tab[data-tab="audit"]')).toHaveClass(/active/);

  /* The repository it was opened from is remembered with the rest. */
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('nv_recent:repositories') || '[]'));
  expect(recent[0]).toEqual({ owner: 'Octo', name: 'Spoon-Knife', visitor: true });
});

test('a listed repository pasted as an address narrows the list to it instead of offering it twice', async ({ page }) => {
  await signedIn(page);
  await page.locator('#repoFilter').fill('https://github.com/sandbox/demo/pulls');
  await expect(page.locator('#repoOpenAny')).toBeHidden();
  await expect(page.locator('#repoGrid .repo-card')).toBeVisible();
  await page.locator('#repoFilter').fill('https://github.com/sandbox');
  await expect(page.locator('#repoOpenAny')).toBeHidden();
});
