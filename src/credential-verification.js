'use strict';

const crypto = require('crypto');

const { PROFILES, guardedFetch } = require('./guarded-fetch');

/*
 * Asking the provider that issued a credential whether it is still live.
 *
 * The scanner already finds credentials. What it cannot say is whether the one
 * it found still works, and that is the difference between a finding a reader
 * has to triage and a finding a reader has to act on this hour. Only the
 * issuing provider knows, so the only way to find out is to use the credential
 * -- which is why almost everything in this file is about not doing that.
 *
 * Three rules shape all of it.
 *
 * Reading a repository is not permission to use what is inside it. A probe
 * requires a separate signed authorization bound to the actor, the repository,
 * the commit, the exact candidate, the adapter and the target, valid for
 * minutes. Anything else produces a record and no request. The check happens
 * before a socket exists, because a probe that is refused afterwards has
 * already used the credential and no later verdict takes that back.
 *
 * The answer is three-state and deliberately asymmetric. `verified` means an
 * identity endpoint confirmed the credential. `rejected` means a documented,
 * unambiguous refusal. Everything else is `unverifiable`, and that includes
 * every case where a provider said something that could mean either -- a 403
 * that is throttling or policy, a Slack `invalid_auth` that is a dead token or
 * a live one used from the wrong address. "We could not tell" and "it is
 * harmless" are different sentences and only one of them is true.
 *
 * Nothing leaves here carrying the credential. Not a record, not an error, not
 * a log line -- this module writes nothing at all. The response is read for a
 * bounded set of fields and then dropped: a provider that echoes the token
 * back in an error message is a provider whose error message must not be
 * stored. The claim is tested rather than asserted, by a synthetic credential
 * searched for across every output surface.
 *
 * What is deliberately absent matters as much. There is no AWS adapter,
 * because the rule that finds an access key ID finds half a credential and
 * pairing it with a nearby-looking secret is guessing with someone else's
 * account. There is no adapter for an installation token, a deploy token, a
 * runner token or a private key: each authenticates differently and an
 * unreviewed guess at the right endpoint would be a verdict with no evidence
 * behind it. Those stay detected and unverifiable, which is an honest answer.
 */

const VERIFICATION_STATES = Object.freeze({
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  UNVERIFIABLE: 'unverifiable'
});

/*
 * A closed vocabulary. A reason ends up on a stored finding and in front of a
 * reader, so the set has to be small enough to write help text for and stable
 * enough that a stored record still means what it meant. Its own test asserts
 * every entry here is reachable.
 */
const REASONS = Object.freeze({
  AUTHORIZATION_MISSING: 'authorization-missing',
  AUTHORIZATION_INVALID: 'authorization-invalid',
  AUTHORIZATION_EXPIRED: 'authorization-expired',
  AUTHORIZATION_MISMATCH: 'authorization-mismatch',
  UNSUPPORTED_CREDENTIAL_CLASS: 'unsupported-credential-class',
  UNSUPPORTED_TOKEN_CLASS: 'unsupported-token-class',
  INCOMPLETE_CREDENTIAL: 'incomplete-credential',
  IDENTITY_CONFIRMED: 'identity-confirmed',
  CREDENTIAL_REFUSED: 'credential-refused',
  MALFORMED_IDENTITY_RESPONSE: 'malformed-identity-response',
  PROVIDER_THROTTLED: 'provider-throttled',
  PROVIDER_POLICY_RESTRICTED: 'provider-policy-restricted',
  PROVIDER_AMBIGUOUS_REJECTION: 'provider-ambiguous-rejection',
  PROVIDER_UNEXPECTED_STATUS: 'provider-unexpected-status',
  TRANSPORT_REFUSED: 'transport-refused',
  TRANSPORT_TIMEOUT: 'transport-timeout',
  RUN_LIMIT_REACHED: 'run-limit-reached'
});

/* An authorization is minutes, not hours. It is consent to one probe against
   one target, and a grant that outlives the screen it was given on is a grant
   nobody is watching. */
const MAX_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;

/* One observation is good for a day. Past that the answer is unknown again --
   not rejected, which is the distinction `verificationFreshness` exists to
   keep. */
const VERIFICATION_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/* An identity response is a few hundred bytes. A generous ceiling on it is
   still two orders of magnitude below the transport's, and a provider that
   answers this endpoint with a megabyte is not answering this endpoint. */
const PROBE_MAX_RESPONSE_BYTES = 16 * 1024;

/* One free web service, and every probe is a request someone else counts
   against us. A run asks at most this many times however many candidates a
   repository holds. */
const MAX_PROBES_PER_RUN = 50;

/* Whatever a provider says about when to come back, we come back no sooner
   than a second and no later than an hour. A Retry-After is their opinion, not
   a scheduler. */
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

