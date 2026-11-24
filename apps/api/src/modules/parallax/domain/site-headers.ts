/*
 * What a page's response headers enforce in the visitor's browser: HSTS, the
 * Content-Security-Policy, framing, type sniffing, the referrer, the opener,
 * credentialed cross-origin reads and the cookies it sets. Each header is
 * reported missing or weak; the only value that crosses back is a cookie's
 * name.
 */
import type { SiteRuleId } from './site-rules.ts';

/* The headers of a response, as the guarded transport hands them over. */
export type SiteHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/* A rule a response breaks, and where: a header's name, a path, a cookie. */
export interface RawFinding {
  readonly rule: SiteRuleId;
  readonly where: string;
  readonly severity?: 'serious' | 'warning';
  readonly soft?: boolean;
  readonly note?: string;
  readonly fixNote?: string;
}

export function looksLikeHtml(response: { readonly headers?: SiteHeaders; readonly body?: unknown }): boolean {
  const type = String(response.headers && response.headers['content-type'] || '').toLowerCase();
  return type.includes('text/html') || /^\s*<(!doctype|html|head|body)/i.test(String(response.body || ''));
}

export function cookieFindings(cookies: unknown): RawFinding[] {
  const out: RawFinding[] = [];
  for (const cookie of (Array.isArray(cookies) ? cookies : [])) {
    const name = (String(cookie).split('=')[0] ?? '').trim().slice(0, 64);
    if (!/^[\w.-]+$/.test(name)) continue;
    const attributes = String(cookie).toLowerCase();
    if (!/;\s*secure\b/.test(attributes)) out.push({ rule: 'WEB-011', where: `Set-Cookie: ${name}` });
    else if (!/;\s*httponly\b/.test(attributes)) out.push({ rule: 'WEB-012', where: `Set-Cookie: ${name}` });
  }
  return out;
}

/* One directive's sources, or null when the policy does not state it. */
export function cspDirective(csp: unknown, name: string): string | null {
  // Browsers use the first occurrence, including an empty source list.
  for (const directive of String(csp || '').split(';')) {
    const [key = '', ...sources] = directive.trim().split(/\s+/);
    if (key.toLowerCase() === name) return sources.join(' ');
  }
  return null;
}
export function fallbackDirective(csp: unknown, names: readonly string[]): string | null {
  for (const name of names) {
    const value = cspDirective(csp, name);
    if (value !== null) return value;
  }
  return null;
}
export function frameProtected(headers: SiteHeaders): boolean {
  const sources = cspDirective(headers['content-security-policy'], 'frame-ancestors');
  // An enforced frame-ancestors overrides X-Frame-Options in modern browsers.
  if (sources !== null) return !/(?:^|\s)(?:\*|https?:)(?=\s|$)/i.test(sources) &&
    (sources === '' || sources.split(/\s+/).every(source => /^(?:'none'|'self'|https?:\/\/[^\s*]+)$/i.test(source)));
  return /^(?:DENY|SAMEORIGIN)$/i.test(String(headers['x-frame-options'] || '').trim());
}
export function corsCredentials(headers: SiteHeaders): boolean {
  return String(headers['access-control-allow-credentials'] || '').trim() === 'true';
}

export interface HstsSummary {
  readonly maxAge: number | null;
  readonly includeSubDomains: boolean;
  readonly preload: boolean;
}
export function hstsSummary(value: unknown): HstsSummary | null {
  const text = String(value || '');
  if (!text) return null;
  const directives = text.split(';').map(value => value.trim()).filter(Boolean);
  const ages = directives.filter(value => /^max-age(?:\s|=|$)/i.test(value));
  const age = ages.length === 1 && /^max-age\s*=\s*(?:"(\d+)"|(\d+))$/i.exec(ages[0] ?? '');
  return Object.freeze({
    maxAge: age && Number.isSafeInteger(Number(age[1] || age[2])) ? Number(age[1] || age[2]) : null,
    includeSubDomains: directives.some(value => /^includesubdomains$/i.test(value)),
    preload: /(?:^|;)\s*preload\s*(?:;|$)/i.test(text)
  });
}

