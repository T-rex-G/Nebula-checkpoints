'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

/* Without this the page can run a cached app.js and measure yesterday's code. */
test.use({ serviceWorkers: 'block' });

/*
 * The batch bar's commit button must contain its own label.
 *
 * Reported from a phone: "Commit all as one" spills past the pill, clipped at
 * both edges, while the sentence beside it wraps to two lines.
 *
 * The cause is a pair of rules that only misbehave together. `.batch-bar` is a
 * flex row, and a flex item's default `min-width: auto` normally stops it
 * shrinking below its content. `.btn.small` overrides that with
 * `min-width: 0` and adds `white-space: nowrap`. So on a narrow screen the
 * button is free to shrink below its text, and the text -- forbidden to wrap
 * -- overflows the box it was given.
 *
 * Measured at the element rather than by screenshot: a label that fits has
 * scrollWidth no wider than clientWidth. This is the check, not a pixel
 * comparison, because the symptom is layout overflow and that is exactly what
 * those two properties disagree about when it happens.
 */
const PHONE = { width: 390, height: 844 };

/*
 * Reached the way a user reaches it -- sign in, open a repository, switch to
 * the push surface, queue files in batch mode -- so the bar is laid out inside
 * its real container at its real width. Forcing `hidden = false` on a detached
 * screen measures a box the user never sees.
 */
const QUEUED = ['one.txt', 'two.txt', 'three.txt'];

async function revealBatchBar(page) {
  await page.setViewportSize(PHONE);
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await ui.enterRepositories(page);
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
  await page.evaluate(() => { if (window.switchTab) window.switchTab('upload'); });
  await page.locator('#uploadMode [data-v="batch"]').click();
  await page.locator('#filePicker').waitFor({ state: 'attached' });
  await page.locator('#filePicker').setInputFiles(QUEUED.map(name => ({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(`contents of ${name}\n`, 'utf8')
  })));
  await expect(page.locator('#batchCommitBtn')).toBeVisible();
  /*
   * The sentence at the length the report showed. The button competes for
   * width against the same text a user actually sees, and a shorter one would
   * leave room the real bar does not have.
   */
  await page.evaluate(() => {
    document.getElementById('batchInfo').textContent =
      '15 files ready — will land as one commit on main';
  });
}

test('the batch commit button contains its own label on a phone', async ({ page }) => {
  await revealBatchBar(page);

  const fit = await page.evaluate(() => {
    const btn = document.getElementById('batchCommitBtn');
    const bar = document.getElementById('batchBar');
    return {
      overflow: btn.scrollWidth - btn.clientWidth,
      barOverflow: bar.scrollWidth - bar.clientWidth,
      label: btn.textContent.trim()
    };
  });

  expect(fit.label).toContain('Commit all as one');
  expect(fit.overflow,
    `the label overflows its button by ${fit.overflow}px — it is being clipped`).toBeLessThanOrEqual(0);
  expect(fit.barOverflow,
    `the batch bar itself overflows its row by ${fit.barOverflow}px`).toBeLessThanOrEqual(0);
});

/*
 * The narrowest screen the rest of the interface is held to. A button that
 * merely stops clipping at 390 and clips again at 320 has not been fixed.
 */
test('the batch commit button still contains its label at 320px', async ({ page }) => {
  await revealBatchBar(page);
  await page.setViewportSize({ width: 320, height: 720 });

  const fit = await page.evaluate(() => {
    const btn = document.getElementById('batchCommitBtn');
    const bar = document.getElementById('batchBar');
    return {
      overflow: btn.scrollWidth - btn.clientWidth,
      barOverflow: bar.scrollWidth - bar.clientWidth
    };
  });

  expect(fit.overflow, `the label overflows its button by ${fit.overflow}px at 320`).toBeLessThanOrEqual(0);
  expect(fit.barOverflow, `the batch bar overflows its row by ${fit.barOverflow}px at 320`).toBeLessThanOrEqual(0);
});
