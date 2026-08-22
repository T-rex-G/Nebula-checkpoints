'use strict';
const assert = require('assert');
const crypto = require('crypto');
const {
  stableJson, hashJson, hmacJson, evidenceRecordHash, verifyGithubSignature, normalizeGithubWebhook,
  EVIDENCE_ACTIVE_KEY_ID, EVIDENCE_LEGACY_KEY_ID, verifyEvidenceRecord, acceptsLegacySessionKey, parseRetiredSessionSecrets,
  evidenceKeyrings,
  riskForEvent, pathMatches, protectedPatternsForRepository, referenceSha, canAcceptLiveClient,
  normalizeRepoPath, normalizeBranchName, normalizeCommitSha, lfsAttributePattern, shortestPath,
  compareSnapshots, riskForAccessSurface, normalizeProviderBranches
} = require('../src/intelligence');
const { normalizeDatabaseUrl } = require('../src/config');
const { KEY_PURPOSES, deriveSecret } = require('../src/key-derivation');

assert.strictEqual(stableJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
assert.strictEqual(stableJson({ z: [2, { b: true, a: false }], a: null }), '{"a":null,"z":[2,{"a":false,"b":true}]}');
assert.strictEqual(hashJson({ a: 1 }), hashJson({ a: 1 }));
assert.notStrictEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
assert.strictEqual(hmacJson('secret', { b: 2, a: 1 }), hmacJson('secret', { a: 1, b: 2 }));
assert.strictEqual(evidenceRecordHash('key', 'prev', 'github:a/b', 'webhook', 'id', 'payload'), evidenceRecordHash('key', 'prev', 'github:a/b', 'webhook', 'id', 'payload'));
assert.notStrictEqual(evidenceRecordHash('key', 'prev', 'github:a/b', 'webhook', 'id', 'payload'), evidenceRecordHash('other', 'prev', 'github:a/b', 'webhook', 'id', 'payload'));

const normalizedDb = normalizeDatabaseUrl('postgresql://u:p@example.com/db?sslmode=require&channel_binding=require', { production: true });
assert.match(normalizedDb, /sslmode=verify-full/);
assert.match(normalizedDb, /channel_binding=require/);
assert.throws(() => normalizeDatabaseUrl('http://example.com/db', { production: true }), /postgres/);
assert.throws(() => normalizeDatabaseUrl('postgresql://u:p@example.com/db?sslmode=disable', { production: true }), /cannot disable TLS/);
assert.match(normalizeDatabaseUrl('postgresql://u:p@localhost/db?sslmode=disable', { production: false, insecure: true }), /sslmode=disable/);


assert.deepStrictEqual(
  protectedPatternsForRepository({ 'Acme/Demo': ['.github/workflows/**'] }, 'acme', 'demo'),
  ['.github/workflows/**']
);
assert.deepStrictEqual(protectedPatternsForRepository({}, 'acme', 'demo'), []);
assert.strictEqual(referenceSha({ commit: { sha: 'a'.repeat(40) } }), 'a'.repeat(40));
assert.strictEqual(referenceSha({ commit: { id: 'b'.repeat(40) } }), 'b'.repeat(40));
assert.strictEqual(referenceSha({ target: { sha: 'c'.repeat(40) } }), 'c'.repeat(40));
assert.strictEqual(referenceSha({ object: { sha: 'd'.repeat(40) } }), 'd'.repeat(40));
assert.strictEqual(referenceSha({}), '');

assert.strictEqual(typeof normalizeProviderBranches, 'function', 'provider branch normalization must be exported');
assert.deepStrictEqual(normalizeProviderBranches('gitea', [
  { name: 'main', protected: true, commit: { id: '1'.repeat(40) } }
]), [
  { name: 'main', protected: true, sha: '1'.repeat(40) }
]);
assert.deepStrictEqual(normalizeProviderBranches('github', [
  { name: 'main', protected: false, commit: { sha: '2'.repeat(40), id: '3'.repeat(40) } }
]), [
  { name: 'main', protected: false, sha: '2'.repeat(40) }
]);
assert.deepStrictEqual(normalizeProviderBranches('gitlab', [
  { name: 'release', protected: true, commit: { id: '4'.repeat(40), sha: '5'.repeat(40) } }
]), [
  { name: 'release', protected: true, sha: '4'.repeat(40) }
]);
assert.deepStrictEqual(normalizeProviderBranches('gitea', [
  { name: 'empty', protected: false, commit: null }
]), [
  { name: 'empty', protected: false, sha: '' }
]);

assert.strictEqual(canAcceptLiveClient(0, 0), true);
assert.strictEqual(canAcceptLiveClient(99, 4), true);
assert.strictEqual(canAcceptLiveClient(100, 0), false);
assert.strictEqual(canAcceptLiveClient(4, 5), false);


assert(pathMatches('.github/workflows/**', '.github/workflows/deploy.yml'));
assert(pathMatches('infra', 'infra/prod/main.tf'));
assert(pathMatches('src/*.js', 'src/app.js'));
assert(pathMatches('docs/??.md', 'docs/en.md'));
assert(!pathMatches('src/*.js', 'src/lib/a.js'));
assert(!pathMatches('../secret', 'secret'));
assert(!pathMatches('', 'src/a.js'));


assert.strictEqual(normalizeRepoPath('\\assets\\release file.zip'), 'assets/release file.zip');
assert.strictEqual(normalizeRepoPath('/docs//guide.md'), 'docs/guide.md');
assert.throws(() => normalizeRepoPath(''), /Invalid repository path/);
assert.throws(() => normalizeRepoPath('../secret.txt'), /Invalid repository path/);
assert.throws(() => normalizeRepoPath('docs/../secret.txt'), /Invalid repository path/);
assert.throws(() => normalizeRepoPath('docs/'), /Invalid repository path/);
assert.throws(() => normalizeRepoPath('bad\npath'), /Invalid repository path/);
assert.strictEqual(normalizeBranchName('feature/neural-live'), 'feature/neural-live');
assert.strictEqual(normalizeBranchName('release-5.2.0'), 'release-5.2.0');
assert.strictEqual(normalizeCommitSha('A'.repeat(40)), 'a'.repeat(40));
assert.throws(() => normalizeCommitSha('abc123'), /Invalid commit SHA/);
for (const bad of ['', 'bad name', 'a..b', '.hidden/x', 'x.lock', 'feature//x', 'x[1]', '@']) {
  assert.throws(() => normalizeBranchName(bad), /Invalid branch name/);
}
assert.strictEqual(lfsAttributePattern('assets/release file.zip'), '/assets/release\\ file.zip');
assert.strictEqual(lfsAttributePattern('assets/[final]*.zip'), '/assets/\\[final\\]\\*.zip');

const raw = Buffer.from('{"hello":"world"}');
const secret = 'test-secret';
const sig = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
assert(verifyGithubSignature(secret, raw, sig));
assert(!verifyGithubSignature(secret, raw, sig.slice(0, -1) + '0'));
assert(!verifyGithubSignature('', raw, sig));
assert(!verifyGithubSignature(secret, 'not-a-buffer', sig));

const evt = normalizeGithubWebhook('push', {
  ref: 'refs/heads/main', forced: true, before: 'a'.repeat(40), after: 'b'.repeat(40),
  repository: { name: 'demo', full_name: 'acme/demo', default_branch: 'main', owner: { login: 'acme' } },
  sender: { login: 'alice' }, commits: [{ modified: ['.github/workflows/deploy.yml', 'src/app.js'], added: [], removed: [] }]
}, 'delivery-1');
assert.strictEqual(evt.ref, 'main');
assert.deepStrictEqual(evt.paths, ['.github/workflows/deploy.yml', 'src/app.js']);
const risk = riskForEvent(evt, { protectedPatterns: ['.github/workflows/**'], defaultBranch: 'main' });
assert.strictEqual(risk.severity, 'critical');
assert(risk.score <= 100);
assert(risk.reasons.some(r => r.code === 'FORCE_PUSH'));
assert(risk.reasons.some(r => r.code === 'PROTECTED_PATH_CHANGED'));
assert(risk.reasons.some(r => r.code === 'WORKFLOW_CHANGED'));


const largeCommits = Array.from({ length: 101 }, (_, i) => ({ modified: [`src/file-${i}.js`], added: [], removed: [] }));
const truncatedPush = normalizeGithubWebhook('push', {
  ref: 'refs/heads/main',
  repository: { name: 'demo', full_name: 'acme/demo', default_branch: 'main', owner: { login: 'acme' } },
  sender: { login: 'alice' }, commits: largeCommits
}, 'delivery-truncated');
assert.strictEqual(truncatedPush.metadata.pathsTruncated, true);
assert.strictEqual(truncatedPush.metadata.commitsInspected, 100);
assert(riskForEvent(truncatedPush).reasons.some(r => r.code === 'CHANGESET_TRUNCATED'));

const providerTruncatedPush = normalizeGithubWebhook('push', {
  ref: 'refs/heads/main', size: 250, distinct_size: 200,
  repository: { name: 'demo', full_name: 'acme/demo', default_branch: 'main', owner: { login: 'acme' } },
  sender: { login: 'alice' }, commits: [{ modified: ['src/only-visible-file.js'], added: [], removed: [] }]
}, 'delivery-provider-truncated');
assert.strictEqual(providerTruncatedPush.metadata.commitCount, 250);
assert.strictEqual(providerTruncatedPush.metadata.distinctCommitCount, 200);
assert.strictEqual(providerTruncatedPush.metadata.pathsTruncated, true);

const deleted = normalizeGithubWebhook('delete', {
  ref: 'production', ref_type: 'branch',
  repository: { name: 'demo', full_name: 'acme/demo', owner: { login: 'acme' } },
  sender: { login: 'bob' }
}, 'delivery-2');
assert.strictEqual(riskForEvent(deleted).severity, 'warning');

const failedWorkflow = normalizeGithubWebhook('workflow_run', {
  action: 'completed', repository: { name: 'demo', full_name: 'acme/demo', owner: { login: 'acme' } },
  sender: { login: 'ci' }, workflow_run: { id: 99, name: 'Deploy', status: 'completed', conclusion: 'failure', head_branch: 'main' }
}, 'delivery-3');
assert(riskForEvent(failedWorkflow).reasons.some(r => r.code === 'WORKFLOW_FAILED'));

const graph = shortestPath(
  [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'isolated' }],
  [{ source: 'a', target: 'b', type: 'x' }, { source: 'b', target: 'c', type: 'y' }],
  'a', 'c'
);
assert.deepStrictEqual(graph.nodeIds, ['a', 'b', 'c']);
assert.strictEqual(graph.edges.length, 2);
assert.strictEqual(shortestPath([{ id: 'a' }], [], 'a', 'missing'), null);
assert.strictEqual(shortestPath([{ id: 'a' }, { id: 'b' }], [], 'a', 'b'), null);
assert.deepStrictEqual(shortestPath([{ id: 'a' }], [], 'a', 'a'), { nodeIds: ['a'], edges: [] });