const USER_AGENT = 'Nebulaverse-X-Exposure-Verifier/1.0';
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const SUBJECT_DIGEST_CHARS = 32;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJsonObject(body, maxBytes = PROBE_MAX_RESPONSE_BYTES) {
  if (typeof body !== 'string' || body.length > maxBytes) return null;
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { return null; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function parseJson(body, maxBytes) {
  if (typeof body !== 'string' || body.length > maxBytes) return undefined;
  try { return JSON.parse(body); }
  catch { return undefined; }
}

/*
 * Seconds, per RFC 9110, clamped at both ends. The HTTP-date form is accepted
 * too because providers send it, but a date is read as a duration from now
 * rather than trusted as an absolute instant -- their clock is not ours.
 */
function retryAfterMs(headers, now) {
  const raw = text(headers && (headers['retry-after'] || headers['Retry-After']));
  if (!raw) return null;
  let ms = null;
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
  else {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(Math.round(ms), MIN_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
}

/* ---- Adapters ---------------------------------------------------------- */

/*
 * Every adapter names the one endpoint that proves authentication for the one
 * token class it accepts, and nothing else.
 *
 * GitHub's `/rate_limit` is the trap worth naming: it answers 200 to an
 * unauthenticated caller, so a 200 there is not proof of anything. `/user`
 * requires a user credential and returns the user it belongs to, which is the
 * question actually being asked.
 */

function githubInterpretation(response, now) {
  const { statusCode } = response;
  if (statusCode === 200) {
    const body = parseJsonObject(response.body);
    const login = body && text(body.login);
    const id = body && body.id;
    if (!login || !Number.isInteger(id)) {
      return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.MALFORMED_IDENTITY_RESPONSE };
    }
    return { state: VERIFICATION_STATES.VERIFIED, reason: REASONS.IDENTITY_CONFIRMED, subject: String(id) };
  }
  if (statusCode === 401) {
    return { state: VERIFICATION_STATES.REJECTED, reason: REASONS.CREDENTIAL_REFUSED };
  }
  if (statusCode === 429) {
    return {
      state: VERIFICATION_STATES.UNVERIFIABLE,
      reason: REASONS.PROVIDER_THROTTLED,
      retryAfterMs: retryAfterMs(response.headers, now)
    };
  }
  /*
   * A 403 is the reason this adapter cannot read status codes alone. GitHub
   * uses it for primary throttling, for secondary throttling, and for an
   * organisation policy that forbids this token from this resource. All three
   * describe a credential that works, so none of them may be recorded as a
   * refusal -- and the two throttling kinds carry a window we must not probe
   * inside.
   */
  if (statusCode === 403) {
    const message = text(parseJsonObject(response.body) && parseJsonObject(response.body).message).toLowerCase();
    const throttled = /rate limit|secondary rate|abuse detection|too many requests/.test(message);
    return {
      state: VERIFICATION_STATES.UNVERIFIABLE,
      reason: throttled ? REASONS.PROVIDER_THROTTLED : REASONS.PROVIDER_POLICY_RESTRICTED,
      retryAfterMs: throttled ? retryAfterMs(response.headers, now) : null
    };
  }
  return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_STATUS };
}

function gitlabInterpretation(response, now) {
  const { statusCode } = response;
  if (statusCode === 200) {
    const body = parseJsonObject(response.body);
    const username = body && text(body.username);
    const id = body && body.id;
    if (!username || !Number.isInteger(id)) {
      return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.MALFORMED_IDENTITY_RESPONSE };
    }
    return { state: VERIFICATION_STATES.VERIFIED, reason: REASONS.IDENTITY_CONFIRMED, subject: String(id) };
  }
  if (statusCode === 401) {
    return { state: VERIFICATION_STATES.REJECTED, reason: REASONS.CREDENTIAL_REFUSED };
  }
  if (statusCode === 429) {
    return {
      state: VERIFICATION_STATES.UNVERIFIABLE,
      reason: REASONS.PROVIDER_THROTTLED,
      retryAfterMs: retryAfterMs(response.headers, now)
    };
  }
  /* GitLab's 403 is a forbidden scope or an instance policy, not a dead
     token: a `read_user`-less PAT is live and still cannot read /user. */
  if (statusCode === 403) {
    return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_POLICY_RESTRICTED };
  }
  return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_STATUS };
}

/*
 * Slack answers 200 to nearly everything, so the status line carries no
 * information and `ok` carries all of it. The error codes then divide into
 * three groups that must not be collapsed: the token is gone, the token is
 * fine but this caller is not allowed, and we cannot tell which.
 *
 * `invalid_auth` is the one the plan calls out by name. Slack returns it both
 * for a revoked token and for a valid token presented from an address the
 * workspace restricts. Recording it as revoked tells a reader the exposure is
 * over while the credential is still live.
 */
const SLACK_DEFINITE_REFUSALS = Object.freeze([
  'token_revoked', 'token_expired', 'account_inactive', 'invalid_token', 'user_removed_from_team'
]);
const SLACK_AMBIGUOUS = Object.freeze(['invalid_auth', 'not_authed']);
const SLACK_POLICY = Object.freeze(['ekm_access_denied', 'no_permission', 'org_login_required', 'enterprise_is_restricted']);
const SLACK_THROTTLED = Object.freeze(['ratelimited', 'rate_limited']);

function slackInterpretation(response, now) {
  const { statusCode } = response;
  if (statusCode === 429) {
    return {
      state: VERIFICATION_STATES.UNVERIFIABLE,
      reason: REASONS.PROVIDER_THROTTLED,
      retryAfterMs: retryAfterMs(response.headers, now)
    };
  }
  if (statusCode !== 200) {
    return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_STATUS };
  }

  const body = parseJsonObject(response.body);
  if (!body || typeof body.ok !== 'boolean') {
    return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.MALFORMED_IDENTITY_RESPONSE };
  }
  if (body.ok) {
    const userId = text(body.user_id);
    const teamId = text(body.team_id);
    if (!userId || !teamId) {
      return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.MALFORMED_IDENTITY_RESPONSE };
    }
    return {
      state: VERIFICATION_STATES.VERIFIED,
      reason: REASONS.IDENTITY_CONFIRMED,
      subject: `${teamId}:${userId}`
    };
  }

  const error = text(body.error).toLowerCase();
  if (!error) return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.MALFORMED_IDENTITY_RESPONSE };
  if (SLACK_DEFINITE_REFUSALS.includes(error)) {
    return { state: VERIFICATION_STATES.REJECTED, reason: REASONS.CREDENTIAL_REFUSED };
  }
  if (SLACK_AMBIGUOUS.includes(error)) {
    return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_AMBIGUOUS_REJECTION };
  }
  if (SLACK_POLICY.includes(error)) {
    return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_POLICY_RESTRICTED };
  }
  if (SLACK_THROTTLED.includes(error)) {
    return {
      state: VERIFICATION_STATES.UNVERIFIABLE,
      reason: REASONS.PROVIDER_THROTTLED,
      retryAfterMs: retryAfterMs(response.headers, now)
    };
  }
  /* A code this adapter has not been reviewed against is not a verdict. */
  return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_STATUS };
}

/*
 * The providers most often leaked, each asked the one question that proves a
 * credential authenticates: an identity endpoint where there is one, and
 * otherwise the cheapest read that requires the credential and changes
 * nothing. Every one of them is a GET or a documented read-only POST, sends
 * the credential in a header, and has its refusals sorted the same way as the
 * three above -- only a documented, unambiguous refusal is `rejected`.
 *
 * What is deliberately not here: any provider whose credential has to travel
 * in a URL (a Telegram bot token, a Mapbox token, a webhook URL), because the
 * transport refuses to put a secret where logs keep it; any whose endpoint
 * depends on a host found in the repository (Shopify, Databricks, Vault,
 * JFrog, Atlassian), because that host is data somebody else chose; and any
 * whose credential is half of a pair (Twilio, Braintree, AWS).
 */

