'use strict';

const assert = require('assert');
const {
  QUALIFICATION_SCHEMA_VERSION,
  qualificationCatalog,
  verifyQualification
} = require('../src/public-alpha-qualification');
const registry = require('../config/public-alpha-capabilities.json');
const {
  SUBJECT,
  SOURCE,
  createPassFixture
} = require('./helpers/public-alpha-pass-fixture');

assert.strictEqual(QUALIFICATION_SCHEMA_VERSION, '1.1.0');
const catalog = qualificationCatalog(registry);
assert(catalog.automated.includes('node22-runtime-matrix'));
assert(catalog.automated.includes('production-audit'));
assert(catalog.hosted.includes('five-concurrent-read-testers'));
assert(catalog.hosted.includes('single-bounded-mutation'));
assert(catalog.manual.includes('ios-voiceover'));
assert(catalog.manual.includes('desktop-screen-reader'));
assert(catalog.providers.github.includes('file.write'));
assert.deepStrictEqual(Object.keys(catalog.providers), ['github']);
for (const retired of ['gitlab', 'gitea']) {
  const unsupportedRegistry = structuredClone(registry);
  unsupportedRegistry.providers[retired] = structuredClone(registry.providers.github);
  assert.throws(() => qualificationCatalog(unsupportedRegistry), error => error.code === 'PUBLIC_ALPHA_REGISTRY_INVALID');
}
assert(Object.isFrozen(catalog));

const fixture = createPassFixture();
const options = {
  expectedVersion: '5.3.0-alpha.17.0',
  expectedSubjectHash: SUBJECT,
  expectedSourceCommit: SOURCE,
  expectedLatestMigration: '015_alpha_privacy',
  now: new Date('2026-07-29T20:00:00.000Z'),
  registry,
  ...fixture.bindings,
  verifyArtifact(artifact) {
    return structuredClone(fixture.envelopes[artifact.id]);
  }
};
for (const retired of ['gitlab', 'gitea']) {
  assert.throws(() => verifyQualification(fixture.record, {
    ...options, expectedAuthorizedTargets: { ...fixture.bindings.expectedAuthorizedTargets, [retired]: 'd'.repeat(64) }
  }), error => error.code === 'PUBLIC_ALPHA_OPTIONS_INVALID');
}

const result = verifyQualification(fixture.record, options);
assert.strictEqual(result.ok, true);
assert.strictEqual(result.decision, 'go');
assert.strictEqual(result.checks.trustedLiveTargets, 2);
assert.strictEqual(result.checks.trustedLiveTargets, Object.keys(fixture.bindings.expectedAuthorizedTargets).length);
assert.match(result.recordHash, /^[0-9a-f]{64}$/);
assert(Object.isFrozen(result));

// New candidates cannot borrow a passing restore from the previous schema.
assert.throws(() => verifyQualification({ ...fixture.record, latestMigration: '016_personal_workspaces' }, {
  ...options, expectedLatestMigration: '016_personal_workspaces'
}), error => error.code === 'PUBLIC_ALPHA_MIGRATION_MISMATCH');
const current = createPassFixture({ latestMigration: '016_personal_workspaces' });
assert.strictEqual(verifyQualification(current.record, {
  ...options, ...current.bindings, expectedLatestMigration: '016_personal_workspaces',
  verifyArtifact: artifact => structuredClone(current.envelopes[artifact.id])
}).ok, true);
const connectionsCandidate = createPassFixture({ latestMigration: '017_workspace_credentials' });
assert.strictEqual(verifyQualification(connectionsCandidate.record, {
  ...options, ...connectionsCandidate.bindings, expectedLatestMigration: '017_workspace_credentials',
  verifyArtifact: artifact => structuredClone(connectionsCandidate.envelopes[artifact.id])
}).ok, true);
assert.throws(() => verifyQualification(current.record, {
  ...options, ...current.bindings, expectedLatestMigration: '017_workspace_credentials',
  verifyArtifact: artifact => structuredClone(current.envelopes[artifact.id])
}), error => error.code === 'PUBLIC_ALPHA_MIGRATION_MISMATCH');

assert.throws(
  () => verifyQualification(fixture.record, { ...options, verifyArtifact: () => true }),
  error => error && error.code === 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH',
  'a legacy boolean/hash-only verifier must not authorize qualification claims'
);

const wrongSubject = structuredClone(fixture.record);
wrongSubject.subjectSha256 = '330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892';
assert.throws(
  () => verifyQualification(wrongSubject, options),
  error => error.code === 'PUBLIC_ALPHA_EVIDENCE_SUBJECT_MISMATCH'
);

console.log('public alpha qualification tests passed');
