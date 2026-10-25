/*
 * The addresses a site check works with: the origin it checks, the site a
 * repository declares, the domain whose email policy is looked up, and a
 * path as it may be shown.
 */
import { parse as parseDomain } from 'tldts';
import { privatePathSegment } from './url-privacy.ts';

export class SiteCheckError extends Error {
  override readonly name = 'SiteCheckError';
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* The site, as an origin. A path, query or fragment is dropped, not followed. */
export function siteOrigin(raw: unknown): string {
  let parsed: URL;
  try { parsed = new URL(String(raw || '').trim()); }
  catch { throw new SiteCheckError('Enter the site’s full address, starting with https://', 'SITE_URL_INVALID'); }
  if (parsed.protocol !== 'https:') throw new SiteCheckError('Only HTTPS sites can be checked', 'SITE_URL_INVALID');
  if (parsed.username || parsed.password) throw new SiteCheckError('The address must not carry a username or password', 'SITE_URL_INVALID');
  if (parsed.port && parsed.port !== '443') throw new SiteCheckError('Only the standard HTTPS port can be checked', 'SITE_URL_INVALID');
  return `https://${parsed.hostname.toLowerCase().replace(/\.$/, '')}`;
}

/*
 * The address a repository declares as its deployed site (GitHub's homepage,
 * Gitea's website), offered as the check's starting value. Only an origin the
 * check would accept crosses back; anything else is no suggestion at all.
 */
export function declaredSite(value: unknown): string | null {
  try { return value ? siteOrigin(value) : null; } catch { return null; }
}

/*
 * Where a site's email policy is looked up: the registrable domain, not the
 * web host. A host on a shared platform's domain has no email policy of its
 * own to check -- the platform's is not the site's -- and is skipped.
 */
const SHARED_PLATFORMS = Object.freeze(['onrender.com', 'vercel.app', 'netlify.app', 'herokuapp.com', 'github.io', 'pages.dev', 'workers.dev', 'fly.dev', 'railway.app',
  'web.app', 'firebaseapp.com', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'amplifyapp.com', 'appspot.com', 'glitch.me', 'replit.app', 'repl.co',
  'surge.sh', 'deno.dev', 'supabase.co', 'gitlab.io', 'onrender.app', 'ngrok.app', 'ngrok-free.app', 'lovable.app', 'bolt.new', 'webflow.io', 'wixsite.com', 'framer.app']);
export type EmailDomain = { readonly skipped: 'shared-platform' | 'no-domain'; readonly domain?: undefined } | { readonly domain: string; readonly skipped?: undefined };
export function emailDomain(hostname: unknown): EmailDomain {
  const host = String(hostname || '').toLowerCase();
  if (SHARED_PLATFORMS.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return { skipped: 'shared-platform' };
  const parsed = parseDomain(host, { allowPrivateDomains: true });
  if (parsed.isPrivate) return { skipped: 'shared-platform' };
  if (!parsed.domain || !parsed.isIcann || parsed.isIp) return { skipped: 'no-domain' };
  return { domain: parsed.domain };
}

export function hostOf(address: string): string {
  try { return new URL(address).host; } catch { return ''; }
}

/*
 * A path as it may be shown: its query dropped, a long opaque segment -- a
 * token, an id -- replaced, and bounded. A link can carry an identifier, and
 * the check repeats places, never identifiers.
 */
export function displayPath(pathname: unknown): string {
  const clean = (String(pathname || '/').split(/[?#]/)[0] ?? '')
    .split('/').map(segment => (privatePathSegment(segment) ? '…' : segment)).join('/');
  return clean.length > 96 ? `${clean.slice(0, 95)}…` : clean || '/';
}
