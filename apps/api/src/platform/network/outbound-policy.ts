import * as dns from 'node:dns';
import type * as http from 'node:http';
import { isIP } from 'node:net';
import { isPublicAddress } from './public-address.ts';

/*
 * What the guarded transport may reach, and how it refuses.
 *
 * The profiles and what each may do, the bounds on a response, the codes a
 * refusal carries, and the checks made before a connection is opened: the
 * target's address and name, every address a name resolves to, and that no
 * credential rides in the URL. guarded-fetch.ts makes the connections; this
 * is what it asks first, and what its callers name a refusal by.
 */

export const PROFILES = Object.freeze({
  /* A signed POST to an endpoint the reader configured. Its URL policy is the
     one that shipped: no query, no fragment, port 443, and the body is bytes
     that have already been signed and must not be touched. */
  WEBHOOK: 'signed-webhook',
  /* A read of a provider API. Carries a query string, returns a bounded body,
     and never carries a URL that came out of a repository. */
  PROVIDER_READ: 'provider-read',
  /*
   * A probe that carries a discovered credential to the provider that issued
   * it. It differs from a provider read in one direction each way, and both
   * directions are the point.
   *
   * It may POST, because which method a provider documents for its identity
   * endpoint is that provider's decision and not this repository's -- Slack's
   * `auth.test` is the case in hand.
   *
   * It may not carry a query string at all. A query string is the part of a
   * request that survives into an access log, a referrer header and every
   * proxy in between, and this is the one profile whose request contains a
   * secret. Putting the credential in a header is only half of that; refusing
   * the query string outright is the half that cannot be forgotten at a call
   * site.
   */
  CREDENTIAL_VERIFY: 'credential-verify',
  /*
   * An anonymous look at a deployed site, the way any visitor's browser sees
   * it: GET or HEAD, cache-busting queries allowed, no credential of any kind, and the
   * response headers returned beside the status -- they are most of what a
   * site check is about. The body is read only as far as the caller's bound
   * and then cut, never refused: a probe needs the first bytes of a file to
   * recognise it, not the whole of a page. A compressed body is not
   * decompressed; it is reported as unread and the headers still arrive.
   */
  SITE_PROBE: 'site-probe',
  /* Anonymous browser resources use the same DNS and TLS guard. Binary
     bodies preserve images/fonts; redirects are returned, never followed. */
  RENDERED_SITE: 'rendered-site',
  /*
   * A question to the public vulnerability database about packages a
   * repository declares: a name, an ecosystem and a version, nothing else.
   * It may POST, because OSV's batch query is a POST, and it may reach one
   * host only -- the database -- so the profile cannot be borrowed to send a
   * body anywhere else. It is anonymous: no credential, no cookie.
   */
  ADVISORY_QUERY: 'advisory-query',
  /*
   * Public exploit intelligence about advisories already found: FIRST's EPSS
   * scores and CISA's catalog of vulnerabilities known to be exploited. GET
   * only, with a query string (EPSS takes its CVE list there), anonymous,
   * and bound to those two hosts, so nothing but CVE identifiers ever leaves
   * and nothing else can be reached through it. The catalog runs to a few
   * megabytes, so this profile may read as much as a provider read.
   */
  THREAT_INTEL: 'threat-intel',
  /*
   * A question to deps.dev about the licence of a package version a
   * repository depends on: an ecosystem, a name and a version in the path,
   * nothing else. GET only, no query string, anonymous, and bound to that
   * one host, so the profile cannot be borrowed to reach anything else.
   */
  LICENCE_QUERY: 'licence-query',
  /*
   * A read of a provider's query API: GitHub's GraphQL endpoint, which returns
   * the text of many files at one commit in a single request where the REST
   * API needs one request per file. It may POST, because GraphQL is a POST,
   * and only to that one host and that one path, so the profile cannot be
   * borrowed to send a body, or the credential it carries, anywhere else.
   */
  PROVIDER_QUERY: 'provider-query'
} as const);

export type Profile = (typeof PROFILES)[keyof typeof PROFILES];

/* What a profile may do. Absent flags are false. */
interface ProfileRule {
  readonly methods: readonly string[];
  readonly query: boolean;
  readonly readsBody: boolean;
  readonly headers?: boolean;
  readonly truncates?: boolean;
  readonly tls?: boolean;
  readonly plainHttp?: boolean;
  readonly binary?: boolean;
  readonly hosts?: readonly string[];
  readonly paths?: readonly string[];
}

