'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createProviderFetchFixture } = require('../ci/alpha17-fixtures');
const { runGithubValidation } = require('../ci/run-github-alpha17-validation');
const { runGitlabValidation } = require('../ci/run-gitlab-alpha17-validation');
const { runGiteaValidation } = require('../ci/run-gitea-alpha17-validation');

const RUN_ID = 'run-2048';
const SUBJECT = 'a'.repeat(64);
const SOURCE = 'b'.repeat(40);
const NOW = '2026-07-29T20:00:00.000Z';

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

async function runOne(provider, runner) {
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
    fetchImpl: fixture.fetch,
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
    assert.deepStrictEqual(result.checks.map(check => check.key), [
      'repository-read',
      'default-branch-read',
      'disposable-branch-create',
      'expected-head-write',
      'utf8-readback',
      'stale-head',
      'permission-denial',
      'stale-head-delete',
      'expected-head-delete',
      'cleanup-absence'
    ]);
    assert(result.checks.some(check => check.key === 'stale-head' && check.zeroCommit === true));
    assert(result.checks.some(check => check.key === 'permission-denial' && check.zeroCommit === true));
    assert(result.checks.some(check => check.key === 'stale-head-delete' && check.zeroCommit === true));
    assert(result.checks.some(check => check.key === 'cleanup-absence' && check.status === 'pass'));
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
    'repository.read'
  ]);
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
    'live-events', 'pulls.read', 'pulls.write', 'webhooks.read',
    'webhooks.write', 'rate-limit', 'auth.app'
  ]) {
    assert(!githubResult.capabilities.includes(unproven), `provider harness must not claim ${unproven}`);
  }

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

  console.log('alpha17 provider harness tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
