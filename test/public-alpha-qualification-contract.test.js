'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  qualificationCatalog,
  validateQualificationRecord,
  verifyQualification
} = require('../src/public-alpha-qualification');
const registry = require('../config/public-alpha-capabilities.json');
const {
  PROVIDER_CAPABILITY_REQUIREMENTS,
  validateEvidenceEnvelope
} = require('../src/qualification-evidence');
const {
  SUBJECT,
  SOURCE,
  createPassFixture
} = require('./helpers/public-alpha-pass-fixture');

function optionsFor(fixture, override = {}) {
  return {
    expectedVersion: '5.3.0-alpha.17.0',
    expectedSubjectHash: SUBJECT,
    expectedSourceCommit: SOURCE,
    expectedLatestMigration: '015_alpha_privacy',
    now: new Date('2026-07-29T20:00:00.000Z'),
    registry,
    ...fixture.bindings,
    verifyArtifact: artifact => structuredClone(fixture.envelopes[artifact.id]),
    ...override
  };
}

function rejects(code, change, override) {
  const fixture = createPassFixture();
  change(fixture);
  assert.throws(
    () => verifyQualification(fixture.record, optionsFor(fixture, override)),
    error => error && error.code === code,
    `expected ${code}`
  );
}

const passFixture = createPassFixture();
const normalized = validateQualificationRecord(passFixture.record);
assert(Object.isFrozen(normalized));
assert.strictEqual(normalized.product, 'Nebulaverse-X');

const catalog = qualificationCatalog(registry);
assert.strictEqual(catalog.automated.length, 22);
assert.strictEqual(catalog.hosted.length, 13);
assert.strictEqual(catalog.manual.length, 5);
for (const [provider, deployment] of Object.entries(registry.providers)) {
  assert(deployment['hosted-alpha']);
  const expected = Object.keys(PROVIDER_CAPABILITY_REQUIREMENTS[provider]).sort();
  assert.deepStrictEqual(catalog.providers[provider], expected);
  const providerVerified = Object.entries(deployment['hosted-alpha'])
    .filter(([, tuple]) => tuple[1] === 'Provider-verified')
    .map(([capability]) => capability)
    .sort();
  assert.deepStrictEqual(
    providerVerified,
    expected,
    `${provider} must not advertise Provider-verified capabilities outside the live proof contract`
  );
}

rejects('PUBLIC_ALPHA_SCHEMA_MISMATCH', ({ record }) => { record.schemaVersion = '0.9.0'; });
rejects('PUBLIC_ALPHA_VERSION_MISMATCH', ({ record }) => { record.version = '5.3.0-alpha.16.3'; });
rejects('PUBLIC_ALPHA_EVIDENCE_SUBJECT_MISMATCH', ({ record }) => { record.subjectSha256 = 'd'.repeat(64); });
rejects('PUBLIC_ALPHA_SOURCE_COMMIT_MISMATCH', ({ record }) => { record.sourceCommit = 'e'.repeat(40); });
rejects('PUBLIC_ALPHA_MIGRATION_MISMATCH', ({ record }) => { record.latestMigration = '014_alpha_access'; });
for (const nodeVersion of ['22.0.0', '22.22.1']) {
  rejects('PUBLIC_ALPHA_NODE_VERSION_INVALID', ({ record }) => { record.nodeVersion = nodeVersion; });
}
rejects('PUBLIC_ALPHA_EVIDENCE_STALE', ({ record }) => {
  record.automated.syntax.completedAt = '2026-07-25T00:00:00.000Z';
});
rejects('PUBLIC_ALPHA_EVIDENCE_MISSING', ({ record }) => { delete record.automated.syntax; });
rejects('PUBLIC_ALPHA_EVIDENCE_NOT_PASS', ({ record }) => { record.hosted['render-cold-start'].status = 'fail'; });
rejects('PUBLIC_ALPHA_CLEANUP_UNVERIFIED', ({ record }) => {
  record.providers.github['file.write'].cleanupVerified = false;
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISSING', ({ record }) => {
  record.manual['ios-voiceover'].artifact = 'absent-artifact';
});
{
  const fixture = createPassFixture();
  const expectedEnvelope = structuredClone(fixture.envelopes['automated-artifact']);
  const differentValidEnvelope = {
    ...expectedEnvelope,
    originId: 'workflow-2048-different-automated'
  };
  fixture.record.artifacts[0].sha256 = require('crypto')
    .createHash('sha256')
    .update(JSON.stringify(expectedEnvelope))
    .digest('hex');
  assert.throws(
    () => verifyQualification(fixture.record, optionsFor(fixture, {
      verifyArtifact: artifact => {
        const envelope = artifact.id === 'automated-artifact'
          ? differentValidEnvelope
          : fixture.envelopes[artifact.id];
        const observed = require('crypto').createHash('sha256')
          .update(JSON.stringify(envelope))
          .digest('hex');
        if (observed !== artifact.sha256) {
          const error = new Error('artifact bytes have a different SHA-256 digest');
          error.code = 'ARTIFACT_DIGEST_MISMATCH';
          throw error;
        }
        return structuredClone(envelope);
      }
    })),
    error => error &&
      error.code === 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH' &&
      error.causeCode === 'ARTIFACT_DIGEST_MISMATCH' &&
      error.artifactId === 'automated-artifact' &&
      /different SHA-256 digest/.test(error.message)
  );
}
rejects('PUBLIC_ALPHA_SECURITY_FINDINGS_OPEN', ({ record }) => { record.security.highUnresolved = 1; });
rejects('PUBLIC_ALPHA_PROVIDER_EVIDENCE_MISSING', ({ record }) => {
  delete record.providers.gitea['file.write'];
});
rejects('PUBLIC_ALPHA_EXPERIMENTAL_IN_GOLDEN_PATH', ({ record }) => {
  /* Still Experimental: delivery needs a deployment the provider can reach. */
  record.goldenPathCapabilities.push('github:live-events');
});
rejects('PUBLIC_ALPHA_UNAVAILABLE_ENABLED', ({ record }) => {
  record.observedEnabledCapabilities.push('gitea:workflows.read');
});
rejects('PUBLIC_ALPHA_SECRET_MATERIAL', ({ record }) => { record.operatorToken = 'not-allowed'; });
rejects('PUBLIC_ALPHA_SECRET_MATERIAL', ({ record }) => {
  record.notes = 'Authorization: Bearer opaque-credential-material';
});

rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_CONTEXT_MISMATCH', ({ envelopes }) => {
  envelopes['automated-artifact'].subjectSha256 = 'd'.repeat(64);
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_CONTEXT_MISMATCH', ({ envelopes }) => {
  envelopes['automated-artifact'].sourceCommit = 'd'.repeat(40);
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['automated-artifact'].artifactType = 'manual';
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['github-artifact'].provider = 'gitlab';
});
rejects('PUBLIC_ALPHA_EVIDENCE_CLAIM_MISSING', ({ envelopes }) => {
  delete envelopes['automated-artifact'].claims['automated.syntax'];
});
rejects('PUBLIC_ALPHA_EVIDENCE_CLAIM_MISMATCH', ({ envelopes }) => {
  envelopes['automated-artifact'].claims['automated.syntax'].completedAt = '2026-07-29T18:59:00.000Z';
});
rejects('PUBLIC_ALPHA_EVIDENCE_CLAIM_MISMATCH', ({ envelopes }) => {
  envelopes['automated-artifact'].claims['automated.syntax'].status = 'fail';
});
rejects('PUBLIC_ALPHA_EVIDENCE_CLAIM_MISMATCH', ({ envelopes }) => {
  envelopes['automated-artifact'].claims['automated.syntax'].cleanupVerified = false;
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['automated-artifact'].originId = '../not-an-origin';
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['github-artifact'].authorizedTargetSha256 = 'not-a-hash';
});
rejects('PUBLIC_ALPHA_EVIDENCE_TARGET_MISMATCH', ({ envelopes }) => {
  envelopes['github-artifact'].authorizedTargetSha256 = 'c'.repeat(64);
});
rejects('PUBLIC_ALPHA_EVIDENCE_TARGET_MISMATCH', ({ envelopes }) => {
  envelopes['hosted-artifact'].authorizedTargetSha256 = 'c'.repeat(64);
});
rejects('PUBLIC_ALPHA_DEPLOYMENT_MISMATCH', ({ envelopes }) => {
  envelopes['hosted-artifact'].deploymentSha256 = 'c'.repeat(64);
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['hosted-artifact'].originId = 'workflow-2048';
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  delete envelopes['hosted-artifact'].operatorAttestation.recordSha256;
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  const attestation = envelopes['hosted-artifact'].operatorAttestation;
  attestation.record.signature.value = Buffer.alloc(64, 8).toString('base64');
  attestation.recordSha256 = require('crypto')
    .createHash('sha256')
    .update((function stable(value) {
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
      if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
      }
      return JSON.stringify(value);
    })(attestation.record), 'utf8')
    .digest('hex');
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  delete envelopes['hosted-artifact'].restoreRunnerAttestation.recordSha256;
});