/*
 * A standard reading of an identity or read-only endpoint. `subject` pulls a
 * stable id out of a 200 when the endpoint returns one; `refusal` decides
 * which non-200 answers are the provider saying the credential is dead, and
 * everything else that is not throttling is policy or unexpected -- never a
 * verdict nobody gave.
 */
function identityInterpretation(options = {}) {
  const maxBytes = options.maxResponseBytes || PROBE_MAX_RESPONSE_BYTES;
  const refused = options.refusedStatuses || [401];
  const ambiguous = options.ambiguousStatuses || [];
  return function interpret(response, now) {
    const { statusCode } = response;
    const body = parseJson(response.body, maxBytes);
    if (statusCode === 200) {
      if (typeof options.refusedWhen === 'function' && options.refusedWhen(body, statusCode)) {
        return { state: VERIFICATION_STATES.REJECTED, reason: REASONS.CREDENTIAL_REFUSED };
      }
      if (typeof options.subject === 'function') {
        const subject = options.subject(body);
        if (!subject) return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.MALFORMED_IDENTITY_RESPONSE };
        return { state: VERIFICATION_STATES.VERIFIED, reason: REASONS.IDENTITY_CONFIRMED, subject: String(subject) };
      }
      if (body === undefined) return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.MALFORMED_IDENTITY_RESPONSE };
      return { state: VERIFICATION_STATES.VERIFIED, reason: REASONS.IDENTITY_CONFIRMED };
    }
    if (statusCode === 429) {
      return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_THROTTLED, retryAfterMs: retryAfterMs(response.headers, now) };
    }
    if (typeof options.policyWhen === 'function' && options.policyWhen(body, statusCode)) {
      return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_POLICY_RESTRICTED };
    }
    if (typeof options.refusedWhen === 'function' && options.refusedWhen(body, statusCode)) {
      return { state: VERIFICATION_STATES.REJECTED, reason: REASONS.CREDENTIAL_REFUSED };
    }
    if (ambiguous.includes(statusCode)) {
      return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_AMBIGUOUS_REJECTION };
    }
    if (refused.includes(statusCode)) return { state: VERIFICATION_STATES.REJECTED, reason: REASONS.CREDENTIAL_REFUSED };
    if (statusCode === 403) return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_POLICY_RESTRICTED };
    return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_STATUS };
  };
}

const field = (...keys) => body => {
  let value = body;
  for (const key of keys) value = value && typeof value === 'object' ? value[key] : undefined;
  return (typeof value === 'string' && value.trim()) || (Number.isInteger(value) ? String(value) : '');
};
const bearer = secret => ({ authorization: `Bearer ${secret}` });
const LIST_RESPONSE_BYTES = 128 * 1024;

function adapter(spec) {
  return Object.freeze({
    version: 1,
    profile: PROFILES.CREDENTIAL_VERIFY,
    method: 'GET',
    body: null,
    headers: Object.freeze({ accept: 'application/json' }),
    credential: bearer,
    maxResponseBytes: PROBE_MAX_RESPONSE_BYTES,
    ...spec,
    headers: Object.freeze({ accept: 'application/json', ...(spec.headers || {}) })
  });
}

