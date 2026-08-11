'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOMAIN = Buffer.from('nebulaverse-x.release-tree.v1\0', 'utf8');
const MAX_FILES = 20_000;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;
const MAX_PATH_BYTES = 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const FORBIDDEN_SEGMENTS = new Set([
  '.git', '.hg', '.svn', '.superpowers', '.agents', '.codex',
  '.cache', '.npm', '.yarn', '.pnpm-store', '.turbo', '.next',
  'node_modules', 'bower_components', '__MACOSX', 'coverage',
  'playwright-report', 'test-results', '.tmp', 'tmp', '.temp', 'temp',
  'dist', 'build', 'out'
]);
const FORBIDDEN_NAMES = new Set(['.DS_Store', '.eslintcache']);

function fail(message) {
  throw new TypeError(message);
}

function normalizeReleasePath(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    path.posix.normalize(normalized) !== normalized ||
    normalized.split('/').some(part => part === '' || part === '.' || part === '..') ||
    Buffer.byteLength(normalized, 'utf8') > MAX_PATH_BYTES
  ) return null;
  return normalized;
}

function hasForbiddenLocation(normalized) {
  const parts = normalized.split('/');
  if (parts.some(part => FORBIDDEN_SEGMENTS.has(part))) return true;
  if (normalized !== '.env.example' && parts.some(part => part.startsWith('.env'))) return true;
  return normalized === 'staging/evidence' || normalized.startsWith('staging/evidence/');
}

function shouldTraverseReleaseDirectory(relative) {
  const normalized = normalizeReleasePath(relative);
  return normalized !== null && !hasForbiddenLocation(normalized);
}

function shouldIncludeReleasePath(relative) {
  const normalized = normalizeReleasePath(relative);
  if (normalized === null || hasForbiddenLocation(normalized)) return false;
  const parts = normalized.split('/');
  const name = parts[parts.length - 1];
  if (FORBIDDEN_NAMES.has(name) || name.startsWith('._')) return false;
  if (/\.(?:log|zip|sha256)$/i.test(name)) return false;
  if (/-Public-Alpha-(?:Qualification\.json|Closeout\.md)$/i.test(name)) return false;
  if (/(?:provider[-_]?credential|credential[-_]?provider).*\.log$/i.test(name)) return false;
  if (/(?:database|db)[-_]?backup[-_]?manifest(?:\.[^.]+)?$/i.test(name)) return false;
  return true;
}

function discoverReleaseFiles(root) {
  const files = [];
  let entries = 0;
  function visit(directory, prefix, depth) {
    if (depth > MAX_DEPTH) fail('release tree exceeds the safe directory depth');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ENTRIES) fail('release tree exceeds the safe entry limit');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (shouldTraverseReleaseDirectory(relative)) visit(absolute, relative, depth + 1);
        continue;
      }
      if (!shouldIncludeReleasePath(relative)) continue;
      if (entry.isSymbolicLink()) fail(`release tree contains a symbolic link: ${relative}`);
      if (!entry.isFile()) fail(`release tree contains a non-regular entry: ${relative}`);
      files.push(Object.freeze({ absolute, relative }));
      if (files.length > MAX_FILES) fail('release tree exceeds the safe file limit');
    }
  }
  visit(root, '', 0);
  if (!files.length) fail('release tree contains no releasable files');
  files.sort((left, right) => Buffer.from(left.relative).compare(Buffer.from(right.relative)));
  return files;
}

function hashStableFile(hash, file, totalBytes) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file.absolute, flags);
  } catch (error) {
    fail(`release tree cannot open a regular file: ${file.relative}: ${error.code || 'unknown error'}`);
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail(`release tree contains a non-regular entry: ${file.relative}`);
    if (before.size < 0n || before.size > BigInt(MAX_FILE_BYTES)) {
      fail(`release tree file exceeds the safe size limit: ${file.relative}`);
    }
    const nextTotal = totalBytes + Number(before.size);
    if (!Number.isSafeInteger(nextTotal) || nextTotal > MAX_TOTAL_BYTES) {
      fail('release tree exceeds the safe expanded size limit');
    }

    const pathBytes = Buffer.from(file.relative, 'utf8');
    const header = Buffer.alloc(12);
    header.writeUInt32BE(pathBytes.length, 0);
    header.writeBigUInt64BE(before.size, 4);
    hash.update(header);
    hash.update(pathBytes);

    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    const size = Number(before.size);
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
      if (bytesRead === 0) fail(`release tree file changed during hashing: ${file.relative}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) fail(`release tree file changed during hashing: ${file.relative}`);
    return nextTotal;
  } finally {
    fs.closeSync(descriptor);
  }
}

function computeReleaseFingerprint(rootDirectory) {
  const requestedRoot = path.resolve(String(rootDirectory || ''));
  let rootMetadata;
  try {
    rootMetadata = fs.lstatSync(requestedRoot);
  } catch {
    fail('release tree root must be a readable directory');
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail('release tree root must be a non-symlink directory');
  }
  const root = fs.realpathSync(requestedRoot);
  const files = discoverReleaseFiles(root);
  const hash = crypto.createHash('sha256');
  hash.update(DOMAIN);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(files.length, 0);
  hash.update(count);
  let totalBytes = 0;
  for (const file of files) totalBytes = hashStableFile(hash, file, totalBytes);
  return hash.digest('hex');
}

module.exports = Object.freeze({
  computeReleaseFingerprint,
  shouldIncludeReleasePath,
  shouldTraverseReleaseDirectory
});
