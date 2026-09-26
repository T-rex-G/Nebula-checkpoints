'use strict';

const dns = require('dns');
const https = require('https');
const net = require('net');
const { isPublicAddress } = require('./governance-delivery');

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

const PROFILES = Object.freeze({
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
   * it: GET or HEAD, no query string, no credential of any kind, and the
   * response headers returned beside the status -- they are most of what a
   * site check is about. The body is read only as far as the caller's bound
   * and then cut, never refused: a probe needs the first bytes of a file to
   * recognise it, not the whole of a page. A compressed body is not
   * decompressed; it is reported as unread and the headers still arrive.
   */
  SITE_PROBE: 'site-probe'
});

const PROFILE_RULES = Object.freeze({
  [PROFILES.WEBHOOK]: Object.freeze({ methods: Object.freeze(['POST']), query: false, readsBody: false }),
  [PROFILES.PROVIDER_READ]: Object.freeze({ methods: Object.freeze(['GET', 'HEAD']), query: true, readsBody: true }),
  [PROFILES.CREDENTIAL_VERIFY]: Object.freeze({ methods: Object.freeze(['GET', 'POST']), query: false, readsBody: true }),
  [PROFILES.SITE_PROBE]: Object.freeze({ methods: Object.freeze(['GET', 'HEAD']), query: false, readsBody: true, headers: true, truncates: true })
});

/* Response headers as a probe may see them: lower-cased names, bounded values. */
function boundedHeaders(raw) {
  const out = {};
  let count = 0;
  for (const [name, value] of Object.entries(raw || {})) {
    if (count++ >= 64) break;
    const values = (Array.isArray(value) ? value : [value]).slice(0, 16).map(item => String(item).slice(0, 2048));
    out[String(name).toLowerCase()] = name.toLowerCase() === 'set-cookie' ? values : values.join(', ');
  }
  return Object.freeze(out);
}

const MAX_RESPONSE_BYTES = 256 * 1024;
/* A recursive tree may exceed the default. Only repository reads opt into
   this larger bound; webhook and credential-probe limits stay unchanged. */
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 20_000;
const MAX_DNS_ANSWERS = 32;

/*
 * Every code this transport can raise, in one frozen set. It exists so a
 * caller that translates these into its own vocabulary can be checked for
 * completeness: a new code added below and not registered here fails the
 * transport's own test, and one registered here without a translation fails
 * the caller's. Without that, a missing translation is absorbed by whatever
 * generic the caller falls back to, and a permanent misconfiguration is
 * recorded as a transient failure and retried forever.
 */
const CODES = Object.freeze({
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
});

/*
 * Carries a code and nothing else. A verification probe sends a discovered
 * credential in a header, and an error that quotes its own request writes that
 * credential into whatever reads the error -- a log, an evidence record, a
 * response body. So no message here is built from caller input, and the
 * underlying failure contributes its code rather than its text.
 */
class GuardedFetchError extends Error {
  constructor(message, code = 'GUARDED_FETCH_REFUSED', transportCode = null) {
    super(message);
    this.name = 'GuardedFetchError';
    this.code = code;
    if (transportCode) this.transportCode = String(transportCode).slice(0, 40);
  }
}

