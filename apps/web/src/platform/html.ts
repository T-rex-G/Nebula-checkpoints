/*
 * Text placed into markup the page writes as a string.
 *
 * `escapeHtml` is what the browser itself writes for a text node -- `&`,
 * `<`, `>` and the no-break space escaped, nothing else -- so a value put
 * between tags reads back as exactly that value, and markup in it is shown,
 * not run. It is for text between tags only; a value inside an attribute
 * takes `escapeAttribute`, which escapes both quotes as well.
 */

const TEXT: Readonly<Record<string, string>> = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\u00a0': '&nbsp;' });
const ATTRIBUTE: Readonly<Record<string, string>> = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/* A value as the text between two tags: null and undefined are nothing. */
export function escapeHtml(value: unknown): string {
  return (value == null ? '' : String(value)).replace(/[&<>\u00a0]/g, ch => TEXT[ch] ?? ch);
}

/* A value as an attribute's quoted text. */
export function escapeAttribute(value: unknown): string {
  return (value == null ? '' : String(value)).replace(/[&<>"']/g, ch => ATTRIBUTE[ch] ?? ch);
}
