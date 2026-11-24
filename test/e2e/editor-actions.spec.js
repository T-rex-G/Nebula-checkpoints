'use strict';

const { test, expect } = require('@playwright/test');
const { HEAD_SHA, mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/*
 * A file's own actions in the editor, each for the file it was asked for: an
 * edit made while a commit is out stays an edit, offered to be committed and
 * kept as a draft; a commit answered after another file was opened leaves
 * that file as it was; a path with quotes in it is the commit message's text,
 * never markup; a rename carries edits not yet committed to the new path; a
 * refused rename is said in full; a commit without a message is still in the
 * history, each with its time, and the history is written only into its own
 * dialog; staging -- even a moment after an edit -- and an offline commit
 * leave nothing to commit or restore; a deletion can be staged instead; a
 * file deleted is no longer offered by the palette and the tree is read
 * again; a commit over a newer version reads the repository again; and a
 * commit names the branch head it was made on, the head it made is the next
 * one's, and the rate is read again after it.
 */

const FILES = { 'src/a.js': 'const a = 1;\n', 'src/b.js': 'const b = 2;\n', 'lib/a.js': 'const a = 1;\n', 'src/q"uote.js': 'const q = 1;\n' };
const shaOf = path => Buffer.from(path).toString('hex').padEnd(40, '0').slice(0, 40);
async function files(page, { put, rename, commits } = {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const sent = [];
  /* Every read the page makes, by path, for the checks of what it reads again. */
  sent.reads = [];
  page.on('request', request => { if (request.method() === 'GET') sent.reads.push(new URL(request.url()).pathname); });
  /* The provider's version of each file: a commit it takes is its version from then on. */
  const versions = {};
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/file', async route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      sent.push(body);
      versions[body.path] = 'e'.repeat(40);
      return put ? put(route, body) : route.fulfill({ json: { sha: 'e'.repeat(40), commit: 'c'.repeat(40) } });
    }
    const path = new URL(request.url()).searchParams.get('path');
    const text = FILES[path] || '';
    return route.fulfill({ json: { path, sha: versions[path] || shaOf(path), size: text.length, content: Buffer.from(text).toString('base64') } });
  });
  if (rename) await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/rename', rename);
  if (commits) await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/commits', route => route.fulfill({ json: commits }));
  return sent;
}
const editorText = page => page.evaluate(() => {
  const editor = document.querySelector('#tab-editor .CodeMirror');
  return editor && editor.CodeMirror ? editor.CodeMirror.getValue() : null;
});
const type = (page, text) => page.evaluate(words => document.querySelector('#tab-editor .CodeMirror').CodeMirror.replaceRange(words, { line: 0, ch: 0 }), text);
const press = (page, id) => page.evaluate(selector => document.querySelector(selector).click(), id);
const drafts = page => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('nv_draft:')).map(([key, value]) => [key, JSON.parse(value).content])));
async function open(page, path) {
  await page.goto(`/#/sandbox/demo@main/editor/${path}`);
  await expect.poll(() => editorText(page)).toBe(FILES[path]);
}
async function commit(page) {
  await press(page, '#commitFileBtn');
  await ui.button(ui.dialog(page, 'Commit changes'), 'Commit \u2726').click();
}

test('an edit made while a commit is out stays an edit: Commit is offered again and its draft kept', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = await files(page, { put: async route => { await gate; return route.fulfill({ json: { sha: 'e'.repeat(40), commit: 'c'.repeat(40) } }); } });
  await open(page, 'src/a.js');
  await type(page, '// first\n');
  const rates = () => sent.reads.filter(path => path === '/api/rate').length;
  const ratesBefore = rates();
  await commit(page);
  await expect.poll(() => sent.length).toBe(1);
  await type(page, '// second\n');
  await page.waitForTimeout(800);
  release();
  await expect(page.locator('.toast.ok').filter({ hasText: 'Committed' })).toBeVisible();
  expect(sent[0].content).toBe('// first\nconst a = 1;\n');
  await expect(page.locator('#commitFileBtn')).toBeEnabled();
  await expect(page.locator('#stageFileBtn')).toBeEnabled();
  expect(await drafts(page)).toEqual({ 'nv_draft:sandbox/demo@main:src/a.js': '// second\n// first\nconst a = 1;\n' });
  expect(sent[0].expectedHeadSha).toBe(HEAD_SHA);
  await expect.poll(rates).toBeGreaterThan(ratesBefore);
  await commit(page);
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ path: 'src/a.js', content: '// second\n// first\nconst a = 1;\n', sha: 'e'.repeat(40), expectedHeadSha: 'c'.repeat(40) });
  await expect(page.locator('.toast.ok').filter({ hasText: 'Committed' })).toHaveCount(2);
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
  expect(await drafts(page)).toEqual({});
});

