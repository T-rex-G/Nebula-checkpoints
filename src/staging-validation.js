'use strict';

const crypto = require('crypto');
const path = require('path');
const { stableJson } = require('./governance-model');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

const EVIDENCE_SCHEMA_VERSION = '1.2.0';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARTIFACTS = 32;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const VALID_STATUSES = new Set(['pass', 'fail', 'blocked']);
const VALID_TIERS = new Set(['source', 'runtime', 'browser', 'neon', 'provider', 'destructive', 'delivery']);

const CHECKS = deepFreeze([
  { id: 'source.full-suite', tier: 'source', required: true, destructive: false, title: 'Complete source and contract suite', command: 'node scripts/test-matrix.js --allow-missing-dependencies --require-subject --report staging/evidence/source-full-suite.json' },
  { id: 'runtime.npm-ci', tier: 'runtime', required: true, destructive: false, title: 'Clean dependency installation', command: 'npm ci' },
  { id: 'runtime.audit', tier: 'runtime', required: true, destructive: false, title: 'Production dependency audit', command: 'node scripts/audit-production.js' },
  { id: 'runtime.express-suite', tier: 'runtime', required: true, destructive: false, title: 'Express startup and integration suite', command: 'node scripts/test-matrix.js --require-all --require-subject --report staging/evidence/runtime-full-suite.json' },
  { id: 'runtime.package-release', tier: 'runtime', required: true, destructive: false, title: 'Archiver release packaging suite', command: 'npm run test:release && npm run package:release -- dist' },
  { id: 'browser.desktop', tier: 'browser', required: true, destructive: false, title: 'Desktop browser workflows', command: 'npx playwright test test/e2e/pwa.spec.js test/e2e/security-foundation.spec.js --project=desktop' },
  { id: 'browser.mobile', tier: 'browser', required: true, destructive: false, title: 'Mobile browser workflows', command: 'npx playwright test test/e2e/task20-accessibility.spec.js --project=mobile --grep "More navigation activates"' },
  { id: 'browser.keyboard-a11y', tier: 'browser', required: true, destructive: false, title: 'Keyboard and accessibility workflows', command: 'npx playwright test test/e2e/task20-accessibility.spec.js --project=desktop --grep "keyboard"' },
  { id: 'browser.offline-boundary', tier: 'browser', required: true, destructive: false, title: 'Governance live-only offline boundary', command: 'npx playwright test test/e2e/task20-accessibility.spec.js --project=desktop --grep "offline"' },
  { id: 'neon.migration-rehearsal', tier: 'neon', required: true, destructive: false, title: 'Fresh and upgrade migration rehearsal', command: 'task20://neon/migration-rehearsal/v1' },
  { id: 'neon.concurrent-governance', tier: 'neon', required: true, destructive: false, title: 'Concurrent review, activation and exception races', command: 'task20://neon/concurrent-governance/v1' },
  { id: 'neon.outbox-workers', tier: 'neon', required: true, destructive: false, title: 'Concurrent outbox worker leasing', command: 'task20://neon/outbox-workers/v1' },
  { id: 'provider.github-pat-oauth', tier: 'provider', required: true, destructive: false, title: 'GitHub PAT or OAuth compatibility', command: 'task20://provider/github-pat-oauth/v1' },
  { id: 'provider.gitlab', tier: 'provider', required: true, destructive: false, title: 'GitLab compatibility', command: 'task20://provider/gitlab/v1' },
  { id: 'provider.gitea', tier: 'provider', required: true, destructive: false, title: 'Gitea compatibility', command: 'task20://provider/gitea/v1' },
  { id: 'provider.github-app', tier: 'provider', required: false, destructive: false, title: 'Optional GitHub App execution', command: 'task20://provider/github-app/v1' },
  { id: 'destructive.batch-and-recovery', tier: 'destructive', required: true, destructive: true, title: 'Sandbox batch mutation and recovery', command: 'task20://destructive/batch-and-recovery/v1' },
  { id: 'destructive.receive-pack-lfs', tier: 'destructive', required: true, destructive: true, title: 'Sandbox Git receive-pack and Git LFS ladders', command: 'task20://destructive/receive-pack-lfs/v1' },
  { id: 'delivery.ssrf-rebinding', tier: 'delivery', required: true, destructive: false, title: 'Webhook SSRF and DNS rebinding resistance', command: 'task20://delivery/ssrf-rebinding/v1' },
  { id: 'delivery.retry-restart-deadletter', tier: 'delivery', required: true, destructive: false, title: 'Webhook retry, restart and dead-letter recovery', command: 'task20://delivery/retry-restart-deadletter/v1' }
]);

