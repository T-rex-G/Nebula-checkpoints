'use strict';

const assert = require('assert');
const {
  QUALIFICATION_SCHEMA_VERSION,
  qualificationCatalog,
  verifyQualification
} = require('../src/public-alpha-qualification');
const registry = require('../config/public-alpha-capabilities.json');
const passRecord = require('./fixtures/public-alpha-qualification-pass.json');

assert.strictEqual(QUALIFICATION_SCHEMA_VERSION, '1.0.0');
const catalog = qualificationCatalog(registry);
assert(catalog.automated.includes('node22-runtime-matrix'));
assert(catalog.automated.includes('production-audit'));
assert(catalog.hosted.includes('five-concurrent-read-testers'));
assert(catalog.hosted.includes('single-bounded-mutation'));
assert(catalog.manual.includes('ios-voiceover'));
assert(catalog.manual.includes('desktop-screen-reader'));
assert(catalog.providers.github.includes('file.write'));
assert(catalog.providers.gitea.includes('file.write'));
assert(!catalog.providers.gitea.includes('workflows.read'));
assert(Object.isFrozen(catalog));

const options = {
  expectedVersion: '5.3.0-alpha.17.0',
  expectedSubjectHash: 'a'.repeat(64),
  expectedSourceCommit: 'b'.repeat(40),
  expectedLatestMigration: '015_alpha_privacy',
  now: new Date('2026-07-29T20:00:00.000Z'),
  registry,
  verifyArtifact(artifact) {
    return artifact.sha256 === 'c'.repeat(64);
  }
};
const result = verifyQualification(passRecord, options);
assert.strictEqual(result.ok, true);
assert.strictEqual(result.decision, 'go');
assert.match(result.recordHash, /^[0-9a-f]{64}$/);
assert(Object.isFrozen(result));

const wrongSubject = structuredClone(passRecord);
wrongSubject.subjectSha256 = '330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892';
assert.throws(
  () => verifyQualification(wrongSubject, options),
  error => error.code === 'PUBLIC_ALPHA_EVIDENCE_SUBJECT_MISMATCH'
);

console.log('public alpha qualification tests passed');
