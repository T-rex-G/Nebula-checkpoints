import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import {
  rules, PROFILES, GuardedFetchError, boundedInteger, lookupAll, resolveWithin, DEFAULT_DEADLINE_MS, validateAddresses,
  normalizeTarget, CODES, assertCredentialNotInUrl, ANONYMOUS, MAX_RESPONSE_BYTES, MAX_PROVIDER_RESPONSE_BYTES,
  MAX_SITE_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, boundedHeaders, errorCode, type Resolver, type AddressAnswer,
  type ProbeHeaders
} from './outbound-policy.ts';
export {
  PROFILES, MAX_RESPONSE_BYTES, MAX_SITE_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_DEADLINE_MS, MAX_DNS_ANSWERS,
  CODES, GuardedFetchError, normalizeTarget, validateAddresses
} from './outbound-policy.ts';
export type { Profile, ProbeHeaders, AddressAnswer, Resolver } from './outbound-policy.ts';

/*
 * One outbound path for everything this application reaches on somebody else's
 * behalf.
 *
 * The hard part already existed. The webhook worker resolved a hostname,
 * validated every answer against a public-address policy, and pinned the
 * connection to an address it had already checked -- so a name that answers
 * differently on the second lookup cannot move the socket after validation.
 * That is the defence that matters and it is reused here rather than rewritten.
 *
 * What it did not have, because a signed POST to a configured endpoint does not
 * need it:
 *
 *   - a total deadline. `timeout` on an https request is socket inactivity, so
 *     a response that sends one byte inside every window never times out and
 *     holds the connection as long as it likes.
 *   - a bound on a body a caller actually reads. The webhook path discarded
 *     the response; a provider read does not.
 *   - any notion of a caller other than a signed POST.
 *
 * Profiles are how the third is handled without the first two becoming
 * everyone's problem. A scan needs GET and a query string. The webhook path
 * must not acquire either, because its URL policy is part of what makes a
 * configured endpoint safe to post a signed payload to.
 */

/*
 * Pools this file minted, and what each was minted for. A WeakMap rather than
 * a flag on the object, so a caller cannot make an agent of its own look like
 * one of these by setting a property on it.
 */
interface MintedPool {
  readonly hostname: string;
  readonly address: string;
  readonly profile: string;
}

const SESSION_AGENTS = new WeakMap<object, MintedPool>();
const MAX_SESSION_POOLS = 8;
const DEFAULT_SESSION_SOCKETS = 6;
const DEFAULT_SESSION_DNS_TTL_MS = 30_000;

/*
 * A run of reads against one provider, sharing connections.
 *
 * Without it every read is a fresh DNS lookup, TCP connect and TLS handshake,
 * which for a scan of two thousand small files is most of the time the scan
 * takes -- the files themselves are a few hundred bytes each. A session keeps
 * a small keep-alive pool per validated address and remembers the validated
 * answer for a short while, so the handshake is paid once per connection
 * rather than once per file.
 *
 * What it does not relax is anything the single-request path guarantees.
 * Every address is validated before a socket exists, as before. Each pool
 * belongs to exactly one validated address, so a pooled socket can never be
 * one opened to a different address for the same name -- the property the
 * unpooled path kept by refusing pools altogether. The remembered answer is a
 * pin, which is the point: a name that starts answering differently mid-scan
 * does not move the connections, and when the answer is refreshed it is
 * validated again. And it is for provider reads only: a webhook's signed POST
 * and a credential probe keep their one-connection-per-request behaviour,
 * because neither is ever sent in bulk and both are worth the handshake.
 *
 * Closing it destroys every socket. A session lives for one scan.
 */
export interface GuardedSessionOptions {
  readonly profile?: string;
  readonly maxSockets?: number;
  readonly dnsTtlMs?: number;
  readonly resolveAddresses?: Resolver;
  readonly now?: () => number;
  readonly Agent?: typeof https.Agent;
  readonly requestImpl?: RequestImpl;
}

