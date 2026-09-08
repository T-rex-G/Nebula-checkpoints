'use strict';

const crypto = require('crypto');
const fs = require('fs');
const registry = require('../config/public-alpha-capabilities.json');
const {
  EVIDENCE_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_REQUIREMENTS,
  providerProbeKeys,
  validateEvidenceEnvelope
} = require('../src/qualification-evidence');
const { verifyLiveTargetBinding } = require('./verify-alpha17-authorization');

const MAX_RESPONSE_BYTES = 256 * 1024;
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

/*
 * A provider acknowledges a mutation before every one of its read paths is
 * guaranteed to show it. GitHub says so of the contents API in its own docs,
 * and the first live run of this gate died on it: the delete returned 200 with
 * a well-formed commit, cleanup then removed the branch cleanly, and the three
 * bindings taken immediately afterwards did not all agree. Reproduced by hand
 * against the same repository with seconds between calls, every binding held.
 *
 * So the observation converges instead of being taken once. The assertions are
 * unchanged and just as strict -- the head must BE the delete commit, the file
 * must BE gone -- but the provider is allowed a moment to answer consistently
 * rather than being failed for answering slowly. If it never converges the
 * gate still fails, and now says which binding never held.
 *
 * This is only ever used where a mutation MUST become visible. It is
 * deliberately not used on the stale-head and permission-denial proofs: those
 * assert that nothing changed, and a lagging read there returns the old state,
 * which is the answer they expect. Polling for a change we require not to
 * happen would be waiting to be lied to.
 */
const OBSERVATION_ATTEMPTS = 5;
const OBSERVATION_BACKOFF_MS = 400;

function pause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function observe(read, satisfied, attempts = OBSERVATION_ATTEMPTS) {
  let value = await read();
  for (let attempt = 1; attempt < attempts && !satisfied(value); attempt += 1) {
    await pause(OBSERVATION_BACKOFF_MS * attempt);
    value = await read();
  }
  return value;
}

