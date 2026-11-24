import { PROFILES } from '../../../platform/network/guarded-fetch.ts';
import { REASONS, VERIFICATION_STATES, type VerificationReason, type VerificationState } from '../domain/verification-outcomes.ts';
import { property, trimmedText } from '../../../platform/values/fields.ts';

/*
 * How each provider is asked whether a discovered credential still works,
 * and how its answer is read.
 *
 * One adapter per rule a provider can answer for: the request its identity
 * endpoint documents, and an interpretation that turns the status and body
 * into a verdict -- live, refused, or unknown -- without ever guessing. A
 * provider that cannot be asked without side effects has no adapter.
 * credential-verification.ts decides whether a probe may run and records what
 * it found; this is what the probe says and hears.
 */

/* An identity response is a few hundred bytes. A generous ceiling on it is
   still two orders of magnitude below the transport's, and a provider that
   answers this endpoint with a megabyte is not answering this endpoint. */
export const PROBE_MAX_RESPONSE_BYTES = 16 * 1024;

/* Whatever a provider says about when to come back, we come back no sooner
   than a second and no later than an hour. A Retry-After is their opinion, not
   a scheduler. */
const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export const USER_AGENT = 'Nebulaverse-X-Exposure-Verifier/1.0';

export type Fields = Readonly<Record<string, unknown>>;

function parseJsonObject(body: unknown, maxBytes = PROBE_MAX_RESPONSE_BYTES): Fields | null {
  if (typeof body !== 'string' || body.length > maxBytes) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { return null; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Fields : null;
}

function parseJson(body: unknown, maxBytes: number): unknown {
  if (typeof body !== 'string' || body.length > maxBytes) return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return value;
  } catch { return undefined; }
}

/*
 * Seconds, per RFC 9110, clamped at both ends. The HTTP-date form is accepted
 * too because providers send it, but a date is read as a duration from now
 * rather than trusted as an absolute instant -- their clock is not ours.
 */
