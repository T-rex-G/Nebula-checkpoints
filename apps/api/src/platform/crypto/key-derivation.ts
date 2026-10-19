import { hkdfSync } from 'node:crypto';

/*
 * One configured SESSION_SECRET backed every keyed construction in the server.
 *
 * The raw secret signed CSRF tokens, step-up grants, GitHub App OAuth state,
 * the evidence-ledger hash chain and the session cookie. Its SHA-256 digest was
 * reused a second time as three different keys at once: the AES-256-GCM key
 * that seals the session cookie, the HMAC key for offline cache scopes, and the
 * HMAC key for GitHub App state replay detection. Using one key for a cipher
 * and for a MAC is the specific pairing key separation exists to prevent.
 *
 * Nothing was exploitable in the shipped code, because each construction has a
 * distinct message shape and the token codec tags its own `kind` inside the
 * signed payload. But that safety was an unwritten invariant, held only by
 * message formats that happen not to overlap, and enforced by nothing: the next
 * keyed construction added to this server would have inherited the same key
 * with no reason to notice.
 *
 * HKDF-SHA256 turns that invariant into structure. Each purpose derives its own
 * key from the same input secret through a distinct `info` label, so keys for
 * different purposes are independent and a value produced under one cannot be
 * verified under another, whatever the message shapes later become.
 *
 * The salt is a fixed application label rather than a random value. HKDF
 * tolerates a non-secret fixed salt when the input keying material is itself
 * high-entropy, which production enforces at 32 bytes minimum, and a stored
 * random salt would have to be distributed to every process that must derive
 * the same keys.
 */
export const HKDF_SALT = 'nebulaverse-x/hkdf/v1';
export const DERIVED_KEY_BYTES = 32;

export const KEY_PURPOSES = Object.freeze({
  SESSION_CONTENT: 'session-content-aes-256-gcm',
  OFFLINE_CACHE_SCOPE: 'offline-cache-scope-hmac',
  GITHUB_APP_STATE_REPLAY: 'github-app-state-replay-hmac',
  CSRF_TOKEN: 'csrf-token',
  STEP_UP_GRANT: 'step-up-grant',
  GITHUB_APP_STATE: 'github-app-state',
  EVIDENCE_LEDGER: 'evidence-ledger-hmac',
  GOVERNANCE_AUDIT: 'governance-audit',
  RATE_LIMIT_IDENTITY: 'rate-limit-identity-hmac',
  /*
   * A repository read permission is not permission to use what is inside
   * it. These two back the authorization a verification probe requires and
   * the digest of the identity it comes back with, and they are separate
   * from each other for the same reason every label here is: one is a MAC
   * over a grant this server issued, the other a MAC over a value a
   * provider told us, and a value produced under either must not verify
   * under the other.
   */
  EXPOSURE_VERIFICATION_AUTHORIZATION: 'exposure-verification-authorization-hmac',
  EXPOSURE_VERIFICATION_SUBJECT: 'exposure-verification-subject-hmac',
  /*
   * The finding fingerprint. Keyed rather than hashed because the thing
   * being fingerprinted is a credential: the population of a provider's
   * token format is small enough to enumerate offline, so an unkeyed
   * digest published on a finding is the credential for anyone willing to
   * spend the hardware.
   */
  EXPOSURE_FINDING_FINGERPRINT: 'exposure-finding-fingerprint-hmac',
  /*
   * The grant a readability probe requires. Separate from the credential
   * verification grant because it binds different things -- a project, a
   * relation and an exact column projection -- and a grant for one must
   * not verify as a grant for the other.
   */
  EXPOSURE_READABILITY_AUTHORIZATION: 'exposure-readability-authorization-hmac'
} as const);

export type KeyPurpose = (typeof KEY_PURPOSES)[keyof typeof KEY_PURPOSES];

const PURPOSE_LABELS: readonly string[] = Object.freeze(Object.values(KEY_PURPOSES));

function assertPurpose(purpose: unknown): KeyPurpose {
  if (typeof purpose !== 'string' || !PURPOSE_LABELS.includes(purpose)) {
    throw new TypeError(`Unknown key derivation purpose: ${String(purpose)}`);
  }
  return purpose as KeyPurpose;
}

function assertSecret(secret: unknown): string {
  const value = typeof secret === 'string' ? secret : '';
  if (!value) throw new TypeError('Key derivation requires a non-empty secret');
  return value;
}

/*
 * Returns raw bytes, for the primitives that take a key directly: createCipheriv
 * needs exactly 32 bytes, and createHmac accepts a Buffer without reinterpreting
 * it.
 */
export function deriveKey(secret: unknown, purpose: unknown, length: number = DERIVED_KEY_BYTES): Buffer {
  const input = assertSecret(secret);
  const label = assertPurpose(purpose);
  if (!Number.isInteger(length) || length < 16 || length > 64) {
    throw new TypeError('Derived key length must be between 16 and 64 bytes');
  }
  return Buffer.from(hkdfSync('sha256', input, HKDF_SALT, `nebulaverse-x/${label}`, length));
}

/*
 * Returns a textual key, for the token modules whose signing helpers coerce the
 * secret with String(). Passing raw bytes through that coercion would decode
 * them as UTF-8 and silently replace every invalid sequence, collapsing distinct
 * derived keys onto the same replacement-character string.
 */
export function deriveSecret(secret: unknown, purpose: unknown): string {
  return deriveKey(secret, purpose).toString('base64url');
}