const CATALOG_HASH = sha256(stableJson(CHECKS));

function cleanText(value, label, max = 500) {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function cleanHex(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return text;
}

function cleanSubjectHash(value, label = 'subjectHash') {
  const text = cleanHex(value, label);
  if (/^0{64}$/.test(text)) throw new TypeError(`${label} must be a non-zero SHA-256 digest`);
  return text;
}

function cleanArtifactPath(value, label) {
  const text = cleanText(value, label, 240);
  if (text.includes('\\') || path.posix.isAbsolute(text)) throw new TypeError(`${label} must be a relative POSIX path`);
  const normalized = path.posix.normalize(text);
  if (normalized !== text || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new TypeError(`${label} contains unsafe traversal`);
  }
  if (!normalized.startsWith('staging/evidence/')) throw new TypeError(`${label} must be under staging/evidence/`);
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new TypeError(`${label} contains an unsafe segment`);
  }
  return normalized;
}

function parseTime(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} is invalid`);
  return date;
}

function catalogById() {
  return new Map(CHECKS.map(check => [check.id, check]));
}

function expectedSubject(options = {}) {
  if (!options.expectedSubjectHash) throw new TypeError('expectedSubjectHash is required');
  return cleanSubjectHash(options.expectedSubjectHash, 'expectedSubjectHash');
}

function normalizeArtifacts(input, status, options, context) {
  const artifacts = Array.isArray(input) ? input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`artifacts[${index}] must be an object`);
    return {
      path: cleanArtifactPath(item.path, `artifacts[${index}].path`),
      sha256: cleanHex(item.sha256, `artifacts[${index}].sha256`)
    };
  }) : [];

  if (artifacts.length > MAX_ARTIFACTS) throw new TypeError(`artifacts cannot exceed ${MAX_ARTIFACTS} entries`);
  if (new Set(artifacts.map(item => item.path)).size !== artifacts.length) throw new TypeError('artifact paths must be unique');
  if (new Set(artifacts.map(item => item.sha256)).size !== artifacts.length) throw new TypeError('artifact hashes must be unique');
  if (status !== 'blocked' && artifacts.length === 0) throw new TypeError(`${status} evidence requires at least one artifact file`);
  if (artifacts.length && typeof options.verifyArtifact !== 'function') throw new TypeError('verifyArtifact is required when evidence contains artifacts');

  const ordered = artifacts.sort((a, b) => a.path.localeCompare(b.path));
  for (const artifact of ordered) {
    if (options.verifyArtifact(artifact, context) !== true) throw new TypeError(`artifact verification failed: ${artifact.path}`);
  }
  return ordered;
}

function normalizeEvidenceRecord(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('evidence record must be an object');
  if (input.schemaVersion !== EVIDENCE_SCHEMA_VERSION) throw new TypeError(`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  if (cleanHex(input.catalogHash, 'catalogHash') !== CATALOG_HASH) throw new TypeError('catalogHash does not match the current staging catalog');
  const subjectHash = cleanSubjectHash(input.subjectHash, 'subjectHash');
  if (subjectHash !== expectedSubject(options)) throw new TypeError('subjectHash does not match the expected release candidate');

  const checks = catalogById();
  const checkId = cleanText(input.checkId, 'checkId', 120);
  const check = checks.get(checkId);
  if (!check) throw new TypeError(`Unknown staging check: ${checkId}`);
  const status = String(input.status || '').trim().toLowerCase();
  if (!VALID_STATUSES.has(status)) throw new TypeError('status must be pass, fail or blocked');
  const startedAt = parseTime(input.startedAt, 'startedAt');
  const completedAt = parseTime(input.completedAt, 'completedAt');
  if (completedAt < startedAt) throw new TypeError('completedAt cannot precede startedAt');
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  if (completedAt.getTime() > now.getTime() + 5 * 60 * 1000) throw new TypeError('completedAt is in the future');

  const environmentFingerprint = cleanHex(input.environmentFingerprint, 'environmentFingerprint');
  const commandHash = cleanHex(input.commandHash, 'commandHash');
  if (commandHash !== sha256(check.command)) throw new TypeError(`commandHash does not match the prescribed command for ${checkId}`);

  const artifacts = normalizeArtifacts(input.artifacts, status, options, { check, subjectHash });
  const reason = status === 'pass' ? null : cleanText(input.reason, 'reason', 1000);

  return deepFreeze({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    catalogHash: CATALOG_HASH,
    subjectHash,
    checkId,
    tier: check.tier,
    required: check.required,
    destructive: check.destructive,
    status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    stale: now.getTime() - completedAt.getTime() > maxAgeMs,
    environmentFingerprint,
    commandHash,
    artifacts,
    reason
  });
}

