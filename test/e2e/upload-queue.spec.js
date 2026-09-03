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
    .toBeGreaterThan(1);

  const flight = await page.evaluate(() => window.__uploadFlight);
  expect(
    flight.peak,
    `${flight.peak} uploads were in flight at once out of ${flight.sent} sent; `
    + 'a queue that does not wait for each reply sends every file against the same head sha, '
    + 'so the first commit lands and the provider refuses the rest as stale'
  ).toBe(1);
});
