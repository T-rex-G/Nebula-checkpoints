'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createProviderFetchFixture } = require('../ci/alpha17-fixtures');
const { PROVIDER_CAPABILITY_REQUIREMENTS, providerProbeKeys, providerCheckContract } = require('../src/qualification-evidence');
const { requestJson, runProviderQualification } = require('../ci/provider-alpha17-common');
const { createGithubClient, runGithubValidation } = require('../ci/run-github-alpha17-validation');

for (const retired of ['gitlab', 'gitea']) {
  assert.throws(() => providerProbeKeys(retired), /not supported for qualification/);
  assert.throws(() => providerCheckContract(retired), /not supported for qualification/);
  assert.throws(() => createProviderFetchFixture({ provider: retired }), /fixture provider is invalid/);
}

const RUN_ID = 'run-2048';
const SUBJECT = 'a'.repeat(64);
const SOURCE = 'b'.repeat(40);
const NOW = '2026-07-29T20:00:00.000Z';

// Probe keys follow the current provider proof contract.
const PROBE_KEYS = Object.freeze(Object.fromEntries(
  ['github'].map(provider => [provider, providerProbeKeys(provider)])
));

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
    NV_ALPHA17_GITHUB_API_URL: 'https://api.github.com',
    NV_ALPHA17_GITHUB_LFS_URL: 'https://github.com',
  };
  const apiUrl = {
    github: env.NV_ALPHA17_GITHUB_API_URL,
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
    /*
     * The lag this models follows the proof file's delete. The capability
     * probes delete things of their own before that -- a star, a release, the
     * branches a pull request was merged between -- and those are not the
     * mutation whose reads this is about.
     */
    const pathname = new URL(key).pathname;
    if (method === 'DELETE' && (pathname.includes('/contents/') || pathname.includes('/repository/files/'))) deleteSeen = true;
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
  for (const name of ['NV_ALPHA17_GITHUB_API_URL', 'NV_ALPHA17_GITHUB_LFS_URL']) {
    const host = name.endsWith('API_URL') ? 'api.github.com' : 'github.com';
    const wrongGithubService = name.endsWith('API_URL') ? 'https://github.com' : 'https://api.github.com';
    for (const value of ['https://gitlab.com', 'https://gitea.example', 'https://evil.invalid',
      `http://${host}`, `https://user:password@${host}`, `https://${host}/path`,
      `https://${host}?redirect=evil`, `https://${host}#fragment`, `https://${host}:8443`, wrongGithubService]) {
      let requests = 0;
      assert.throws(() => createGithubClient({
        env: { ...environment('github'), [name]: value },
        fetchImpl() { requests += 1; throw new Error('must not send credentials to a noncanonical origin'); }
      }), error => error.code === 'ALPHA17_AUTHORIZATION_TARGET_INVALID', `${name}=${value}`);
      assert.strictEqual(requests, 0);
    }
  }
  for (const retired of ['gitlab', 'gitea']) {
    let requests = 0;
    await assert.rejects(() => runProviderQualification({ provider: retired, client: {
      getRepository() { requests += 1; throw new Error('must not contact a retired provider'); }
    } }), error => error.code === 'ALPHA17_PROVIDER_INVALID');
    assert.strictEqual(requests, 0);
  }
  const githubResult = await runOne('github', runGithubValidation);

  for (const result of [githubResult]) {
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
      'conditional-update',
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
    'exposure.scan',
    'file.batch',
    'file.delete',
    'file.read',
    'file.rename',
    'file.write',
    'folder.move',
    'global-search',
    'issues.read',
    'issues.write',
    'lfs',
    'native-push',
    'pulls.read',
    'pulls.write',
    'rate.read',
    'releases.read',
    'releases.write',
    'repository.read',
    'search',
    'stars.read',
    'stars.write',
    'tree.read',
    'workflows.read',
    'workflows.rerun'
  ]);

  /*
   * The push chain. blob-create is a cross-check on identity: the provider is
   * handed bytes and its answer has to be the hash git itself would give them,
   * computed in the runner. batch-commit spends that identity in a tree and
   * requires three things a pair of ordinary writes could not produce -- a
   * commit descending from the head that was read, both paths present at the
   * new head with the bytes and identities they were given, and a refusal when
   * the ref is moved back to the parent without force.
   */
  const blobCreate = githubResult.checks.find(check => check.key === 'blob-create');
  assert(blobCreate, 'the github artifact must carry a blob-create proof');
  assert.strictEqual(blobCreate.gitObjectIdentityMatched, true);
  assert.strictEqual(blobCreate.blobReadBack, true);

  const batchCommit = githubResult.checks.find(check => check.key === 'batch-commit');
  assert(batchCommit, 'the github artifact must carry a batch-commit proof');
  assert.strictEqual(batchCommit.paths, 2);
  assert.strictEqual(batchCommit.parentIsObservedHead, true);
  assert.strictEqual(batchCommit.pathsLanded, true);
  assert.strictEqual(batchCommit.nonFastForwardRefused, true);

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
  for (const result of [githubResult]) {
    assert.deepStrictEqual(
      result.capabilities,
      Object.keys(PROVIDER_CAPABILITY_REQUIREMENTS[result.provider]).sort(),
      `${result.provider} must claim exactly the capabilities its contract requires`
    );
  }
  /*
   * What the harness still does not prove, and must not claim: live events
   * need a deployment the provider can deliver to; notifications are not
   * served to the fine-grained credential the harness uses; and the
   * credential is confined to one repository, so it can neither create nor
   * delete one. The rest of this list was never a GitHub capability here.
   */
  for (const unproven of [
    'live-events', 'notifications', 'repository.create', 'repository.delete',
    'webhooks.read', 'webhooks.write', 'auth.app'
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
  /*
   * The read this replaces is the one taken after the refused conditional
   * update, so it is identified by what precedes it rather than by an index.
   * It used to be the second read of the proof file; the superseding write
   * added one before it, and an ordinal would have silently started standing
   * for a different read while the assertion still passed.
   */
  let refusalSeen = false;
  await assert.rejects(
    () => runGithubValidation({
      env: missingReadbackEnvironment,
      now: () => new Date(NOW),
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        const isProofPath = new URL(url).pathname.includes('/contents/nvx-alpha17-run-2048-proof.txt');
        if (refusalSeen && method === 'GET' && isProofPath) {
          const body = JSON.stringify({ message: 'not found' });
          return new Response(body, {
            status: 404,
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
          });
        }
        const response = await missingReadbackFixture.fetch(url, init);
        if (isProofPath && method === 'PUT' && response.status === 409) refusalSeen = true;
        return response;
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
   * The push chain, falsified one condition at a time.
   *
   * These two probes are the first in the harness whose fixture I wrote in the
   * same change as the check, which is exactly the arrangement that has
   * manufactured confidence three times in this release. So each condition is
   * broken deliberately here, against a fixture that is otherwise correct, and
   * the run has to fail naming that condition and no other.
   *
   * A perturbation that leaves the run green means the condition is decorative.
   */
  for (const [label, perturb, unmet] of [
    [
      'a provider that answers with an object identity that is not the bytes it was given',
      (pathname, method, body) => (pathname.endsWith('/git/blobs') && method === 'POST'
        ? { status: 201, json: { ...body, sha: 'a'.repeat(40) } }
        : null),
      'gitObjectIdentityMatched'
    ],
    [
      'a provider that returns different bytes than the object it stored',
      (pathname, method, body) => (/\/git\/blobs\/[0-9a-f]{40}$/.test(pathname) && method === 'GET'
        ? { status: 200, json: { ...body, content: Buffer.from('other bytes\n', 'utf8').toString('base64') } }
        : null),
      'blobReadBack'
    ],
    [
      'a provider that commits onto a parent other than the head that was read',
      (pathname, method, body) => (/\/git\/commits\/[0-9a-f]{40}$/.test(pathname) && method === 'GET'
        ? { status: 200, json: { ...body, parents: [{ sha: 'b'.repeat(40) }, { sha: 'c'.repeat(40) }] } }
        : null),
      'parentIsObservedHead'
    ],
    [
      'a provider that lands one path of the batch and not the other',
      (pathname, method) => (/-batch-inline\.txt$/.test(decodeURIComponent(pathname)) && method === 'GET'
        ? { status: 404, json: { message: 'not found' } }
        : null),
      'pathsLanded'
    ],
    [
      'a provider that rewinds a branch on a ref move sent without force',
      (pathname, method) => (/\/git\/refs\/heads\//.test(pathname) && method === 'PATCH'
        ? { status: 200, json: { ref: 'refs/heads/x', object: { sha: 'd'.repeat(40) } } }
        : null),
      'nonFastForwardRefused'
    ]
  ]) {
    const pushEnvironment = environment('github');
    const pushFixture = createProviderFetchFixture({
      provider: 'github',
      repository: pushEnvironment.NV_ALPHA17_REPOSITORY,
      defaultBranch: 'main',
      runId: RUN_ID,
      mutationCredential: pushEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
      readOnlyCredential: pushEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
    });
    /*
     * The rewind perturbation has to leave the publishing ref move alone, or
     * the batch never lands and the run fails for the wrong reason. Only the
     * second PATCH -- the rewind -- is answered falsely.
     */
    let refMoves = 0;
    await assert.rejects(
      () => runGithubValidation({
        env: pushEnvironment,
        now: () => new Date(NOW),
        fetchImpl: async (url, init = {}) => {
          const response = await pushFixture.fetch(url, init);
          const pathname = new URL(url).pathname;
          const method = String((init && init.method) || 'GET').toUpperCase();
          if (/\/git\/refs\/heads\//.test(pathname) && method === 'PATCH') {
            refMoves += 1;
            if (refMoves < 2) return response;
          }
          const original = response.status < 300 ? await response.clone().json() : null;
          const replacement = perturb(pathname, method, original);
          if (!replacement) return response;
          const body = JSON.stringify(replacement.json);
          return new Response(body, {
            status: replacement.status,
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
          });
        }
      }),
      error => Boolean(
        error &&
        error.code === 'ALPHA17_PROVIDER_PROBE_FAILED' &&
        new RegExp(unmet).test(error.message)
      ),
      label
    );
  }

  /*
   * A tree entry may not name an object the provider has never been given.
   * Without this the blob proof buys nothing: a client could commit any sha it
   * liked and the batch would still land.
   */
  const inventedEnvironment = environment('github');
  const inventedFixture = createProviderFetchFixture({
    provider: 'github',
    repository: inventedEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: inventedEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: inventedEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  let treeRefusedInvented = false;
  await assert.rejects(
    () => runGithubValidation({
      env: inventedEnvironment,
      now: () => new Date(NOW),
      fetchImpl: async (url, init = {}) => {
        const pathname = new URL(url).pathname;
        const method = String((init && init.method) || 'GET').toUpperCase();
        if (pathname.endsWith('/git/trees') && method === 'POST') {
          const body = JSON.parse(String(init.body));
          const forged = {
            ...body,
            tree: body.tree.map(entry => (entry.sha ? { ...entry, sha: 'e'.repeat(40) } : entry))
          };
          const response = await inventedFixture.fetch(url, { ...init, body: JSON.stringify(forged) });
          if (response.status === 422) treeRefusedInvented = true;
          return response;
        }
        return inventedFixture.fetch(url, init);
      }
    }),
    () => true,
    'a tree naming an object the provider never stored must not be accepted'
  );
  assert(treeRefusedInvented, 'the provider must refuse a tree entry naming an unknown object');

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
        /* The run's own disposable branch -- not the two a pull-request probe
           cuts and removes for itself, which are that probe's business. */
        if (method === 'DELETE' && new URL(url).pathname.endsWith(
          `/git/refs/heads/${encodeURIComponent(refusedCleanupEnvironment.NV_ALPHA17_BRANCH)}`
        )) {
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

  /*
   * The stale-write proof used to be satisfied by this client's own
   * precondition: writeFile asserted the expected head locally and threw
   * before the provider was ever called, so a provider with NO optimistic
   * concurrency at all passed the check named after it.
   *
   * Measured before this guard was written: the old sequence passes against
   * the provider below, which accepts every conditional update it is given.
   * The current one refuses.
   */
  const permissiveEnvironment = environment('github');
  const permissiveFixture = createProviderFetchFixture({
    provider: 'github',
    repository: permissiveEnvironment.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: permissiveEnvironment.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: permissiveEnvironment.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  await assert.rejects(
    () => runGithubValidation({
      env: permissiveEnvironment,
      now: () => new Date(NOW),
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (method !== 'PUT' || !new URL(url).pathname.includes('/contents/')) {
          return permissiveFixture.fetch(url, init);
        }
        const body = JSON.parse(String(init.body || '{}'));
        /*
         * Only the CONDITIONAL update is made permissive. The first write
         * carries no sha and has to go through, or the run fails earlier for
         * an unrelated reason and proves nothing about this.
         */
        if (!body.sha) return permissiveFixture.fetch(url, init);
        /*
         * A provider with no optimistic concurrency does not accept the write
         * and discard it -- it accepts the write and PERFORMS it, whatever
         * token you sent. So the token is replaced with the file's current one
         * and the write is let through, which is the same thing as never
         * having compared it. Both conditional updates then land, and the
         * proof has to notice that the second one moved the branch.
         */
        const read = new URL(url);
        read.searchParams.set('ref', body.branch);
        const current = await (await permissiveFixture.fetch(read.toString(), {})).json();
        return permissiveFixture.fetch(url, {
          ...init,
          body: JSON.stringify({ ...body, sha: current.sha })
        });
      }
    }),
    error => Boolean(error && error.code === 'ALPHA17_STALE_HEAD_PROOF_FAILED'),
    'a provider that accepts a stale conditional update must fail the stale-write proof'
  );


  console.log('alpha17 provider harness tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
