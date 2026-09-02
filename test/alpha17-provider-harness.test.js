'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createProviderFetchFixture } = require('../ci/alpha17-fixtures');
const { requestJson } = require('../ci/provider-alpha17-common');
const { runGithubValidation } = require('../ci/run-github-alpha17-validation');
const { runGitlabValidation } = require('../ci/run-gitlab-alpha17-validation');
const { runGiteaValidation } = require('../ci/run-gitea-alpha17-validation');

const RUN_ID = 'run-2048';
const SUBJECT = 'a'.repeat(64);
const SOURCE = 'b'.repeat(40);
const NOW = '2026-07-29T20:00:00.000Z';

/*
 * The extra checks each provider contributes, in contract order. GitLab and
 * Gitea prove nothing beyond the shared sequence, and saying so here keeps the
 * empty case asserted rather than assumed.
 */
const PROBE_KEYS = Object.freeze({
  github: ['tree-read', 'rate-read', 'pulls-read', 'issues-read', 'releases-read', 'workflows-read'],
  gitlab: [],
  gitea: []
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function environment(provider) {
  const repository = `fixture-owner/nvx-alpha17-${provider}-qualification`;
  const env = {
    NV_PUBLIC_ALPHA_SUBJECT_SHA256: SUBJECT,
    NV_PUBLIC_ALPHA_SOURCE_COMMIT: SOURCE,
    NV_ALPHA17_WORKFLOW_RUN_ID: RUN_ID,
    NV_ALPHA17_REPOSITORY: repository,
    NV_ALPHA17_BRANCH: `nvx-alpha17-${RUN_ID}-proof`,
    NV_ALPHA17_MUTATION_CREDENTIAL: 'fixture-mutation-credential',
    NV_ALPHA17_READ_ONLY_CREDENTIAL: 'fixture-readonly-credential',
    NV_ALPHA17_GITHUB_API_URL: 'https://github.fixture.invalid',
    NV_ALPHA17_GITLAB_API_URL: 'https://gitlab.fixture.invalid/api/v4',
    NV_ALPHA17_GITEA_API_URL: 'https://gitea.fixture.invalid/api/v1'
  };
  const apiUrl = {
    github: env.NV_ALPHA17_GITHUB_API_URL,
    gitlab: env.NV_ALPHA17_GITLAB_API_URL,
    gitea: env.NV_ALPHA17_GITEA_API_URL
  }[provider];
  env.NV_ALPHA17_SIGNED_TARGET_SHA256 = crypto.createHash('sha256').update(JSON.stringify({
    apiUrl,
    jobName: provider,
    repository
  })).digest('hex');
  return env;
}

/*
 * A provider that acknowledges a mutation and then serves reads that have not
 * caught up yet. This is what the first live GitHub run hit: the delete
 * answered 200 with a well-formed commit, and the reads taken immediately
 * afterwards did not all agree with it.
 *
 * `lagReads` is how many GETs after the first DELETE are answered from the
 * response the same URL gave earlier -- literally the stale answer, not an
 * error. Infinity models a provider that never converges, which must still
 * fail the gate.
 */
function laggingFetch(fetchImpl, lagReads) {
  const lastResponse = new Map();
  let deleteSeen = false;
  let lagged = 0;
  return async (url, init = {}) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const key = String(url);
    if (method === 'GET' && deleteSeen && lagged < lagReads && lastResponse.has(key)) {
      lagged += 1;
      return lastResponse.get(key).clone();
    }
    const response = await fetchImpl(url, init);
    if (method === 'GET') lastResponse.set(key, response.clone());
    if (method === 'DELETE') deleteSeen = true;
    return response;
  };
}

/*
 * A provider whose tree listing has not caught up with the commit this run
 * just made. This is what failed the first run ever to reach the probes: the
 * proof file was written, and the tree came back without it.
 *
 * `lagTreeReads` is how many tree reads answer from before the write.
 */
function laggingTreeFetch(fetchImpl, lagTreeReads) {
  let lagged = 0;
  return async (url, init = {}) => {
    const response = await fetchImpl(url, init);
    if (!new URL(url).pathname.includes('/git/trees/') || lagged >= lagTreeReads) return response;
    lagged += 1;
    const listing = await response.json();
    const body = JSON.stringify({ ...listing, tree: [] });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
    });
  };
}

