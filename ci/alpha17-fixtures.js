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
  if (provider !== 'github') throw new TypeError('fixture provider is invalid');
  const initialSha = '1'.repeat(40);
  const state = {
    counter: 1,
    defaultBranch,
    requests: [],
    /* oid -> size, for objects the LFS store has actually been handed. */
    lfsObjects: new Map(),
    branches: new Map([[defaultBranch, { sha: initialSha, files: new Map() }]]),
    // Commit history supports the GitHub ancestry and readback proofs.
    commits: new Map(),
    /*
     * The Git Data object stores. A branch head alone cannot answer what tree
     * a commit names or what bytes an object holds, and the push proofs ask
     * both.
     */
    blobs: new Map(),
    trees: new Map(),
    /*
     * The collaboration surface the GitHub probes write to: issues, pull
     * requests, releases and their tags, workflow runs, the account's stars
     * and the code-search index. Each starts with the permanent fixture the
     * real target carries, so the collection probes still read a seeded
     * object, and each grows only through the endpoints that grow it on
     * GitHub -- a probe cannot pass by writing somewhere GitHub would not.
     */
    clock: Date.parse('2026-09-26T12:00:00.000Z'),
    nextNumber: 100,
    issues: new Map([[11, { number: 11, title: 'fixture', body: 'Permanent issues.read fixture.', state: 'open', comments: [] }]]),
    pulls: new Map([[7, {
      number: 7, title: 'fixture', body: 'Permanent pulls.read fixture.', state: 'open', merged: false,
      head: { ref: 'nvx-alpha17-fixture-pull', sha: '7'.repeat(40) }, base: { ref: defaultBranch }, reviews: []
    }]]),
    releases: new Map([[21, { id: 21, tag_name: 'fixture', name: 'fixture', target_commitish: defaultBranch, prerelease: false, draft: false }]]),
    tags: new Map([['fixture', initialSha]]),
    runs: new Map([[31, {
      id: 31, workflow_id: 41, name: 'fixture', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
      run_attempt: 1, created_at: '2026-08-01T00:00:00.000Z', reads: 0
    }]]),
    starred: false,
    searchIndex: [{ path: 'NVX_SEARCH_FIXTURE.md', text: 'nvx-alpha17-search-fixture: permanent code search fixture.' }]
  };

  function tick() {
    state.clock += 1000;
    return new Date(state.clock).toISOString();
  }

  /*
   * A tree listing as GitHub gives it: blobs and the directories above them,
   * each directory with an identity of its own that resolves to the subtree.
   * Recursive lists every path; otherwise one level, which is what a path
   * walk reads a segment at a time.
   */
  function subtreeSha(files, dir) {
    const prefix = `${dir}/`;
    const sub = new Map();
    for (const [name, file] of files) if (name.startsWith(prefix)) sub.set(name.slice(prefix.length), file);
    const sha = crypto.createHash('sha1')
      .update([...sub.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => `${name}:${file.sha}`).join('\n'))
      .digest('hex');
    state.trees.set(sha, sub);
    return sha;
  }
  function treeListing(files, recursive) {
    const out = new Map();
    for (const [name, file] of files) {
      const parts = name.split('/');
      if (!recursive && parts.length > 1) {
        if (!out.has(parts[0])) out.set(parts[0], { path: parts[0], mode: '040000', type: 'tree', sha: subtreeSha(files, parts[0]) });
        continue;
      }
      for (let index = 1; index < parts.length; index += 1) {
        const dir = parts.slice(0, index).join('/');
        if (!out.has(dir)) out.set(dir, { path: dir, mode: '040000', type: 'tree', sha: subtreeSha(files, dir) });
      }
      out.set(name, { path: name, mode: '100644', type: 'blob', sha: file.sha, size: file.content.length });
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  function filesAt(key) {
    if (state.branches.has(key)) return state.branches.get(key).files;
    if (state.commits.has(key)) return state.commits.get(key).files;
    if (state.trees.has(key)) return state.trees.get(key);
    if (key === initialSha) return new Map();
    return null;
  }

  /* What a commit changed against its first parent, as the commits API reports it. */
  function commitChanges(commit) {
    const before = (commit.parentIds[0] && filesAt(commit.parentIds[0])) || new Map();
    const lines = content => content.toString('utf8').replace(/\n$/, '').split('\n');
    const changes = [];
    for (const [name, file] of commit.files) {
      const prior = before.get(name);
      if (prior && prior.sha === file.sha) continue;
      const added = lines(file.content);
      changes.push({
        filename: name,
        status: prior ? 'modified' : 'added',
        sha: file.sha,
        patch: prior
          ? `@@ -1,${lines(prior.content).length} +1,${added.length} @@\n${lines(prior.content).map(line => `-${line}`).join('\n')}\n${added.map(line => `+${line}`).join('\n')}`
          : `@@ -0,0 +1,${added.length} @@\n${added.map(line => `+${line}`).join('\n')}`
      });
    }
    for (const [name, prior] of before) {
      if (!commit.files.has(name)) changes.push({ filename: name, status: 'removed', sha: prior.sha });
    }
    return changes.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  function commitView(commit) {
    return {
      sha: commit.id,
      commit: { committer: { date: commit.date }, author: { date: commit.date } },
      parents: commit.parentIds.filter(Boolean).map(id => ({ sha: id }))
    };
  }

  /* Every ancestor, newest first -- all parents, not only the first. */
  function history(fromSha) {
    const out = [];
    const seen = new Set();
    const queue = [fromSha];
    while (queue.length) {
      const sha = queue.shift();
      if (!sha || seen.has(sha) || !state.commits.has(sha)) continue;
      seen.add(sha);
      const commit = state.commits.get(sha);
      out.push(commit);
      queue.push(...commit.parentIds);
    }
    return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

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
   * Git LFS authenticates with Basic, not Bearer, and the product signs it as
   * `login:token`. Checked here rather than by widening canMutate, because a
   * Bearer check that also accepted Basic would stop noticing if the product
   * started sending the wrong scheme to the wrong endpoint.
   */
  function canMutateLfs(init) {
    const header = new Headers(init.headers || {}).get('authorization') || '';
    const match = /^Basic (.+)$/.exec(header);
    if (!match) return false;
    let decoded = '';
    try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { return false; }
    const separator = decoded.indexOf(':');
    if (separator < 1) return false;
    return decoded.slice(separator + 1) === mutationCredential;
  }

  /*
   * `commitsAllowed` exists because providers do not all accept a commit
   * wherever they accept a branch. Resolving both interchangeably made the
   * fixture answer a question no real provider was asked.
   */
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
    else {
      branch.files.set(filePath, { content, sha: fileSha(content) });
      /* A file written through the contents API is an object like any other,
         and a tree may name it by its identity -- a rename does exactly that. */
      state.blobs.set(fileSha(content), Buffer.from(content));
    }
    const parent = branch.sha;
    branch.sha = nextSha(`${branchName}:${filePath}:${remove ? 'delete' : 'write'}`);
    // Record the commit that last touched the file, separately from branch head.
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
      date: tick(),
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

  async function githubFetch(url, init) {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const base = `/repos/${repository}`;
    /* Hrefs must lead back to the fixture, whichever origin the caller used. */
    const lfsStorageOrigin = parsed.origin;
    /* Account-wide rather than repository-scoped, so it is answered first. */
    if (parsed.pathname === '/rate_limit' && method === 'GET') {
      return json({ resources: { core: { limit: 5000, remaining: 4987 } } });
    }
    /* Also account-wide: the LFS probe signs Basic auth with the actor's login. */
    if (parsed.pathname === '/user' && method === 'GET') {
      return json({ login: 'alpha17-fixture-actor' });
    }
    /*
     * The LFS store. Modelled, not stubbed: the batch endpoint offers an upload
     * action only for an object it does not hold, which is the behaviour the
     * probe's deduplication proof turns on. A fixture that always offered one
     * would let a provider that never stored the bytes pass.
     */
    if (parsed.pathname === `/${repository}.git/info/lfs/objects/batch` && method === 'POST') {
      if (!canMutateLfs(init)) return json({ message: 'forbidden' }, 403);
      const body = bodyOf(init);
      if (String(body.operation || '') !== 'upload') return json({ message: 'unsupported operation' }, 422);
      const objects = (Array.isArray(body.objects) ? body.objects : []).map(requested => {
        const oid = String(requested.oid || '');
        const size = Number(requested.size);
        if (!/^[0-9a-f]{64}$/.test(oid) || !Number.isSafeInteger(size) || size < 0) {
          return { oid, size, error: { code: 422, message: 'invalid object' } };
        }
        if (state.lfsObjects.has(oid)) return { oid, size };
        return {
          oid,
          size,
          actions: {
            upload: { href: `${lfsStorageOrigin}/lfs-storage/${oid}`, header: { 'x-nv-fixture': 'upload' } },
            verify: { href: `${lfsStorageOrigin}/${repository}.git/info/lfs/objects/verify` }
          }
        };
      });
      return json({ transfer: 'basic', objects });
    }
    const lfsStoragePrefix = '/lfs-storage/';
    if (parsed.pathname.startsWith(lfsStoragePrefix) && method === 'PUT') {
      const oid = parsed.pathname.slice(lfsStoragePrefix.length);
      const body = init.body;
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
      /*
       * The oid is the sha256 of the bytes, so the fixture recomputes it rather
       * than trusting the path. A store that accepted any bytes under any name
       * would make the second batch response meaningless.
       */
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== oid) return json({ message: 'object identity mismatch' }, 422);
      state.lfsObjects.set(oid, bytes.length);
      return json({}, 200);
    }
    if (parsed.pathname === `/${repository}.git/info/lfs/objects/verify` && method === 'POST') {
      const body = bodyOf(init);
      const oid = String(body.oid || '');
      if (!state.lfsObjects.has(oid)) return json({ message: 'object not found' }, 404);
      return json({ oid, size: state.lfsObjects.get(oid) });
    }
    /* The account's star on this repository: 204 when starred, 404 when not. */
    if (parsed.pathname === `/user/starred/${repository}`) {
      if (method === 'GET') return state.starred ? json(null, 204) : json({ message: 'not found' }, 404);
      if (!canMutate(init)) return json({ message: 'forbidden' }, 403);
      if (method === 'PUT') { state.starred = true; return json(null, 204); }
      if (method === 'DELETE') { state.starred = false; return json(null, 204); }
    }
    /*
     * Code search over the default branch's index. Qualifiers other than the
     * repository are not modelled, and a query without the repository
     * qualifier finds nothing here -- the fixture holds one repository.
     */
    if (parsed.pathname === '/search/code' && method === 'GET') {
      const q = String(parsed.searchParams.get('q') || '');
      const terms = q.split(/\s+/).filter(Boolean);
      const scoped = terms.some(term => term.toLowerCase() === `repo:${repository}`.toLowerCase());
      const words = terms.filter(term => !/^[a-z]+:/i.test(term));
      const items = scoped && words.length
        ? state.searchIndex.filter(entry => words.every(word => entry.text.includes(word))).map(entry => ({
          name: entry.path.split('/').pop(), path: entry.path, repository: { full_name: repository }
        }))
        : [];
      return json({ total_count: items.length, incomplete_results: false, items });
    }
    if (!parsed.pathname.startsWith(base)) return json({ message: 'unknown repository' }, 404);
    if (method !== 'GET' && !canMutate(init)) return json({ message: 'forbidden' }, 403);
    if (parsed.pathname === base && method === 'GET') {
      return json({ full_name: repository, default_branch: defaultBranch });
    }
    /* GET /repos/:owner/:repo/branches/:branch, the branch with its head commit. */
    const branchesPrefix = `${base}/branches/`;
    if (parsed.pathname.startsWith(branchesPrefix) && method === 'GET') {
      const name = decodeURIComponent(parsed.pathname.slice(branchesPrefix.length));
      const branch = state.branches.get(name);
      return branch ? json({ name, commit: { sha: branch.sha } }) : json({ message: 'Branch not found' }, 404);
    }
    const tagRefPrefix = `${base}/git/ref/tags/`;
    if (parsed.pathname.startsWith(tagRefPrefix) && method === 'GET') {
      const sha = state.tags.get(decodeURIComponent(parsed.pathname.slice(tagRefPrefix.length)));
      return sha ? json({ object: { sha, type: 'commit' } }) : json({ message: 'not found' }, 404);
    }
    const tagDeletePrefix = `${base}/git/refs/tags/`;
    if (parsed.pathname.startsWith(tagDeletePrefix) && method === 'DELETE') {
      const tag = decodeURIComponent(parsed.pathname.slice(tagDeletePrefix.length));
      if (!state.tags.delete(tag)) return json({ message: 'Reference does not exist' }, 422);
      return json(null, 204);
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
    /*
     * The commits API, which the exposure reader walks: a ref resolved to its
     * sha on request, history newest first from a commit, and one commit with
     * the files it changed and their patches.
     */
    if (parsed.pathname === `${base}/commits` && method === 'GET') {
      const from = String(parsed.searchParams.get('sha') || '');
      const start = state.branches.has(from) ? state.branches.get(from).sha : from;
      const perPage = Math.max(1, Math.min(100, Number(parsed.searchParams.get('per_page') || 30)));
      const page = Math.max(1, Number(parsed.searchParams.get('page') || 1));
      const all = history(start);
      if (!all.length && !state.commits.has(start) && start !== initialSha) return json({ message: 'not found' }, 404);
      return json(all.slice((page - 1) * perPage, page * perPage).map(commitView));
    }
    const commitsApiPrefix = `${base}/commits/`;
    if (parsed.pathname.startsWith(commitsApiPrefix) && method === 'GET') {
      const ref = decodeURIComponent(parsed.pathname.slice(commitsApiPrefix.length));
      const sha = state.branches.has(ref) ? state.branches.get(ref).sha : ref;
      const commit = state.commits.get(sha);
      if (!commit) return json({ message: 'not found' }, 404);
      const accept = new Headers(init.headers || {}).get('accept') || '';
      if (accept.includes('application/vnd.github.sha')) {
        return new Response(commit.id, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      const perPage = Math.max(1, Math.min(300, Number(parsed.searchParams.get('per_page') || 300)));
      const page = Math.max(1, Number(parsed.searchParams.get('page') || 1));
      return json({ ...commitView(commit), files: commitChanges(commit).slice((page - 1) * perPage, page * perPage) });
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
        date: tick(),
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
        state.blobs.set(fileSha(bytes), Buffer.from(bytes));
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
     * Issues. A pull request is not listed here: the real endpoint does list
     * them, and the dispatch procedure says to expect it, but the probes do
     * not depend on the difference and the fixture keeps the two apart.
     */
    const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(parsed.pathname.slice(base.length));
    if (parsed.pathname === `${base}/issues` && method === 'POST') {
      const body = bodyOf(init);
      if (!String(body.title || '').trim()) return json({ message: 'title is required' }, 422);
      const number = state.nextNumber++;
      const issue = { number, title: String(body.title), body: String(body.body || ''), state: 'open', comments: [] };
      state.issues.set(number, issue);
      return json({ number, title: issue.title, body: issue.body, state: issue.state }, 201);
    }
    if (issueMatch) {
      const issue = state.issues.get(Number(issueMatch[1]));
      if (!issue) return json({ message: 'not found' }, 404);
      if (issueMatch[2]) {
        if (method === 'GET') return json(issue.comments.map(comment => ({ ...comment })));
        if (method === 'POST') {
          const body = bodyOf(init);
          if (!String(body.body || '').trim()) return json({ message: 'body is required' }, 422);
          const comment = { id: state.nextNumber++, body: String(body.body) };
          issue.comments.push(comment);
          return json({ ...comment }, 201);
        }
      }
      if (!issueMatch[2] && method === 'GET') return json({ number: issue.number, title: issue.title, body: issue.body, state: issue.state });
      if (!issueMatch[2] && method === 'PATCH') {
        const body = bodyOf(init);
        if (body.state && !['open', 'closed'].includes(body.state)) return json({ message: 'invalid state' }, 422);
        if (body.state) issue.state = body.state;
        return json({ number: issue.number, title: issue.title, state: issue.state });
      }
    }
    /*
     * Pull requests. The head's identity is read from the branch at the time
     * of asking, because that is what makes the merge precondition mean
     * anything: GitHub refuses a merge whose `sha` is not the head it has now.
     */
    const pullView = pull => {
      const head = state.branches.get(pull.head.ref);
      const baseBranch = state.branches.get(pull.base.ref);
      return {
        number: pull.number, title: pull.title, body: pull.body, state: pull.state, merged: pull.merged,
        head: { ref: pull.head.ref, sha: head && !pull.merged ? head.sha : pull.head.sha },
        base: { ref: pull.base.ref, sha: baseBranch ? baseBranch.sha : null }
      };
    };
    const pullMatch = /^\/pulls\/(\d+)(\/merge|\/reviews|\/files)?$/.exec(parsed.pathname.slice(base.length));
    if (parsed.pathname === `${base}/pulls` && method === 'POST') {
      const body = bodyOf(init);
      const head = state.branches.get(String(body.head || ''));
      const baseBranch = state.branches.get(String(body.base || ''));
      if (!head || !baseBranch) return json({ message: 'Validation Failed' }, 422);
      if (head.sha === baseBranch.sha) return json({ message: 'No commits between base and head' }, 422);
      const number = state.nextNumber++;
      state.pulls.set(number, {
        number, title: String(body.title || ''), body: String(body.body || ''), state: 'open', merged: false,
        head: { ref: String(body.head), sha: head.sha }, base: { ref: String(body.base) }, reviews: []
      });
      return json(pullView(state.pulls.get(number)), 201);
    }
    if (pullMatch) {
      const pull = state.pulls.get(Number(pullMatch[1]));
      if (!pull) return json({ message: 'not found' }, 404);
      if (pullMatch[2] === '/reviews' && method === 'POST') {
        const body = bodyOf(init);
        const event = String(body.event || '');
        if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) return json({ message: 'invalid event' }, 422);
        if (event === 'COMMENT' && !String(body.body || '').trim()) return json({ message: 'body is required for a comment review' }, 422);
        const review = { id: state.nextNumber++, state: event === 'COMMENT' ? 'COMMENTED' : event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED' };
        pull.reviews.push(review);
        return json({ ...review });
      }
      if (pullMatch[2] === '/merge' && method === 'PUT') {
        if (pull.merged || pull.state !== 'open') return json({ message: 'Pull Request is not mergeable' }, 405);
        const head = state.branches.get(pull.head.ref);
        const baseBranch = state.branches.get(pull.base.ref);
        if (!head || !baseBranch) return json({ message: 'not found' }, 404);
        const body = bodyOf(init);
        if (body.sha && String(body.sha) !== head.sha) {
          return json({ message: 'Head branch was modified. Review and try the merge again.' }, 409);
        }
        const files = snapshotFiles(baseBranch.files);
        for (const [name, file] of head.files) files.set(name, { content: Buffer.from(file.content), sha: file.sha });
        const sha = nextSha(`merge:${pull.number}`);
        const treeSha = nextSha('merge:tree');
        state.trees.set(treeSha, snapshotFiles(files));
        state.commits.set(sha, { id: sha, parentIds: [baseBranch.sha, head.sha], date: tick(), path: null, treeSha, files: snapshotFiles(files) });
        pull.head.sha = head.sha;
        baseBranch.sha = sha;
        baseBranch.files = snapshotFiles(files);
        pull.merged = true;
        pull.state = 'closed';
        return json({ sha, merged: true, message: 'Pull Request successfully merged' });
      }
      /* The files a pull request changes: its head against its base. */
      if (pullMatch[2] === '/files' && method === 'GET') {
        const head = state.branches.get(pull.head.ref);
        const baseBranch = state.branches.get(pull.base.ref);
        if (!head || !baseBranch) return json([]);
        const changed = [];
        for (const [name, file] of head.files) {
          const prior = baseBranch.files.get(name);
          if (!prior || prior.sha !== file.sha) changed.push({ filename: name, status: prior ? 'modified' : 'added', additions: 1, deletions: prior ? 1 : 0, patch: '' });
        }
        return json(changed);
      }
      if (!pullMatch[2] && method === 'GET') return json(pullView(pull));
    }
    if (parsed.pathname === `${base}/pulls` && method === 'GET') {
      return json([...state.pulls.values()].filter(pull => pull.number === 7 || parsed.searchParams.get('state') === 'all' || pull.state === 'open').map(pullView));
    }
    if (parsed.pathname === `${base}/issues` && method === 'GET') {
      return json([...state.issues.values()].map(issue => ({ number: issue.number, title: issue.title, state: issue.state })));
    }
    /*
     * Releases. Publishing one that is not a draft creates its tag at the
     * target, as GitHub does, so a probe that removes the release and leaves
     * the tag leaves something behind -- and the fixture can see it.
     */
    const releaseMatch = /^\/releases\/(\d+)$/.exec(parsed.pathname.slice(base.length));
    if (parsed.pathname === `${base}/releases` && method === 'POST') {
      const body = bodyOf(init);
      const tag = String(body.tag_name || '');
      if (!tag || [...state.releases.values()].some(release => release.tag_name === tag)) return json({ message: 'Validation Failed' }, 422);
      const target = String(body.target_commitish || defaultBranch);
      const branch = state.branches.get(target);
      if (!state.tags.has(tag)) {
        if (!branch) return json({ message: 'Validation Failed' }, 422);
        if (!body.draft) state.tags.set(tag, branch.sha);
      }
      const id = state.nextNumber++;
      const release = {
        id, tag_name: tag, name: String(body.name || tag), target_commitish: target,
        prerelease: body.prerelease === true, draft: body.draft === true
      };
      state.releases.set(id, release);
      return json({ ...release }, 201);
    }
    if (releaseMatch) {
      const id = Number(releaseMatch[1]);
      const release = state.releases.get(id);
      if (!release) return json({ message: 'not found' }, 404);
      if (method === 'GET') return json({ ...release });
      if (method === 'DELETE') { state.releases.delete(id); return json(null, 204); }
    }
    if (parsed.pathname === `${base}/releases` && method === 'GET') {
      return json([...state.releases.values()].filter(release => !release.draft).map(release => ({ ...release })));
    }
    /*
     * Workflow runs. A dispatched run is queued, then running, then complete
     * as it is read; a run can be re-run only once it is complete and while it
     * is younger than thirty days, which is why the permanent fixture run
     * cannot be the one a probe re-runs.
     */
    const runView = run => ({
      id: run.id, workflow_id: run.workflow_id, name: run.name, event: run.event, status: run.status,
      conclusion: run.conclusion, run_attempt: run.run_attempt, created_at: run.created_at
    });
    const advance = run => {
      run.reads += 1;
      if (run.status === 'queued') run.status = 'in_progress';
      else if (run.status === 'in_progress') { run.status = 'completed'; run.conclusion = 'success'; }
      return run;
    };
    const dispatchMatch = /^\/actions\/workflows\/(\d+)\/(dispatches|runs)$/.exec(parsed.pathname.slice(base.length));
    if (dispatchMatch) {
      const workflowId = Number(dispatchMatch[1]);
      if (![...state.runs.values()].some(run => run.workflow_id === workflowId)) return json({ message: 'not found' }, 404);
      if (dispatchMatch[2] === 'dispatches' && method === 'POST') {
        const body = bodyOf(init);
        if (!state.branches.has(String(body.ref || ''))) return json({ message: 'No ref found' }, 422);
        const id = state.nextNumber++;
        state.runs.set(id, {
          id, workflow_id: workflowId, name: 'fixture', event: 'workflow_dispatch', status: 'queued', conclusion: null,
          run_attempt: 1, created_at: tick(), reads: 0
        });
        return json(null, 204);
      }
      if (dispatchMatch[2] === 'runs' && method === 'GET') {
        const event = parsed.searchParams.get('event');
        const runs = [...state.runs.values()]
          .filter(run => run.workflow_id === workflowId && (!event || run.event === event))
          .sort((a, b) => b.id - a.id);
        return json({ total_count: runs.length, workflow_runs: runs.map(runView) });
      }
    }
    const runMatch = /^\/actions\/runs\/(\d+)(\/rerun)?$/.exec(parsed.pathname.slice(base.length));
    if (runMatch) {
      const run = state.runs.get(Number(runMatch[1]));
      if (!run) return json({ message: 'not found' }, 404);
      if (runMatch[2] && method === 'POST') {
        if (run.status !== 'completed') return json({ message: 'This workflow is already running' }, 403);
        if (state.clock - Date.parse(run.created_at) > 30 * 86400000) {
          return json({ message: 'Unable to re-run this workflow run because it was created over a month ago' }, 403);
        }
        run.run_attempt += 1;
        run.status = 'queued';
        run.conclusion = null;
        return json({}, 201);
      }
      if (!runMatch[2] && method === 'GET') return json(runView(run.id === 31 ? run : advance(run)));
    }
    if (parsed.pathname === `${base}/actions/runs` && method === 'GET') {
      const runs = [...state.runs.values()].sort((a, b) => b.id - a.id).map(runView);
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    /*
     * A tree by branch, commit or tree identity, as GitHub resolves any
     * tree-ish: recursive lists every path and the directories above them, and
     * without it one level, whose directories carry the identity of their own
     * subtree -- which is what a path walk reads a segment at a time.
     */
    const treePrefix = `${base}/git/trees/`;
    if (parsed.pathname.startsWith(treePrefix) && method === 'GET') {
      const key = decodeURIComponent(parsed.pathname.slice(treePrefix.length));
      const files = filesAt(key);
      if (!files) return json({ message: 'not found' }, 404);
      return json({
        sha: key,
        truncated: false,
        tree: treeListing(files, parsed.searchParams.has('recursive'))
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

  return Object.freeze({
    state,
    fetch: async (url, init = {}) => {
      state.requests.push({ method: String(init.method || 'GET').toUpperCase(), url: String(url) });
      return githubFetch(url, init);
    }
  });
}

module.exports = Object.freeze({ createProviderFetchFixture });