const PROVIDER_ADAPTERS = [
  adapter({
    id: 'openai-api-key', rule: 'openai-api-key', supports: /^sk-[A-Za-z0-9_-]{20,}$/,
    origin: 'https://api.openai.com', probePath: '/v1/models', targetId: 'api.openai.com',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES })
  }),
  adapter({
    id: 'anthropic-api-key', rule: 'anthropic-api-key', supports: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    origin: 'https://api.anthropic.com', probePath: '/v1/models', targetId: 'api.anthropic.com',
    headers: { 'anthropic-version': '2023-06-01' },
    credential: secret => ({ 'x-api-key': secret }),
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES })
  }),
  adapter({
    id: 'huggingface-token', rule: 'huggingface-token', supports: /^hf_[A-Za-z0-9]{30,}$/,
    origin: 'https://huggingface.co', probePath: '/api/whoami-v2', targetId: 'huggingface.co',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES, subject: field('id') })
  }),
  adapter({
    id: 'groq-api-key', rule: 'groq-api-key', supports: /^gsk_[A-Za-z0-9]{40,}$/,
    origin: 'https://api.groq.com', probePath: '/openai/v1/models', targetId: 'api.groq.com',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES })
  }),
  adapter({
    id: 'replicate-token', rule: 'replicate-token', supports: /^r8_[A-Za-z0-9]{30,}$/,
    origin: 'https://api.replicate.com', probePath: '/v1/account', targetId: 'api.replicate.com',
    interpret: identityInterpretation({ subject: field('username') })
  }),
  adapter({
    id: 'google-api-key', rule: 'google-api-key', supports: /^AIza[0-9A-Za-z_-]{35}$/,
    origin: 'https://generativelanguage.googleapis.com', probePath: '/v1beta/models', targetId: 'generativelanguage.googleapis.com',
    credential: secret => ({ 'x-goog-api-key': secret }),
    maxResponseBytes: LIST_RESPONSE_BYTES,
    /* A key Google does not recognise is a 400 naming API_KEY_INVALID. A 403
       is a live key restricted from this API, which is still a live key. */
    interpret: identityInterpretation({
      maxResponseBytes: LIST_RESPONSE_BYTES,
      refusedStatuses: [],
      refusedWhen: (body, status) => status === 400 && JSON.stringify(body || {}).includes('API_KEY_INVALID')
    })
  }),
  adapter({
    id: 'stripe-live-key', rule: 'stripe-live-key', supports: /^(?:sk|rk)_live_[0-9A-Za-z]{20,}$/,
    origin: 'https://api.stripe.com', probePath: '/v1/account', targetId: 'api.stripe.com',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES, subject: field('id') })
  }),
  adapter({
    id: 'stripe-test-key', rule: 'stripe-test-key', supports: /^(?:sk|rk)_test_[0-9A-Za-z]{20,}$/,
    origin: 'https://api.stripe.com', probePath: '/v1/account', targetId: 'api.stripe.com',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES, subject: field('id') })
  }),
  adapter({
    id: 'sendgrid-api-key', rule: 'sendgrid-api-key', supports: /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
    origin: 'https://api.sendgrid.com', probePath: '/v3/scopes', targetId: 'api.sendgrid.com',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES })
  }),
  adapter({
    /* Mailgun keys are regional and this asks the US region: a refusal here
       may be an EU key, so it is ambiguous rather than a verdict. */
    id: 'mailgun-api-key', rule: 'mailgun-api-key', supports: /^key-[0-9a-f]{32}$|^[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{8}$/,
    origin: 'https://api.mailgun.net', probePath: '/v3/domains', targetId: 'api.mailgun.net',
    credential: secret => ({ authorization: `Basic ${Buffer.from(`api:${secret}`).toString('base64')}` }),
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES, refusedStatuses: [], ambiguousStatuses: [401] })
  }),
  adapter({
    id: 'resend-api-key', rule: 'resend-api-key', supports: /^re_[A-Za-z0-9_]{20,}$/,
    origin: 'https://api.resend.com', probePath: '/domains', targetId: 'api.resend.com',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    /* A sending-only key is refused here with its own name, and it is a live
       key; an invalid one is refused with another. */
    interpret: identityInterpretation({
      maxResponseBytes: LIST_RESPONSE_BYTES,
      refusedStatuses: [],
      policyWhen: body => field('name')(body) === 'restricted_api_key',
      refusedWhen: (body, status) => status !== 200 && field('name')(body) === 'invalid_api_key'
    })
  }),
  adapter({
    id: 'npm-token', rule: 'npm-token', supports: /^npm_[A-Za-z0-9]{36}$/,
    origin: 'https://registry.npmjs.org', probePath: '/-/whoami', targetId: 'registry.npmjs.org',
    interpret: identityInterpretation({ subject: field('username') })
  }),
  adapter({
    id: 'digitalocean-token', rule: 'digitalocean-token', supports: /^do[opr]_v1_[a-f0-9]{64}$/,
    origin: 'https://api.digitalocean.com', probePath: '/v2/account', targetId: 'api.digitalocean.com',
    interpret: identityInterpretation({ subject: field('account', 'uuid') })
  }),
  adapter({
    id: 'notion-token', rule: 'notion-token', supports: /^(?:secret_|ntn_)[A-Za-z0-9]{30,}$/,
    origin: 'https://api.notion.com', probePath: '/v1/users/me', targetId: 'api.notion.com',
    headers: { 'notion-version': '2022-06-28' },
    interpret: identityInterpretation({ subject: field('id') })
  }),
  adapter({
    id: 'airtable-token', rule: 'airtable-token', supports: /^pat[A-Za-z0-9]{14}\.[a-f0-9]{64}$/,
    origin: 'https://api.airtable.com', probePath: '/v0/meta/whoami', targetId: 'api.airtable.com',
    interpret: identityInterpretation({ subject: field('id') })
  }),
  adapter({
    /* Linear sends a personal key bare, without a scheme, and answers a bad
       one with a GraphQL error naming authentication. */
    id: 'linear-api-key', rule: 'linear-api-key', supports: /^lin_api_[A-Za-z0-9]{40}$/,
    origin: 'https://api.linear.app', probePath: '/graphql', targetId: 'api.linear.app',
    method: 'POST', body: JSON.stringify({ query: '{ viewer { id } }' }),
    headers: { 'content-type': 'application/json' },
    credential: secret => ({ authorization: secret }),
    interpret: identityInterpretation({
      subject: field('data', 'viewer', 'id'),
      refusedWhen: body => JSON.stringify(body || {}).includes('AUTHENTICATION_ERROR')
    })
  }),
  adapter({
    id: 'postman-api-key', rule: 'postman-api-key', supports: /^PMAK-[a-f0-9]{24}-[a-f0-9]{34}$/,
    origin: 'https://api.getpostman.com', probePath: '/me', targetId: 'api.getpostman.com',
    credential: secret => ({ 'x-api-key': secret }),
    interpret: identityInterpretation({ subject: field('user', 'id') })
  }),
  adapter({
    /* Figma answers a bad token with a 403 that says so, and a 403 that says
       anything else is a live token without the scope. */
    id: 'figma-token', rule: 'figma-token', supports: /^figd_[A-Za-z0-9_-]{40,}$/,
    origin: 'https://api.figma.com', probePath: '/v1/me', targetId: 'api.figma.com',
    credential: secret => ({ 'x-figma-token': secret }),
    interpret: identityInterpretation({
      subject: field('id'),
      refusedWhen: (body, status) => status === 403 && /invalid token/i.test(field('err')(body))
    })
  }),
  adapter({
    id: 'doppler-token', rule: 'doppler-token', supports: /^dp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9]{40,}$/,
    origin: 'https://api.doppler.com', probePath: '/v3/me', targetId: 'api.doppler.com',
    interpret: identityInterpretation({ subject: field('slug') })
  }),
  adapter({
    id: 'netlify-token', rule: 'netlify-token', supports: /^nfp_[A-Za-z0-9]{36,}$/,
    origin: 'https://api.netlify.com', probePath: '/api/v1/user', targetId: 'api.netlify.com',
    interpret: identityInterpretation({ subject: field('id') })
  }),
  adapter({
    id: 'render-api-key', rule: 'render-api-key', supports: /^rnd_[A-Za-z0-9]{32,}$/,
    origin: 'https://api.render.com', probePath: '/v1/users', targetId: 'api.render.com',
    interpret: identityInterpretation({})
  }),
  adapter({
    id: 'neon-api-key', rule: 'neon-api-key', supports: /^napi_[a-z0-9]{60,}$/,
    origin: 'https://console.neon.tech', probePath: '/api/v2/users/me', targetId: 'console.neon.tech',
    interpret: identityInterpretation({ subject: field('id') })
  }),
  adapter({
    id: 'sentry-token', rule: 'sentry-token', supports: /^sntry[su]_[A-Za-z0-9_=+/-]{40,}$/,
    origin: 'https://sentry.io', probePath: '/api/0/organizations/', targetId: 'sentry.io',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES })
  }),
  adapter({
    id: 'circleci-token', rule: 'circleci-token', supports: /^CCIPAT_[A-Za-z0-9]{20,}_[a-f0-9]{40}$/,
    origin: 'https://circleci.com', probePath: '/api/v2/me', targetId: 'circleci.com',
    credential: secret => ({ 'circle-token': secret }),
    interpret: identityInterpretation({ subject: field('id') })
  }),
  adapter({
    id: 'buildkite-token', rule: 'buildkite-token', supports: /^bkua_[a-f0-9]{40}$/,
    origin: 'https://api.buildkite.com', probePath: '/v2/access-token', targetId: 'api.buildkite.com',
    interpret: identityInterpretation({ subject: field('uuid') })
  }),
  adapter({
    id: 'terraform-cloud-token', rule: 'terraform-cloud-token', supports: /^[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_=-]{60,}$/,
    origin: 'https://app.terraform.io', probePath: '/api/v2/account/details', targetId: 'app.terraform.io',
    headers: { accept: 'application/vnd.api+json' },
    interpret: identityInterpretation({ subject: field('data', 'id') })
  }),
  adapter({
    id: 'pulumi-token', rule: 'pulumi-token', supports: /^pul-[a-f0-9]{40}$/,
    origin: 'https://api.pulumi.com', probePath: '/api/user', targetId: 'api.pulumi.com',
    credential: secret => ({ authorization: `token ${secret}` }),
    interpret: identityInterpretation({ subject: body => field('githubLogin')(body) || field('name')(body) })
  }),
  adapter({
    id: 'hubspot-token', rule: 'hubspot-token', supports: /^pat-(?:na|eu)[12]-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    origin: 'https://api.hubapi.com', probePath: '/account-info/v3/details', targetId: 'api.hubapi.com',
    interpret: identityInterpretation({ subject: field('portalId') })
  }),
  adapter({
    id: 'contentful-token', rule: 'contentful-token', supports: /^CFPAT-[A-Za-z0-9_-]{43}$/,
    origin: 'https://api.contentful.com', probePath: '/users/me', targetId: 'api.contentful.com',
    interpret: identityInterpretation({ subject: field('sys', 'id') })
  }),
  adapter({
    /* Square's sandbox tokens share a prefix with production ones, and this
       asks production: a refusal may be a live sandbox token. */
    id: 'square-token', rule: 'square-token', supports: /^(?:EAAA[A-Za-z0-9_-]{50,}|sq0atp-[A-Za-z0-9_-]{22,})$/,
    origin: 'https://connect.squareup.com', probePath: '/v2/merchants/me', targetId: 'connect.squareup.com',
    interpret: identityInterpretation({ subject: field('merchant', 'id'), refusedStatuses: [], ambiguousStatuses: [401] })
  }),
  adapter({
    id: 'supabase-access-token', rule: 'supabase-access-token', supports: /^sbp_(?:oauth_)?[a-f0-9]{40}$/,
    origin: 'https://api.supabase.com', probePath: '/v1/projects', targetId: 'api.supabase.com',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES })
  }),
  adapter({
    /* xAI refuses a key it does not know with a 400 that says so. */
    id: 'xai-api-key', rule: 'xai-api-key', supports: /^xai-[A-Za-z0-9]{80}$/,
    origin: 'https://api.x.ai', probePath: '/v1/api-key', targetId: 'api.x.ai',
    interpret: identityInterpretation({
      refusedWhen: (body, status) => status === 400 && /incorrect api key|invalid api key/i.test(JSON.stringify(body || ''))
    })
  }),
  adapter({
    id: 'openrouter-api-key', rule: 'openrouter-api-key', supports: /^sk-or-v1-[a-f0-9]{64}$/,
    origin: 'https://openrouter.ai', probePath: '/api/v1/auth/key', targetId: 'openrouter.ai',
    interpret: identityInterpretation({})
  }),
  adapter({
    id: 'pinecone-api-key', rule: 'pinecone-api-key', supports: /^pcsk_[A-Za-z0-9]{5,6}_[A-Za-z0-9]{50,70}$/,
    origin: 'https://api.pinecone.io', probePath: '/indexes', targetId: 'api.pinecone.io',
    credential: secret => ({ 'api-key': secret }),
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES })
  }),
  adapter({
    /* API keys only: an auth key joins devices and cannot call the API. */
    id: 'tailscale-api-key', rule: 'tailscale-key', supports: /^tskey-api-[A-Za-z0-9]{6,32}-[A-Za-z0-9]{20,64}$/,
    origin: 'https://api.tailscale.com', probePath: '/api/v2/tailnet/-/keys', targetId: 'api.tailscale.com',
    maxResponseBytes: LIST_RESPONSE_BYTES,
    interpret: identityInterpretation({ maxResponseBytes: LIST_RESPONSE_BYTES })
  }),
  adapter({
    /* Dropbox documents its identity call as a POST with a JSON null body. */
    id: 'dropbox-token', rule: 'dropbox-token', supports: /^sl\.[A-Za-z0-9_-]{130,}$/,
    origin: 'https://api.dropboxapi.com', probePath: '/2/users/get_current_account', targetId: 'api.dropboxapi.com',
    method: 'POST', body: 'null', headers: { 'content-type': 'application/json' },
    interpret: identityInterpretation({ subject: field('account_id') })
  }),
  adapter({
    id: 'asana-token', rule: 'asana-token', supports: /^[12]\/[0-9]{10,20}(?:\/[0-9]{10,20})?:[a-f0-9]{32}$/,
    origin: 'https://app.asana.com', probePath: '/api/1.0/users/me', targetId: 'app.asana.com',
    interpret: identityInterpretation({ subject: field('data', 'gid') })
  }),
  adapter({
    id: 'heroku-api-key', rule: 'heroku-api-key', supports: /^HRKU-[A-Za-z0-9_-]{58,64}$/,
    origin: 'https://api.heroku.com', probePath: '/account', targetId: 'api.heroku.com',
    headers: { accept: 'application/vnd.heroku+json; version=3' },
    interpret: identityInterpretation({ subject: field('id') })
  }),
  adapter({
    /* API keys only, asked on the US site: a key from another Datadog site
       is refused here too, so a refusal is ambiguous rather than a verdict. */
    id: 'datadog-api-key', rule: 'datadog-api-key', supports: /^[a-f0-9]{32}$/,
    origin: 'https://api.datadoghq.com', probePath: '/api/v1/validate', targetId: 'api.datadoghq.com',
    credential: secret => ({ 'dd-api-key': secret }),
    interpret: identityInterpretation({
      refusedStatuses: [],
      ambiguousStatuses: [403],
      refusedWhen: body => body && body.valid === false
    })
  }),
  adapter({
    /* An app-only bearer token, asked for one public post by id. A free-tier
       app is refused with a 403 naming its enrolment, which is a live token. */
    id: 'twitter-bearer-token', rule: 'twitter-bearer-token', supports: /^A{15,}[A-Za-z0-9%]{30,}$/,
    origin: 'https://api.twitter.com', probePath: '/2/tweets/20', targetId: 'api.twitter.com',
    interpret: identityInterpretation({})
  })
];