export interface GuardedSession {
  request(input?: GuardedFetchInput): Promise<GuardedResponse>;
  close(): void;
}

export function createGuardedSession(options: GuardedSessionOptions = {}): GuardedSession {
  const profile = String(options.profile || '');
  rules(profile);
  if (profile !== PROFILES.PROVIDER_READ) {
    throw new GuardedFetchError('Only provider reads may share connections', 'GUARDED_FETCH_PROFILE_INVALID');
  }
  const maxSockets = boundedInteger(options.maxSockets, DEFAULT_SESSION_SOCKETS, 1, 16);
  const ttlMs = boundedInteger(options.dnsTtlMs, DEFAULT_SESSION_DNS_TTL_MS, 1000, 5 * 60 * 1000);
  const resolver = typeof options.resolveAddresses === 'function' ? options.resolveAddresses : lookupAll;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const Agent = typeof options.Agent === 'function' ? options.Agent : https.Agent;
  const requestImpl = typeof options.requestImpl === 'function' ? options.requestImpl : undefined;
  const pins = new Map<string, { readonly pinned: AddressAnswer; readonly expiresAt: number }>();
  const pools = new Map<string, https.Agent>();
  const controller = new AbortController();
  let closed = false;

  function refused(): GuardedFetchError {
    return new GuardedFetchError('This session has been closed', 'GUARDED_FETCH_REFUSED');
  }

  async function pinFor(hostname: string, signal: AbortSignal): Promise<AddressAnswer> {
    const cached = pins.get(hostname);
    if (cached && cached.expiresAt > now()) return cached.pinned;
    const answers = await resolveWithin(resolver, hostname, DEFAULT_DEADLINE_MS, signal);
    const pinned = validateAddresses(answers)[0] as AddressAnswer;
    pins.set(hostname, { pinned, expiresAt: now() + ttlMs });
    return pinned;
  }

  function poolFor(hostname: string, pinned: AddressAnswer): https.Agent {
    const key = `${hostname}\u0000${pinned.address}`;
    let agent = pools.get(key);
    if (agent) return agent;
    /* A bounded number of pools. A scan talks to one provider; more than a
       handful of distinct addresses is a name answering strangely, and the
       oldest pool is closed rather than kept. */
    if (pools.size >= MAX_SESSION_POOLS) {
      const first = pools.entries().next().value;
      if (first) {
        const [oldestKey, oldest] = first;
        pools.delete(oldestKey);
        oldest.destroy();
      }
    }
    agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets, timeout: 15_000, scheduling: 'lifo' });
    SESSION_AGENTS.set(agent, Object.freeze({ hostname, address: pinned.address, profile }));
    pools.set(key, agent);
    return agent;
  }

  async function request(input: GuardedFetchInput = {}): Promise<GuardedResponse> {
    if (closed) throw refused();
    if (String(input.profile || '') !== profile) {
      throw new GuardedFetchError('A session serves only the profile it was opened for', 'GUARDED_FETCH_PROFILE_INVALID');
    }
    const target = normalizeTarget(input.url, profile);
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const pinned = await pinFor(target.hostname, signal);
    if (closed) throw refused();
    return guardedFetch({
      ...input,
      signal,
      ...(requestImpl ? { requestImpl } : {}),
      addresses: [pinned],
      agent: poolFor(target.hostname, pinned)
    });
  }

  function close(): void {
    closed = true;
    controller.abort();
    for (const agent of pools.values()) agent.destroy();
    pools.clear();
    pins.clear();
  }

  return Object.freeze({ request, close });
}

/* The request a socket is opened for, and the response it answers with: the subset of node:http's both sides use, so tests can stand in for either. */
export type RequestImpl = (options: https.RequestOptions, onResponse: (response: http.IncomingMessage) => void) => http.ClientRequest;

