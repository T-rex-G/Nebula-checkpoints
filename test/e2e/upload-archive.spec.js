'use strict';

/*
 * A zip pushed to the repository is checked before anything in it is
 * extracted. Its central directory is read and every entry's path is
 * validated first (apps/web/src/features/workbench/archive-safety.js,
 * test/archive-safety.test.js); an entry that would climb out of the
 * folder it is extracted into refuses the whole archive, and nothing from
 * it is queued or sent. A well-formed archive is extracted and queued, so
 * the refusal is the validator at work rather than extraction that never
 * runs.
 */

const zlib = require('node:zlib');
const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/* A stored (uncompressed) zip of [name, text] entries, names in UTF-8. */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const path = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, path, data);
    centrals.push(central, path);
    offset += local.length + path.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function pushArchive(page, buffer) {
  const writes = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' && url.pathname.startsWith('/api/repo/sandbox/demo/')) writes.push(`${request.method()} ${url.pathname}`);
  });
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await ui.openTab(page, 'upload');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#zipUploadBtn').click();
  await (await chooser).setFiles({ name: 'release.zip', mimeType: 'application/zip', buffer });
  await expect(ui.dialog(page, 'Zip archive')).toBeVisible();
  await expect(page.locator('#zipExtract')).toBeChecked();
  await page.locator('#modalOk').click();
  return writes;
}

test('an archive with an entry that climbs out of its folder is refused whole, and nothing is queued', async ({ page }) => {
  const writes = await pushArchive(page, zipOf([['notes.txt', 'kept\n'], ['../escape.txt', 'outside\n']]));
  await expect(page.locator('.toast').last()).toContainText('Extraction failed: Unsafe archive file path traversal');
  await expect(page.locator('#uploadQueue .uq-item')).toHaveCount(0);
  expect(writes).toEqual([]);
});

/*
 * Two entries whose names differ only in case are one file on a checkout that
 * ignores case, and which of them lands would be decided by the order they
 * unpack in. The central directory's validation refuses the archive whole,
 * before anything is extracted; the local headers alone would not.
 */
test('an archive with two entries that differ only in case is refused whole, and nothing is queued', async ({ page }) => {
  const writes = await pushArchive(page, zipOf([['README.md', 'one\n'], ['readme.md', 'two\n']]));
  await expect(page.locator('.toast').last()).toContainText('Extraction failed: Duplicate archive path: readme.md');
  await expect(page.locator('#uploadQueue .uq-item')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('a well-formed archive is extracted and its files queued', async ({ page }) => {
  await pushArchive(page, zipOf([['notes.txt', 'kept\n'], ['readme.txt', 'also kept\n']]));
  await expect(page.locator('#uploadQueue .uq-item')).toHaveCount(2);
  await expect(page.locator('#uploadQueue .uq-name')).toHaveText(['readme.txt', 'notes.txt']);
});