function unmetBindings(bindings) {
  return Object.entries(bindings).filter(([, held]) => !held).map(([name]) => name);
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
    if (Array.isArray(input)) return input.map(item => sanitize(item, claims));
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
  /*
   * A provider the contract asks nothing of cannot be qualified, and saying so
   * here is the difference between a clear refusal and a confusing one. Gitea
   * is in this state deliberately: its five claims were withdrawn because no
   * live run had ever established them, so a run against it would produce an
   * artifact with no claims at all, which the evidence validator rejects much
   * further downstream as "claims are missing or invalid".
   *
   * Restore its contract entry when there is an instance to earn it against,
   * and this stops firing.
   */
  if (Object.keys(requirements).length === 0) {
    fail('provider declares no capabilities for the live proof contract to establish', 'ALPHA17_PROVIDER_NOT_CONTRACTED');
  }
  for (const capability of Object.keys(requirements)) {
    if (
      !Array.isArray(deployment[capability]) ||
      deployment[capability][0] !== 'Supported' ||
      deployment[capability][1] !== 'Provider-verified'
    ) {
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
    /*
     * Not every provider spends a status code on a concurrency conflict.
     * GitLab answers one with 400 -- the same 400 it uses for a traversal in
     * the path and for a commit that would change nothing -- so the status
     * alone cannot say which happened, and reading any 400 as a refused stale
     * write would let two unrelated mistakes pass as proof.
     *
     * A caller that knows its provider's conflict when it sees it says so
     * here. Nothing else may widen the mapping below.
     */
    if (typeof options.conflict === 'function' && options.conflict(response.status, data)) {
      fail('provider rejected a stale mutation', 'ALPHA17_STALE_HEAD');
    }
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
  /*
   * Converged like every other post-mutation read. A branch that is gone can
   * still be listed for a moment, and reporting a cleanup failure for that
   * would strand nothing but would send someone looking for a branch that is
   * not there.
   */
  return (await observe(
    () => client.getBranch(target.branch, 'mutation'),
    head => head === null
  )) === null;
}

/*
 * The probes a provider contributes on top of the shared mutation sequence.
 *
 * A provider that proves nothing extra declares an empty probe list and needs
 * no client support; a provider that does must implement probeChecks and
 * return exactly the checks its contract names, in order, all passing.
 */
async function runProviderProbes({ provider, client, target, proofPath, readback }) {
  const expected = providerProbeKeys(provider);
  if (!expected.length) return [];
  if (typeof client.probeChecks !== 'function') {
    fail('provider client does not implement the probes its contract requires', 'ALPHA17_PROVIDER_INVALID');
  }
  const probes = await client.probeChecks({ branch: target.branch, prefix: target.prefix, proofPath, proofFileSha: readback.sha });
  if (!Array.isArray(probes) || probes.length !== expected.length) {
    fail('provider probes do not match the provider proof contract', 'ALPHA17_PROVIDER_PROBE_INVALID');
  }
  probes.forEach((probe, index) => {
    if (!probe || probe.key !== expected[index]) {
      fail('provider probes do not match the provider proof contract', 'ALPHA17_PROVIDER_PROBE_INVALID');
    }
    if (probe.status !== 'pass') {
      /*
       * Say which part of the probe did not hold. "tree-read did not pass"
       * sent me back to the source to work out that it could mean a missing
       * path, a truncated listing, or a blob identity mismatch; the run that
       * emitted it had already thrown the answer away. Every boolean the probe
       * carries is a named condition, so the false ones are the diagnosis.
       */
      const unmet = Object.entries(probe)
        .filter(([, value]) => value === false)
        .map(([name]) => name);
      fail(
        `provider probe ${probe.key} did not pass${unmet.length ? ` (unmet: ${unmet.join(', ')})` : ''}`,
        'ALPHA17_PROVIDER_PROBE_FAILED'
      );
    }
  });
  return probes;
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
  let cleanupError = null;
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
    const afterWrite = await observe(
      () => client.getBranch(target.branch, 'mutation'),
      head => Boolean(head) && head.sha === written.commitSha
    );
    assertExpectedHead(written.commitSha, afterWrite.sha);
    checks.push({ key: 'expected-head-write', status: 'pass', statusClass: '2xx' });
    const readback = await observe(
      () => client.readFile(target.branch, proofPath, 'mutation'),
      file => file !== null
    );
    verifyUtf8Readback(proofBytes, readback.content);
    checks.push({
      key: 'utf8-readback',
      status: 'pass',
      statusClass: readback.statusClass,
      bytes: proofBytes.length,
      contentSha256: sha256(proofBytes)
    });

    /*
     * Whatever this provider proves beyond the shared sequence. Run here
     * because the proof file is on the branch and nothing has been rolled back
     * yet, and checked against the provider's own contract on the way out: a
     * client that returns the wrong probes, in the wrong order, or a probe that
     * did not pass, fails the run rather than producing an artifact that the
     * evidence validator will reject later with less to say about why.
     */
    for (const probe of await runProviderProbes({ provider, client, target, proofPath, readback })) {
      checks.push(probe);
    }

    /*
     * Optimistic concurrency, proved by making the provider answer the same
     * token twice.
     *
     * The first version of this proof called writeFile with a stale head, and
     * writeFile asserts the expected head locally before it calls anything --
     * so the client refused, the provider was never asked, and a check named
     * "stale-head" recorded that OUR precondition works.
     *
     * The second version went to the provider with a synthetic token: a real
     * blob sha of other bytes for GitHub and Gitea, and for GitLab the branch
     * head from before the file existed. GitHub refused it. GitLab did not,
     * and runs 63 and 64 died there. Its check is not "is this the file's
     * current commit" but Files::BaseService#file_has_changed?, which resolves
     * the file's last commit at BOTH refs and compares them -- and a ref where
     * the path does not exist yields no commit, which it reads as no
     * information rather than as a conflict. A token from before the file
     * existed is not stale to GitLab. It is silent.
     *
     * So this asks for the real race instead of a manufactured one. The token
     * this run is holding for the proof file -- blob sha for GitHub and Gitea,
     * last-touching commit for GitLab -- is sent twice with different content:
     *
     *   1. while it is still current, and the provider must ACCEPT it;
     *   2. after a write has landed under it, and the provider must REFUSE it.
     *
     * One token, one endpoint, two outcomes, and nothing between them but
     * somebody else's commit. A provider with no concurrency control cannot
     * produce that difference, and neither can a client faking one: the
     * accepted call is the control, so a refusal cannot be blamed on a
     * malformed token.
     */
    if (typeof client.conditionalUpdate !== 'function') {
      fail('provider client cannot make a conditional update the provider itself refuses', 'ALPHA17_PROVIDER_INVALID');
    }
    /*
     * The token as held before anything superseded it. Every later assertion
     * is about this exact pair.
     */
    const heldFileSha = readback.sha;
    const heldCommitId = readback.lastCommitId || afterWrite.sha;
    const supersedeBytes = Buffer.from('Nebulaverse-X alpha.17 superseding write\n', 'utf8');
    const staleProofBytes = Buffer.from('Nebulaverse-X alpha.17 rejected stale-write proof\n', 'utf8');

    /*
     * The head as it stands going into the superseding write, read rather than
     * remembered.
     *
     * It used to be afterWrite.sha, which was the same value only because
     * nothing between the write and here ever moved the branch. GitHub's push
     * probes do move it, and with the old baseline the observer below would
     * have returned satisfied on the probe's commit -- before the superseding
     * write had landed -- and the stale-head proof would then have compared
     * two different heads and reported the branch as moved. The bug would have
     * been in the baseline, and the failure would have been reported against
     * the provider.
     */
    const beforeSupersede = await client.getBranch(target.branch, 'mutation');

    /*
     * Step 1. Distinct content on every conditional write, because GitLab
     * refuses a commit that would change nothing with the same 400 it uses for
     * a conflict. Identical bytes would be refused for the wrong reason and
     * counted as proof of the right one.
     */
    await client.conditionalUpdate({
      branch: target.branch,
      path: proofPath,
      content: supersedeBytes,
      fileSha: heldFileSha,
      commitId: heldCommitId,
      credential: 'mutation'
    });
    const afterSupersede = await observe(
      () => client.getBranch(target.branch, 'mutation'),
      head => Boolean(head) && head.sha !== beforeSupersede.sha
    );
    const superseded = await observe(
      () => client.readFile(target.branch, proofPath, 'mutation'),
      file => file !== null && file.sha !== heldFileSha
    );
    verifyUtf8Readback(supersedeBytes, superseded.content);
    checks.push({
      key: 'conditional-update',
      status: 'pass',
      statusClass: superseded.statusClass,
      contentSha256: sha256(supersedeBytes)
    });

    /* Step 2. The same token, now behind by exactly one commit. */
    let staleRejected = false;
    try {
      await client.conditionalUpdate({
        branch: target.branch,
        path: proofPath,
        content: staleProofBytes,
        fileSha: heldFileSha,
        commitId: heldCommitId,
        credential: 'mutation'
      });
    } catch (error) {
      if (error.code !== 'ALPHA17_STALE_HEAD') throw error;
      staleRejected = true;
    }
    const afterStale = await client.getBranch(target.branch, 'mutation');
    let afterStaleFile = null;
    let staleFileUnchanged = false;
    let staleFileVerification = {
      status: 'missing-or-unreadable',
      reasonCode: 'ALPHA17_STALE_FILE_UNAVAILABLE',
      detail: 'the post-rejection file could not be read'
    };
    try {
      afterStaleFile = await client.readFile(target.branch, proofPath, 'mutation');
      if (afterStaleFile === null) {
        staleFileVerification = {
          status: 'missing',
          reasonCode: 'ALPHA17_STALE_FILE_MISSING',
          detail: 'the post-rejection file is absent'
        };
      } else {
        verifyUtf8Readback(supersedeBytes, afterStaleFile.content);
        staleFileUnchanged = afterStaleFile.sha === superseded.sha;
        staleFileVerification = staleFileUnchanged
          ? { status: 'verified', reasonCode: null, detail: 'content bytes and provider file identity match' }
          : {
              status: 'identity-mismatch',
              reasonCode: 'ALPHA17_STALE_FILE_IDENTITY_MISMATCH',
              detail: 'content matches but the provider file identity changed'
            };
      }
    } catch (error) {
      const reasonCode = String(error && error.code || 'ALPHA17_PROVIDER_REQUEST_FAILED');
      staleFileVerification = {
        status: reasonCode === 'ALPHA17_READBACK_MISMATCH' ? 'content-mismatch' : 'unreadable',
        reasonCode: /^[A-Z][A-Z0-9_]{2,79}$/.test(reasonCode)
          ? reasonCode
          : 'ALPHA17_PROVIDER_REQUEST_FAILED',
        detail: reasonCode === 'ALPHA17_READBACK_MISMATCH'
          ? 'the post-rejection content differs from the expected superseding bytes'
          : 'the post-rejection file read failed before comparison'
      };
    }
    const staleConditions = Object.freeze({
      refused: staleRejected,
      headUnmoved: Boolean(afterStale) && afterStale.sha === afterSupersede.sha,
      fileUnchanged: staleFileUnchanged
    });
    const staleZeroCommit = Object.values(staleConditions).every(Boolean);
    const staleHeadCheck = {
      key: 'stale-head',
      status: staleZeroCommit ? 'pass' : 'fail',
      zeroCommit: staleZeroCommit,
      fileVerificationStatus: staleFileVerification.status,
      fileVerificationReasonCode: staleFileVerification.reasonCode,
      fileVerificationDetail: staleFileVerification.detail
    };
    checks.push(staleHeadCheck);
    if (!staleZeroCommit) {
      /*
       * Which of the three did not hold. Runs 63 and 64 both failed here and
       * said only "changed the branch or file", so two runs went by without
       * distinguishing a provider that accepted the write from a read that
       * lagged behind one that refused it.
       */
      const unmet = Object.entries(staleConditions).filter(([, value]) => !value).map(([name]) => name);
      const error = new Error(
        `stale-head attempt was not refused cleanly (unmet: ${unmet.join(', ')}; `
        + `file ${staleFileVerification.status})`
      );
      error.code = 'ALPHA17_STALE_HEAD_PROOF_FAILED';
      error.check = deepFreeze({ ...staleHeadCheck, conditions: { ...staleConditions } });
      throw error;
    }

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
    /*
     * The delete half of the same proof, and it had the same defect: it passed
     * `before.sha` as the expected head, and deleteFile asserts the expected
     * head locally before it calls anything. The client refused, the provider
     * was never asked, and the check recorded our own precondition.
     *
     * It carries the CURRENT head now, so the local assertion passes and the
     * request goes out -- with the file token this run has been holding since
     * before the superseding write, which the provider must refuse for the
     * same reason it refused the stale update.
     */
    let staleDeleteRejected = false;
    try {
      await client.deleteFile({
        branch: target.branch,
        path: proofPath,
        fileSha: heldFileSha,
        commitId: heldCommitId,
        expectedHead: afterPermission.sha,
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
    const staleDeleteCheck = {
      key: 'stale-head-delete',
      status: staleDeleteZeroCommit ? 'pass' : 'fail',
      zeroCommit: staleDeleteZeroCommit,
      fileRetained: Boolean(retainedAfterStaleDelete)
    };
    checks.push(staleDeleteCheck);
    if (!staleDeleteZeroCommit) {
      const unmet = Object.entries({
        refused: staleDeleteRejected,
        headUnmoved: Boolean(afterStaleDelete) && afterStaleDelete.sha === afterPermission.sha,
        fileRetained: Boolean(retainedAfterStaleDelete) && retainedAfterStaleDelete.sha === currentFile.sha
      }).filter(([, value]) => !value).map(([name]) => name);
      const error = new Error(`stale-head delete was not refused cleanly (unmet: ${unmet.join(', ')})`);
      error.code = 'ALPHA17_DELETE_PROOF_FAILED';
      error.check = deepFreeze({ ...staleDeleteCheck });
      throw error;
    }

    const deleted = await client.deleteFile({
      branch: target.branch,
      path: proofPath,
      fileSha: currentFile.sha,
      expectedHead: afterStaleDelete.sha,
      credential: 'mutation'
    });
    const afterDelete = await observe(
      () => client.getBranch(target.branch, 'mutation'),
      head => Boolean(deleted) && Boolean(head) && head.sha === deleted.commitSha
    );
    const absentAfterDelete = await observe(
      () => client.readFile(target.branch, proofPath, 'mutation'),
      file => file === null
    );
    const deleteBindings = Object.freeze({
      deleteCommitIsASha: Boolean(deleted) && /^[0-9a-f]{40}$/.test(deleted.commitSha),
      deleteAnswered2xx: Boolean(deleted) && deleted.statusClass === '2xx',
      headIsTheDeleteCommit: Boolean(deleted) && Boolean(afterDelete) && deleted.commitSha === afterDelete.sha,
      headAdvanced: Boolean(afterDelete) && afterDelete.sha !== afterStaleDelete.sha,
      fileAbsent: absentAfterDelete === null
    });
    const unmetDeleteBindings = unmetBindings(deleteBindings);
    const deleteBoundToObservedHead = unmetDeleteBindings.length === 0;
    checks.push({
      key: 'expected-head-delete',
      status: deleteBoundToObservedHead ? 'pass' : 'fail',
      statusClass: deleted && deleted.statusClass,
      headAdvanced: deleteBindings.headAdvanced,
      fileAbsent: deleteBindings.fileAbsent
    });
    if (!deleteBoundToObservedHead) {
      fail(
        `delete result is not bound to the observed post-delete head (unmet: ${unmetDeleteBindings.join(', ')})`,
        'ALPHA17_DELETE_PROOF_FAILED'
      );
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      cleanupVerified = await cleanupDisposableBranch(client, target, [permissionPath, proofPath]);
    } catch (error) {
      /*
       * This catch used to be bare. Cleanup failing is the one outcome that
       * leaves something behind in somebody else's repository, and it was the
       * one outcome that threw away its own reason -- so the run reported
       * "cleanup is incomplete" and nothing else, and a branch sat in the
       * target with no record of what refused to remove it.
       *
       * The provider failure codes are already free of URLs, bodies and
       * credentials, so carrying the reason out costs no secrecy.
       */
      cleanupVerified = false;
      cleanupError = error;
    }
  }

  const cleanupReasonCode = cleanupError && /^[A-Z][A-Z0-9_]{2,79}$/.test(String(cleanupError.code || ''))
    ? String(cleanupError.code)
    : null;
  checks.push({
    key: 'cleanup-absence',
    status: cleanupVerified ? 'pass' : 'fail',
    reasonCode: cleanupReasonCode
  });
  /*
   * When the operation failed AND cleanup could not verify, the operation
   * error is the one worth reading -- cleanup is usually failing for the same
   * reason. Reporting only the cleanup failure buries the cause, which is how
   * a provider whose reads never caught up came back as 'cleanup is
   * incomplete' with nothing said about the delete proof underneath it.
   *
   * Neither fact is dropped: the cleanup outcome is already in the checks, and
   * an unverified cleanup is named on the error as well, because a disposable
   * branch possibly left behind in someone's repository is not a detail.
   */
  if (operationError) {
    if (!cleanupVerified) {
      operationError.message =
        `${operationError.message}; cleanup did not verify, so the disposable branch may remain`;
      operationError.cleanupVerified = false;
    }
    throw operationError;
  }
  if (!cleanupVerified) {
    fail(
      cleanupError
        ? `provider cleanup is incomplete: ${cleanupError.message}${cleanupReasonCode ? ` (${cleanupReasonCode})` : ''}`
        : 'provider cleanup is incomplete: the disposable branch was still present after it was deleted',
      'ALPHA17_CLEANUP_INCOMPLETE'
    );
  }

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
  observe,
  /*
   * Exported so a provider client raises the same shape as the shared
   * sequence does, rather than each one inventing its own error type for the
   * same class of refusal.
   */
  fail,
  statusClass,
  providerCapabilityRequirements,
  providerClaims,
  runProviderQualification
});
