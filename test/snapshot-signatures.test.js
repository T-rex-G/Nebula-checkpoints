'use strict';

const assert = require('assert');
const { hmacJson } = require('../src/intelligence');
const {
  createSnapshotSignatures,
  loadSnapshotSigningConfig
} = require('../src/snapshot-signatures');

const activeSecretA = ['snapshot-active-a', '0123456789abcdef', '0123456789abcdef'].join('-');
const activeSecretB = ['snapshot-active-b', '0123456789abcdef', '0123456789abcdef'].join('-');
const sessionSecret = ['session-only', '0123456789abcdef', '0123456789abcdef'].join('-');
const legacySessionSecret = ['legacy-session', '0123456789abcdef', '0123456789abcdef'].join('-');
const payload = {
  snapshotId: '11111111-1111-4111-8111-111111111111',
  snapshot: { kind: 'nebulaverse-snapshot', refs: [{ name: 'main', sha: 'a'.repeat(40) }] }
};

const configA = loadSnapshotSigningConfig({
  NV_SNAPSHOT_SIGNING_KEY_ID: 'snapshot-key-a',
  NV_SNAPSHOT_SIGNING_SECRET: activeSecretA
}, { production: true, sessionSecret });
const signerA = createSnapshotSignatures(configA);
const signatureA = signerA.sign(payload.snapshotId, payload.snapshot);
assert.strictEqual(
  signatureA,
  `nvx-snapshot-hmac-v1:snapshot-key-a:${hmacJson(activeSecretA, payload)}`
);
assert.deepStrictEqual(signerA.verify(signatureA, payload.snapshotId, payload.snapshot), {
  valid: true,
  keyId: 'snapshot-key-a',
  legacy: false
});

const configB = loadSnapshotSigningConfig({
  NV_SNAPSHOT_SIGNING_KEY_ID: 'snapshot-key-b',
  NV_SNAPSHOT_SIGNING_SECRET: activeSecretB,
  NV_SNAPSHOT_RETIRED_KEYS_JSON: JSON.stringify({ 'snapshot-key-a': activeSecretA }),
  NV_SNAPSHOT_LEGACY_KEYS_JSON: JSON.stringify([legacySessionSecret])
}, { production: true, sessionSecret });
const signerB = createSnapshotSignatures(configB);
const implicitSessionSignature = hmacJson(sessionSecret, payload);
assert.deepStrictEqual(signerB.verify(
  implicitSessionSignature,
  payload.snapshotId,
  payload.snapshot
), {
  valid: false,
  keyId: 'legacy',
  legacy: true
}, 'production must not implicitly trust SESSION_SECRET as a legacy snapshot key');
assert.deepStrictEqual(signerB.verify(signatureA, payload.snapshotId, payload.snapshot), {
  valid: true,
  keyId: 'snapshot-key-a',
  legacy: false
}, 'a retired key must verify retained snapshots after active-key rotation');

const signatureB = signerB.sign(payload.snapshotId, payload.snapshot);
assert.match(signatureB, /^nvx-snapshot-hmac-v1:snapshot-key-b:[0-9a-f]{64}$/);
assert.deepStrictEqual(signerA.verify(signatureB, payload.snapshotId, payload.snapshot), {
  valid: false,
  keyId: 'snapshot-key-b',
  legacy: false
});
assert.strictEqual(
  signerB.verify(signatureA, payload.snapshotId, { ...payload.snapshot, kind: 'tampered' }).valid,
  false
);

const legacySignature = hmacJson(legacySessionSecret, payload);
assert.deepStrictEqual(signerB.verify(legacySignature, payload.snapshotId, payload.snapshot), {
  valid: true,
  keyId: 'legacy',
  legacy: true
}, 'an explicitly retained legacy session key must verify old unversioned signatures');
assert.deepStrictEqual(signerB.verify('not-a-signature', payload.snapshotId, payload.snapshot), {
  valid: false,
  keyId: null,
  legacy: false
});

assert.throws(
  () => loadSnapshotSigningConfig({}, { production: true, sessionSecret }),
  /dedicated snapshot signing key/i
);
assert.throws(
  () => loadSnapshotSigningConfig({
    NV_SNAPSHOT_SIGNING_KEY_ID: 'snapshot-key-a'
  }, { production: false, sessionSecret }),
  /configuration requires both a dedicated key ID and signing secret/i,
  'partial local configuration must report the missing pair without claiming production mode'
);
assert.throws(
  () => loadSnapshotSigningConfig({
    NV_SNAPSHOT_SIGNING_KEY_ID: 'snapshot-key-a',
    NV_SNAPSHOT_SIGNING_SECRET: sessionSecret
  }, { production: true, sessionSecret }),
  /must differ from SESSION_SECRET/i
);
assert.throws(
  () => loadSnapshotSigningConfig({
    NV_SNAPSHOT_SIGNING_KEY_ID: 'snapshot-key-a',
    NV_SNAPSHOT_SIGNING_SECRET: activeSecretA,
    NV_SNAPSHOT_RETIRED_KEYS_JSON: '{not-json}'
  }, { production: true, sessionSecret }),
  /retired snapshot keyring must be valid JSON/i
);
assert.throws(
  () => loadSnapshotSigningConfig({
    NV_SNAPSHOT_SIGNING_KEY_ID: 'snapshot-key-a',
    NV_SNAPSHOT_SIGNING_SECRET: activeSecretA,
    NV_SNAPSHOT_LEGACY_KEYS_JSON: '{not-json}'
  }, { production: true, sessionSecret }),
  /legacy snapshot keyring must be valid JSON/i,
  'malformed legacy compatibility configuration must fail closed'
);
assert.throws(
  () => loadSnapshotSigningConfig({
    NV_SNAPSHOT_SIGNING_KEY_ID: 'snapshot-key-a',
    NV_SNAPSHOT_SIGNING_SECRET: activeSecretA,
    NV_SNAPSHOT_RETIRED_KEYS_JSON: JSON.stringify({ 'snapshot-key-a': activeSecretB })
  }, { production: true, sessionSecret }),
  /active snapshot key ID must not appear in the retired keyring/i
);

const localConfig = loadSnapshotSigningConfig({}, { production: false, sessionSecret });
assert.strictEqual(localConfig.activeKeyId, 'local-development');
assert.strictEqual(createSnapshotSignatures(localConfig).verify(
  createSnapshotSignatures(localConfig).sign(payload.snapshotId, payload.snapshot),
  payload.snapshotId,
  payload.snapshot
).valid, true);

console.log('snapshot signature tests passed');
