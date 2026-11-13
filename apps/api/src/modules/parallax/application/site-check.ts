/*
 * A deployed site, looked at the way any visitor's browser -- and anyone
 * probing it -- looks at it.
 *
 * The page a visitor lands on and the headers it is told to enforce; the
 * certificate and the protocol the connection settled on; whether plain HTTP
 * sends a visitor on to HTTPS; whether another website may read answers made
 * with the visitor's cookies; the files that must never be served; what a
 * missing page gives away; the pages the landing page links to (as far as
 * robots.txt allows); the JavaScript those pages load, read for secrets,
 * public source maps and library versions with published advisories; and
 * whether anyone may send email as the domain.
 *
 * Every request goes through the guarded transport's anonymous site profile:
 * GET only, HTTPS on 443 to a public address (and one plain-HTTP question on
 * port 80 whose answer body is never read), no credential and no cookie,
 * every body cut at a bound. At most sixty requests and forty-five seconds;
 * nothing is sent but the requests a browser would send, nothing is tried,
 * guessed or submitted, and pages robots.txt closes to crawlers are left
 * alone.
 *
 * Nothing it reads is returned. A served .env is reported as served, never
 * quoted; a secret in a script is reported by its kind and the script's path;
 * a header is reported as missing or weak, and the only header value that
 * crosses back is a cookie's name. Soft 404s -- a single-page app that
 * answers every path with its index -- are told apart by what a file of that
 * kind has to contain, not by the status alone.
 *
 * It stands on Uranus for the grade and the advisory lookup, on posture for
 * the standards a rule maps to and on Quasar for credential detection, which
 * is why it is application and not domain.
 */
import crypto from 'node:crypto';
import type { Severity } from '../../../../../../packages/contracts/src/findings.ts';
import { boundedMap } from '../../../platform/concurrency/bounded-map.ts';
import type { GuardedFetchInput } from '../../../platform/network/guarded-fetch.ts';
import { listOf, ownEntry, read } from '../../../platform/values/fields.ts';
import { RULE_NARRATION, detectInText } from '../../quasar/index.ts';
import { standardsFor, type Standards } from '../../posture/index.ts';
import { advisoryKey, compareVersions, gradeOf, lookupAdvisories, type AdvisoryAnswer, type AuditTransport, type Grade } from '../../uranus/index.ts';
import { SiteCheckError, displayPath, emailDomain, hostOf, siteOrigin } from '../domain/site-address.ts';
import { dmarcState, spfState, type DmarcState, type SpfState } from '../domain/site-email.ts';
import { corsCredentials, cookieFindings, frameProtected, headerFindings, hstsSummary, looksLikeHtml, type HstsSummary, type RawFinding, type SiteHeaders } from '../domain/site-headers.ts';
import { librariesInText, libraryFromAddress, markupFindings, pageLinks, robotsDisallowed, scriptSources, type Library } from '../domain/site-markup.ts';
import { DEBUG_SIGNATURES, DIRECTORY_LISTING, PROBES, PUBLIC_BY_DESIGN, RULES, SOFTER_SECRETS, VERSION, type SiteRuleId } from '../domain/site-rules.ts';

const PENALTY: Readonly<Record<Severity, number>> = Object.freeze({ critical: 40, serious: 20, warning: 6 });
const SEVERITY_ORDER: Readonly<Record<Severity, number>> = Object.freeze({ critical: 0, serious: 1, warning: 2 });
const CRITICAL_CAP = 49;
const MAX_REDIRECTS = 3;
export const LIMITS = Object.freeze({
  /* Every request the check may make, redirects and all. */
  maxRequests: 60,
  concurrency: 4,
  /* The whole check, from the first request to the last answer. */
  deadlineMs: 45_000,
  requestMs: 15_000,
  pageBytes: 256 * 1024,
  probeBytes: 4096,
  errorPageBytes: 32 * 1024,
  scriptBytes: 2 * 1024 * 1024,
  scriptBudgetBytes: 12 * 1024 * 1024,
  /* The landing page and at most this many more, from its own links. */
  maxPages: 5,
  maxScripts: 12,
  maxMaps: 3,
  maxLibraries: 20,
  detectChunk: 1024 * 1024
});
export type SiteLimits = { readonly [Key in keyof typeof LIMITS]: number };
export const STAGES = Object.freeze(['page', 'transport', 'paths', 'pages', 'scripts', 'libraries', 'email'] as const);
export type SiteStage = (typeof STAGES)[number];

