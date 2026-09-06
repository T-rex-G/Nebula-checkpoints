'use strict';

const crypto = require('crypto');

function json(value, status = 200) {
  if (status === 204) return new Response(null, { status });
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body))
    }
  });
}

function snapshotFiles(files) {
  return new Map([...files.entries()].map(([name, file]) => [name, {
    content: Buffer.from(file.content),
    sha: file.sha,
    lastCommitId: file.lastCommitId
  }]));
}

function cloneBranch(branch) {
  return {
    sha: branch.sha,
    files: new Map([...branch.files.entries()].map(([name, file]) => [name, {
      content: Buffer.from(file.content),
      sha: file.sha,
      lastCommitId: file.lastCommitId
    }]))
  };
}

function createProviderFetchFixture(options = {}) {
  const provider = String(options.provider || '');
  const repository = String(options.repository || '');
  const defaultBranch = String(options.defaultBranch || 'main');
  const mutationCredential = String(options.mutationCredential || '');
  const readOnlyCredential = String(options.readOnlyCredential || '');
  const deleteCommitSha = options.deleteCommitSha == null
    ? null
    : String(options.deleteCommitSha).trim().toLowerCase();
  if (!['github', 'gitlab', 'gitea'].includes(provider)) throw new TypeError('fixture provider is invalid');
  const initialSha = '1'.repeat(40);
  const state = {
    counter: 1,
    defaultBranch,
    requests: [],
    branches: new Map([[defaultBranch, { sha: initialSha, files: new Map() }]]),
    /*
     * A commit log, keyed by sha, recording which path each commit touched.
     * The fixture used to keep only a head and a single tip, which cannot
     * answer "what commit last touched this path, as of that ref" -- and that
     * is the exact question GitLab's conflict check asks. See gitlabFetch's
     * PUT handler.
     */
    commits: new Map(),
    /*
     * The Git Data object stores. A branch head alone cannot answer what tree
     * a commit names or what bytes an object holds, and the push proofs ask
     * both.
     */
    blobs: new Map(),
    trees: new Map()
  };

  function nextSha(material) {
    state.counter += 1;
    return crypto.createHash('sha1').update(`${provider}:${state.counter}:${material}`).digest('hex');
  }

  /*
   * The identity git gives a blob, not a bare sha1 of the bytes.
   *
   * This used to be sha1(content), which no provider reports. It went
   * unnoticed for as long as nothing compared the value against anything
   * computed independently -- the harness only ever compared the fixture to
   * itself. The blob proof does compare: it hashes the bytes the way git does
   * and requires the provider's answer to match. A fixture that answered a
   * bare sha1 would have failed a client that is correct, which is the
   * kinder-fixture mistake pointing the other way.
   */
  function fileSha(content) {
    const bytes = Buffer.from(content);
    return crypto.createHash('sha1')
      .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
      .digest('hex');
  }

  function credential(headers) {
    if (provider === 'gitlab') return headers.get('private-token') || '';
    const authorization = headers.get('authorization') || '';
    return authorization.replace(/^(?:bearer|token)\s+/i, '');
  }

  function bodyOf(init) {
    if (!init.body) return {};
    return JSON.parse(String(init.body));
  }

  function canMutate(init) {
    const value = credential(new Headers(init.headers || {}));
    if (value === mutationCredential) return true;
    if (value === readOnlyCredential) return false;
    return false;
  }

  /*
   * `commitsAllowed` exists because providers do not all accept a commit
   * wherever they accept a branch. Resolving both interchangeably made the
   * fixture answer a question no real provider was asked.
   */
  /*
   * One merge request and one issue, so the collection probes list a real
   * object, fetch it on its own and compare -- rather than passing on an empty
   * listing, which proves only that the endpoint answered.
   */
  const giteaOrGitlabSeed = Object.freeze({
    mergeRequests: [{ id: 155016530, iid: 1, title: 'fixture merge request', state: 'opened' }],
    issues: [{ id: 41, iid: 1, title: 'fixture issue', state: 'opened' }]
  });

  function findSource(ref, { commitsAllowed = true } = {}) {
    if (state.branches.has(ref)) return state.branches.get(ref);
    if (!commitsAllowed) return null;
    return [...state.branches.values()].find(branch => branch.sha === ref) || null;
  }

  function createBranch(name, ref, options = {}) {
    if (state.branches.has(name)) return json({ message: 'conflict' }, 409);
    const source = findSource(ref, options);
    if (!source) return json({ message: 'not found' }, 404);
    state.branches.set(name, cloneBranch(source));
    return null;
  }

  function mutateFile(branchName, filePath, content, remove = false, message = '') {
    const branch = state.branches.get(branchName);
    if (!branch) return null;
    if (remove) branch.files.delete(filePath);
    else branch.files.set(filePath, { content, sha: fileSha(content) });
    const parent = branch.sha;
    branch.sha = nextSha(`${branchName}:${filePath}:${remove ? 'delete' : 'write'}`);
    /*
     * Which commit last touched this file, as distinct from the branch head.
     * They diverge as soon as anything else is committed, and GitLab keys its
     * conditional update on the file's, not the branch's.
     */
    if (!remove) branch.files.get(filePath).lastCommitId = branch.sha;
    /*
     * Lineage, because a provider that reports no commit on a mutation can
     * still be asked what the tip commit is and who its parent was. A fixture
     * that only tracks the head cannot model that question, so a client
     * relying on it cannot be tested.
     */
    branch.tip = { id: branch.sha, parentIds: [parent], message: String(message || '') };
    state.commits.set(branch.sha, {
      id: branch.sha,
      parentIds: [parent],
      path: filePath,
      /*
       * Every commit names a tree, and the tree is a snapshot rather than a
       * reference to the live branch: a commit's tree does not change when a
       * later commit lands, and a fixture that shared one map would say it
       * did.
       */
      treeSha: nextSha(`${branchName}:tree`),
      files: snapshotFiles(branch.files)
    });
    state.trees.set(state.commits.get(branch.sha).treeSha, snapshotFiles(branch.files));
    return branch;
  }

  /*
   * Whether `candidate` has `ancestor` in its first-parent history, which is
   * the question a fast-forward-only ref move asks.
   */
  function descendsFrom(candidate, ancestor) {
    let sha = String(candidate || '');
    const seen = new Set();
    while (sha && !seen.has(sha)) {
      if (sha === ancestor) return true;
      seen.add(sha);
      const commit = state.commits.get(sha);
      if (!commit) return false;
      sha = commit.parentIds[0];
    }
    return false;
  }

  /*
   * `git log -1 <ref> -- <path>`, which is what GitLab resolves on both sides
   * of its conflict check. Returns null when no commit in the ref's history
   * touched the path -- meaning the file did not exist there.
   */
  function lastCommitForPath(ref, filePath) {
    const branch = state.branches.get(ref);
    let sha = branch ? branch.sha : String(ref || '');
    const seen = new Set();
    while (sha && state.commits.has(sha) && !seen.has(sha)) {
      seen.add(sha);
      const commit = state.commits.get(sha);
      if (commit.path === filePath) return commit.id;
      sha = commit.parentIds[0];
    }
    return null;
  }

  async function githubFetch(url, init) {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const base = `/repos/${repository}`;
    /* Account-wide rather than repository-scoped, so it is answered first. */
    if (parsed.pathname === '/rate_limit' && method === 'GET') {
      return json({ resources: { core: { limit: 5000, remaining: 4987 } } });
    }
    if (!parsed.pathname.startsWith(base)) return json({ message: 'unknown repository' }, 404);
    if (method !== 'GET' && !canMutate(init)) return json({ message: 'forbidden' }, 403);
    if (parsed.pathname === base && method === 'GET') {
      return json({ full_name: repository, default_branch: defaultBranch });
    }
    const refPrefix = `${base}/git/ref/heads/`;
    if (parsed.pathname.startsWith(refPrefix) && method === 'GET') {
      const branch = state.branches.get(decodeURIComponent(parsed.pathname.slice(refPrefix.length)));
      return branch ? json({ object: { sha: branch.sha } }) : json({ message: 'not found' }, 404);
    }
    if (parsed.pathname === `${base}/git/refs` && method === 'POST') {
      const body = bodyOf(init);
      const branchName = String(body.ref || '').replace(/^refs\/heads\//, '');
      const conflict = createBranch(branchName, body.sha);
      return conflict || json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    const deleteRefPrefix = `${base}/git/refs/heads/`;
    if (parsed.pathname.startsWith(deleteRefPrefix) && method === 'DELETE') {
      const branchName = decodeURIComponent(parsed.pathname.slice(deleteRefPrefix.length));
      if (branchName === defaultBranch || !state.branches.delete(branchName)) return json({ message: 'not found' }, 404);
      return json(null, 204);
    }
    /*
     * The Git Data API: an object store, trees over it, commits naming a tree,
     * and a ref move that publishes one. Transcribed rather than approximated,
     * because the push proofs cross-check the provider's answers against
     * values computed independently -- object identity against git's own hash,
     * a commit's parent against the head that was read before it, a ref rewind
     * against a refusal. A fixture that answered any of those loosely would
     * pass a client that a real provider would reject.
     */
    if (parsed.pathname === `${base}/git/blobs` && method === 'POST') {
      const body = bodyOf(init);
      const bytes = Buffer.from(String(body.content || ''), body.encoding === 'utf-8' ? 'utf8' : 'base64');
      const sha = fileSha(bytes);
      state.blobs.set(sha, bytes);
      return json({ sha, url: `${base}/git/blobs/${sha}` }, 201);
    }
    const blobPrefix = `${base}/git/blobs/`;
    if (parsed.pathname.startsWith(blobPrefix) && method === 'GET') {
      const sha = decodeURIComponent(parsed.pathname.slice(blobPrefix.length));
      const bytes = state.blobs.get(sha);
      if (!bytes) return json({ message: 'not found' }, 404);
      return json({ sha, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    }
    const commitPrefix = `${base}/git/commits/`;
    if (parsed.pathname.startsWith(commitPrefix) && method === 'GET') {
      const sha = decodeURIComponent(parsed.pathname.slice(commitPrefix.length));
      const commit = state.commits.get(sha);
      if (!commit) return json({ message: 'not found' }, 404);
      return json({
        sha: commit.id,
        tree: { sha: commit.treeSha },
        parents: commit.parentIds.filter(Boolean).map(id => ({ sha: id }))
      });
    }
    if (parsed.pathname === `${base}/git/commits` && method === 'POST') {
      const body = bodyOf(init);
      const files = state.trees.get(String(body.tree || ''));
      if (!files) return json({ message: 'not found' }, 422);
      const parentIds = (Array.isArray(body.parents) ? body.parents : []).map(String);
      const sha = nextSha(`commit:${body.tree}`);
      state.commits.set(sha, {
        id: sha,
        parentIds,
        path: null,
        treeSha: String(body.tree),
        files: snapshotFiles(files)
      });
      return json({ sha, tree: { sha: String(body.tree) }, parents: parentIds.map(id => ({ sha: id })) }, 201);
    }
    if (parsed.pathname === `${base}/git/trees` && method === 'POST') {
      const body = bodyOf(init);
      const baseFiles = state.trees.get(String(body.base_tree || ''));
      if (body.base_tree && !baseFiles) return json({ message: 'not found' }, 422);
      const files = snapshotFiles(baseFiles || new Map());
      for (const entry of Array.isArray(body.tree) ? body.tree : []) {
        const entryPath = String(entry && entry.path || '');
        if (!entryPath) return json({ message: 'invalid tree entry' }, 422);
        if (entry.sha === null) { files.delete(entryPath); continue; }
        /*
         * A tree entry names its content either inline or by an object already
         * in the store. An entry naming an object the store has never seen is
         * refused -- accepting it would let a client invent identities and the
         * blob proof would stop meaning anything.
         */
        if (entry.sha != null) {
          const bytes = state.blobs.get(String(entry.sha));
          if (!bytes) return json({ message: 'tree entry references an unknown object' }, 422);
          files.set(entryPath, { content: Buffer.from(bytes), sha: String(entry.sha) });
          continue;
        }
        const bytes = Buffer.from(String(entry.content ?? ''), 'utf8');
        files.set(entryPath, { content: bytes, sha: fileSha(bytes) });
      }
      const sha = nextSha(`tree:${files.size}`);
      state.trees.set(sha, files);
      return json({ sha, tree: [...files.entries()].map(([name, file]) => ({ path: name, sha: file.sha })) }, 201);
    }
    const patchRefPrefix = `${base}/git/refs/heads/`;
    if (parsed.pathname.startsWith(patchRefPrefix) && method === 'PATCH') {
      const branchName = decodeURIComponent(parsed.pathname.slice(patchRefPrefix.length));
      const branch = state.branches.get(branchName);
      if (!branch) return json({ message: 'not found' }, 404);
      const body = bodyOf(init);
      const targetSha = String(body.sha || '');
      const commit = state.commits.get(targetSha);
      if (!commit) return json({ message: 'not found' }, 422);
      /*
       * force:false means fast-forward only. GitHub refuses anything else with
       * 422, and that refusal is what commitTree reads as "the branch changed"
       * -- so the fixture has to produce it, or the batch proof's rewind check
       * would pass against a fixture that had simply rewound the branch.
       */
      if (body.force !== true && !descendsFrom(targetSha, branch.sha)) {
        return json({ message: 'Update is not a fast forward' }, 422);
      }
      branch.sha = targetSha;
      branch.files = snapshotFiles(commit.files);
      return json({ ref: `refs/heads/${branchName}`, object: { sha: targetSha } });
    }
    /*
     * One object in each collection, so the detail-agreement loop in the
     * collection probes actually runs. An empty listing would satisfy that
     * loop vacuously and the fixture would prove nothing about it.
     */
    const collections = {
      pulls: { items: [{ number: 7, title: 'fixture' }], key: 'number' },
      issues: { items: [{ number: 11, title: 'fixture' }], key: 'number' },
      releases: { items: [{ id: 21, tag_name: 'fixture' }], key: 'id' },
      'actions/runs': { items: [{ id: 31, name: 'fixture' }], key: 'id', envelope: 'workflow_runs' }
    };
    for (const [name, collection] of Object.entries(collections)) {
      const listPath = `${base}/${name}`;
      if (parsed.pathname === listPath && method === 'GET') {
        return json(collection.envelope
          ? { total_count: collection.items.length, [collection.envelope]: collection.items }
          : collection.items);
      }
      if (parsed.pathname.startsWith(`${listPath}/`) && method === 'GET') {
        const identifier = Number(parsed.pathname.slice(listPath.length + 1));
        const item = collection.items.find(entry => entry[collection.key] === identifier);
        return item ? json(item) : json({ message: 'not found' }, 404);
      }
    }
    const treePrefix = `${base}/git/trees/`;
    if (parsed.pathname.startsWith(treePrefix) && method === 'GET') {
      const branch = state.branches.get(decodeURIComponent(parsed.pathname.slice(treePrefix.length)));
      if (!branch) return json({ message: 'not found' }, 404);
      return json({
        sha: branch.sha,
        truncated: false,
        tree: [...branch.files.entries()].map(([name, file]) => ({
          path: name,
          type: 'blob',
          sha: file.sha
        }))
      });
    }
    const contentPrefix = `${base}/contents/`;
    if (parsed.pathname.startsWith(contentPrefix)) {
      const filePath = decodeURIComponent(parsed.pathname.slice(contentPrefix.length));
      if (method === 'GET') {
        const branch = state.branches.get(parsed.searchParams.get('ref'));
        const file = branch && branch.files.get(filePath);
        return file ? json({ content: file.content.toString('base64'), sha: file.sha }) : json({ message: 'not found' }, 404);
      }
      const body = bodyOf(init);
      const branch = state.branches.get(body.branch);
      if (!branch) return json({ message: 'not found' }, 404);
      if (method === 'PUT') {
        /*
         * GitHub keys an update on the blob sha of the file being replaced:
         * omit it over an existing file and the write is refused, send one
         * that does not match and it is refused. The fixture enforced this on
         * DELETE and not on PUT, so a client sending a stale token was told
         * the write succeeded -- and a proof that the provider refuses stale
         * writes could not be written against it at all.
         */
        const existing = branch.files.get(filePath);
        if (existing && !body.sha) return json({ message: "sha wasn't supplied" }, 422);
        if (existing && body.sha !== existing.sha) return json({ message: 'conflict' }, 409);
        if (!existing && body.sha) return json({ message: 'conflict' }, 409);
        const changed = mutateFile(body.branch, filePath, Buffer.from(String(body.content || ''), 'base64'));
        const file = changed.files.get(filePath);
        return json({ content: { sha: file.sha }, commit: { sha: changed.sha } }, 201);
      }
      if (method === 'DELETE') {
        const file = branch.files.get(filePath);
        if (!file || file.sha !== body.sha) return json({ message: 'conflict' }, 409);
        const changed = mutateFile(body.branch, filePath, Buffer.alloc(0), true);
        return json({ commit: { sha: deleteCommitSha || changed.sha } }, 200);
      }
    }
    return json({ message: 'not found' }, 404);
  }

  async function gitlabFetch(url, init) {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const base = `/api/v4/projects/${encodeURIComponent(repository)}`;
    if (!parsed.pathname.startsWith(base)) return json({ message: 'unknown repository' }, 404);
    if (method !== 'GET' && !canMutate(init)) return json({ message: 'forbidden' }, 403);
    if (parsed.pathname === base && method === 'GET') {
      return json({ path_with_namespace: repository, default_branch: defaultBranch });
    }
    const branchBase = `${base}/repository/branches`;
    if (parsed.pathname === branchBase && method === 'POST') {
      const body = bodyOf(init);
      const conflict = createBranch(body.branch, body.ref);
      return conflict || json({ name: body.branch, commit: { id: state.branches.get(body.branch).sha } }, 201);
    }
    const branchPrefix = `${branchBase}/`;
    if (parsed.pathname.startsWith(branchPrefix)) {
      const branchName = decodeURIComponent(parsed.pathname.slice(branchPrefix.length));
      if (method === 'GET') {
        const branch = state.branches.get(branchName);
        return branch ? json({ name: branchName, commit: { id: branch.sha } }) : json({ message: 'not found' }, 404);
      }
      if (method === 'DELETE') {
        if (branchName === defaultBranch || !state.branches.delete(branchName)) return json({ message: 'not found' }, 404);
        return json(null, 204);
      }
    }
    /*
     * GET /projects/:id/repository/tree -- an array whose `id` is the blob
     * sha, paginated rather than flagged as truncated.
     */
    if (parsed.pathname === `${base}/repository/tree` && method === 'GET') {
      const branch = state.branches.get(parsed.searchParams.get('ref'));
      if (!branch) return json({ message: 'not found' }, 404);
      return json([...branch.files.entries()].map(([path, file]) => ({
        id: file.sha, name: path.split('/').pop(), type: 'blob', path, mode: '100644'
      })));
    }
    /*
     * Merge requests and issues. The detail path takes `iid`, the
     * project-scoped internal id -- `id` is global to the instance and would
     * not resolve here, which is exactly the mistake the client must not make.
     */
    for (const [segment, seeded] of [['merge_requests', giteaOrGitlabSeed.mergeRequests], ['issues', giteaOrGitlabSeed.issues]]) {
      if (parsed.pathname === `${base}/${segment}` && method === 'GET') return json(seeded);
      const detailPrefix = `${base}/${segment}/`;
      if (parsed.pathname.startsWith(detailPrefix) && method === 'GET') {
        const iid = Number(decodeURIComponent(parsed.pathname.slice(detailPrefix.length)));
        const found = seeded.find(item => item.iid === iid);
        return found ? json(found) : json({ message: '404 Not found' }, 404);
      }
    }
    /*
     * GET /projects/:id/repository/commits/:ref, which accepts a branch name.
     * This is how a caller learns what a delete actually committed, since the
     * delete itself answers with nothing.
     */
    const commitPrefix = `${base}/repository/commits/`;
    if (parsed.pathname.startsWith(commitPrefix) && method === 'GET') {
      const ref = decodeURIComponent(parsed.pathname.slice(commitPrefix.length));
      const branch = state.branches.get(ref)
        || [...state.branches.values()].find(candidate => candidate.sha === ref);
      if (!branch || !branch.tip) return json({ message: 'not found' }, 404);
      return json({
        id: branch.tip.id,
        parent_ids: branch.tip.parentIds,
        message: branch.tip.message,
        title: String(branch.tip.message).split('\n')[0]
      });
    }
    const filePrefix = `${base}/repository/files/`;
    if (parsed.pathname.startsWith(filePrefix)) {
      const filePath = decodeURIComponent(parsed.pathname.slice(filePrefix.length));
      if (method === 'GET') {
        const branch = state.branches.get(parsed.searchParams.get('ref'));
        const file = branch && branch.files.get(filePath);
        return file
          ? json({
            content: file.content.toString('base64'),
            blob_id: file.sha,
            // GitLab's file read carries the ref's commit and the commit that
            // last modified this file. The write response carries neither.
            commit_id: branch.sha,
            last_commit_id: file.lastCommitId
          })
          : json({ message: 'not found' }, 404);
      }
      const body = bodyOf(init);
      const branch = state.branches.get(body.branch);
      if (!branch) return json({ message: 'not found' }, 404);
      if (method === 'PUT') {
        /*
         * GitLab's conditional update, transcribed from Files::BaseService.
         *
         *   def file_has_changed?(path, commit_id)
         *     return false unless commit_id
         *     last_commit_from_branch = get_last_commit_for_path(ref: @start_branch, path: path)
         *     return false unless last_commit_from_branch
         *     last_commit_from_commit_id = get_last_commit_for_path(ref: commit_id, path: path)
         *     return false unless last_commit_from_commit_id
         *     last_commit_from_branch.sha != last_commit_from_commit_id.sha
         *   end
         *
         * It does not ask "is this the file's current commit". It asks whether
         * the file's last commit DIFFERS between the branch and the ref the
         * writer named. A ref where the path does not exist yields no commit,
         * and no commit is read as no information -- so the write is allowed.
         *
         * The fixture used to compare last_commit_id against the file's
         * current lastCommitId and answer 409, which refuses strictly more
         * than GitLab does. Under that fixture a token naming a commit from
         * before the file existed looked like a conflict; against gitlab.com
         * the same token was accepted and the write landed. Runs 63 and 64
         * died on the difference.
         */
        const existing = branch.files.get(filePath);
        if (!existing) return json({ message: 'not found' }, 404);
        const content = Buffer.from(String(body.content || ''), 'base64');
        if (body.last_commit_id) {
          const onBranch = lastCommitForPath(body.branch, filePath);
          const onRef = lastCommitForPath(body.last_commit_id, filePath);
          if (onBranch && onRef && onBranch !== onRef) {
            /*
             * 400, not 409, and the message is the only thing distinguishing
             * this from the other reasons GitLab rejects a commit.
             */
            return json({
              message: 'You are attempting to update a file that has changed since you started editing it'
            }, 400);
          }
        }
        /*
         * GitLab refuses a commit that changes nothing, with the same 400 and
         * a different message. A proof that sent identical bytes would be
         * refused for the wrong reason and could not tell the two apart.
         */
        if (existing.content.equals(content)) {
          return json({ message: 'A commit with the same content already exists' }, 400);
        }
        mutateFile(body.branch, filePath, content, false, body.commit_message);
        return json({ file_path: filePath, branch: body.branch }, 200);
      }
      if (method === 'POST') {
        mutateFile(body.branch, filePath, Buffer.from(String(body.content || ''), 'base64'), false, body.commit_message);
        /*
         * Exactly what GitLab documents for a created file, and nothing more:
         * branch and file_path. It returns no commit id.
         *
         * This fixture used to invent one. The client read it, every test
         * agreed, and the first live GitLab write failed on an empty commit
         * sha. A fixture kinder than the provider manufactures confidence,
         * which is worse than having no fixture at all.
         */
        return json({ file_path: filePath, branch: body.branch }, 201);
      }
      if (method === 'DELETE') {
        if (!branch.files.has(filePath)) return json({ message: 'not found' }, 404);
        /*
         * Files::DeleteService runs the same file_has_changed? check as the
         * update, and raises FileChangedError with its own wording. The
         * fixture used to compare last_commit_id against the BRANCH HEAD and
         * answer 409 -- wrong on the comparison, the status and the message,
         * and it happened to pass only because this run's head and the file's
         * last commit coincide.
         */
        if (body.last_commit_id) {
          const onBranch = lastCommitForPath(body.branch, filePath);
          const onRef = lastCommitForPath(body.last_commit_id, filePath);
          if (onBranch && onRef && onBranch !== onRef) {
            return json({
              message: 'You are attempting to delete a file that has been previously updated'
            }, 400);
          }
        }
        mutateFile(body.branch, filePath, Buffer.alloc(0), true, body.commit_message);
        // GitLab answers a delete with 204 and an empty body.
        return json(null, 204);
      }
    }
    return json({ message: 'not found' }, 404);
  }

  async function giteaFetch(url, init) {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const base = `/api/v1/repos/${repository}`;
    if (!parsed.pathname.startsWith(base)) return json({ message: 'unknown repository' }, 404);
    if (method !== 'GET' && !canMutate(init)) return json({ message: 'forbidden' }, 403);
    if (parsed.pathname === base && method === 'GET') {
      return json({ full_name: repository, default_branch: defaultBranch });
    }
    const branchBase = `${base}/branches`;
    if (parsed.pathname === branchBase && method === 'POST') {
      const body = bodyOf(init);
      /*
       * Gitea's own option object separates these: old_branch_name is marked
       * deprecated and names a BRANCH, while old_ref_name names a branch, tag
       * or commit. A commit sha handed to old_branch_name is looked up as a
       * branch name and is not found -- so the fixture must not resolve it,
       * or a client using the wrong field passes here and fails live.
       */
      const conflict = body.old_ref_name
        ? createBranch(body.new_branch_name, body.old_ref_name)
        : createBranch(body.new_branch_name, body.old_branch_name, { commitsAllowed: false });
      return conflict || json({ name: body.new_branch_name, commit: { id: state.branches.get(body.new_branch_name).sha } }, 201);
    }
    const branchPrefix = `${branchBase}/`;
    if (parsed.pathname.startsWith(branchPrefix)) {
      const branchName = decodeURIComponent(parsed.pathname.slice(branchPrefix.length));
      if (method === 'GET') {
        const branch = state.branches.get(branchName);
        return branch ? json({ name: branchName, commit: { id: branch.sha } }) : json({ message: 'not found' }, 404);
      }
      if (method === 'DELETE') {
        if (branchName === defaultBranch || !state.branches.delete(branchName)) return json({ message: 'not found' }, 404);
        return json(null, 204);
      }
    }
    const contentPrefix = `${base}/contents/`;
    if (parsed.pathname.startsWith(contentPrefix)) {
      const filePath = decodeURIComponent(parsed.pathname.slice(contentPrefix.length));
      if (method === 'GET') {
        const branch = state.branches.get(parsed.searchParams.get('ref'));
        const file = branch && branch.files.get(filePath);
        return file ? json({ content: file.content.toString('base64'), sha: file.sha }) : json({ message: 'not found' }, 404);
      }
      const body = bodyOf(init);
      const branch = state.branches.get(body.branch);
      if (!branch) return json({ message: 'not found' }, 404);
      if (method === 'PUT') {
        /* Gitea keys an update on the blob sha, the same way GitHub does. */
        const existing = branch.files.get(filePath);
        if (!existing) return json({ message: 'not found' }, 404);
        if (body.sha !== existing.sha) return json({ message: 'conflict' }, 409);
        const changed = mutateFile(body.branch, filePath, Buffer.from(String(body.content || ''), 'base64'));
        return json({ content: changed.files.get(filePath), commit: { sha: changed.sha } }, 200);
      }
      if (method === 'POST') {
        const changed = mutateFile(body.branch, filePath, Buffer.from(String(body.content || ''), 'base64'));
        return json({ content: changed.files.get(filePath), commit: { sha: changed.sha } }, 201);
      }
      if (method === 'DELETE') {
        const file = branch.files.get(filePath);
        if (!file || body.sha !== file.sha) return json({ message: 'conflict' }, 409);
        const changed = mutateFile(body.branch, filePath, Buffer.alloc(0), true);
        return json({ commit: { sha: deleteCommitSha || changed.sha } }, 200);
      }
    }
    return json({ message: 'not found' }, 404);
  }

  const routers = { github: githubFetch, gitlab: gitlabFetch, gitea: giteaFetch };
  return Object.freeze({
    state,
    fetch: async (url, init = {}) => {
      state.requests.push({ method: String(init.method || 'GET').toUpperCase(), url: String(url) });
      return routers[provider](url, init);
    }
  });
}

module.exports = Object.freeze({ createProviderFetchFixture });