const PROFILE_RULES: Readonly<Record<string, ProfileRule>> = Object.freeze({
  [PROFILES.WEBHOOK]: Object.freeze({ methods: Object.freeze(['POST']), query: false, readsBody: false }),
  [PROFILES.PROVIDER_READ]: Object.freeze({ methods: Object.freeze(['GET', 'HEAD']), query: true, readsBody: true }),
  [PROFILES.CREDENTIAL_VERIFY]: Object.freeze({ methods: Object.freeze(['GET', 'POST']), query: false, readsBody: true }),
  [PROFILES.SITE_PROBE]: Object.freeze({ methods: Object.freeze(['GET', 'HEAD']), query: true, readsBody: true, headers: true, truncates: true, tls: true, plainHttp: true }),
  [PROFILES.RENDERED_SITE]: Object.freeze({ methods: Object.freeze(['GET', 'HEAD']), query: true, readsBody: true, headers: true, truncates: true, tls: true, binary: true }),
  [PROFILES.ADVISORY_QUERY]: Object.freeze({ methods: Object.freeze(['GET', 'POST']), query: false, readsBody: true, hosts: Object.freeze(['api.osv.dev']) }),
  [PROFILES.THREAT_INTEL]: Object.freeze({ methods: Object.freeze(['GET']), query: true, readsBody: true, hosts: Object.freeze(['api.first.org', 'www.cisa.gov']) }),
  [PROFILES.LICENCE_QUERY]: Object.freeze({ methods: Object.freeze(['GET']), query: false, readsBody: true, hosts: Object.freeze(['api.deps.dev']) }),
  [PROFILES.PROVIDER_QUERY]: Object.freeze({ methods: Object.freeze(['POST']), query: false, readsBody: true, hosts: Object.freeze(['api.github.com']), paths: Object.freeze(['/graphql']) })
});

/* The profiles that never carry a credential, and what the refusal says. */
export const ANONYMOUS: Readonly<Record<string, string>> = Object.freeze({
  [PROFILES.SITE_PROBE]: 'A site probe must be anonymous',
  [PROFILES.RENDERED_SITE]: 'A rendered site request must be anonymous',
  [PROFILES.ADVISORY_QUERY]: 'An advisory query must be anonymous',
  [PROFILES.LICENCE_QUERY]: 'A licence query must be anonymous',
  [PROFILES.THREAT_INTEL]: 'An exploit-intelligence read must be anonymous'
});

/* Response headers as a probe may see them: lower-cased names, bounded values. */
export type ProbeHeaders = Readonly<Record<string, string | string[]>>;

export function boundedHeaders(raw: http.IncomingHttpHeaders | null | undefined): ProbeHeaders {
  const out: Record<string, string | string[]> = {};
  let count = 0;
  for (const [name, value] of Object.entries(raw || {})) {
    if (count++ >= 64) break;
    const values = (Array.isArray(value) ? value : [value]).slice(0, 16).map(item => String(item).slice(0, 2048));
    out[String(name).toLowerCase()] = name.toLowerCase() === 'set-cookie' ? values : values.join(', ');
  }
  return Object.freeze(out);
}

export const MAX_RESPONSE_BYTES = 256 * 1024;
/* A deployed site's script bundle runs to a few megabytes; a site probe may read one, and still cuts it there. */
export const MAX_SITE_RESPONSE_BYTES = 2 * 1024 * 1024;
/* A recursive tree may exceed the default. Only repository reads opt into
   this larger bound; webhook and credential-probe limits stay unchanged. */
export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_DEADLINE_MS = 20_000;
export const MAX_DNS_ANSWERS = 32;

/*
 * Every code this transport can raise, in one frozen set. It exists so a
 * caller that translates these into its own vocabulary can be checked for
 * completeness: a new code added below and not registered here fails the
 * transport's own test, and one registered here without a translation fails
 * the caller's. Without that, a missing translation is absorbed by whatever
 * generic the caller falls back to, and a permanent misconfiguration is
 * recorded as a transient failure and retried forever.
 */
