'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

/* Without this the page can run a cached app.js and measure yesterday's code. */
test.use({ serviceWorkers: 'block' });

/*
 * The upload queue must send one file at a time.
 *
 * Reported as a zip of many files where one lands and the rest fail with
 * "Operation could not be completed", each offering its own Retry -- unusable
 * at four hundred files. Two things combine to cause it:
 *
 *   1. uploadOne ends at xhr.send() and returns. It is an async function and
 *      the queue awaits it, but that await resolves when the request is SENT,
 *      not when it completes, so the loop is sequential in appearance only.
 *   2. Every one of those simultaneous uploads carries the expectedHeadSha it
 *      read before any of them landed. The first commit moves the head and the
 *      provider refuses the rest as stale.
 *
 * Measured at the source rather than through mocked responses: the page counts
 * how many uploads are in flight at once. Sequential means the peak is one.
 * Against the reported code the peak is the size of the queue, because every
 * file is sent before the first reply arrives.
 */
const QUEUED = ['one.txt', 'two.txt', 'three.txt', 'four.txt', 'five.txt'];

test('the upload queue sends one file at a time', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const heads = [];
  await page.route('**/api/repo/sandbox/demo/upload?**', route => {
    heads.push(new URL(route.request().url()).searchParams.get('expectedHeadSha'));
    return route.fulfill({ json: { ok: true, commit: String(heads.length).repeat(40), strategy: 'git-data-api' } });
  });

  await page.addInitScript(() => {
    /* Watches the transport itself, so nothing about it depends on routing. */
    window.__uploadFlight = { open: 0, peak: 0, sent: 0 };
    const send = XMLHttpRequest.prototype.send;
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function trackedOpen(method, url, ...rest) {
      this.__isUpload = /\/upload(\?|$)/.test(String(url));
      /*
       * Attached here, at open, rather than at send -- so this listener runs
       * BEFORE the queue's own. Registered after it, the count read 2 on a
       * queue that was already sequential: the queue's listener resolved
       * first, the next file was sent, and only then did this one decrement.
       * That would have been the measurement's own overlap, not the app's.
       */
      this.addEventListener('loadend', () => {
        if (this.__isUpload) window.__uploadFlight.open -= 1;
      });
      return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function trackedSend(body) {
      if (this.__isUpload) {
        const flight = window.__uploadFlight;
        flight.open += 1;
        flight.sent += 1;
        flight.peak = Math.max(flight.peak, flight.open);
      }
      return send.call(this, body);
    };
    /*
     * The security context, stubbed before the app loads. An upload is the
     * first unsafe method this flow issues; without a token none is ever sent
     * and the guard would pass for a reason unrelated to the queue.
     */
    const fetchImpl = window.fetch;
    window.fetch = function guardedFetch(input, init) {
      const url = String(typeof input === 'string' ? input : (input && input.url) || '');
      if (url.includes('/api/security/csrf')) {
        return Promise.resolve(new Response(
          JSON.stringify({ token: 'upload-guard-csrf', expiresAt: new Date(Date.now() + 600000).toISOString() }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ));
      }
      return fetchImpl.call(this, input, init);
    };
  });

  await page.goto('/');
  await ui.enterRepositories(page);
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();

  await page.evaluate(() => { if (window.switchTab) window.switchTab('upload'); });
  await page.locator('#filePicker').waitFor({ state: 'attached' });
  await page.locator('#filePicker').setInputFiles(QUEUED.map(name => ({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(`contents of ${name}\n`, 'utf8')
  })));

  await expect
    .poll(() => page.evaluate(() => window.__uploadFlight.sent), { timeout: 25000 })
    .toBe(QUEUED.length);
  await expect(page.locator('#uploadQueue .uq-item.done')).toHaveCount(QUEUED.length);
  await expect.poll(() => page.evaluate(() => window.__uploadFlight.open)).toBe(0);
  expect(heads).toEqual(['a', '1', '2', '3', '4'].map(value => value.repeat(40)));

  const flight = await page.evaluate(() => window.__uploadFlight);
  expect(
    flight.peak,
    `${flight.peak} uploads were in flight at once out of ${flight.sent} sent; `
    + 'a queue that does not wait for each reply sends every file against the same head sha, '
    + 'so the first commit lands and the provider refuses the rest as stale'
  ).toBe(1);
});

const { createHash } = require('crypto');
const CONTENT = 'upload regression fixture\n';
const GOOD = { ok: true, commit: 'b'.repeat(40), strategy: 'git-data-api' };

async function openUploads(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await ui.enterRepositories(page);
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
  await page.evaluate(() => window.switchTab('upload'));
}

async function selectFiles(page, paths = ['one.txt', 'two.txt']) {
  // A directory selection supplies webkitRelativePath; preserve it at the DOM seam.
  await page.evaluate(({ paths, content }) => {
    const transfer = new DataTransfer();
    for (const path of paths) {
      const file = new File([content], path.split('/').pop(), { type: 'text/plain' });
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      transfer.items.add(file);
    }
    const picker = document.querySelector('#folderPicker');
    picker.files = transfer.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  }, { paths, content: CONTENT });
}

test('failed files are reported and group retry keeps nested paths without stripping again', async ({ page }) => {
  await openUploads(page);
  const paths = [];
  await page.route('**/api/repo/sandbox/demo/upload?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    paths.push(path);
    return route.fulfill(paths.length === 1
      ? { status: 503, json: { error: 'Provider unavailable' } }
      : { json: GOOD });
  });
  await selectFiles(page, ['alpha/nested/one.txt', 'beta/two.txt']);
  await expect(page.locator('#modalTitle')).toHaveText("1 of 2 didn't upload");
  await expect(page.locator('.toast.ok')).not.toContainText(['2 files uploaded']);
  await page.locator('#uploadDir').evaluate(el => { el.value = 'different'; });
  await page.locator('#modalOk').click();
  await expect(page.locator('#scrim')).toBeHidden();
  await expect.poll(() => paths.length).toBe(3);
  expect(paths).toEqual(['alpha/nested/one.txt', 'beta/two.txt', 'alpha/nested/one.txt']);
  await expect(page.locator('#uploadQueue .uq-item.error')).toHaveCount(0);
  await expect(page.locator('#uploadQueue .uq-item.done')).toHaveCount(2);
});

