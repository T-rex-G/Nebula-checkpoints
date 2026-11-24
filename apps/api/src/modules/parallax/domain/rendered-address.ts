/*
 * The rendered audit's bounds, the two viewports it renders, and the
 * addresses it works with: the page a person enters, every address the
 * browser may load, and an address as a report may show it.
 */
import { privatePathSegment } from './url-privacy.ts';

export const LIMITS = Object.freeze({ requests: 80, bytes: 20 * 1024 * 1024, resourceBytes: 2 * 1024 * 1024, deadlineMs: 90000, resourceMs: 10000, screenshots: 2 });
export type RenderedLimits = { readonly [Key in keyof typeof LIMITS]: number };
export const VIEWPORTS = Object.freeze([{ name: 'Desktop', width: 1440, height: 900 }, { name: 'Mobile', width: 390, height: 844 }]);
export type Viewport = (typeof VIEWPORTS)[number];

export type RenderedAuditError = Error & { readonly code: string; readonly status: number };
export function auditError(message: string, code = 'RENDERED_AUDIT_UNAVAILABLE', status = 503): RenderedAuditError {
  return Object.assign(new Error(message), { code, status });
}
/* The shape every address the browser may load must have: HTTPS on 443, no userinfo, no fragment. */
export function httpsAddress(value: unknown): URL {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw auditError('Enter a public HTTPS page address.', 'RENDERED_URL_INVALID', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || url.href.length > 2048) {
    throw auditError('Use HTTPS on port 443 without a username, password or fragment.', 'RENDERED_URL_INVALID', 400);
  }
  return url;
}
/* The address a person enters. Only here is a credential-shaped query refused: the
   page's own assets and redirects may carry them, and reports never keep a query. */
export function renderedUrl(value: unknown): string {
  const url = httpsAddress(value);
  const sensitive = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|auth(?:orization)?|auth[-_]?token|password|passwd|secret|client[-_]?secret|api[-_]?key|key|signature|sig|credential|code|session[-_]?id|session[-_]?token|jwt|oauth[-_]?token)$/i;
  if ([...url.searchParams.keys()].some(key => sensitive.test(key) || /^(?:x-amz-|x-goog-)/i.test(key))) {
    throw auditError('Use a public page address without credentials, access tokens or signed query parameters.', 'RENDERED_URL_SENSITIVE', 400);
  }
  return url.href;
}
/* An address as a report shows it: no query, fragment or userinfo, and no token-shaped path segment. */
export function displayUrl(value: unknown, base?: string): string | null {
  try { const target = new URL(String(value), base); if (!/^https?:$/.test(target.protocol)) return null; target.search = ''; target.hash = ''; target.username = ''; target.password = '';
    target.pathname = target.pathname.split('/').map(part => privatePathSegment(part) ? '[redacted]' : part).join('/');
    return target.href;
  } catch { return null; }
}
