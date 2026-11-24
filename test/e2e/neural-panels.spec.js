'use strict';

/*
 * The Neural command center's panels in the reader's browser: the four
 * summary cards above the stage and the controls beside them, the strip of
 * events under it, and the groups list -- what each says about a repository
 * whose readings the test chooses, and what a press in each does. A panel
 * drawn again keeps its elements, so the control the reader pressed keeps
 * their focus: the classic page replaced every element and dropped it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });
/* The graph's state is read through the read-only probe, which the harness marker asks for (ADR-092). */
test.beforeEach(async ({ page }) => { await ui.underHarness(page); });

const now = Date.now();
const iso = ms => new Date(now - ms).toISOString();
const json = body => route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const at = suffix => url => new URL(url).pathname === `/api/repo/sandbox/demo/${suffix}`;

/* A repository with two protected branches, one protected file, a failed run and a dozen commits. */
async function openGraph(page, extra = async () => {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(url => new URL(url).pathname === '/api/safety', route => (route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ readOnly: false, freezeSync: false, protected: { 'sandbox/demo': ['deploy/key.yml'] }, globalControls: false }) })
    : route.fallback()));
  await page.route(at('refs-snapshot'), json({
    defaultBranch: 'main',
    refs: [{ name: 'main', sha: 'a'.repeat(40), protected: true }, { name: 'release', sha: 'b'.repeat(40), protected: true }, { name: 'feature/x', sha: 'c'.repeat(40) }],
    tags: []
  }));
  await page.route(at('activity'), json({
    commits: Array.from({ length: 12 }, (_, i) => ({ sha: String(i).padStart(40, 'f'), message: `Commit number ${i}`, author: 'alpha-tester', date: iso((i + 1) * 3600e3) })),
    pulls: [], issues: [], releases: []
  }));
  await page.route(at('actions'), json([{ id: 91, name: 'ci', status: 'completed', conclusion: 'failure', branch: 'main', event: 'push', created_at: iso(600e3), html_url: 'https://example.test/run/91' }]));
  await extra(page);
  await page.goto('/#/sandbox/demo@main/neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => (window.__NV_PROBE__.read('neural') || { nodes: [] }).nodes.filter(n => n.visible).length)).toBeGreaterThan(5);
  await expect(page.locator('#neuralEventStrip button[data-event-index]').first()).toBeVisible();
}

/* The groups list, opened where the stage keeps it in a panel. */
async function openGroups(page) {
  if (await page.locator('#neuralLegend').isVisible()) return;
  await page.locator('#neuralExpandBtn').click();
  const stage = page.locator('#neuralStage');
  if (!(await stage.evaluate(node => node.classList.contains('panel-open')))) await page.locator('#neuralPanelBtn').click();
  await expect(page.locator('#neuralLegend')).toBeVisible();
}

test('the summary cards say what the repository holds', async ({ page }) => {
  await openGraph(page);
  await expect(page.locator('#neuralProtectedCount')).toHaveText('3');
  const risk = page.locator('#neuralRiskScore');
  await expect(risk).toHaveText(/^(?:(?:Low|Guarded|Elevated|Critical) · \d{1,3}|(?:Critical · )?Incomplete)$/);
  await expect(page.locator('.neural-kpi', { has: risk })).toHaveAttribute('data-level', /^(?:good|warning|critical)$/);
  /* The worst thing found is named: here, the failed run (nothing in the graph is worse). */
  const severe = await page.evaluate(() => window.__NV_PROBE__.read('neural').nodes.filter(n => n.severity === 'critical' && (n.type === 'vulnerability' || n.type === 'leak')).length);
  expect(severe).toBe(0);
  await expect(page.locator('#neuralRiskHint')).toHaveText(/^1 failed workflow run\(s\)/);
  await expect(page.locator('#neuralSignalCount')).toHaveText(/^\d+$/);
  expect(Number(await page.locator('#neuralSignalCount').textContent())).toBeGreaterThanOrEqual(12);
  await expect(page.locator('#neuralRecoveryState')).toHaveText(/^(?:Captured|Unverified|Unknown|Gap)$/);
  await expect(page.locator('#neuralRecoveryHint')).not.toHaveText('No snapshot inspected yet');
  await expect(page.locator('.neural-kpi', { has: page.locator('#neuralRecoveryState') })).toHaveAttribute('data-level', /^(?:good|warning)$/);
  /* The stream is live here: the control offers to disconnect, in both its labels, and keeps its icon. */
  const live = page.locator('#neuralLiveBtn');
  await expect(live).toBeEnabled();
  await expect(live.locator('.nh-long')).toHaveText('Disconnect verified live events');
  await expect(live.locator('.nh-short')).toHaveText('Disconnect');
  await expect(live.locator('svg.ico')).toHaveCount(1);
  await expect(page.locator('#neuralReadOnlyBtn')).toHaveText('Enable read-only');
  for (const id of ['neuralRiskScore', 'neuralRiskHint', 'neuralSignalCount', 'neuralRecoveryState', 'neuralRecoveryHint']) {
    await expect(page.locator(`#${id}`)).not.toHaveText(/undefined|NaN|\[object Object\]/);
  }
});

