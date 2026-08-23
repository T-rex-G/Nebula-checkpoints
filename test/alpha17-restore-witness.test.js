'use strict';

/*
 * The restore witness, end to end.
 *
 * The gap this closes is easy to state and easy to miss: the restore runner
 * signs its record with a key generated inside its own job and destroyed when
 * the job ends, so that HMAC cannot be verified anywhere else. Every other
 * check the gate makes on the restore proof is shape and cross-reference,
 * which a forger can satisfy. The first case below is that forgery, and it is
 * the reason the witness exists.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyQualification } = require('../src/public-alpha-qualification');
const registry = require('../config/public-alpha-capabilities.json');
const { SUBJECT, SOURCE, createPassFixture } = require('./helpers/public-alpha-pass-fixture');

const root = path.resolve(__dirname, '..');
const NOW = new Date('2026-07-29T20:00:00.000Z');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function optionsFor(fixture, override = {}) {
  return {
    expectedVersion: '5.3.0-alpha.17.0',
    expectedSubjectHash: SUBJECT,
    expectedSourceCommit: SOURCE,
    expectedLatestMigration: '015_alpha_privacy',
    now: NOW,
    registry,
    ...fixture.bindings,
    verifyArtifact: artifact => structuredClone(fixture.envelopes[artifact.id]),
    ...override
  };
}

/*
 * A restore record whose digests are invented, then re-hashed and
 * cross-referenced so that every structural check still agrees with it.
 * Nothing short of the witness distinguishes this from a real one.
 */
{
  const fixture = createPassFixture();
  const attestation = fixture.envelopes['hosted-artifact'].restoreRunnerAttestation;
  attestation.record.check.restoreEvidenceSha256 = 'c'.repeat(64);
  attestation.record.check.backupCiphertextSha256 = 'd'.repeat(64);
  fixture.envelopes['hosted-artifact'].checks['isolated-database-restore'] = attestation.record.check;
  attestation.recordSha256 = crypto.createHash('sha256')
    .update(stableJson(attestation.record), 'utf8').digest('hex');
  assert.throws(
    () => verifyQualification(fixture.record, optionsFor(fixture)),
    error => error && error.code === 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH',
    'a restore record nobody witnessed must not qualify a release'
  );
}

/* A run that supplies no witness at all cannot reach a verdict. */
{
  const fixture = createPassFixture();
  assert.throws(
    () => verifyQualification(fixture.record, optionsFor(fixture, { restoreWitness: undefined })),
    error => error && error.code === 'PUBLIC_ALPHA_OPTIONS_INVALID',
    'the gate must refuse to run without an operator restore witness'
  );
}

/*
 * The signing script is the operator's whole interface to this, so it is
 * tested as they use it: run the command, feed the output to the gate.
 */
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-restore-witness-'));
try {
  const fixture = createPassFixture();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const evidencePath = path.join(temporaryRoot, 'hosted-evidence.json');
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(fixture.envelopes['hosted-artifact'], null, 2)}\n`,
    { mode: 0o600 }
  );
  const signingEnv = {
    ...process.env,
    NV_ALPHA17_OPERATOR_KEY_ID: 'offline-operator',
    NV_ALPHA17_OPERATOR_PRIVATE_KEY_BASE64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  };
  const witness = JSON.parse(execFileSync(
    process.execPath,
    ['scripts/sign-restore-witness.js', evidencePath],
    { cwd: root, env: signingEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ));

  assert.strictEqual(witness.artifactType, 'hosted-restore-witness');
  assert.strictEqual(
    witness.restoreRecordSha256,
    fixture.envelopes['hosted-artifact'].restoreRunnerAttestation.recordSha256,
    'the witness must cover the restore record in the evidence it was given'
  );
  assert(!Object.hasOwn(witness, 'check'), 'the witness must not restate the runner\'s claims as its own');

  const trustedOperatorKeys = {
    ...fixture.bindings.trustedOperatorKeys,
    'offline-operator': publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  };
  verifyQualification(fixture.record, optionsFor(fixture, {
    trustedOperatorKeys,
    restoreWitness: witness
  }));

  /* The same witness must not carry over to a run it did not see. */
  const other = createPassFixture();
  other.envelopes['hosted-artifact'].restoreRunnerAttestation.recordSha256 = 'e'.repeat(64);
  assert.throws(
    () => verifyQualification(other.record, optionsFor(other, {
      trustedOperatorKeys,
      restoreWitness: witness
    })),
    error => error && error.code === 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH',
    'a witness must not vouch for a restore record it does not cover'
  );

  /* The script must refuse to put the operator's key behind malformed evidence. */
  const brokenPath = path.join(temporaryRoot, 'broken-evidence.json');
  fs.writeFileSync(brokenPath, `${JSON.stringify({ schemaVersion: '1.1.0' }, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/sign-restore-witness.js', brokenPath], {
      cwd: root, env: signingEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }),
    'signing must refuse evidence that does not validate'
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('alpha17 restore witness tests passed');
