'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/*
 * A file opened in the editor while another is open or still being read: the
 * editor never shows one file's text under another's name; the file before
 * never has the editor's placeholder kept as its draft; and a file that
 * cannot be read leaves nothing to commit -- least of all an empty version
 * of the file open before it. And what opening shows: a text file with its
 * size and the mode its name implies, a draft kept from before offered back;
 * an image previewed rather than edited; a Git LFS pointer and a file too
 * large for the editor offered as downloads; the last file's find bar, draft
 * bar and edits put away; a file opened from another tool shown in the
 * editor, the address rewritten for it, and kept among the recent files; and a
 * file deleted closed.
 */

const FILES = { 'src/a.js': 'const a = 1;\n', 'src/b.js': 'const b = 2;\n' };
async function files(page, { slow = {}, fail = {}, answers = {} } = {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/file', async route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (slow[path]) await new Promise(resolve => setTimeout(resolve, slow[path]));
    if (fail[path]) return route.fulfill({ status: 500, json: { error: 'The file could not be read.' } });
    if (route.request().method() === 'DELETE') return route.fulfill({ json: { ok: true, commit: { sha: 'd'.repeat(40) } } });
    if (answers[path]) return route.fulfill({ json: answers[path] });
    const text = FILES[path] || '';
    return route.fulfill({ json: { path, sha: `${path.replace(/\W/g, '')}`.padEnd(40, '0').slice(0, 40), size: text.length, content: Buffer.from(text).toString('base64') } });
  });
}
const editorText = page => page.evaluate(() => {
  const editor = document.querySelector('#tab-editor .CodeMirror');
  return editor && editor.CodeMirror ? editor.CodeMirror.getValue() : null;
});
const openByAddress = (page, path) => page.evaluate(to => { location.hash = `#/sandbox/demo@main/editor/${to}`; }, path);

test('a file answered after another was opened does not take its place', async ({ page }) => {
  await files(page, { slow: { 'src/a.js': 2500 } });
  await page.goto('/#/sandbox/demo@main/editor/src/a.js');
  await expect(page.locator('#filePath')).toHaveText('src/a.js');
  await openByAddress(page, 'src/b.js');
  await expect.poll(() => editorText(page)).toBe('const b = 2;\n');
  await page.waitForTimeout(3000);
  await expect(page.locator('#filePath')).toHaveText('src/b.js');
  expect(await editorText(page)).toBe('const b = 2;\n');
});

test('the file open before is never left a draft of the editor\u2019s placeholder', async ({ page }) => {
  await files(page, { slow: { 'src/b.js': 2500 } });
  await page.goto('/#/sandbox/demo@main/editor/src/a.js');
  await expect.poll(() => editorText(page)).toBe('const a = 1;\n');
  await openByAddress(page, 'src/b.js');
  await page.waitForTimeout(1500);
  const drafts = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('nv_draft:')));
  expect(drafts).toEqual([]);
  await expect.poll(() => editorText(page)).toBe('const b = 2;\n');
});

test('a file that cannot be read leaves nothing to commit, not an empty version of the file before', async ({ page }) => {
  await files(page, { fail: { 'src/b.js': true } });
  await page.goto('/#/sandbox/demo@main/editor/src/a.js');
  await expect.poll(() => editorText(page)).toBe('const a = 1;\n');
  await openByAddress(page, 'src/b.js');
  await expect(page.locator('.toast', { hasText: 'The file could not be read.' })).toBeVisible();
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
  await expect(page.locator('#stageFileBtn')).toBeDisabled();
});

test('a text file opens with its size and its mode, and a draft kept from before is offered back', async ({ page }) => {
  await files(page);
  await page.addInitScript(() => { localStorage.setItem('nv_draft:sandbox/demo@main:src/a.js', JSON.stringify({ content: 'const a = 2;\n', t: Date.now() - 60000 })); });
  await page.goto('/#/sandbox/demo@main/editor/src/a.js');
  await expect.poll(() => editorText(page)).toBe('const a = 1;\n');
  await expect(page.locator('#fileSize')).not.toHaveText('');
  expect(await page.evaluate(() => document.querySelector('#tab-editor .CodeMirror').CodeMirror.getOption('mode'))).toBe('text/javascript');
  await expect(page.locator('#draftBar')).toContainText('Unsaved draft from');
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
});

