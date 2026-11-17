import { createHash } from 'node:crypto';

/*
 * Small readers every family of rules shares: the line an offset sits on, a
 * JSON document read without throwing, the line a key is written on, a
 * provider's text made plain, a finding's digest, and the waiver a team
 * writes beside a line.
 */

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let cursor = text.indexOf('\n'); cursor !== -1 && cursor < index; cursor = text.indexOf('\n', cursor + 1)) line += 1;
  return line;
}

/* A JSON document, or null when the text is not one; what it holds is read field by field. */
export function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export function keyLine(text: string, key: string): number {
  const index = text.indexOf(`"${key}"`);
  return index < 0 ? 1 : lineOf(text, index);
}

export function plain(value: unknown, limit: number): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

export function fingerprint(rule: string, filePath: string, context: string): string {
  return createHash('sha256').update(`${rule}\0${filePath}\0${context}`).digest('hex').slice(0, 24);
}

/*
 * A finding a team has looked at and decided about, recorded where the code
 * is: a comment on the line or the line above naming the rule, and ideally
 * why --
 *
 *   // nv-audit-ignore SEC-005 -- the token is a display nonce, not a secret
 *   # nv-audit-ignore SEC-024: the pickle comes from our own signed cache
 *
 * A directive must name the rule it waives; a bare "ignore everything" is not
 * honoured, so a suppression can never hide the next, different mistake on
 * the same line. Waived findings are not scored and are still reported, with
 * their reason, so nothing disappears silently.
 */
const WAIVER = /nv-audit-ignore\s+([A-Z]{3}-\d{3}(?:\s*,\s*[A-Z]{3}-\d{3})*)(?:\s*(?:--|:|\u2014)\s*([^*\n]{1,200}?))?\s*(?:\*\/|-->)?\s*$/;
/* A waiver: why the finding was waived, if the note says, and the line the note is on. */
export interface Suppression {
  readonly reason: string | null;
  readonly line: number | null;
  readonly policy?: string;
}
export function suppression(lines: readonly string[] | null | undefined, line: number, rule: string): Suppression | null {
  if (!lines) return null;
  for (const index of [line - 1, line - 2]) {
    const match = WAIVER.exec(lines[index] || '');
    if (!match) continue;
    const named = match[1] ?? '';
    const rules = named.split(',').map(part => part.trim());
    if (rules.includes(rule)) return Object.freeze({ reason: match[2] ? match[2].trim() : null, line: index + 1 });
  }
  return null;
}
