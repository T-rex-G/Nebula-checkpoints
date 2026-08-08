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

  return Object.freeze({ getRepository, getBranch, createBranch, writeFile, readFile, deleteFile, deleteBranch });
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
