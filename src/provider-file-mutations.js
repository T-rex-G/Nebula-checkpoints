'use strict';

const crypto = require('crypto');

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function providerError(message, code, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function requireSha(value, label) {
  const sha = String(value || '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw providerError(`Gitea returned an invalid ${label} commit SHA`, 'GITEA_COMMIT_SHA_INVALID');
  }
  return sha;
}

function repositoryRoute(owner, repo) {
  return `/repos/${encodeURIComponent(String(owner))}/${encodeURIComponent(String(repo))}`;
}

function encodeRepoPath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

function branchChangedError() {
  return providerError(
    'The branch changed since this view was loaded. Refresh the repository and retry so newer work is not overwritten.',
    'BRANCH_CHANGED',
    409
  );
}

function createGiteaFileMutationAdapter({ request, temporaryBranchNameFactory } = {}) {
  if (typeof request !== 'function') throw new TypeError('Gitea file mutation adapter requires a request function');
  const createTemporaryBranchName = temporaryBranchNameFactory || (() =>
    `nv-tx/${crypto.randomBytes(12).toString('hex')}`);

  async function branchHead(base, branch) {
    const result = await request(`${base}/branches/${encodeURIComponent(branch)}`);
    return requireSha(result && result.commit && result.commit.id, 'branch head');
  }

  async function write(input = {}) {
    const base = repositoryRoute(input.owner, input.repo);
    const branch = String(input.branch || '');
    const filePath = encodeRepoPath(input.path);
    const currentHead = await branchHead(base, branch);
    const expectedHead = input.expectedHeadSha
      ? requireSha(input.expectedHeadSha, 'expected head')
      : currentHead;
    if (expectedHead !== currentHead) throw branchChangedError();
    let existing = null;
    try {
      existing = await request(`${base}/contents/${filePath}?ref=${encodeURIComponent(expectedHead)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    const temporaryBranch = createTemporaryBranchName();
    let temporaryBranchCreated = false;
    let failure = null;
    let result = null;
    try {
      await request(`${base}/branches`, {
        method: 'POST',
        body: { new_branch_name: temporaryBranch, old_ref_name: expectedHead }
      });
      temporaryBranchCreated = true;

      const changed = await request(`${base}/contents/${filePath}`, {
        method: 'PUT',
        body: {
          branch: temporaryBranch,
          content: Buffer.from(String(input.content), 'utf8').toString('base64'),
          message: String(input.message || `Update ${input.path}`),
          ...(existing && existing.sha ? { sha: String(existing.sha) } : {})
        }
      });
      const commit = requireSha(changed && changed.commit && changed.commit.sha, 'file mutation');
      const parent = requireSha(
        changed && changed.commit && changed.commit.parents && changed.commit.parents[0] &&
          changed.commit.parents[0].sha,
        'file mutation parent'
      );
      if (parent !== expectedHead) throw branchChangedError();

      try {
        await request(`${base}/branches/${encodeURIComponent(branch)}`, {
          method: 'PUT',
          body: { new_commit_id: commit, old_commit_id: expectedHead, force: false }
        });
      } catch (error) {
        if (error.status === 409 || error.status === 422) throw branchChangedError();
        throw error;
      }
      if (await branchHead(base, branch) !== commit) {
        throw providerError('Gitea did not move the branch to the created commit', 'GITEA_BRANCH_UPDATE_INVALID');
      }
      result = {
        commit,
        sha: requireSha(changed && changed.content && changed.content.sha, 'file blob')
      };
    } catch (error) {
      failure = error;
    }

    if (temporaryBranchCreated) {
      try {
        await request(`${base}/branches/${encodeURIComponent(temporaryBranch)}`, { method: 'DELETE' });
      } catch (cleanupError) {
        if (!failure) throw cleanupError;
        failure.cleanupFailed = true;
      }
    }
    if (failure) throw failure;
    return result;
  }

  async function deleteFile(input = {}) {
    const base = repositoryRoute(input.owner, input.repo);
    const branch = String(input.branch || '');
    const filePath = encodeRepoPath(input.path);
    const currentHead = await branchHead(base, branch);
    const expectedHead = input.expectedHeadSha
      ? requireSha(input.expectedHeadSha, 'expected head')
      : currentHead;
    if (expectedHead !== currentHead) throw branchChangedError();
    const existing = await request(
      `${base}/contents/${filePath}?ref=${encodeURIComponent(expectedHead)}`
    );
    const existingSha = requireSha(existing && existing.sha, 'file blob');

    const temporaryBranch = createTemporaryBranchName();
    let temporaryBranchCreated = false;
    let failure = null;
    let result = null;
    try {
      await request(`${base}/branches`, {
        method: 'POST',
        body: { new_branch_name: temporaryBranch, old_ref_name: expectedHead }
      });
      temporaryBranchCreated = true;

      const changed = await request(`${base}/contents/${filePath}`, {
        method: 'DELETE',
        body: {
          branch: temporaryBranch,
          message: String(input.message || `Delete ${input.path}`),
          sha: existingSha
        }
      });
      const commit = requireSha(changed && changed.commit && changed.commit.sha, 'file mutation');
      const parent = requireSha(
        changed && changed.commit && changed.commit.parents && changed.commit.parents[0] &&
          changed.commit.parents[0].sha,
        'file mutation parent'
      );
      if (parent !== expectedHead) throw branchChangedError();

      try {
        await request(`${base}/branches/${encodeURIComponent(branch)}`, {
          method: 'PUT',
          body: { new_commit_id: commit, old_commit_id: expectedHead, force: false }
        });
      } catch (error) {
        if (error.status === 409 || error.status === 422) throw branchChangedError();
        throw error;
      }
      if (await branchHead(base, branch) !== commit) {
        throw providerError('Gitea did not move the branch to the created commit', 'GITEA_BRANCH_UPDATE_INVALID');
      }
      result = { commit };
    } catch (error) {
      failure = error;
    }

    if (temporaryBranchCreated) {
      try {
        await request(`${base}/branches/${encodeURIComponent(temporaryBranch)}`, { method: 'DELETE' });
      } catch (cleanupError) {
        if (!failure) throw cleanupError;
        failure.cleanupFailed = true;
      }
    }
    if (failure) throw failure;
    return result;
  }

  return Object.freeze({ write, delete: deleteFile });
}

module.exports = Object.freeze({ createGiteaFileMutationAdapter });
