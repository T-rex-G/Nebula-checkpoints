#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  EVIDENCE_SCHEMA_VERSION,
  CATALOG_HASH,
  MAX_ARTIFACT_BYTES,
  createBlockedEvidencePlan,
  evaluateStagingGate
} = require('../src/staging-validation');

function usage() {
  process.stderr.write('Usage:\n  NV_STAGING_SUBJECT_SHA256=<sha256> node scripts/staging-gate.js plan [output.json]\n  NV_STAGING_SUBJECT_SHA256=<sha256> node scripts/staging-gate.js verify <evidence.json> [report.json]\n');
  process.exitCode = 2;
}

function writeJson(target, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (target) fs.writeFileSync(path.resolve(target), text, { mode: 0o600 });
  else process.stdout.write(text);
}

function subjectHashFromEnvironment() {
  const value = String(process.env.NV_STAGING_SUBJECT_SHA256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value) || /^0{64}$/.test(value)) {
    throw new TypeError('NV_STAGING_SUBJECT_SHA256 must contain the exact non-zero release-candidate SHA-256 digest');
  }
  return value;
}

function readEvidenceEnvelope(inputPath, subjectHash) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('evidence file must be a versioned object envelope');
  if (parsed.schemaVersion !== EVIDENCE_SCHEMA_VERSION) throw new TypeError(`evidence schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  if (parsed.catalogHash !== CATALOG_HASH) throw new TypeError('evidence catalogHash does not match the current catalog');
  if (parsed.subjectHash !== subjectHash) throw new TypeError('evidence subjectHash does not match NV_STAGING_SUBJECT_SHA256');
  if (!Array.isArray(parsed.records)) throw new TypeError('evidence records must be an array');
  return parsed.records;
}

function hashFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function createArtifactVerifier(rootDirectory) {
  const root = fs.realpathSync(path.resolve(rootDirectory));
  let evidencePrefix = null;
  return artifact => {
    if (!evidencePrefix) {
      const evidenceDirectory = path.join(root, 'staging', 'evidence');
      const evidenceMetadata = fs.lstatSync(evidenceDirectory);
      if (!evidenceMetadata.isDirectory() || evidenceMetadata.isSymbolicLink()) {
        throw new TypeError('staging/evidence must be a regular non-symlink directory');
      }
      evidencePrefix = `${fs.realpathSync(evidenceDirectory)}${path.sep}`;
    }
    const absolute = path.resolve(root, ...artifact.path.split('/'));
    const metadata = fs.lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError(`artifact must be a regular non-symlink file: ${artifact.path}`);
    if (metadata.size > MAX_ARTIFACT_BYTES) throw new TypeError(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${artifact.path}`);
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(evidencePrefix)) throw new TypeError(`artifact resolves outside staging/evidence: ${artifact.path}`);
    if (hashFileSync(real) !== artifact.sha256) throw new TypeError(`artifact hash mismatch: ${artifact.path}`);
    return true;
  };
}

function main() {
  const [command, inputPath, outputPath] = process.argv.slice(2);
  if (!command) return usage();
  const subjectHash = subjectHashFromEnvironment();

  if (command === 'plan') {
    const target = inputPath || 'staging/TASK_20_EVIDENCE_TEMPLATE.json';
    writeJson(target, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      catalogHash: CATALOG_HASH,
      subjectHash,
      generatedAt: new Date().toISOString(),
      instructions: 'Replace a blocked record only with evidence produced for this exact subject and prescribed command. Pass and fail records require verified non-secret artifact files under staging/evidence/. Never include credentials, cookies, secret URLs or provider response bodies.',
      records: createBlockedEvidencePlan({ subjectHash })
    });
    return;
  }

  if (command === 'verify' && inputPath) {
    const records = readEvidenceEnvelope(inputPath, subjectHash);
    const report = evaluateStagingGate(records, {
      expectedSubjectHash: subjectHash,
      verifyArtifact: createArtifactVerifier(process.cwd())
    });
    writeJson(outputPath, report);
    if (report.gate !== 'open') process.exitCode = 1;
    return;
  }

  usage();
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