export const CODES = Object.freeze({
  BODY_TOO_LARGE: 'GUARDED_FETCH_BODY_TOO_LARGE',
  DEADLINE: 'GUARDED_FETCH_DEADLINE',
  DNS_INVALID: 'GUARDED_FETCH_DNS_INVALID',
  ENCODING_REFUSED: 'GUARDED_FETCH_ENCODING_REFUSED',
  METHOD_INVALID: 'GUARDED_FETCH_METHOD_INVALID',
  PROFILE_INVALID: 'GUARDED_FETCH_PROFILE_INVALID',
  REFUSED: 'GUARDED_FETCH_REFUSED',
  RESPONSE_TOO_LARGE: 'GUARDED_FETCH_RESPONSE_TOO_LARGE',
  SSRF_BLOCKED: 'GUARDED_FETCH_SSRF_BLOCKED',
  TIMEOUT: 'GUARDED_FETCH_TIMEOUT',
  TRANSPORT_FAILED: 'GUARDED_FETCH_TRANSPORT_FAILED',
  URL_INVALID: 'GUARDED_FETCH_URL_INVALID'
} as const);

/*
 * Carries a code and nothing else. A verification probe sends a discovered
 * credential in a header, and an error that quotes its own request writes that
 * credential into whatever reads the error -- a log, an evidence record, a
 * response body. So no message here is built from caller input, and the
 * underlying failure contributes its code rather than its text.
 */
/* Set only when the failure underneath carried a code of its own, so it is typed here rather than declared as a field that would always exist. */
export interface GuardedFetchError {
  readonly transportCode?: string;
}

export class GuardedFetchError extends Error {
  override readonly name = 'GuardedFetchError';
  readonly code: string;

  constructor(message: string, code = 'GUARDED_FETCH_REFUSED', transportCode: unknown = null) {
    super(message);
    this.code = code;
    if (transportCode) (this as { transportCode?: string }).transportCode = String(transportCode).slice(0, 40);
  }
}

/* Own keys only: an inherited name such as `constructor` is not a profile. */
export function rules(profile: unknown): ProfileRule {
  const name = String(profile || '');
  const rule = Object.hasOwn(PROFILE_RULES, name) ? PROFILE_RULES[name] : undefined;
  if (!rule) throw new GuardedFetchError('Unknown outbound profile', 'GUARDED_FETCH_PROFILE_INVALID');
  return rule;
}

/*
 * The suffixes are refused by name as well as by address. A name ending in
 * .local, .internal or localhost resolves inside somebody's network by
 * convention, and the answer it gives on this host is not the answer it gives
 * on the reader's. The trailing dot is stripped first because a fully
 * qualified name is the same host and must not be a way around the check.
 */
export function normalizeTarget(rawUrl: unknown, profile: unknown, options: { readonly plainHttp?: boolean } = {}): URL {
  const rule = rules(profile);
  let parsed: URL;
  try { parsed = new URL(String(rawUrl || '').trim()); }
  catch { throw new GuardedFetchError('Outbound target must be an absolute URL', 'GUARDED_FETCH_URL_INVALID'); }

  /*
   * Plain HTTP exists for one question only -- does a site send a visitor who
   * types its name without https:// on to HTTPS -- so only the site profile
   * may ask it, only on port 80, and the answer is a status and headers:
   * nothing sent over it carries anything, and no body is ever read back.
   */
  const plain = options.plainHttp === true;
  if (plain && !rule.plainHttp) {
    throw new GuardedFetchError('This profile may not use plain HTTP', 'GUARDED_FETCH_REFUSED');
  }
  if (plain ? parsed.protocol !== 'http:' : parsed.protocol !== 'https:') {
    throw new GuardedFetchError(plain ? 'A plain-HTTP probe must use http://' : 'Outbound target must use HTTPS', 'GUARDED_FETCH_URL_INVALID');
  }
  if (parsed.username || parsed.password) {
    throw new GuardedFetchError('Outbound target must not carry credentials in the URL', 'GUARDED_FETCH_URL_INVALID');
  }
  if (parsed.hash) {
    throw new GuardedFetchError('Outbound target must not carry a fragment', 'GUARDED_FETCH_URL_INVALID');
  }
  if (!rule.query && parsed.search) {
    throw new GuardedFetchError('This profile does not permit a query string', 'GUARDED_FETCH_URL_INVALID');
  }
  if (parsed.port && parsed.port !== (plain ? '80' : '443')) {
    throw new GuardedFetchError(plain ? 'A plain-HTTP probe must use port 80' : 'Outbound target must use HTTPS port 443', 'GUARDED_FETCH_URL_INVALID');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')) {
    throw new GuardedFetchError('Outbound target hostname is not allowed', 'GUARDED_FETCH_SSRF_BLOCKED');
  }
  parsed.hostname = hostname;
  parsed.port = '';
  return parsed;
}