test('a commit puts away the offer of an older draft, and a commit over a newer version reads the repository again', async ({ page }) => {
  const sent = await files(page);
  await page.addInitScript(() => { localStorage.setItem('nv_draft:sandbox/demo@main:src/a.js', JSON.stringify({ content: 'const a = 0;\n', t: Date.now() - 60000 })); });
  await open(page, 'src/a.js');
  await expect(page.locator('#draftBar')).toBeVisible();
  await type(page, '// mine\n');
  /* The provider has a newer version than the one opened. */
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/file', route => (route.request().method() === 'GET'
    ? route.fulfill({ json: { path: 'src/a.js', sha: 'f'.repeat(40), size: 13, content: Buffer.from('const a = 1;\n').toString('base64') } })
    : route.fallback()));
  const before = sent.reads.filter(path => path === '/api/repo/sandbox/demo').length;
  await commit(page);
  await ui.button(ui.dialog(page, 'File changed on GitHub'), 'Overwrite anyway').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].sha).toBe('f'.repeat(40));
  expect(sent.reads.filter(path => path === '/api/repo/sandbox/demo').length).toBeGreaterThan(before);
  await expect(page.locator('.toast.ok').filter({ hasText: 'Committed' })).toBeVisible();
  await expect(page.locator('#draftBar')).toHaveCount(0);
});

test('a commit answered after another file was opened leaves that file as it was', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = await files(page, { put: async (route, body) => { if (body.path === 'src/a.js') await gate; return route.fulfill({ json: { sha: 'e'.repeat(40), commit: 'c'.repeat(40) } }); } });
  await open(page, 'src/a.js');
  await type(page, '// a\n');
  await commit(page);
  await expect.poll(() => sent.length).toBe(1);
  await page.evaluate(() => { location.hash = '#/sandbox/demo@main/editor/src/b.js'; });
  await expect.poll(() => editorText(page)).toBe(FILES['src/b.js']);
  release();
  await expect(page.locator('.toast.ok').filter({ hasText: 'Committed' })).toBeVisible();
  await expect(page.locator('#filePath')).toHaveText('src/b.js');
  await type(page, '// b\n');
  await commit(page);
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ path: 'src/b.js', content: '// b\nconst b = 2;\n', sha: shaOf('src/b.js') });
});

test('a path with quotes in it is the commit message\u2019s text, never markup of its own', async ({ page }) => {
  const sent = await files(page);
  await page.goto('/#/sandbox/demo@main/editor/src/q%22uote.js');
  await expect.poll(() => editorText(page)).toBe(FILES['src/q"uote.js']);
  await type(page, '// q\n');
  await press(page, '#commitFileBtn');
  const dialog = ui.dialog(page, 'Commit changes');
  await expect(dialog.locator('#cmMsg')).toHaveValue('Update src/q"uote.js');
  expect(await dialog.locator('#cmMsg').evaluate(input => input.getAttributeNames().sort())).toEqual(['id', 'spellcheck', 'type', 'value']);
  await ui.button(dialog, 'Commit \u2726').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ path: 'src/q"uote.js', message: 'Update src/q"uote.js' });
});

