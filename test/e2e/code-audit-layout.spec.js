'use strict';

/*
 * Every word of the audit and of the site check stays whole and inside its
 * box, at every width from a wide desk to the narrowest phone. A word that
 * reaches past its box overlaps its neighbour or runs off the screen; one
 * that is cut loses what it says -- two security headers share their first
 * twenty letters. A cut is allowed only where the reader has a pointer to
 * hover over it and the title it shows carries the words that were cut; on a
 * touch screen nothing may be cut. Each project reads as its own device: the
 * desktop with a pointer, the phone by touch. The repository's site has a
 * long address, so its chip is tested where it is longest.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { riskyResult } = require('./code-audit-risk-fixture');

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 120000 });

const WIDTHS = [1440, 1280, 1024, 900, 768, 600, 480, 393, 360, 320];
const DAY = 864e5;
const LONG_SITE = 'https://staging-eu-west-1.internal-tools.example-company.com';

/* Every text in the two screens that reaches past the box holding it, or is cut by it, as "where «words»". */
function strayWords() {
  const hover = matchMedia('(hover: hover)').matches;
  const words = value => String(value || '').replace(/\s+/g, ' ').trim();
  const found = new Set();
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.data.trim()) continue;
    const element = node.parentElement;
    if (!element || seen.has(element) || !element.closest('#auditRoot, #siteRoot')) continue;
    seen.add(element);
    if (element.closest('[hidden], .sr-only, [inert], details:not([open]) > :not(summary)') || !element.getClientRects().length) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const ink = range.getBoundingClientRect();
    if (!ink.width) continue;
    for (let box = element; box && box !== document.body; box = box.parentElement) {
      const style = getComputedStyle(box);
      if ((style.display.startsWith('inline') && style.overflowX === 'visible') || style.display === 'contents') continue;
      const edges = box.getBoundingClientRect();
      const left = edges.left + parseFloat(style.borderLeftWidth);
      const right = edges.right - parseFloat(style.borderRightWidth);
      if (ink.right > right + 0.75 || ink.left < left - 0.75) {
        const cut = style.overflowX !== 'visible';
        const recovered = cut && hover && words(box.closest('[title]')?.getAttribute('title')).includes(words(node.data));
        if (!recovered) found.add(`${cut ? 'cut' : 'past'} ${String(box.className || box.tagName).split(' ')[0]} «${node.data.trim().slice(0, 40)}»`);
        break;
      }
      if (style.overflowX !== 'visible' || box.matches('.card, li, button, .nv-chip')) break;
    }
  }
  return [...found];
}

/* A page that scrolls sideways shifts every card when something is brought into view. */
function sideways() {
  return [...document.querySelectorAll('#tab-audit, #page-site, #siteRoot, #auditRoot')]
    .filter(node => node.getClientRects().length && node.scrollWidth > node.clientWidth)
    .map(node => `${node.id} scrolls sideways by ${node.scrollWidth - node.clientWidth}px`);
}

async function everyWidth(page) {
  const found = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const word of await page.evaluate(strayWords)) found.push(`${width}: ${word}`);
    for (const pane of await page.evaluate(sideways)) found.push(`${width}: ${pane}`);
  }
  return found;
}

test('every word of the audit and the site check stays whole and inside its box at every width', async ({ page }) => {
  const now = Date.now();
  const kept = riskyResult();
  const keptOn = (daysAgo, score, grade, sha) => ({ ...kept, commitSha: sha.repeat(40), ref: 'main', score, grade, auditedAt: new Date(now - daysAgo * DAY).toISOString() });
  /* Five kept audits and the one run here: six points on the trend, one of them left of the middle with its tip centred on it. */
  await mockPublicAlphaApi(page, {
    access: 'active', repositoryState: 'current', licences: 'copyleft', homepage: LONG_SITE,
    auditHistorySeed: [
      keptOn(30, 41, 'F', '3'), keptOn(20, 48, 'F', '4'), keptOn(12, 52, 'F', '5'), keptOn(8, 55, 'F', '1'),
      { ...keptOn(1, 64, 'D', '2'), capped: false, capReason: null, findings: kept.findings.slice(1) }
    ]
  });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit again' }).click();
  await expect(pane.locator('.audit-grade').first()).toHaveAttribute('aria-label', /^Grade [A-F], /, { timeout: 15000 });
  await expect(pane.locator('.audit-hist-row')).toHaveCount(6);
  /* Opened as a reader opens them: a finding, a kept audit, and the trend's tip on its point. */
  await pane.locator('.audit-item summary').first().click();
  await pane.locator('.audit-trend-dot').nth(1).click();
  await expect(pane.locator('details.audit-hist[open] .audit-hist-finding').first()).toBeVisible();
  /*
   * The latest point's tip is anchored at the plot's right edge, where a
   * narrow screen leaves it least room. Pressed, the point opens its audit,
   * which scrolls into view and moves the point from under the pointer: the
   * tip stays, because the point keeps focus.
   */
  await pane.locator('.audit-trend-dot').last().click();
  await expect(pane.locator('.audit-trend-dot').last()).toBeFocused();
  await expect(pane.locator('.audit-trend-tip')).toBeVisible();
  expect(await everyWidth(page)).toEqual([]);
  /*
   * A point left of the middle has its tip centred on it. On a narrow screen
   * the tip is as wide as the plot, wider than the room on the point's left:
   * it is moved back inside, and kept there as the plot changes width.
   */
  await page.mouse.move(0, 0);
  await pane.locator('.audit-trend-dot').nth(2).focus();
  await expect(pane.locator('.audit-trend-tip')).toHaveText(/Grade F, 52/);
  expect(await everyWidth(page)).toEqual([]);

  await page.setViewportSize({ width: 1280, height: 900 });
  await pane.locator('[data-key="site-open"]').click();
  const card = page.locator('#siteRoot .audit-site');
  await expect(card.locator('.audit-grade')).toHaveAttribute('aria-label', /^Site grade/, { timeout: 15000 });
  await card.locator('[data-key="site-more"]').click();
  await card.locator('.audit-item summary').first().click();
  expect(await everyWidth(page)).toEqual([]);
});