const snapshotComparison = compareSnapshots(
  {
    kind: 'nebulaverse-snapshot', owner: 'acme', repo: 'demo', capturedAt: '2026-07-20T00:00:00Z',
    refs: [{ name: 'main', sha: 'a'.repeat(40) }, { name: 'release', sha: 'b'.repeat(40) }],
    tags: [{ name: 'v1', sha: 'c'.repeat(40) }],
    manifest: { truncated: false, files: [
      { path: 'src/app.js', sha: 'd'.repeat(40), mode: '100644', type: 'blob' },
      { path: 'README.md', sha: 'e'.repeat(40), mode: '100644', type: 'blob' }
    ] }
  },
  {
    kind: 'nebulaverse-snapshot', owner: 'acme', repo: 'demo', capturedAt: '2026-07-21T00:00:00Z',
    refs: [{ name: 'main', sha: 'f'.repeat(40) }, { name: 'feature', sha: '1'.repeat(40) }],
    tags: [{ name: 'v1', sha: 'c'.repeat(40) }, { name: 'v2', sha: '2'.repeat(40) }],
    manifest: { truncated: false, files: [
      { path: 'src/app.js', sha: '3'.repeat(40), mode: '100644', type: 'blob' },
      { path: 'docs/guide.md', sha: '4'.repeat(40), mode: '100644', type: 'blob' }
    ] }
  }
);
assert.deepStrictEqual(snapshotComparison.refs.move.map(x => x.name), ['main']);
assert.deepStrictEqual(snapshotComparison.refs.recreate.map(x => x.name), ['release']);
assert.deepStrictEqual(snapshotComparison.refs.preserve.map(x => x.name), ['feature']);
assert.deepStrictEqual(snapshotComparison.files.modified.map(x => x.path), ['src/app.js']);
assert.deepStrictEqual(snapshotComparison.files.restore.map(x => x.path), ['README.md']);
assert.deepStrictEqual(snapshotComparison.files.preserve.map(x => x.path), ['docs/guide.md']);
assert.strictEqual(snapshotComparison.compatible, true);
assert.strictEqual(compareSnapshots({ owner: 'a', repo: 'x' }, { owner: 'b', repo: 'x' }).compatible, false);
assert.strictEqual(compareSnapshots({ provider: 'github', owner: 'a', repo: 'x' }, { provider: 'gitea', owner: 'a', repo: 'x' }).compatible, false);

