'use strict';

const crypto = require('crypto');
const fs = require('fs');
const registry = require('../config/public-alpha-capabilities.json');
const {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope
} = require('../src/qualification-evidence');
const { verifyLiveTargetBinding } = require('./verify-alpha17-authorization');

const MAX_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_CAPABILITY_REQUIREMENTS = deepFreeze({
  github: {
    'repository.read': ['repository-read'],
    'branches.read': ['default-branch-read'],
    'branches.write': ['disposable-branch-create', 'cleanup-absence'],
    'file.read': ['utf8-readback'],
    'file.write': ['expected-head-write', 'stale-head', 'permission-denial'],
    'file.delete': ['stale-head-delete', 'expected-head-delete', 'cleanup-absence']
  },
  gitlab: {
    'repository.read': ['repository-read'],
    'branches.read': ['default-branch-read'],
    'file.read': ['utf8-readback'],
    'file.write': ['expected-head-write', 'stale-head', 'permission-denial'],
    'file.delete': ['stale-head-delete', 'expected-head-delete', 'cleanup-absence']
  },
  gitea: {
    'repository.read': ['repository-read'],
    'branches.read': ['default-branch-read'],
    'file.read': ['utf8-readback'],
    'file.write': ['expected-head-write', 'stale-head', 'permission-denial'],
    'file.delete': ['stale-head-delete', 'expected-head-delete', 'cleanup-absence']
  }
});

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(input).digest('hex');
}

function requireSubjectHash(env = process.env) {
  const value = String(env.NV_PUBLIC_ALPHA_SUBJECT_SHA256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value) || /^0{64}$/.test(value)) {
    fail('exact public-alpha subject SHA-256 is required', 'ALPHA17_SUBJECT_INVALID');
  }
  return value;
}

function requireExactCommit(env = process.env) {
  const value = String(env.NV_PUBLIC_ALPHA_SOURCE_COMMIT || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value) || /^0{40}$/.test(value)) {
    fail('exact public-alpha source commit is required', 'ALPHA17_SOURCE_INVALID');
  }
  return value;
}

function requireEnvironment(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) fail(`${name} is required`, 'ALPHA17_ENVIRONMENT_INVALID');
  return value;
}

function assertDisposableTarget(target) {
  const runId = String(target.runId || '').trim();
  const repository = String(target.repository || '').trim();
  const branch = String(target.branch || '').trim();
  const defaultBranch = String(target.defaultBranch || '').trim();
  const actualRepository = String(target.actualRepository || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(runId)) fail('workflow run ID is invalid', 'ALPHA17_TARGET_NOT_DISPOSABLE');
  const prefix = `nvx-alpha17-${runId}`;
  const repositoryName = repository.split('/').at(-1) || '';
  if (
    !/^[^/\s]+\/[^/\s]+$/.test(repository) ||
    repository !== actualRepository ||
    !repositoryName.startsWith('nvx-alpha17-') ||
    !branch.startsWith(prefix) ||
    ['main', 'master', defaultBranch].includes(branch)
  ) {
    fail('provider target is not an exact disposable alpha.17 target', 'ALPHA17_TARGET_NOT_DISPOSABLE');
  }
  return Object.freeze({ runId, repository, branch, defaultBranch, prefix });
}

function assertExpectedHead(before, current) {
  const expected = String(before || '').trim().toLowerCase();
  const observed = String(current || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected) || !/^[0-9a-f]{40}$/.test(observed) || expected !== observed) {
    fail('provider branch head changed before mutation', 'ALPHA17_STALE_HEAD');
  }
  return observed;
}

function verifyUtf8Readback(expected, response) {
  const expectedBytes = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected), 'utf8');
  const responseBytes = Buffer.isBuffer(response) ? response : Buffer.from(response || '');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(responseBytes);
  } catch {
    fail('provider readback is not valid UTF-8', 'ALPHA17_READBACK_MISMATCH');
  }
  if (!crypto.timingSafeEqual(
    crypto.createHash('sha256').update(expectedBytes).digest(),
    crypto.createHash('sha256').update(responseBytes).digest()
  ) || expectedBytes.length !== responseBytes.length) {
    fail('provider readback bytes do not match', 'ALPHA17_READBACK_MISMATCH');
  }
  return true;
}

function hashArtifact(filePath) {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail('artifact must be a regular non-symlink file', 'ALPHA17_ARTIFACT_INVALID');
  return sha256(fs.readFileSync(filePath));
}

