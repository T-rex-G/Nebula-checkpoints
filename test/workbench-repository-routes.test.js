'use strict';
/*
 * The workbench's repository, content and history routes, over HTTP (D12),
 * on the module's own commit writer, repository list and LFS transfer, with a
 * small scripted GitHub: CODEOWNERS; the repositories a session may see and
 * one repository's view; deletion and the archive; branches and a
 * comparison; folders, files and raw bytes; a file saved, deleted, renamed,
 * and many changes committed at once; commits and a revert.
 *
 * What each must hold: the chain the route policy records; a list held to
 * what the hosted alpha lets the session see; content a browser would run
 * served as a download; an LFS pointer answered from storage reached over
 * HTTPS only; every write one commit on the head the view was loaded at,
 * never forced, keeping the mode of the path it replaces; a rename that will
 * not overwrite and will not move a folder; a batch that names its head; and
 * a revert refused for a merge or a protected path before anything is written.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const workbench = require('../apps/api/src/modules/workbench/index.ts');
const { locations } = require('./oracles/route-policy');
const inventory = require('../docs/architecture/mission/ROUTE_INVENTORY.json');

const root = path.resolve(__dirname, '..');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), T = 'd'.repeat(40), P = 'e'.repeat(40);
const OID = 'f'.repeat(64);
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 11\n`;
const b64 = text => Buffer.from(text, 'utf8').toString('base64');

/* ---- The chains, as the baseline inventory recorded them and the route policy reads them now ---- */
const MOVED = [
  'GET /api/repo/:owner/:repo/codeowners', 'GET /api/repos', 'POST /api/repos', 'GET /api/repo/:owner/:repo', 'DELETE /api/repo/:owner/:repo',
  'GET /api/repo/:owner/:repo/zip', 'POST /api/repo/:owner/:repo/branches', 'DELETE /api/repo/:owner/:repo/branches/:name',
  'GET /api/repo/:owner/:repo/compare', 'GET /api/repo/:owner/:repo/tree', 'GET /api/repo/:owner/:repo/files', 'GET /api/repo/:owner/:repo/file',
  'GET /api/repo/:owner/:repo/raw', 'PUT /api/repo/:owner/:repo/file', 'DELETE /api/repo/:owner/:repo/file', 'POST /api/repo/:owner/:repo/rename',
  'POST /api/repo/:owner/:repo/batch', 'GET /api/repo/:owner/:repo/commits', 'GET /api/repo/:owner/:repo/commit/:sha', 'POST /api/repo/:owner/:repo/revert'
];
{
  const now = new Map(locations(root).filter(entry => entry.kind === 'route').map(entry => [`${entry.method} ${entry.path}`, entry]));
  const baseline = new Map(inventory.routes.map(route => [`${route.method} ${route.path}`, route]));
  assert.equal(MOVED.length, 20);
  for (const key of MOVED) {
    const route = baseline.get(key);
    assert(route && route.owner === 'workbench', `${key} is the workbench's`);
    const entry = now.get(key);
    assert(entry, `${key} is registered`);
    assert.deepEqual(entry.guards, route.guards, `${key} keeps its chain`);
    assert(entry.at.startsWith('apps/api/src/modules/workbench/http/'), `${key} is registered by the workbench (${entry.at})`);
  }
}