const accessRisk = riskForAccessSurface({
  collaborators: [{ login: 'alice', permission: 'admin' }],
  deployKeys: [{ id: 1, title: 'prod', readOnly: false, verified: true }],
  webhooks: [{ id: 2, active: true, insecureSsl: true, host: 'example.net' }],
  partial: false
});
assert.strictEqual(accessRisk.severity, 'critical');
assert(accessRisk.reasons.some(r => r.code === 'WRITABLE_DEPLOY_KEY'));
assert(accessRisk.reasons.some(r => r.code === 'INSECURE_WEBHOOK_TLS'));
assert.strictEqual(riskForAccessSurface({ collaborators: [], deployKeys: [], webhooks: [], partial: true }).reasons.some(r => r.code === 'ACCESS_INVENTORY_PARTIAL'), true);

/*
 * Evidence-chain key rotation.
 *
 * The ledger reports a record that fails to reproduce its hash as tampering, so
 * rotating the hashing key without accepting the retired one would make every
 * pre-rotation record accuse itself on first deploy. These assert the property
 * that prevents it: a chain written before the rotation and extended after it
 * verifies end to end, while tampering still fails.
 */
const legacySecret = 'legacy-raw-session-secret-0123456789abcdef';
const rotatedSecret = 'derived-evidence-secret-0123456789abcdef';
const keyring = Object.freeze({ active: rotatedSecret, retired: Object.freeze([legacySecret]) });
const GENESIS = 'NEBULAVERSE-EVIDENCE-GENESIS-V2';
const repoKey = 'github:Acme/Demo';

