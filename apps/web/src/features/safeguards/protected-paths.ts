/*
 * Which paths a repository has locked, read as the server reads them.
 *
 * A lock is a path or a pattern, kept per repository in the safety record the
 * server returns. A pattern is read as the server's pathMatches reads it
 * (apps/api/src/platform/values/path-patterns.ts): slashes normalised, a
 * plain path covering itself and everything beneath it, a folder written with
 * its slash covering the same, `*` within a segment, `?` one character, and
 * a double star and a slash zero or more folders -- so a pattern for `.env`
 * files under any folder covers the root `.env` too. A
 * path the page shows as locked is one the server refuses to change, and the
 * other way round; test/protected-path-patterns.test.js puts one table to both.
 */
import { field } from '../../platform/values.ts';

const normal = (value: unknown): string => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');

export function protectedPatternMatch(pattern: unknown, value: unknown): boolean {
  /* As the server reads it (pathMatches): a pattern ending in `/` names a folder and covers everything beneath it. */
  const written = normal(pattern);
  const folder = written.endsWith('/');
  const p = written.replace(/\/+$/, '') + (folder && /[?*]/.test(written) ? '/**' : '');
  const v = normal(value);
  if (!p || !v) return false;
  if (!/[?*]/.test(p)) return v === p || v.startsWith(p + '/');
  let rx = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === '*') {
      /* As the server reads it: a double star and a slash is zero or more folders, so the root counts as one of them. */
      if (p[i + 1] === '*') { i++; if (p[i + 1] === '/') { i++; rx += '(?:.*/)?'; } else rx += '.*'; } else rx += '[^/]*';
    } else if (c === '?') rx += '[^/]';
    else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(rx + '$').test(v); } catch { return false; }
}

/* The key a repository's locks are kept under: its owner and name, or nothing with none open. */
export function safetyKey(work: unknown): string {
  return field(work, 'owner') ? `${String(field(work, 'owner'))}/${String(field(work, 'repo'))}` : '';
}

/* The repository's locks, as the safety record holds them: only the paths written, under its own key. */
export function protectedList(safety: unknown, key: string): readonly string[] {
  const all = field(safety, 'protected');
  const list = key && all && typeof all === 'object' && Object.hasOwn(all, key) ? (all as Record<string, unknown>)[key] : null;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
}

export const isProtected = (list: readonly string[], path: unknown): boolean => list.some(pattern => protectedPatternMatch(pattern, path));
/* Locked by its own entry, rather than by a folder or a pattern that covers it. */
export const isExactProtected = (list: readonly string[], path: unknown): boolean => list.includes(String(path).replace(/^\/+/, ''));