test('a stream that cannot connect says why and cannot be pressed', async ({ page }) => {
  await openGraph(page, p => p.route(at('live-events/status'), json({ available: false, connected: false, reason: 'Neon is not configured for this deployment' })));
  const live = page.locator('#neuralLiveBtn');
  await expect(live).toBeDisabled();
  await expect(live).toHaveAttribute('title', 'Neon is not configured for this deployment');
  await expect(live.locator('.nh-long')).toHaveText('Connect verified live events');
  await expect(live.locator('.nh-short')).toHaveText('Live events');
  await expect(live.locator('svg.ico')).toHaveCount(1);
});

test('pressing an event in the strip moves the history to it, opens what it is about and keeps the press', async ({ page }) => {
  await openGraph(page);
  const strip = page.locator('#neuralEventStrip');
  const range = page.locator('#neuralTimeline');
  const cards = strip.locator('button[data-event-index]');
  await expect(cards).toHaveCount(6);
  await expect(strip.locator('button.active')).toHaveCount(1);
  const last = Number(await range.getAttribute('max'));
  expect(last).toBeGreaterThanOrEqual(11);
  await expect(range).toHaveValue(String(last));
  await expect(strip.locator('button.active')).toHaveAttribute('data-event-index', String(last));
  /* The first card shown, three or more before the latest. */
  const first = cards.first();
  const index = Number(await first.getAttribute('data-event-index'));
  expect(index).toBe(last - 5);
  const label = await first.locator('b').textContent();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(range).toHaveValue(String(index));
  await expect(strip.locator('button.active')).toHaveAttribute('data-event-index', String(index));
  await expect(page.locator('#neuralTimelineCaption')).toHaveText(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · \\d+[smhd] ago$`));
  /* The strip moved with the slider: three before the one pressed. */
  expect(await cards.evaluateAll(list => list.map(b => Number(b.dataset.eventIndex)))).toEqual([index - 3, index - 2, index - 1, index, index + 1, index + 2]);
  /* What the event is about is chosen and its card opened. */
  await expect(page.locator('#neuralCard')).toBeVisible();
  const selected = await page.evaluate(() => (window.__NV_PROBE__.read('neural').selected || {}).label);
  await expect(page.locator('#neuralCardTitle')).toHaveText(selected);
  /* The pressed card is the same element, still focused. */
  expect(await page.evaluate(() => document.activeElement && document.activeElement.dataset.eventIndex)).toBe(String(index));
  /* The slider moves the strip the same way. */
  await range.evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, String(last));
  await expect(strip.locator('button.active')).toHaveAttribute('data-event-index', String(last));
  expect(await cards.evaluateAll(list => list.map(b => Number(b.dataset.eventIndex)))).toEqual([last - 5, last - 4, last - 3, last - 2, last - 1, last]);
  /* Closed by a press that does not move focus (Safari's mouse leaves it where it was), the
   * reader is returned to the graph; and the card holds nothing a screen reader or Tab could still reach. */
  await page.locator('#neuralCard [data-neural-card-close]').evaluate(button => button.click());
  await expect(page.locator('#neuralCard')).toBeHidden();
  expect(await page.locator('#neuralCard *').count()).toBe(0);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('neuralCanvas');
});

test('hiding a group from the keyboard keeps the reader on its eye', async ({ page }) => {
  await openGraph(page);
  await openGroups(page);
  const eye = page.locator('#neuralLegend [data-neural-toggle="commit"]');
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await expect(eye).toHaveAttribute('aria-label', 'Hide commits');
  await eye.focus();
  await page.keyboard.press('Enter');
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  await expect(eye).toHaveAttribute('aria-label', 'Show commits');
  await expect(page.locator('#neuralLegend .neural-group-row:has([data-neural-toggle="commit"])')).toHaveClass(/is-hidden/);
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').nodes.filter(n => n.type === 'commit' && n.visible).length)).toBe(0);
  const focused = () => page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-neural-toggle'));
  expect(await focused()).toBe('commit');
  await expect(page.locator('#neuralLegend [data-neural-groups="show"]')).toHaveText('Show all (1 hidden)');
  /* And showing it again from where they are. */
  await page.keyboard.press('Space');
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').nodes.filter(n => n.type === 'commit' && n.visible).length)).toBeGreaterThan(0);
  expect(await focused()).toBe('commit');
  await expect(page.locator('#neuralLegend [data-neural-groups="show"]')).toHaveCount(0);
  /* Hidden again, the group's name brings it back, lit. */
  await page.keyboard.press('Enter');
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  const chip = page.locator('#neuralLegend [data-neural-group="commit"]');
  await expect(chip).toHaveAttribute('aria-disabled', 'true');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').focusGroup)).toBe('commit');
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').nodes.filter(n => n.type === 'commit' && n.visible).length)).toBeGreaterThan(0);
});

test('lighting a group from the keyboard keeps the reader on its name', async ({ page }) => {
  await openGraph(page);
  await openGroups(page);
  const chip = page.locator('#neuralLegend [data-neural-group="branch"]');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(chip).toHaveClass(/is-on/);
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').focusGroup)).toBe('branch');
  expect(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-neural-group'))).toBe('branch');
  await expect(chip.locator('b')).toHaveText('3');
});

test('a lit group the chosen mode leaves out is let go', async ({ page }) => {
  await openGraph(page);
  await openGroups(page);
  await page.locator('#neuralLegend [data-neural-group="commit"]').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').focusGroup)).toBe('commit');
  /* Dependencies hold no commits: the lit group is let go, rather than dimming every node around nothing. */
  await page.locator('#neuralModeList [data-neural-mode="dependencies"]').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').focusGroup)).toBeNull();
  expect(await page.evaluate(() => window.__NV_PROBE__.read('neural').nodes.some(n => n.type === 'commit' && n.inScope))).toBe(false);
  await expect(page.locator('#neuralLegend [aria-pressed="true"][data-neural-group]')).toHaveCount(0);
});

test('another repository opens onto a clean map: no groups, figures or card of the last one', async ({ page }) => {
  await openGraph(page);
  const search = page.locator('#neuralSearch');
  await search.fill('Commit number 3');
  await expect(page.locator('#neuralCard')).toBeVisible();
  expect(await page.locator('#neuralLegend').evaluate(node => node.hidden)).toBe(false);
  /* The next repository's readings are held until the test lets them through. */
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(/\/api\/repo\/sandbox\/other(\/.*)?(\?.*)?$/, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/repo/sandbox/other') return route.fulfill({ json: { full_name: 'sandbox/other', private: false, default_branch: 'main', homepage: '', branches: [{ name: 'main', protected: false, sha: 'd'.repeat(40) }] } });
    if (pathname.endsWith('/tree')) return route.fulfill({ json: [] });
    if (pathname.endsWith('/files')) return route.fulfill({ json: { files: [] } });
    await gate;
    return route.fulfill({ json: {} });
  });
  await page.evaluate(() => { location.hash = '#/sandbox/other@main/neural'; });
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/other');
  /* While it is read: nothing of the last repository -- no groups, no figures, no card. */
  await expect.poll(() => page.locator('#neuralLegend').evaluate(node => node.hidden)).toBe(true);
  expect(await page.locator('#neuralLegend *').count()).toBe(0);
  for (const id of ['neuralRiskScore', 'neuralSignalCount', 'neuralProtectedCount', 'neuralRecoveryState']) await expect(page.locator(`#${id}`)).toHaveText('—');
  await expect(page.locator('#neuralCard')).toBeHidden();
  expect(await page.locator('#neuralCard *').count()).toBe(0);
  await expect(page.locator('#neuralEventStrip')).toHaveText(/No events/);
  /* The last repository's search goes with it, rather than filtering the next map down to its hub. */
  await expect(search).toHaveValue('');
  release();
  /* Then its own map, its own groups, all of them in view. */
  await expect.poll(() => page.locator('#neuralLegend').evaluate(node => node.hidden)).toBe(false);
  await expect(page.locator('#neuralLegend [data-neural-group="commit"]')).toHaveCount(0);
  /* Out of view only what the security mode leaves out (the upload scan), nothing a search filtered. */
  expect(await page.evaluate(() => window.__NV_PROBE__.read('neural').nodes.filter(n => !n.inScope).map(n => n.type))).toEqual(['scan']);
});

test('a workflow\'s provider link opens only an https address', async ({ page }) => {
  /* What the page asks to open, recorded rather than opened. */
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url, target, features) => { window.__opened.push([String(url), target, features]); return null; };
  });
  await openGraph(page, p => p.route(at('actions'), json([
    { id: 91, name: 'ci', status: 'completed', conclusion: 'failure', branch: 'main', event: 'push', created_at: iso(600e3), html_url: 'https://example.test/run/91' },
    { id: 92, name: 'sneaky', status: 'completed', conclusion: 'success', branch: 'main', event: 'push', created_at: iso(500e3), html_url: 'javascript:alert(1)' }
  ])));
  const open = async name => {
    const search = page.locator('#neuralSearch');
    await search.fill('');
    await search.fill(name);
    await expect(page.locator('#neuralCardTitle')).toContainText(name);
    await page.locator('#neuralCard [data-neural-action="external-url"]').click();
  };
  await open('ci');
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([['https://example.test/run/91', '_blank', 'noopener']]);
  await open('sneaky');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__opened)).toEqual([['https://example.test/run/91', '_blank', 'noopener']]);
});
