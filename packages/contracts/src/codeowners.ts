/*
 * Who owns a path, by the repository's own CODEOWNERS file.
 *
 * The findings inbox names an owner beside each finding so a person can see
 * whose it is to fix without opening the repository. The file is read on the
 * server (it is a repository file like any other) and parsed here, and the
 * same module matches paths in the browser and in the tests.
 *
 * GitHub's rules, as its documentation states them: the last matching line
 * wins; a pattern that starts with a slash, or has one in the middle, is
 * anchored to the root; one without is matched at any depth; a trailing slash
 * matches everything under a directory; `*` stays within one path segment
 * and `**` crosses them; `docs/*` owns the files directly in docs and not the
 * ones nested deeper. Negation (`!`) and character ranges are not supported
 * by GitHub, so a line that uses them is skipped rather than guessed at. A
 * line with a pattern and no owners clears ownership for what it matches.
 */

/* Where GitHub looks, in the order it looks. */
export const CODEOWNERS_CONTRACT_VERSION = 1;

export const LOCATIONS = Object.freeze(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const);
export const MAX_RULES = 2000;
const OWNER = /^(@[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?|[^\s@]{1,64}@[^\s@]{1,253})$/;

export interface OwnershipRule {
  readonly pattern: string;
  readonly owners: string[];
  readonly regex: RegExp;
}

/* A rule as it crosses the wire: the pattern and its owners, never a regex. */
export interface SerializedOwnershipRule {
  readonly pattern: string;
  readonly owners: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function patternRegex(raw: string): RegExp | null {
  let pattern = raw;
  let anchored = false;
  if (pattern.startsWith('/')) { anchored = true; pattern = pattern.slice(1); }
  const directory = pattern.endsWith('/');
  if (directory) pattern = pattern.slice(0, -1);
  if (!pattern) return directory || anchored ? /^.*$/ : null;
  if (pattern.includes('/')) anchored = true;
  /* `docs/*` owns docs' own files, not what is nested under them. */
  const shallow = !directory && /(^|\/)\*$/.test(pattern) && pattern !== '*';
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === '*') {
      if (pattern.charAt(index + 1) === '*') {
        const before = index === 0 || pattern.charAt(index - 1) === '/';
        const after = pattern.charAt(index + 2) === '/';
        if (before && after) { source += '(?:.*/)?'; index += 2; continue; }
        source += '.*';
        index += 1;
        continue;
      }
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '\\' && index + 1 < pattern.length) {
      source += escapeRegex(pattern.charAt(index + 1));
      index += 1;
    } else {
      source += escapeRegex(char);
    }
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  const suffix = directory ? '/.*$' : shallow ? '$' : '(?:/.*)?$';
  return new RegExp(prefix + source + suffix);
}

/* The file's text into ordered rules. Bounded, so a hostile file costs nothing. */
export function parse(text: unknown): OwnershipRule[] {
  const rules: OwnershipRule[] = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (rules.length >= MAX_RULES) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [pattern, ...rest] = trimmed.replace(/\s#.*$/, '').split(/\s+/);
    if (!pattern || pattern.startsWith('!') || /[[\]]/.test(pattern) || pattern.length > 512) continue;
    const regex = patternRegex(pattern.replace(/^\\#/, '#'));
    if (!regex) continue;
    rules.push({ pattern, owners: rest.filter(owner => OWNER.test(owner)).slice(0, 20), regex });
  }
  return rules;
}

/* The owners of one path: the last rule that matches it, or none. */
export function ownersOf(rules: readonly OwnershipRule[], path: unknown): string[] {
  const target = String(path || '').replace(/^\/+/, '');
  if (!target) return [];
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule && rule.regex.test(target)) return rule.owners.slice();
  }
  return [];
}

/* Rules as they cross the wire: the pattern and its owners, never a regex. */
export function serialize(rules: readonly OwnershipRule[]): SerializedOwnershipRule[] {
  return rules.map(rule => ({ pattern: rule.pattern, owners: rule.owners.slice() }));
}

export function revive(list: unknown): OwnershipRule[] {
  const rules: OwnershipRule[] = [];
  for (const entry of Array.isArray(list) ? list.slice(0, MAX_RULES) : []) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { pattern?: unknown }).pattern !== 'string') continue;
    const { pattern, owners } = entry as { pattern: string; owners?: unknown };
    const regex = patternRegex(pattern.replace(/^\\#/, '#'));
    if (!regex) continue;
    rules.push({ pattern, owners: (Array.isArray(owners) ? owners : []).filter((owner): owner is string => typeof owner === 'string' && OWNER.test(owner)), regex });
  }
  return rules;
}