/*
 * Every answer, not the first one. A name that resolves to both a public and a
 * private address is a name whose owner is answering differently per query,
 * and filtering the set down to the acceptable half is how the next lookup
 * gets through -- so one private answer disqualifies all of them.
 */
export interface AddressAnswer {
  readonly address: string;
  readonly family: number;
}

export function validateAddresses(answers: unknown): AddressAnswer[] {
  const list: readonly unknown[] = Array.isArray(answers) ? answers : [];
  if (!list.length) {
    throw new GuardedFetchError('Outbound target did not resolve', 'GUARDED_FETCH_DNS_INVALID');
  }
  if (list.length > MAX_DNS_ANSWERS) {
    throw new GuardedFetchError('Outbound target resolved to an implausible number of addresses', 'GUARDED_FETCH_DNS_INVALID');
  }
  return list.map(entry => {
    const item = (entry && typeof entry === 'object' ? entry : {}) as { readonly address?: unknown; readonly family?: unknown };
    const address = String(entry && item.address || '').trim();
    const family = Number(entry && item.family) || isIP(address);
    if (![4, 6].includes(family) || isIP(address) !== family) {
      throw new GuardedFetchError('Outbound target resolved to a malformed address', 'GUARDED_FETCH_DNS_INVALID');
    }
    if (!isPublicAddress(address)) {
      throw new GuardedFetchError('Outbound target must resolve only to public addresses', 'GUARDED_FETCH_SSRF_BLOCKED');
    }
    return { address, family };
  });
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/*
 * A credential belongs in a header and nowhere else.
 *
 * The verification profile refuses a query string outright, which handles the
 * profile whose whole request is sensitive. This handles the mistake that ban
 * cannot reach: a call site on a profile that legitimately carries both a
 * credential and a query string -- a provider read, which sends the reader's
 * own session token -- interpolating the token into the address. A URL is the
 * part of a request that survives into an access log, a referrer header and
 * every proxy in between, so a token that reaches one has been published.
 *
 * The floor on length is what keeps the check from being noise: an
 * `Authorization: Bearer main` would otherwise refuse every URL containing the
 * word, and a value that short is not a credential.
 */
const MIN_CREDENTIAL_LENGTH = 8;

export function assertCredentialNotInUrl(target: URL, headers: unknown): void {
  const source: object = headers && typeof headers === 'object' ? headers : {};
  const href = target.href;
  for (const [name, value] of Object.entries(source)) {
    if (!/^(?:authorization|proxy-authorization|private-token|x-api-key)$/i.test(name)) continue;
    const raw = String(value == null ? '' : value);
    /* The scheme is not the secret; what follows it is. Both are checked, so a
       header carrying a bare token is covered as well as a prefixed one. */
    for (const candidate of [raw, raw.replace(/^\S+\s+/, '')]) {
      if (candidate.length >= MIN_CREDENTIAL_LENGTH && href.includes(candidate)) {
        throw new GuardedFetchError(
          'Outbound target must not carry a credential in the URL',
          'GUARDED_FETCH_URL_INVALID'
        );
      }
    }
  }
}

/* Resolves a name to its answers: the system resolver by default, a fake in tests. */
export type Resolver = (hostname: string) => unknown;

export function lookupAll(hostname: string): Promise<dns.LookupAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/* A resolution that cannot outlive the request it serves. */
export async function resolveWithin(resolver: Resolver, hostname: string, remainingMs: number, signal: AbortSignal | null | undefined): Promise<unknown> {
  let dnsDeadline: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (signal && signal.aborted) throw new GuardedFetchError('Outbound request was cancelled', CODES.DEADLINE);
    return await Promise.race([
      Promise.resolve().then(() => resolver(hostname)),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new GuardedFetchError('Outbound request was cancelled', CODES.DEADLINE));
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        dnsDeadline = setTimeout(() => reject(new GuardedFetchError(
          'Outbound request exceeded its deadline', 'GUARDED_FETCH_DEADLINE'
        )), Math.max(0, remainingMs));
      })
    ]);
  } catch (error) {
    if (error instanceof GuardedFetchError) throw error;
    throw new GuardedFetchError('Outbound target could not be resolved', 'GUARDED_FETCH_DNS_INVALID', errorCode(error));
  } finally {
    clearTimeout(dnsDeadline);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/* The driver's or the system's error code, when the failure carries one. */
export function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
}