assert.notStrictEqual(legacySecret, rotatedSecret, 'the rotation must actually change the key');

function record(secret, previousHash, kind, recordId) {
  const payloadHash = hashJson({ record: recordId });
  return {
    kind,
    recordId,
    payload_hash: payloadHash,
    previous_hash: previousHash,
    record_hash: evidenceRecordHash(secret, previousHash, repoKey, kind, recordId, payloadHash)
  };
}
function check(row, previousHash) {
  return verifyEvidenceRecord(
    keyring, row.record_hash, previousHash, repoKey, row.kind, row.recordId, row.payload_hash
  );
}

/* A record written under either key verifies, and names the key that matched. */
const preRotation = record(legacySecret, GENESIS, 'push', 'r1');
const postRotation = record(rotatedSecret, preRotation.record_hash, 'push', 'r2');
assert.deepStrictEqual(check(preRotation, GENESIS),
  { valid: true, keyId: EVIDENCE_LEGACY_KEY_ID, legacy: true },
  'a pre-rotation record must verify under the retired key and be reported as legacy');
assert.deepStrictEqual(check(postRotation, preRotation.record_hash),
  { valid: true, keyId: EVIDENCE_ACTIVE_KEY_ID, legacy: false },
  'a post-rotation record must verify under the active key');

