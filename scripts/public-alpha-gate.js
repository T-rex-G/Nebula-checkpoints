#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const registry = require('../config/public-alpha-capabilities.json');
const { APP_VERSION, PRODUCT_NAME } = require('../src/version');
const { loadMigrations } = require('../src/migrations');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');
const { validateEvidenceEnvelope } = require('../src/qualification-evidence');
const {
  QUALIFICATION_SCHEMA_VERSION,
  qualificationCatalog,
  validateQualificationRecord,
  verifyQualification
} = require('../src/public-alpha-qualification');

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const QUALIFICATION_NAME = `${PRODUCT_NAME}-v${APP_VERSION}-Public-Alpha-Qualification.json`;
const CLOSEOUT_NAME = `${PRODUCT_NAME}-v${APP_VERSION}-Public-Alpha-Closeout.md`;

function parseArgs(argv) {
  const values = Array.isArray(argv) ? argv.map(value => String(value)) : [];
  const command = values[0] || '';
  if (command === 'plan') {
    if (values.length !== 1) throw new TypeError('plan does not accept arguments');
    return { command };
  }
  if (command === 'verify') {
    if (values.length !== 2) throw new TypeError('verify requires one evidence path');
    if (!path.isAbsolute(values[1])) throw new TypeError('evidence must use an absolute path');
    return { command, evidence: path.normalize(values[1]) };
  }
  if (command === 'close') {
    if (values.length !== 4 || values[2] !== '--output-dir' || !values[3]) {
      throw new TypeError('close requires EVIDENCE --output-dir PATH');
    }
    if (!path.isAbsolute(values[1]) || !path.isAbsolute(values[3])) {
      throw new TypeError('evidence and --output-dir must use an absolute path');
    }
    return {
      command,
      evidence: path.normalize(values[1]),
      outputDir: path.normalize(values[3])
    };
  }
  throw new TypeError('Command must be plan, verify, or close');
}

function readBoundedRegularFile(filePath, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
  } catch {
    throw new TypeError(`${label} must be a readable regular non-symlink file`);
  }
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile()) throw new TypeError(`${label} must be a regular non-symlink file`);
    if (metadata.size > maximumBytes) throw new TypeError(`${label} exceeds the safe size limit`);
    const chunks = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
    while (true) {
      const remaining = maximumBytes - total + 1;
      const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new TypeError(`${label} exceeds the safe size limit`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readEvidence(filePath) {
  const bytes = readBoundedRegularFile(filePath, MAX_RECORD_BYTES, 'evidence');
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TypeError('evidence must contain valid JSON');
  }
  return record;
}

function environmentBindings(env) {
  const subjectSha256 = String(env.NV_PUBLIC_ALPHA_SUBJECT_SHA256 || '').trim().toLowerCase();
  const sourceCommit = String(env.NV_PUBLIC_ALPHA_SOURCE_COMMIT || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(subjectSha256) || /^0{64}$/.test(subjectSha256)) {
    throw new TypeError('NV_PUBLIC_ALPHA_SUBJECT_SHA256 must bind the exact non-zero candidate digest');
  }
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || /^0{40}$/.test(sourceCommit)) {
    throw new TypeError('NV_PUBLIC_ALPHA_SOURCE_COMMIT must bind the exact non-zero source commit');
  }
  const targetVariables = Object.freeze({
    github: 'NV_PUBLIC_ALPHA_GITHUB_TARGET_SHA256',
    gitlab: 'NV_PUBLIC_ALPHA_GITLAB_TARGET_SHA256',
    gitea: 'NV_PUBLIC_ALPHA_GITEA_TARGET_SHA256',
    hosted: 'NV_PUBLIC_ALPHA_HOSTED_TARGET_SHA256'
  });
  const expectedAuthorizedTargets = {};
  for (const [target, variable] of Object.entries(targetVariables)) {
    const value = String(env[variable] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value) || /^0{64}$/.test(value)) {
      throw new TypeError(`${variable} must bind the exact signed target digest`);
    }
    expectedAuthorizedTargets[target] = value;
  }
  const operatorKeyId = String(env.NV_ALPHA17_OPERATOR_KEY_ID || '').trim();
  const operatorPublicKey = String(env.NV_ALPHA17_OPERATOR_PUBLIC_KEY_BASE64 || '').trim();
  if (
    !/^[a-zA-Z0-9._-]{3,80}$/.test(operatorKeyId) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(operatorPublicKey) ||
    operatorPublicKey.length > 4096
  ) {
    throw new TypeError('trusted Alpha.17 operator key ID and public key are required');
  }
  /*
   * The operator's restore witness is a required binding, not an optional
   * extra: the restore runner's own signature cannot be verified outside the
   * job that made it, so a run reaching this gate without a witness has no
   * checkable restore proof at all. Missing means no-go, never "skip it".
   */
  const witnessPath = String(env.NV_PUBLIC_ALPHA_RESTORE_WITNESS || '').trim();
  if (!witnessPath) {
    throw new TypeError('NV_PUBLIC_ALPHA_RESTORE_WITNESS must point at the operator restore witness');
  }
  let restoreWitness;
  try {
    restoreWitness = JSON.parse(
      readBoundedRegularFile(witnessPath, MAX_ARTIFACT_BYTES, 'restore witness').toString('utf8')
    );
  } catch (error) {
    throw new TypeError(`the operator restore witness could not be read: ${error.message}`);
  }
  return Object.freeze({
    subjectSha256,
    sourceCommit,
    expectedAuthorizedTargets: Object.freeze(expectedAuthorizedTargets),
    trustedOperatorKeys: Object.freeze({ [operatorKeyId]: operatorPublicKey }),
    restoreWitness
  });
}