const ADAPTERS = Object.freeze({
  'github-user-token': Object.freeze({
    id: 'github-user-token',
    version: 1,
    rule: 'github-token',
    /*
     * Classic and fine-grained personal tokens, OAuth user tokens and
     * user-to-server tokens all authenticate as a user. `ghs_` is an
     * installation token and `ghr_` a refresh token: neither has a user and
     * neither belongs at this endpoint.
     */
    supports: /^(?:gh[pou]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})$/,
    profile: PROFILES.CREDENTIAL_VERIFY,
    origin: 'https://api.github.com',
    probePath: '/user',
    targetId: 'api.github.com',
    method: 'GET',
    body: null,
    headers: Object.freeze({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    }),
    interpret: githubInterpretation
  }),
  'gitlab-user-token': Object.freeze({
    id: 'gitlab-user-token',
    version: 1,
    rule: 'gitlab-token',
    /* Personal access tokens only. Deploy, runner, agent, feed and impersonation
       tokens each authenticate against a different surface. */
    supports: /^glpat-[A-Za-z0-9_-]{12,}$/,
    profile: PROFILES.CREDENTIAL_VERIFY,
    origin: 'https://gitlab.com',
    probePath: '/api/v4/user',
    targetId: 'gitlab.com',
    method: 'GET',
    body: null,
    headers: Object.freeze({ accept: 'application/json' }),
    interpret: gitlabInterpretation
  }),
  'slack-user-token': Object.freeze({
    id: 'slack-user-token',
    version: 1,
    rule: 'slack-token',
    /* Bot and user tokens. `xoxa`, `xoxr` and `xoxs` are app, refresh and
       session tokens and do not answer auth.test as themselves. */
    supports: /^xox[bp]-[A-Za-z0-9-]{20,}$/,
    profile: PROFILES.CREDENTIAL_VERIFY,
    origin: 'https://slack.com',
    probePath: '/api/auth.test',
    targetId: 'slack.com',
    /*
     * A POST with an empty body, which is the whole reason the transport has a
     * credential-bearing profile separate from a provider read. Slack
     * documents auth.test as a POST, and the credential goes in the
     * Authorization header rather than a form field so it is never part of a
     * body that could be logged as request content.
     */
    method: 'POST',
    body: '',
    headers: Object.freeze({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded'
    }),
    interpret: slackInterpretation
  }),
  ...Object.fromEntries(PROVIDER_ADAPTERS.map(entry => [entry.id, entry]))
});

