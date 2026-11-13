import { createHmac, timingSafeEqual } from 'node:crypto';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import { guardedFetch, type GuardedFetchInput } from '../../../platform/network/guarded-fetch.ts';
import {
  REASONS, VERIFICATION_FRESHNESS_MS, VERIFICATION_STATES, verificationFreshness, type VerificationReason,
  type VerificationState
} from '../domain/verification-outcomes.ts';
import { fieldsOf, listOf, property, trimmedText } from '../../../platform/values/fields.ts';
import {
  INCOMPLETE_RULES, adapterForRule, adapterForCandidate, USER_AGENT, PROBE_MAX_RESPONSE_BYTES, type Adapter,
  type Fields
} from './verification-adapters.ts';
export { PROBE_MAX_RESPONSE_BYTES, MAX_RETRY_AFTER_MS, ADAPTERS, adapterForCandidate } from './verification-adapters.ts';
export type { ProbeAnswer, Verdict, Interpretation, Adapter } from './verification-adapters.ts';

export { REASONS, VERIFICATION_FRESHNESS_MS, VERIFICATION_STATES, verificationFreshness };
export type { VerificationReason, VerificationState };

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


/* An authorization is minutes, not hours. It is consent to one probe against
   one target, and a grant that outlives the screen it was given on is a grant
   nobody is watching. */
export const MAX_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;

/* One free web service, and every probe is a request someone else counts
   against us. A run asks at most this many times however many candidates a
   repository holds. */
export const MAX_PROBES_PER_RUN = 50;
const SUBJECT_DIGEST_CHARS = 32;

/* ---- Authorization ----------------------------------------------------- */

/*
 * Length-prefixed parts, so no rearrangement of one grant's fields can produce
 * another's message: an owner named `Demo` in a repository named `Acme` must
 * not sign the same bytes as the reverse.
 */
