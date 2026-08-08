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
const fixture = require('./fixtures/public-alpha-qualification-pass.json');

const baseOptions = {
  expectedVersion: '5.3.0-alpha.17.0',
  expectedSubjectHash: 'a'.repeat(64),
  expectedSourceCommit: 'b'.repeat(40),
  expectedLatestMigration: '015_alpha_privacy',
  now: new Date('2026-07-29T20:00:00.000Z'),
  registry,
  verifyArtifact: artifact => artifact.sha256 === 'c'.repeat(64)
};

function copy() {
  return structuredClone(fixture);
}

function rejects(code, change, options = baseOptions) {
  const record = copy();
  change(record);
  assert.throws(
    () => verifyQualification(record, options),
    error => error && error.code === code,
    `expected ${code}`
  );
}

const normalized = validateQualificationRecord(copy());
assert(Object.isFrozen(normalized));
assert.strictEqual(normalized.product, 'Nebulaverse-X');

const catalog = qualificationCatalog(registry);
assert.strictEqual(catalog.automated.length, 22);
assert.strictEqual(catalog.hosted.length, 13);
assert.strictEqual(catalog.manual.length, 5);
for (const [provider, deployment] of Object.entries(registry.providers)) {
  const expected = Object.entries(deployment['hosted-alpha'])
    .filter(([, tuple]) => tuple[0] === 'Supported')
    .map(([feature]) => feature)
    .sort();
  assert.deepStrictEqual(catalog.providers[provider], expected);
}

rejects('PUBLIC_ALPHA_SCHEMA_MISMATCH', record => { record.schemaVersion = '0.9.0'; });
rejects('PUBLIC_ALPHA_VERSION_MISMATCH', record => { record.version = '5.3.0-alpha.16.3'; });
rejects('PUBLIC_ALPHA_EVIDENCE_SUBJECT_MISMATCH', record => { record.subjectSha256 = 'd'.repeat(64); });
rejects('PUBLIC_ALPHA_SOURCE_COMMIT_MISMATCH', record => { record.sourceCommit = 'e'.repeat(40); });
rejects('PUBLIC_ALPHA_MIGRATION_MISMATCH', record => { record.latestMigration = '014_alpha_access'; });
rejects('PUBLIC_ALPHA_EVIDENCE_STALE', record => {
  record.automated.syntax.completedAt = '2026-07-25T00:00:00.000Z';
});
rejects('PUBLIC_ALPHA_EVIDENCE_MISSING', record => { delete record.automated.syntax; });
rejects('PUBLIC_ALPHA_EVIDENCE_NOT_PASS', record => { record.hosted['render-cold-start'].status = 'fail'; });
rejects('PUBLIC_ALPHA_CLEANUP_UNVERIFIED', record => {
  record.providers.github['file.write'].cleanupVerified = false;
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISSING', record => {
  record.manual['ios-voiceover'].artifact = 'absent-artifact';
});
rejects('PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH', record => {
  record.artifacts[0].sha256 = 'd'.repeat(64);
});
rejects('PUBLIC_ALPHA_SECURITY_FINDINGS_OPEN', record => { record.security.highUnresolved = 1; });
rejects('PUBLIC_ALPHA_PROVIDER_EVIDENCE_MISSING', record => {
  delete record.providers.gitea['file.write'];
});
rejects('PUBLIC_ALPHA_EXPERIMENTAL_IN_GOLDEN_PATH', record => {
  record.goldenPathCapabilities.push('github:workflows.rerun');
});
rejects('PUBLIC_ALPHA_UNAVAILABLE_ENABLED', record => {
  record.observedEnabledCapabilities.push('gitea:workflows.read');
});
rejects('PUBLIC_ALPHA_SECRET_MATERIAL', record => {
  record.operatorToken = 'not-allowed';
});
rejects('PUBLIC_ALPHA_SECRET_MATERIAL', record => {
  record.notes = 'Authorization: Bearer opaque-credential-material';
});

const templatePath = path.join(__dirname, '..', 'staging', 'PUBLIC_ALPHA_EVIDENCE_TEMPLATE.json');
assert(fs.existsSync(templatePath), 'qualification evidence template must exist');
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
assert.strictEqual(template.schemaVersion, '1.0.0');
assert.strictEqual(template.subjectSha256, '');
assert.strictEqual(template.security.criticalUnresolved, -1);
assert.throws(
  () => verifyQualification(template, baseOptions),
  error => error && /^PUBLIC_ALPHA_/.test(error.code)
);

console.log('public alpha qualification contract tests passed');