test('individual Retry preserves folder, message, LFS choice and commit mode', async ({ page }) => {
  await openUploads(page);
  await page.locator('#uploadDir').fill('original');
  await page.locator('#uploadMsg').fill('Original upload');
  await page.locator('#forceLfs').check();
  const requests = [];
  await page.route('**/api/repo/sandbox/demo/upload?**', route => {
    requests.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    return route.fulfill(requests.length === 1
      ? { status: 409, json: { error: 'Retry fixture' } }
      : { json: GOOD });
  });
  await selectFiles(page, ['alpha/nested/one.txt', 'beta/two.txt']);
  await expect(page.locator('#uploadQueue .uq-item.error')).toHaveCount(1);
  // The unfixed queue never opens the failure summary; cancel it when present.
  await expect.poll(() => requests.length).toBe(2);
  if (await page.locator('#scrim').isVisible()) await page.locator('#modalCancel').click();
  await page.locator('#uploadDir').fill('different');
  await page.locator('#uploadMsg').fill('Different message');
  await page.locator('#forceLfs').uncheck();
  await page.locator('#uploadMode [data-v="batch"]').click();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toMatchObject({
    path: 'original/alpha/nested/one.txt', branch: 'main', message: 'Original upload', lfs: 'force'
  });
  expect(requests[2].expectedHeadSha).toBe('b'.repeat(40));
  await expect(page.locator('#uploadQueue .uq-item.done')).toHaveCount(2);
});

test('batch selection says queued until the commit actually lands', async ({ page }) => {
  await openUploads(page);
  const writes = [];
  await page.route('**/api/repo/sandbox/demo/*', route => {
    if (route.request().method() === 'GET') return route.fallback();
    writes.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { ...GOOD, sha: 'c'.repeat(40) } });
  });
  await page.locator('#uploadMode [data-v="batch"]').click();
  await selectFiles(page);
  await expect(page.locator('#batchInfo')).toContainText('2 files ready');
  await expect(page.locator('.toast')).toContainText(['2 files queued']);
  expect(writes).toEqual([]);
  await expect(page.locator('#uploadQueue .done')).toHaveCount(0);
  await page.locator('#batchCommitBtn').click();
  await expect(page.locator('#uploadQueue .done')).toHaveCount(2);
  await expect(page.locator('.toast.ok')).toContainText(['2 files landed as one commit']);
  expect(writes).toEqual(['/api/repo/sandbox/demo/blob', '/api/repo/sandbox/demo/blob', '/api/repo/sandbox/demo/batch']);
});

