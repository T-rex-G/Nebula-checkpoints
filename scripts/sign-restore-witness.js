'use strict';

/*
 * Sign the operator's restore witness for one qualification run.
 *
 * The restore runner signs its record with a key it generates inside its own
 * job and destroys when the job ends. That HMAC is an integrity check within
 * the run; nothing downstream can verify it. So without a second signature the
 * restore proof is only as trustworthy as whoever produced the evidence file:
 * a record with invented digests, internally consistent and correctly
 * cross-referenced, passes every other check the gate makes.
 *
 * This produces the missing signature. The operator is not attesting that the
 * restore succeeded -- that claim belongs to the runner, and the operator's
 * operational record is deliberately forbidden from carrying it. The operator
 * is attesting something narrower and checkable: *this exact restore record is
 * the one that run produced*. The summary printed to stderr is what they are
 * putting their key behind, so it is printed before anything is signed.
 *
 *   NV_ALPHA17_OPERATOR_KEY_ID=... \
 *   NV_ALPHA17_OPERATOR_PRIVATE_KEY_BASE64=... \
 *   node scripts/sign-restore-witness.js hosted-evidence.json > witness.json
 */

const crypto = require('crypto');
const fs = require('fs');
const { validateEvidenceEnvelope } = require('../src/qualification-evidence');

function fail(message) {
  process.stderr.write(`sign-restore-witness: ${message}\n`);
  process.exit(1);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function privateKey(encoded) {
  const value = String(encoded || '').trim();
  if (!value) fail('NV_ALPHA17_OPERATOR_PRIVATE_KEY_BASE64 is required');
  let key;
  try {
    key = crypto.createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    fail('the operator private key must be base64 PKCS#8 DER');
  }
  if (key.asymmetricKeyType !== 'ed25519') fail('the operator private key must be Ed25519');
  return key;
}

function main() {
  const source = process.argv[2];
  if (!source) fail('usage: node scripts/sign-restore-witness.js <hosted-evidence.json>');

  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (error) {
    fail(`the evidence file could not be read: ${error.message}`);
  }

  /*
   * Validate before signing. An operator who signs whatever they are handed is
   * a rubber stamp, and a witness over malformed evidence would be worse than
   * none -- it would carry the gate's trust into a record nothing checked.
   */
  let artifact;
  try {
    artifact = validateEvidenceEnvelope(evidence);
  } catch (error) {
    fail(`the evidence is not a valid envelope, so it must not be witnessed: ${error.message}`);
  }
  if (artifact.artifactType !== 'hosted-live') {
    fail(`only hosted-live evidence carries a restore record, got ${artifact.artifactType}`);
  }

  const keyId = String(process.env.NV_ALPHA17_OPERATOR_KEY_ID || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(keyId)) fail('NV_ALPHA17_OPERATOR_KEY_ID is required and must be a key identifier');
  const key = privateKey(process.env.NV_ALPHA17_OPERATOR_PRIVATE_KEY_BASE64);

  const restore = artifact.restoreRunnerAttestation;
  const check = restore.record.check;
  process.stderr.write([
    '',
    'You are about to witness this restore record:',
    '',
    `  run             ${artifact.originId}`,
    `  subject         ${artifact.subjectSha256}`,
    `  source commit   ${artifact.sourceCommit}`,
    `  restore record  ${restore.recordSha256}`,
    `  completed at    ${restore.completedAt}`,
    '',
    'which claims:',
    '',
    `  status          ${check.status}`,
    `  migration       ${check.latestMigration}`,
    `  target          ${check.restoreTargetFingerprint}`,
    `  smoke passed    ${check.smokePassed}`,
    `  backup removed  ${check.backupRemoved}`,
    '',
    'Your signature says this record came from that run. It does not endorse',
    'the claims above -- those remain the runner\'s, and the gate checks them',
    'separately. Confirm the run identity against the workflow before use.',
    '',
    ''
  ].join('\n'));

  const witness = {
    schemaVersion: '1.0.0',
    artifactType: 'hosted-restore-witness',
    subjectSha256: artifact.subjectSha256,
    sourceCommit: artifact.sourceCommit,
    originId: artifact.originId,
    restoreRecordSha256: restore.recordSha256,
    completedAt: new Date().toISOString()
  };
  const value = crypto.sign(null, Buffer.from(stableJson(witness), 'utf8'), key).toString('base64');
  process.stdout.write(`${JSON.stringify({ ...witness, signature: { algorithm: 'ed25519', keyId, value } }, null, 2)}\n`);
}

main();