test('a rename carries edits not yet committed to the new path, offered back there', async ({ page }) => {
  const moves = [];
  await files(page, { rename: route => { moves.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, commit: 'r'.repeat(40) } }); } });
  await open(page, 'src/a.js');
  await type(page, '// mine\n');
  await press(page, '#renameFileBtn');
  const dialog = ui.dialog(page, 'Rename / move file');
  await dialog.locator('#rnTo').fill('lib/a.js');
  await ui.button(dialog, 'Rename \u2726').click();
  await expect(page.locator('#filePath')).toHaveText('lib/a.js');
  expect(moves).toEqual([expect.objectContaining({ from: 'src/a.js', to: 'lib/a.js', branch: 'main' })]);
  await expect(page.locator('#draftBar')).toBeVisible();
  expect(await drafts(page)).toEqual({ 'nv_draft:sandbox/demo@main:lib/a.js': '// mine\nconst a = 1;\n' });
  await page.locator('#draftRestore').click();
  await expect.poll(() => editorText(page)).toBe('// mine\nconst a = 1;\n');
  await expect(page.locator('#commitFileBtn')).toBeEnabled();
});

test('a refused rename is said in full, as a refused commit or deletion is', async ({ page }) => {
  await files(page, { rename: route => route.fulfill({ status: 409, json: { error: 'A file already exists at that path.', code: 'conflict' } }) });
  await open(page, 'src/a.js');
  await press(page, '#renameFileBtn');
  const dialog = ui.dialog(page, 'Rename / move file');
  await dialog.locator('#rnTo').fill('src/b.js');
  await ui.button(dialog, 'Rename \u2726').click();
  await expect(page.locator('#trustErrorBackdrop')).toBeVisible();
  await expect(page.locator('#filePath')).toHaveText('src/a.js');
});

test('a commit without a message is still listed in the file\u2019s history', async ({ page }) => {
  await files(page, { commits: [
    { sha: '1'.repeat(40), author: 'Ann', date: new Date(Date.now() - 3600e3).toISOString(), message: 'Fix the sum\nwith a body' },
    { sha: '2'.repeat(40), author: 'Bo', date: new Date(Date.now() - 7200e3).toISOString() }
  ] });
  await open(page, 'src/a.js');
  await press(page, '#fileHistoryBtn');
  const dialog = ui.dialog(page, 'History \u2014 a.js');
  await expect(dialog.locator('.comment')).toHaveCount(2);
  await expect(dialog.locator('.comment-body').first()).toHaveText('Fix the sum');
  await expect(dialog.locator('.commit-sha')).toHaveText(['1111111', '2222222']);
  await expect(dialog.locator('.comment-head')).toContainText(['1h ago', '2h ago']);
  await expect(dialog).not.toContainText('\u26a0');
});

test('a history answered after another dialog was opened is not written into it', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await files(page);
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/commits', async route => { await gate; return route.fulfill({ json: [] }); });
  await open(page, 'src/a.js');
  await press(page, '#fileHistoryBtn');
  await expect(ui.dialog(page, 'History \u2014 a.js')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ui.dialog(page, 'History \u2014 a.js')).toHaveCount(0);
  await press(page, '#renameFileBtn');
  const rename = ui.dialog(page, 'Rename / move file');
  await expect(rename.locator('#rnTo')).toHaveValue('src/a.js');
  release();
  await page.waitForTimeout(600);
  await expect(rename.locator('#rnTo')).toHaveValue('src/a.js');
  await expect(rename).not.toContainText('No history found');
});

test('staging leaves nothing to commit, and an offline commit is queued with nothing left to commit, then sent as queued', async ({ page }) => {
  let offline = true;
  const sent = await files(page, { put: route => (offline ? route.abort('internetdisconnected') : route.fulfill({ json: { sha: 'e'.repeat(40), commit: 'c'.repeat(40) } })) });
  await open(page, 'src/a.js');
  await type(page, '// staged\n');
  await press(page, '#stageFileBtn');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Staged src/a.js' })).toBeVisible();
  await expect(page.locator('#stagedCount')).toHaveText('1');
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
  await expect(page.locator('#stageFileBtn')).toBeDisabled();
  await type(page, '// queued\n');
  await expect(page.locator('#commitFileBtn')).toBeEnabled();
  await commit(page);
  await expect(page.locator('.toast.ok').filter({ hasText: 'commit saved to the offline queue' })).toBeVisible();
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
  await expect(page.locator('#stageFileBtn')).toBeDisabled();
  /* Back online, the queue sends the commit as it was asked for, on the head it was made on. */
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ path: 'src/a.js', content: '// queued\n// staged\nconst a = 1;\n', branch: 'main', expectedHeadSha: HEAD_SHA });
});

