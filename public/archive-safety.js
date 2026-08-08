/* Nebulaverse-X ZIP intake guard — path traversal, bomb, duplicate and integrity checks. */
'use strict';
(function universal(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NebulaArchiveSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildArchiveSafety() {
  const DEFAULT_LIMITS = Object.freeze({
    maxEntries: 500,
    maxFileUncompressed: 128 * 1024 * 1024,
    maxTotalUncompressed: 256 * 1024 * 1024,
    maxCompressionRatio: 200,
    maxPathLength: 1024
  });

  function archiveError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function normalizeZipPath(value, limits = DEFAULT_LIMITS) {
    const original = String(value == null ? '' : value);
    if (!original || original.length > limits.maxPathLength || /[\u0000-\u001f\u007f]/.test(original)) {
      throw archiveError('Unsafe or empty archive file path', 'ZIP_UNSAFE_PATH');
    }
    if (/^[\\/]/.test(original) || /^[a-z]:[\\/]/i.test(original)) {
      throw archiveError('Unsafe absolute archive file path', 'ZIP_UNSAFE_PATH');
    }
    const normalized = original.replace(/\\/g, '/').replace(/\/{2,}/g, '/').normalize('NFC');
    if (normalized.endsWith('/')) throw archiveError('Archive directory entries are not extractable files', 'ZIP_DIRECTORY_ENTRY');
    const parts = normalized.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
      throw archiveError('Unsafe archive file path traversal', 'ZIP_UNSAFE_PATH');
    }
    return normalized;
  }

  function finiteSize(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw archiveError(`Invalid ${label} in archive`, 'ZIP_INVALID_SIZE');
    return number;
  }

  function validateArchiveEntries(entries, customLimits = {}) {
    const limits = { ...DEFAULT_LIMITS, ...(customLimits || {}) };
    if (!Array.isArray(entries)) throw archiveError('Archive entry list is invalid', 'ZIP_INVALID_ENTRIES');
    if (entries.length > limits.maxEntries) throw archiveError(`Archive exceeds the ${limits.maxEntries} files limit`, 'ZIP_TOO_MANY_FILES');
    const seen = new Set();
    const clean = [];
    let totalUncompressed = 0;
    for (const source of entries) {
      const method = Number(source && source.method);
      if (![0, 8].includes(method)) throw archiveError(`Unsupported archive compression method (${method})`, 'ZIP_UNSUPPORTED_METHOD');
      const name = normalizeZipPath(source && source.name, limits);
      const collisionKey = name.toLocaleLowerCase('en-US');
      if (seen.has(collisionKey)) throw archiveError(`Duplicate archive path: ${name}`, 'ZIP_DUPLICATE_PATH');
      seen.add(collisionKey);
      const compressedSize = finiteSize(source && source.compressedSize, 'compressed size');
      const uncompressedSize = finiteSize(source && source.uncompressedSize, 'uncompressed size');
      if (uncompressedSize > limits.maxFileUncompressed) {
        throw archiveError(`Archive file exceeds the ${limits.maxFileUncompressed} byte per-file limit: ${name}`, 'ZIP_FILE_TOO_LARGE');
      }
      totalUncompressed += uncompressedSize;
      if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > limits.maxTotalUncompressed) {
        throw archiveError(`Archive exceeds the ${limits.maxTotalUncompressed} byte total extracted limit`, 'ZIP_TOTAL_TOO_LARGE');
      }
      const ratio = uncompressedSize === 0 ? 0 : uncompressedSize / Math.max(1, compressedSize);
      if (ratio > limits.maxCompressionRatio) {
        throw archiveError(`Suspicious archive compression ratio for ${name}`, 'ZIP_COMPRESSION_RATIO');
      }
      clean.push({ ...source, name, method, compressedSize, uncompressedSize });
    }
    return { entries: clean, totalUncompressed, limits };
  }

  let crcTable = null;
  function table() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
    return crcTable;
  }
  function crc32(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    const lookup = table();
    let crc = 0xffffffff;
    for (let i = 0; i < input.length; i += 1) crc = lookup[(crc ^ input[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  return { DEFAULT_LIMITS, normalizeZipPath, validateArchiveEntries, crc32 };
});
