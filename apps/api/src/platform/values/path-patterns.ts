/*
 * Whether a repository path falls under a pattern a person wrote: a plain
 * path covers itself and everything beneath it; `*` and `?` stay within one
 * segment, and `**` crosses them.
 */
import { cleanPath } from './text.ts';

export function globToRegExp(pattern: unknown): RegExp {
  const p = cleanPath(pattern);
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p.charAt(i);
    if (c === '*') {
      if (p.charAt(i + 1) === '*') {
        i++;
        out += p.charAt(i + 1) === '/' ? '(?:.*/)?' : '.*';
        if (p.charAt(i + 1) === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

export function pathMatches(pattern: unknown, candidate: unknown): boolean {
  const p = cleanPath(pattern);
  const c = cleanPath(candidate);
  if (!p || !c) return false;
  if (!/[?*]/.test(p)) return c === p || c.startsWith(`${p}/`);
  try { return globToRegExp(p).test(c); } catch { return false; }
}