const ADAPTER_BY_RULE = Object.freeze(Object.fromEntries(
  Object.values(ADAPTERS).map(adapter => [adapter.rule, adapter])
));

/*
 * The rule finds an access key ID, which is a name, not a credential: signing
 * needs the secret access key as well and a session token for a temporary
 * one. Pairing the ID with a nearby-looking string would be guessing at
 * someone's account with their own data, so this class is recorded as
 * incomplete and never sent anywhere.
 */
const INCOMPLETE_RULES = Object.freeze(['aws-access-key']);

function adapterForCandidate(candidate) {
  const rule = text(candidate && candidate.rule);
  const adapter = ADAPTER_BY_RULE[rule];
  if (!adapter) return null;
  const secret = typeof candidate.secret === 'string' ? candidate.secret.trim() : '';
  return adapter.supports.test(secret) ? adapter : null;
}

/* ---- Authorization ----------------------------------------------------- */

/*
 * Length-prefixed parts, so no rearrangement of one grant's fields can produce
 * another's message: an owner named `Demo` in a repository named `Acme` must
 * not sign the same bytes as the reverse.
 */
function authorizationMessage(grant) {
  const parts = [
    'nvexpauth.v1',
    'verify-credential',
    text(grant.authorizationId),
    text(grant.actorLogin),
    text(grant.scope && grant.scope.provider),
    text(grant.scope && grant.scope.authority),
    text(grant.scope && grant.scope.owner),
    text(grant.scope && grant.scope.repo),
    text(grant.commit),
    text(grant.candidateFingerprint),
    text(grant.adapter),
    text(grant.targetId),
    text(grant.issuedAt),
    text(grant.expiresAt)
  ];
  return parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

function signVerificationAuthorization(input = {}) {
  if (!Buffer.isBuffer(input.hmacKey) && typeof input.hmacKey !== 'string') {
    throw new TypeError('A verification authorization requires a derived HMAC key');
  }
  const grant = {
    authorizationId: text(input.authorizationId),
    actorLogin: text(input.actorLogin),
    scope: Object.freeze({
      provider: text(input.scope && input.scope.provider),
      authority: text(input.scope && input.scope.authority),
      owner: text(input.scope && input.scope.owner),
      repo: text(input.scope && input.scope.repo)
    }),
    commit: text(input.commit),
    candidateFingerprint: text(input.candidateFingerprint),
    adapter: text(input.adapter),
    targetId: text(input.targetId),
    issuedAt: text(input.issuedAt),
    expiresAt: text(input.expiresAt)
  };
  const signature = crypto.createHmac('sha256', input.hmacKey)
    .update(authorizationMessage(grant), 'utf8')
    .digest('hex');
  return Object.freeze({ ...grant, signature });
}

/*
 * Returns a reason code, or null when the grant is good. Order matters: the
 * signature is checked before any field is read as meaningful, because an
 * unsigned grant's fields are just text a caller supplied.
 */
function authorizationRefusal({ authorization, hmacKey, adapter, candidate, actorLogin, now }) {
  if (!authorization || typeof authorization !== 'object') return REASONS.AUTHORIZATION_MISSING;
  const signature = text(authorization.signature);
  if (!signature && !text(authorization.authorizationId)) return REASONS.AUTHORIZATION_MISSING;
  if (!SIGNATURE_PATTERN.test(signature)) return REASONS.AUTHORIZATION_INVALID;

  const expected = crypto.createHmac('sha256', hmacKey)
    .update(authorizationMessage(authorization), 'utf8')
    .digest();
  const presented = Buffer.from(signature, 'hex');
  if (presented.length !== expected.length) return REASONS.AUTHORIZATION_INVALID;
  if (!crypto.timingSafeEqual(presented, expected)) return REASONS.AUTHORIZATION_INVALID;

  const issuedAt = Date.parse(text(authorization.issuedAt));
  const expiresAt = Date.parse(text(authorization.expiresAt));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt <= issuedAt) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt - issuedAt > MAX_AUTHORIZATION_LIFETIME_MS) return REASONS.AUTHORIZATION_INVALID;
  if (issuedAt > now) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt <= now) return REASONS.AUTHORIZATION_EXPIRED;
  if (!text(authorization.actorLogin)) return REASONS.AUTHORIZATION_INVALID;

  /*
   * Bound to this candidate in this repository at this commit, for this
   * adapter against this target. A grant for any other combination is a grant
   * for a different question.
   */
  const scope = authorization.scope && typeof authorization.scope === 'object' ? authorization.scope : {};
  const bound = [
    [text(scope.provider), text(candidate.scope && candidate.scope.provider)],
    [text(scope.authority), text(candidate.scope && candidate.scope.authority)],
    [text(scope.owner), text(candidate.scope && candidate.scope.owner)],
    [text(scope.repo), text(candidate.scope && candidate.scope.repo)],
    [text(authorization.commit), text(candidate.commit)],
    [text(authorization.candidateFingerprint), text(candidate.fingerprint)],
    [text(authorization.adapter), adapter.id],
    [text(authorization.targetId), adapter.targetId]
  ];
  if (actorLogin != null) bound.push([text(authorization.actorLogin), text(actorLogin)]);
  for (const [granted, required] of bound) {
    if (!granted || granted !== required) return REASONS.AUTHORIZATION_MISMATCH;
  }
  return null;
}

