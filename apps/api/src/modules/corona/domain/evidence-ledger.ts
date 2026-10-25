/*
 * The evidence ledger's keys: how a record's hash is taken, which keys a
 * record may verify under, and how a failure is told apart from tampering.
 */
import crypto from 'node:crypto';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import { sha256Hmac } from '../../../platform/crypto/hmac.ts';
import { KEY_PURPOSES, deriveSecret } from '../../../platform/crypto/key-derivation.ts';
import { read } from '../../../platform/values/fields.ts';

/* The process environment, or a fixture of it. Each variable is read by its literal name, so the configuration registry sees every one. */
type Environment = Readonly<Record<string, string | undefined>>;

export function evidenceRecordHash(secret: unknown, previousHash: unknown, repoKey: unknown, kind: unknown, recordId: unknown, payloadHash: unknown): string {
  return sha256Hmac(secret)
    .update(`${String(previousHash)}|${String(repoKey)}|${String(kind)}|${String(recordId)}|${String(payloadHash)}`)
    .digest('hex');
}

/*
 * The evidence ledger is tamper-evident, so a record that fails to reproduce
 * its hash is reported as tampering. That makes the hashing key part of the
 * record's meaning: rotating it would make every record written under the old
 * key accuse itself, which is the one false alarm this feature must not raise.
 *
 * Verification therefore tries the active key first and then any retired key,
 * and reports which one matched. This is the same shape the snapshot signatures
 * already use for rotation, and it needs no stored key column: the record hash
 * is an HMAC, so a record only verifies under a key the operator holds, and a
 * forged record verifies under none of them.
 */
export const EVIDENCE_ACTIVE_KEY_ID = 'hkdf-v1';
export const EVIDENCE_LEGACY_KEY_ID = 'legacy-session-secret';

