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

function cloneBranch(branch) {
  return {
    sha: branch.sha,
    files: new Map([...branch.files.entries()].map(([name, file]) => [name, {
      content: Buffer.from(file.content),
      sha: file.sha
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
    branches: new Map([[defaultBranch, { sha: initialSha, files: new Map() }]])
  };

  function nextSha(material) {
    state.counter += 1;
    return crypto.createHash('sha1').update(`${provider}:${state.counter}:${material}`).digest('hex');
  }

  function fileSha(content) {
    return crypto.createHash('sha1').update(content).digest('hex');
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

  function findSource(ref) {
    if (state.branches.has(ref)) return state.branches.get(ref);
    return [...state.branches.values()].find(branch => branch.sha === ref) || null;
  }

  function createBranch(name, ref) {
    const source = findSource(ref);
    if (!source || state.branches.has(name)) return json({ message: 'conflict' }, 409);
    state.branches.set(name, cloneBranch(source));
    return null;
  }

  function mutateFile(branchName, filePath, content, remove = false) {
    const branch = state.branches.get(branchName);
    if (!branch) return null;
    if (remove) branch.files.delete(filePath);
    else branch.files.set(filePath, { content, sha: fileSha(content) });
    branch.sha = nextSha(`${branchName}:${filePath}:${remove ? 'delete' : 'write'}`);
    return branch;
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
    const filePrefix = `${base}/repository/files/`;
    if (parsed.pathname.startsWith(filePrefix)) {
      const filePath = decodeURIComponent(parsed.pathname.slice(filePrefix.length));
      if (method === 'GET') {
        const branch = state.branches.get(parsed.searchParams.get('ref'));
        const file = branch && branch.files.get(filePath);
        return file ? json({ content: file.content.toString('base64'), blob_id: file.sha }) : json({ message: 'not found' }, 404);
      }
      const body = bodyOf(init);
      const branch = state.branches.get(body.branch);
      if (!branch) return json({ message: 'not found' }, 404);
      if (method === 'POST') {
        const changed = mutateFile(body.branch, filePath, Buffer.from(String(body.content || ''), 'base64'));
        return json({ file_path: filePath, branch: body.branch, commit_id: changed.sha }, 201);
      }
      if (method === 'DELETE') {
        if (!branch.files.has(filePath) || body.last_commit_id !== branch.sha) return json({ message: 'conflict' }, 409);
        mutateFile(body.branch, filePath, Buffer.alloc(0), true);
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
      const conflict = createBranch(body.new_branch_name, body.old_branch_name);
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
