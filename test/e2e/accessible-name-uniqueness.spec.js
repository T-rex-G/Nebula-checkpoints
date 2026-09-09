'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * No two form controls may share an accessible name on a screen.
 *
 * The owner card was added with its token field labelled "GitHub Personal
 * Access Token" -- the same name the cohort login field already carried on the
 * same document. Twenty end-to-end cases across six unrelated spec files broke
 * at once, each on `getByLabel(...)` resolving to two elements, and every one
 * of them reported a strict-mode violation rather than the defect: two controls
 * that a screen reader, a password manager and a test all have to tell apart by
 * name, and cannot.
 *
 * Checked over the whole document rather than the visible screen. Every screen
 * is present in the DOM at once here -- the gate covers the login page rather
 * than replacing it -- so a name that collides only while hidden still collides
 * for anything selecting by name.
 *
 * The retired owner card is no longer part of this surface. Keep the general
 * accessibility guarantee for the ordinary provider sign-in and workbench.
 */
async function duplicateNames(page) {
  return page.evaluate(() => {
    const named = [];
    /*
     * Fields, not buttons. The shell repeats an action button per screen on
     * purpose -- Settings exists on three screens, Accounts on two -- and only
     * one screen is ever active, so those names are unambiguous to a reader and
     * the suite resolves them by visibility. Two entry fields sharing a name is
     * the case nothing can disambiguate: not a screen reader, not a password
     * manager, not a selector.
     */
    for (const control of document.querySelectorAll('input, select, textarea')) {
      if (control.type === 'hidden') continue;
      let name = '';
      if (control.id) {
        const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
        if (label) name = label.textContent.trim();
      }
      if (!name && control.getAttribute('aria-label')) name = control.getAttribute('aria-label').trim();
      if (!name && control.getAttribute('aria-labelledby')) {
        const source = document.getElementById(control.getAttribute('aria-labelledby'));
        if (source) name = source.textContent.trim();
      }
      if (!name) continue;
      named.push({ name, id: control.id || '(no id)', tag: control.tagName.toLowerCase() });
    }
    const seen = new Map();
    for (const entry of named) {
      if (!seen.has(entry.name)) seen.set(entry.name, []);
      seen.get(entry.name).push(`${entry.tag}#${entry.id}`);
    }
    return [...seen.entries()]
      .filter(([, controls]) => controls.length > 1)
      .map(([name, controls]) => `${JSON.stringify(name)} -> ${controls.join(', ')}`);
  });
}

test('no two form controls share an accessible name', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await page.locator('#page-alpha-access.active, #page-login.active, #page-repos.active').first().waitFor();

  await expect(page.locator('#workspaceCard')).toHaveCount(0);

  const duplicates = await duplicateNames(page);
  expect(duplicates, `controls sharing an accessible name:\n  ${duplicates.join('\n  ')}`).toEqual([]);
});
