/*
 * What a credential verification can conclude, and how long a conclusion
 * holds. The verifier produces these; narration and the store read them, so
 * they are the domain's words rather than the client's.
 */

type Fields = Readonly<Record<string, unknown>>;

/* A field of something that may not be an object, read as plain JavaScript would. */
function read(value: unknown, key: string): unknown {
  return value == null ? undefined : (value as Fields)[key];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const VERIFICATION_STATES = Object.freeze({
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  UNVERIFIABLE: 'unverifiable'
} as const);
export type VerificationState = (typeof VERIFICATION_STATES)[keyof typeof VERIFICATION_STATES];

/*
 * A closed vocabulary. A reason ends up on a stored finding and in front of a
 * reader, so the set has to be small enough to write help text for and stable
 * enough that a stored record still means what it meant. Its own test asserts
 * every entry here is reachable.
 */
export const REASONS = Object.freeze({
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
} as const);
export type VerificationReason = (typeof REASONS)[keyof typeof REASONS];

/* One observation is good for a day. Past that the answer is unknown again --
   not rejected, which is the distinction `verificationFreshness` exists to
   keep. */
export const VERIFICATION_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/*
 * An observation ages out; a verdict does not change by itself. A `verified`
 * record whose deadline has passed still records a credential that was seen
 * live -- what is no longer known is whether it still is, which is what
 * re-verification is for. Letting staleness read as `rejected` would resolve
 * findings by waiting.
 */
export function verificationFreshness(attempt: unknown, now: number): 'fresh' | 'stale' {
  const deadline = Date.parse(text(attempt && read(attempt, 'freshnessDeadline')));
  if (!Number.isFinite(deadline)) return 'stale';
  return now < deadline ? 'fresh' : 'stale';
}
