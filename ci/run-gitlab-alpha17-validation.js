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

function createGitlabClient({ env, fetchImpl }) {
  const repository = required(env, 'NV_ALPHA17_REPOSITORY');
  const baseUrl = new URL(String(env.NV_ALPHA17_GITLAB_API_URL || 'https://gitlab.com/api/v4'));
  const mutationCredential = required(env, 'NV_ALPHA17_MUTATION_CREDENTIAL');
  const readOnlyCredential = required(env, 'NV_ALPHA17_READ_ONLY_CREDENTIAL');
  const project = encodeURIComponent(repository);
  const api = pathname => new URL(pathname, `${baseUrl.toString().replace(/\/$/, '')}/`).toString();

  function headers(kind) {
    return {
      'PRIVATE-TOKEN': kind === 'readOnly' ? readOnlyCredential : mutationCredential,
      'Content-Type': 'application/json',
      'User-Agent': 'Nebulaverse-X-alpha17-qualification'
    };
  }

  async function getRepository(credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`projects/${project}`), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    return Object.freeze({
      fullName: String(response.data.path_with_namespace || ''),
      defaultBranch: String(response.data.default_branch || '')
    });
  }

  async function getBranch(branch, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`projects/${project}/repository/branches/${encodeURIComponent(branch)}`), {
      headers: headers(credential),
      allowedStatuses: [200, 404]
    });
    if (response.status === 404) return null;
    return Object.freeze({ sha: String(response.data.commit && response.data.commit.id || '').toLowerCase() });
  }

  async function createBranch(branch, sha, credential = 'mutation') {
    return requestJson(fetchImpl, api(`projects/${project}/repository/branches`), {
      method: 'POST',
      headers: headers(credential),
      body: { branch, ref: sha },
      allowedStatuses: [201]
    });
  }

  async function writeFile(input) {
    const current = await getBranch(input.branch, input.credential);
    assertExpectedHead(input.expectedHead, current && current.sha);
    const response = await requestJson(fetchImpl, api(`projects/${project}/repository/files/${encodeURIComponent(input.path)}`), {
      method: 'POST',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        commit_message: 'test(alpha): qualification proof',
        content: Buffer.from(input.content).toString('base64'),
        encoding: 'base64'
      },
      allowedStatuses: [201]
    });
    /*
     * GitLab's create-file response is documented as carrying exactly two
     * fields, branch and file_path. It does not say which commit it made, so
     * unlike GitHub there is nothing in the write to bind against.
     *
     * The file read does carry it: last_commit_id is the commit that last
     * modified this file, from a different endpoint than the branch listing.
     * Asking that endpoint what wrote the file, and requiring the branch head
     * to agree, is the same cross-check GitHub gets from its write response --
     * arguably a better one, since the two facts come from two endpoints
     * rather than from the mutation reporting on itself.
     */
    const written = await readFile(input.branch, input.path, input.credential);
    return Object.freeze({
      commitSha: String((written && written.lastCommitId) || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function readFile(branch, filePath, credential = 'mutation') {
    const url = new URL(api(`projects/${project}/repository/files/${encodeURIComponent(filePath)}`));
    url.searchParams.set('ref', branch);
    const response = await requestJson(fetchImpl, url.toString(), {
      headers: headers(credential),
      allowedStatuses: [200, 404]
    });
    if (response.status === 404) return null;
    return Object.freeze({
      content: Buffer.from(String(response.data.content || ''), 'base64'),
      sha: String(response.data.blob_id || '').toLowerCase(),
      lastCommitId: String(response.data.last_commit_id || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function deleteFile(input) {
    const current = await getBranch(input.branch, input.credential);
    assertExpectedHead(input.expectedHead, current && current.sha);
    const response = await requestJson(fetchImpl, api(`projects/${project}/repository/files/${encodeURIComponent(input.path)}`), {
      method: 'DELETE',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        commit_message: 'test(alpha): remove qualification proof',
        last_commit_id: input.expectedHead
      },
      allowedStatuses: [200, 204]
    });
    const commitSha = response.data && response.data.commit_id
      ? String(response.data.commit_id).toLowerCase()
      : String((await getBranch(input.branch, input.credential)).sha).toLowerCase();
    return Object.freeze({ commitSha, statusClass: response.statusClass });
  }

  async function deleteBranch(branch, credential = 'mutation') {
    return requestJson(fetchImpl, api(`projects/${project}/repository/branches/${encodeURIComponent(branch)}`), {
      method: 'DELETE',
      headers: headers(credential),
      allowedStatuses: [204]
    });
  }

  return Object.freeze({ getRepository, getBranch, createBranch, writeFile, readFile, deleteFile, deleteBranch });
}

async function runGitlabValidation(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  return runProviderQualification({
    provider: 'gitlab',
    client: createGitlabClient({ env, fetchImpl }),
    env,
    now: options.now
  });
}

if (require.main === module) {
  runGitlabValidation().then(
    result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    error => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = Object.freeze({ createGitlabClient, runGitlabValidation });