function sanitizeEvidence(value) {
  const forbiddenKey = /(credential|password|secret|authorization|cookie|repository|branch|filePath|url)/i;
  const forbiddenValue = /(authorization\s*:\s*bearer|postgres(?:ql)?:\/\/|\bgh[pousr]_|\bglpat-)/i;
  const claimLabel = /^(?:automated|hosted|manual)\.[a-z0-9][a-z0-9.-]*$|^providers\.(?:github|gitlab|gitea)\.[a-z0-9][a-z0-9.-]*$/;
  function sanitize(input, claims = false) {
    if (Array.isArray(input)) return input.map(item => sanitize(item));
    if (input && typeof input === 'object') {
      const output = {};
      for (const [key, child] of Object.entries(input)) {
        if (forbiddenKey.test(key) && !(claims && claimLabel.test(key))) continue;
        output[key] = sanitize(child, key === 'claims');
      }
      return output;
    }
    if (typeof input === 'string' && forbiddenValue.test(input)) return '[redacted]';
    return input;
  }
  return deepFreeze(sanitize(value));
}

function providerCapabilityRequirements(provider) {
  const deployment = registry.providers[provider] && registry.providers[provider]['hosted-alpha'];
  const requirements = PROVIDER_CAPABILITY_REQUIREMENTS[provider];
  if (!deployment || !requirements) fail('provider is not in the alpha.17 capability registry', 'ALPHA17_PROVIDER_INVALID');
  for (const capability of Object.keys(requirements)) {
    if (!Array.isArray(deployment[capability]) || deployment[capability][0] !== 'Supported') {
      fail('provider claim mapping conflicts with the capability registry', 'ALPHA17_PROVIDER_INVALID');
    }
  }
  return requirements;
}

function providerClaims(provider, checks, completedAt) {
  const requirements = providerCapabilityRequirements(provider);
  const checkStatus = new Map(checks.map(check => [check.key, check.status]));
  const capabilities = Object.keys(requirements).sort();
  const claims = {};
  for (const capability of capabilities) {
    if (requirements[capability].some(key => checkStatus.get(key) !== 'pass')) {
      fail(`provider evidence is missing a prerequisite for ${capability}`, 'ALPHA17_PROVIDER_CLAIM_INCOMPLETE');
    }
    claims[`providers.${provider}.${capability}`] = {
      status: 'pass',
      cleanupVerified: true,
      completedAt
    };
  }
  return Object.freeze({ capabilities, claims });
}

function statusClass(status) {
  const numeric = Number(status);
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599
    ? `${Math.floor(numeric / 100)}xx`
    : 'unknown';
}

async function readBoundedJson(response) {
  if (response.status === 204) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) fail('provider response exceeds the safe limit', 'ALPHA17_PROVIDER_RESPONSE_INVALID');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('provider response exceeds the safe limit', 'ALPHA17_PROVIDER_RESPONSE_INVALID');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) return null;
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    fail('provider returned malformed JSON', 'ALPHA17_PROVIDER_RESPONSE_INVALID');
  }
}

async function requestJson(fetchImpl, url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    fail('provider API URL must use HTTPS without embedded credentials', 'ALPHA17_PROVIDER_URL_INVALID');
  }
  const response = await fetchImpl(parsed, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body == null ? undefined : JSON.stringify(options.body),
    redirect: 'error',
    signal: options.signal
  });
  const allowed = new Set(options.allowedStatuses || [200]);
  const data = await readBoundedJson(response);
  if (!allowed.has(response.status)) {
    if ([401, 403].includes(response.status)) fail('provider denied the mutation credential', 'ALPHA17_PERMISSION_DENIED');
    if ([409, 412, 422].includes(response.status)) fail('provider rejected a stale mutation', 'ALPHA17_STALE_HEAD');
    fail(`provider request failed with ${statusClass(response.status)}`, 'ALPHA17_PROVIDER_REQUEST_FAILED');
  }
  return Object.freeze({ status: response.status, statusClass: statusClass(response.status), data });
}

async function cleanupDisposableBranch(client, target, paths) {
  let branch = await client.getBranch(target.branch, 'mutation');
  if (!branch) return true;
  for (const filePath of paths) {
    const file = await client.readFile(target.branch, filePath, 'mutation');
    if (!file) continue;
    branch = await client.getBranch(target.branch, 'mutation');
    await client.deleteFile({
      branch: target.branch,
      path: filePath,
      fileSha: file.sha,
      expectedHead: branch.sha,
      credential: 'mutation'
    });
  }
  await client.deleteBranch(target.branch, 'mutation');
  return (await client.getBranch(target.branch, 'mutation')) === null;
}

