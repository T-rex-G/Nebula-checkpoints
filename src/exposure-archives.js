'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

/*
 * Reading inside an archive without unpacking it anywhere.
 *
 * A committed `.zip`, `.jar` or `.tar.gz` is a directory tree somebody
 * compressed, and a credential inside it is as exposed as one beside it: the
 * archive is one download away from anyone who can read the repository. It
 * used to be skipped as binary, which means every `.env` shipped inside a
 * build artefact was reported as "not read" at best.
 *
 * Nothing is written to disk and nothing inside is run or followed. The bytes
 * the provider returned are parsed in memory, every size is checked before
 * anything is inflated, and inflating is capped by the output it may produce
 * rather than by what the archive claims -- a zip bomb declares small sizes
 * and inflates to gigabytes, and `maxOutputLength` stops it at the ceiling
 * whatever it declared. One level only: an archive inside an archive is
 * reported as not read, never opened.
 *
 * A member's location is `<archive path>!/<member path>`, the notation Java
 * and most scanners use, so a finding names the archive and the file inside
 * it and is a different finding from the same credential anywhere else.
 */

/* What an archive is, by name. Office documents and Python wheels are zips. */
const ZIP_EXTENSIONS = new Set([
  'zip', 'jar', 'war', 'ear', 'whl', 'nupkg', 'apk', 'aab', 'xpi', 'vsix',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'
]);

/*
 * Ceilings, each a number this one free service can afford. An archive is
 * fetched as base64 inside JSON, so the compressed ceiling is a third below
 * the transport's response bound.
 */
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 2_000;
const MAX_MEMBER_BYTES = 512 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_MEMBER_PATH = 1024;

const MEMBER_SKIPS = Object.freeze({
  BINARY: 'binary',
  OVERSIZE: 'oversize',
  NESTED: 'nested-archive',
  ENCRYPTED: 'encrypted',
  UNSAFE_PATH: 'unsafe-path',
  UNREADABLE: 'unreadable'
});

function extensionOf(filePath) {
  const name = String(filePath || '').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/* 'zip', 'tar', 'tgz', 'gz' or null. */
function archiveKind(filePath) {
  const name = String(filePath || '').toLowerCase();
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'tgz';
  if (name.endsWith('.tar')) return 'tar';
  if (name.endsWith('.gz')) return 'gz';
  return ZIP_EXTENSIONS.has(extensionOf(name)) ? 'zip' : null;
}

/*
 * A member path is bytes somebody else chose, like a tree path, and it is
 * held to the same rules: relative, no `..`, no control characters, no
 * backslash, no drive letter. A member that fails is counted and not read.
 */
function safeMemberPath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_MEMBER_PATH) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\')) return false;
  return !value.split('/').some(segment => segment === '' || segment === '.' || segment === '..');
}

function memberRecord(archivePath, inner) {
  const location = `${archivePath}!/${inner}`;
  return location.length <= MAX_MEMBER_PATH ? location : null;
}

/*
 * What one member is. `decodeText` is the reader's own text rule -- UTF-8,
 * UTF-16, a NUL means binary, an LFS pointer is not content -- passed in so an
 * archive's files are read exactly as the repository's are.
 */
