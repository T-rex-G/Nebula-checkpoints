'use strict';

const crypto = require('crypto');
const { KEY_PURPOSES, deriveSecret } = require('./key-derivation');

const MAX_REASON_COUNT = 12;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function hmacJson(secret, value) {
  return crypto.createHmac('sha256', secret).update(stableJson(value)).digest('hex');
}

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

function verifyGithubSignature(secret, rawBody, signature) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function cleanText(value, max = 240) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/').slice(0, 1024);
}

function globToRegExp(pattern) {
  const p = cleanPath(pattern);
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        out += p[i + 1] === '/' ? '(?:.*/)?' : '.*';
        if (p[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

function pathMatches(pattern, candidate) {
  const p = cleanPath(pattern);
  const c = cleanPath(candidate);
  if (!p || !c) return false;
  if (!/[?*]/.test(p)) return c === p || c.startsWith(`${p}/`);
  try { return globToRegExp(p).test(c); } catch { return false; }
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

function referenceSha(reference) {
  const value = reference && (
    reference.object && (reference.object.sha || reference.object.id) ||
    reference.commit && (reference.commit.sha || reference.commit.id) ||
    reference.target && (reference.target.sha || reference.target.id) ||
    reference.sha || reference.id
  );
  return /^[0-9a-f]{40}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
}

function normalizeProviderBranches(provider, branches) {
  const commitKey = provider === 'gitlab' || provider === 'gitea' ? 'id' : 'sha';
  return (Array.isArray(branches) ? branches : []).map(branch => ({
    name: branch && branch.name,
    protected: branch && branch.protected,
    sha: branch && branch.commit && branch.commit[commitKey] || ''
  }));
}

function canAcceptLiveClient(totalClients, keyClients, maxTotal = 100, maxPerKey = 5) {
  const total = Number(totalClients);
  const scoped = Number(keyClients);
  return Number.isFinite(total) && Number.isFinite(scoped) && total >= 0 && scoped >= 0 &&
    total < maxTotal && scoped < maxPerKey;
}

function normalizeGithubWebhook(eventName, payload = {}, deliveryId = '') {
  const repo = payload.repository || {};
  const actorObj = payload.sender || payload.pusher || payload.deployment && payload.deployment.creator || {};
  const actor = cleanText(actorObj.login || actorObj.name || payload.pusher && payload.pusher.name || 'unknown', 100);
  const base = {
    id: cleanText(deliveryId || crypto.randomUUID(), 100),
    provider: 'github',
    owner: cleanText(repo.owner && (repo.owner.login || repo.owner.name) || '', 100),
    repo: cleanText(repo.name || '', 100),
    eventType: cleanText(eventName || 'unknown', 80),
    action: cleanText(payload.action || '', 80),
    actor,
    targetType: 'repository',
    targetId: cleanText(repo.full_name || '', 220),
    ref: '',
    beforeSha: '',
    afterSha: '',
    paths: [],
    forced: false,
    defaultBranch: cleanText(repo.default_branch || '', 200),
    timestamp: new Date().toISOString(),
    summary: '',
    metadata: {}
  };

  if (eventName === 'ping') {
    base.targetType = 'webhook';
    base.targetId = cleanText(payload.hook_id || payload.zen || 'ping');
    base.summary = 'GitHub webhook connection verified';
  } else if (eventName === 'push') {
    base.targetType = 'branch';
    base.ref = cleanText(payload.ref || '', 300).replace(/^refs\/heads\//, '');
    base.targetId = base.ref || 'unknown branch';
    base.beforeSha = cleanText(payload.before || '', 80);
    base.afterSha = cleanText(payload.after || '', 80);
    base.forced = !!payload.forced;
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const providerCommitCount = Number.isFinite(Number(payload.size)) ? Math.max(0, Number(payload.size)) : commits.length;
    const distinctCommitCount = Number.isFinite(Number(payload.distinct_size)) ? Math.max(0, Number(payload.distinct_size)) : providerCommitCount;
    const inspectedCommits = commits.slice(0, 100);
    const paths = [];
    let pathsTruncated = commits.length > inspectedCommits.length || providerCommitCount > commits.length;
    for (const commit of inspectedCommits) {
      for (const key of ['added', 'modified', 'removed']) {
        const changed = Array.isArray(commit[key]) ? commit[key] : [];
        if (changed.length > 300) pathsTruncated = true;
        for (const p of changed.slice(0, 300)) paths.push(cleanPath(p));
      }
    }
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (uniquePaths.length > 500) pathsTruncated = true;
    base.paths = uniquePaths.slice(0, 500);
    base.summary = `${actor} pushed ${providerCommitCount} commit(s) to ${base.ref || 'a branch'}`;
    base.metadata = {
      compare: cleanText(payload.compare || '', 500),
      created: !!payload.created,
      deleted: !!payload.deleted,
      headMessage: cleanText(payload.head_commit && payload.head_commit.message || '', 500),
      commitCount: providerCommitCount,
      distinctCommitCount,
      commitsIncluded: commits.length,
      commitsInspected: inspectedCommits.length,
      pathsTruncated
    };
  } else if (eventName === 'pull_request') {
    const pr = payload.pull_request || {};
    base.targetType = 'pull_request';
    base.targetId = String(pr.number || payload.number || '');
    base.ref = cleanText(pr.head && pr.head.ref || '', 300);
    base.afterSha = cleanText(pr.head && pr.head.sha || '', 80);
    base.summary = `${actor} ${base.action || 'updated'} pull request #${base.targetId}`;
    base.metadata = {
      title: cleanText(pr.title || '', 500),
      baseRef: cleanText(pr.base && pr.base.ref || '', 300),
      merged: !!pr.merged,
      draft: !!pr.draft,
      changedFiles: Number(pr.changed_files || 0)
    };
  } else if (eventName === 'workflow_run') {
    const run = payload.workflow_run || {};
    base.targetType = 'workflow';
    base.targetId = String(run.id || '');
    base.ref = cleanText(run.head_branch || '', 300);
    base.afterSha = cleanText(run.head_sha || '', 80);
    base.summary = `${cleanText(run.name || 'Workflow', 180)} ${cleanText(run.conclusion || run.status || base.action || 'updated', 80)}`;
    base.metadata = {
      name: cleanText(run.name || '', 200),
      status: cleanText(run.status || '', 80),
      conclusion: cleanText(run.conclusion || '', 80),
      event: cleanText(run.event || '', 80),
      url: cleanText(run.html_url || '', 500)
    };
  } else if (eventName === 'issues') {
    const issue = payload.issue || {};
    base.targetType = 'issue';
    base.targetId = String(issue.number || '');
    base.summary = `${actor} ${base.action || 'updated'} issue #${base.targetId}`;
    base.metadata = { title: cleanText(issue.title || '', 500), state: cleanText(issue.state || '', 50) };
  } else if (eventName === 'release') {
    const release = payload.release || {};
    base.targetType = 'release';
    base.targetId = cleanText(release.tag_name || release.id || '', 200);
    base.summary = `${actor} ${base.action || 'updated'} release ${base.targetId}`;
    base.metadata = { name: cleanText(release.name || '', 300), draft: !!release.draft, prerelease: !!release.prerelease };
  } else if (eventName === 'create' || eventName === 'delete') {
    base.targetType = cleanText(payload.ref_type || 'reference', 80);
    base.targetId = cleanText(payload.ref || '', 300);
    base.ref = base.targetId;
    base.summary = `${actor} ${eventName}d ${base.targetType} ${base.targetId}`;
  } else if (eventName === 'deployment' || eventName === 'deployment_status') {
    const deployment = payload.deployment || {};
    const status = payload.deployment_status || {};
    base.targetType = 'deployment';
    base.targetId = String(deployment.id || status.id || '');
    base.ref = cleanText(deployment.ref || '', 300);
    base.afterSha = cleanText(deployment.sha || '', 80);
    base.summary = `${actor} ${eventName === 'deployment' ? 'created deployment' : `reported deployment ${status.state || 'status'}`}`;
    base.metadata = { environment: cleanText(deployment.environment || status.environment || '', 200), state: cleanText(status.state || '', 80) };
  } else if (eventName === 'repository_vulnerability_alert') {
    const alert = payload.alert || {};
    base.targetType = 'vulnerability';
    base.targetId = String(alert.id || payload.action || 'alert');
    base.summary = `Repository vulnerability alert ${base.action || 'updated'}`;
    base.metadata = { affectedRange: cleanText(alert.affected_range || '', 300), externalIdentifier: cleanText(alert.external_identifier || '', 200) };
  } else {
    base.targetType = cleanText(eventName || 'event', 80);
    base.targetId = cleanText(payload.action || repo.full_name || deliveryId || 'event', 220);
    base.summary = `${actor} triggered ${eventName}${base.action ? `:${base.action}` : ''}`;
  }

  return base;
}

function riskForEvent(event, context = {}) {
  let score = 0;
  const reasons = [];
  const add = (points, code, message) => {
    score += points;
    if (reasons.length < MAX_REASON_COUNT) reasons.push({ points, code, message });
  };
  const protectedPatterns = Array.isArray(context.protectedPatterns) ? context.protectedPatterns : [];
  const defaultBranch = cleanText(context.defaultBranch || event.defaultBranch || '', 200);

  if (event.eventType === 'push') {
    if (event.forced) add(45, 'FORCE_PUSH', 'A force push rewrote branch history.');
    if (event.metadata && event.metadata.deleted) add(50, 'BRANCH_DELETED', 'A branch reference was deleted.');
    if (defaultBranch && event.ref === defaultBranch && event.metadata && event.metadata.deleted) add(35, 'DEFAULT_BRANCH_DELETED', 'The repository default branch was deleted.');
    if (defaultBranch && event.ref === defaultBranch) add(10, 'DEFAULT_BRANCH_WRITE', 'The change directly affected the default branch.');
    const protectedHits = (event.paths || []).filter(p => protectedPatterns.some(pattern => pathMatches(pattern, p))).slice(0, 12);
    if (protectedHits.length) add(45, 'PROTECTED_PATH_CHANGED', `Protected path change detected: ${protectedHits.slice(0, 3).join(', ')}${protectedHits.length > 3 ? '…' : ''}`);
    const workflowHits = (event.paths || []).filter(p => p === '.github/workflows' || p.startsWith('.github/workflows/'));
    if (workflowHits.length) add(35, 'WORKFLOW_CHANGED', 'A GitHub Actions workflow file changed.');
    const secretHits = (event.paths || []).filter(p => /(^|\/)(\.env|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.key)$/i.test(p));
    if (secretHits.length) add(50, 'SENSITIVE_FILE_PATH', 'A commonly sensitive credential or environment file path changed.');
    if (event.metadata && event.metadata.pathsTruncated) add(25, 'CHANGESET_TRUNCATED', 'The push contained more commits or file paths than the webhook payload could safely inspect.');
  }
  if (event.eventType === 'delete') add(event.targetType === 'branch' ? 35 : 20, 'REFERENCE_DELETED', `A ${event.targetType || 'reference'} was deleted.`);
  if (event.eventType === 'workflow_run') {
    const conclusion = String(event.metadata && event.metadata.conclusion || '').toLowerCase();
    if (['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required'].includes(conclusion)) add(30, 'WORKFLOW_FAILED', `Workflow ended with ${conclusion}.`);
  }
  if (event.eventType === 'deployment_status') {
    const state = String(event.metadata && event.metadata.state || '').toLowerCase();
    if (['failure', 'error', 'inactive'].includes(state)) add(30, 'DEPLOYMENT_FAILED', `Deployment state is ${state}.`);
  }
  if (event.eventType === 'repository_vulnerability_alert') add(45, 'VULNERABILITY_ALERT', 'GitHub reported a repository vulnerability alert.');
  if (event.actor === 'unknown') add(15, 'UNKNOWN_ACTOR', 'The event did not include a recognized actor.');
  if (event.eventType === 'pull_request' && event.metadata && event.metadata.merged && event.metadata.draft) add(20, 'DRAFT_MERGED', 'A draft pull request appears to have been merged.');

  score = Math.min(100, score);
  const severity = score >= 70 ? 'critical' : score >= 35 ? 'warning' : 'normal';
  return { score, severity, reasons };
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
  stableJson,
  hashJson,
  hmacJson,
  EVIDENCE_ACTIVE_KEY_ID,
  EVIDENCE_LEGACY_KEY_ID,
  acceptsLegacySessionKey,
  parseRetiredSessionSecrets,
  evidenceKeyrings,
  evidenceRecordHash,
  verifyEvidenceRecord,
  verifyGithubSignature,
  normalizeGithubWebhook,
  riskForEvent,
  pathMatches,
  protectedPatternsForRepository,
  referenceSha,
  normalizeProviderBranches,
  canAcceptLiveClient,
  normalizeRepoPath,
  normalizeBranchName,
  normalizeCommitSha,
  lfsAttributePattern,
  compareSnapshots,
  riskForAccessSurface,
  shortestPath,
  cleanText,
  cleanPath
};