function latestMigration() {
  const migrations = loadMigrations(path.join(__dirname, '..', 'db', 'migrations'));
  const latest = migrations.at(-1)?.id || '';
  if (!latest) throw new TypeError('no database migration is available');
  return latest;
}

function createArtifactVerifier() {
  return artifact => {
    if (!path.isAbsolute(artifact.path)) throw new TypeError('artifact paths must be absolute');
    const bytes = readBoundedRegularFile(artifact.path, MAX_ARTIFACT_BYTES, 'artifact');
    const observedSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (observedSha256 !== artifact.sha256) throw new TypeError('artifact hash does not match');
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new TypeError('artifact must contain a valid JSON evidence envelope');
    }
    return validateEvidenceEnvelope(parsed);
  };
}

function verifyRecord(record, env, now = new Date()) {
  const bindings = environmentBindings(env);
  const result = verifyQualification(record, {
    expectedVersion: APP_VERSION,
    expectedSubjectHash: bindings.subjectSha256,
    expectedSourceCommit: bindings.sourceCommit,
    expectedLatestMigration: latestMigration(),
    expectedAuthorizedTargets: bindings.expectedAuthorizedTargets,
    expectedDeploymentSha256: computeReleaseFingerprint(path.resolve(__dirname, '..')),
    trustedOperatorKeys: bindings.trustedOperatorKeys,
    restoreWitness: bindings.restoreWitness,
    now,
    registry,
    verifyArtifact: createArtifactVerifier()
  });
  return Object.freeze({ bindings, result, normalized: validateQualificationRecord(record) });
}

function planOutput() {
  return Object.freeze({
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    product: PRODUCT_NAME,
    version: APP_VERSION,
    catalog: qualificationCatalog(registry),
    commands: Object.freeze([
      Object.freeze({ key: 'clean-install', command: 'npm ci' }),
      Object.freeze({ key: 'syntax', command: 'npm run check:syntax' }),
      Object.freeze({ key: 'secret-scan', command: 'npm run check:secrets' }),
      Object.freeze({ key: 'unit-integration', command: 'npm test' }),
      Object.freeze({ key: 'browser', command: 'npm run test:e2e' }),
      Object.freeze({ key: 'production-audit', command: 'npm audit --omit=dev --audit-level=high' }),
      Object.freeze({ key: 'runtime-matrix', command: 'npm run test:public-alpha:matrix' }),
      Object.freeze({
        key: 'verify-qualification',
        command: 'node scripts/public-alpha-gate.js verify /absolute/path/to/public-alpha-evidence.json'
      }),
      Object.freeze({
        key: 'close-qualification',
        command: 'node scripts/public-alpha-gate.js close /absolute/path/to/public-alpha-evidence.json --output-dir /absolute/path/to/closeout'
      })
    ]),
    requirements: Object.freeze({
      subjectBinding: 'NV_PUBLIC_ALPHA_SUBJECT_SHA256',
      sourceBinding: 'NV_PUBLIC_ALPHA_SOURCE_COMMIT',
      liveTargetBindings: [
        'NV_PUBLIC_ALPHA_GITHUB_TARGET_SHA256',
        'NV_PUBLIC_ALPHA_GITLAB_TARGET_SHA256',
        'NV_PUBLIC_ALPHA_GITEA_TARGET_SHA256',
        'NV_PUBLIC_ALPHA_HOSTED_TARGET_SHA256'
      ],
      operatorTrustBinding: ['NV_ALPHA17_OPERATOR_KEY_ID', 'NV_ALPHA17_OPERATOR_PUBLIC_KEY_BASE64'],
      deploymentBinding: 'computed from the exact local release tree',
      evidenceMaxAgeHours: 72,
      evidenceFiles: 'regular non-symlink files',
      decision: 'go only when every catalog item and cleanup check passes'
    })
  });
}