/* ---- Records ----------------------------------------------------------- */

/*
 * Which provider account a leaked credential belongs to is worth being able to
 * compare between runs; storing the login to do it is a detail no finding
 * needs. The digest is keyed, under its own purpose, because a provider user
 * id is short and guessable and an unkeyed digest of it is the id.
 */
function subjectDigestFor(subject, adapterId, subjectKey) {
  if (!subject || (!Buffer.isBuffer(subjectKey) && typeof subjectKey !== 'string')) return null;
  return crypto.createHmac('sha256', subjectKey)
    .update(`${adapterId}|${subject}`, 'utf8')
    .digest('hex')
    .slice(0, SUBJECT_DIGEST_CHARS);
}

function record(input) {
  const observedAt = new Date(input.now).toISOString();
  return Object.freeze({
    adapter: input.adapter ? input.adapter.id : null,
    adapterVersion: input.adapter ? input.adapter.version : null,
    authorizationId: input.authorizationId || null,
    candidateFingerprint: text(input.candidate && input.candidate.fingerprint) || null,
    deduplicated: Boolean(input.deduplicated),
    freshnessDeadline: new Date(input.now + VERIFICATION_FRESHNESS_MS).toISOString(),
    observedAt,
    reason: input.reason,
    retryAfterMs: Number.isFinite(input.retryAfterMs) ? input.retryAfterMs : null,
    state: input.state,
    subjectDigest: input.subjectDigest || null,
    targetId: input.adapter ? input.adapter.targetId : null
  });
}

/*
 * An observation ages out; a verdict does not change by itself. A `verified`
 * record whose deadline has passed still records a credential that was seen
 * live -- what is no longer known is whether it still is, which is what
 * re-verification is for. Letting staleness read as `rejected` would resolve
 * findings by waiting.
 */
function verificationFreshness(attempt, now) {
  const deadline = Date.parse(text(attempt && attempt.freshnessDeadline));
  if (!Number.isFinite(deadline)) return 'stale';
  return now < deadline ? 'fresh' : 'stale';
}

/*
 * The transport speaks codes; this file needs a reason. A transport error
 * message is never carried across, because it can quote the request it failed
 * to send and the request carries the credential.
 */
function transportRefusal(error) {
  const code = text(error && error.code);
  if (code === 'GUARDED_FETCH_TIMEOUT' || code === 'GUARDED_FETCH_DEADLINE') return REASONS.TRANSPORT_TIMEOUT;
  if (code === 'GUARDED_FETCH_RESPONSE_TOO_LARGE') return REASONS.MALFORMED_IDENTITY_RESPONSE;
  return REASONS.TRANSPORT_REFUSED;
}

/* ---- Verification ------------------------------------------------------ */

/*
 * Returns `{ record, probed }`. `probed` is what a run counts against its
 * ceiling: a refusal that never reached the network cost nobody anything.
 */