function harness() {
  const calls = [];
  const state = {
    head: A, refPatch: 'ok', protectedPrefix: 'locked/', listHidden: 'secret', deleteRefusal: null, permissions: { maintain: true },
    contents: new Map(), raw: new Map(), commits: new Map(), lfsHref: 'https://lfs.example/object', archiveOk: true,
    recursive: [
      { path: 'run.sh', type: 'blob', sha: B, mode: '100755' }, { path: 'src', type: 'tree', sha: T },
      { path: 'src/a.js', type: 'blob', sha: C, mode: '100644' }, { path: 'taken.txt', type: 'blob', sha: P, mode: '100644' }
    ],
    truncated: false
  };
  const levels = {
    [T]: [{ path: 'run.sh', type: 'blob', sha: B, mode: '100755' }, { path: 'src', type: 'tree', sha: 'src-tree' }, { path: 'taken.txt', type: 'blob', sha: P }],
    'src-tree': [{ path: 'a.js', type: 'blob', sha: C, mode: '100644' }]
  };
  const refusal = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
  const gh = async (account, apiPath, options = {}) => {
    const method = options.method || 'GET';
    calls.push(['gh', method, apiPath, options.body]);
    if (options.raw) {
      const raw = state.raw.get(apiPath.split('?')[0]);
      return raw ? new Response(raw, { status: 200 }) : new Response('missing', { status: 404 });
    }
    if (method === 'GET' && apiPath === '/user/repos?sort=pushed&per_page=30&page=1&affiliation=owner,collaborator,organization_member') {
      return [{ full_name: 'acme/demo', name: 'demo', owner: { login: 'acme' }, private: true, stargazers_count: 4 }, { full_name: 'acme/secret', name: 'secret', owner: { login: 'acme' } }];
    }
    if (method === 'GET' && apiPath === '/installation/repositories?per_page=30&page=1') return { repositories: [{ full_name: 'acme/app', name: 'app', owner: { login: 'acme' } }] };
    if (apiPath === '/repos/acme/demo') {
      if (method === 'DELETE') { if (state.deleteRefusal) throw state.deleteRefusal; return {}; }
      return { id: 9, full_name: 'acme/demo', default_branch: 'main', private: true, description: 'Demo', homepage: 'https://demo.example/docs', permissions: state.permissions, archived: true };
    }
    if (apiPath === '/repos/acme/demo/branches?per_page=100') return [{ name: 'main', commit: { sha: A }, protected: true }];
    if (apiPath.startsWith('/repos/acme/demo/contents/')) {
      const key = decodeURIComponent(apiPath.slice('/repos/acme/demo/contents/'.length).split('?')[0]);
      if (!state.contents.has(key)) throw refusal(404, 'Not Found');
      return state.contents.get(key);
    }
    if (method === 'GET' && apiPath.startsWith('/repos/acme/demo/git/ref/heads/')) return { object: { sha: state.head } };
    if (method === 'GET' && /\/git\/commits\/[0-9a-f]{40}$/.test(apiPath)) return { tree: { sha: T } };
    if (method === 'GET' && apiPath === `/repos/acme/demo/git/trees/${T}?recursive=1`) return { tree: state.recursive, truncated: state.truncated };
    if (method === 'GET' && apiPath.startsWith('/repos/acme/demo/git/trees/')) return { tree: levels[apiPath.split('/').pop()] || [] };
    if (method === 'POST' && apiPath === '/repos/acme/demo/git/blobs') return { sha: 'blob-sha' };
    if (method === 'POST' && apiPath === '/repos/acme/demo/git/trees') return { sha: 'tree-sha' };
    if (method === 'POST' && apiPath === '/repos/acme/demo/git/commits') return { sha: 'commit-sha' };
    if (method === 'PATCH' && apiPath.startsWith('/repos/acme/demo/git/refs/heads/')) {
      if (state.refPatch !== 'ok') throw refusal(state.refPatch, 'not a fast forward');
      return {};
    }
    if (method === 'POST' && apiPath === '/repos/acme/demo/git/refs') return {};
    if (method === 'GET' && apiPath.startsWith('/repos/acme/demo/commits?')) return [{ sha: A, commit: { message: 'm', author: { name: 'Alice', date: 'd' } }, author: { login: 'alice', avatar_url: 'u' } }];
    if (method === 'GET' && apiPath.startsWith('/repos/acme/demo/commits/')) {
      const commit = state.commits.get(apiPath.split('/').pop());
      if (!commit) throw refusal(404, 'No commit');
      return commit;
    }
    if (method === 'GET' && apiPath.startsWith('/repos/acme/demo/compare/')) {
      return { status: 'ahead', ahead_by: 30, behind_by: 0, total_commits: 30, commits: Array.from({ length: 30 }, (_, i) => ({ sha: String(i), commit: { message: `c${i}\nbody`, author: { name: 'n' } } })), files: [] };
    }
    throw refusal(404, `unscripted ${method} ${apiPath}`);
  };
  const fetchT = async (url, init = {}) => {
    calls.push(['fetch', String(url), init.method || 'GET', init.redirect]);
    if (String(url).endsWith('/info/lfs/objects/batch')) return new Response(JSON.stringify({ objects: [{ actions: { download: { href: state.lfsHref, header: { 'X-Lfs': 'signed' } } } }] }), { status: 200 });
    return new Response('lfs bytes!!', { status: 200 });
  };
  const fail = (res, error) => {
    calls.push(['fail', error && error.code, error && error.message]);
    if (res.headersSent) { res.destroy(); return; }
    res.status(error && error.status >= 400 && error.status < 600 ? error.status : 500).json({ code: error && error.code, error: error && error.message, nextAction: error && error.nextAction, providerChanged: error && error.providerChanged });
  };
  const pass = (_req, _res, next) => next();
  const guards = {
    providerSessionAccess: (req, _res, next) => { req.gh = { login: 'alice', provider: 'github', authMethod: state.authMethod || 'oauth', token: 'tok' }; next(); },
    alphaRepositoryAccess: pass, alphaRepositoryListAccess: pass, capabilityAccess: () => pass,
    repositoryCreationAccess: pass, repositoryDeletionConfirmation: pass, auth: pass, mutationContext: () => pass
  };
  const account = req => req.gh;
  const commits = workbench.createCommitWriter(gh);
  const listRepositories = workbench.createRepositoryList({ gh, account, listAllowed: (_req, owner, name) => name !== state.listHidden });
  const assertProviderBoundLfs = () => true;
  const lfs = workbench.createLfsTransfer({ fetch: fetchT, gh, commits, assertProviderBoundLfs, assertProviderMutation: () => true, transferTimeoutMs: 60_000 });
  const app = express();
  app.use(express.json());
  workbench.registerCodeownersRoute(app, { ...guards, account, fail, gh });
  workbench.registerRepositoryRoutes(app, {
    ...guards, account, fail, gh, listRepositories,
    archiveResponse: async () => (state.archiveOk ? new Response('PKzip', { status: 200 }) : new Response('', { status: 404 }))
  });
  workbench.registerContentRoutes(app, {
    ...guards, account, fail, gh, ghRaw: (acct, apiPath, options) => gh(acct, apiPath, { ...options, raw: true }),
    commits, lfs, assertProviderBoundLfs, executionSnapshot: () => ({ operationIds: ['op-1'] })
  });
  workbench.registerHistoryRoutes(app, {
    ...guards, account, fail, gh, commits,
    protectedPathError: (_req, paths) => (paths.some(p => String(p).startsWith(state.protectedPrefix)) ? `${state.protectedPrefix} is a protected file` : '')
  });
  return { app, calls, state };
}

