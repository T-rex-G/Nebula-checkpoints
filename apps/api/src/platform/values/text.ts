/*
 * Text from outside, made safe to keep and show: one line, no control
 * characters, bounded. And a repository path as one form: forward slashes,
 * no leading slash, no empty segment, bounded.
 */
export function cleanText(value: unknown, max = 240): string {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanPath(value: unknown): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/').slice(0, 1024);
}