export interface GuardedFetchInput {
  readonly profile?: string;
  readonly url?: unknown;
  readonly method?: string;
  readonly headers?: http.OutgoingHttpHeaders | null;
  readonly body?: unknown;
  readonly signal?: AbortSignal | null;
  readonly deadlineMs?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly plainHttp?: boolean;
  readonly agent?: unknown;
  readonly addresses?: unknown;
  readonly resolveAddresses?: Resolver;
  readonly requestImpl?: RequestImpl;
  readonly responseType?: 'buffer' | 'text';
}

export interface GuardedResponse {
  readonly statusCode: number;
  readonly headers?: ProbeHeaders;
  readonly tls?: PeerTls;
  readonly body?: string | Buffer;
  readonly bodyUnread?: boolean;
  readonly truncated?: boolean;
  readonly plain?: boolean;
}

export async function guardedFetch(input: GuardedFetchInput = {}): Promise<GuardedResponse> {
  const deadlineMs = boundedInteger(input.deadlineMs, DEFAULT_DEADLINE_MS, 1, 120_000);
  const startedAt = Date.now();
  const rule = rules(input.profile);
  const aborted = (): boolean | null | undefined => input.signal && input.signal.aborted;
  if (aborted()) throw new GuardedFetchError('Outbound request was cancelled', CODES.DEADLINE);
  const method = String(input.method || '').toUpperCase();
  if (!rule.methods.includes(method)) {
    throw new GuardedFetchError('This profile does not permit that method', 'GUARDED_FETCH_METHOD_INVALID');
  }

  const plain = input.plainHttp === true;
  const target = normalizeTarget(input.url, input.profile, { plainHttp: plain });
  if (plain && input.agent != null) throw new GuardedFetchError('A plain-HTTP probe never shares a connection', 'GUARDED_FETCH_REFUSED');
  assertCredentialNotInUrl(target, input.headers);
  /* A site probe, an advisory or licence query and an exploit-intelligence read are anonymous by construction: no credential and no cookie. */
  const profile = String(input.profile || '');
  const anonymous = Object.hasOwn(ANONYMOUS, profile) ? ANONYMOUS[profile] : undefined;
  if (anonymous && Object.keys(input.headers || {}).some(name =>
    /^(?:authorization|proxy-authorization|cookie|private-token|x-api-key)$/i.test(name))) {
    throw new GuardedFetchError(anonymous, 'GUARDED_FETCH_REFUSED');
  }
  const siteRead = profile === PROFILES.RENDERED_SITE || profile === PROFILES.SITE_PROBE;
  if (siteRead && Object.keys(input.headers || {}).some(name =>
    !/^(?:accept|accept-language|accept-encoding|user-agent|origin|referer|range)$/i.test(name))) {
    throw new GuardedFetchError('Site reads accept only anonymous browser headers', CODES.REFUSED);
  }
  /* A profile bound to named hosts reaches those and nothing else, and one bound to named paths only those. */
  if (rule.hosts && !rule.hosts.includes(target.hostname)) {
    throw new GuardedFetchError('This profile may not reach that host', 'GUARDED_FETCH_REFUSED');
  }
  if (rule.paths && !rule.paths.includes(target.pathname)) {
    throw new GuardedFetchError('This profile may not reach that path', 'GUARDED_FETCH_REFUSED');
  }
  const body = input.body == null ? null : String(input.body);
  if (siteRead && body !== null) {
    throw new GuardedFetchError('Anonymous site reads cannot carry a request body', CODES.REFUSED);
  }
  const maxBytes = boundedInteger(input.maxResponseBytes, MAX_RESPONSE_BYTES, 1024,
    profile === PROFILES.PROVIDER_READ || profile === PROFILES.THREAT_INTEL || profile === PROFILES.PROVIDER_QUERY ? MAX_PROVIDER_RESPONSE_BYTES
      : rule.truncates ? MAX_SITE_RESPONSE_BYTES : MAX_RESPONSE_BYTES);
  if (body !== null && Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new GuardedFetchError('Outbound body exceeds the transport limit', 'GUARDED_FETCH_BODY_TOO_LARGE');
  }

  /*
   * A caller that already resolved and validated passes its answers in rather
   * than letting this resolve again. That is not an optimisation: a second
   * lookup is a second chance for the name to answer differently, which is
   * precisely the window pinning exists to close. Passed-in answers are still
   * validated here -- trusting them because they arrived as a parameter would
   * make the guard optional.
   */
  let answers: unknown;
  if (Array.isArray(input.addresses)) {
    answers = input.addresses;
  } else {
    answers = await resolveWithin(
      typeof input.resolveAddresses === 'function' ? input.resolveAddresses : lookupAll,
      target.hostname,
      Math.max(0, deadlineMs - (Date.now() - startedAt)),
      input.signal
    );
  }
  /* Validation before a socket exists: a refused address must never reach one. */
  const validated = validateAddresses(answers);
  if (aborted()) throw new GuardedFetchError('Outbound request was cancelled', CODES.DEADLINE);
  /* validateAddresses returns at least one answer or throws. */
  const pinned = validated[0] as AddressAnswer;

  /*
   * A pool, only when a guarded session minted it, and only for the address
   * and name it was minted for. The rule this file has always kept is that a
   * pooled socket must never be one opened to a different address for the same
   * hostname; a session keeps it by construction -- one pool per validated
   * address -- and this check keeps it at the boundary, so a caller that
   * passed the wrong pool is refused rather than trusted.
   */
  let agent: https.Agent | false = false;
  if (input.agent != null) {
    const minted = typeof input.agent === 'object' ? SESSION_AGENTS.get(input.agent) : undefined;
    if (!minted || minted.hostname !== target.hostname || minted.address !== pinned.address
      || minted.profile !== input.profile) {
      throw new GuardedFetchError('Only a guarded session may supply a connection pool', 'GUARDED_FETCH_REFUSED');
    }
    agent = input.agent as https.Agent;
  }

  const requestImpl: RequestImpl = typeof input.requestImpl === 'function' ? input.requestImpl : plain ? http.request : https.request;
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30_000);
  const remainingMs = deadlineMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    throw new GuardedFetchError('Outbound request exceeded its deadline', 'GUARDED_FETCH_DEADLINE');
  }
  /* Never accept-encoding: the bound that matters is on the bytes a caller
     ends up holding, and a small compressed body can become an enormous one. */
  const headers: http.OutgoingHttpHeaders = { ...(input.headers || {}) };
  for (const name of Object.keys(headers)) if (name.toLowerCase() === 'accept-encoding') delete headers[name];

  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | null = null;
    const finish = <T>(fn: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (input.signal) input.signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = (): void => {
      const error = new GuardedFetchError('Outbound request was cancelled', CODES.DEADLINE);
      if (request && typeof request.destroy === 'function') request.destroy(error);
      finish(reject, error);
    };
    /*
     * The total deadline, which the socket timeout is not. A response that
     * sends a byte inside every inactivity window never times out.
     */
    const deadline = setTimeout(() => {
      const error = new GuardedFetchError('Outbound request exceeded its deadline', 'GUARDED_FETCH_DEADLINE');
      if (request && typeof request.destroy === 'function') request.destroy(error);
      finish(reject, error);
    }, remainingMs);
    if (input.signal) input.signal.addEventListener('abort', onAbort, { once: true });
    if (aborted()) return onAbort();
    /*
     * Deliberately not unref'd. An unreferenced deadline lets the process exit
     * while a request is still in flight, so the deadline never fires and the
     * caller never learns the request was abandoned -- which showed up here as
     * a test suite exiting silently with a success code. The timer is cleared
     * the moment anything settles, so it holds nothing open that matters.
     */

    try {
      request = requestImpl({
      protocol: plain ? 'http:' : 'https:',
      hostname: target.hostname,
      port: plain ? 80 : 443,
      path: `${target.pathname || '/'}${target.search || ''}`,
      method,
      headers,
      /* The certificate is still checked against the name, not the pinned
         address: pinning decides where the bytes go, not who may answer. */
      ...(plain ? {} : { servername: target.hostname }),
      lookup: (_hostname: string, options: dns.LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
        /* Node's family auto-selection asks for all:true. Both callback
           forms must return the same validated pin, never resolve again. */
        if (options && options.all) callback(null, [{ ...pinned }]);
        else callback(null, pinned.address, pinned.family);
      },
      timeout: timeoutMs,
      /* No shared agent unless a session minted one for exactly this pinned
         address: a pooled socket must never be one opened to a different
         address for the same hostname. */
      agent
    }, response => {
      const statusCode = Number(response.statusCode || 0);
      const seen: { headers?: ProbeHeaders; tls?: PeerTls } = rule.headers ? { headers: boundedHeaders(response.headers) } : {};
      /* Plain HTTP answers with a status and headers, and its body is never read. */
      if (plain) {
        if (typeof response.destroy === 'function') response.destroy();
        return finish(resolve, { statusCode, ...seen, body: '', bodyUnread: true, plain: true });
      }
      if (rule.tls) {
        const tls = peerTls(response.socket);
        if (tls) seen.tls = tls;
      }

      const binary = rule.binary && input.responseType === 'buffer';
      const resultBody = (chunks: Buffer[]): string | Buffer => binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8');
      if (rule.readsBody && !binary) {
        const encoding = String((response.headers || {})['content-encoding'] || '').trim().toLowerCase();
        if (encoding && encoding !== 'identity' && rule.truncates) {
          if (typeof response.destroy === 'function') response.destroy();
          return finish(resolve, { statusCode, ...seen, body: '', bodyUnread: true });
        }
        if (encoding && encoding !== 'identity') {
          if (typeof response.destroy === 'function') response.destroy();
          return finish(reject, new GuardedFetchError(
            'Outbound response used an encoding this transport will not read', 'GUARDED_FETCH_ENCODING_REFUSED'
          ));
        }
      }

      let received = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        received += chunk.length;
        if (received > maxBytes && rule.truncates) {
          chunks.push(Buffer.from(chunk).subarray(0, Math.max(0, chunk.length - (received - maxBytes))));
          if (typeof response.destroy === 'function') response.destroy();
          return finish(resolve, { statusCode, ...seen, body: resultBody(chunks), truncated: true });
        }
        if (received > maxBytes) {
          if (typeof response.destroy === 'function') response.destroy();
          return finish(reject, new GuardedFetchError(
            'Outbound response exceeded the transport limit', 'GUARDED_FETCH_RESPONSE_TOO_LARGE'
          ));
        }
        /* The webhook profile drains and discards, exactly as it did. */
        if (rule.readsBody) chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => finish(resolve, rule.readsBody
        ? { statusCode, ...seen, body: resultBody(chunks) }
        : { statusCode }));
      response.on('error', (error: unknown) => finish(reject, new GuardedFetchError(
        'Outbound response failed', 'GUARDED_FETCH_TRANSPORT_FAILED', errorCode(error)
      )));
      response.resume();
      return undefined;
    });

    const issued = request;
    issued.on('timeout', () => {
      const error = new GuardedFetchError('Outbound request timed out', 'GUARDED_FETCH_TIMEOUT');
      if (typeof issued.destroy === 'function') issued.destroy(error);
      finish(reject, error);
    });
    issued.on('error', (error: unknown) => finish(reject, error instanceof GuardedFetchError
      ? error
      : new GuardedFetchError('Outbound request failed', 'GUARDED_FETCH_TRANSPORT_FAILED', errorCode(error))));
      issued.end(body == null ? undefined : body);
    } catch (error) {
      if (request && typeof request.destroy === 'function') request.destroy();
      finish(reject, error instanceof GuardedFetchError ? error : new GuardedFetchError(
        'Outbound request failed', CODES.TRANSPORT_FAILED, errorCode(error)
      ));
    }
  });
}

