/*
 * Signed snapshots: a snapshot's HMAC under the active key, named by its key
 * id so a rotation leaves earlier signatures verifiable under the retired
 * keyring; and the pre-keyring form, a bare digest, verified only under the
 * legacy keys an operator supplies (or, in local development, the session
 * secret).
 */
import crypto from 'node:crypto';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import { iterable, read } from '../../../platform/values/fields.ts';
import { hmacJson } from '../../../platform/values/stable-hash.ts';

export const SIGNATURE_PREFIX = 'nvx-snapshot-hmac-v1';
const KEY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/;
const SIGNATURE_PATTERN = new RegExp(
  `^${SIGNATURE_PREFIX}:(${KEY_ID_PATTERN.source.slice(1, -1)}):([0-9a-f]{64})$`
);
const MAX_KEYRING_BYTES = 64 * 1024;
const MAX_RETIRED_KEYS = 16;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKeyId(value: unknown, label: string): string {
  const keyId = String(value || '').trim();
  if (!KEY_ID_PATTERN.test(keyId) || keyId.includes(':')) {
    throw new TypeError(`${label} is invalid`);
  }
  return keyId;
}

function assertSecret(value: unknown, label: string, minimumBytes = 32): string {
  const secret = String(value || '');
  const size = Buffer.byteLength(secret, 'utf8');
  if (size < minimumBytes || size > 4096) {
    throw new TypeError(`${label} must contain ${minimumBytes} to 4096 UTF-8 bytes`);
  }
  return secret;
}

