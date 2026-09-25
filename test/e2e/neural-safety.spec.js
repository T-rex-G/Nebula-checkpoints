'use strict';

/*
 * Nothing a repository says about itself runs in the reader's browser.
 *
 * Almost every word on the graph was written by somebody else: branch names,
 * commit messages, workflow names, webhook hosts, collaborator logins, the
 * paths an Exposure scan reports. The graph draws most of them on a canvas,
 * where markup is only text, but the card, the groups list, the timeline and
 * the connection explanation are HTML. Each of those surfaces is fed a value
 * that would run script if it were written into the page unescaped, and the
 * test reads whether anything ran or any element was created from it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/* A payload that runs if it is ever parsed as markup, marked so each surface
 * can be found by searching for its token. */
const hostile = token => `${token}"><img src=x data-hostile="${token}" onerror="window.__hostile=(window.__hostile||[]).concat('${token}')">`;
const now = new Date().toISOString();

async function openHostileGraph(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const json = body => route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const at = suffix => url => new URL(url).pathname === `/api/repo/sandbox/demo/${suffix}`;
  await page.route(at('refs-snapshot'), json({
    defaultBranch: 'main',
    refs: [{ name: 'main', sha: 'a'.repeat(40), protected: true }, { name: hostile('brx'), sha: 'b'.repeat(40) }],
    tags: []
  }));
  await page.route(at('activity'), json({
    commits: [{ sha: 'abc1234'.padEnd(40, '0'), message: hostile('cmx'), author: hostile('aux'), date: now }],
    pulls: [], issues: [], releases: []
  }));
  await page.route(at('actions'), json([{ id: 91, name: hostile('wfx'), status: 'completed', conclusion: 'failure', branch: 'main', event: 'push', created_at: now, html_url: 'javascript:alert(1)' }]));
  await page.route(at('access-surface'), json({
    available: true,
    collaborators: [{ login: hostile('usx'), permission: 'admin', type: 'User' }],
    deployKeys: [{ id: 7, title: hostile('dkx'), readOnly: false, verified: true }],
    webhooks: [{ id: 8, host: hostile('hkx'), active: true, insecureSsl: true, events: ['push'] }],
    risk: { score: 0, severity: 'normal', reasons: [] }
  }));
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/exposure/findings', json({
    findings: [{
      fingerprint: hostile('fpx'), rule: 'github-token', disposition: 'open',
      displayPath: `config/${hostile('lkx')}.env`, occurrences: [{ line: 3 }],
      inTree: false, introducedCommit: 'abc1234',
      narration: { severity: 'critical', what: hostile('nrx') }
    }],
    verifications: {}
  }));
  await page.goto('/#/sandbox/demo@main/neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => (window.NebulaNeural ? window.NebulaNeural.state.nodes.filter(n => n.visible).length : 0))).toBeGreaterThan(5);
}

async function noScriptRan(page) {
  expect(await page.evaluate(() => window.__hostile || [])).toEqual([]);
  expect(await page.locator('img[data-hostile]').count()).toBe(0);
}

async function openCardFor(page, token) {
  const search = page.locator('#neuralSearch');
  await search.fill('');
  await search.fill(token);
  await expect(page.locator('#neuralCard')).toBeVisible();
  await expect(page.locator('#neuralCardTitle')).toContainText(token);
}

test('hostile names are shown as text in the card, the groups list and the timeline', async ({ page }) => {
  await openHostileGraph(page);
  /* The leaked credential arrived, masked path and all, as text. */
  expect(await page.evaluate(() => window.NebulaNeural.state.nodes.some(n => n.type === 'leak'))).toBe(true);
  for (const token of ['brx', 'cmx', 'wfx', 'hkx', 'dkx', 'usx', 'lkx']) {
    await openCardFor(page, token);
    await noScriptRan(page);
  }
  /* The workflow's provider link is offered only for https. */
  await openCardFor(page, 'wfx');
  const provider = page.locator('#neuralCard [data-neural-action="external-url"]');
  await expect(provider).toHaveCount(1);
  const opened = [];
  page.on('popup', popup => opened.push(popup.url()));
  await provider.click();
  await page.waitForTimeout(200);
  expect(opened).toEqual([]);
  /* The connection explanation is a dialog built from the same labels. */
  await openCardFor(page, 'lkx');
  await page.locator('#neuralCard [data-neural-action="explain"]').click();
  await openCardFor(page, 'brx');
  await page.locator('#neuralCard [data-neural-action="explain"]').click();
  const dialog = page.getByRole('dialog', { name: 'Explain this connection' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('lkx');
  await noScriptRan(page);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await noScriptRan(page);
  /* And the timeline and groups list, which list the same names. */
  expect(await page.locator('#neuralLegend, #neuralEventStrip').evaluateAll(nodes => nodes.map(n => n.innerHTML).join(''))).not.toContain('<img');
});
