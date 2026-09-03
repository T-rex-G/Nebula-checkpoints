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

function createGiteaClient({ env, fetchImpl }) {
  const repository = required(env, 'NV_ALPHA17_REPOSITORY');
  const baseUrl = new URL(required(env, 'NV_ALPHA17_GITEA_API_URL'));
  const mutationCredential = required(env, 'NV_ALPHA17_MUTATION_CREDENTIAL');
  const readOnlyCredential = required(env, 'NV_ALPHA17_READ_ONLY_CREDENTIAL');
  const repositoryPath = repository.split('/').map(encodeURIComponent).join('/');
  const api = pathname => new URL(pathname, `${baseUrl.toString().replace(/\/$/, '')}/`).toString();

  function headers(kind) {
    const credential = kind === 'readOnly' ? readOnlyCredential : mutationCredential;
    return {
      Authorization: `token ${credential}`,
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
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/branches/${encodeURIComponent(branch)}`), {
      headers: headers(credential),
      allowedStatuses: [200, 404]
    });
    if (response.status === 404) return null;
    return Object.freeze({ sha: String(response.data.commit && response.data.commit.id || '').toLowerCase() });
  }

  async function createBranch(branch, sha, credential = 'mutation') {
    return requestJson(fetchImpl, api(`repos/${repositoryPath}/branches`), {
      method: 'POST',
      headers: headers(credential),
      /*
       * old_ref_name, not old_branch_name. Gitea marks old_branch_name
       * deprecated and documents it as the name of a BRANCH; old_ref_name is
       * the one that takes a branch, tag or commit. This passes a commit, so
       * the deprecated field would have Gitea looking for a branch whose name
       * is a forty-character sha, and not finding one.
       */
      body: { old_ref_name: sha, new_branch_name: branch },
      allowedStatuses: [201]
    });
  }

  async function writeFile(input) {
    const current = await getBranch(input.branch, input.credential);
    assertExpectedHead(input.expectedHead, current && current.sha);
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/contents/${encodeURIComponent(input.path)}`), {
      method: 'POST',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        message: 'test(alpha): qualification proof',
        content: Buffer.from(input.content).toString('base64')
      },
      allowedStatuses: [201]
    });
    return Object.freeze({
      commitSha: String(response.data.commit && response.data.commit.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  /*
   * Gitea's own optimistic concurrency, the same shape as GitHub's: an update
   * carries the blob sha of the file it believes it is replacing, and a
   * mismatch is refused. The caller supplies a well-formed sha belonging to
   * other content.
   */
  /*
   * The blob sha of the file being replaced is this provider's concurrency
   * token. The caller sends the same one twice: current, which must be
   * accepted, and then superseded, which must be refused with 409.
   */
  async function conditionalUpdate(input) {
    return requestJson(fetchImpl, api(`repos/${repositoryPath}/contents/${encodeURIComponent(input.path)}`), {
      method: 'PUT',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        message: 'test(alpha): conditional write proof',
        content: Buffer.from(input.content).toString('base64'),
        sha: input.fileSha
      },
      allowedStatuses: [200, 201]
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
    return requestJson(fetchImpl, api(`repos/${repositoryPath}/branches/${encodeURIComponent(branch)}`), {
      method: 'DELETE',
      headers: headers(credential),
      allowedStatuses: [204]
    });
  }

  return Object.freeze({ getRepository, getBranch, createBranch, writeFile, conditionalUpdate, readFile, deleteFile, deleteBranch });
}

async function runGiteaValidation(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  return runProviderQualification({
    provider: 'gitea',
    client: createGiteaClient({ env, fetchImpl }),
    env,
    now: options.now
  });
}

if (require.main === module) {
  runGiteaValidation().then(
    result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    error => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
      /*
       * The failing check, when the failure carried one. Runs 63 and 64 both
       * died on a proof that had recorded exactly which condition broke and
       * printed none of it, so the log said only that something changed.
       */
      if (error.check) process.stderr.write(`${JSON.stringify(error.check)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = Object.freeze({ createGiteaClient, runGiteaValidation });