function parseJson(raw: unknown, label: string): unknown {
  const source = String(raw || '').trim();
  if (!source) return null;
  if (Buffer.byteLength(source, 'utf8') > MAX_KEYRING_BYTES) {
    throw new TypeError(`${label} exceeds the safe size limit`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
}

function parseRetiredKeys(raw: unknown): Record<string, string> {
  const parsed = parseJson(raw, 'Retired snapshot keyring');
  if (parsed === null) return {};
  if (!isPlainObject(parsed) || Object.keys(parsed).length > MAX_RETIRED_KEYS) {
    throw new TypeError('Retired snapshot keyring must be an object with at most 16 keys');
  }
  const keys: Record<string, string> = {};
  for (const [rawKeyId, rawSecret] of Object.entries(parsed)) {
    const keyId = assertKeyId(rawKeyId, 'Retired snapshot key ID');
    keys[keyId] = assertSecret(rawSecret, `Retired snapshot key ${keyId}`);
  }
  return keys;
}

function parseLegacyKeys(raw: unknown): string[] {
  const parsed = parseJson(raw, 'Legacy snapshot keyring');
  if (parsed === null) return [];
  if (!Array.isArray(parsed) || parsed.length > MAX_RETIRED_KEYS) {
    throw new TypeError('Legacy snapshot keyring must be an array with at most 16 keys');
  }
  return parsed.map((secret, index) => assertSecret(secret, `Legacy snapshot key ${index + 1}`));
}

export interface SnapshotSigningConfig {
  readonly activeKeyId: string;
  readonly activeSecret: string;
  readonly retiredKeys: Readonly<Record<string, string>>;
  readonly legacyKeys: readonly string[];
}

/* The process environment, or a fixture of it. Each variable is read by its literal name, so the configuration registry sees every one. */
type Environment = Readonly<Record<string, string | undefined>>;

export function loadSnapshotSigningConfig(env: Environment = process.env, options: { readonly production?: unknown; readonly sessionSecret?: unknown } = {}): SnapshotSigningConfig {
  const production = options.production === true;
  const sessionSecret = String(options.sessionSecret || '');
  let activeKeyId = String(env.NV_SNAPSHOT_SIGNING_KEY_ID || '').trim();
  let activeSecret = String(env.NV_SNAPSHOT_SIGNING_SECRET || '');
  if (!activeKeyId && !activeSecret && !production) {
    activeKeyId = 'local-development';
    activeSecret = sessionSecret || 'dev-snapshot-signing-key';
  }
  if (!activeKeyId || !activeSecret) {
    const message = production
      ? 'Production requires a dedicated snapshot signing key ID and secret: set NV_SNAPSHOT_SIGNING_KEY_ID and NV_SNAPSHOT_SIGNING_SECRET'
      : 'Snapshot signing configuration requires both a dedicated key ID and signing secret: set NV_SNAPSHOT_SIGNING_KEY_ID and NV_SNAPSHOT_SIGNING_SECRET together';
    throw new TypeError(message);
  }
  /* Named by the variables that hold them, so a deployment refused for one is told which to fix. */
  activeKeyId = assertKeyId(activeKeyId, 'NV_SNAPSHOT_SIGNING_KEY_ID');
  activeSecret = assertSecret(activeSecret, 'NV_SNAPSHOT_SIGNING_SECRET', production ? 32 : 16);
  if (production && sessionSecret && activeSecret === sessionSecret) {
    throw new TypeError('NV_SNAPSHOT_SIGNING_SECRET must differ from SESSION_SECRET');
  }

  const retiredKeys = parseRetiredKeys(env.NV_SNAPSHOT_RETIRED_KEYS_JSON);
  if (Object.hasOwn(retiredKeys, activeKeyId)) {
    throw new TypeError('The active snapshot key ID must not appear in the retired keyring');
  }
  const legacyKeys = parseLegacyKeys(env.NV_SNAPSHOT_LEGACY_KEYS_JSON);
  // Local development retains the pre-keyring compatibility path. Production
  // accepts legacy snapshot keys only from the explicit operator keyring.
  if (!production && sessionSecret) legacyKeys.push(sessionSecret);

  return Object.freeze({
    activeKeyId,
    activeSecret,
    retiredKeys: Object.freeze({ ...retiredKeys }),
    legacyKeys: Object.freeze([...new Set(legacyKeys)])
  });
}

function sameHex(left: unknown, right: unknown): boolean {
  if (!isSha256Hex(String(left || '')) || !isSha256Hex(String(right || ''))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(String(left), 'hex'), Buffer.from(String(right), 'hex'));
}

export interface SnapshotVerification {
  readonly valid: boolean;
  readonly keyId: string | null;
  readonly legacy: boolean;
}
export interface SnapshotSignatures {
  readonly activeKeyId: unknown;
  sign(snapshotId: unknown, snapshot: unknown): string;
  verify(signature: unknown, snapshotId: unknown, snapshot: unknown): SnapshotVerification;
}

export function createSnapshotSignatures(config: unknown): SnapshotSignatures {
  const activeKeyId = read(config, 'activeKeyId');
  const activeSecret = read(config, 'activeSecret');
  if (!config || !activeKeyId || !activeSecret) {
    throw new TypeError('Snapshot signing configuration is invalid');
  }
  const retired: unknown = read(config, 'retiredKeys');
  const keys = new Map<unknown, unknown>([
    [activeKeyId, activeSecret],
    ...Object.entries(Object(retired || {}))
  ]);
  const legacy = read(config, 'legacyKeys');
  const legacyKeys: unknown[] = [...iterable(legacy || [], '(config.legacyKeys || [])')];

  function sign(snapshotId: unknown, snapshot: unknown): string {
    const digest = hmacJson(activeSecret, { snapshotId, snapshot });
    return `${SIGNATURE_PREFIX}:${String(activeKeyId)}:${digest}`;
  }

  function verify(signature: unknown, snapshotId: unknown, snapshot: unknown): SnapshotVerification {
    const supplied = String(signature || '');
    const match = SIGNATURE_PATTERN.exec(supplied);
    if (match) {
      const [, keyId = '', digest] = match;
      const secret = keys.get(keyId);
      const valid = !!secret && sameHex(digest, hmacJson(secret, { snapshotId, snapshot }));
      return Object.freeze({ valid, keyId, legacy: false });
    }
    if (isSha256Hex(supplied)) {
      const valid = legacyKeys.some(secret => sameHex(
        supplied,
        hmacJson(secret, { snapshotId, snapshot })
      ));
      return Object.freeze({ valid, keyId: 'legacy', legacy: true });
    }
    return Object.freeze({ valid: false, keyId: null, legacy: false });
  }

  return Object.freeze({ activeKeyId, sign, verify });
}