/* What the guarded transport answers a site probe with: the part of its response the check reads. */
export interface SiteResponse {
  readonly statusCode: number;
  readonly headers?: SiteHeaders;
  readonly tls?: { readonly protocol?: string | null; readonly validTo?: string | null; readonly issuer?: string | null } | null;
  readonly body?: string | Buffer;
  readonly bodyUnread?: boolean;
  readonly truncated?: boolean;
}
export type SiteTransport = (input: GuardedFetchInput) => Promise<SiteResponse>;
/* What is left of the check's clock for one operation, and the signal that ends it. */
export interface Budget {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export type TxtLookup = (name: string, budget: Budget) => Promise<readonly string[]>;
export interface SiteProgress {
  readonly stage: SiteStage;
  readonly done?: number;
  readonly total?: number;
}

export interface SiteFinding {
  readonly id: string;
  readonly rule: SiteRuleId;
  readonly category: 'site';
  readonly severity: Severity;
  readonly where: string;
  readonly title: string;
  readonly why: string;
  readonly fix: string;
  readonly standards: Standards | null;
  readonly prompt: string;
}

function describe(rule: SiteRuleId, where: string, extra: { readonly severity?: Severity | null; readonly note?: string | undefined; readonly fixNote?: string | undefined } = {}): SiteFinding {
  const definition = RULES[rule];
  const severity = extra.severity || definition.severity;
  const why = extra.note ? `${definition.why} ${extra.note}` : definition.why;
  const fix = extra.fixNote ? `${definition.fix} ${extra.fixNote}` : definition.fix;
  return {
    id: crypto.createHash('sha256').update(`${rule}\0${where}`).digest('hex').slice(0, 24),
    rule,
    category: 'site',
    severity,
    where,
    title: definition.title,
    why,
    fix,
    standards: standardsFor(rule),
    prompt: `On the deployed site (${where}): ${definition.title.toLowerCase()}. ${why} ${fix} ` +
      'Make the change in the hosting or server configuration this repository controls, and verify it by requesting the page and reading the response headers.'
  };
}

/* Every credential in a script or page, by kind; the value never leaves this function. */
function shippedSecrets(text: unknown): { readonly secrets: readonly { readonly rule: string; readonly kind: string }[]; readonly truncated: boolean } {
  const kinds = new Map<string, string>();
  const source = Buffer.from(String(text || ''), 'utf8');
  const overlap = 16 * 1024;
  let truncated = false;
  for (let start = 0; start < source.length; start += LIMITS.detectChunk - overlap) {
    const chunk = source.subarray(start, start + LIMITS.detectChunk).toString('utf8');
    // UTF-8 replacement at a byte boundary can add bytes; keep the detector's bound.
    const detected = detectInText({ text: Buffer.byteLength(chunk) > LIMITS.detectChunk ? chunk.slice(0, -4) : chunk });
    truncated ||= !detected.scanned || detected.truncated;
    for (const candidate of detected.candidates) {
      if (PUBLIC_BY_DESIGN.has(candidate.rule)) continue;
      if (candidate.rule === 'database-url-password' || candidate.rule === 'authenticated-url') {
        try {
          const candidateHost = new URL(candidate.secret.split(/[\s'"`<>]/)[0] ?? '').hostname;
          if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|postgres|mysql|mongo|redis|db|database)$/i.test(candidateHost)) continue;
        } catch { /* An unparseable credential remains a finding, never suppressed. */ }
      }
      if (!kinds.has(candidate.rule)) kinds.set(candidate.rule, credentialKind(candidate.rule));
    }
  }
  return { secrets: [...kinds.entries()].map(([rule, kind]) => ({ rule, kind })), truncated };
}

/* A credential's kind, as its rule's narration names it: "A Stripe live key is ..." gives "Stripe live key". */
function credentialKind(rule: string): string {
  const narration = ownEntry(RULE_NARRATION, rule);
  const match = narration && /^(?:An?|The) (.+?) (?:is|are|was|were) /.exec(narration.consequence);
  const kind = match && match[1] !== undefined && match[1].length <= 48 ? match[1] : 'credential';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

type LedgerState = 'pass' | 'warn' | 'fail' | 'unknown' | 'skip';
export interface LedgerEntry {
  readonly id: string;
  readonly state: LedgerState;
  readonly detail: string;
}
interface Counts {
  attempted: number;
  completed: number;
  read: number;
  negative: number;
  unknown: number;
  truncated: number;
  skipped: number;
}
export interface CategoryCoverage extends Readonly<Counts> {
  readonly state: 'complete' | 'partial' | 'unknown';
  readonly complete: boolean;
  readonly reasons: readonly string[];
}
type PlainHttp = 'redirects' | 'serves' | 'refuses' | 'closed' | 'unknown';
interface LibraryReport extends Library {
  readonly state: 'unknown' | 'vulnerable' | 'clean';
  readonly advisories: number;
  readonly severity?: Severity | null;
  readonly fixed?: string | null;
  readonly ids?: readonly string[];
}
interface Email {
  readonly state: 'skipped' | 'unknown' | 'partial' | 'checked';
  readonly reason: 'shared-platform' | 'no-domain' | 'not-asked' | null;
  readonly domain: string | null;
  readonly spf: SpfState | null;
  readonly dmarc: DmarcState | null;
}
interface VisitedPage {
  readonly path: string;
  readonly address: string;
  readonly status: number;
  readonly html: string;
}

export interface SiteCheckInput {
  readonly url: unknown;
  readonly transport: SiteTransport;
  readonly signal?: AbortSignal | null;
  readonly advisoryTransport?: AuditTransport | null;
  readonly txt?: TxtLookup | null;
  readonly onProgress?: ((update: SiteProgress) => void) | null;
  readonly limits?: Partial<SiteLimits>;
  readonly now?: () => number;
  readonly random?: () => string;
}

/*
 * The check. `transport` is the guarded transport; every request it is given
 * is anonymous and bounded. `advisoryTransport` asks OSV about the libraries
 * found, and `txt` looks up the domain's email policy; either may be absent,
 * and what it would have answered is then reported as not checked, never as
 * clean. A failure to reach the page at all is an error, never an empty --
 * and therefore clean -- report.
 */
export async function checkSite({ url, transport, signal, advisoryTransport = null, txt = null, onProgress = null, limits: requestedLimits = LIMITS, now = Date.now, random = () => crypto.randomBytes(6).toString('hex') }: SiteCheckInput) {
  const checkCancelled = (): void => { if (signal && signal.aborted) throw new SiteCheckError('The site check was cancelled.', 'SITE_CHECK_CANCELLED', 499); };
  checkCancelled();
  const limits: SiteLimits = { ...LIMITS, ...requestedLimits };
  const requested = siteOrigin(url);
  let origin = requested;
  const startedAt = now();
  let probed = 0;
  const progress = (update: SiteProgress): void => { checkCancelled(); if (typeof onProgress === 'function') { try { onProgress(update); } catch { /* progress is advisory */ } } };
  const remaining = (): number => limits.deadlineMs - (now() - startedAt);
  const withinBudget = async <T>(operation: (budget: Budget) => T | Promise<T>, ceiling = limits.deadlineMs): Promise<T> => {
    checkCancelled();
    const left = Math.min(remaining(), ceiling);
    if (left < 1) throw new SiteCheckError('time budget spent', 'SITE_BUDGET');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => { controller.abort(); reject(new SiteCheckError('The site check was cancelled.', 'SITE_CHECK_CANCELLED', 499)); };
        if (signal) signal.addEventListener('abort', cancel, { once: true });
      });
      const result = await Promise.race([
        cancelled,
        Promise.resolve().then(() => {
          checkCancelled();
          const available = Math.min(remaining(), ceiling);
          if (available < 1) throw new SiteCheckError('time budget spent', 'SITE_BUDGET');
          return operation({ deadlineMs: available, signal: controller.signal });
        }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SiteCheckError('time budget spent', 'SITE_BUDGET')); }, left); })
      ]);
      checkCancelled();
      if (remaining() <= 0) { controller.abort(); throw new SiteCheckError('time budget spent', 'SITE_BUDGET'); }
      return result;
    } finally { clearTimeout(timer); if (signal && cancel) signal.removeEventListener('abort', cancel); controller.abort(); }
  };
  const request = async (target: string, { method = 'GET', maxResponseBytes = limits.probeBytes, headers = {}, plainHttp = false }: { readonly method?: string; readonly maxResponseBytes?: number; readonly headers?: Readonly<Record<string, string>>; readonly plainHttp?: boolean } = {}): Promise<SiteResponse> => {
    checkCancelled();
    if (probed >= limits.maxRequests) throw new SiteCheckError('request budget spent', 'SITE_BUDGET');
    const left = remaining();
    if (left < 1000) throw new SiteCheckError('time budget spent', 'SITE_BUDGET');
    probed += 1;
    return withinBudget(budget => transport({
      url: /^https?:\/\//.test(target) ? target : `${origin}${target}`, profile: 'site-probe', method, maxResponseBytes, plainHttp: plainHttp || undefined,
      headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'Nebulaverse-X-SiteCheck/2.0', ...headers },
      ...budget
    }), Math.min(limits.requestMs, left));
  };
  const raw: RawFinding[] = [];
  const ledger = new Map<string, LedgerEntry>();
  const gaps = new Map<string, Set<string>>();
  const counts = new Map<string, Counts>();
  const emptyCounts = (): Counts => ({ attempted: 0, completed: 0, read: 0, negative: 0, unknown: 0, truncated: 0, skipped: 0 });
  const incomplete = (id: string, reason: string): void => {
    const reasons = gaps.get(id) || new Set<string>();
    gaps.set(id, reasons);
    reasons.add(reason);
  };
  const observed = (id: string, response: SiteResponse | null, { negative = false } = {}): boolean => {
    const count = counts.get(id) || emptyCounts();
    count.attempted += 1;
    const negativeStatus = negative && [401, 403, 404, 410].includes(response ? response.statusCode : NaN);
    const readable = Boolean(response && !response.bodyUnread && (typeof response.body === 'string' || Buffer.isBuffer(response.body)));
    const ok = Boolean(response && (negativeStatus || (response.statusCode >= 200 && response.statusCode < 300 && readable && !response.truncated)));
    if (negativeStatus) count.negative += 1;
    else if (readable) count.read += 1;
    if (ok) count.completed += 1;
    else {
      count.unknown += 1;
      if (response && response.truncated) { count.truncated += 1; incomplete(id, 'Response body exceeded the read limit'); }
      else if (response && response.bodyUnread) incomplete(id, 'Response body could not be read');
      else if (response) incomplete(id, 'A response did not establish the check result');
      else incomplete(id, 'A request failed or the scan budget was exhausted');
    }
    counts.set(id, count);
    return ok;
  };
  const skipped = (id: string, reason: string, total = 1): void => {
    const count = counts.get(id) || emptyCounts();
    count.skipped += total;
    counts.set(id, count);
    incomplete(id, reason);
  };
  const note = (id: string, state: LedgerState, detail: string): void => { ledger.set(id, { id, state, detail }); };

  /*
   * The page a visitor lands on, not the redirect in front of it: most sites
   * answer / with a hop to www or to a locale, and a redirect's headers are
   * not the page's. Each hop is a new request through the same guarded
   * profile, only to HTTPS on 443, at most three of them; the cookies set on
   * the way are the visitor's cookies too.
   */
  progress({ stage: 'page' });
  let page: SiteResponse;
  let pathname = '/';
  let redirects = 0;
  const cookies: unknown[] = [];
  for (let hop = 0; ; hop += 1) {
    try { page = await request(pathname, { maxResponseBytes: limits.pageBytes }); }
    catch {
      checkCancelled();
      throw new SiteCheckError('The site could not be reached over valid HTTPS from here. Check the address, and that it has a public certificate.', 'SITE_UNREACHABLE', 502);
    }
    const headers = page.headers || {};
    cookies.push(...listOf(headers['set-cookie']));
    const location = page.statusCode >= 300 && page.statusCode < 400 ? String(headers.location || '') : '';
    if (!location) break;
    if (hop === MAX_REDIRECTS) {
      throw new SiteCheckError('The site kept redirecting without settling on a page, so there is no page to check.', 'SITE_REDIRECT_LOOP', 502);
    }
    let next: URL;
    try { next = new URL(location, `${origin}${pathname}`); origin = siteOrigin(next.href); }
    catch {
      throw new SiteCheckError('The site redirected to an address that is not HTTPS on the standard port, so the check stopped there.', 'SITE_REDIRECT_REFUSED', 502);
    }
    pathname = `${next.pathname || '/'}${next.search}`;
    redirects += 1;
  }
  const landing = pathname;
  const pageHeaders = page.headers || {};
  observed('pages', page);
  raw.push(...headerFindings(pageHeaders));
  const html = looksLikeHtml(page) ? String(page.body || '') : '';
  const host = new URL(origin).hostname;
  const HEADER_FAILURES: Readonly<Record<string, readonly SiteRuleId[]>> = { 'strict-transport-security': ['WEB-003', 'WEB-004'], 'content-security-policy': ['WEB-005', 'WEB-006', 'WEB-017', 'WEB-032'], 'x-frame-options': ['WEB-007'], 'x-content-type-options': ['WEB-008'], 'referrer-policy': ['WEB-009'], 'cross-origin-opener-policy': ['WEB-016'] };
  const effectiveHeader = (name: string): boolean | null => {
    const failures = ownEntry(HEADER_FAILURES, name);
    return failures ? !raw.some(finding => failures.includes(finding.rule)) : null;
  };
  const protectiveHeaders = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'cross-origin-opener-policy'];
  const effectiveHeaders = protectiveHeaders.filter(effectiveHeader).length;
  note('headers', effectiveHeaders >= 6 ? 'pass' : effectiveHeaders >= 3 ? 'warn' : 'fail', `${effectiveHeaders} of the 6 header protections meet the checked requirements`);

  /* ---- The connection: certificate, protocol, plain HTTP, cross-origin reads ---- */
  progress({ stage: 'transport' });
  const tls = page.tls || null;
  let certificate: { readonly protocol: string | null; readonly validTo: string; readonly daysLeft: number; readonly issuer: string | null } | null = null;
  if (tls && tls.validTo && Number.isFinite(new Date(tls.validTo).getTime())) {
    const daysLeft = Math.floor((new Date(tls.validTo).getTime() - now()) / 86_400_000);
    certificate = Object.freeze({ protocol: tls.protocol || null, validTo: tls.validTo, daysLeft, issuer: tls.issuer || null });
    if (daysLeft <= 14) raw.push({ rule: 'WEB-029', where: `Certificate for ${host}` });
    else if (daysLeft <= 30) raw.push({ rule: 'WEB-030', where: `Certificate for ${host}` });
    note('certificate', daysLeft <= 14 ? 'fail' : daysLeft <= 30 ? 'warn' : 'pass', `Valid for ${Math.max(0, daysLeft)} more days${tls.issuer ? `, issued by ${tls.issuer}` : ''}`);
  } else {
    note('certificate', 'unknown', 'The certificate’s dates were not available to the check');
  }
  if (tls && /^(?:TLSv1(?:\.1)?|SSLv3)$/.test(tls.protocol || '')) raw.push({ rule: 'WEB-031', where: `${tls.protocol} on ${host}` });
  if (tls && tls.protocol) note('protocol', /^(?:TLSv1(?:\.1)?|SSLv3)$/.test(tls.protocol) ? 'fail' : 'pass', `Negotiated ${tls.protocol.replace('TLSv', 'TLS ')}`);

  let plain: PlainHttp = 'unknown';
  try {
    const answer = await request(`http://${host}/`, { plainHttp: true });
    const location = String(answer.headers && answer.headers.location || '');
    const upgrades = answer.statusCode >= 300 && answer.statusCode < 400 && /^https:\/\//i.test(location);
    plain = upgrades ? 'redirects' : answer.statusCode >= 200 && answer.statusCode < 400 ? 'serves' : [401, 403, 404, 410].includes(answer.statusCode) ? 'refuses' : 'unknown';
    if (plain === 'serves') raw.push({ rule: 'WEB-020', where: `http://${host}/` });
  } catch (error) {
    plain = read(error, 'transportCode') === 'ECONNREFUSED' ? 'closed' : 'unknown';
  }
  const PLAIN_DETAIL: Readonly<Record<PlainHttp, string>> = { redirects: 'Plain HTTP redirects to HTTPS', serves: 'Plain HTTP serves the site without redirecting', refuses: 'Plain HTTP answers with an error, not the site', closed: 'Nothing answers on plain HTTP', unknown: 'Plain HTTP was not checked' };
  note('plain-http', plain === 'serves' ? 'fail' : plain === 'unknown' ? 'unknown' : 'pass', PLAIN_DETAIL[plain]);
  const hsts: HstsSummary | null = hstsSummary(pageHeaders['strict-transport-security']);
  if (hsts) note('hsts', (hsts.maxAge ?? 0) >= 15552000 ? 'pass' : 'warn',
    `HSTS for ${Math.round((hsts.maxAge || 0) / 86400)} days${hsts.includeSubDomains ? ', subdomains included' : ''}${hsts.preload && (hsts.maxAge ?? 0) >= 31536000 && hsts.includeSubDomains ? ', ready for the preload list' : ''}`);
  else note('hsts', 'fail', 'No Strict-Transport-Security header');

  /* Does the site let any other website read its answers with the visitor's cookies? Asked once, as another origin would. */
  const foreignOrigin = 'https://nv-origin-check.invalid';
  try {
    const answer = await request(landing, { headers: { origin: foreignOrigin } });
    const allowed = String(answer.headers && answer.headers['access-control-allow-origin'] || '').trim();
    const credentials = corsCredentials(answer.headers || {});
    const reflected = (allowed === foreignOrigin || allowed === 'null') && credentials;
    const wildcard = allowed === '*' && credentials;
    if (reflected) raw.push({ rule: 'WEB-010', where: 'Access-Control-Allow-Origin (accepts the untrusted test origin)' });
    if (wildcard && !raw.some(finding => finding.rule === 'WEB-037')) raw.push({ rule: 'WEB-037', where: 'Access-Control-Allow-Origin' });
    if (!(answer.statusCode >= 200 && answer.statusCode < 300)) incomplete('cors', 'The tested endpoint did not return a successful response');
    note('cors', reflected ? 'fail' : wildcard ? 'warn' : 'pass', reflected ? 'This endpoint permits credentialed reads from the tested untrusted origin' : wildcard ? 'Browsers reject credentialed CORS with a wildcard origin' : 'This endpoint did not allow credentialed reads from the tested untrusted origin');
  } catch {
    note('cors', 'unknown', 'Cross-origin access was not checked');
  }

  /* ---- Paths that must never be served, told apart from a catch-all page ------- */
  progress({ stage: 'paths', done: 0, total: PROBES.length + 2 });
  try {
    const missing = await request(`/nv-site-check-${random()}`, { maxResponseBytes: limits.errorPageBytes });
    if (missing.bodyUnread || missing.truncated || missing.statusCode >= 500 || missing.statusCode < 200 || (missing.statusCode >= 300 && missing.statusCode < 400)) incomplete('errors', 'The missing-page response was incomplete or inconclusive');
    const body = String(missing.body || '');
    const debug = DEBUG_SIGNATURES.find(([pattern]) => pattern.test(body));
    if (debug) raw.push({ rule: 'WEB-021', where: `${debug[1]} on a missing page` });
    note('errors', debug ? 'fail' : 'pass', debug ? `A missing page shows a ${debug[1]}` : `A missing page answers ${missing.statusCode} without a stack trace`);
  } catch {
    note('errors', 'unknown', 'The error page was not checked');
  }
  if (DIRECTORY_LISTING.test(html)) raw.push({ rule: 'WEB-022', where: displayPath(landing) });
  let served = 0;
  let asked = 0;
  let done = 0;
  await boundedMap(PROBES, limits.concurrency, async probe => {
    let response: SiteResponse;
    try { response = await request(probe.path); asked += 1; observed('paths', response, { negative: true }); }
    catch { observed('paths', null); return; }
    finally { done += 1; progress({ stage: 'paths', done, total: PROBES.length + 2 }); }
    if (response.statusCode !== 200 || response.bodyUnread) return;
    if (!probe.html && looksLikeHtml(response)) return;
    const body = String(response.body || '');
    if (probe.looks(body)) {
      served += 1;
      raw.push({ rule: probe.rule, where: probe.path });
    }
  });
  note('paths', served ? 'fail' : gaps.has('paths') ? 'unknown' : 'pass', served
    ? `${served} of ${asked} paths that should never be served ${served === 1 ? 'is' : 'are'} served`
    : `${counts.get('paths')?.completed ?? 0} of ${PROBES.length} sensitive paths assessed; no exposure found in the completed checks`);

  let securityTxt: { readonly contact: boolean; readonly expires: string | null } = { contact: false, expires: null };
  let contactKnown = false;
  try {
    const response = await request('/.well-known/security.txt', { maxResponseBytes: 8192 });
    contactKnown = observed('contact', response, { negative: true });
    const body = String(response.body || '');
    if (response.statusCode === 200 && !looksLikeHtml(response)) {
      const expires = /^\s*Expires:\s*(\S+)/im.exec(body);
      const date = expires ? new Date(expires[1] ?? '') : null;
      securityTxt = { contact: /^\s*Contact:/im.test(body), expires: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null };
    }
  } catch { observed('contact', null); }
  progress({ stage: 'paths', done: PROBES.length + 1, total: PROBES.length + 2 });
  /* Read when it is asked, each time: the clock is the caller's. */
  const contactExpired = (): boolean => !securityTxt.expires || new Date(securityTxt.expires).getTime() < now();
  if (contactKnown && !securityTxt.contact) raw.push({ rule: 'WEB-014', where: '/.well-known/security.txt' });
  else if (contactKnown && contactExpired()) raw.push({ rule: 'WEB-026', where: '/.well-known/security.txt' });
  note('contact', !contactKnown ? 'unknown' : !securityTxt.contact ? 'fail' : contactExpired() ? 'warn' : 'pass',
    !contactKnown ? 'The security contact could not be assessed' : !securityTxt.contact ? 'No security contact is published' : securityTxt.expires ? `security.txt names a contact until ${securityTxt.expires.slice(0, 10)}` : 'security.txt names a contact but no expiry');

  let disallowed: string[] = [];
  let robotsKnown = false;
  try {
    const robots = await request('/robots.txt', { maxResponseBytes: 16 * 1024 });
    robotsKnown = observed('robots', robots, { negative: true });
    if (robots.statusCode === 200 && !looksLikeHtml(robots)) disallowed = robotsDisallowed(robots.body);
  } catch { observed('robots', null); }
  note('robots', robotsKnown ? 'pass' : 'unknown', robotsKnown ? 'Robots policy assessed before following links' : 'Robots policy unavailable; linked pages were not crawled');
  progress({ stage: 'paths', done: PROBES.length + 2, total: PROBES.length + 2 });

  /* ---- Pages a visitor reaches from the landing page ---------------------------- */
  const pages: VisitedPage[] = [{ path: displayPath(new URL(landing, origin).pathname), address: `${origin}${landing}`, status: page.statusCode, html }];
  const linkedPages = pageLinks(html, `${origin}${landing}`, origin, disallowed);
  const toVisit = robotsKnown ? linkedPages.slice(0, limits.maxPages) : [];
  if (linkedPages.length > toVisit.length) skipped('pages', robotsKnown ? 'Linked-page limit reached' : 'Linked pages skipped because robots policy was unavailable', linkedPages.length - toVisit.length);
  progress({ stage: 'pages', done: 0, total: toVisit.length });
  let visited = 0;
  await boundedMap(toVisit, limits.concurrency, async path => {
    try {
      const response = await request(path, { maxResponseBytes: limits.pageBytes });
      observed('pages', response);
      const headers = response.headers || {};
      cookies.push(...listOf(headers['set-cookie']));
      const body = looksLikeHtml(response) ? String(response.body || '') : '';
      pages.push({ path: displayPath(new URL(path, origin).pathname), address: `${origin}${path}`, status: response.statusCode, html: body });
      /* Debug signatures are read once per page below, together with the landing page. */
      if (body && DIRECTORY_LISTING.test(body)) raw.push({ rule: 'WEB-022', where: displayPath(path) });
    } catch { observed('pages', null); }
    finally { visited += 1; progress({ stage: 'pages', done: visited, total: toVisit.length }); }
  });
  for (const visitedPage of pages) {
    if (!visitedPage.html) continue;
    const debug = DEBUG_SIGNATURES.find(([pattern, , anywhere]) => anywhere && pattern.test(visitedPage.html));
    if (debug) raw.push({ rule: 'WEB-021', where: `${debug[1]} on ${visitedPage.path}` });
    raw.push(...markupFindings(visitedPage.html, origin, visitedPage.address));
    const detected = shippedSecrets(visitedPage.html);
    if (detected.truncated) incomplete('pages', 'Credential detector reached its candidate limit');
    for (const secret of detected.secrets) raw.push({ rule: 'WEB-023', where: `${secret.kind} in ${visitedPage.path}`, soft: SOFTER_SECRETS.has(secret.rule) });
  }
  raw.push(...cookieFindings(cookies));
  note('pages', 'pass', `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} read: ${pages.map(entry => entry.path).slice(0, 6).join(', ')}${disallowed.length ? '; robots.txt honoured' : ''}`);
  const cookieNames = new Set(cookies.map(cookie => (String(cookie).split('=')[0] ?? '').trim()).filter(Boolean));
  note('cookies', raw.some(item => item.rule === 'WEB-011') ? 'fail' : raw.some(item => item.rule === 'WEB-012') ? 'warn' : 'pass',
    cookieNames.size ? `${cookieNames.size} ${cookieNames.size === 1 ? 'cookie' : 'cookies'} set to an anonymous visitor` : 'No cookie set to an anonymous visitor');

  /* ---- The JavaScript the pages load --------------------------------------------- */
  const allScripts = [...new Set(pages.flatMap(entry => scriptSources(entry.html, entry.address, () => skipped('scripts', 'A script address was malformed'))))];
  const ownScripts = allScripts.filter(address => hostOf(address) === new URL(origin).host && /^https:/.test(address));
  const own = ownScripts.slice(0, limits.maxScripts);
  if (ownScripts.length > own.length) skipped('scripts', 'Same-origin script limit reached', ownScripts.length - own.length);
  if (gaps.has('pages')) incomplete('scripts', 'Page coverage was incomplete, so resource discovery may be incomplete');
  const thirdParty = [...new Set(allScripts.filter(address => hostOf(address) && hostOf(address) !== new URL(origin).host).map(hostOf))].slice(0, 12);
  const libraries = new Map<string, Library>();
  const addLibrary = (found: Library | null): void => {
    if (!found || !found.name || !VERSION.test(found.version)) return;
    const key = `${found.name}@${found.version}`;
    if (!libraries.has(key)) {
      if (libraries.size < limits.maxLibraries) libraries.set(key, found);
      else incomplete('libraries', 'Recognised-library limit reached');
    }
  };
  allScripts.forEach(address => addLibrary(libraryFromAddress(address)));
  progress({ stage: 'scripts', done: 0, total: own.length });
  let scriptBytes = 0;
  let reservedBytes = 0;
  let scriptsRead = 0;
  let mapsPublic = 0;
  const maps: string[] = [];
  let scanned = 0;
  await boundedMap(own, limits.concurrency, async address => {
    let reservation = 0;
    try {
      reservation = Math.min(limits.scriptBytes, limits.scriptBudgetBytes - scriptBytes - reservedBytes);
      if (reservation < 1024) { skipped('scripts', 'Script byte budget exhausted'); return; }
      reservedBytes += reservation;
      const response = await request(address, { maxResponseBytes: reservation });
      observed('scripts', response);
      if (response.statusCode !== 200 || response.bodyUnread) return;
      const text = String(response.body || '');
      scriptBytes += Buffer.byteLength(text, 'utf8');
      scriptsRead += 1;
      const path = displayPath(new URL(address).pathname);
      const detected = shippedSecrets(text);
      if (detected.truncated) incomplete('scripts', 'Credential detector reached its candidate limit');
      for (const secret of detected.secrets) raw.push({ rule: 'WEB-023', where: `${secret.kind} in ${path}`, soft: SOFTER_SECRETS.has(secret.rule) });
      librariesInText(text).forEach(addLibrary);
      const declared = [...text.slice(-4096).matchAll(/\/[/*][#@]\s*sourceMappingURL=([^\s'"*]+)/g)].pop();
      const header = response.headers && (response.headers.sourcemap || response.headers['x-sourcemap']);
      const reference = header || (declared && declared[1]);
      if (reference && !/^data:/i.test(String(reference))) {
        try {
          const map = new URL(String(reference), address);
          map.hash = '';
          if (map.origin === origin) {
            if (maps.length < limits.maxMaps) maps.push(map.href);
            else incomplete('maps', 'Referenced source-map limit reached');
          }
        } catch { /* not an address */ }
      }
    } catch { observed('scripts', null); }
    finally { if (reservation >= 1024) reservedBytes -= reservation; scanned += 1; progress({ stage: 'scripts', done: scanned, total: own.length }); }
  });
  await boundedMap(maps, limits.concurrency, async address => {
    try {
      const response = await request(address, { maxResponseBytes: 1024 });
      const identified = response.statusCode === 200 && !response.bodyUnread && /^\s*\{\s*"version"\s*:\s*3\b|"mappings"\s*:/.test(String(response.body || ''));
      // A recognisable prefix establishes map publication even if the rest is bounded.
      observed('maps', identified ? { ...response, truncated: false } : response, { negative: true });
      if (identified) {
        mapsPublic += 1;
        raw.push({ rule: 'WEB-024', where: displayPath(new URL(address).pathname) });
      }
    } catch { observed('maps', null); }
  });
  const secretsFound = raw.filter(item => item.rule === 'WEB-023').length;
  note('scripts', secretsFound ? 'fail' : gaps.has('scripts') ? 'unknown' : 'pass', own.length
    ? `${scriptsRead} of ${ownScripts.length} ${ownScripts.length === 1 ? 'script' : 'scripts'} on this origin read (${scriptBytes < 1024 ? 'under 1 KB' : `${Math.round(scriptBytes / 1024)} KB`})${secretsFound ? `; ${secretsFound} secret${secretsFound === 1 ? '' : 's'} found` : ', no server-side secret detected in the bytes assessed'}`
    : 'No script is loaded from this origin');
  note('maps', mapsPublic ? 'warn' : 'pass', mapsPublic ? `${mapsPublic} source ${mapsPublic === 1 ? 'map is' : 'maps are'} public` : maps.length ? 'Referenced source maps are not served' : 'No source map is referenced');
  if (gaps.has('scripts')) {
    incomplete('maps', 'Script coverage was incomplete, so source-map discovery may be incomplete');
    incomplete('libraries', 'Script coverage was incomplete, so library discovery may be incomplete');
  }

  /* ---- Libraries against the advisory database ----------------------------------- */
  const libraryList = [...libraries.values()];
  const libraryReport: LibraryReport[] = [];
  progress({ stage: 'libraries', done: 0, total: libraryList.length });
  if (libraryList.length && typeof advisoryTransport === 'function') {
    let answers: ReadonlyMap<string, AdvisoryAnswer> | null = null;
    try {
      ({ answers } = await withinBudget(() => lookupAdvisories(libraryList.map(entry => ({ ecosystem: 'npm', name: entry.name, version: entry.version })),
        input => withinBudget(budget => advisoryTransport({ ...input, ...budget }), limits.requestMs))));
    } catch { answers = null; }
    for (const entry of libraryList) {
      const answer = answers && answers.get(advisoryKey({ ecosystem: 'npm', name: entry.name, version: entry.version }));
      if (!answer || answer === 'unknown') { libraryReport.push({ ...entry, state: 'unknown', advisories: 0 }); continue; }
      const advisories = answer.advisories || [];
      const rated = advisories.filter(advisory => advisory.severity);
      const worst = rated.flatMap(advisory => (advisory.severity ? [advisory.severity] : [])).sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])[0] || (advisories.length ? 'warning' : null);
      const fixes = rated.flatMap(advisory => (advisory.fixed ? [advisory.fixed] : []));
      const fixed = rated.length && fixes.length === rated.length ? fixes.sort(compareVersions)[fixes.length - 1] ?? null : null;
      libraryReport.push({ ...entry, state: advisories.length ? 'vulnerable' : 'clean', advisories: advisories.length, severity: worst, fixed, ids: advisories.slice(0, 4).map(advisory => advisory.cve || advisory.id) });
      if (advisories.length) {
        raw.push({
          rule: 'WEB-025', where: `${entry.name} ${entry.version}`,
          severity: worst === 'critical' ? 'serious' : worst === 'serious' ? 'serious' : 'warning',
          note: `${advisories.length} published ${advisories.length === 1 ? 'advisory' : 'advisories'}: ${advisories.slice(0, 4).map(advisory => advisory.cve || advisory.id).join(', ')}.`,
          fixNote: fixed ? `Version ${fixed} fixes ${advisories.length === 1 ? 'it' : 'them'}.` : ''
        });
      }
    }
  } else {
    libraryList.forEach(entry => libraryReport.push({ ...entry, state: 'unknown', advisories: 0 }));
  }
  progress({ stage: 'libraries', done: libraryList.length, total: libraryList.length });
  const vulnerable = libraryReport.filter(entry => entry.state === 'vulnerable').length;
  if (libraryReport.some(entry => entry.state === 'unknown')) incomplete('libraries', 'Not all recognised libraries were checked against advisories');
  note('libraries', vulnerable ? 'fail' : libraryReport.some(entry => entry.state === 'unknown') ? 'unknown' : 'pass', libraryList.length
    ? `${libraryList.length} ${libraryList.length === 1 ? 'library' : 'libraries'} recognised${vulnerable ? `, ${vulnerable} with published advisories` : libraryReport.some(entry => entry.state === 'unknown') ? ', not all checked against advisories' : ', none with a published advisory'}`
    : 'No versioned browser library recognised');

  /* ---- Email: can someone send mail as this domain? ------------------------------ */
  progress({ stage: 'email' });
  const mail = emailDomain(host);
  let email: Email;
  if (mail.skipped) {
    email = { state: 'skipped', reason: mail.skipped, domain: null, spf: null, dmarc: null };
    note('email', 'skip', mail.skipped === 'shared-platform' ? 'Skipped: the site is on a shared platform’s domain, whose email is not the site’s' : 'Skipped: no domain to look up');
  } else if (typeof txt !== 'function') {
    email = { state: 'unknown', reason: 'not-asked', domain: mail.domain, spf: null, dmarc: null };
    note('email', 'unknown', 'The domain’s email policy was not looked up');
  } else {
    let spf: SpfState | null = null;
    let dmarc: DmarcState | null = null;
    try { spf = spfState(await withinBudget(budget => txt(mail.domain, budget), limits.requestMs)); } catch { spf = null; }
    try { dmarc = dmarcState(await withinBudget(budget => txt(`_dmarc.${mail.domain}`, budget), limits.requestMs)); } catch { dmarc = null; }
    if (spf === 'missing' || spf === 'open' || spf === 'invalid') raw.push({ rule: 'WEB-028', where: `${mail.domain} (SPF ${spf === 'open' ? 'allows anyone' : spf})` });
    if (dmarc === 'missing' || dmarc === 'none' || dmarc === 'invalid') raw.push({ rule: 'WEB-027', where: `_dmarc.${mail.domain} (${dmarc === 'none' ? 'p=none' : dmarc})` });
    email = { state: spf === null || dmarc === null ? 'partial' : 'checked', reason: null, domain: mail.domain, spf, dmarc };
    if (spf === null || dmarc === null) incomplete('email', 'Not all email DNS lookups completed');
    note('email', dmarc === 'missing' || dmarc === 'none' || dmarc === 'invalid' || spf === 'missing' || spf === 'open' || spf === 'invalid' ? 'warn' : spf === null || dmarc === null ? 'unknown' : 'pass',
      `${mail.domain}: SPF ${spf || 'unknown'}, DMARC ${dmarc === null ? 'unknown' : dmarc === 'missing' ? 'missing' : dmarc === 'invalid' ? 'record malformed' : `p=${dmarc}`}`);
  }

  /* ---- The report ------------------------------------------------------------------ */
  const seen = new Set<string>();
  const findings = raw.filter(item => {
    const key = `${item.rule}\0${item.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => describe(item.rule, item.where, {
    severity: item.severity || (item.soft ? 'warning' : null),
    note: item.note, fixNote: item.fixNote
  }));
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rule.localeCompare(b.rule) || a.where.localeCompare(b.where));
  const byRule = new Map<string, number>();
  for (const finding of findings) {
    const cap = PENALTY[finding.severity] * 2;
    byRule.set(finding.rule, Math.min(cap, (byRule.get(finding.rule) || 0) + PENALTY[finding.severity]));
  }
  const mean = Math.max(0, 100 - [...byRule.values()].reduce((total, penalty) => total + penalty, 0));
  const critical = findings.some(finding => finding.severity === 'critical');
  const observedScore = critical ? Math.min(mean, CRITICAL_CAP) : mean;
  if (!ledger.has('protocol')) note('protocol', 'unknown', 'The negotiated TLS version was unavailable');
  const LEDGER_ORDER = ['certificate', 'protocol', 'plain-http', 'hsts', 'headers', 'cookies', 'cors', 'paths', 'errors', 'robots', 'pages', 'scripts', 'maps', 'libraries', 'contact', 'email'];
  const categories: Record<string, CategoryCoverage> = {};
  for (const id of LEDGER_ORDER) {
    const entry = ledger.get(id);
    if (!entry) continue;
    if (entry.state === 'unknown') incomplete(id, entry.detail);
    const reasons = [...(gaps.get(id) || [])];
    const statistics = counts.get(id) || { attempted: entry.state === 'skip' ? 0 : 1, completed: reasons.length ? 0 : entry.state === 'skip' ? 0 : 1, read: 0, negative: 0, unknown: reasons.length ? 1 : 0, truncated: 0, skipped: entry.state === 'skip' ? 1 : 0 };
    const complete = !reasons.length;
    categories[id] = { state: complete ? 'complete' : statistics.completed ? 'partial' : 'unknown', complete, reasons, ...statistics };
    if (!complete && entry.state === 'pass') note(id, 'unknown', `${entry.detail}; coverage incomplete`);
  }
  const reasons = Object.entries(categories).flatMap(([id, category]) => category.reasons.map(reason => `${id}: ${reason}`));
  const complete = reasons.length === 0;
  const coverage = { state: complete ? 'complete' : Object.values(categories).some(category => category.completed > 0) ? 'partial' : 'unknown', complete, reasons, categories };
  checkCancelled();
  const grade: Grade | null = complete ? gradeOf(observedScore) : null;
  return {
    engine: 3,
    origin,
    requested,
    redirects,
    status: page.statusCode,
    requests: probed,
    score: complete ? observedScore : null,
    grade,
    observedScore,
    coverage,
    scope: { mode: 'anonymous-security-snapshot', requestCount: 'site-http-only', limitations: ['Checks cover only the observed anonymous pages and resources; authenticated content, dynamic imports and third-party script bodies are not assessed.', 'Library advisories describe published package risks; browser exploitability is not established.', 'A negotiated TLS version does not establish which other protocol versions the server accepts.'] },
    capped: critical && mean > CRITICAL_CAP,
    findings,
    /*
     * The headers a browser enforces, each sent or not. X-Frame-Options is
     * the old spelling of CSP frame-ancestors; a page that sends the newer
     * one is protected, and says so rather than showing a missing header.
     */
    headers: Object.freeze(['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy']
      .map(name => {
        const present = Boolean(pageHeaders[name]);
        const via = !present && name === 'x-frame-options' && frameProtected(pageHeaders)
          ? 'content-security-policy' : null;
        return Object.freeze({ name, present, via, effective: effectiveHeader(name) });
      })),
    transport: Object.freeze({ certificate, plainHttp: plain, hsts }),
    pages: pages.map(entry => Object.freeze({ path: entry.path, status: entry.status })),
    scripts: Object.freeze({ read: scriptsRead, onOrigin: ownScripts.length, kilobytes: Math.ceil(scriptBytes / 1024), thirdParty, sourceMaps: mapsPublic }),
    libraries: libraryReport.map(entry => Object.freeze({ name: entry.name, version: entry.version, source: entry.source, state: entry.state, advisories: entry.advisories, severity: entry.severity || null, fixed: entry.fixed || null, ids: entry.ids || [] })),
    email: Object.freeze(email),
    ledger: LEDGER_ORDER.flatMap(id => { const entry = ledger.get(id); return entry ? [Object.freeze(entry)] : []; }),
    durationMs: Math.max(0, now() - startedAt)
  };
}

export type SiteReport = Awaited<ReturnType<typeof checkSite>>;
