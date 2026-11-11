'use strict';
const assert = require('assert');
const { normalizeZipPath, validateArchiveEntries, crc32, DEFAULT_LIMITS } = require('../apps/web/src/features/workbench/archive-safety.ts');

assert.strictEqual(normalizeZipPath('project/src/app.js'), 'project/src/app.js');
assert.strictEqual(normalizeZipPath('folder\\nested\\file.txt'), 'folder/nested/file.txt');

assert(DEFAULT_LIMITS.maxFileUncompressed <= 128 * 1024 * 1024, 'Per-file extraction ceiling must remain mobile-safe');
assert(DEFAULT_LIMITS.maxTotalUncompressed <= 256 * 1024 * 1024, 'Total extraction ceiling must remain bounded for mobile browsers');
assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
for (const bad of ['../secret.txt', 'folder/../../secret.txt', '/absolute.txt', 'C:/windows.txt', 'folder\u0000/file.txt', '.', 'folder/']) {
  assert.throws(() => normalizeZipPath(bad), /unsafe|file path|directory/i);
}

const safe = validateArchiveEntries([
  { name: 'src/app.js', method: 8, compressedSize: 100, uncompressedSize: 500 },
  { name: 'README.md', method: 0, compressedSize: 50, uncompressedSize: 50 }
]);
assert.strictEqual(safe.entries.length, 2);
assert.strictEqual(safe.totalUncompressed, 550);
assert.strictEqual(safe.entries[0].name, 'src/app.js');

assert.throws(() => validateArchiveEntries([
  { name: 'a.txt', method: 0, compressedSize: 1, uncompressedSize: 1 },
  { name: 'a.txt', method: 0, compressedSize: 1, uncompressedSize: 1 }
]), /duplicate/i);
assert.throws(() => validateArchiveEntries([
  { name: 'bomb.bin', method: 8, compressedSize: 1, uncompressedSize: 1000 }
], { ...DEFAULT_LIMITS, maxCompressionRatio: 100 }), /compression ratio/i);
assert.throws(() => validateArchiveEntries([
  { name: 'huge.bin', method: 0, compressedSize: 20, uncompressedSize: 20 }
], { ...DEFAULT_LIMITS, maxFileUncompressed: 10 }), /per-file/i);
assert.throws(() => validateArchiveEntries([
  { name: 'a.bin', method: 0, compressedSize: 8, uncompressedSize: 8 },
  { name: 'b.bin', method: 0, compressedSize: 8, uncompressedSize: 8 }
], { ...DEFAULT_LIMITS, maxTotalUncompressed: 10 }), /total extracted/i);
assert.throws(() => validateArchiveEntries(
  Array.from({ length: 501 }, (_, i) => ({ name: `${i}.txt`, method: 0, compressedSize: 1, uncompressedSize: 1 }))
), /500 files/i);
assert.throws(() => validateArchiveEntries([
  { name: 'script.sh', method: 99, compressedSize: 1, uncompressedSize: 1 }
]), /compression method/i);

/* Each refusal says which it is, by a code the intake and the reader's message tell apart. */
function refuses(run, code) {
  assert.throws(run, error => error instanceof Error && error.code === code, `expected ${code}`);
}
refuses(() => normalizeZipPath('../secret.txt'), 'ZIP_UNSAFE_PATH');
refuses(() => normalizeZipPath('/absolute.txt'), 'ZIP_UNSAFE_PATH');
refuses(() => normalizeZipPath('folder/'), 'ZIP_DIRECTORY_ENTRY');
refuses(() => validateArchiveEntries('not a list'), 'ZIP_INVALID_ENTRIES');
refuses(() => validateArchiveEntries([{ name: 'a', method: 0, compressedSize: -1, uncompressedSize: 1 }]), 'ZIP_INVALID_SIZE');
refuses(() => validateArchiveEntries([{ name: 'a', method: 3, compressedSize: 1, uncompressedSize: 1 }]), 'ZIP_UNSUPPORTED_METHOD');
refuses(() => validateArchiveEntries([{ name: 'a', method: 0, compressedSize: 20, uncompressedSize: 20 }], { maxFileUncompressed: 10 }), 'ZIP_FILE_TOO_LARGE');
refuses(() => validateArchiveEntries([{ name: 'a', method: 8, compressedSize: 1, uncompressedSize: 1000 }], { maxCompressionRatio: 100 }), 'ZIP_COMPRESSION_RATIO');
refuses(() => validateArchiveEntries(Array.from({ length: 3 }, (_, i) => ({ name: `${i}`, method: 0, compressedSize: 1, uncompressedSize: 1 })), { maxEntries: 2 }), 'ZIP_TOO_MANY_FILES');
refuses(() => validateArchiveEntries([
  { name: 'a', method: 0, compressedSize: 8, uncompressedSize: 8 }, { name: 'b', method: 0, compressedSize: 8, uncompressedSize: 8 }
], { maxTotalUncompressed: 10 }), 'ZIP_TOTAL_TOO_LARGE');
/* Two names that differ only in case are one file on a case-insensitive disk: refused as a duplicate. */
refuses(() => validateArchiveEntries([
  { name: 'docs/README.md', method: 0, compressedSize: 1, uncompressedSize: 1 },
  { name: 'docs/readme.md', method: 0, compressedSize: 1, uncompressedSize: 1 }
]), 'ZIP_DUPLICATE_PATH');

console.log('archive safety tests passed');
