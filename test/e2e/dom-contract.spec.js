'use strict';
/*
 * The DOM contract: for every page and workbench tab, on both devices, the
 * element IDs, classes, roles, data attributes and accessible labels a reader
 * can see.
 *
 * Captured from the classic-script interface before the architecture mission
 * replaced it. The React interface must render the same contract -- that is
 * what keeps the stylesheet, both presets and the rest of this suite valid
 * oracles while every line of the interface changes underneath them. A token
 * that appears or disappears fails here unless it is listed, with its reason,
 * in dom-contract-deviations.json.
 *
 * Visible elements only: a panel React does not render until it is opened and
 * a panel the classic page kept in the DOM but hidden are the same thing to a
 * reader. Each view is read until it has held still for longer than the
 * page's slowest poll, so a class an animation toggles or a job between two
 * polls is not mistaken for structure.
 *
 * NV_DOM_CONTRACT_WRITE=1 records the current interface as the contract.
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });
/* A view may take the whole settling budget, on top of reaching it. */
test.setTimeout(60000);

const CONTRACT_DIR = path.join(__dirname, '..', 'oracles', 'dom-contract');
const DEVIATIONS = path.join(__dirname, '..', 'oracles', 'dom-contract-deviations.json');
const WRITE = process.env.NV_DOM_CONTRACT_WRITE === '1';

const WORK_TABS = Object.freeze([
  'editor', 'upload', 'commits', 'pulls', 'issues', 'releases', 'actions', 'compare',
  'neural', 'governance', 'exposure', 'audit', 'safeguards'
]);

function readTokens() {
  const tokens = new Set();
  for (const element of document.body.querySelectorAll('*')) {
    if (!element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if (element.id) tokens.add(`#${element.id}`);
    for (const name of element.classList) tokens.add(`.${name}`);
    const role = element.getAttribute('role');
    if (role) tokens.add(`[role=${role}]`);
    for (const attribute of element.attributes) {
      if (attribute.name.startsWith('data-')) tokens.add(`[${attribute.name}]`);
    }
    const label = element.getAttribute('aria-label');
    if (label) tokens.add(`[aria-label=${label}]`);
  }
  return [...tokens].sort();
}

/*
 * Read until the view stops changing. A job the page polls backs off to one
 * request every two seconds, so two readings that agree across a shorter gap
 * can both fall between polls and record a view that is still on its way.
 * The view must hold still for STILL_MS, longer than that longest gap; what
 * it held is the contract.
 */
const SAMPLE_MS = 500;
const STILL_MS = 2500;
const BUDGET_MS = 24000;

async function stableTokens(page) {
  const same = (left, right) => left.length === right.length && left.every((token, index) => token === right[index]);
  const readings = [await page.evaluate(readTokens)];
  let still = 0;
  for (let waited = 0; waited < BUDGET_MS; waited += SAMPLE_MS) {
    await page.waitForTimeout(SAMPLE_MS);
    const current = await page.evaluate(readTokens);
    still = same(readings[readings.length - 1], current) ? still + SAMPLE_MS : 0;
    readings.push(current);
    if (still >= STILL_MS) return current;
  }
  /* Still moving after the budget: an animation that never stops. What every reading of the last STILL_MS shares is structure. */
  const recent = readings.slice(-(STILL_MS / SAMPLE_MS + 1)).map(reading => new Set(reading));
  return readings[readings.length - 1].filter(token => recent.every(reading => reading.has(token)));
}

function deviationsFor(project, view) {
  if (!fs.existsSync(DEVIATIONS)) return { added: [], removed: [] };
  const all = JSON.parse(fs.readFileSync(DEVIATIONS, 'utf8'));
  const entry = (all[project] && all[project][view]) || (all['*'] && all['*'][view]) || {};
  return { added: (entry.added || []).map(item => item.token), removed: (entry.removed || []).map(item => item.token) };
}

async function holdContract(page, testInfo, view) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  const tokens = await stableTokens(page);
  const file = path.join(CONTRACT_DIR, testInfo.project.name, `${view.replace(/\//g, '--')}.json`);
  if (WRITE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(tokens, null, 1)}\n`);
    return;
  }
  expect(fs.existsSync(file), `no recorded contract for ${testInfo.project.name} ${view}`).toBe(true);
  const recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
  const allowed = deviationsFor(testInfo.project.name, view);
  const now = new Set(tokens);
  const before = new Set(recorded);
  const added = tokens.filter(token => !before.has(token) && !allowed.added.includes(token));
  const removed = recorded.filter(token => !now.has(token) && !allowed.removed.includes(token));
  expect({ view, added, removed }).toEqual({ view, added: [], removed: [] });
}

test('landing page', async ({ page }, testInfo) => {
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  await expect(page.locator('#page-alpha-access')).toHaveClass(/active/);
  await holdContract(page, testInfo, 'landing');
});

test('sign-in page', async ({ page }, testInfo) => {
  await mockPublicAlphaApi(page, { mode: 'off', access: 'required', ready: 'ready' });
  await page.goto('/');
  await page.locator('#alphaPassThrough').click();
  await expect(page.locator('#page-login')).toHaveClass(/active/);
  await holdContract(page, testInfo, 'login');
});

test('overview page', async ({ page }, testInfo) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await holdContract(page, testInfo, 'overview');
});

test('repositories page', async ({ page }, testInfo) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/');
  await require('./semantic').enterRepositories(page);
  await expect(page.locator('#page-repos')).toHaveClass(/active/);
  await holdContract(page, testInfo, 'repos');
});

test('findings page', async ({ page }, testInfo) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/#/findings');
  await expect(page.locator('#page-findings')).toHaveClass(/active/);
  await holdContract(page, testInfo, 'findings');
});

test('website page', async ({ page }, testInfo) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/#/sandbox/demo@main/audit');
  await expect(page.locator('#tab-audit')).toBeVisible();
  await page.locator('#tab-audit .audit-site').getByRole('button', { name: 'Check in Parallax' }).click();
  await expect(page.locator('#page-site')).toHaveClass(/active/);
  /* The page starts a check and polls it; the contract is the page with its answer. */
  await expect(page.locator('#page-site .audit-site-assessment')).toBeVisible({ timeout: 20000 });
  await holdContract(page, testInfo, 'site');
});

for (const tab of WORK_TABS) {
  test(`workbench ${tab} tab`, async ({ page }, testInfo) => {
    await mockPublicAlphaApi(page, { access: 'active', governance: 'populated' });
    await page.goto(`/#/sandbox/demo@main/${tab}`);
    await expect(page.locator('#page-work')).toHaveClass(/active/);
    await expect(page.locator(`#tab-${tab}`)).toBeVisible();
    await holdContract(page, testInfo, `work/${tab}`);
  });
}