export function headerFindings(headers: SiteHeaders): RawFinding[] {
  const out: RawFinding[] = [];
  const get = (name: string): string => String(headers[name] || '');
  const hsts = get('strict-transport-security');
  if (!hsts) out.push({ rule: 'WEB-003', where: 'Strict-Transport-Security' });
  else {
    const age = hstsSummary(hsts)?.maxAge ?? null;
    if (age === null || age < 15552000) out.push({ rule: 'WEB-004', where: 'Strict-Transport-Security' });
  }
  const csp = get('content-security-policy');
  if (!csp) out.push({ rule: 'WEB-005', where: get('content-security-policy-report-only') ? 'Content-Security-Policy (report-only is not enforced)' : 'Content-Security-Policy' });
  else {
    const script = fallbackDirective(csp, ['script-src', 'default-src']);
    const elements = fallbackDirective(csp, ['script-src-elem', 'script-src', 'default-src']);
    const nonced = (value: string | null): boolean => /(?:^|\s)'(?:nonce-[A-Za-z0-9+/_-]+=*|sha(?:256|384|512)-[A-Za-z0-9+/_-]+=*)'(?=\s|$)/i.test(value || '');
    const unsafeInline = (value: string | null): boolean => /'unsafe-inline'/i.test(value || '') && !nonced(value);
    if (/'unsafe-eval'/i.test(script || '') || unsafeInline(elements)) out.push({ rule: 'WEB-006', where: 'Content-Security-Policy' });
    const unrestricted = (value: string | null): boolean => value === null || (!(nonced(value) && /'strict-dynamic'/i.test(value)) && /(?:^|\s)(?:\*|https?:|data:)(?=\s|$)/i.test(value));
    if (unrestricted(script) || unrestricted(elements)) out.push({ rule: 'WEB-032', where: 'Content-Security-Policy: script-src' });
  }
  if (!frameProtected(headers)) out.push({ rule: 'WEB-007', where: 'X-Frame-Options' });
  if (!/^nosniff$/i.test(get('x-content-type-options').trim())) out.push({ rule: 'WEB-008', where: 'X-Content-Type-Options' });
  if (!get('referrer-policy').split(',').some(value => /^(?:no-referrer|no-referrer-when-downgrade|origin|origin-when-cross-origin|same-origin|strict-origin|strict-origin-when-cross-origin|unsafe-url)$/i.test(value.trim()))) out.push({ rule: 'WEB-009', where: 'Referrer-Policy' });
  const allowedOrigin = get('access-control-allow-origin').trim();
  if (allowedOrigin === 'null' && corsCredentials(headers)) out.push({ rule: 'WEB-010', where: 'Access-Control-Allow-Origin' });
  if (allowedOrigin === '*' && corsCredentials(headers)) out.push({ rule: 'WEB-037', where: 'Access-Control-Allow-Origin' });
  if (/\d/.test(get('server')) || get('x-powered-by')) out.push({ rule: 'WEB-013', where: get('x-powered-by') ? 'X-Powered-By' : 'Server' });
  if (!/^(?:same-origin|same-origin-allow-popups)$/i.test((get('cross-origin-opener-policy').split(';')[0] ?? '').trim())) out.push({ rule: 'WEB-016', where: 'Cross-Origin-Opener-Policy' });
  if (csp) {
    const objects = fallbackDirective(csp, ['object-src', 'default-src']);
    const baseOpen = cspDirective(csp, 'base-uri') === null;
    const pluginsOpen = objects === null || (objects !== '' && !/'none'|'self'/i.test(objects)) || /\*|https?:/i.test(objects);
    if (baseOpen || pluginsOpen) out.push({ rule: 'WEB-017', where: 'Content-Security-Policy' });
  }
  return out;
}
