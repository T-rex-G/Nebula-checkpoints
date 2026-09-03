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
assert(catalog.providers.gitlab.includes('file.write'));
assert(!catalog.providers.gitlab.includes('workflows.read'));
/*
 * Gitea is absent rather than empty. Its five Provider-verified claims were
 * withdrawn because no live run had ever established them and there is no
 * instance to establish them on, so the contract asks nothing of it and it
 * owes no artifact.
 */
assert.strictEqual(catalog.providers.gitea, undefined);
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
const result = verifyQualification(fixture.record, options);
assert.strictEqual(result.ok, true);
assert.strictEqual(result.decision, 'go');
assert.match(result.recordHash, /^[0-9a-f]{64}$/);
assert(Object.isFrozen(result));

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