function sameHex(left: unknown, right: unknown): boolean {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/*
 * Whether the raw session secret may still verify pre-separation records.
 *
 * Accepting it forever would undo half the point of separating the keys: a
 * leaked SESSION_SECRET could forge evidence that verifies. Production
 * therefore requires an explicit opt-in, which is the rule snapshot signatures
 * already apply to their legacy keys; development keeps the compatibility path
 * so a local chain keeps verifying.
 */
export function acceptsLegacySessionKey(supplied: Environment | null | undefined): boolean {
  const env: Environment = supplied || {};
  if (String(env.NV_EVIDENCE_LEGACY_SESSION_KEY || '').trim() === 'true') return true;
  return env.NODE_ENV !== 'production';
}

/*
 * Prior SESSION_SECRET values, for verifying records written before a rotation.
 *
 * The evidence key is derived from SESSION_SECRET, so rotating that secret moves
 * the derived key and every record written under the old one stops reproducing
 * its hash. On a tamper-evident ledger that reads as tampering after nothing
 * worse than routine key hygiene, which is the same failure the retired key
 * already prevents for the pre-separation records.
 *
 * Operators therefore supply the previous secrets, bounded, and the caller
 * derives an evidence key from each. This mirrors the snapshot retired keyring.
 */
const MAX_RETIRED_SESSION_SECRETS = 8;
const MIN_SESSION_SECRET_BYTES = 32;
const MAX_SESSION_SECRET_BYTES = 4096;

export function parseRetiredSessionSecrets(raw: unknown): readonly string[] {
  const source = String(raw == null ? '' : raw).trim();
  if (!source) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError('Retired evidence session secrets must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RETIRED_SESSION_SECRETS) {
    throw new TypeError(`Retired evidence session secrets must be an array of at most ${MAX_RETIRED_SESSION_SECRETS} values`);
  }
  const secrets: string[] = [];
  for (const value of parsed) {
    if (typeof value !== 'string') throw new TypeError('Each retired evidence session secret must be a string');
    const size = Buffer.byteLength(value, 'utf8');
    if (size < MIN_SESSION_SECRET_BYTES || size > MAX_SESSION_SECRET_BYTES) {
      throw new TypeError(`Each retired evidence session secret must contain ${MIN_SESSION_SECRET_BYTES} to ${MAX_SESSION_SECRET_BYTES} UTF-8 bytes`);
    }
    if (!secrets.includes(value)) secrets.push(value);
  }
  return Object.freeze(secrets);
}

/*
 * The two keyrings evidence verification needs, built from one description of
 * the operator's key history so they cannot disagree.
 *
 * `keyring` decides what verifies. `legacyProbe` only explains a failure: when a
 * record does not verify, it answers "was this written before the ledger key was
 * separated from SESSION_SECRET?" so the caller can report an unmigrated chain
 * rather than tampering.
 *
 * Their retired lists differ deliberately, and the difference is the point:
 *
 *   - `keyring.retired` always carries each supplied prior secret's *derived*
 *     evidence key, because a rotation is routine key hygiene and must not cost
 *     the ledger its history. It carries the *raw* secrets only on the explicit
 *     pre-separation opt-in, since accepting those forever would leave a leaked
 *     SESSION_SECRET able to forge evidence that verifies.
 *
 *   - `legacyProbe.retired` always carries the raw secrets, opt-in or not.
 *     Diagnosis is not acceptance: the probe never widens what verifies, and an
 *     operator who declines the opt-in still has to be able to tell an
 *     unmigrated chain from a forged one.
 *
 * Assembling both here is what keeps that true. Held as two separate lists at
 * the call site they drifted, and a record signed with a retired raw secret was
 * reported as tampering with no indication that migration was what it needed.
 */
export interface Keyring {
  readonly active: unknown;
  readonly retired: readonly unknown[];
}
export interface EvidenceKeyrings {
  readonly legacyAccepted: boolean;
  readonly keyring: Keyring;
  readonly legacyProbe: Keyring;
}
export function evidenceKeyrings(supplied: Environment | null | undefined, { sessionSecret, ledgerSecret }: { readonly sessionSecret?: unknown; readonly ledgerSecret?: unknown } = {}): EvidenceKeyrings {
  const env: Environment = supplied || {};
  const legacyAccepted = acceptsLegacySessionKey(env);
  const retiredSessionSecrets = parseRetiredSessionSecrets(env.NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON);
  return Object.freeze({
    legacyAccepted,
    keyring: Object.freeze({
      active: ledgerSecret,
      retired: Object.freeze([
        ...retiredSessionSecrets.map(secret => deriveSecret(secret, KEY_PURPOSES.EVIDENCE_LEDGER)),
        ...(legacyAccepted ? [sessionSecret, ...retiredSessionSecrets] : [])
      ])
    }),
    legacyProbe: Object.freeze({
      active: sessionSecret,
      retired: Object.freeze([...retiredSessionSecrets])
    })
  });
}

export interface Verification {
  readonly valid: boolean;
  readonly keyId: string | null;
  readonly legacy: boolean;
}
/* Whether a record reproduces its hash under the keyring: the active key first, then each retired one, and which matched. */
export function verifyEvidenceRecord(keyring: unknown, recordHash: unknown, previousHash: unknown, repoKey: unknown, kind: unknown, recordId: unknown, payloadHash: unknown): Verification {
  const supplied = String(recordHash || '');
  const miss = Object.freeze({ valid: false, keyId: null, legacy: false });
  if (!isSha256Hex(supplied) || !keyring || typeof keyring !== 'object') return miss;
  const expected = (secret: string): string => evidenceRecordHash(secret, previousHash, repoKey, kind, recordId, payloadHash);
  const active = read(keyring, 'active');
  const activeKey = typeof active === 'string' ? active : '';
  if (activeKey && sameHex(supplied, expected(activeKey))) {
    return Object.freeze({ valid: true, keyId: EVIDENCE_ACTIVE_KEY_ID, legacy: false });
  }
  const retired = read(keyring, 'retired');
  for (const secret of Array.isArray(retired) ? retired : []) {
    if (typeof secret === 'string' && secret && sameHex(supplied, expected(secret))) {
      return Object.freeze({ valid: true, keyId: EVIDENCE_LEGACY_KEY_ID, legacy: true });
    }
  }
  return miss;
}
