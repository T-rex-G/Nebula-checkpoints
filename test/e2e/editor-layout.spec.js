'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * The editor's own bar where a reader meets it: at the top of the editor,
 * above the file's first line rather than over it; a draft offered back
 * under it, its buttons there to be pressed; and the find bar straight under
 * it. On a desk the editor's pane scrolls by itself, so the bar keeps to the
 * top of that pane; on a phone the page scrolls, and the bar stays under the
 * page's own bar.
 */

const TEXT = `${Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n')}\n`;
async function open(page, draft) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/file', route => route.fulfill({
    json: { path: 'src/a.js', sha: 'a'.repeat(40), size: TEXT.length, content: Buffer.from(TEXT).toString('base64') }
  }));
  if (draft) await page.addInitScript(text => { localStorage.setItem('nv_draft:sandbox/demo@main:src/a.js', JSON.stringify({ content: text, t: Date.now() - 60000 })); }, draft);
  await page.goto('/#/sandbox/demo@main/editor/src/a.js');
  await expect(page.locator('#tab-editor .CodeMirror-line').first()).toHaveText('const line1 = 1;');
  /* The editor settles into its laid-out size a frame or two after it opens. */
  await page.waitForTimeout(400);
}
const box = (page, selector) => page.locator(selector).first().evaluate(element => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
});
/* What a pointer at the middle of an element meets there: the element itself, or what lies over it. */
const meets = (page, selector) => page.locator(selector).first().evaluate((element, wanted) => {
  const rect = element.getBoundingClientRect();
  const found = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 24), rect.top + rect.height / 2);
  return Boolean(found && (found === element || element.contains(found) || found.closest(wanted) === element));
}, selector);

test('the editor\u2019s bar sits at the top of the editor, over none of the file', async ({ page }, testInfo) => {
  await open(page);
  /* On a desk, at a width with the side rail and at one without it, where the editor's pane still scrolls by itself. */
  for (const width of testInfo.project.name === 'desktop' ? [1280, 1000] : [0]) {
    if (width) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(300);
    }
    const shell = await box(page, '#editorShell');
    const bar = await box(page, '.editor-bar');
    const first = await box(page, '#tab-editor .CodeMirror-line');
    expect(Math.abs(bar.top - shell.top), `the bar at the top of the editor at ${width || 'phone'} width`).toBeLessThanOrEqual(2);
    expect(first.top).toBeGreaterThanOrEqual(bar.bottom - 1);
    expect(await meets(page, '#tab-editor .CodeMirror-line')).toBe(true);
    expect(await meets(page, '#commitFileBtn')).toBe(true);
  }
});

test('a draft offered back sits under the bar, and its buttons can be pressed', async ({ page }) => {
  await open(page, 'const kept = 1;\n');
  await expect(page.locator('#draftBar')).toBeVisible();
  const bar = await box(page, '.editor-bar');
  const draft = await box(page, '#draftBar');
  const first = await box(page, '#tab-editor .CodeMirror-line');
  expect(draft.top).toBeGreaterThanOrEqual(bar.bottom - 1);
  expect(first.top).toBeGreaterThanOrEqual(draft.bottom - 1);
  expect(await meets(page, '#draftRestore')).toBe(true);
  expect(await meets(page, '#draftDiscard')).toBe(true);
  await page.locator('#draftRestore').click();
  await expect(page.locator('#tab-editor .CodeMirror-line').first()).toHaveText('const kept = 1;');
  await expect(page.locator('#draftBar')).toHaveCount(0);
});

test('the find bar opens straight under the editor\u2019s bar', async ({ page }) => {
  await open(page);
  await page.locator('#findBtn').click();
  await expect(page.locator('#findBar')).toBeVisible();
  const bar = await box(page, '.editor-bar');
  const find = await box(page, '#findBar');
  expect(Math.abs(find.top - bar.bottom)).toBeLessThanOrEqual(2);
  expect(await meets(page, '#findInput')).toBe(true);
  await page.locator('#findInput').fill('line3 ');
  await expect(page.locator('#findCount')).toContainText('1');
});

test('read further down, the bar stays at the top of the editor, the find bar under it', async ({ page }) => {
  await open(page);
  await page.locator('#findBtn').click();
  await page.locator('#findInput').fill('line90 ');
  await page.locator('#findInput').press('Enter');
  /* On a phone the page scrolls; on a desk the editor scrolls within its pane, which stays put. */
  await page.evaluate(() => { window.scrollBy(0, 600); document.querySelector('#tab-editor').scrollBy(0, 600); });
  await page.waitForTimeout(200);
  const bar = await box(page, '.editor-bar');
  const find = await box(page, '#findBar');
  const top = await page.evaluate(() => {
    const own = document.querySelector('#tab-editor');
    const scrolls = getComputedStyle(own).overflowY !== 'visible';
    return scrolls ? own.getBoundingClientRect().top : document.querySelector('#page-work .topbar').getBoundingClientRect().bottom;
  });
  expect(bar.top).toBeGreaterThanOrEqual(top - 1);
  expect(bar.top).toBeLessThanOrEqual(top + 14);
  expect(Math.abs(find.top - bar.bottom)).toBeLessThanOrEqual(2);
  expect(await meets(page, '#commitFileBtn')).toBe(true);
  expect(await meets(page, '#findInput')).toBe(true);
});

/* Each look the reader can choose: the bars over the file are solid in all of them, so the code does not show through, and in the look's own colour. */
for (const [design, theme] of [['nebula', 'dark'], ['nebula', 'light'], ['obsidian', 'dark'], ['obsidian', 'light']]) {
  test(`in ${design}, ${theme}, the editor's bar and the find bar are solid over the file`, async ({ page }) => {
    await page.addInitScript(([chosen, shade]) => {
      localStorage.setItem('nv_settings', JSON.stringify({ design: chosen }));
      localStorage.setItem('nv_theme', shade);
    }, [design, theme]);
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-design', design);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('#findBtn').click();
    await expect(page.locator('#findBar')).toBeVisible();
    const alpha = selector => page.locator(selector).evaluate(element => {
      const colour = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).map(Number);
      return colour.length > 3 ? colour[3] : 1;
    });
    expect(await alpha('.editor-bar')).toBeGreaterThanOrEqual(0.9);
    expect(await alpha('#findBar')).toBeGreaterThanOrEqual(0.9);
    /* One glass: the find bar blurs what passes beneath it as the editor's bar does. */
    const glass = selector => page.locator(selector).evaluate(element => getComputedStyle(element).backdropFilter);
    expect(await glass('#findBar')).toBe(await glass('.editor-bar'));
    expect(await glass('#findBar')).not.toBe('none');
    if (design === 'obsidian' && theme === 'dark') {
      /* Obsidian is neutral: its bars carry no tint of Nebula's indigo. */
      const tint = selector => page.locator(selector).evaluate(element => {
        const [red, green, blue] = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).map(Number);
        return Math.max(red, green, blue) - Math.min(red, green, blue);
      });
      expect(await tint('.editor-bar')).toBeLessThanOrEqual(3);
      expect(await tint('#findBar')).toBeLessThanOrEqual(3);
    }
  });
}
