#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const registry = require('../config/public-alpha-capabilities.json');
const { APP_VERSION, PRODUCT_NAME } = require('../src/version');
const { loadMigrations } = require('../src/migrations');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');
const { validateEvidenceEnvelope, PROVIDER_CAPABILITY_REQUIREMENTS } = require('../src/qualification-evidence');

/*
 * The live targets a run has to bind, derived from the proof contract rather
 * than listed. A provider the contract asks nothing of has no leg to run and
 * therefore no signed target -- and a hardcoded list went stale the moment
 * Gitea's claims were withdrawn, demanding a digest for a target that no
 * longer exists.
 */
const LIVE_TARGETS = Object.freeze([
  ...Object.keys(PROVIDER_CAPABILITY_REQUIREMENTS)
    .filter(provider => Object.keys(PROVIDER_CAPABILITY_REQUIREMENTS[provider]).length > 0),
  'hosted'
]);
const TARGET_VARIABLES = Object.freeze(Object.fromEntries(
  LIVE_TARGETS.map(target => [target, `NV_PUBLIC_ALPHA_${target.toUpperCase()}_TARGET_SHA256`])
));
const {
  QUALIFICATION_SCHEMA_VERSION,
  MAX_EVIDENCE_AGE_MS,
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
  if (command === 'status') {
    if (values.length !== 2) throw new TypeError('status requires one evidence path');
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
  throw new TypeError('Command must be plan, status, verify, or close');
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
  const expectedAuthorizedTargets = {};
  for (const [target, variable] of Object.entries(TARGET_VARIABLES)) {
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
      liveTargetBindings: Object.values(TARGET_VARIABLES),
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

/*
 * A readiness view over a record that is not finished yet.
 *
 * Every gate has to pass for one frozen candidate, and every piece of evidence
 * ages out after MAX_EVIDENCE_AGE_MS. Verification enforces both, but it is
 * all-or-nothing: it raises on the first problem, so a record missing sixty of
 * its sixty-odd entries reports the same way as one missing a single manual
 * pass, and neither says how long the entries already collected have left.
 *
 * That is a scheduling problem being answered by a pass/fail tool. A campaign
 * against this gate needs a board: what is in hand, what is outstanding, and
 * when the oldest evidence in hand takes the whole attempt down with it.
 *
 * This deliberately re-decides nothing. It reads what a record claims and
 * reports it against the catalog and the clock; whether the evidence is real
 * is verification's business, and duplicating that judgement here would only
 * create a second opinion to drift from the first.
 */
function statusOutput(record, now = new Date()) {
  const catalog = qualificationCatalog(registry);
  const groups = {
    automated: catalog.automated.map(key => [`automated.${key}`, ['automated', key]]),
    hosted: catalog.hosted.map(key => [`hosted.${key}`, ['hosted', key]]),
    manual: catalog.manual.map(key => [`manual.${key}`, ['manual', key]]),
    providers: Object.entries(catalog.providers).flatMap(([provider, capabilities]) =>
      capabilities.map(capability => [
        `providers.${provider}.${capability}`,
        ['providers', provider, capability]
      ]))
  };

  const entryAt = pathParts => pathParts.reduce(
    (node, part) => (node && typeof node === 'object' ? node[part] : undefined),
    record
  );

  const deadlines = [];
  const summary = {};
  const outstanding = [];
  const expired = [];

  for (const [group, labels] of Object.entries(groups)) {
    let present = 0;
    for (const [label, pathParts] of labels) {
      const entry = entryAt(pathParts);
      if (!entry || typeof entry !== 'object' || typeof entry.completedAt !== 'string') {
        outstanding.push(label);
        continue;
      }
      present += 1;
      const completedAt = new Date(entry.completedAt);
      if (Number.isNaN(completedAt.getTime())) {
        expired.push({ label, reason: 'completedAt is not a timestamp' });
        continue;
      }
      const expiresAt = new Date(completedAt.getTime() + MAX_EVIDENCE_AGE_MS);
      if (expiresAt.getTime() <= now.getTime()) {
        expired.push({ label, completedAt: entry.completedAt, expiresAt: expiresAt.toISOString() });
        continue;
      }
      deadlines.push({ label, expiresAt });
    }
    summary[group] = { required: labels.length, present, outstanding: labels.length - present };
  }

  /*
   * The number the campaign actually runs on: the oldest evidence in hand
   * decides when the attempt has to be finished, because it ages out first and
   * takes the record with it.
   */
  deadlines.sort((left, right) => left.expiresAt - right.expiresAt);
  const earliest = deadlines[0] || null;

  const required = Object.values(summary).reduce((total, group) => total + group.required, 0);
  const present = Object.values(summary).reduce((total, group) => total + group.present, 0);

  return Object.freeze({
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    product: PRODUCT_NAME,
    version: APP_VERSION,
    generatedAt: now.toISOString(),
    evidenceWindowHours: MAX_EVIDENCE_AGE_MS / (60 * 60 * 1000),
    subjectSha256: typeof record.subjectSha256 === 'string' ? record.subjectSha256 : null,
    sourceCommit: typeof record.sourceCommit === 'string' ? record.sourceCommit : null,
    totals: { required, present, outstanding: required - present },
    groups: summary,
    campaignDeadline: earliest
      ? {
          expiresAt: earliest.expiresAt.toISOString(),
          hoursRemaining: Math.round(
            ((earliest.expiresAt.getTime() - now.getTime()) / (60 * 60 * 1000)) * 10
          ) / 10,
          setBy: earliest.label
        }
      : null,
    expired,
    outstanding,
    /*
     * Said out loud, because a green-looking board is the most dangerous thing
     * this command could produce.
     */
    note: 'Readiness only. Run verify for the authoritative decision; this command checks nothing about whether the evidence is genuine.'
  });
}

function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.command === 'plan') return planOutput();
  const record = readEvidence(args.evidence);
  if (args.command === 'status') return statusOutput(record);
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