test('unchanged files are reported as skipped, never uploaded', async ({ page }) => {
  await openUploads(page);
  const sha = createHash('sha1').update(`blob ${Buffer.byteLength(CONTENT)}\0${CONTENT}`).digest('hex');
  await page.route('**/api/repo/sandbox/demo/tree?**', route => route.fulfill({ json: [
    { type: 'file', name: 'one.txt', sha }, { type: 'file', name: 'two.txt', sha }
  ] }));
  await selectFiles(page);
  await expect(page.locator('#uploadQueue .v-skip')).toHaveCount(2);
  await expect(page.locator('.toast')).toContainText(['2 files unchanged']);
  await expect(page.locator('.toast.ok')).not.toContainText(['2 files uploaded']);
});

for (const failure of ['network', 'malformed', 'abort']) {
  test(`${failure} failures release the queue and appear in its failure summary`, async ({ page }) => {
    await openUploads(page);
    let sent = 0;
    await page.route('**/api/repo/sandbox/demo/upload?**', route => {
      sent += 1;
      if (failure === 'network') return route.abort('failed');
      return route.fulfill({ status: 200, body: '{invalid' });
    });
    if (failure === 'abort') {
      await page.evaluate(() => {
        const open = XMLHttpRequest.prototype.open;
        const send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__abortUpload = /\/upload\?/.test(String(url));
          return open.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(body) {
          send.call(this, body);
          if (this.__abortUpload) this.abort();
        };
      });
    }
    await selectFiles(page);
    await expect(page.locator('#modalTitle')).toHaveText("2 of 2 didn't upload");
    await expect(page.locator('#uploadQueue .uq-item.error')).toHaveCount(2);
    if (failure !== 'abort') expect(sent).toBe(2);
    await expect(page.locator('.toast.ok')).not.toContainText(['2 files uploaded']);
  });
}

test('files exceeding the limit are failures in the summary', async ({ page }) => {
  await openUploads(page);
  await page.evaluate(() => { state.runtime.uploadMaxMb = 0; });
  await selectFiles(page);
  await expect(page.locator('#modalTitle')).toHaveText("2 of 2 didn't upload");
  await expect(page.locator('#modalBody')).toContainText('per-file limit');
  await expect(page.locator('.toast.ok')).not.toContainText(['2 files uploaded']);
});

test('form changes during a queue do not retarget the remaining files', async ({ page }) => {
  await openUploads(page);
  await page.locator('#uploadDir').fill('original');
  const paths = [];
  await page.route('**/api/repo/sandbox/demo/upload?**', async route => {
    paths.push(new URL(route.request().url()).searchParams.get('path'));
    await page.locator('#uploadDir').evaluate(el => { el.value = 'different'; });
    return route.fulfill({ json: GOOD });
  });
  await selectFiles(page);
  await expect(page.locator('#uploadQueue .done')).toHaveCount(2);
  expect(paths).toEqual(['original/one.txt', 'original/two.txt']);
});

test('security-context failure is retryable and is never counted as uploaded', async ({ page }) => {
  await openUploads(page);
  await page.route('**/api/security/csrf', route => route.fulfill({
    status: 503, json: { error: 'Security context unavailable' }
  }));
  await selectFiles(page, ['one.txt']);
  await expect(page.locator('#modalTitle')).toHaveText("1 of 1 didn't upload");
  await expect(page.locator('#uploadQueue .error')).toContainText('Security context unavailable');
  await page.locator('#modalCancel').click();
  await page.route('**/api/security/csrf', route => route.fulfill({ json: {
    token: 'upload-retry-fixture', expiresAt: new Date(Date.now() + 600000).toISOString()
  } }));
  await page.route('**/api/repo/sandbox/demo/upload?**', route => route.fulfill({ json: GOOD }));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('#uploadQueue .done')).toHaveCount(1);
});

test('an account change during preparation prevents an upload under the new account', async ({ page }) => {
  await openUploads(page);
  const writes = [];
  await page.route('**/api/repo/sandbox/demo/upload?**', route => {
    writes.push(route.request().url());
    return route.fulfill({ json: GOOD });
  });
  await page.route('**/api/security/csrf', async route => {
    await page.evaluate(() => { state.me.offlineCacheScope = 'different-account-scope'; });
    return route.fulfill({ json: {
      token: 'upload-account-fixture', expiresAt: new Date(Date.now() + 600000).toISOString()
    } });
  });
  await selectFiles(page, ['one.txt']);
  await expect(page.locator('#modalTitle')).toHaveText("1 of 1 didn't upload");
  await expect(page.locator('#modalBody')).toContainText('Return to the original account');
  expect(writes).toEqual([]);
});
