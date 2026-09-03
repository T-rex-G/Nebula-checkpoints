'use strict';

const crypto = require('crypto');
const { hmacJson } = require('./intelligence');

const SIGNATURE_PREFIX = 'nvx-snapshot-hmac-v1';
const KEY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/;
const SIGNATURE_PATTERN = new RegExp(
  `^${SIGNATURE_PREFIX}:(${KEY_ID_PATTERN.source.slice(1, -1)}):([0-9a-f]{64})$`
);
const MAX_KEYRING_BYTES = 64 * 1024;
const MAX_RETIRED_KEYS = 16;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKeyId(value, label) {
  const keyId = String(value || '').trim();
  if (!KEY_ID_PATTERN.test(keyId) || keyId.includes(':')) {
    throw new TypeError(`${label} is invalid`);
  }
  return keyId;
}

function assertSecret(value, label, minimumBytes = 32) {
  const secret = String(value || '');
  const size = Buffer.byteLength(secret, 'utf8');
  if (size < minimumBytes || size > 4096) {
    throw new TypeError(`${label} must contain ${minimumBytes} to 4096 UTF-8 bytes`);
  }
  return secret;
}

function parseJson(raw, label) {
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

function parseRetiredKeys(raw) {
  const parsed = parseJson(raw, 'Retired snapshot keyring');
  if (parsed === null) return {};
  if (!isPlainObject(parsed) || Object.keys(parsed).length > MAX_RETIRED_KEYS) {
    throw new TypeError('Retired snapshot keyring must be an object with at most 16 keys');
  }
  const keys = {};
  for (const [rawKeyId, rawSecret] of Object.entries(parsed)) {
    const keyId = assertKeyId(rawKeyId, 'Retired snapshot key ID');
    keys[keyId] = assertSecret(rawSecret, `Retired snapshot key ${keyId}`);
  }
  return keys;
}

function parseLegacyKeys(raw) {
  const parsed = parseJson(raw, 'Legacy snapshot keyring');
  if (parsed === null) return [];
  if (!Array.isArray(parsed) || parsed.length > MAX_RETIRED_KEYS) {
    throw new TypeError('Legacy snapshot keyring must be an array with at most 16 keys');
  }
  return parsed.map((secret, index) => assertSecret(secret, `Legacy snapshot key ${index + 1}`));
}

function loadSnapshotSigningConfig(env = process.env, options = {}) {
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
      ? 'Production requires a dedicated snapshot signing key ID and secret'
      : 'Snapshot signing configuration requires both a dedicated key ID and signing secret';
    throw new TypeError(message);
  }
  activeKeyId = assertKeyId(activeKeyId, 'Active snapshot key ID');
  activeSecret = assertSecret(activeSecret, 'Active snapshot signing secret', production ? 32 : 16);
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

function sameHex(left, right) {
  if (!/^[0-9a-f]{64}$/.test(String(left || '')) || !/^[0-9a-f]{64}$/.test(String(right || ''))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function createSnapshotSignatures(config) {
  if (!config || !config.activeKeyId || !config.activeSecret) {
    throw new TypeError('Snapshot signing configuration is invalid');
  }
  const keys = new Map([
    [config.activeKeyId, config.activeSecret],
    ...Object.entries(config.retiredKeys || {})
  ]);
  const legacyKeys = [...(config.legacyKeys || [])];

  function sign(snapshotId, snapshot) {
    const digest = hmacJson(config.activeSecret, { snapshotId, snapshot });
    return `${SIGNATURE_PREFIX}:${config.activeKeyId}:${digest}`;
  }

  function verify(signature, snapshotId, snapshot) {
    const supplied = String(signature || '');
    const match = SIGNATURE_PATTERN.exec(supplied);
    if (match) {
      const [, keyId, digest] = match;
      const secret = keys.get(keyId);
      const valid = !!secret && sameHex(digest, hmacJson(secret, { snapshotId, snapshot }));
      return Object.freeze({ valid, keyId, legacy: false });
    }
    if (/^[0-9a-f]{64}$/.test(supplied)) {
      const valid = legacyKeys.some(secret => sameHex(
        supplied,
        hmacJson(secret, { snapshotId, snapshot })
      ));
      return Object.freeze({ valid, keyId: 'legacy', legacy: true });
    }
    return Object.freeze({ valid: false, keyId: null, legacy: false });
  }

  return Object.freeze({ activeKeyId: config.activeKeyId, sign, verify });
}

module.exports = Object.freeze({
  SIGNATURE_PREFIX,
  loadSnapshotSigningConfig,
  createSnapshotSignatures
});
