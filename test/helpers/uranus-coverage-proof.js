'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createCoverageProof, verifyCoverageProof } = require('../../apps/api/src/modules/uranus/application/coverage-proof.ts');
const { stableJson } = require('../../packages/contracts/src/canonical-json.ts');
const { classifyApiRequest } = require('../../packages/contracts/src/offline-cache-policy.ts');

const SCOPE = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const audit = {
  id: '479f60c5-5bdf-4cc7-9857-96aaa08896c1', commitSha: 'a'.repeat(40), engine: '3.0.0', ruleset: 'b'.repeat(64),
  auditedAt: '2026-01-12T04:03:02.000Z', analysisComplete: true,
  files: { read: 3, eligible: 3, complete: true }, findings: { total: 2, stored: 2 }, watch: null
};

function checkCoverageProof() {
  const proof = createCoverageProof(SCOPE, audit);
  const url = new URL('https://application.invalid/api/repo/Acme/Demo/code-audit/history/' + audit.id + '?proof=coverage');
  const offline = new Headers({ 'x-nv-offline-scope': 'a'.repeat(32), 'x-nv-offline-repo': 'github:Acme/Demo' });
  assert.equal(classifyApiRequest(url, 'GET', offline).mode, 'network-only', 'even authenticated offline bindings cannot cache a proof');
  const expected = { scope: SCOPE, commitSha: audit.commitSha, ruleset: audit.ruleset, digest: proof.digest };
  // Independent vector obtained with Python json.dumps(sort_keys=True, separators=(',', ':')) and hashlib.sha256.
  assert.equal(proof.digest, '6f28d4ac39ecfd39777668b129e97d5c686257e0cdeaf2fc87c5ba5ddb87b3e3');
  assert.equal(verifyCoverageProof(proof, expected), 'complete');
  for (const bad of [undefined, null, {}, { ...expected, digest: undefined }, { ...expected, ruleset: null }, { ...expected, scope: null }]) {
    assert.equal(verifyCoverageProof(proof, bad), 'invalid-expectations');
  }
  assert.equal(verifyCoverageProof(proof, { ...expected, digest: 'f'.repeat(64) }), 'untrusted-digest');
  for (const target of [{ scope: { ...SCOPE, repo: 'other' } }, { commitSha: '1'.repeat(40) }, { ruleset: '2'.repeat(64) }]) {
    assert.equal(verifyCoverageProof(proof, { ...expected, ...target }), 'target-mismatch');
  }
  for (const bad of [null, { ...proof, digest: '' }, { ...proof, extra: true }, { ...proof, decision: 'incomplete' },
    { ...proof, statement: { ...proof.statement, version: 2 } }, { ...proof, statement: { ...proof.statement, extra: 'data' } }]) {
    assert.equal(verifyCoverageProof(bad, expected), 'invalid-proof');
  }
  const cases = [
    [{ analysisComplete: null }, 'unrecorded'], [{ ruleset: null }, 'unrecorded'], [{ analysisComplete: false }, 'incomplete'],
    [{ files: { read: 2, eligible: 3, complete: false } }, 'incomplete'], [{ findings: { total: 2, stored: 1 } }, 'incomplete'],
    [{ watch: { state: 'partial', checkedAt: audit.auditedAt } }, 'incomplete'], [{ watch: { state: 'unavailable', checkedAt: audit.auditedAt } }, 'incomplete'],
    [{ watch: { state: 'ok', checkedAt: audit.auditedAt } }, 'complete']
  ];
  for (const [change, decision] of cases) {
    const changed = createCoverageProof(SCOPE, { ...audit, ...change });
    assert.equal(changed.decision, decision);
    assert.equal(verifyCoverageProof(changed, { ...expected, digest: changed.digest }), decision);
    assert.equal(verifyCoverageProof(changed, expected), 'untrusted-digest');
  }
  for (const change of [{ analysisComplete: undefined }, { files: { complete: true, eligible: 3, read: 2 } },
    { findings: { stored: 3, total: 2 } }, { files: { complete: true, eligible: null, read: null } }, { ruleset: 'unknown' }]) {
    assert.throws(() => createCoverageProof(SCOPE, { ...audit, ...change }));
  }
  const falseClaim = { statement: { ...proof.statement, analysisComplete: false }, decision: 'complete' };
  const recomputed = createHash('sha256').update(stableJson(falseClaim)).digest('hex');
  assert.equal(verifyCoverageProof({ ...falseClaim, digest: recomputed }, { ...expected, digest: recomputed }), 'invalid-proof');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uranus-proof-'));
  const file = path.join(dir, 'proof.json');
  const cli = path.resolve(__dirname, '../../scripts/uranus-verify-coverage.js');
  const run = (source, digest = proof.digest) => {
    fs.writeFileSync(file, source);
    return spawnSync(process.execPath, [cli, file, 'Acme/Demo', audit.commitSha, audit.ruleset, digest], { encoding: 'utf8' });
  };
  try {
    assert.equal(run(stableJson(proof)).status, 0);
    const partial = createCoverageProof(SCOPE, { ...audit, analysisComplete: false });
    assert.equal(run(stableJson(partial) + '\n', partial.digest).status, 2);
    assert.equal(run(stableJson(proof).replace('{"decision"', '{"decision":"incomplete","decision"')).status, 1, 'duplicate JSON keys are ambiguous');
    assert.equal(run(' '.repeat(8193) + stableJson(proof)).status, 1);
    assert.equal(run('broken JSON').status, 1);
    if (process.platform !== 'win32') {
      fs.writeFileSync(file, stableJson(proof));
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(file, link);
      assert.equal(spawnSync(process.execPath, [cli, link, 'Acme/Demo', audit.commitSha, audit.ruleset, proof.digest]).status, 1);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { audit, checkCoverageProof };
