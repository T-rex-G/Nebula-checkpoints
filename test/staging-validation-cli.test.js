'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  CHECKS,
  CATALOG_HASH,
  EVIDENCE_SCHEMA_VERSION,
  sha256
} = require('../src/staging-validation');

const root = path.resolve(__dirname, '..');
const gateScript = path.join(root, 'scripts', 'staging-gate.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-staging-cli-'));
const subjectHash = sha256('exact-release-candidate');
const env = { ...process.env, NV_STAGING_SUBJECT_SHA256: subjectHash };
const planPath = path.join(temp, 'plan.json');
const reportPath = path.join(temp, 'report.json');

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

let result = spawnSync(process.execPath, [gateScript, 'plan', planPath], { cwd: root, env, encoding: 'utf8' });
assert.strictEqual(result.status, 0, result.stderr);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
assert.strictEqual(plan.schemaVersion, EVIDENCE_SCHEMA_VERSION);
assert.strictEqual(plan.catalogHash, CATALOG_HASH);
assert.strictEqual(plan.subjectHash, subjectHash);
assert.strictEqual(plan.records.length, CHECKS.length);
assert.ok(plan.records.every(record => record.status === 'blocked'));

result = spawnSync(process.execPath, [gateScript, 'verify', planPath, reportPath], { cwd: root, env, encoding: 'utf8' });
assert.strictEqual(result.status, 1, 'blocked plan must close the gate');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.strictEqual(report.gate, 'closed');
assert.strictEqual(report.subjectHash, subjectHash);

const forgedPath = path.join(temp, 'forged.json');
const forged = JSON.parse(JSON.stringify(plan));
forged.records = forged.records.map(record => ({
  ...record,
  status: 'pass',
  reason: undefined,
  commandHash: sha256('echo pass'),
  artifacts: [{ path: `staging/evidence/${record.checkId}.json`, sha256: sha256(`artifact:${record.checkId}`) }]
}));
fs.writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`);
result = spawnSync(process.execPath, [gateScript, 'verify', forgedPath], { cwd: root, env, encoding: 'utf8' });
assert.strictEqual(result.status, 2);
assert.match(result.stderr, /commandHash/);

const artifactDirectory = path.join(temp, 'staging', 'evidence');
fs.mkdirSync(artifactDirectory, { recursive: true });
const passingPath = path.join(temp, 'passing.json');
const passing = JSON.parse(JSON.stringify(plan));
passing.records = passing.records.map(record => {
  const safeName = `${record.checkId.replace(/[^a-z0-9.-]/gi, '-')}.json`;
  const relativeArtifact = `staging/evidence/${safeName}`;
  const absoluteArtifact = path.join(temp, ...relativeArtifact.split('/'));
  fs.writeFileSync(absoluteArtifact, `${JSON.stringify({ checkId: record.checkId, subjectHash })}\n`);
  return {
    ...record,
    status: 'pass',
    reason: undefined,
    artifacts: [{ path: relativeArtifact, sha256: fileHash(absoluteArtifact) }]
  };
});
fs.writeFileSync(passingPath, `${JSON.stringify(passing, null, 2)}\n`);
result = spawnSync(process.execPath, [gateScript, 'verify', passingPath, path.join(temp, 'passing-report.json')], { cwd: temp, env, encoding: 'utf8' });
assert.strictEqual(result.status, 0, result.stderr);

const firstArtifact = path.join(temp, ...passing.records[0].artifacts[0].path.split('/'));
fs.appendFileSync(firstArtifact, 'tampered\n');
result = spawnSync(process.execPath, [gateScript, 'verify', passingPath], { cwd: temp, env, encoding: 'utf8' });
assert.strictEqual(result.status, 2);
assert.match(result.stderr, /artifact hash mismatch/);

result = spawnSync(process.execPath, [gateScript, 'plan', path.join(temp, 'missing-subject.json')], {
  cwd: root,
  env: { ...process.env, NV_STAGING_SUBJECT_SHA256: '' },
  encoding: 'utf8'
});
assert.strictEqual(result.status, 2);
assert.match(result.stderr, /NV_STAGING_SUBJECT_SHA256/);

result = spawnSync(process.execPath, [gateScript, 'plan', path.join(temp, 'zero-subject.json')], {
  cwd: root,
  env: { ...process.env, NV_STAGING_SUBJECT_SHA256: '0'.repeat(64) },
  encoding: 'utf8'
});
assert.strictEqual(result.status, 2);
assert.match(result.stderr, /non-zero/);

fs.rmSync(temp, { recursive: true, force: true });
console.log('staging validation CLI tests passed');