/* Build a chain that straddles the rotation and verify it as the server does. */
function verifyChain(rows) {
  let previousHash = GENESIS;
  let legacyRecords = 0;
  for (const row of rows) {
    const result = check(row, previousHash);
    if (result.legacy) legacyRecords += 1;
    if (row.previous_hash !== previousHash || !result.valid) {
      return { valid: false, failedAt: row.recordId, legacyRecords };
    }
    previousHash = row.record_hash;
  }
  return { valid: true, head: previousHash, legacyRecords };
}
const r3 = record(rotatedSecret, postRotation.record_hash, 'merge', 'r3');
const mixedChain = [preRotation, postRotation, r3];
assert.deepStrictEqual(verifyChain(mixedChain),
  { valid: true, head: r3.record_hash, legacyRecords: 1 },
  'a chain written before the rotation and extended after it must verify, and count the legacy record');

/*
 * Falsify: drop the retired key and the pre-rotation record fails immediately.
 * That failure is precisely the false alarm the retired keyring prevents.
 */
const activeOnly = Object.freeze({ active: rotatedSecret, retired: Object.freeze([]) });
assert.strictEqual(
  verifyEvidenceRecord(activeOnly, preRotation.record_hash, GENESIS, repoKey,
    preRotation.kind, preRotation.recordId, preRotation.payload_hash).valid,
  false,
  'without the retired key a pre-rotation record reports as tampered, which is the regression being prevented'
);

/* Rotation must not weaken tamper detection anywhere in the chain. */
for (const index of [0, 1, 2]) {
  const tampered = mixedChain.map((row, position) =>
    position === index ? { ...row, payload_hash: hashJson({ record: 'tampered' }) } : row);
  assert.strictEqual(verifyChain(tampered).valid, false,
    `a tampered payload at position ${index} must still be detected after rotation`);
}
assert.strictEqual(verifyChain([postRotation, preRotation, r3]).valid, false,
  'reordering must still break the chain');

/* A record forged under an unheld key must verify under neither. */
const forged = record('an-attacker-secret-not-in-the-keyring', GENESIS, 'push', 'r1');
assert.strictEqual(check(forged, GENESIS).valid, false,
  'a record hashed with a key the operator does not hold must not verify');

/* Malformed and hostile inputs must not resolve to a valid record. */
for (const bad of ['', 'not-hex', 'a'.repeat(63), 'A'.repeat(64), null, undefined, 42, {}]) {
  assert.strictEqual(
    verifyEvidenceRecord(keyring, bad, GENESIS, repoKey, 'push', 'r1', hashJson({ record: 'r1' })).valid,
    false, `record hash ${JSON.stringify(bad)} must not verify`);
}
for (const badKeyring of [null, undefined, 'secret', 42, {}, { active: 42 }, { retired: 'nope' }]) {
  assert.strictEqual(
    verifyEvidenceRecord(badKeyring, preRotation.record_hash, GENESIS, repoKey,
      preRotation.kind, preRotation.recordId, preRotation.payload_hash).valid,
    false, `keyring ${JSON.stringify(badKeyring)} must not verify`);
}

/*
 * Retiring the legacy key is the point of separating it. Accepting the raw
 * session secret forever would leave a leaked SESSION_SECRET able to forge
 * evidence that verifies, so production must opt in deliberately.
 */
assert.strictEqual(acceptsLegacySessionKey({ NODE_ENV: 'production' }), false,
  'production must not accept the retired session key by default');
assert.strictEqual(acceptsLegacySessionKey({ NODE_ENV: 'production', NV_EVIDENCE_LEGACY_SESSION_KEY: 'true' }), true,
  'production must accept it only on an explicit opt-in');
assert.strictEqual(acceptsLegacySessionKey({}), true,
  'development keeps the compatibility path');
assert.strictEqual(acceptsLegacySessionKey({ NODE_ENV: 'development' }), true);

/* Only an exact opt-in counts; near-misses must not silently enable it. */
for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', 'true ', ' true', 'trueish', null, undefined, 0, 1, {}]) {
  assert.strictEqual(
    acceptsLegacySessionKey({ NODE_ENV: 'production', NV_EVIDENCE_LEGACY_SESSION_KEY: value }),
    typeof value === 'string' && value.trim() === 'true',
    `opt-in value ${JSON.stringify(value)} must be handled exactly`
  );
}
for (const bad of [null, undefined, 'env', 42]) {
  assert.strictEqual(acceptsLegacySessionKey(bad), true,
    'a missing environment must not be read as production');
}