/*
 * What a site's certificate says about itself, and the protocol the
 * handshake settled on: the certificate's end date, its issuing
 * organisation's name and the TLS version. Nothing else of the certificate
 * crosses back.
 */
export interface PeerTls {
  readonly protocol: string | null;
  readonly validTo: string | null;
  readonly issuer: string | null;
}

/* The two TLS socket methods read here; a plain socket has neither. */
interface PeerSocket {
  readonly getPeerCertificate?: (detailed: boolean) => { readonly valid_to?: string; readonly issuer?: { readonly O?: string; readonly CN?: string } } | null;
  readonly getProtocol?: () => string | null;
}

function peerTls(socketInput: unknown): PeerTls | null {
  try {
    const socket = socketInput as PeerSocket | null | undefined;
    if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
    const certificate = socket.getPeerCertificate(false) || {};
    const protocol = typeof socket.getProtocol === 'function' ? String(socket.getProtocol() || '') : '';
    const validTo = certificate.valid_to ? new Date(certificate.valid_to) : null;
    const issuer = certificate.issuer && (certificate.issuer.O || certificate.issuer.CN);
    return Object.freeze({
      protocol: /^TLSv1(?:\.[0-3])?$|^SSLv3$/.test(protocol) ? protocol : null,
      validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null,
      issuer: issuer ? String(issuer).replace(/[^\w .,'&()-]/g, '').slice(0, 80) || null : null
    });
  } catch {
    return null;
  }
}

/*
 * A domain's published TXT records, for the questions a site check asks of
 * the name rather than the server: does it say who may send its mail (SPF),
 * and what to do with mail that fails (DMARC). A lookup of public DNS through
 * the system resolver, bounded like everything else here: a name only, a
 * deadline, and at most a few dozen short records back. No record at all is
 * an answer (an empty list); a resolver that could not answer is an error,
 * so the caller can say "unknown" rather than "missing".
 */
const MAX_TXT_RECORDS = 32;
const MAX_TXT_RECORD_BYTES = 2048;
const TXT_NAME = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export interface GuardedTxtOptions {
  readonly resolveTxt?: Resolver;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal | null;
}

export async function guardedTxt(name: unknown, options: GuardedTxtOptions = {}): Promise<readonly string[]> {
  const hostname = String(name || '').trim().toLowerCase().replace(/\.$/, '');
  if (!TXT_NAME.test(hostname) || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname)) {
    throw new GuardedFetchError('A DNS lookup needs a public domain name', 'GUARDED_FETCH_URL_INVALID');
  }
  const resolver: Resolver = typeof options.resolveTxt === 'function' ? options.resolveTxt : (host: string) => dns.promises.resolveTxt(host);
  const deadlineMs = boundedInteger(options.deadlineMs, 5000, 1, 15_000);
  let records: unknown;
  try {
    records = await resolveWithin(resolver, hostname, deadlineMs, options.signal);
  } catch (error) {
    const transportCode = error && typeof error === 'object' ? (error as { readonly transportCode?: unknown }).transportCode : undefined;
    if (typeof transportCode === 'string' && ['ENODATA', 'ENOTFOUND', 'NXDOMAIN'].includes(transportCode)) return Object.freeze([]);
    throw error;
  }
  return Object.freeze((Array.isArray(records) ? records as unknown[] : []).slice(0, MAX_TXT_RECORDS)
    .map(chunks => (Array.isArray(chunks) ? chunks.join('') : String(chunks || '')).slice(0, MAX_TXT_RECORD_BYTES)));
}
