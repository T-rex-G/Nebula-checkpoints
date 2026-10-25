'use strict';

const crypto = require('crypto');
const { KEY_PURPOSES, deriveSecret } = require('../apps/api/src/platform/crypto/key-derivation.ts');
const { cleanPath, cleanText } = require('../apps/api/src/platform/values/text.ts');

const MAX_REASON_COUNT = 12;

function evidenceRecordHash(secret, previousHash, repoKey, kind, recordId, payloadHash) {
  return crypto.createHmac('sha256', secret)
    .update(`${previousHash}|${repoKey}|${kind}|${recordId}|${payloadHash}`)
    .digest('hex');
}

/*
 * The evidence ledger is tamper-evident, so a record that fails to reproduce
 * its hash is reported as tampering. That makes the hashing key part of the
 * record's meaning: rotating it would make every record written under the old
 * key accuse itself, which is the one false alarm this feature must not raise.
 *
 * Verification therefore tries the active key first and then any retired key,
 * and reports which one matched. This is the same shape the snapshot signatures
 * already use for rotation, and it needs no stored key column: the record hash
 * is an HMAC, so a record only verifies under a key the operator holds, and a
 * forged record verifies under none of them.
 */
const EVIDENCE_ACTIVE_KEY_ID = 'hkdf-v1';
const EVIDENCE_LEGACY_KEY_ID = 'legacy-session-secret';

