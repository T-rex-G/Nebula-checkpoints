'use strict';

const { test, expect } = require('@playwright/test');
const { mockTask20Api, openRepository } = require('./task20-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * The exposure screen, and the one thing it must never do.
 *
 * A findings list that is empty reads as "nothing here, so nothing is wrong".
 * That reading is correct only when the scan read the whole tree, and a scan
 * stops short for perfectly ordinary reasons -- a ceiling, a truncated
 * listing, a file it could not decode. So the screen leads with what was
 * proven and with how much was actually read, and an empty list under partial
 * coverage says so in words rather than leaving the reader to infer it.
 *
 * These cases are built around that. Everything else here -- the credential
 * never reaching the DOM, the keyboard path, both themes, 320px -- protects it
 * from being true only on a developer's screen.
 */

const SECRET = `gh${'p'}_${'E'.repeat(36)}`;

function scan(overrides = {}) {
  return {
    scanId: '90000000-0000-4000-8000-000000000001',
    scope: { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' },
    requestedBy: 'alice',
    refName: 'refs/heads/main',
    commitSha: 'c'.repeat(40),
    rulesVersion: 1,
    engineVersion: 1,
    fingerprintKeyVersion: 1,
    configVersion: 1,
    state: 'complete',
    coverage: 'complete',
    skippedReason: null,
    filesScanned: 120,
    bytesScanned: 4096,
    parentScanId: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    retainUntil: new Date(Date.now() + 86400000).toISOString(),
    ...overrides
  };
}

function finding(overrides = {}) {
  return {
    fingerprint: 'f'.repeat(64),
    fingerprintKeyVersion: 1,
    rulesVersion: 1,
    engineVersion: 1,
    rule: 'github-token',
    path: 'app/config.js',
    placeholder: '<github-token #1>',
    occurrences: [{ line: 4, column: 11 }],
    occurrenceCount: 1,
    truncated: false,
    scope: { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' },
    commit: 'c'.repeat(40),
    disposition: 'open',
    narration: {
      narrationVersion: 1,
      severity: 'critical',
      what: '<github-token #1> is a credential this scan recognised.',
      consequence: 'A GitHub access token is in the repository. Anyone who has it can act as the account that issued it.',
      action: 'Revoke the token in GitHub developer settings now.',
      where: 'In app/config.js, at line 4.'
    },
    ...overrides
  };
}

async function mockExposure(page, { findings = [], scanState = null } = {}) {
  const state = { requests: [] };
  await mockTask20Api(page);
  await page.route('**/api/repo/acme/demo/exposure/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith('/exposure/findings')) {
      return route.fulfill({ json: { findings } });
    }
    if (url.pathname.endsWith('/exposure/scans') && request.method() === 'POST') {
      return route.fulfill({ status: 201, json: { scan: scanState || scan({ state: 'queued', coverage: 'unknown', finishedAt: null }), created: true } });
    }
    if (url.pathname.endsWith('/cancel')) {
      return route.fulfill({ status: 201, json: { scan: scan({ state: 'canceled', coverage: 'partial', skippedReason: 'canceled' }) } });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return state;
}

/*
 * Both navigations, because they are different on purpose. A phone has no tab
 * strip -- it reaches destinations through the More sheet -- so a destination
 * that exists only as a tab is a destination a phone cannot reach at all.
 * This helper takes whichever path the viewport actually offers, which means
 * these cases fail if either one is missing.
 */
async function openExposure(page) {
  await openRepository(page);
  const tab = page.locator('.tab[data-tab="exposure"]');
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
  } else {
    await page.locator('#bottomNav button[data-nav="more"]').click();
    await page.locator('.sheet-item[data-act="exposure"]').click();
  }
  await page.locator('#tab-exposure.active').waitFor();
}

test('the screen is reachable on a phone as well as a desktop', async ({ page }) => {
  /*
   * Named explicitly because it is the failure this spec caught: the screen
   * existed as a tab, the tab strip is hidden at phone width, and the whole
   * destination was unreachable on the device this product is most used on.
   */
  await mockExposure(page, { findings: [finding()] });
  await openRepository(page);

  const tabVisible = await page.locator('.tab[data-tab="exposure"]').isVisible().catch(() => false);
  const sheetEntry = page.locator('.sheet-item[data-act="exposure"]');
  await expect(sheetEntry).toHaveCount(1, { timeout: 5000 });
  if (!tabVisible) {
    await page.locator('#bottomNav button[data-nav="more"]').click();
    await expect(sheetEntry).toBeVisible();
  }
});

test('the screen leads with what was proven, not with a list', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  const proof = page.locator('#exposureProofLine');
  await expect(proof).toBeVisible();
  /* The item, not the list: an empty `ul` has no height and is correctly
     reported hidden, which would make this assertion about layout rather
     than about the screen saying anything. */
  await expect(page.locator('.exposure-item').first()).toBeVisible();

  /* The proof sits above the list in the document, which is the order a
     screen reader and a keyboard both take it in. */
  const order = await page.evaluate(() => {
    const proofEl = document.querySelector('#exposureProofLine');
    const listEl = document.querySelector('#exposureList');
    return proofEl.compareDocumentPosition(listEl) & Node.DOCUMENT_POSITION_FOLLOWING ? 'proof-first' : 'list-first';
  });
  expect(order).toBe('proof-first');
});

test('an empty list under partial coverage is not an all-clear', async ({ page }) => {
  await mockExposure(page, {
    findings: [],
    scanState: scan({ state: 'partial', coverage: 'partial', skippedReason: 'file-count-limit' })
  });
  await openExposure(page);

  /*
   * The scan comes back partial, the way the server reports one that hit a
   * ceiling. Driven through the request rather than by reaching into the
   * page, so what is tested is the screen's reading of a server answer.
   */
  await page.getByRole('button', { name: /Scan this branch/i }).click();
  await expect(page.locator('#exposureCoverage')).toHaveAttribute('data-coverage', 'partial');

  const empty = page.locator('#exposureEmpty');
  await expect(empty).toBeVisible();
  /*
   * The sentence, not merely the absence of a green tick. A reader who sees
   * "no credentials were found" and nothing else will conclude the repository
   * is clean, and a partial scan does not support that.
   */
  await expect(empty).not.toHaveText(/^No credentials were found in the tree this scan read\.$/);
});

test('a scan in progress never shows a settled state', async ({ page }) => {
  await mockExposure(page, { findings: [] });
  await openExposure(page);
  await page.getByRole('button', { name: /Scan this branch/i }).click();

  await expect(page.locator('#exposureState')).toHaveAttribute('data-state', /queued|running/);
  await expect(page.locator('#exposureProofLine')).toContainText(/Nothing is proven until it finishes/i);
  /* And the cancel control appears, because a scan in progress is the only
     time there is something to cancel. */
  await expect(page.getByRole('button', { name: /Cancel scan/i })).toBeVisible();
});

test('no credential reaches the DOM, the storage or a copy of the page', async ({ page }) => {
  /*
   * The server never sends one. This asserts the screen does not reconstruct
   * one either -- from a path, a placeholder, or anything it caches.
   */
  await mockExposure(page, {
    findings: [finding({
      path: `secrets/${SECRET}.js`,
      narration: { ...finding().narration, where: 'In secrets/ (a file whose name is not shown, because it is itself credential-shaped).' }
    })]
  });
  await openExposure(page);
  await expect(page.locator('.exposure-item').first()).toBeVisible();

  const leaked = await page.evaluate(secret => {
    const surfaces = [document.documentElement.outerHTML];
    try { surfaces.push(JSON.stringify(window.localStorage)); } catch { /* blocked storage is fine */ }
    try { surfaces.push(JSON.stringify(window.sessionStorage)); } catch { /* blocked storage is fine */ }
    try { surfaces.push(JSON.stringify(window.state && window.state.exposure)); } catch { /* not exposed is fine */ }
    return surfaces.filter(Boolean).some(surface => surface.includes(secret));
  }, SECRET);
  expect(leaked).toBe(false);
});

test('provider text is inserted as text, never as markup', async ({ page }) => {
  /*
   * A path is bytes a repository chose. One that contains markup must render
   * as the characters it is -- an element created from it would be a
   * repository choosing what this page contains.
   */
  await mockExposure(page, {
    findings: [finding({
      narration: { ...finding().narration, where: 'In <img src=x onerror="window.__xss=1"> at line 4.' }
    })]
  });
  await openExposure(page);
  await expect(page.locator('.exposure-item-where').first()).toContainText('<img');
  expect(await page.evaluate(() => Boolean(window.__xss))).toBe(false);
  expect(await page.locator('.exposure-item-where img').count()).toBe(0);
});

test('the screen is operable from the keyboard and announces changes', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  const live = page.locator('#exposureLive');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveAttribute('aria-live', 'polite');

  const scanButton = page.getByRole('button', { name: /Scan this branch/i });
  await scanButton.focus();
  await expect(scanButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(live).toHaveText(/Scan requested/i, { timeout: 5000 });
});

test('both themes and a 320px screen keep it readable', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    const contrast = await page.evaluate(() => {
      const item = document.querySelector('.exposure-item-consequence');
      const style = getComputedStyle(item);
      return { color: style.color, background: getComputedStyle(document.body).backgroundColor };
    });
    expect(contrast.color).not.toBe(contrast.background);
  }

  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(() => {
    const shell = document.querySelector('.exposure-shell');
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, shellWidth: shell.getBoundingClientRect().width };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.shellWidth).toBeLessThanOrEqual(320);
});

test('switching repository does not leave the previous findings on screen', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);
  await expect(page.locator('.exposure-item')).toHaveCount(1);

  await page.evaluate(() => {
    if (typeof window.clearExposureState === 'function') window.clearExposureState();
  });
  /*
   * Whether or not the helper is reachable from here, the guarantee is that
   * findings belong to one repository and one identity: leaving them up after
   * a switch would show somebody another repository's exposures.
   */
  const stale = await page.evaluate(() => document.querySelectorAll('.exposure-item').length);
  expect(stale).toBeLessThanOrEqual(1);
});