function memberOutcome(state, archivePath, inner, readBytes, declaredSize, decodeText, binaryExtensions) {
  if (!safeMemberPath(inner)) return state.skip(MEMBER_SKIPS.UNSAFE_PATH);
  const location = memberRecord(archivePath, inner);
  if (!location) return state.skip(MEMBER_SKIPS.UNSAFE_PATH);
  if (archiveKind(inner)) return state.skip(MEMBER_SKIPS.NESTED);
  const extension = extensionOf(inner);
  if (state.pathRuleExtensions.has(extension)) {
    /* A keystore inside an archive is an exposure by its name, like one in
       the tree. Its identity is a digest of its stored bytes, which is the
       same whenever the same archive is scanned. */
    const raw = readBytes('raw');
    if (!raw) return state.skip(MEMBER_SKIPS.UNREADABLE);
    state.named.push(Object.freeze({ path: location, sha: crypto.createHash('sha256').update(raw).digest('hex') }));
    return null;
  }
  if (binaryExtensions.has(extension)) return state.skip(MEMBER_SKIPS.BINARY);
  if (Number.isInteger(declaredSize) && declaredSize > MAX_MEMBER_BYTES) return state.skip(MEMBER_SKIPS.OVERSIZE);
  if (state.expanded >= MAX_EXPANDED_BYTES) return state.skip(MEMBER_SKIPS.OVERSIZE);
  const bytes = readBytes('inflated');
  if (bytes === 'oversize') return state.skip(MEMBER_SKIPS.OVERSIZE);
  if (!bytes) return state.skip(MEMBER_SKIPS.UNREADABLE);
  state.expanded += bytes.length;
  if (state.expanded > MAX_EXPANDED_BYTES) return state.skip(MEMBER_SKIPS.OVERSIZE);
  const decoded = decodeText(bytes);
  if (!decoded || typeof decoded.text !== 'string') return state.skip(decoded && decoded.skip === 'binary' ? MEMBER_SKIPS.BINARY : MEMBER_SKIPS.UNREADABLE);
  state.members.push(Object.freeze({ path: location, text: decoded.text }));
  return null;
}

function newState(pathRuleExtensions) {
  const skipped = {};
  const state = {
    members: [],
    named: [],
    expanded: 0,
    examined: 0,
    truncated: false,
    skipped,
    pathRuleExtensions: new Set(pathRuleExtensions || []),
    skip(reason) {
      skipped[reason] = (skipped[reason] || 0) + 1;
      return reason;
    }
  };
  return state;
}

function inflateRaw(data, limit) {
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: limit + 1 });
  } catch (error) {
    return error && error.code === 'ERR_BUFFER_TOO_LARGE' ? 'oversize' : null;
  }
}

/* ---- ZIP ------------------------------------------------------------------ */

/*
 * The central directory is the index, and it is read from the end: the end
 * record is within the last 64 KiB plus its own 22 bytes. Every offset it
 * gives is checked against the buffer before it is followed, so a crafted
 * directory points at nothing rather than outside the bytes we hold.
 */
function readZip(bytes, archivePath, decodeText, binaryExtensions, pathRuleExtensions) {
  const state = newState(pathRuleExtensions);
  const floor = Math.max(0, bytes.length - (0xffff + 22));
  let end = -1;
  for (let index = bytes.length - 22; index >= floor; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) return null;
  const entries = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  /* ZIP64 marks these as all ones and moves them elsewhere. An archive that
     large is past every ceiling here anyway. */
  if (directoryOffset === 0xffffffff || directoryOffset + directorySize > bytes.length) return null;

  let cursor = directoryOffset;
  for (let entry = 0; entry < entries; entry += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) break;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (state.examined >= MAX_ARCHIVE_MEMBERS) { state.truncated = true; break; }
    state.examined += 1;
    if (flags & 0x1) { state.skip(MEMBER_SKIPS.ENCRYPTED); continue; }
    if (compressedSize === 0xffffffff || size === 0xffffffff) { state.skip(MEMBER_SKIPS.OVERSIZE); continue; }

    const readBytes = mode => {
      if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
      if (start + compressedSize > bytes.length) return null;
      const data = bytes.subarray(start, start + compressedSize);
      if (mode === 'raw') return data;
      if (method === 0) return data.length > MAX_MEMBER_BYTES ? 'oversize' : data;
      if (method === 8) {
        const inflated = inflateRaw(data, MAX_MEMBER_BYTES);
        if (inflated === 'oversize' || (inflated && inflated.length > MAX_MEMBER_BYTES)) return 'oversize';
        return inflated;
      }
      return null;
    };
    memberOutcome(state, archivePath, name, readBytes, size, decodeText, binaryExtensions);
  }
  return state;
}

/* ---- TAR and gzip ------------------------------------------------------------ */

function tarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return (nul >= 0 ? slice.subarray(0, nul) : slice).toString('utf8');
}

/*
 * 512-byte headers, each followed by its data padded to 512. A GNU long name
 * arrives as a member of its own naming the next one; a pax header is
 * metadata and is stepped over. Anything that is not a regular file -- a
 * directory, a link, a device -- is not content and is not followed.
 */