function rules(profile) {
  const rule = PROFILE_RULES[String(profile || '')];
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
function normalizeTarget(rawUrl, profile) {
  const rule = rules(profile);
  let parsed;
  try { parsed = new URL(String(rawUrl || '').trim()); }
  catch { throw new GuardedFetchError('Outbound target must be an absolute URL', 'GUARDED_FETCH_URL_INVALID'); }

  if (parsed.protocol !== 'https:') {
    throw new GuardedFetchError('Outbound target must use HTTPS', 'GUARDED_FETCH_URL_INVALID');
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
  if (parsed.port && parsed.port !== '443') {
    throw new GuardedFetchError('Outbound target must use HTTPS port 443', 'GUARDED_FETCH_URL_INVALID');
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
function validateAddresses(answers) {
  const list = Array.isArray(answers) ? answers : [];
  if (!list.length) {
    throw new GuardedFetchError('Outbound target did not resolve', 'GUARDED_FETCH_DNS_INVALID');
  }
  if (list.length > MAX_DNS_ANSWERS) {
    throw new GuardedFetchError('Outbound target resolved to an implausible number of addresses', 'GUARDED_FETCH_DNS_INVALID');
  }
  return list.map(item => {
    const address = String(item && item.address || '').trim();
    const family = Number(item && item.family) || net.isIP(address);
    if (![4, 6].includes(family) || net.isIP(address) !== family) {
      throw new GuardedFetchError('Outbound target resolved to a malformed address', 'GUARDED_FETCH_DNS_INVALID');
    }
    if (!isPublicAddress(address)) {
      throw new GuardedFetchError('Outbound target must resolve only to public addresses', 'GUARDED_FETCH_SSRF_BLOCKED');
    }
    return { address, family };
  });
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
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

function assertCredentialNotInUrl(target, headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
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

function lookupAll(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/* A resolution that cannot outlive the request it serves. */
async function resolveWithin(resolver, hostname, remainingMs) {
  let dnsDeadline;
  try {
    return await Promise.race([
      Promise.resolve().then(() => resolver(hostname)),
      new Promise((_, reject) => {
        dnsDeadline = setTimeout(() => reject(new GuardedFetchError(
          'Outbound request exceeded its deadline', 'GUARDED_FETCH_DEADLINE'
        )), Math.max(0, remainingMs));
      })
    ]);
  } catch (error) {
    if (error instanceof GuardedFetchError) throw error;
    throw new GuardedFetchError('Outbound target could not be resolved', 'GUARDED_FETCH_DNS_INVALID', error && error.code);
  } finally {
    clearTimeout(dnsDeadline);
  }
}

/*
 * Pools this file minted, and what each was minted for. A WeakMap rather than
 * a flag on the object, so a caller cannot make an agent of its own look like
 * one of these by setting a property on it.
 */
const SESSION_AGENTS = new WeakMap();
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
function createGuardedSession(options = {}) {
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
  const pins = new Map();
  const pools = new Map();
  let closed = false;

  function refused() {
    return new GuardedFetchError('This session has been closed', 'GUARDED_FETCH_REFUSED');
  }

  async function pinFor(hostname) {
    const cached = pins.get(hostname);
    if (cached && cached.expiresAt > now()) return cached.pinned;
    const answers = await resolveWithin(resolver, hostname, DEFAULT_DEADLINE_MS);
    const pinned = validateAddresses(answers)[0];
    pins.set(hostname, { pinned, expiresAt: now() + ttlMs });
    return pinned;
  }

  function poolFor(hostname, pinned) {
    const key = `${hostname}\u0000${pinned.address}`;
    let agent = pools.get(key);
    if (agent) return agent;
    /* A bounded number of pools. A scan talks to one provider; more than a
       handful of distinct addresses is a name answering strangely, and the
       oldest pool is closed rather than kept. */
    if (pools.size >= MAX_SESSION_POOLS) {
      const [oldestKey, oldest] = pools.entries().next().value;
      pools.delete(oldestKey);
      oldest.destroy();
    }
    agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets, timeout: 15_000, scheduling: 'lifo' });
    SESSION_AGENTS.set(agent, Object.freeze({ hostname, address: pinned.address, profile }));
    pools.set(key, agent);
    return agent;
  }

  async function request(input = {}) {
    if (closed) throw refused();
    if (String(input.profile || '') !== profile) {
      throw new GuardedFetchError('A session serves only the profile it was opened for', 'GUARDED_FETCH_PROFILE_INVALID');
    }
    const target = normalizeTarget(input.url, profile);
    const pinned = await pinFor(target.hostname);
    if (closed) throw refused();
    return guardedFetch({
      ...input,
      ...(requestImpl ? { requestImpl } : {}),
      addresses: [pinned],
      agent: poolFor(target.hostname, pinned)
    });
  }

  function close() {
    closed = true;
    for (const agent of pools.values()) agent.destroy();
    pools.clear();
    pins.clear();
  }

  return Object.freeze({ request, close });
}

async function guardedFetch(input = {}) {
  const deadlineMs = boundedInteger(input.deadlineMs, DEFAULT_DEADLINE_MS, 1000, 120_000);
  const startedAt = Date.now();
  const rule = rules(input.profile);
  const method = String(input.method || '').toUpperCase();
  if (!rule.methods.includes(method)) {
    throw new GuardedFetchError('This profile does not permit that method', 'GUARDED_FETCH_METHOD_INVALID');
  }

  const target = normalizeTarget(input.url, input.profile);
  assertCredentialNotInUrl(target, input.headers);
  /* A site probe is anonymous by construction: it may carry no credential and no cookie. */
  if (input.profile === PROFILES.SITE_PROBE && Object.keys(input.headers || {}).some(name =>
    /^(?:authorization|proxy-authorization|cookie|private-token|x-api-key)$/i.test(name))) {
    throw new GuardedFetchError('A site probe must be anonymous', 'GUARDED_FETCH_REFUSED');
  }
  const body = input.body == null ? null : String(input.body);
  const maxBytes = boundedInteger(input.maxResponseBytes, MAX_RESPONSE_BYTES, 1024,
    input.profile === PROFILES.PROVIDER_READ ? MAX_PROVIDER_RESPONSE_BYTES : MAX_RESPONSE_BYTES);
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
  let answers;
  if (Array.isArray(input.addresses)) {
    answers = input.addresses;
  } else {
    answers = await resolveWithin(
      typeof input.resolveAddresses === 'function' ? input.resolveAddresses : lookupAll,
      target.hostname,
      Math.max(0, deadlineMs - (Date.now() - startedAt))
    );
  }
  /* Validation before a socket exists: a refused address must never reach one. */
  const validated = validateAddresses(answers);
  const pinned = validated[0];

  /*
   * A pool, only when a guarded session minted it, and only for the address
   * and name it was minted for. The rule this file has always kept is that a
   * pooled socket must never be one opened to a different address for the same
   * hostname; a session keeps it by construction -- one pool per validated
   * address -- and this check keeps it at the boundary, so a caller that
   * passed the wrong pool is refused rather than trusted.
   */
  let agent = false;
  if (input.agent != null) {
    const minted = SESSION_AGENTS.get(input.agent);
    if (!minted || minted.hostname !== target.hostname || minted.address !== pinned.address
      || minted.profile !== input.profile) {
      throw new GuardedFetchError('Only a guarded session may supply a connection pool', 'GUARDED_FETCH_REFUSED');
    }
    agent = input.agent;
  }

  const requestImpl = typeof input.requestImpl === 'function' ? input.requestImpl : https.request;
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30_000);
  const remainingMs = deadlineMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    throw new GuardedFetchError('Outbound request exceeded its deadline', 'GUARDED_FETCH_DEADLINE');
  }
  /* Never accept-encoding: the bound that matters is on the bytes a caller
     ends up holding, and a small compressed body can become an enormous one. */
  const headers = { ...(input.headers || {}) };
  delete headers['accept-encoding'];
  delete headers['Accept-Encoding'];

  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
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
    /*
     * Deliberately not unref'd. An unreferenced deadline lets the process exit
     * while a request is still in flight, so the deadline never fires and the
     * caller never learns the request was abandoned -- which showed up here as
     * a test suite exiting silently with a success code. The timer is cleared
     * the moment anything settles, so it holds nothing open that matters.
     */

    request = requestImpl({
      protocol: 'https:',
      hostname: target.hostname,
      port: 443,
      path: `${target.pathname || '/'}${target.search || ''}`,
      method,
      headers,
      /* The certificate is still checked against the name, not the pinned
         address: pinning decides where the bytes go, not who may answer. */
      servername: target.hostname,
      lookup: (_hostname, options, callback) => {
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
      const seen = rule.headers ? { headers: boundedHeaders(response.headers) } : {};

      if (rule.readsBody) {
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
      const chunks = [];
      response.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes && rule.truncates) {
          chunks.push(Buffer.from(chunk).subarray(0, Math.max(0, chunk.length - (received - maxBytes))));
          if (typeof response.destroy === 'function') response.destroy();
          return finish(resolve, { statusCode, ...seen, body: Buffer.concat(chunks).toString('utf8'), truncated: true });
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
        ? { statusCode, ...seen, body: Buffer.concat(chunks).toString('utf8') }
        : { statusCode }));
      response.on('error', error => finish(reject, new GuardedFetchError(
        'Outbound response failed', 'GUARDED_FETCH_TRANSPORT_FAILED', error && error.code
      )));
      response.resume();
      return undefined;
    });

    request.on('timeout', () => {
      const error = new GuardedFetchError('Outbound request timed out', 'GUARDED_FETCH_TIMEOUT');
      if (typeof request.destroy === 'function') request.destroy(error);
      finish(reject, error);
    });
    request.on('error', error => finish(reject, error instanceof GuardedFetchError
      ? error
      : new GuardedFetchError('Outbound request failed', 'GUARDED_FETCH_TRANSPORT_FAILED', error && error.code)));
    request.end(body == null ? undefined : body);
  });
}

module.exports = Object.freeze({
  PROFILES,
  CODES,
  MAX_RESPONSE_BYTES,
  MAX_DNS_ANSWERS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  GuardedFetchError,
  normalizeTarget,
  validateAddresses,
  createGuardedSession,
  guardedFetch
});