function authorizationMessage(grant: unknown): string {
  const scope = property(grant, 'scope');
  const parts = [
    'nvexpauth.v1',
    'verify-credential',
    trimmedText(property(grant, 'authorizationId')),
    trimmedText(property(grant, 'actorLogin')),
    trimmedText(scope && property(scope, 'provider')),
    trimmedText(scope && property(scope, 'authority')),
    trimmedText(scope && property(scope, 'owner')),
    trimmedText(scope && property(scope, 'repo')),
    trimmedText(property(grant, 'commit')),
    trimmedText(property(grant, 'candidateFingerprint')),
    trimmedText(property(grant, 'adapter')),
    trimmedText(property(grant, 'targetId')),
    trimmedText(property(grant, 'issuedAt')),
    trimmedText(property(grant, 'expiresAt'))
  ];
  return parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

export interface AuthorizationInput {
  readonly hmacKey?: unknown;
  readonly authorizationId?: unknown;
  readonly actorLogin?: unknown;
  readonly scope?: unknown;
  readonly commit?: unknown;
  readonly candidateFingerprint?: unknown;
  readonly adapter?: unknown;
  readonly targetId?: unknown;
  readonly issuedAt?: unknown;
  readonly expiresAt?: unknown;
}

/* A grant to probe one candidate at one target, bound to everything that names it. */
export interface VerificationAuthorization {
  readonly authorizationId: string;
  readonly actorLogin: string;
  readonly scope: { readonly provider: string; readonly authority: string; readonly owner: string; readonly repo: string };
  readonly commit: string;
  readonly candidateFingerprint: string;
  readonly adapter: string;
  readonly targetId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export function signVerificationAuthorization(input: AuthorizationInput = {}): VerificationAuthorization {
  const hmacKey = input.hmacKey;
  if (!Buffer.isBuffer(hmacKey) && typeof hmacKey !== 'string') {
    throw new TypeError('A verification authorization requires a derived HMAC key');
  }
  const scope = input.scope;
  const grant = {
    authorizationId: trimmedText(input.authorizationId),
    actorLogin: trimmedText(input.actorLogin),
    scope: Object.freeze({
      provider: trimmedText(scope && property(scope, 'provider')),
      authority: trimmedText(scope && property(scope, 'authority')),
      owner: trimmedText(scope && property(scope, 'owner')),
      repo: trimmedText(scope && property(scope, 'repo'))
    }),
    commit: trimmedText(input.commit),
    candidateFingerprint: trimmedText(input.candidateFingerprint),
    adapter: trimmedText(input.adapter),
    targetId: trimmedText(input.targetId),
    issuedAt: trimmedText(input.issuedAt),
    expiresAt: trimmedText(input.expiresAt)
  };
  const signature = createHmac('sha256', hmacKey)
    .update(authorizationMessage(grant), 'utf8')
    .digest('hex');
  return Object.freeze({ ...grant, signature });
}

/*
 * Returns a reason code, or null when the grant is good. Order matters: the
 * signature is checked before any field is read as meaningful, because an
 * unsigned grant's fields are just text a caller supplied.
 */
interface RefusalInput {
  readonly authorization: unknown;
  readonly hmacKey: Buffer | string;
  readonly adapter: Adapter;
  readonly candidate: Fields;
  readonly actorLogin: unknown;
  readonly now: number;
}

function authorizationRefusal({ authorization, hmacKey, adapter, candidate, actorLogin, now }: RefusalInput): VerificationReason | null {
  if (!authorization || typeof authorization !== 'object') return REASONS.AUTHORIZATION_MISSING;
  const signature = trimmedText(property(authorization, 'signature'));
  if (!signature && !trimmedText(property(authorization, 'authorizationId'))) return REASONS.AUTHORIZATION_MISSING;
  if (!isSha256Hex(signature)) return REASONS.AUTHORIZATION_INVALID;

  const expected = createHmac('sha256', hmacKey)
    .update(authorizationMessage(authorization), 'utf8')
    .digest();
  const presented = Buffer.from(signature, 'hex');
  if (presented.length !== expected.length) return REASONS.AUTHORIZATION_INVALID;
  if (!timingSafeEqual(presented, expected)) return REASONS.AUTHORIZATION_INVALID;

  const issuedAt = Date.parse(trimmedText(property(authorization, 'issuedAt')));
  const expiresAt = Date.parse(trimmedText(property(authorization, 'expiresAt')));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt <= issuedAt) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt - issuedAt > MAX_AUTHORIZATION_LIFETIME_MS) return REASONS.AUTHORIZATION_INVALID;
  if (issuedAt > now) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt <= now) return REASONS.AUTHORIZATION_EXPIRED;
  if (!trimmedText(property(authorization, 'actorLogin'))) return REASONS.AUTHORIZATION_INVALID;

  /*
   * Bound to this candidate in this repository at this commit, for this
   * adapter against this target. A grant for any other combination is a grant
   * for a different question.
   */
  const scope = fieldsOf(property(authorization, 'scope'));
  const asked = candidate.scope;
  const bound: [string, string][] = [
    [trimmedText(scope.provider), trimmedText(asked && property(asked, 'provider'))],
    [trimmedText(scope.authority), trimmedText(asked && property(asked, 'authority'))],
    [trimmedText(scope.owner), trimmedText(asked && property(asked, 'owner'))],
    [trimmedText(scope.repo), trimmedText(asked && property(asked, 'repo'))],
    [trimmedText(property(authorization, 'commit')), trimmedText(candidate.commit)],
    [trimmedText(property(authorization, 'candidateFingerprint')), trimmedText(candidate.fingerprint)],
    [trimmedText(property(authorization, 'adapter')), adapter.id],
    [trimmedText(property(authorization, 'targetId')), adapter.targetId]
  ];
  if (actorLogin != null) bound.push([trimmedText(property(authorization, 'actorLogin')), trimmedText(actorLogin)]);
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
function subjectDigestFor(subject: unknown, adapterId: string, subjectKey: unknown): string | null {
  if (!subject || (!Buffer.isBuffer(subjectKey) && typeof subjectKey !== 'string')) return null;
  return createHmac('sha256', subjectKey)
    .update(`${adapterId}|${String(subject)}`, 'utf8')
    .digest('hex')
    .slice(0, SUBJECT_DIGEST_CHARS);
}

/* One attempt, as it is recorded: never the credential, never the provider's answer. */
export interface VerificationRecord {
  readonly adapter: string | null;
  readonly adapterVersion: number | null;
  readonly authorizationId: string | null;
  readonly candidateFingerprint: string | null;
  readonly deduplicated: boolean;
  readonly freshnessDeadline: string;
  readonly observedAt: string;
  readonly reason: VerificationReason;
  readonly retryAfterMs: number | null;
  readonly state: VerificationState;
  readonly subjectDigest: string | null;
  readonly targetId: string | null;
}

interface RecordInput {
  readonly now: number;
  readonly candidate: Fields;
  readonly adapter: Adapter | null;
  readonly authorizationId?: string | null;
  readonly deduplicated?: boolean;
  readonly state: VerificationState;
  readonly reason: VerificationReason;
  readonly retryAfterMs?: number | null | undefined;
  readonly subjectDigest?: string | null;
}