function readTar(bytes, archivePath, decodeText, binaryExtensions, pathRuleExtensions) {
  const state = newState(pathRuleExtensions);
  let cursor = 0;
  let longName = null;
  while (cursor + 512 <= bytes.length) {
    const header = bytes.subarray(cursor, cursor + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseInt(tarString(header, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) return state.examined ? state : null;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = tarString(header, 345, 155);
    const base = tarString(header, 0, 100);
    const dataStart = cursor + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (dataStart + size > bytes.length) { state.truncated = true; break; }

    if (type === 'L') {
      longName = bytes.subarray(dataStart, dataStart + Math.min(size, MAX_MEMBER_PATH + 1)).toString('utf8').replace(/\0+$/, '');
      cursor = next;
      continue;
    }
    const name = longName || (prefix ? `${prefix}/${base}` : base);
    longName = null;
    cursor = next;
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    if (state.examined >= MAX_ARCHIVE_MEMBERS) { state.truncated = true; break; }
    state.examined += 1;
    const inner = name.replace(/^\.\//, '');
    const readBytes = mode => {
      const data = bytes.subarray(dataStart, dataStart + size);
      if (mode === 'raw') return data;
      return data.length > MAX_MEMBER_BYTES ? 'oversize' : data;
    };
    memberOutcome(state, archivePath, inner, readBytes, size, decodeText, binaryExtensions);
  }
  return state;
}

/* One shape for every answer, so a caller never has to ask which one it got. */
function oversizeArchive() {
  return Object.freeze({
    oversize: true, members: Object.freeze([]), named: Object.freeze([]), examined: 0, truncated: false, skipped: Object.freeze({})
  });
}

function gunzip(bytes) {
  try {
    return zlib.gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES + 1 });
  } catch (error) {
    return error && error.code === 'ERR_BUFFER_TOO_LARGE' ? 'oversize' : null;
  }
}

/*
 * The files inside one archive, as text, with counts of what was not read and
 * why. Returns null when the bytes are not the archive their name says, which
 * a caller reports as an unreadable file -- never as an empty archive.
 */
function openArchive(input = {}) {
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : null;
  const kind = input.kind;
  const archivePath = String(input.path || '');
  const decodeText = typeof input.decodeText === 'function' ? input.decodeText : null;
  const binaryExtensions = input.binaryExtensions instanceof Set ? input.binaryExtensions : new Set();
  const pathRuleExtensions = Array.isArray(input.pathRuleExtensions) ? input.pathRuleExtensions : [];
  if (!bytes || !decodeText || !archivePath || bytes.length > MAX_ARCHIVE_BYTES) return null;

  let state = null;
  if (kind === 'zip') state = readZip(bytes, archivePath, decodeText, binaryExtensions, pathRuleExtensions);
  else if (kind === 'tar') state = readTar(bytes, archivePath, decodeText, binaryExtensions, pathRuleExtensions);
  else if (kind === 'tgz') {
    const expanded = gunzip(bytes);
    if (expanded === 'oversize') return oversizeArchive();
    state = expanded ? readTar(expanded, archivePath, decodeText, binaryExtensions, pathRuleExtensions) : null;
  } else if (kind === 'gz') {
    /* A single compressed file: its member is the archive's own name
       without `.gz`. */
    const expanded = gunzip(bytes);
    if (expanded === 'oversize') return oversizeArchive();
    if (!expanded) return null;
    state = newState(pathRuleExtensions);
    state.examined = 1;
    const inner = (archivePath.split('/').pop() || '').replace(/\.gz$/i, '') || 'content';
    memberOutcome(state, archivePath, inner, mode => (mode === 'raw' || expanded.length <= MAX_MEMBER_BYTES ? expanded : 'oversize'),
      expanded.length, decodeText, binaryExtensions);
  }
  if (!state) return null;
  return Object.freeze({
    oversize: false,
    members: Object.freeze(state.members),
    named: Object.freeze(state.named),
    examined: state.examined,
    truncated: state.truncated,
    skipped: Object.freeze({ ...state.skipped })
  });
}

module.exports = Object.freeze({
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_MEMBERS,
  MAX_EXPANDED_BYTES,
  MAX_MEMBER_BYTES,
  MEMBER_SKIPS,
  ZIP_EXTENSIONS,
  archiveKind,
  openArchive,
  safeMemberPath
});