test('an image is previewed, not edited', async ({ page }) => {
  await files(page, { answers: { 'art/logo.png': { path: 'art/logo.png', sha: 'f'.repeat(40), size: 2048 } } });
  await page.goto('/#/sandbox/demo@main/editor/art/logo.png');
  const preview = page.locator('#binaryPreview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('img')).toHaveAttribute('src', '/api/repo/sandbox/demo/raw?ref=main&path=art%2Flogo.png');
  await expect(page.locator('#editorHost')).toBeHidden();
  await expect(page.locator('#fileSize')).not.toHaveText('');
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
});

test('a Git LFS pointer and a file too large for the editor are offered as downloads', async ({ page }) => {
  await files(page, { answers: {
    'media/big.bin': { path: 'media/big.bin', sha: 'a'.repeat(40), size: 9000000, lfs: true },
    'data/huge.json': { path: 'data/huge.json', sha: 'b'.repeat(40), size: 7000000, tooLarge: true }
  } });
  await page.goto('/#/sandbox/demo@main/editor/media/big.bin');
  const preview = page.locator('#binaryPreview');
  await expect(preview).toContainText('Git LFS object');
  await expect(preview.getByRole('link', { name: /^Download/ })).toHaveAttribute('href', '/api/repo/sandbox/demo/raw?ref=main&path=media%2Fbig.bin');
  await expect(page.locator('#fileSize')).toContainText('LFS');
  await openByAddress(page, 'data/huge.json');
  await expect(preview).toContainText('too large for the in-browser editor');
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
});

test('opening another file puts the last one away: its find bar, its draft bar and its edits', async ({ page }) => {
  await files(page, { slow: { 'src/b.js': 1500 } });
  await page.addInitScript(() => { localStorage.setItem('nv_draft:sandbox/demo@main:src/a.js', JSON.stringify({ content: 'const a = 2;\n', t: Date.now() - 60000 })); });
  await page.goto('/#/sandbox/demo@main/editor/src/a.js');
  await expect(page.locator('#draftBar')).toBeVisible();
  await page.evaluate(() => document.querySelector('#findBtn').click());
  await expect(page.locator('#findBar')).toBeVisible();
  await page.evaluate(() => document.querySelector('#tab-editor .CodeMirror').CodeMirror.replaceRange('// edited\n', { line: 0, ch: 0 }));
  await expect(page.locator('#commitFileBtn')).toBeEnabled();
  await openByAddress(page, 'src/b.js');
  await expect(page.locator('#findBar')).toBeHidden();
  await expect(page.locator('#draftBar')).toHaveCount(0);
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
  await expect.poll(() => editorText(page)).toBe('const b = 2;\n');
});

test('a file named in the address of another tool is shown in the editor, the address rewritten for it, and kept among the recent files', async ({ page }) => {
  await files(page);
  await page.goto('/#/sandbox/demo@main/commits/src/a.js');
  await expect(page.locator('#tab-editor')).toBeVisible();
  await expect.poll(() => editorText(page)).toBe('const a = 1;\n');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/sandbox/demo@main/editor/src%2Fa.js');
  await openByAddress(page, 'src/b.js');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('nv_recent:sandbox/demo') || '[]'))).toEqual(['src/b.js', 'src/a.js']);
});

test('a file deleted is closed', async ({ page }) => {
  await files(page);
  await page.goto('/#/sandbox/demo@main/editor/src/a.js');
  await expect.poll(() => editorText(page)).toBe('const a = 1;\n');
  await page.evaluate(() => document.querySelector('#deleteFileBtn').click());
  await ui.dialog(page, 'Delete file').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#editorEmpty')).toBeVisible();
  await expect(page.locator('#editorShell')).toBeHidden();
});