/*
 * The restore witness.
 *
 * Everything above proves the restore record is internally consistent and
 * cross-referenced. None of it proves the record came from a real restore: the
 * runner signs with a key generated and destroyed inside its own job, so that
 * HMAC is unverifiable here -- the fixture's is the literal string '7' sixty-four
 * times, and every check above passes on it. The operator's witness is the only
 * thing standing between "a restore happened" and "the evidence says so".
 *
 * Each case below is a way to defeat the witness. All of them must fail.
 */
function sha256Stable(value) {
  const stable = input => {
    if (Array.isArray(input)) return `[${input.map(stable).join(',')}]`;
    if (input && typeof input === 'object') {
      return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${stable(input[key])}`).join(',')}}`;
    }
    return JSON.stringify(input);
  };
  return require('crypto').createHash('sha256').update(stable(value), 'utf8').digest('hex');
}
{
  const fixture = createPassFixture();
  assert.throws(
    () => verifyQualification(fixture.record, optionsFor(fixture, { restoreWitness: undefined })),
    error => error && error.code === 'PUBLIC_ALPHA_OPTIONS_INVALID',
    'a run with no operator witness must not qualify'
  );
}
// A forged restore record: internally coherent, freshly hashed, never witnessed.
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  const attestation = envelopes['hosted-artifact'].restoreRunnerAttestation;
  attestation.record.check.restoreEvidenceSha256 = 'c'.repeat(64);
  envelopes['hosted-artifact'].checks['isolated-database-restore'] = attestation.record.check;
  attestation.recordSha256 = sha256Stable(attestation.record);
});
// A witness for a different restore record.
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', fixture => {
  fixture.bindings.restoreWitness.restoreRecordSha256 = 'd'.repeat(64);
});
// A witness lifted from another run.
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', fixture => {
  fixture.bindings.restoreWitness.originId = 'workflow-9999-hosted';
});
// A witness signed by a key the gate does not trust.
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', fixture => {
  fixture.bindings.restoreWitness.signature.keyId = 'not-the-operator';
});
// A witness whose signature does not verify.
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', fixture => {
  const forged = Buffer.from(fixture.bindings.restoreWitness.signature.value, 'base64');
  forged[0] ^= 0xff;
  fixture.bindings.restoreWitness.signature.value = forged.toString('base64');
});
// A witness signed before the restore it claims to have seen.
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', fixture => {
  fixture.bindings.restoreWitness.completedAt = '2026-07-29T00:00:00.000Z';
});

{
  const fixture = createPassFixture();
  assert.throws(
    () => verifyQualification(fixture.record, optionsFor(fixture, {
      expectedAuthorizedTargets: undefined
    })),
    error => error && error.code === 'PUBLIC_ALPHA_OPTIONS_INVALID',
    'final qualification must require externally trusted live-target bindings'
  );
}
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['hosted-artifact'].restoreRunnerAttestation.record.check.smokePassed = false;
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['github-artifact'].checks.splice(9, 1);
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['github-artifact'].checks.find(check => check.key === 'stale-head').zeroCommit = false;
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['github-artifact'].checks.find(check => check.key === 'expected-head-delete').fileAbsent = false;
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', ({ envelopes }) => {
  envelopes['github-artifact'].capabilities = [
    ...envelopes['github-artifact'].capabilities,
    'pulls.read'
  ];
});

{
  const deeplyNested = structuredClone(createPassFixture().envelopes['automated-artifact']);
  deeplyNested.proof = {};
  let cursor = deeplyNested.proof;
  for (let depth = 0; depth < 80; depth += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.throws(
    () => validateEvidenceEnvelope(deeplyNested),
    error => error &&
      error.code === 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH' &&
      /maximum nesting depth/i.test(error.message)
  );
}

for (const forbiddenKey of ['__proto__', 'constructor', 'prototype']) {
  const envelope = structuredClone(createPassFixture().envelopes['automated-artifact']);
  envelope.proof = JSON.parse(`{"${forbiddenKey}":{"polluted":true}}`);
  assert.throws(
    () => validateEvidenceEnvelope(envelope),
    error => error &&
      error.code === 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH' &&
      /forbidden property name/i.test(error.message),
    `evidence must reject the prototype-mutating key ${forbiddenKey}`
  );
}

const templatePath = path.join(__dirname, '..', 'staging', 'PUBLIC_ALPHA_EVIDENCE_TEMPLATE.json');
assert(fs.existsSync(templatePath), 'qualification evidence template must exist');
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
assert.strictEqual(template.schemaVersion, '1.1.0');
assert.strictEqual(template.subjectSha256, '');
assert.strictEqual(template.security.criticalUnresolved, -1);
assert.throws(
  () => verifyQualification(template, optionsFor(passFixture)),
  error => error && /^PUBLIC_ALPHA_/.test(error.code)
);

console.log('public alpha qualification contract tests passed');
