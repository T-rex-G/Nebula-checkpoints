#!/usr/bin/env node
'use strict';

const {
  assertExpectedHead,
  requestJson,
  runProviderQualification
} = require('./provider-alpha17-common');

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function createGithubClient({ env, fetchImpl }) {
  const repository = required(env, 'NV_ALPHA17_REPOSITORY');
  const baseUrl = new URL(String(env.NV_ALPHA17_GITHUB_API_URL || 'https://api.github.com'));
  const mutationCredential = required(env, 'NV_ALPHA17_MUTATION_CREDENTIAL');
  const readOnlyCredential = required(env, 'NV_ALPHA17_READ_ONLY_CREDENTIAL');
  const repositoryPath = repository.split('/').map(encodeURIComponent).join('/');
  const api = pathname => new URL(pathname, `${baseUrl.toString().replace(/\/$/, '')}/`).toString();

  function headers(kind) {
    const credential = kind === 'readOnly' ? readOnlyCredential : mutationCredential;
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Nebulaverse-X-alpha17-qualification'
    };
  }

  async function getRepository(credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}`), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    return Object.freeze({
      fullName: String(response.data.full_name || ''),
      defaultBranch: String(response.data.default_branch || '')
    });
  }

  async function getBranch(branch, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/ref/heads/${encodeURIComponent(branch)}`), {
      headers: headers(credential),
      allowedStatuses: [200, 404]
    });
    if (response.status === 404) return null;
    return Object.freeze({ sha: String(response.data.object && response.data.object.sha || '').toLowerCase() });
  }

  async function createBranch(branch, sha, credential = 'mutation') {
    return requestJson(fetchImpl, api(`repos/${repositoryPath}/git/refs`), {
      method: 'POST',
      headers: headers(credential),
      body: { ref: `refs/heads/${branch}`, sha },
      allowedStatuses: [201]
    });
  }

  async function writeFile(input) {
    const current = await getBranch(input.branch, input.credential);
    assertExpectedHead(input.expectedHead, current && current.sha);
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/contents/${encodeURIComponent(input.path)}`), {
      method: 'PUT',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        message: 'test(alpha): qualification proof',
        content: Buffer.from(input.content).toString('base64')
      },
      allowedStatuses: [200, 201]
    });
    return Object.freeze({
      commitSha: String(response.data.commit && response.data.commit.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function readFile(branch, filePath, credential = 'mutation') {
    const url = new URL(api(`repos/${repositoryPath}/contents/${encodeURIComponent(filePath)}`));
    url.searchParams.set('ref', branch);
    const response = await requestJson(fetchImpl, url.toString(), {
      headers: headers(credential),
      allowedStatuses: [200, 404]
    });
    if (response.status === 404) return null;
    return Object.freeze({
      content: Buffer.from(String(response.data.content || '').replace(/\s+/g, ''), 'base64'),
      sha: String(response.data.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function deleteFile(input) {
    const current = await getBranch(input.branch, input.credential);
    assertExpectedHead(input.expectedHead, current && current.sha);
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/contents/${encodeURIComponent(input.path)}`), {
      method: 'DELETE',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        message: 'test(alpha): remove qualification proof',
        sha: input.fileSha
      },
      allowedStatuses: [200]
    });
    return Object.freeze({
      commitSha: String(response.data.commit && response.data.commit.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function deleteBranch(branch, credential = 'mutation') {
    return requestJson(fetchImpl, api(`repos/${repositoryPath}/git/refs/heads/${encodeURIComponent(branch)}`), {
      method: 'DELETE',
      headers: headers(credential),
      allowedStatuses: [204]
    });
  }

  /*
   * The tree listing for a branch, recursive, so a file written anywhere under
   * it is visible. Bounded by the shared response reader; the disposable
   * qualification repository holds a handful of files, so the truncation flag
   * is reported rather than paged through -- a truncated listing is not proof
   * of anything and fails the probe.
   */
  async function readTree(branch, credential = 'mutation') {
    const url = new URL(api(`repos/${repositoryPath}/git/trees/${encodeURIComponent(branch)}`));
    url.searchParams.set('recursive', '1');
    const response = await requestJson(fetchImpl, url.toString(), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    const tree = Array.isArray(response.data.tree) ? response.data.tree : [];
    return Object.freeze({
      statusClass: response.statusClass,
      truncated: response.data.truncated === true,
      entries: tree.map(entry => Object.freeze({
        path: String(entry.path || ''),
        sha: String(entry.sha || '').toLowerCase()
      }))
    });
  }

  async function readRateLimit(credential = 'mutation') {
    const response = await requestJson(fetchImpl, api('rate_limit'), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    const core = response.data.resources && response.data.resources.core;
    return Object.freeze({
      statusClass: response.statusClass,
      limit: Number(core && core.limit),
      remaining: Number(core && core.remaining)
    });
  }

  /*
   * Cross-checks, not reachability pings.
   *
   * The tree probe requires the listing to name the file this run just wrote
   * and to give it the blob identity the contents API already reported for it.
   * An endpoint answering 200 with an unrelated tree satisfies a ping and
   * fails this.
   *
   * The rate probe records comparisons rather than the figures: the ceiling
   * has to be a real positive number and the remaining budget has to sit
   * within it. The account's actual quota is not the evidence's business.
   */
  async function probeChecks({ branch, proofPath, proofFileSha }) {
    const tree = await readTree(branch);
    const entry = tree.entries.find(item => item.path === proofPath);
    const treeRead = {
      key: 'tree-read',
      status: 'fail',
      statusClass: tree.statusClass,
      entries: tree.entries.length,
      proofPathPresent: Boolean(entry) && !tree.truncated,
      blobIdentityMatched: Boolean(entry) && entry.sha === String(proofFileSha || '').toLowerCase()
    };
    treeRead.status = treeRead.proofPathPresent && treeRead.blobIdentityMatched ? 'pass' : 'fail';

    const rate = await readRateLimit();
    const limitPositive = Number.isSafeInteger(rate.limit) && rate.limit > 0;
    const rateRead = {
      key: 'rate-read',
      status: 'fail',
      statusClass: rate.statusClass,
      limitPositive,
      remainingWithinLimit: limitPositive &&
        Number.isSafeInteger(rate.remaining) &&
        rate.remaining >= 0 &&
        rate.remaining <= rate.limit
    };
    rateRead.status = rateRead.limitPositive && rateRead.remainingWithinLimit ? 'pass' : 'fail';

    return [treeRead, rateRead];
  }

  return Object.freeze({
    getRepository, getBranch, createBranch, writeFile, readFile, deleteFile, deleteBranch,
    readTree, readRateLimit, probeChecks
  });
}

async function runGithubValidation(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  return runProviderQualification({
    provider: 'github',
    client: createGithubClient({ env, fetchImpl }),
    env,
    now: options.now
  });
}

if (require.main === module) {
  runGithubValidation().then(
    result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    error => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = Object.freeze({ createGithubClient, runGithubValidation });
