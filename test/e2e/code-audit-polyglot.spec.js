'use strict';

/*
 * An audit of a branch written in more than one language: a Go service, a
 * Spring controller and a Laravel app beside the Node code. Each is traced,
 * its endpoints are mapped under its own framework's name with the guard in
 * front of them, a route that answers two verbs reads as two, and a flow in
 * a controller is reached through the route that names it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function audit(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', auditStack: 'polyglot' });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade [A-F], \d{1,3} out of 100$/);
  return pane;
}

test('Go, Java and PHP are traced and their endpoints mapped under their own frameworks', async ({ page }) => {
  const pane = await audit(page);
  await expect(pane.locator('.audit-engine-line')).toContainText('Uranus 2.3');
  await expect(pane.locator('.audit-engine-line')).toContainText('6 files traced');
  /* The version and the count are read apart, not as one number. */
  await expect(pane.locator('.audit-engine-line')).toContainText('Uranus 2.3 6 files traced');
  /* And the space is not drawn: a flex row drops a text run that is only white space. */
  const drawn = await pane.locator('.audit-engine-line').evaluate(line => {
    const space = [...line.childNodes].find(node => node.nodeType === 3);
    const range = document.createRange();
    range.selectNodeContents(space);
    return range.getClientRects().length;
  });
  expect(drawn).toBe(0);

  const surface = pane.locator('.audit-surface');
  await expect(surface.getByRole('heading', { name: 'Attack surface' })).toBeVisible();
  const more = surface.getByRole('button', { name: /^Show all/ });
  if (await more.count()) await more.click();
  const routes = surface.getByRole('list', { name: 'Endpoints' }).getByRole('listitem');
  await expect(routes).toHaveCount(9);
  for (const name of ['Gin', 'Spring', 'Laravel', 'Express']) await expect(surface.locator('.audit-route-fw', { hasText: name }).first()).toBeVisible();

  /* Laravel's Route::match answers two verbs: one a line, inside the pill's column */
  const both = routes.filter({ hasText: '/posts' }).filter({ hasText: 'POST' }).first();
  const pill = both.locator('.audit-route-method');
  await expect(pill).toHaveText('POST PUT');
  const [pillBox, mainBox] = await Promise.all([pill.boundingBox(), both.locator('.audit-route-main').boundingBox()]);
  expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(mainBox.x + 1);
  expect(pillBox.height).toBeGreaterThan(24);

  /* every path starts on the same line, whatever the verb beside it */
  const starts = await surface.locator('.audit-route:not([hidden]) .audit-route-path').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));
  expect(new Set(starts).size).toBe(1);

  /* the Spring delete behind @PreAuthorize is signed in; the Go download is open */
  await expect(routes.filter({ hasText: '/api/accounts/{id}' })).toContainText('Signed in');
  await expect(routes.filter({ hasText: '/files/download' })).toContainText('Open');
  await expect(routes.filter({ hasText: '/admin/files/:name' })).toContainText('Signed in');

  /* the traced Java injection, reached through its Spring route */
  const sql = pane.locator('.audit-item', { hasText: 'AccountController.java' }).filter({ hasText: 'SQL statement' });
  await expect(sql).toHaveCount(1);
  await sql.locator('summary').click();
  await expect(sql.locator('.audit-reach-line')).toContainText('GET /api/accounts/search');
  await expect(sql.locator('.audit-reach-fw')).toHaveText('Spring');

  /* the mass assignment in a Laravel controller, reached through the two-verb route */
  const mass = pane.locator('.audit-item', { hasText: 'PostController.php' });
  await expect(mass).toHaveCount(1);
  await mass.locator('summary').click();
  await expect(mass.locator('.audit-reach-line')).toContainText('POST/PUT /posts');

  /* the ledger names the languages traced */
  const ledger = pane.locator('.audit-ledger');
  await expect(ledger).toContainText('across 6 files');
});