function sameHex(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/*
 * Whether the raw session secret may still verify pre-separation records.
 *
 * Accepting it forever would undo half the point of separating the keys: a
 * leaked SESSION_SECRET could forge evidence that verifies. Production
 * therefore requires an explicit opt-in, which is the rule snapshot signatures
 * already apply to their legacy keys; development keeps the compatibility path
 * so a local chain keeps verifying.
 */
function acceptsLegacySessionKey(env) {
  const source = env && typeof env === 'object' ? env : {};
  if (String(source.NV_EVIDENCE_LEGACY_SESSION_KEY || '').trim() === 'true') return true;
  return source.NODE_ENV !== 'production';
}

/*
 * Prior SESSION_SECRET values, for verifying records written before a rotation.
 *
 * The evidence key is derived from SESSION_SECRET, so rotating that secret moves
 * the derived key and every record written under the old one stops reproducing
 * its hash. On a tamper-evident ledger that reads as tampering after nothing
 * worse than routine key hygiene, which is the same failure the retired key
 * already prevents for the pre-separation records.
 *
 * Operators therefore supply the previous secrets, bounded, and the caller
 * derives an evidence key from each. This mirrors the snapshot retired keyring.
 */
const MAX_RETIRED_SESSION_SECRETS = 8;
const MIN_SESSION_SECRET_BYTES = 32;
const MAX_SESSION_SECRET_BYTES = 4096;

function parseRetiredSessionSecrets(raw) {
  const source = String(raw == null ? '' : raw).trim();
  if (!source) return Object.freeze([]);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError('Retired evidence session secrets must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RETIRED_SESSION_SECRETS) {
    throw new TypeError(`Retired evidence session secrets must be an array of at most ${MAX_RETIRED_SESSION_SECRETS} values`);
  }
  const secrets = [];
  for (const value of parsed) {
    if (typeof value !== 'string') throw new TypeError('Each retired evidence session secret must be a string');
    const size = Buffer.byteLength(value, 'utf8');
    if (size < MIN_SESSION_SECRET_BYTES || size > MAX_SESSION_SECRET_BYTES) {
      throw new TypeError(`Each retired evidence session secret must contain ${MIN_SESSION_SECRET_BYTES} to ${MAX_SESSION_SECRET_BYTES} UTF-8 bytes`);
    }
    if (!secrets.includes(value)) secrets.push(value);
  }
  return Object.freeze(secrets);
}

/*
 * The two keyrings evidence verification needs, built from one description of
 * the operator's key history so they cannot disagree.
 *
 * `keyring` decides what verifies. `legacyProbe` only explains a failure: when a
 * record does not verify, it answers "was this written before the ledger key was
 * separated from SESSION_SECRET?" so the caller can report an unmigrated chain
 * rather than tampering.
 *
 * Their retired lists differ deliberately, and the difference is the point:
 *
 *   - `keyring.retired` always carries each supplied prior secret's *derived*
 *     evidence key, because a rotation is routine key hygiene and must not cost
 *     the ledger its history. It carries the *raw* secrets only on the explicit
 *     pre-separation opt-in, since accepting those forever would leave a leaked
 *     SESSION_SECRET able to forge evidence that verifies.
 *
 *   - `legacyProbe.retired` always carries the raw secrets, opt-in or not.
 *     Diagnosis is not acceptance: the probe never widens what verifies, and an
 *     operator who declines the opt-in still has to be able to tell an
 *     unmigrated chain from a forged one.
 *
 * Assembling both here is what keeps that true. Held as two separate lists at
 * the call site they drifted, and a record signed with a retired raw secret was
 * reported as tampering with no indication that migration was what it needed.
 */
function evidenceKeyrings(env, { sessionSecret, ledgerSecret } = {}) {
  const legacyAccepted = acceptsLegacySessionKey(env);
  const source = env && typeof env === 'object' ? env : {};
  const retiredSessionSecrets = parseRetiredSessionSecrets(source.NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON);
  return Object.freeze({
    legacyAccepted,
    keyring: Object.freeze({
      active: ledgerSecret,
      retired: Object.freeze([
        ...retiredSessionSecrets.map(secret => deriveSecret(secret, KEY_PURPOSES.EVIDENCE_LEDGER)),
        ...(legacyAccepted ? [sessionSecret, ...retiredSessionSecrets] : [])
      ])
    }),
    legacyProbe: Object.freeze({
      active: sessionSecret,
      retired: Object.freeze([...retiredSessionSecrets])
    })
  });
}

function verifyEvidenceRecord(keyring, recordHash, previousHash, repoKey, kind, recordId, payloadHash) {
  const supplied = String(recordHash || '');
  const miss = Object.freeze({ valid: false, keyId: null, legacy: false });
  if (!/^[0-9a-f]{64}$/.test(supplied) || !keyring || typeof keyring !== 'object') return miss;
  const expected = secret => evidenceRecordHash(secret, previousHash, repoKey, kind, recordId, payloadHash);
  const active = typeof keyring.active === 'string' ? keyring.active : '';
  if (active && sameHex(supplied, expected(active))) {
    return Object.freeze({ valid: true, keyId: EVIDENCE_ACTIVE_KEY_ID, legacy: false });
  }
  for (const secret of Array.isArray(keyring.retired) ? keyring.retired : []) {
    if (typeof secret === 'string' && secret && sameHex(supplied, expected(secret))) {
      return Object.freeze({ valid: true, keyId: EVIDENCE_LEGACY_KEY_ID, legacy: true });
    }
  }
  return miss;
}

function protectedPatternsForRepository(protectedMap, owner, repo) {
  const map = protectedMap && typeof protectedMap === 'object' ? protectedMap : {};
  const requested = `${cleanText(owner, 100)}/${cleanText(repo, 100)}`.toLowerCase();
  if (requested === '/') return [];
  const key = Object.keys(map).find(candidate => String(candidate).toLowerCase() === requested);
  return key && Array.isArray(map[key])
    ? map[key].map(pattern => cleanPath(pattern)).filter(Boolean)
    : [];
}

function normalizeRepoPath(value, label = 'path') {
  const raw = String(value == null ? '' : value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
  if (!raw || raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw) || raw.endsWith('/') ||
      raw.split('/').some(part => !part || part === '.' || part === '..')) {
    const error = new Error(`Invalid repository ${label}`);
    error.status = 400;
    error.code = 'INVALID_REPOSITORY_PATH';
    throw error;
  }
  return raw;
}

function normalizeBranchName(value, label = 'branch') {
  const name = String(value == null ? '' : value);
  if (!name || name === '@' || name.length > 255 || /[\u0000-\u0020\u007f~^:?*\\]/.test(name) || name.includes('[') ||
      name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.includes('..') ||
      name.includes('//') || name.includes('@{') ||
      name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    const error = new Error(`Invalid ${label} name`);
    error.status = 400;
    error.code = 'INVALID_BRANCH_NAME';
    throw error;
  }
  return name;
}

function normalizeCommitSha(value, label = 'commit SHA') {
  const sha = String(value == null ? '' : value);
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    const error = new Error(`Invalid ${label}`);
    error.status = 400;
    error.code = 'INVALID_COMMIT_SHA';
    throw error;
  }
  return sha.toLowerCase();
}