function evaluateStagingGate(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const subjectHash = expectedSubject(options);
  const normalized = records.map(record => normalizeEvidenceRecord(record, { ...options, expectedSubjectHash: subjectHash }));
  const duplicateIds = normalized.map(record => record.checkId).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length) throw new TypeError(`Duplicate staging evidence: ${[...new Set(duplicateIds)].join(', ')}`);
  const byId = new Map(normalized.map(record => [record.checkId, record]));
  const orderedEvidence = CHECKS.map(check => byId.get(check.id)).filter(Boolean);
  const evidenceHash = sha256(stableJson(orderedEvidence));
  const results = CHECKS.map(check => {
    const evidence = byId.get(check.id) || null;
    const effectiveStatus = !evidence ? 'missing' : evidence.stale ? 'stale' : evidence.status;
    return deepFreeze({ ...check, effectiveStatus, evidence });
  });
  const blocking = results.filter(result => result.required && result.effectiveStatus !== 'pass');
  const optionalIssues = results.filter(result => !result.required && !['pass', 'missing'].includes(result.effectiveStatus));
  const reportCore = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    catalogHash: CATALOG_HASH,
    subjectHash,
    evidenceHash,
    gate: blocking.length ? 'closed' : 'open',
    passed: results.filter(result => result.effectiveStatus === 'pass').length,
    required: CHECKS.filter(check => check.required).length,
    blockingCheckIds: blocking.map(result => result.id),
    optionalIssueIds: optionalIssues.map(result => result.id),
    results
  };
  return deepFreeze({
    ...reportCore,
    verifiedAt: (options.now instanceof Date ? options.now : new Date(options.now || Date.now())).toISOString(),
    reportHash: sha256(stableJson(reportCore))
  });
}

function createBlockedEvidencePlan(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const subjectHash = cleanSubjectHash(input.subjectHash, 'subjectHash');
  const fingerprint = cleanHex(input.environmentFingerprint || sha256('unconfigured-staging-environment'), 'environmentFingerprint');
  return CHECKS.map(check => ({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    catalogHash: CATALOG_HASH,
    subjectHash,
    checkId: check.id,
    status: 'blocked',
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    environmentFingerprint: fingerprint,
    commandHash: sha256(check.command),
    artifacts: [],
    reason: 'Required staging environment or credential was not supplied; this is not a pass.'
  }));
}

module.exports = deepFreeze({
  EVIDENCE_SCHEMA_VERSION,
  DEFAULT_MAX_AGE_MS,
  MAX_ARTIFACTS,
  MAX_ARTIFACT_BYTES,
  VALID_TIERS,
  CHECKS,
  CATALOG_HASH,
  sha256,
  cleanArtifactPath,
  normalizeEvidenceRecord,
  evaluateStagingGate,
  createBlockedEvidencePlan
});
