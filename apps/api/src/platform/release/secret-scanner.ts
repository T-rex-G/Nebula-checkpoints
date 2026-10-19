/*
 * The release gate's secret scan: whether a tracked file carries a
 * credential, by the rules in secret-rules.ts.
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

function decodeText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

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
    const text = decodeText(fs.readFileSync(absolute));
    if (text === null) continue;
    for (const { rule, regex } of RULES) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(Object.freeze({ path: relative, rule, line }));
      }
    }
  }
  return Object.freeze(findings.sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule)));
}