/*
 * Rotating SESSION_SECRET moves the derived evidence key, so records written
 * under a previous secret must stay verifiable through an explicit, bounded
 * list of those secrets. Anything malformed must fail loudly at startup rather
 * than silently shrinking the keyring, because a silently missing key reads as
 * tampering later.
 */
const priorA = 'prior-session-secret-a-0123456789abcdef0123';
const priorB = 'prior-session-secret-b-0123456789abcdef0123';
assert.deepStrictEqual(parseRetiredSessionSecrets(''), []);
assert.deepStrictEqual(parseRetiredSessionSecrets('   '), []);
assert.deepStrictEqual(parseRetiredSessionSecrets(null), []);
assert.deepStrictEqual(parseRetiredSessionSecrets(undefined), []);
assert.deepStrictEqual(parseRetiredSessionSecrets('[]'), []);
assert.deepStrictEqual(parseRetiredSessionSecrets(JSON.stringify([priorA])), [priorA]);
assert.deepStrictEqual(parseRetiredSessionSecrets(JSON.stringify([priorA, priorB])), [priorA, priorB]);
assert.deepStrictEqual(parseRetiredSessionSecrets(JSON.stringify([priorA, priorA])), [priorA],
  'duplicates must collapse rather than widening the keyring');
assert(Object.isFrozen(parseRetiredSessionSecrets(JSON.stringify([priorA]))));

assert.throws(() => parseRetiredSessionSecrets('not json'), /must be valid JSON/);
assert.throws(() => parseRetiredSessionSecrets('{}'), /must be an array/);
assert.throws(() => parseRetiredSessionSecrets(JSON.stringify([priorA])+'x'), /must be valid JSON/);
assert.throws(() => parseRetiredSessionSecrets(JSON.stringify(Array(9).fill(priorA).map((v,i)=>v+i))), /at most 8/);
assert.throws(() => parseRetiredSessionSecrets(JSON.stringify([42])), /must be a string/);
assert.throws(() => parseRetiredSessionSecrets(JSON.stringify([null])), /must be a string/);
assert.throws(() => parseRetiredSessionSecrets(JSON.stringify(['too-short'])), /32 to 4096/);
assert.throws(() => parseRetiredSessionSecrets(JSON.stringify(['x'.repeat(4097)])), /32 to 4096/);
assert.deepStrictEqual(parseRetiredSessionSecrets(JSON.stringify(['y'.repeat(32)])), ['y'.repeat(32)],
  'exactly the minimum length must be accepted');

/*
 * A record written under a previous secret's derived key must verify once that
 * secret is supplied, and must not verify when it is missing. The second half is
 * the regression: without it a routine rotation makes the ledger accuse itself.
 */
const priorDerived = 'derived-from-prior-secret-0123456789abcdef';
const currentDerived = 'derived-from-current-secret-0123456789abcd';
const rotatedRecord = record(priorDerived, GENESIS, 'push', 'rotated');
assert.strictEqual(
  verifyEvidenceRecord({ active: currentDerived, retired: [priorDerived] },
    rotatedRecord.record_hash, GENESIS, repoKey, 'push', 'rotated', rotatedRecord.payload_hash).valid,
  true,
  'a record written before the secret rotation must verify once the prior key is supplied');
assert.strictEqual(
  verifyEvidenceRecord({ active: currentDerived, retired: [] },
    rotatedRecord.record_hash, GENESIS, repoKey, 'push', 'rotated', rotatedRecord.payload_hash).valid,
  false,
  'without the prior key a routine SESSION_SECRET rotation makes the ledger report tampering');

/*
 * The acceptance keyring and the diagnostic probe are assembled together,
 * because holding the same retired secrets in two hand-maintained lists is how
 * they drift: the keyring listed them and the probe did not, so a record signed
 * with a retired raw secret was reported as tampering rather than as a chain
 * still awaiting migration.
 *
 * The two have opposite jobs. The keyring decides what verifies. The probe only
 * explains a failure, so it always holds the pre-separation secrets -- knowing
 * why a record failed must never depend on being willing to accept it.
 */