async function runOne(provider, runner, options = {}) {
  const env = environment(provider);
  const fixture = createProviderFetchFixture({
    provider,
    repository: env.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: env.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: env.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  const result = await runner({
    env,
    fetchImpl: options.lagTreeReads != null
      ? laggingTreeFetch(fixture.fetch, options.lagTreeReads)
      : options.lagReads == null ? fixture.fetch : laggingFetch(fixture.fetch, options.lagReads),
    now: () => new Date(NOW)
  });
  assert.strictEqual(fixture.state.branches.size, 1, `${provider} must remove its disposable branch`);
  assert.strictEqual(fixture.state.branches.has('main'), true);
  return result;
}

(async () => {
  const githubResult = await runOne('github', runGithubValidation);
  const gitlabResult = await runOne('gitlab', runGitlabValidation);
  const giteaResult = await runOne('gitea', runGiteaValidation);

  for (const result of [githubResult, gitlabResult, giteaResult]) {
    assert.strictEqual(result.schemaVersion, '1.1.0');
    assert.strictEqual(result.artifactType, 'provider-live');
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.cleanupVerified, true);
    assert.strictEqual(result.subjectSha256, SUBJECT);
    assert.strictEqual(result.sourceCommit, SOURCE);
    const { artifactSha256, ...evidenceCore } = result;
    assert.strictEqual(
      artifactSha256,
      crypto.createHash('sha256').update(stableJson(evidenceCore)).digest('hex'),
      `${result.provider} artifact digest must bind the exact serialized evidence core`
    );
    assert.strictEqual(result.originId, `workflow-${RUN_ID}-${result.provider}`);
    assert.strictEqual(
      result.authorizedTargetSha256,
      environment(result.provider).NV_ALPHA17_SIGNED_TARGET_SHA256,
      `${result.provider} artifact must retain the exact authorized target digest`
    );
    const serialized = JSON.stringify(result);
    assert(!serialized.includes('fixture-mutation-credential'));
    assert(!serialized.includes('fixture-readonly-credential'));
    assert(!serialized.includes('fixture-owner'));
    assert(!serialized.includes(`nvx-alpha17-${RUN_ID}-proof`));
    /*
     * Every provider runs the same mutation sequence; a provider that proves
     * capabilities beyond it inserts its own probes after the readback, where
     * the proof file exists on the disposable branch and nothing has been
     * rolled back yet. The order is part of the evidence contract, so it is
     * asserted rather than sorted away.
     */
    assert.deepStrictEqual(result.checks.map(check => check.key), [
      'repository-read',
      'default-branch-read',
      'disposable-branch-create',
      'expected-head-write',
      'utf8-readback',
      ...PROBE_KEYS[result.provider],
      'stale-head',
      'permission-denial',
      'stale-head-delete',
      'expected-head-delete',
      'cleanup-absence'
    ]);
    assert(result.checks.some(check => check.key === 'stale-head' && check.zeroCommit === true &&
      check.fileVerificationStatus === 'verified' && check.fileVerificationReasonCode === null));
    assert(result.checks.some(check => check.key === 'permission-denial' && check.zeroCommit === true));
    assert(result.checks.some(check => check.key === 'stale-head-delete' && check.zeroCommit === true));
    assert(result.checks.some(check =>
      check.key === 'cleanup-absence' && check.status === 'pass' && check.reasonCode === null));
    assert.deepStrictEqual(
      Object.keys(result.claims).sort(),
      result.capabilities.map(capability => `providers.${result.provider}.${capability}`).sort()
    );
    for (const claim of Object.values(result.claims)) {
      assert.deepStrictEqual(claim, {
        status: 'pass',
        cleanupVerified: true,
        completedAt: NOW
      });
    }
  }
  assert.deepStrictEqual(githubResult.capabilities, [
    'branches.read',
    'branches.write',
    'file.delete',
    'file.read',
    'file.write',
    'issues.read',
    'pulls.read',
    'rate.read',
    'releases.read',
    'repository.read',
    'tree.read',
    'workflows.read'
  ]);

  /*
   * The tree probe is a cross-check rather than a reachability ping: the
   * listing has to name the file the write just created, and give it the same
   * blob identity the contents API reported. An endpoint that answers 200 with
   * somebody else's tree passes a reachability ping and fails this.
   */
  const treeRead = githubResult.checks.find(check => check.key === 'tree-read');
  assert(treeRead, 'the github artifact must carry a tree-read proof');
  assert.strictEqual(treeRead.proofPathPresent, true);
  assert.strictEqual(treeRead.blobIdentityMatched, true);
  assert(Number.isSafeInteger(treeRead.entries) && treeRead.entries > 0);

  const rateRead = githubResult.checks.find(check => check.key === 'rate-read');
  assert(rateRead, 'the github artifact must carry a rate-read proof');
  assert.strictEqual(rateRead.limitPositive, true);
  assert.strictEqual(rateRead.remainingWithinLimit, true);

  /*
   * The fixture holds one object in each collection, so the detail-agreement
   * loop actually runs. Against an empty listing it would hold vacuously and
   * this would assert nothing about it.
   */
  for (const key of ['pulls-read', 'issues-read', 'releases-read', 'workflows-read']) {
    const collection = githubResult.checks.find(check => check.key === key);
    assert(collection, `the github artifact must carry a ${key} proof`);
    assert.strictEqual(collection.listed, 1, `${key} must have verified the object it listed`);
    assert.strictEqual(collection.detailAgreed, true);
    assert.strictEqual(collection.absentDiscriminated, true);
  }
  for (const result of [gitlabResult, giteaResult]) {
    assert.deepStrictEqual(result.capabilities, [
      'branches.read',
      'file.delete',
      'file.read',
      'file.write',
      'repository.read'
    ]);
  }
  for (const unproven of [
    'live-events', 'pulls.write', 'issues.write', 'releases.write',
    'workflows.rerun', 'webhooks.read', 'webhooks.write', 'auth.app'
  ]) {
    assert(!githubResult.capabilities.includes(unproven), `provider harness must not claim ${unproven}`);
  }

  const missingReadbackEnvironment = environment('github');
  const missingReadbackFixture = createProviderFetchFixture({
    provider: 'github',
    repository: missingReadbackEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: missingReadbackEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: missingReadbackEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  let proofReadCount = 0;
  await assert.rejects(
    () => runGithubValidation({
      env: missingReadbackEnvironment,
      now: () => new Date(NOW),
      fetchImpl: async (url, init = {}) => {
        const isProofRead = String(init.method || 'GET').toUpperCase() === 'GET' &&
          new URL(url).pathname.includes('/contents/nvx-alpha17-run-2048-proof.txt');
        if (isProofRead && ++proofReadCount === 2) {
          const body = JSON.stringify({ message: 'not found' });
          return new Response(body, {
            status: 404,
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
          });
        }
        return missingReadbackFixture.fetch(url, init);
      }
    }),
    error => error &&
      error.code === 'ALPHA17_STALE_HEAD_PROOF_FAILED' &&
      error.check &&
      error.check.fileVerificationStatus === 'missing' &&
      error.check.fileVerificationReasonCode === 'ALPHA17_STALE_FILE_MISSING',
    'a missing post-rejection file must retain its classified stale-head proof failure'
  );

  const badEnvironment = environment('github');
  badEnvironment.NV_ALPHA17_REPOSITORY = 'fixture-owner/not-disposable';
  const badFixture = createProviderFetchFixture({
    provider: 'github',
    repository: badEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: badEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: badEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  await assert.rejects(
    () => runGithubValidation({ env: badEnvironment, fetchImpl: badFixture.fetch, now: () => new Date(NOW) }),
    error => error && error.code === 'ALPHA17_TARGET_NOT_DISPOSABLE'
  );

  const mismatchedBindingEnvironment = environment('github');
  mismatchedBindingEnvironment.NV_ALPHA17_SIGNED_TARGET_SHA256 = 'f'.repeat(64);
  const mismatchedBindingFixture = createProviderFetchFixture({
    provider: 'github',
    repository: mismatchedBindingEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: mismatchedBindingEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: mismatchedBindingEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  await assert.rejects(
    () => runGithubValidation({
      env: mismatchedBindingEnvironment,
      fetchImpl: mismatchedBindingFixture.fetch,
      now: () => new Date(NOW)
    }),
    error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH'
  );
  assert.strictEqual(mismatchedBindingFixture.state.requests.length, 0, 'target mismatch must fail before provider access');

  const forgedDeleteEnvironment = environment('github');
  const forgedDeleteFixture = createProviderFetchFixture({
    provider: 'github',
    repository: forgedDeleteEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: forgedDeleteEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: forgedDeleteEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL,
    deleteCommitSha: 'e'.repeat(40)
  });
  await assert.rejects(
    () => runGithubValidation({
      env: forgedDeleteEnvironment,
      fetchImpl: forgedDeleteFixture.fetch,
      now: () => new Date(NOW)
    }),
    error => error && error.code === 'ALPHA17_DELETE_PROOF_FAILED'
  );

  /*
   * A provider whose reads lag behind its own acknowledged mutations must
   * still qualify. Before the observation converged, three stale GETs were
   * enough to fail a run in which nothing was actually wrong -- which is
   * exactly how the first live dispatch died.
   */
  const laggedResult = await runOne('github', runGithubValidation, { lagReads: 3 });
  assert.strictEqual(laggedResult.status, 'pass', 'a provider whose reads lag must still qualify');
  assert.strictEqual(laggedResult.cleanupVerified, true);
  assert(laggedResult.checks.some(check =>
    check.key === 'expected-head-delete' && check.status === 'pass' &&
    check.headAdvanced === true && check.fileAbsent === true
  ), 'the delete proof must hold once the provider catches up');

  /*
   * Converging is not the same as giving up on the binding. A provider that
   * never catches up still fails, and now names the binding that never held.
   */
  await assert.rejects(
    () => runOne('github', runGithubValidation, { lagReads: Infinity }),
    error => Boolean(
      error &&
      error.code === 'ALPHA17_DELETE_PROOF_FAILED' &&
      /unmet: /.test(error.message) &&
      /fileAbsent|headIsTheDeleteCommit|headAdvanced/.test(error.message)
    ),
    'a provider that never converges must still fail, and say which binding never held'
  );

  /*
   * The tree probe has to be a cross-check, not a reachability ping. A listing
   * that answers 200 and names the right path but carries somebody else's blob
   * identity is exactly the case a ping cannot tell from success, so the run
   * has to refuse it.
   */
  const forgedTreeEnvironment = environment('github');
  const forgedTreeFixture = createProviderFetchFixture({
    provider: 'github',
    repository: forgedTreeEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: forgedTreeEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: forgedTreeEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  await assert.rejects(
    () => runGithubValidation({
      env: forgedTreeEnvironment,
      now: () => new Date(NOW),
      fetchImpl: async (url, init = {}) => {
        const response = await forgedTreeFixture.fetch(url, init);
        if (!new URL(url).pathname.includes('/git/trees/')) return response;
        const listing = await response.json();
        const body = JSON.stringify({
          ...listing,
          tree: listing.tree.map(entry => ({ ...entry, sha: 'f'.repeat(40) }))
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
        });
      }
    }),
    error => error && error.code === 'ALPHA17_PROVIDER_PROBE_FAILED'
  );

  /*
   * The collection proof has two arms, and each is falsified on its own.
   *
   * A detail view that answers with a different object than the one asked for
   * still answers 200, and an endpoint that answers 200 to any identifier at
   * all -- including one that cannot exist -- is not a lookup. Both pass a
   * reachability ping; neither may pass this.
   */
  for (const [label, rewrite, expectedCode] of [
    [
      'a detail view that answers with a different object',
      (pathname, body) => (/\/pulls\/7$/.test(pathname) ? { ...body, number: 4242 } : null),
      'ALPHA17_PROVIDER_PROBE_FAILED'
    ],
    [
      'a detail view that answers for an identifier that cannot exist',
      pathname => (/\/issues\/999999999$/.test(pathname) ? { number: 999999999 } : null),
      'ALPHA17_PROVIDER_PROBE_FAILED'
    ]
  ]) {
    const collectionEnvironment = environment('github');
    const collectionFixture = createProviderFetchFixture({
      provider: 'github',
      repository: collectionEnvironment.NV_ALPHA17_REPOSITORY,
      defaultBranch: 'main',
      runId: RUN_ID,
      mutationCredential: collectionEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
      readOnlyCredential: collectionEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
    });
    await assert.rejects(
      () => runGithubValidation({
        env: collectionEnvironment,
        now: () => new Date(NOW),
        fetchImpl: async (url, init = {}) => {
          const response = await collectionFixture.fetch(url, init);
          const pathname = new URL(url).pathname;
          const original = response.status === 200 ? await response.clone().json() : null;
          const replacement = rewrite(pathname, original);
          if (!replacement) return response;
          const body = JSON.stringify(replacement);
          return new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
          });
        }
      }),
      error => error && error.code === expectedCode,
      label
    );
  }

  /*
   * A tree that has not caught up must not fail the run. Three stale tree
   * reads were enough to fail run 56, in which nothing was wrong.
   */
  const laggedTreeResult = await runOne('github', runGithubValidation, { lagTreeReads: 3 });
  assert.strictEqual(laggedTreeResult.status, 'pass', 'a provider whose tree lags must still qualify');
  assert(laggedTreeResult.checks.some(check =>
    check.key === 'tree-read' && check.status === 'pass' &&
    check.proofPathPresent === true && check.blobIdentityMatched === true
  ), 'the tree proof must hold once the provider catches up');

  /*
   * A tree that never catches up still fails, and now says which condition
   * never held rather than only naming the probe.
   */
  await assert.rejects(
    () => runOne('github', runGithubValidation, { lagTreeReads: Infinity }),
    error => Boolean(
      error &&
      error.code === 'ALPHA17_PROVIDER_PROBE_FAILED' &&
      /tree-read/.test(error.message) &&
      /unmet: /.test(error.message) &&
      /proofPathPresent/.test(error.message)
    ),
    'a tree that never converges must fail and name the unmet condition'
  );

  /*
   * Cleanup is the one failure that leaves something behind in someone else's
   * repository, and it was the one that reported nothing about why. Run 57
   * stranded a branch and said only "provider cleanup is incomplete"; the
   * refusal underneath it had already been swallowed by a bare catch.
   */
  const refusedCleanupEnvironment = environment('github');
  const refusedCleanupFixture = createProviderFetchFixture({
    provider: 'github',
    repository: refusedCleanupEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: refusedCleanupEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: refusedCleanupEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  let branchDeleteSeen = false;
  await assert.rejects(
    () => runGithubValidation({
      env: refusedCleanupEnvironment,
      now: () => new Date(NOW),
      fetchImpl: async (url, init = {}) => {
        const method = String((init && init.method) || 'GET').toUpperCase();
        if (method === 'DELETE' && new URL(url).pathname.includes('/git/refs/heads/')) {
          branchDeleteSeen = true;
          return new Response(JSON.stringify({ message: 'refused' }), {
            status: 403,
            headers: { 'content-type': 'application/json' }
          });
        }
        return refusedCleanupFixture.fetch(url, init);
      }
    }),
    error => Boolean(
      error &&
      error.code === 'ALPHA17_CLEANUP_INCOMPLETE' &&
      /ALPHA17_PERMISSION_DENIED/.test(error.message)
    ),
    'a refused branch delete must name the refusal, not just say cleanup is incomplete'
  );
  assert.strictEqual(branchDeleteSeen, true, 'the branch delete must actually have been attempted');

  /*
   * The refusals below are the ones the gate leans on and nothing had ever
   * shown to fire. Each is written from the failure it is supposed to catch.
   */

  /*
   * The read-only credential is supposed to be refused; permission-denial
   * passes BECAUSE it fails to write. An operator who grants that token write
   * access turns the proof into a formality -- the write succeeds, nothing
   * refuses it, and a gate that only asked "did permission-denial pass?" would
   * see a pass. This is the check that catches it, and it was the one I told
   * the operator to rely on.
   */
  const overScopedEnvironment = environment('github');
  const overScopedFixture = createProviderFetchFixture({
    provider: 'github',
    repository: overScopedEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: overScopedEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: overScopedEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  await assert.rejects(
    () => runGithubValidation({
      env: overScopedEnvironment,
      now: () => new Date(NOW),
      fetchImpl: async (url, init = {}) => {
        const authorization = String((init.headers && init.headers.Authorization) || '');
        const method = String(init.method || 'GET').toUpperCase();
        if (method === 'PUT' && authorization.includes(overScopedEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL)) {
          // The over-scoped token writes instead of being refused.
          return overScopedFixture.fetch(url, {
            ...init,
            headers: { ...init.headers, Authorization: `Bearer ${overScopedEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL}` }
          });
        }
        return overScopedFixture.fetch(url, init);
      }
    }),
    error => Boolean(error && error.code === 'ALPHA17_PERMISSION_SCOPE_INVALID'),
    'a read-only credential that can write must fail the run, not pass permission-denial'
  );

  /*
   * A provider that acknowledges a write and then serves back different bytes.
   * utf8-readback is the only thing standing between that and an artifact
   * claiming file.read and file.write are proven.
   */
  const corruptingEnvironment = environment('github');
  const corruptingFixture = createProviderFetchFixture({
    provider: 'github',
    repository: corruptingEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: corruptingEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: corruptingEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  await assert.rejects(
    () => runGithubValidation({
      env: corruptingEnvironment,
      now: () => new Date(NOW),
      fetchImpl: async (url, init = {}) => {
        const response = await corruptingFixture.fetch(url, init);
        const method = String(init.method || 'GET').toUpperCase();
        if (method !== 'GET' || !new URL(url).pathname.includes('/contents/')) return response;
        const payload = await response.json();
        if (!payload || typeof payload.content !== 'string') {
          return new Response(JSON.stringify(payload), { status: response.status, headers: { 'content-type': 'application/json' } });
        }
        const body = JSON.stringify({
          ...payload,
          content: Buffer.from('not the bytes that were written\n', 'utf8').toString('base64')
        });
        return new Response(body, {
          status: response.status,
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
        });
      }
    }),
    error => Boolean(error && error.code === 'ALPHA17_READBACK_MISMATCH'),
    'a provider that serves back different bytes must fail the readback proof'
  );

  /*
   * Transport refusals, exercised directly against requestJson because they
   * guard every call rather than one step of the sequence.
   */
  const anyHeaders = { Accept: 'application/json' };
  const neverCalled = async () => {
    throw new Error('the transport must refuse this URL before any request is made');
  };
  for (const [label, url] of [
    ['plain http', 'http://api.example.invalid/repos/x'],
    ['credentials embedded in the URL', 'https://user:secret@api.example.invalid/repos/x']
  ]) {
    await assert.rejects(
      () => requestJson(neverCalled, url, { headers: anyHeaders }),
      error => Boolean(error && error.code === 'ALPHA17_PROVIDER_URL_INVALID'),
      `${label} must be refused before the request is made`
    );
  }

  await assert.rejects(
    () => requestJson(
      async () => new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) }
      }),
      'https://api.example.invalid/repos/x',
      { headers: anyHeaders }
    ),
    error => Boolean(error && error.code === 'ALPHA17_PROVIDER_RESPONSE_INVALID'),
    'a declared response size beyond the cap must be refused'
  );

  await assert.rejects(
    () => requestJson(
      async () => new Response('{ not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      'https://api.example.invalid/repos/x',
      { headers: anyHeaders }
    ),
    error => Boolean(error && error.code === 'ALPHA17_PROVIDER_RESPONSE_INVALID'),
    'malformed JSON must be refused rather than parsed into nothing'
  );

  for (const status of [500, 502, 404]) {
    await assert.rejects(
      () => requestJson(
        async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
        'https://api.example.invalid/repos/x',
        { headers: anyHeaders }
      ),
      error => Boolean(error && error.code === 'ALPHA17_PROVIDER_REQUEST_FAILED'),
      `an unexpected ${status} must fail the run rather than be read as an answer`
    );
  }

  console.log('alpha17 provider harness tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
