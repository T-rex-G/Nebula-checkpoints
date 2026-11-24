/*
 * The release gate's scan of what the release carries: whether a tracked
 * file holds a credential, by the rules in secret-rules.ts, and whether its
 * text hides anything from the review the release relies on -- characters a
 * reader cannot see, or a file that should be text and cannot be read as such.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RULES } from './secret-rules.ts';

export { RULES, type SecretRule } from './secret-rules.ts';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
export const MAX_DIRECTORY_DEPTH = 64;
const EXCLUDED_DIRECTORIES = Object.freeze([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out',
  'coverage', 'playwright-report', 'test-results', '.cache', '.npm'
]);
function fail(message: string): never {
  throw new TypeError(message);
}

function normalizeRelative(relative: unknown): string {
  const value = String(relative || '').replace(/\\/g, '/');
  if (
    !value ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').some(part => part === '' || part === '.' || part === '..')
  ) fail('secret scan received an unsafe file path');
  return value;
}

function gitTrackedFiles(root: string): string[] | null {
  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (topLevel.error || topLevel.status !== 0) return null;
  if (fs.realpathSync(topLevel.stdout.trim()) !== fs.realpathSync(root)) return null;
  const result = spawnSync('git', ['ls-files', '--cached', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail('tracked-file discovery failed');
  }
  if (result.stdout.length > 0 && result.stdout.at(-1) !== 0) fail('tracked-file inventory is unterminated');
  const files = result.stdout.length
    ? result.stdout.toString('utf8').split('\0').filter(Boolean).map(normalizeRelative)
    : [];
  if (files.length > MAX_FILES || new Set(files).size !== files.length) fail('tracked-file inventory is invalid');
  return files.sort();
}

function walkArchiveFiles(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string, prefix = '', depth = 0): void {
    if (depth > MAX_DIRECTORY_DEPTH) fail('archive directory nesting exceeds the safe limit');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('._')) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.includes(entry.name)) {
          visit(path.join(directory, entry.name), relative, depth + 1);
        }
      } else if (entry.isFile()) {
        files.push(normalizeRelative(relative));
        if (files.length > MAX_FILES) fail('archive file inventory exceeds the safe limit');
      }
    }
  }
  visit(root);
  return files.sort();
}

export function discoverReleasableTextFiles(rootDirectory: string): string[] {
  const root = fs.realpathSync(path.resolve(rootDirectory));
  return gitTrackedFiles(root) || walkArchiveFiles(root);
}

/* The file's text as it is, a leading byte-order mark kept rather than consumed: it is a character no reader sees. */
function decodeText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

/*
 * The types of file the release carries as bytes rather than text: images,
 * fonts, archives. Every other file must be UTF-8 text the scan can read. One
 * that is not is refused as undecodable -- a single NUL or stray byte used to
 * make a file pass unread. A binary file's bytes are still searched for
 * credentials, which are ASCII whatever carries them.
 */
export const BINARY_EXTENSIONS: readonly string[] = Object.freeze([
  '.avif', '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.otf', '.pdf', '.png', '.tgz', '.ttf', '.wasm', '.webp', '.woff', '.woff2', '.zip'
]);

/*
 * Characters a reader of the file cannot see: control characters other than
 * tab and the line ends; format characters -- the bidirectional controls that
 * make code read in one order and run in another, zero-width characters, a
 * byte-order mark, the tags that spell text no one is shown; and the line and
 * paragraph separators, which end a line where an editor may show none. Each
 * can hide code, or a credential, from the review; text that needs one writes
 * its escape.
 */
const HIDDEN_CHARACTER = /(?![\t\n\r])[\p{Cc}\p{Cf}\u2028\u2029]/u;

/* The offset of the first byte that is a NUL or not well-formed UTF-8 (Unicode's table 3-7), or -1. */
function firstUndecodable(bytes: Buffer): number {
  for (let at = 0; at < bytes.length;) {
    const lead = bytes[at] ?? 0;
    if (lead === 0) return at;
    if (lead < 0x80) { at += 1; continue; }
    const [length, low, high] = lead >= 0xc2 && lead <= 0xdf ? [2, 0x80, 0xbf]
      : lead === 0xe0 ? [3, 0xa0, 0xbf]
        : lead === 0xed ? [3, 0x80, 0x9f]
          : lead >= 0xe1 && lead <= 0xef ? [3, 0x80, 0xbf]
            : lead === 0xf0 ? [4, 0x90, 0xbf]
              : lead >= 0xf1 && lead <= 0xf3 ? [4, 0x80, 0xbf]
                : lead === 0xf4 ? [4, 0x80, 0x8f] : [0, 0, 0];
    if (!length) return at;
    for (let next = 1; next < length; next += 1) {
      const byte = bytes[at + next];
      if (byte === undefined || byte < (next === 1 ? low : 0x80) || byte > (next === 1 ? high : 0xbf)) return at;
    }
    at += length;
  }
  return -1;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

export interface SecretFinding {
  readonly path: string;
  readonly rule: string;
  readonly line: number;
}

export interface ScanOptions {
  readonly root?: string;
  readonly files?: readonly unknown[];
}

export function scanFiles(options: ScanOptions = {}): readonly SecretFinding[] {
  const root = fs.realpathSync(path.resolve(options.root || process.cwd()));
  const files = Array.isArray(options.files)
    ? options.files.map(normalizeRelative)
    : discoverReleasableTextFiles(root);
  if (files.length > MAX_FILES || new Set(files).size !== files.length) fail('secret scan file inventory is invalid');
  const findings: SecretFinding[] = [];
  for (const relative of [...files].sort()) {
    const absolute = path.join(root, relative);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(absolute);
    } catch (error) {
      fail(`secret scan cannot read tracked file metadata: ${relative}: ${String((error as { readonly code?: unknown } | null)?.code || 'unknown error')}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    if (metadata.size > MAX_FILE_BYTES) fail(`secret scan file exceeds the safe size limit: ${relative}`);
    const bytes = fs.readFileSync(absolute);
    const binary = BINARY_EXTENSIONS.includes(path.posix.extname(relative).toLowerCase());
    const text = binary ? bytes.toString('latin1') : decodeText(bytes);
    if (text === null) {
      const at = firstUndecodable(bytes);
      findings.push(Object.freeze({ path: relative, rule: 'undecodable-text', line: lineOf(bytes.toString('latin1'), at < 0 ? bytes.length : at) }));
      continue;
    }
    if (!binary) {
      const hidden = HIDDEN_CHARACTER.exec(text);
      if (hidden) findings.push(Object.freeze({ path: relative, rule: 'hidden-character', line: lineOf(text, hidden.index) }));
    }
    for (const { rule, regex } of RULES) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match) findings.push(Object.freeze({ path: relative, rule, line: lineOf(text, match.index) }));
    }
  }
  return Object.freeze(findings.sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule)));
}