function retryAfterMs(headers: unknown, now: number): number | null {
  const raw = trimmedText(headers && (property(headers, 'retry-after') || property(headers, 'Retry-After')));
  if (!raw) return null;
  let ms: number | null = null;
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
  else {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
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

/* A provider's answer, reduced to what an interpretation may read. */
export interface ProbeAnswer {
  readonly statusCode: number;
  readonly body: unknown;
  readonly headers: unknown;
}

/* What an answer means: a state, the reason for it, and what it identified. */
export interface Verdict {
  readonly state: VerificationState;
  readonly reason: VerificationReason;
  readonly subject?: string;
  readonly retryAfterMs?: number | null;
}

export type Interpretation = (response: ProbeAnswer, now: number) => Verdict;

function githubInterpretation(response: ProbeAnswer, now: number): Verdict {
  const { statusCode } = response;
  if (statusCode === 200) {
    const body = parseJsonObject(response.body);
    const login = body && trimmedText(body.login);
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
    const refusal = parseJsonObject(response.body);
    const message = trimmedText(refusal && refusal.message).toLowerCase();
    const throttled = /rate limit|secondary rate|abuse detection|too many requests/.test(message);
    return {
      state: VERIFICATION_STATES.UNVERIFIABLE,
      reason: throttled ? REASONS.PROVIDER_THROTTLED : REASONS.PROVIDER_POLICY_RESTRICTED,
      retryAfterMs: throttled ? retryAfterMs(response.headers, now) : null
    };
  }
  return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_STATUS };
}

function gitlabInterpretation(response: ProbeAnswer, now: number): Verdict {
  const { statusCode } = response;
  if (statusCode === 200) {
    const body = parseJsonObject(response.body);
    const username = body && trimmedText(body.username);
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
const SLACK_DEFINITE_REFUSALS: readonly string[] = Object.freeze([
  'token_revoked', 'token_expired', 'account_inactive', 'invalid_token', 'user_removed_from_team'
]);
const SLACK_AMBIGUOUS: readonly string[] = Object.freeze(['invalid_auth', 'not_authed']);
const SLACK_POLICY: readonly string[] = Object.freeze(['ekm_access_denied', 'no_permission', 'org_login_required', 'enterprise_is_restricted']);
const SLACK_THROTTLED: readonly string[] = Object.freeze(['ratelimited', 'rate_limited']);

function slackInterpretation(response: ProbeAnswer, now: number): Verdict {
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
    const userId = trimmedText(body.user_id);
    const teamId = trimmedText(body.team_id);
    if (!userId || !teamId) {
      return { state: VERIFICATION_STATES.UNVERIFIABLE, reason: REASONS.MALFORMED_IDENTITY_RESPONSE };
    }
    return {
      state: VERIFICATION_STATES.VERIFIED,
      reason: REASONS.IDENTITY_CONFIRMED,
      subject: `${teamId}:${userId}`
    };
  }

  const error = trimmedText(body.error).toLowerCase();
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
interface InterpretationOptions {
  readonly maxResponseBytes?: number;
  readonly refusedStatuses?: readonly number[];
  readonly ambiguousStatuses?: readonly number[];
  readonly refusedWhen?: (body: unknown, status: number) => unknown;
  readonly policyWhen?: (body: unknown, status: number) => unknown;
  readonly subject?: (body: unknown) => unknown;
}

function identityInterpretation(options: InterpretationOptions = {}): Interpretation {
  const maxBytes = options.maxResponseBytes || PROBE_MAX_RESPONSE_BYTES;
  const refused = options.refusedStatuses || [401];
  const ambiguous = options.ambiguousStatuses || [];
  return function interpret(response: ProbeAnswer, now: number): Verdict {
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

const field = (...keys: string[]) => (body: unknown): string => {
  let value = body;
  for (const key of keys) value = value && typeof value === 'object' ? property(value, key) : undefined;
  return (typeof value === 'string' && value.trim()) || (Number.isInteger(value) ? String(value) : '');
};
const bearer = (secret: string): Readonly<Record<string, string>> => ({ authorization: `Bearer ${secret}` });
const LIST_RESPONSE_BYTES = 128 * 1024;

/* How one provider is asked whether a credential it issued is live. */
export interface Adapter {
  readonly id: string;
  readonly version: number;
  readonly rule: string;
  readonly supports: RegExp;
  readonly profile: string;
  readonly origin: string;
  readonly probePath: string;
  readonly targetId: string;
  readonly method: string;
  readonly body: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly credential?: (secret: string) => Readonly<Record<string, string>>;
  readonly maxResponseBytes?: number;
  readonly interpret: Interpretation;
}

type AdapterSpec = Pick<Adapter, 'id' | 'rule' | 'supports' | 'origin' | 'probePath' | 'targetId' | 'interpret'>
  & Partial<Pick<Adapter, 'method' | 'body' | 'credential' | 'maxResponseBytes' | 'headers'>>;

function adapter(spec: AdapterSpec): Adapter {
  return Object.freeze({
    version: 1,
    profile: PROFILES.CREDENTIAL_VERIFY,
    method: 'GET',
    body: null,
    credential: bearer,
    maxResponseBytes: PROBE_MAX_RESPONSE_BYTES,
    ...spec,
    headers: Object.freeze({ accept: 'application/json', ...(spec.headers || {}) })
  });
}

const PROVIDER_ADAPTERS: readonly Adapter[] = [
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
      refusedWhen: body => body && property(body, 'valid') === false
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

export const ADAPTERS: Readonly<Record<string, Adapter>> = Object.freeze({
  'github-user-token': Object.freeze<Adapter>({
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
  'gitlab-user-token': Object.freeze<Adapter>({
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
  'slack-user-token': Object.freeze<Adapter>({
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

const ADAPTER_BY_RULE: Readonly<Record<string, Adapter>> = Object.freeze(Object.fromEntries(
  Object.values(ADAPTERS).map(adapter => [adapter.rule, adapter])
));

/* The adapter a rule names. Only a rule this module lists: an inherited key is not an adapter. */
export function adapterForRule(rule: string): Adapter | null {
  return (Object.hasOwn(ADAPTER_BY_RULE, rule) && ADAPTER_BY_RULE[rule]) || null;
}

/*
 * The rule finds an access key ID, which is a name, not a credential: signing
 * needs the secret access key as well and a session token for a temporary
 * one. Pairing the ID with a nearby-looking string would be guessing at
 * someone's account with their own data, so this class is recorded as
 * incomplete and never sent anywhere.
 */
export const INCOMPLETE_RULES: readonly string[] = Object.freeze(['aws-access-key']);

export function adapterForCandidate(candidate: unknown): Adapter | null {
  const rule = trimmedText(candidate && property(candidate, 'rule'));
  const adapter = adapterForRule(rule);
  if (!adapter) return null;
  const secret = trimmedText(property(candidate, 'secret'));
  return adapter.supports.test(secret) ? adapter : null;
}