async function verifyOne(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const candidate = input.candidate && typeof input.candidate === 'object' ? input.candidate : {};
  const rule = text(candidate.rule);

  /*
   * Classification first, and it is not a shortcut past consent: none of these
   * paths reaches the network, so there is nothing to authorize. Answering
   * "this class has no reviewed adapter" is static knowledge about this
   * repository, not anything about the candidate.
   */
  if (INCOMPLETE_RULES.includes(rule)) {
    return {
      probed: false,
      record: record({
        now, candidate, adapter: null,
        state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.INCOMPLETE_CREDENTIAL
      })
    };
  }
  const known = ADAPTER_BY_RULE[rule];
  if (!known) {
    return {
      probed: false,
      record: record({
        now, candidate, adapter: null,
        state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.UNSUPPORTED_CREDENTIAL_CLASS
      })
    };
  }
  const adapter = adapterForCandidate(candidate);
  if (!adapter) {
    return {
      probed: false,
      record: record({
        now, candidate, adapter: null,
        state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.UNSUPPORTED_TOKEN_CLASS
      })
    };
  }

  if (!Buffer.isBuffer(input.authorizationKey) && typeof input.authorizationKey !== 'string') {
    throw new TypeError('Credential verification requires a derived authorization key');
  }
  const refusal = authorizationRefusal({
    authorization: input.authorization,
    hmacKey: input.authorizationKey,
    adapter,
    candidate,
    actorLogin: input.actorLogin,
    now
  });
  if (refusal) {
    return {
      probed: false,
      record: record({
        now, candidate, adapter,
        state: VERIFICATION_STATES.UNVERIFIABLE, reason: refusal
      })
    };
  }
  const authorizationId = text(input.authorization.authorizationId);

  /*
   * The URL is assembled from the adapter's own constants. A candidate can
   * name a rule and carry bytes; it can never contribute an origin, a path or
   * a query string, because a URL taken out of a repository is a URL an
   * attacker chose.
   */
  const transport = typeof input.transport === 'function' ? input.transport : guardedFetch;
  let response;
  try {
    /* The credential travels in a header, in the scheme its provider
       documents; a bearer token is the default and the common case. */
    const credential = typeof adapter.credential === 'function'
      ? adapter.credential(candidate.secret)
      : { authorization: `Bearer ${candidate.secret}` };
    response = await transport({
      url: `${adapter.origin}${adapter.probePath}`,
      profile: adapter.profile,
      method: adapter.method,
      headers: { ...adapter.headers, 'user-agent': USER_AGENT, ...credential },
      body: adapter.body,
      maxResponseBytes: adapter.maxResponseBytes || PROBE_MAX_RESPONSE_BYTES
    });
  } catch (error) {
    return {
      probed: true,
      record: record({
        now, candidate, adapter, authorizationId,
        state: VERIFICATION_STATES.UNVERIFIABLE, reason: transportRefusal(error)
      })
    };
  }

  const verdict = adapter.interpret(
    { statusCode: Number(response && response.statusCode) || 0, body: response && response.body, headers: (response && response.headers) || {} },
    now
  );
  return {
    probed: true,
    record: record({
      now, candidate, adapter, authorizationId,
      state: verdict.state,
      reason: verdict.reason,
      retryAfterMs: verdict.retryAfterMs,
      subjectDigest: subjectDigestFor(verdict.subject, adapter.id, input.subjectKey)
    })
  };
}

async function verifyCredential(input = {}) {
  const { record: attempt } = await verifyOne(input);
  return attempt;
}

/*
 * A run over many candidates, with the three bounds that make it safe to point
 * at a repository nobody has looked at yet.
 *
 * The same credential in four files is one probe: repeating it tells us nothing
 * and spends somebody else's rate limit. A provider that says it is throttling
 * is not asked again in this run -- probing inside a window it just told us
 * about is how a temporary throttle becomes a longer one. And a run asks a
 * finite number of times whatever the repository holds, because this server
 * has one process and the cost of a scan cannot scale with someone else's
 * checkout.
 */
async function verifyCandidates(input = {}) {
  const requests = Array.isArray(input.requests) ? input.requests : [];
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const seen = new Map();
  const throttled = new Map();
  const records = [];
  let probes = 0;

  for (const request of requests) {
    const candidate = request && request.candidate && typeof request.candidate === 'object'
      ? request.candidate
      : {};
    const fingerprint = text(candidate.fingerprint);
    const adapter = adapterForCandidate(candidate);

    const earlier = fingerprint ? seen.get(fingerprint) : null;
    if (earlier) {
      records.push(Object.freeze({ ...earlier, deduplicated: true }));
      continue;
    }

    const hold = adapter ? throttled.get(adapter.id) : null;
    if (hold) {
      const held = record({
        now, candidate, adapter, authorizationId: null,
        state: VERIFICATION_STATES.UNVERIFIABLE, reason: hold.reason, retryAfterMs: hold.retryAfterMs
      });
      if (fingerprint) seen.set(fingerprint, held);
      records.push(held);
      continue;
    }

    /*
     * The ceiling applies only to candidates that would actually ask. A class
     * with no adapter is answered without a request, so counting it would make
     * a repository full of private keys exhaust a budget it never spent.
     */
    if (adapter && probes >= MAX_PROBES_PER_RUN) {
      const refused = record({
        now, candidate, adapter, authorizationId: null,
        state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.RUN_LIMIT_REACHED
      });
      if (fingerprint) seen.set(fingerprint, refused);
      records.push(refused);
      continue;
    }

    const { record: attempt, probed } = await verifyOne({
      candidate,
      authorization: request && request.authorization,
      authorizationKey: input.authorizationKey,
      subjectKey: input.subjectKey,
      actorLogin: input.actorLogin,
      transport: input.transport,
      now
    });
    if (probed) probes += 1;
    if (attempt.reason === REASONS.PROVIDER_THROTTLED && adapter) {
      throttled.set(adapter.id, { reason: attempt.reason, retryAfterMs: attempt.retryAfterMs });
    }
    if (fingerprint) seen.set(fingerprint, attempt);
    records.push(attempt);
  }

  return Object.freeze(records);
}

module.exports = Object.freeze({
  ADAPTERS,
  DEFAULT_TRANSPORT: guardedFetch,
  MAX_AUTHORIZATION_LIFETIME_MS,
  MAX_PROBES_PER_RUN,
  MAX_RETRY_AFTER_MS,
  PROBE_MAX_RESPONSE_BYTES,
  REASONS,
  VERIFICATION_FRESHNESS_MS,
  VERIFICATION_STATES,
  adapterForCandidate,
  signVerificationAuthorization,
  verificationFreshness,
  verifyCandidates,
  verifyCredential
});