const ledgerActive = 'derived-from-current-secret-0123456789abcd';
const rawCurrent = 'current-session-secret-0123456789abcdef0123';
const retiredJson = JSON.stringify([priorA, priorB]);

const openRing = evidenceKeyrings(
  { NODE_ENV: 'production', NV_EVIDENCE_LEGACY_SESSION_KEY: 'true', NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON: retiredJson },
  { sessionSecret: rawCurrent, ledgerSecret: ledgerActive }
);
const closedRing = evidenceKeyrings(
  { NODE_ENV: 'production', NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON: retiredJson },
  { sessionSecret: rawCurrent, ledgerSecret: ledgerActive }
);

assert.strictEqual(openRing.legacyAccepted, true);
assert.strictEqual(closedRing.legacyAccepted, false);
for (const ring of [openRing, closedRing]) {
  assert.strictEqual(ring.keyring.active, ledgerActive, 'the active key is always the derived ledger key');
  assert.strictEqual(ring.legacyProbe.active, rawCurrent, 'the probe always tests the raw session secret');
  assert(Object.isFrozen(ring.keyring.retired) && Object.isFrozen(ring.legacyProbe.retired));
}

/*
 * A record from before the key separation, written with a session secret that
 * has since been rotated away. This is the row the probe existed to explain and
 * could not: it is signed with neither the active key nor any derived key.
 */
const preSeparationRotated = record(priorA, GENESIS, 'webhook', 'pre-separation-rotated');
const verifyWith = (ring, row) => verifyEvidenceRecord(
  ring, row.record_hash, GENESIS, repoKey, row.kind, row.recordId, row.payload_hash
);

assert.strictEqual(verifyWith(closedRing.keyring, preSeparationRotated).valid, false,
  'declining the opt-in must still refuse a record signed with a retired raw secret');
assert.strictEqual(verifyWith(closedRing.legacyProbe, preSeparationRotated).valid, true,
  'the probe must recognise it, or the operator cannot tell an unmigrated chain from tampering');
assert.strictEqual(verifyWith(openRing.keyring, preSeparationRotated).valid, true,
  'opting in must accept it');

/* Opting in must not be required to explain a pre-separation record either. */
const preSeparationCurrent = record(rawCurrent, GENESIS, 'webhook', 'pre-separation-current');
assert.strictEqual(verifyWith(closedRing.keyring, preSeparationCurrent).valid, false);
assert.strictEqual(verifyWith(closedRing.legacyProbe, preSeparationCurrent).valid, true);

/* A record under a rotated-away derived key verifies outright: no opt-in needed. */
const rotatedDerived = record(deriveSecret(priorB, KEY_PURPOSES.EVIDENCE_LEDGER), GENESIS, 'webhook', 'rotated-derived');
assert.strictEqual(verifyWith(closedRing.keyring, rotatedDerived).valid, true,
  'supplying a prior secret must keep its derived key verifying without the pre-separation opt-in');

/* Forged records verify under nothing, which is what makes the ledger evidence. */
const forgedRecord = record('attacker-key-0123456789abcdef0123456789ab', GENESIS, 'webhook', 'forged');
for (const ring of [closedRing.keyring, closedRing.legacyProbe, openRing.keyring, openRing.legacyProbe]) {
  assert.strictEqual(verifyWith(ring, forgedRecord).valid, false, 'a forged record must verify under no key');
}

/* Without retired secrets the probe still covers the un-rotated legacy case. */
const bare = evidenceKeyrings({ NODE_ENV: 'production' }, { sessionSecret: rawCurrent, ledgerSecret: ledgerActive });
assert.deepStrictEqual(bare.keyring.retired, []);
assert.deepStrictEqual(bare.legacyProbe.retired, []);
assert.strictEqual(verifyWith(bare.legacyProbe, preSeparationCurrent).valid, true);

/* Malformed operator input must fail at startup rather than shrink the keyring. */
assert.throws(
  () => evidenceKeyrings({ NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON: 'not json' },
    { sessionSecret: rawCurrent, ledgerSecret: ledgerActive }),
  /must be valid JSON/
);

console.log('intelligence tests passed');