function safeLimitations(record) {
  if (!Array.isArray(record.knownLimitations)) return [];
  return record.knownLimitations.map(value => String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\bhttps?:\/\/(?:github\.com|gitlab\.com|[^\s/]*gitea[^\s/]*)\/\S+/gi, '[redacted-provider-target]')
    .replace(/[#<>\\`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240))
    .filter(Boolean)
    .slice(0, 50);
}

function closeoutMarkdown(record, verification) {
  const { bindings, result } = verification;
  const limitations = safeLimitations(record);
  const lines = [
    `# ${PRODUCT_NAME} v${APP_VERSION} Public Alpha Closeout`,
    '',
    `Decision: **${result.decision}**`,
    '',
    `Subject SHA-256: \`${bindings.subjectSha256}\``,
    `Source commit: \`${bindings.sourceCommit}\``,
    `Evidence record hash: \`${result.recordHash}\``,
    '',
    `Provider evidence: ${result.checks.providerCapabilities}/${result.checks.providerCapabilities} passed`,
    `Hosted evidence: ${result.checks.hosted}/${result.checks.hosted} passed`,
    `Manual evidence: ${result.checks.manual}/${result.checks.manual} passed`,
    'Security findings: zero unresolved critical/high',
    'Cleanup: verified',
    '',
    '## Known limitations',
    ''
  ];
  if (limitations.length) lines.push(...limitations.map(item => `- ${item}`));
  else lines.push('- No limitation record was supplied.');
  lines.push('', 'This closeout contains sanitized qualification summaries only.', '');
  return lines.join('\n');
}

function assertSafeOutputDirectory(rawPath) {
  const resolved = path.resolve(rawPath);
  const filesystemRoot = path.parse(resolved).root;
  if (resolved === filesystemRoot || path.dirname(resolved) === filesystemRoot) {
    throw new TypeError('closeout output directory is too broad');
  }
  try {
    const metadata = fs.lstatSync(resolved);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError('closeout output directory must be a regular non-symlink directory');
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    fs.mkdirSync(resolved, { mode: 0o700 });
  }
  fs.chmodSync(resolved, 0o700);
  return fs.realpathSync(resolved);
}

function writeExclusive(filePath, content) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
}

function qualificationSummary(verification) {
  const { bindings, result } = verification;
  return Object.freeze({
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    product: PRODUCT_NAME,
    version: APP_VERSION,
    decision: result.decision,
    subjectSha256: bindings.subjectSha256,
    sourceCommit: bindings.sourceCommit,
    recordHash: result.recordHash,
    checks: result.checks
  });
}

function closeRecord(record, verification, outputDirectory) {
  const directory = assertSafeOutputDirectory(outputDirectory);
  const qualificationPath = path.join(directory, QUALIFICATION_NAME);
  const closeoutPath = path.join(directory, CLOSEOUT_NAME);
  const created = [];
  try {
    writeExclusive(qualificationPath, `${JSON.stringify(qualificationSummary(verification), null, 2)}\n`);
    created.push(qualificationPath);
    writeExclusive(closeoutPath, closeoutMarkdown(record, verification));
    created.push(closeoutPath);
  } catch (error) {
    for (const filePath of created) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    throw error;
  }
  return Object.freeze({
    ...qualificationSummary(verification),
    qualificationPath,
    closeoutPath
  });
}

function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.command === 'plan') return planOutput();
  const record = readEvidence(args.evidence);
  const verification = verifyRecord(record, env);
  if (args.command === 'verify') return qualificationSummary(verification);
  return closeRecord(verification.normalized, verification, args.outputDir);
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(run(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  parseArgs,
  run,
  createArtifactVerifier
});