function record(input: RecordInput): VerificationRecord {
  const observedAt = new Date(input.now).toISOString();
  return Object.freeze({
    adapter: input.adapter ? input.adapter.id : null,
    adapterVersion: input.adapter ? input.adapter.version : null,
    authorizationId: input.authorizationId || null,
    candidateFingerprint: trimmedText(input.candidate.fingerprint) || null,
    deduplicated: Boolean(input.deduplicated),
    freshnessDeadline: new Date(input.now + VERIFICATION_FRESHNESS_MS).toISOString(),
    observedAt,
    reason: input.reason,
    retryAfterMs: typeof input.retryAfterMs === 'number' && Number.isFinite(input.retryAfterMs) ? input.retryAfterMs : null,
    state: input.state,
    subjectDigest: input.subjectDigest || null,
    targetId: input.adapter ? input.adapter.targetId : null
  });
}

/*
 * The transport speaks codes; this file needs a reason. A transport error
 * message is never carried across, because it can quote the request it failed
 * to send and the request carries the credential.
 */
function transportRefusal(error: unknown): VerificationReason {
  const code = trimmedText(error && property(error, 'code'));
  if (code === 'GUARDED_FETCH_TIMEOUT' || code === 'GUARDED_FETCH_DEADLINE') return REASONS.TRANSPORT_TIMEOUT;
  if (code === 'GUARDED_FETCH_RESPONSE_TOO_LARGE') return REASONS.MALFORMED_IDENTITY_RESPONSE;
  return REASONS.TRANSPORT_REFUSED;
}

/* ---- Verification ------------------------------------------------------ */

/*
 * Returns `{ record, probed }`. `probed` is what a run counts against its
 * ceiling: a refusal that never reached the network cost nobody anything.
 */
/* What a probe is answered with; any of it may be missing. */
export interface VerifierResponse {
  readonly statusCode?: unknown;
  readonly body?: unknown;
  readonly headers?: unknown;
}

/* The guarded transport, or a stand-in with its shape. */
export type VerifierTransport = (input: GuardedFetchInput) => Promise<VerifierResponse | null | undefined>;

export interface VerifyInput {
  readonly now?: unknown;
  readonly candidate?: unknown;
  readonly authorization?: unknown;
  readonly authorizationKey?: unknown;
  readonly subjectKey?: unknown;
  readonly actorLogin?: unknown;
  readonly transport?: VerifierTransport | undefined;
}

async function verifyOne(input: VerifyInput): Promise<{ readonly probed: boolean; readonly record: VerificationRecord }> {
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const candidate = fieldsOf(input.candidate);
  const rule = trimmedText(candidate.rule);

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
  const known = adapterForRule(rule);
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

  const authorizationKey = input.authorizationKey;
  if (!Buffer.isBuffer(authorizationKey) && typeof authorizationKey !== 'string') {
    throw new TypeError('Credential verification requires a derived authorization key');
  }
  const refusal = authorizationRefusal({
    authorization: input.authorization,
    hmacKey: authorizationKey,
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
  const authorizationId = trimmedText(property(input.authorization, 'authorizationId'));

  /*
   * The URL is assembled from the adapter's own constants. A candidate can
   * name a rule and carry bytes; it can never contribute an origin, a path or
   * a query string, because a URL taken out of a repository is a URL an
   * attacker chose.
   */
  const transport: VerifierTransport = typeof input.transport === 'function' ? input.transport : guardedFetch;
  /* adapterForCandidate has checked the secret is a string. */
  const secret = String(candidate.secret);
  let response: VerifierResponse | null | undefined;
  try {
    /* The credential travels in a header, in the scheme its provider
       documents; a bearer token is the default and the common case. */
    const credential = typeof adapter.credential === 'function'
      ? adapter.credential(secret)
      : { authorization: `Bearer ${secret}` };
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

export async function verifyCredential(input: VerifyInput = {}): Promise<VerificationRecord> {
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
export interface VerifyCandidatesInput extends Omit<VerifyInput, 'candidate' | 'authorization'> {
  readonly requests?: unknown;
}

export async function verifyCandidates(input: VerifyCandidatesInput = {}): Promise<readonly VerificationRecord[]> {
  const requests = listOf(input.requests);
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const seen = new Map<string, VerificationRecord>();
  const throttled = new Map<string, { readonly reason: VerificationReason; readonly retryAfterMs: number | null }>();
  const records: VerificationRecord[] = [];
  let probes = 0;

  for (const request of requests) {
    const candidate = fieldsOf(request && property(request, 'candidate'));
    const fingerprint = trimmedText(candidate.fingerprint);
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
      authorization: request && property(request, 'authorization'),
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

export const DEFAULT_TRANSPORT = guardedFetch;