async function serve(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json = null;
    try { json = JSON.parse(bytes.toString('utf8')); } catch {}
    return { status: response.status, headers: response.headers, text: bytes.toString('utf8'), json };
  };
  try { await run(call); } finally { await new Promise(resolve => server.close(resolve)); }
}
const writes = calls => calls.filter(entry => entry[0] === 'gh' && entry[1] !== 'GET');
const { moves } = require('./fixtures/provider-requests');

(async () => {
  /* ---- CODEOWNERS: the first of GitHub's three places, bounded ---- */
  {
    const { app, state } = harness();
    await serve(app, async call => {
      const none = await call('GET', '/api/repo/acme/demo/codeowners');
      assert.deepEqual(none.json, { path: null, rules: [], tooLarge: false });
      assert.equal(none.headers.get('cache-control'), 'no-store');
      state.contents.set('CODEOWNERS', { type: 'file', size: 20, content: b64('* @acme/core\n') });
      state.contents.set('docs/CODEOWNERS', { type: 'file', size: 20, content: b64('* @acme/docs\n') });
      const found = await call('GET', '/api/repo/acme/demo/codeowners');
      assert.equal(found.json.path, 'CODEOWNERS', 'the second place wins over the third');
      assert.equal(JSON.stringify(found.json.rules).includes('@acme/core'), true);
      state.contents.set('.github/CODEOWNERS', { type: 'file', size: 300 * 1024, content: 'eA==' });
      const big = await call('GET', '/api/repo/acme/demo/codeowners');
      assert.deepEqual(big.json, { path: '.github/CODEOWNERS', rules: [], tooLarge: true });
    });
  }

  /* ---- The repositories a session may see, and one repository ---- */
  {
    const { app, calls, state } = harness();
    await serve(app, async call => {
      const list = await call('GET', '/api/repos');
      assert.deepEqual(list.json.map(repo => repo.full_name), ['acme/demo'], 'what the alpha filter hides is not listed');
      assert.equal(list.json[0].stars, 4);
      state.authMethod = 'github-app';
      const installation = await call('GET', '/api/repos');
      assert.deepEqual(installation.json.map(repo => repo.full_name), ['acme/app'], 'an installation lists its own repositories');
      state.authMethod = 'oauth';

      const view = await call('GET', '/api/repo/acme/demo');
      assert.equal(view.json.permission, 'maintain');
      assert.equal(view.json.archived, true);
      assert.equal(view.json.homepage, 'https://demo.example');
      assert.deepEqual(view.json.branches.map(branch => branch.name), ['main']);

      const unverified = await call('DELETE', '/api/repo/acme/demo');
      assert.equal(unverified.status, 403);
      assert(!calls.some(entry => entry[1] === 'DELETE'), 'a repository the account cannot administer is not deleted');
      state.permissions = { admin: true };
      state.deleteRefusal = Object.assign(new Error('Must have admin rights'), { status: 403, code: 'PROVIDER_FORBIDDEN' });
      const refused = await call('DELETE', '/api/repo/acme/demo');
      assert(calls.some(entry => entry[1] === 'DELETE'), 'an administrator\'s deletion reaches the provider');
      assert.equal(refused.status, 403);
      assert.equal(refused.json.providerChanged, false, 'a refused deletion changed nothing');
      assert.match(refused.json.nextAction, /Allow repository deletion/);

      const archive = await call('GET', '/api/repo/acme/demo/zip?ref=release/1.0%20beta');
      assert.equal(archive.status, 200);
      assert.equal(archive.headers.get('content-disposition'), 'attachment; filename="demo-release_1.0_beta.zip"');
      assert.equal(archive.text, 'PKzip');
      state.archiveOk = false;
      assert.deepEqual((await call('GET', '/api/repo/acme/demo/zip')).json, { error: 'Could not download archive' });

      const compared = await call('GET', '/api/repo/acme/demo/compare?base=main&head=dev');
      assert.equal(compared.json.commits.length, 20, 'only the latest twenty commits');
      assert.equal(compared.json.commits[0].message, 'c10', 'each by its first line');

      const created = await call('POST', '/api/repo/acme/demo/branches', { name: 'feature/x', from: 'main' });
      assert.deepEqual(created.json, { ok: true, name: 'feature/x', sha: A });
      assert.deepEqual(writes(calls).at(-1), ['gh', 'POST', '/repos/acme/demo/git/refs', { ref: 'refs/heads/feature/x', sha: A }]);
      const bad = await call('POST', '/api/repo/acme/demo/branches', { name: 'bad..name', from: 'main' });
      assert.equal(bad.json.code, 'INVALID_BRANCH_NAME');
    });
  }

  /* ---- Folders, files and raw bytes ---- */
  {
    const { app, calls, state } = harness();
    state.contents.set('', [{ name: 'b.txt', path: 'b.txt', type: 'file' }, { name: 'z', path: 'z', type: 'dir' }, { name: 'a.txt', path: 'a.txt', type: 'file' }, { name: 'c', path: 'c', type: 'dir' }]);
    state.contents.set('notes.txt', { name: 'notes.txt', path: 'notes.txt', sha: A, size: 5, content: b64('hello'), encoding: 'base64' });
    state.contents.set('model.bin', { name: 'model.bin', path: 'model.bin', sha: B, size: 130, content: b64(POINTER), encoding: 'base64' });
    state.contents.set('huge.log', { name: 'huge.log', path: 'huge.log', sha: C, size: 2 * 1024 * 1024 });
    state.raw.set('/repos/acme/demo/contents/page.html', '<script>alert(1)</script>');
    state.raw.set('/repos/acme/demo/contents/photo.png', 'PNGDATA');
    state.raw.set('/repos/acme/demo/contents/model.bin', POINTER);
    await serve(app, async call => {
      const listing = await call('GET', '/api/repo/acme/demo/tree?ref=main');
      assert.deepEqual(listing.json.map(item => item.name), ['c', 'z', 'a.txt', 'b.txt'], 'folders first, each group by name');
      assert.deepEqual((await call('GET', '/api/repo/acme/demo/file?path=notes.txt&ref=main')).json.content, b64('hello'));
      const pointer = await call('GET', '/api/repo/acme/demo/file?path=model.bin&ref=main');
      assert.deepEqual([pointer.json.lfs, pointer.json.oid, pointer.json.size], [true, OID, 11]);
      assert.equal((await call('GET', '/api/repo/acme/demo/file?path=huge.log&ref=main')).json.tooLarge, true);
      assert.equal((await call('GET', '/api/repo/acme/demo/file?path=../etc&ref=main')).json.code, 'INVALID_REPOSITORY_PATH');

      const page = await call('GET', '/api/repo/acme/demo/raw?path=page.html&ref=main');
      assert.equal(page.headers.get('content-type'), 'application/octet-stream');
      assert.equal(page.headers.get('content-disposition'), 'attachment; filename="page.html"', 'content a browser would run is a download');
      const photo = await call('GET', '/api/repo/acme/demo/raw?path=photo.png&ref=main');
      assert.equal(photo.headers.get('content-type'), 'image/png');
      assert.equal(photo.headers.get('content-disposition'), 'inline; filename="photo.png"');
      assert.equal(photo.text, 'PNGDATA');

      const object = await call('GET', '/api/repo/acme/demo/raw?path=model.bin&ref=main');
      assert.equal(object.text, 'lfs bytes!!', 'a pointer is answered from LFS storage');
      assert.equal(object.headers.get('content-length'), '11');
      assert.deepEqual(calls.filter(entry => entry[0] === 'fetch').map(entry => entry[3]), ['error', 'error'], 'no redirect is followed');
      state.lfsHref = 'http://lfs.example/object';
      const plain = await call('GET', '/api/repo/acme/demo/raw?path=model.bin&ref=main');
      assert.notEqual(plain.text, 'lfs bytes!!', 'storage over plain HTTP is refused');
    });
  }

  /* ---- Writes: one commit each, on the head the view was loaded at, never forced ---- */
  {
    const { app, calls, state } = harness();
    await serve(app, async call => {
      const saved = await call('PUT', '/api/repo/acme/demo/file', { path: 'run.sh', content: 'echo hi', branch: 'main', expectedHeadSha: A.toUpperCase() });
      assert.deepEqual(saved.json, { ok: true, sha: 'blob-sha', commit: 'commit-sha' });
      const tree = writes(calls).find(entry => entry[2] === '/repos/acme/demo/git/trees');
      assert.deepEqual(tree[3].tree, [{ path: 'run.sh', mode: '100755', type: 'blob', sha: 'blob-sha' }], 'an executable stays executable');
      assert.deepEqual(writes(calls).at(-1), ['gh', 'PATCH', '/repos/acme/demo/git/refs/heads/main', { sha: 'commit-sha', force: false }]);

      const before = writes(calls).length;
      const moved = await call('PUT', '/api/repo/acme/demo/file', { path: 'run.sh', content: 'x', branch: 'main', expectedHeadSha: B });
      assert.deepEqual([moved.status, moved.json.code], [409, 'BRANCH_CHANGED']);
      assert.equal(writes(calls).length, before + 1, 'only the blob was written before the head was found moved');
      state.refPatch = 422;
      assert.equal((await call('DELETE', '/api/repo/acme/demo/file', { path: 'taken.txt', branch: 'main', sha: P })).json.code, 'BRANCH_CHANGED', 'a ref the provider refuses is a moved branch');
      state.refPatch = 'ok';

      assert.equal((await call('POST', '/api/repo/acme/demo/rename', { from: 'src/a.js', to: 'taken.txt', branch: 'main' })).json.code, 'DESTINATION_EXISTS');
      assert.equal((await call('POST', '/api/repo/acme/demo/rename', { from: 'src', to: 'lib', branch: 'main' })).json.code, 'SOURCE_IS_FOLDER');
      assert.equal((await call('POST', '/api/repo/acme/demo/rename', { from: 'nope.txt', to: 'x.txt', branch: 'main' })).status, 404);
      const renamed = await call('POST', '/api/repo/acme/demo/rename', { from: 'src/a.js', to: 'lib/a.js', branch: 'main' });
      assert.deepEqual(renamed.json, { ok: true, commit: 'commit-sha' });
      const renamedTree = writes(calls).filter(entry => entry[2] === '/repos/acme/demo/git/trees').at(-1)[3].tree;
      assert.deepEqual(renamedTree, [
        { path: 'lib/a.js', mode: '100644', type: 'blob', sha: C }, { path: 'src/a.js', mode: '100644', type: 'blob', sha: null }
      ], 'the blob is linked under its new name, never uploaded again');
      assert(moves(renamedTree, 'src/a.js', 'lib/a.js'), 'the tree moves the path as the probes\' does (test/fixtures/provider-requests.js)');

      assert.equal((await call('POST', '/api/repo/acme/demo/batch', { branch: 'main', ops: [{ op: 'delete', path: 'taken.txt' }] })).json.code, 'AGGREGATE_EXPECTED_HEAD_REQUIRED');
      const batch = await call('POST', '/api/repo/acme/demo/batch', { branch: 'main', expectedHeadSha: A, ops: [{ op: 'put', path: 'new.txt', content: 'n' }, { op: 'delete', path: 'taken.txt' }] });
      assert.deepEqual([batch.json.ok, batch.json.count, batch.json.providerOperationIds], [true, 2, ['op-1']]);
      assert.equal(batch.json.itemIds.length, 2);
    });
  }

  /* ---- Commits and a revert ---- */
  {
    const { app, calls, state } = harness();
    state.commits.set(A, {
      sha: A, commit: { message: 'Add things\n\nbody' }, parents: [{ sha: P }],
      files: [{ filename: 'new.txt', status: 'added' }, { filename: 'src/a.js', status: 'modified' }, { filename: 'moved.sh', status: 'renamed', previous_filename: 'run.sh' }]
    });
    state.commits.set(P, { sha: P, commit: { tree: { sha: T } } });
    state.commits.set(B, { sha: B, commit: { message: 'Merge' }, parents: [{ sha: P }, { sha: C }], files: [] });
    state.commits.set(C, { sha: C, commit: { message: 'Lock' }, parents: [{ sha: P }], files: [{ filename: 'locked/key.pem', status: 'added' }] });
    await serve(app, async call => {
      assert.equal((await call('GET', '/api/repo/acme/demo/commits?ref=main&page=5000')).json[0].author, 'Alice');
      assert(calls.some(entry => entry[2].includes('&page=1000')), 'the page is capped at a thousand');
      const merge = await call('POST', '/api/repo/acme/demo/revert', { sha: B, branch: 'main' });
      assert.match(merge.json.error, /has 2 parents/);
      const locked = await call('POST', '/api/repo/acme/demo/revert', { sha: C, branch: 'main' });
      assert.deepEqual([locked.status, locked.json.locked], [423, true]);
      assert.equal(writes(calls).length, 0, 'nothing is written for a refused revert');
      const reverted = await call('POST', '/api/repo/acme/demo/revert', { sha: A.toUpperCase(), branch: 'main', expectedHeadSha: A });
      assert.deepEqual(reverted.json, { ok: true, commit: 'commit-sha', changed: 4 });
      const [tree, commit] = writes(calls).filter(entry => /git\/(trees|commits)$/.test(entry[2])).map(entry => entry[3]);
      assert.deepEqual(tree.tree, [
        { path: 'new.txt', mode: '100644', type: 'blob', sha: null },
        { path: 'src/a.js', mode: '100644', type: 'blob', sha: C },
        { path: 'moved.sh', mode: '100644', type: 'blob', sha: null },
        { path: 'run.sh', mode: '100755', type: 'blob', sha: B }
      ]);
      assert.equal(commit.message, `Revert "Add things" (${A.slice(0, 7)}) via Nebulaverse-X`);
    });
  }

  console.log('workbench repository routes passed');
})().catch(error => { console.error(error); process.exit(1); });