async function runProviderQualification({ provider, client, env = process.env, now = () => new Date() }) {
  if (!client) fail('provider client is required', 'ALPHA17_PROVIDER_INVALID');
  const subjectSha256 = requireSubjectHash(env);
  const sourceCommit = requireExactCommit(env);
  const runId = requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_RUN_ID');
  const repository = requireEnvironment(env, 'NV_ALPHA17_REPOSITORY');
  const branchName = requireEnvironment(env, 'NV_ALPHA17_BRANCH');
  const repositoryName = repository.split('/').at(-1) || '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !repositoryName.startsWith('nvx-alpha17-')) {
    fail('provider repository is not a pre-created disposable alpha.17 target', 'ALPHA17_TARGET_NOT_DISPOSABLE');
  }
  const apiUrl = requireEnvironment(env, `NV_ALPHA17_${provider.toUpperCase()}_API_URL`);
  const targetBinding = verifyLiveTargetBinding({
    jobName: provider,
    target: { repository, apiUrl },
    signedTargetHash: requireEnvironment(env, 'NV_ALPHA17_SIGNED_TARGET_SHA256')
  });
  const startedAt = now().toISOString();
  const checks = [];
  const repositoryState = await client.getRepository('mutation');
  checks.push({ key: 'repository-read', status: 'pass', statusClass: '2xx' });
  const target = assertDisposableTarget({
    runId,
    repository,
    branch: branchName,
    defaultBranch: repositoryState.defaultBranch,
    actualRepository: repositoryState.fullName
  });
  const defaultBranch = await client.getBranch(target.defaultBranch, 'mutation');
  if (!defaultBranch) fail('provider default branch is unavailable', 'ALPHA17_PROVIDER_REQUEST_FAILED');
  checks.push({ key: 'default-branch-read', status: 'pass', statusClass: '2xx' });

  const proofPath = `${target.prefix}-proof.txt`;
  const permissionPath = `${target.prefix}-permission.txt`;
  const proofBytes = Buffer.from('Nebulaverse-X alpha.17 UTF-8 qualification proof\n', 'utf8');
  let cleanupVerified = false;
  let operationError = null;

  try {
    await client.createBranch(target.branch, defaultBranch.sha, 'mutation');
    checks.push({ key: 'disposable-branch-create', status: 'pass', statusClass: '2xx' });

    const before = await client.getBranch(target.branch, 'mutation');
    assertExpectedHead(defaultBranch.sha, before.sha);
    const written = await client.writeFile({
      branch: target.branch,
      path: proofPath,
      content: proofBytes,
      expectedHead: before.sha,
      credential: 'mutation'
    });
    const afterWrite = await client.getBranch(target.branch, 'mutation');
    assertExpectedHead(written.commitSha, afterWrite.sha);
    checks.push({ key: 'expected-head-write', status: 'pass', statusClass: '2xx' });
    const readback = await client.readFile(target.branch, proofPath, 'mutation');
    verifyUtf8Readback(proofBytes, readback.content);
    checks.push({
      key: 'utf8-readback',
      status: 'pass',
      statusClass: readback.statusClass,
      bytes: proofBytes.length,
      contentSha256: sha256(proofBytes)
    });

    let staleRejected = false;
    try {
      assertExpectedHead(before.sha, afterWrite.sha);
      await client.writeFile({
        branch: target.branch,
        path: proofPath,
        content: proofBytes,
        expectedHead: before.sha,
        credential: 'mutation'
      });
    } catch (error) {
      if (error.code !== 'ALPHA17_STALE_HEAD') throw error;
      staleRejected = true;
    }
    const afterStale = await client.getBranch(target.branch, 'mutation');
    const staleZeroCommit = staleRejected && afterStale.sha === afterWrite.sha;
    checks.push({ key: 'stale-head', status: staleZeroCommit ? 'pass' : 'fail', zeroCommit: staleZeroCommit });
    if (!staleZeroCommit) fail('stale-head attempt changed the branch', 'ALPHA17_STALE_HEAD_PROOF_FAILED');

    let permissionRejected = false;
    try {
      await client.writeFile({
        branch: target.branch,
        path: permissionPath,
        content: proofBytes,
        expectedHead: afterStale.sha,
        credential: 'readOnly'
      });
    } catch (error) {
      if (error.code !== 'ALPHA17_PERMISSION_DENIED') throw error;
      permissionRejected = true;
    }
    const afterPermission = await client.getBranch(target.branch, 'mutation');
    const permissionZeroCommit = permissionRejected && afterPermission.sha === afterStale.sha;
    checks.push({ key: 'permission-denial', status: permissionZeroCommit ? 'pass' : 'fail', zeroCommit: permissionZeroCommit });
    if (!permissionZeroCommit) fail('read-only credential changed the branch', 'ALPHA17_PERMISSION_SCOPE_INVALID');

    const currentFile = await client.readFile(target.branch, proofPath, 'mutation');
    let staleDeleteRejected = false;
    try {
      await client.deleteFile({
        branch: target.branch,
        path: proofPath,
        fileSha: currentFile.sha,
        expectedHead: before.sha,
        credential: 'mutation'
      });
    } catch (error) {
      if (error.code !== 'ALPHA17_STALE_HEAD') throw error;
      staleDeleteRejected = true;
    }
    const afterStaleDelete = await client.getBranch(target.branch, 'mutation');
    const retainedAfterStaleDelete = await client.readFile(target.branch, proofPath, 'mutation');
    const staleDeleteZeroCommit = Boolean(
      staleDeleteRejected &&
      afterStaleDelete &&
      afterStaleDelete.sha === afterPermission.sha &&
      retainedAfterStaleDelete &&
      retainedAfterStaleDelete.sha === currentFile.sha
    );
    checks.push({
      key: 'stale-head-delete',
      status: staleDeleteZeroCommit ? 'pass' : 'fail',
      zeroCommit: staleDeleteZeroCommit,
      fileRetained: Boolean(retainedAfterStaleDelete)
    });
    if (!staleDeleteZeroCommit) {
      fail('stale-head delete changed the branch or file', 'ALPHA17_DELETE_PROOF_FAILED');
    }

    const deleted = await client.deleteFile({
      branch: target.branch,
      path: proofPath,
      fileSha: currentFile.sha,
      expectedHead: afterStaleDelete.sha,
      credential: 'mutation'
    });
    const afterDelete = await client.getBranch(target.branch, 'mutation');
    const absentAfterDelete = await client.readFile(target.branch, proofPath, 'mutation');
    const deleteBoundToObservedHead = Boolean(
      deleted &&
      /^[0-9a-f]{40}$/.test(deleted.commitSha) &&
      deleted.statusClass === '2xx' &&
      afterDelete &&
      deleted.commitSha === afterDelete.sha &&
      afterDelete.sha !== afterStaleDelete.sha &&
      absentAfterDelete === null
    );
    checks.push({
      key: 'expected-head-delete',
      status: deleteBoundToObservedHead ? 'pass' : 'fail',
      statusClass: deleted && deleted.statusClass,
      headAdvanced: Boolean(afterDelete && afterDelete.sha !== afterStaleDelete.sha),
      fileAbsent: absentAfterDelete === null
    });
    if (!deleteBoundToObservedHead) {
      fail('delete result is not bound to the observed post-delete head', 'ALPHA17_DELETE_PROOF_FAILED');
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      cleanupVerified = await cleanupDisposableBranch(client, target, [permissionPath, proofPath]);
    } catch {
      cleanupVerified = false;
    }
  }

  checks.push({ key: 'cleanup-absence', status: cleanupVerified ? 'pass' : 'fail' });
  if (!cleanupVerified) fail('provider cleanup is incomplete', 'ALPHA17_CLEANUP_INCOMPLETE');
  if (operationError) throw operationError;

  const completedAt = now().toISOString();
  const proof = providerClaims(provider, checks, completedAt);
  const core = sanitizeEvidence({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    artifactType: 'provider-live',
    status: 'pass',
    cleanupVerified: true,
    subjectSha256,
    sourceCommit,
    originId: `workflow-${runId}-${provider}`,
    provider,
    capabilities: proof.capabilities,
    authorizedTargetSha256: targetBinding.targetHash,
    targetHash: sha256(`${repository}\n${branchName}\n${proofPath}`),
    checks,
    claims: proof.claims,
    startedAt,
    completedAt,
    nodeVersion: process.versions.node
  });
  validateEvidenceEnvelope(core);
  return deepFreeze({ ...core, artifactSha256: sha256(stableJson(core)) });
}

module.exports = Object.freeze({
  requireSubjectHash,
  requireExactCommit,
  requireEnvironment,
  sanitizeEvidence,
  assertDisposableTarget,
  assertExpectedHead,
  verifyUtf8Readback,
  hashArtifact,
  requestJson,
  providerCapabilityRequirements,
  providerClaims,
  runProviderQualification
});