test('an edit staged a moment after it was made leaves no draft to restore', async ({ page }) => {
  await files(page);
  await open(page, 'src/a.js');
  await page.evaluate(() => {
    document.querySelector('#tab-editor .CodeMirror').CodeMirror.replaceRange('// quick\n', { line: 0, ch: 0 });
    document.querySelector('#stageFileBtn').click();
  });
  await expect(page.locator('.toast.ok').filter({ hasText: 'Staged src/a.js' })).toBeVisible();
  await page.waitForTimeout(900);
  expect(await drafts(page)).toEqual({});
});

test('a deletion can be staged instead of committed', async ({ page }) => {
  const deletes = [];
  await files(page);
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/file', route => (route.request().method() === 'DELETE' ? (deletes.push(1), route.fulfill({ json: { ok: true } })) : route.fallback()));
  await open(page, 'src/a.js');
  await press(page, '#deleteFileBtn');
  const dialog = ui.dialog(page, 'Delete file');
  await dialog.locator('#delStage').check();
  await ui.button(dialog, 'Delete').click();
  await expect(page.locator('.toast.ok').filter({ hasText: 'Deletion of src/a.js staged' })).toBeVisible();
  await expect(page.locator('#stagedCount')).toHaveText('1');
  await expect(page.locator('#filePath')).toHaveText('src/a.js');
  expect(deletes).toEqual([]);
});

test('a new file is staged from the files, which make way for the staged changes', async ({ page }) => {
  await files(page);
  await page.goto('/#/sandbox/demo@main/files');
  await page.locator('#page-work.active').waitFor();
  /* On a phone the files are a drawer, opened from the bottom bar. */
  if (await page.locator('#bottomNav').isVisible()) {
    await page.locator('#bottomNav button[data-nav="files"]').click();
    await expect(page.locator('#side')).toHaveClass(/\bopen\b/);
  }
  await page.locator('#newFileBtn').click();
  const dialog = ui.dialog(page, 'New file');
  await dialog.locator('#nfPath').fill('docs/notes.md');
  await ui.button(dialog, 'Stage file').click();
  await expect(page.locator('#stageList')).toContainText('docs/notes.md');
  await expect(page.locator('#stageList')).toBeVisible();
  await expect(page.locator('#side')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#stagedCount')).toHaveText('1');
});

test('a file deleted is no longer offered by the palette', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let deleted = false;
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/files', route => route.fulfill({ json: { files: deleted ? ['src/b.js'] : ['src/a.js', 'src/b.js'], truncated: false } }));
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/file', route => {
    if (route.request().method() === 'DELETE') { deleted = true; return route.fulfill({ json: { ok: true, commit: 'd'.repeat(40) } }); }
    const path = new URL(route.request().url()).searchParams.get('path');
    return route.fulfill({ json: { path, sha: shaOf(path), size: 13, content: Buffer.from(FILES[path] || '').toString('base64') } });
  });
  const trees = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/repo/sandbox/demo/tree') trees.push(1); });
  await page.goto('/#/sandbox/demo@main/files');
  await page.locator('#page-work.active').waitFor();
  await ui.openFileByName(page, 'src/a.js');
  await expect.poll(() => editorText(page)).toBe(FILES['src/a.js']);
  const treesBefore = trees.length;
  await press(page, '#deleteFileBtn');
  await ui.button(ui.dialog(page, 'Delete file'), 'Delete').click();
  await expect(page.locator('.toast.ok').filter({ hasText: 'File deleted' })).toBeVisible();
  await expect(page.locator('#editorShell')).toBeHidden();
  await expect.poll(() => trees.length).toBeGreaterThan(treesBefore);
  await (await ui.action(page, 'Command palette')).click();
  await page.locator('#paletteInput').fill('.js');
  await expect(page.locator('#paletteList .pal-item span.mono')).toHaveText(['src/b.js']);
});
