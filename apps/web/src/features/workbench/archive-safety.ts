/* Nebulaverse-X ZIP intake guard — path traversal, bomb, duplicate and integrity checks. */
import { field } from '../../platform/values.ts';

export interface ArchiveLimits {
  maxEntries: number;
  maxFileUncompressed: number;
  maxTotalUncompressed: number;
  maxCompressionRatio: number;
  maxPathLength: number;
}

export const DEFAULT_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxEntries: 500,
  maxFileUncompressed: 128 * 1024 * 1024,
  maxTotalUncompressed: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathLength: 1024
});

/* A refusal, with the code the intake and its tests tell refusals apart by. */
export class ArchiveError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export function normalizeZipPath(value: unknown, limits: Readonly<ArchiveLimits> = DEFAULT_LIMITS): string {
  const original = String(value == null ? '' : value);
  if (!original || original.length > limits.maxPathLength || /[\u0000-\u001f\u007f]/.test(original)) {
    throw new ArchiveError('Unsafe or empty archive file path', 'ZIP_UNSAFE_PATH');
  }
  if (/^[\\/]/.test(original) || /^[a-z]:[\\/]/i.test(original)) {
    throw new ArchiveError('Unsafe absolute archive file path', 'ZIP_UNSAFE_PATH');
  }
  const normalized = original.replace(/\\/g, '/').replace(/\/{2,}/g, '/').normalize('NFC');
  if (normalized.endsWith('/')) throw new ArchiveError('Archive directory entries are not extractable files', 'ZIP_DIRECTORY_ENTRY');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new ArchiveError('Unsafe archive file path traversal', 'ZIP_UNSAFE_PATH');
  }
  return normalized;
}

function finiteSize(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new ArchiveError(`Invalid ${label} in archive`, 'ZIP_INVALID_SIZE');
  return number;
}

/* An entry as the central directory listed it, with its name made safe and its sizes and method made numbers. */
export interface ArchiveEntry {
  readonly [property: string]: unknown;
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ValidatedArchive {
  entries: ArchiveEntry[];
  totalUncompressed: number;
  limits: ArchiveLimits;
}

export function validateArchiveEntries(entries: unknown, customLimits: Partial<ArchiveLimits> | null = {}): ValidatedArchive {
  const limits: ArchiveLimits = { ...DEFAULT_LIMITS, ...(customLimits || {}) };
  if (!Array.isArray(entries)) throw new ArchiveError('Archive entry list is invalid', 'ZIP_INVALID_ENTRIES');
  const listed: readonly unknown[] = entries;
  if (listed.length > limits.maxEntries) throw new ArchiveError(`Archive exceeds the ${limits.maxEntries} files limit`, 'ZIP_TOO_MANY_FILES');
  const seen = new Set<string>();
  const clean: ArchiveEntry[] = [];
  let totalUncompressed = 0;
  for (const source of listed) {
    const method = Number(field(source, 'method'));
    if (![0, 8].includes(method)) throw new ArchiveError(`Unsupported archive compression method (${method})`, 'ZIP_UNSUPPORTED_METHOD');
    const name = normalizeZipPath(field(source, 'name'), limits);
    const collisionKey = name.toLocaleLowerCase('en-US');
    if (seen.has(collisionKey)) throw new ArchiveError(`Duplicate archive path: ${name}`, 'ZIP_DUPLICATE_PATH');
    seen.add(collisionKey);
    const compressedSize = finiteSize(field(source, 'compressedSize'), 'compressed size');
    const uncompressedSize = finiteSize(field(source, 'uncompressedSize'), 'uncompressed size');
    if (uncompressedSize > limits.maxFileUncompressed) {
      throw new ArchiveError(`Archive file exceeds the ${limits.maxFileUncompressed} byte per-file limit: ${name}`, 'ZIP_FILE_TOO_LARGE');
    }
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > limits.maxTotalUncompressed) {
      throw new ArchiveError(`Archive exceeds the ${limits.maxTotalUncompressed} byte total extracted limit`, 'ZIP_TOTAL_TOO_LARGE');
    }
    const ratio = uncompressedSize === 0 ? 0 : uncompressedSize / Math.max(1, compressedSize);
    if (ratio > limits.maxCompressionRatio) {
      throw new ArchiveError(`Suspicious archive compression ratio for ${name}`, 'ZIP_COMPRESSION_RATIO');
    }
    clean.push({ ...(typeof source === 'object' && source !== null ? source : {}), name, method, compressedSize, uncompressedSize });
  }
  return { entries: clean, totalUncompressed, limits };
}

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  const made = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    made[n] = c >>> 0;
  }
  crcTable = made;
  return made;
}

/* The CRC-32 a ZIP entry records, over bytes as given: a Uint8Array (a Buffer is one), a buffer, or a list of byte values. */
export function crc32(bytes: Uint8Array | ArrayBuffer | ArrayLike<number> | null | undefined): number {
  const input = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes || []);
  const lookup = table();
  let crc = 0xffffffff;
  for (const byte of input) crc = (lookup[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const ArchiveSafety = Object.freeze({ DEFAULT_LIMITS, normalizeZipPath, validateArchiveEntries, crc32 });
export default ArchiveSafety;