function lfsAttributePattern(repoPath) {
  return '/' + normalizeRepoPath(repoPath)
    .replace(/[\\*?\[\]#]/g, ch => `\\${ch}`)
    .replace(/ /g, '\\ ');
}

function compareNamedObjects(baselineItems, currentItems, key = 'name', value = 'sha') {
  const baseline = new Map((Array.isArray(baselineItems) ? baselineItems : [])
    .filter(item => item && item[key]).map(item => [String(item[key]), item]));
  const current = new Map((Array.isArray(currentItems) ? currentItems : [])
    .filter(item => item && item[key]).map(item => [String(item[key]), item]));
  const unchanged = [], move = [], recreate = [], preserve = [];
  for (const [name, expected] of baseline) {
    const actual = current.get(name);
    if (!actual) recreate.push({ name, expected: expected[value] || '', current: '' });
    else if (String(actual[value] || '') === String(expected[value] || '')) unchanged.push({ name, sha: expected[value] || '' });
    else move.push({ name, expected: expected[value] || '', current: actual[value] || '' });
  }
  for (const [name, actual] of current) if (!baseline.has(name)) preserve.push({ name, current: actual[value] || '' });
  return { unchanged, move, recreate, preserve };
}

function compareSnapshots(baselineSnapshot = {}, currentSnapshot = {}) {
  const ownerA = cleanText(baselineSnapshot.owner || '', 100).toLowerCase();
  const ownerB = cleanText(currentSnapshot.owner || '', 100).toLowerCase();
  const repoA = cleanText(baselineSnapshot.repo || '', 100).toLowerCase();
  const repoB = cleanText(currentSnapshot.repo || '', 100).toLowerCase();
  const providerA = cleanText(baselineSnapshot.provider || '', 40).toLowerCase();
  const providerB = cleanText(currentSnapshot.provider || '', 40).toLowerCase();
  const providerCompatible = !providerA || !providerB || providerA === providerB;
  const compatible = !!ownerA && !!repoA && ownerA === ownerB && repoA === repoB && providerCompatible;
  const refs = compareNamedObjects(baselineSnapshot.refs, currentSnapshot.refs);
  const tags = compareNamedObjects(baselineSnapshot.tags, currentSnapshot.tags);
  const baseManifest = baselineSnapshot.manifest && Array.isArray(baselineSnapshot.manifest.files)
    ? baselineSnapshot.manifest.files : [];
  const currentManifest = currentSnapshot.manifest && Array.isArray(currentSnapshot.manifest.files)
    ? currentSnapshot.manifest.files : [];
  const fileDiff = compareNamedObjects(baseManifest, currentManifest, 'path', 'sha');
  const files = {
    unchanged: fileDiff.unchanged.map(item => ({ path: item.name, sha: item.sha })),
    modified: fileDiff.move.map(item => ({ path: item.name, expected: item.expected, current: item.current })),
    restore: fileDiff.recreate.map(item => ({ path: item.name, expected: item.expected })),
    preserve: fileDiff.preserve.map(item => ({ path: item.name, current: item.current }))
  };
  const counts = {
    refsToMove: refs.move.length,
    refsToRecreate: refs.recreate.length,
    refsUnchanged: refs.unchanged.length,
    newerRefsPreserved: refs.preserve.length,
    tagsChanged: tags.move.length + tags.recreate.length,
    filesModified: files.modified.length,
    filesToRestore: files.restore.length,
    newerFilesPreserved: files.preserve.length
  };
  return {
    compatible,
    repository: compatible ? `${baselineSnapshot.owner}/${baselineSnapshot.repo}` : '',
    refs,
    tags,
    files,
    counts,
    manifestCompared: !!(baseManifest.length || currentManifest.length),
    truncated: !!(baselineSnapshot.manifest && baselineSnapshot.manifest.truncated) || !!(currentSnapshot.manifest && currentSnapshot.manifest.truncated)
  };
}

function riskForAccessSurface(surface = {}) {
  let score = 0;
  const reasons = [];
  const add = (points, code, message) => {
    score += points;
    if (reasons.length < MAX_REASON_COUNT) reasons.push({ points, code, message });
  };
  const deployKeys = Array.isArray(surface.deployKeys) ? surface.deployKeys : [];
  const webhooks = Array.isArray(surface.webhooks) ? surface.webhooks : [];
  const collaborators = Array.isArray(surface.collaborators) ? surface.collaborators : [];
  const writable = deployKeys.filter(key => key && key.readOnly === false);
  if (writable.length) add(Math.min(60, 30 + (writable.length - 1) * 10), 'WRITABLE_DEPLOY_KEY', `${writable.length} deploy key(s) can write to the repository.`);
  const unverified = deployKeys.filter(key => key && key.verified === false);
  if (unverified.length) add(15, 'UNVERIFIED_DEPLOY_KEY', `${unverified.length} deploy key(s) are not verified.`);
  const insecure = webhooks.filter(hook => hook && hook.insecureSsl === true);
  if (insecure.length) add(40, 'INSECURE_WEBHOOK_TLS', `${insecure.length} webhook(s) disable TLS certificate verification.`);
  const inactive = webhooks.filter(hook => hook && hook.active === false);
  if (inactive.length) add(8, 'INACTIVE_WEBHOOK', `${inactive.length} inactive webhook(s) remain configured.`);
  const admins = collaborators.filter(c => c && String(c.permission || '').toLowerCase() === 'admin');
  if (admins.length > 8) add(10, 'BROAD_ADMIN_ACCESS', `${admins.length} collaborators have repository administration permission.`);
  if (surface.partial) add(12, 'ACCESS_INVENTORY_PARTIAL', 'One or more access surfaces could not be enumerated with the current token.');
  score = Math.min(100, score);
  return { score, severity: score >= 70 ? 'critical' : score >= 35 ? 'warning' : 'normal', reasons };
}

function shortestPath(nodes, edges, startId, endId) {
  const ids = new Set((nodes || []).map(n => n.id));
  if (!ids.has(startId) || !ids.has(endId)) return null;
  if (startId === endId) return { nodeIds: [startId], edges: [] };
  const adjacency = new Map();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of edges || []) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    adjacency.get(edge.source).push({ next: edge.target, edge });
    adjacency.get(edge.target).push({ next: edge.source, edge: { ...edge, reversed: true } });
  }
  const queue = [startId];
  const prev = new Map([[startId, null]]);
  while (queue.length) {
    const cur = queue.shift();
    for (const item of adjacency.get(cur) || []) {
      if (prev.has(item.next)) continue;
      prev.set(item.next, { node: cur, edge: item.edge });
      if (item.next === endId) {
        const nodeIds = [endId];
        const pathEdges = [];
        let p = endId;
        while (p !== startId) {
          const step = prev.get(p);
          pathEdges.unshift(step.edge);
          p = step.node;
          nodeIds.unshift(p);
        }
        return { nodeIds, edges: pathEdges };
      }
      queue.push(item.next);
    }
  }
  return null;
}

module.exports = {
  EVIDENCE_ACTIVE_KEY_ID,
  EVIDENCE_LEGACY_KEY_ID,
  acceptsLegacySessionKey,
  parseRetiredSessionSecrets,
  evidenceKeyrings,
  evidenceRecordHash,
  verifyEvidenceRecord,
  protectedPatternsForRepository,
  normalizeRepoPath,
  normalizeBranchName,
  normalizeCommitSha,
  lfsAttributePattern,
  compareSnapshots,
  riskForAccessSurface,
  shortestPath
};
