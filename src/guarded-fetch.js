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
  PROVIDER_READ: 'provider-read'
});

const PROFILE_RULES = Object.freeze({
  [PROFILES.WEBHOOK]: Object.freeze({ methods: Object.freeze(['POST']), query: false, readsBody: false }),
  [PROFILES.PROVIDER_READ]: Object.freeze({ methods: Object.freeze(['GET', 'HEAD']), query: true, readsBody: true })
});

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 20_000;
const MAX_DNS_ANSWERS = 32;

/*
 * Carries a code and nothing else. A verification probe sends a discovered
 * credential in a header, and an error that quotes its own request writes that
 * credential into whatever reads the error -- a log, an evidence record, a
 * response body. So no message here is built from caller input, and the
 * underlying failure contributes its code rather than its text.
 */
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

async function guardedFetch(input = {}) {
  const rule = rules(input.profile);
  const method = String(input.method || '').toUpperCase();
  if (!rule.methods.includes(method)) {
    throw new GuardedFetchError('This profile does not permit that method', 'GUARDED_FETCH_METHOD_INVALID');
  }

  const target = normalizeTarget(input.url, input.profile);
  const body = input.body == null ? null : String(input.body);
  const maxBytes = boundedInteger(input.maxResponseBytes, MAX_RESPONSE_BYTES, 1024, MAX_RESPONSE_BYTES);
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
    const resolver = typeof input.resolveAddresses === 'function'
      ? input.resolveAddresses
      : async hostname => dns.promises.lookup(hostname, { all: true, verbatim: true });
    try {
      answers = await resolver(target.hostname);
    } catch (error) {
      throw new GuardedFetchError('Outbound target could not be resolved', 'GUARDED_FETCH_DNS_INVALID', error && error.code);
    }
  }
  /* Validation before a socket exists: a refused address must never reach one. */
  const validated = validateAddresses(answers);
  const pinned = validated[0];

  const requestImpl = typeof input.requestImpl === 'function' ? input.requestImpl : https.request;
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30_000);
  const deadlineMs = boundedInteger(input.deadlineMs, DEFAULT_DEADLINE_MS, 1000, 120_000);
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
    }, deadlineMs);
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
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      timeout: timeoutMs,
      /* No shared agent: a pooled socket could be one opened to a different
         address for the same hostname. */
      agent: false
    }, response => {
      const statusCode = Number(response.statusCode || 0);

      if (rule.readsBody) {
        const encoding = String((response.headers || {})['content-encoding'] || '').trim().toLowerCase();
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
        ? { statusCode, body: Buffer.concat(chunks).toString('utf8') }
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
  guardedFetch
});
