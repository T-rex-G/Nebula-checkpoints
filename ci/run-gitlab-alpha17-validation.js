#!/usr/bin/env node
'use strict';

const {
  assertExpectedHead,
  fail,
  observe,
  requestJson,
  runProviderQualification
} = require('./provider-alpha17-common');

const DELETE_COMMIT_MESSAGE = 'test(alpha): remove qualification proof';

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

  /*
   * GitLab's own optimistic concurrency: an update carries last_commit_id, the
   * commit the writer believes last touched the file, and a mismatch is
   * refused with 409.
   *
   * The caller hands it a real commit that is not the file's last one -- the
   * branch head from before this run wrote the file. That is precisely what a
   * writer working from a stale view would send.
   */
  async function staleConditionalUpdate(input) {
    return requestJson(fetchImpl, api(`projects/${project}/repository/files/${encodeURIComponent(input.path)}`), {
      method: 'PUT',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        commit_message: 'test(alpha): rejected stale-write proof',
        content: Buffer.from(input.content).toString('base64'),
        encoding: 'base64',
        last_commit_id: input.staleCommitId
      },
      allowedStatuses: [200, 201]
    });
  }

  async function readCommit(ref, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`projects/${project}/repository/commits/${encodeURIComponent(ref)}`), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    return Object.freeze({
      id: String(response.data.id || '').toLowerCase(),
      message: String(response.data.message || ''),
      parentIds: (Array.isArray(response.data.parent_ids) ? response.data.parent_ids : [])
        .map(value => String(value).toLowerCase())
    });
  }

  async function deleteFile(input) {
    const current = await getBranch(input.branch, input.credential);
    assertExpectedHead(input.expectedHead, current && current.sha);
    const existing = await readFile(input.branch, input.path, input.credential);
    const lastCommitId = (existing && existing.lastCommitId) || input.expectedHead;
    const response = await requestJson(fetchImpl, api(`projects/${project}/repository/files/${encodeURIComponent(input.path)}`), {
      method: 'DELETE',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        commit_message: DELETE_COMMIT_MESSAGE,
        /*
         * GitLab defines last_commit_id as the last known commit of THIS FILE,
         * not the branch head. The two coincide here -- this run's write is
         * both -- so passing the head worked, and would keep working right up
         * until a commit touched something else on the branch, at which point
         * a correct delete would be refused as a conflict.
         *
         * The file says which commit last changed it, so ask it.
         */
        last_commit_id: lastCommitId
      },
      allowedStatuses: [200, 204]
    });
    if (response.data && response.data.commit_id) {
      return Object.freeze({
        commitSha: String(response.data.commit_id).toLowerCase(),
        statusClass: response.statusClass
      });
    }
    /*
     * GitLab answers a delete with 204 and no body, so it never says which
     * commit it made. This used to fall back to re-reading the branch head and
     * returning that, which made the caller's "the head is the delete commit"
     * check a comparison of the head with itself -- true no matter what the
     * provider did, including nothing.
     *
     * The commits endpoint can answer it. The tip commit is fetched there and
     * required to be a CHILD of the head this delete was made against, and to
     * carry this run's delete message. A head that did not advance fails
     * because the tip's parent is then the wrong commit; a head advanced by
     * somebody else's commit fails on the message. Only then is that commit
     * handed back as what the delete did, so the caller's binding is a claim
     * about a verified commit rather than a tautology.
     */
    const expected = String(input.expectedHead || '').toLowerCase();
    const tip = await observe(
      () => readCommit(input.branch, input.credential),
      commit => Boolean(commit) && commit.parentIds.includes(expected)
    );
    if (!tip || !tip.parentIds.includes(expected)) {
      fail('provider delete commit is not a child of the head it was made against', 'ALPHA17_DELETE_PROOF_FAILED');
    }
    if (tip.message.trim() !== DELETE_COMMIT_MESSAGE) {
      fail('provider tip commit is not the delete this run made', 'ALPHA17_DELETE_PROOF_FAILED');
    }
    return Object.freeze({ commitSha: tip.id, statusClass: response.statusClass });
  }

  /*
   * GitLab's tree is an array of entries whose `id` is the blob sha, and it
   * PAGINATES rather than reporting truncation the way GitHub does. A hundred
   * per page is far beyond anything a disposable target holds, and the proof
   * still has to find its own file in what came back -- a short page that
   * happened to omit it fails rather than passing quietly.
   */
  async function readTree(branch, credential = 'mutation') {
    const url = new URL(api(`projects/${project}/repository/tree`));
    url.searchParams.set('ref', branch);
    url.searchParams.set('recursive', 'true');
    url.searchParams.set('per_page', '100');
    const response = await requestJson(fetchImpl, url.toString(), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    const entries = Array.isArray(response.data) ? response.data : [];
    return Object.freeze({
      statusClass: response.statusClass,
      entries: entries.map(entry => Object.freeze({
        path: String(entry.path || ''),
        sha: String(entry.id || '').toLowerCase(),
        type: String(entry.type || '')
      }))
    });
  }

  /*
   * An internal id no object in a disposable project can hold. GitLab scopes
   * merge requests and issues to the project by `iid`, a small sequential
   * number, so this is unreachable by construction.
   */
  const ABSENT_IID = 999999999;

  /*
   * The collection reads. Same shape as GitHub's, and one difference that
   * matters: the detail path takes `iid`, the project-scoped internal id, not
   * `id`, which is global to the whole instance. Identifying by `id` would
   * have produced a 404 on every detail fetch.
   */
  async function readCollection({ key, listPath, detailPath }) {
    const listing = await requestJson(fetchImpl, api(`projects/${project}/${listPath}`), {
      headers: headers('mutation'),
      allowedStatuses: [200]
    });
    const items = Array.isArray(listing.data) ? listing.data : [];
    let detailAgreed = true;
    for (const item of items) {
      const iid = Number(item && item.iid);
      if (!Number.isSafeInteger(iid) || iid <= 0) {
        detailAgreed = false;
        break;
      }
      const detail = await requestJson(fetchImpl, api(`projects/${project}/${detailPath}/${iid}`), {
        headers: headers('mutation'),
        allowedStatuses: [200]
      });
      if (Number(detail.data && detail.data.iid) !== iid) {
        detailAgreed = false;
        break;
      }
    }
    const absent = await requestJson(fetchImpl, api(`projects/${project}/${detailPath}/${ABSENT_IID}`), {
      headers: headers('mutation'),
      allowedStatuses: [200, 404]
    });
    const absentDiscriminated = absent.status === 404;
    return {
      key,
      status: detailAgreed && absentDiscriminated ? 'pass' : 'fail',
      statusClass: listing.statusClass,
      listed: items.length,
      detailAgreed,
      absentDiscriminated
    };
  }

  const COLLECTION_READS = Object.freeze([
    { key: 'pulls-read', listPath: 'merge_requests?state=all', detailPath: 'merge_requests' },
    { key: 'issues-read', listPath: 'issues?state=all', detailPath: 'issues' }
  ]);

  async function probeChecks({ branch, proofPath, proofFileSha }) {
    const expectedSha = String(proofFileSha || '').toLowerCase();
    /* Converged, for the same read-after-write reason the GitHub tree was. */
    const tree = await observe(
      () => readTree(branch),
      current => Boolean(current) &&
        current.entries.some(entry => entry.path === proofPath && entry.sha === expectedSha)
    );
    const entry = tree.entries.find(item => item.path === proofPath);
    const treeRead = {
      key: 'tree-read',
      status: 'fail',
      statusClass: tree.statusClass,
      entries: tree.entries.length,
      proofPathPresent: Boolean(entry),
      blobIdentityMatched: Boolean(entry) && entry.sha === expectedSha
    };
    treeRead.status = treeRead.proofPathPresent && treeRead.blobIdentityMatched ? 'pass' : 'fail';

    const collections = [];
    for (const collection of COLLECTION_READS) collections.push(await readCollection(collection));
    return [treeRead, ...collections];
  }

  async function deleteBranch(branch, credential = 'mutation') {
    return requestJson(fetchImpl, api(`projects/${project}/repository/branches/${encodeURIComponent(branch)}`), {
      method: 'DELETE',
      headers: headers(credential),
      allowedStatuses: [204]
    });
  }

  return Object.freeze({
    getRepository, getBranch, createBranch, writeFile, staleConditionalUpdate,
    readFile, deleteFile, deleteBranch, probeChecks
  });
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
