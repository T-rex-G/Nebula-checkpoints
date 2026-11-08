'use strict';
/*
 * The workbench's collaboration, upload, folder-move and dependency-audit
 * routes, over HTTP (D12), on the module's own upload intake, native push and
 * LFS transfer, with a small scripted GitHub, Git remote, LFS store and OSV:
 * code search, pull requests and a merge, issues, notifications and global
 * search, stars, reviews, workflow runs, releases, a blob, the smart upload by
 * each transport, a folder move and an audit.
 *
 * What each must hold: the chain the route policy records; search and the
 * account-wide reads held to the repositories the session may see; a merge
 * pinned to the head the reviewer saw and refused over a protected path
 * before GitHub is asked; a GitHub App never asked to star; an upload refused
 * over its limit, scanned before anything is written and leaving no file
 * behind; a native push that sends exactly the blob, trees and commit for the
 * one file, on the head it read; LFS storage reached over HTTPS only, with
 * the pointer and its attribute committed once; a folder move that will not
 * nest, overflow or overwrite; and an audit that says when it could not ask.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');
const workbench = require('../apps/api/src/modules/workbench/index.ts');
const { githubRepositoryScopes } = require('../apps/api/src/modules/github-provider/index.ts');
const { locations } = require('./oracles/route-policy');
const { PROVIDER_REQUESTS, sent, scopedToRepository, moves } = require('./fixtures/provider-requests');
const inventory = require('../docs/architecture/mission/ROUTE_INVENTORY.json');

const root = path.resolve(__dirname, '..');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), T = 'd'.repeat(40), S = 'e'.repeat(40);
const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const sha1 = (type, bytes) => crypto.createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const pkt = text => { const bytes = Buffer.from(text); return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]); };
const LIMITS = { blobMaxBytes: 3000, uploadMaxBytes: 9000, gitPushMaxBytes: 5000, gitDataMaxBytes: 2000 };

/* ---- The chains, as the baseline inventory recorded them and the route policy reads them now ---- */
const MOVED = [
  'GET /api/repo/:owner/:repo/search', 'GET /api/repo/:owner/:repo/pulls', 'GET /api/repo/:owner/:repo/pulls/:num', 'POST /api/repo/:owner/:repo/pulls',
  'PUT /api/repo/:owner/:repo/pulls/:num/merge', 'GET /api/repo/:owner/:repo/issues', 'GET /api/repo/:owner/:repo/issues/:num',
  'POST /api/repo/:owner/:repo/issues', 'POST /api/repo/:owner/:repo/issues/:num/comments', 'PATCH /api/repo/:owner/:repo/issues/:num',
  'GET /api/notifications', 'GET /api/repo/:owner/:repo/star', 'PUT /api/repo/:owner/:repo/star', 'DELETE /api/repo/:owner/:repo/star',
  'POST /api/repo/:owner/:repo/pulls/:num/reviews', 'GET /api/repo/:owner/:repo/actions/:runId/jobs', 'POST /api/repo/:owner/:repo/actions/:runId/rerun',
  'GET /api/search', 'GET /api/repo/:owner/:repo/actions', 'GET /api/repo/:owner/:repo/releases', 'POST /api/repo/:owner/:repo/releases',
  'POST /api/repo/:owner/:repo/blob', 'POST /api/repo/:owner/:repo/upload', 'POST /api/repo/:owner/:repo/move-dir', 'GET /api/repo/:owner/:repo/audit-deps'
];
{
  const now = new Map(locations(root).filter(entry => entry.kind === 'route').map(entry => [`${entry.method} ${entry.path}`, entry]));
  const baseline = new Map(inventory.routes.map(route => [`${route.method} ${route.path}`, route]));
  assert.equal(MOVED.length, 25);
  for (const key of MOVED) {
    const route = baseline.get(key);
    assert(route && route.owner === 'workbench', `${key} is the workbench's`);
    const entry = now.get(key);
    assert(entry, `${key} is registered`);
    assert.deepEqual(entry.guards, route.guards, `${key} keeps its chain`);
    assert(entry.at.startsWith('apps/api/src/modules/workbench/http/'), `${key} is registered by the workbench (${entry.at})`);
  }
}

function refusal(status, message, extra = {}) { return Object.assign(new Error(message), { status, ...extra }); }

function harness() {
  const calls = [];
  const state = {
    authMethod: 'oauth', provider: 'github', alpha: null, protectedPaths: false, pullFiles: [], changedFiles: 3, mergeRefusal: null,
    head: A, advertHead: A, receive: 'ok', blobRefusal: null, attributes: null, lfsHref: 'https://lfs.example/store', verifyHost: 'lfs.example',
    folder: Array.from({ length: 3 }, (_, i) => ({ path: `src/f${i}.js`, type: 'blob', sha: B, mode: i === 0 ? '100755' : '100644' })),
    manifests: new Map(), osv: 'ok', dependabot: 'ok', scanBlocks: false, commits: []
  };
  const gh = async (acct, apiPath, options = {}) => {
    const method = options.method || 'GET';
    calls.push(['gh', method, apiPath, options.body, typeof acct === 'string' ? `token:${acct}` : acct && acct.login]);
    if (apiPath.startsWith('/search/code?')) {
      return { items: [{ name: 'a.js', path: 'src/a.js', repository: { full_name: 'Acme/Demo' } }, { name: 'x.js', path: 'x.js', repository: { full_name: 'other/repo' } }] };
    }
    if (/\/pulls\/\d+\/files\?per_page=100&page=/.test(apiPath)) return state.pullFiles;
    if (/\/pulls\/\d+$/.test(apiPath) && method === 'GET') return { number: 5, changed_files: state.changedFiles, head: { ref: 'feature', sha: A }, base: { ref: 'main' } };
    if (apiPath.endsWith('/merge')) { if (state.mergeRefusal) throw state.mergeRefusal; return { sha: C, message: 'Merged' }; }
    if (/\/issues\?state=/.test(apiPath)) return [{ number: 1, title: 'Bug', state: 'open', user: { login: 'a' }, labels: [{ name: 'bug', color: 'f00' }] }, { number: 2, title: 'A pull', pull_request: {} }];
    if (/\/issues$/.test(apiPath) && method === 'POST') return { number: 11 };
    if (/\/issues\/\d+$/.test(apiPath) && method === 'PATCH') return {};
    if (/\/issues\/\d+\/comments$/.test(apiPath) && method === 'POST') return { id: 31 };
    if (/\/pulls$/.test(apiPath) && method === 'POST') return { number: 6 };
    if (/notifications\?per_page=30$/.test(apiPath)) return [{ id: '1', reason: 'mention', unread: true, subject: { title: 'Ping', type: 'Issue' }, repository: { full_name: apiPath.split('/')[2] + '/' + apiPath.split('/')[3] } }];
    if (apiPath.startsWith('/user/starred/')) { if (method === 'GET') throw refusal(404, 'Not Found'); return {}; }
    if (/\/releases$/.test(apiPath) && method === 'POST') return { id: 9, tag_name: options.body.tag_name };
    if (/\/actions\/runs\/\d+\/rerun$/.test(apiPath)) return {};
    if (apiPath.endsWith('/git/blobs')) { if (state.blobRefusal) throw state.blobRefusal; return { sha: sha1('blob', Buffer.from(options.body.content, 'base64')) }; }
    if (apiPath.includes('/git/ref/heads/')) return { object: { sha: state.head } };
    if (apiPath.includes('/git/trees/') && apiPath.endsWith('?recursive=1')) {
      return { tree: [...state.folder, { path: 'src', type: 'tree', sha: T }, { path: 'srcx/kept.js', type: 'blob', sha: C, mode: '100644' }, { path: 'lib/taken.js', type: 'blob', sha: C, mode: '100644' }, { path: 'locked/key.pem', type: 'blob', sha: C, mode: '100644' }], truncated: false };
    }
    if (apiPath.includes('/git/commits/')) return { tree: { sha: T } };
    if (apiPath.endsWith(`/git/trees/${T}`)) return { tree: [{ path: 'README.md', type: 'blob', sha: B, mode: '100644' }, { path: 'run.sh', type: 'blob', sha: C, mode: '100755' }, { path: 'src', type: 'tree', sha: S, mode: '040000' }, { path: 'link', type: 'blob', sha: C, mode: '120000' }] };
    if (apiPath.endsWith(`/git/trees/${S}`)) return { tree: [{ path: 'a.js', type: 'blob', sha: B, mode: '100644' }, { path: 'tool', type: 'blob', sha: C, mode: '100755' }] };
    if (apiPath.includes('/contents/.gitattributes')) { if (state.attributes === null) throw refusal(404, 'Not Found'); return { content: b64(state.attributes) }; }
    if (apiPath.includes('/contents/')) {
      const name = decodeURIComponent(apiPath.split('/contents/').pop().split('?')[0]);
      if (!state.manifests.has(name)) throw refusal(404, 'Not Found');
      return { content: b64(state.manifests.get(name)) };
    }
    if (apiPath.includes('/dependabot/alerts')) {
      if (state.dependabot === 'refused') throw refusal(403, 'Resource not accessible');
      return [{ security_advisory: { severity: 'high', summary: 'Prototype pollution' }, dependency: { package: { name: 'lodash' } } }];
    }
    throw refusal(404, `unscripted ${method} ${apiPath}`);
  };
  const consume = async body => {
    if (!body || typeof body.pipe !== 'function') return body;
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const fetchT = async (url, init = {}) => {
    const target = String(url);
    const body = await consume(init.body);
    calls.push(['fetch', init.method || 'GET', target, init.headers, body, init.redirect]);
    if (target.endsWith('/info/refs?service=git-receive-pack')) {
      return new Response(Buffer.concat([pkt('# service=git-receive-pack\n'), Buffer.from('0000'), pkt(`${state.advertHead} refs/heads/main\0report-status\n`), Buffer.from('0000')]), { status: 200 });
    }
    if (target.endsWith('/git-receive-pack')) {
      if (state.receive === 'rejected') return new Response(Buffer.concat([pkt('unpack ok\n'), pkt('ng refs/heads/main non-fast-forward\n'), Buffer.from('0000')]), { status: 200 });
      if (state.receive === 'down') return new Response('', { status: 503 });
      return new Response(Buffer.concat([pkt('unpack ok\n'), pkt('ok refs/heads/main\n'), Buffer.from('0000')]), { status: 200 });
    }
    if (target.endsWith('/info/lfs/objects/batch')) {
      return new Response(JSON.stringify({ objects: [{ actions: { upload: { href: state.lfsHref, header: { Authorization: 'RemoteAuth up' } }, verify: { href: `https://${state.verifyHost}/verify` } } }] }), { status: 200 });
    }
    if (target === state.lfsHref) return new Response('', { status: 200 });
    if (target.endsWith('/verify')) return new Response('{}', { status: 200 });
    if (target === 'https://api.osv.dev/v1/querybatch') {
      if (state.osv === 'down') return new Response('busy', { status: 503 });
      const queries = JSON.parse(body).queries;
      return new Response(JSON.stringify({ results: queries.map(q => (q.package.name === 'lodash' ? { vulns: Array.from({ length: 10 }, (_, i) => ({ id: `GHSA-lodash-${i}` })) } : {})) }), { status: 200 });
    }
    if (target.startsWith('https://api.osv.dev/v1/vulns/')) return new Response(JSON.stringify({ summary: 'A flaw', severity: [{ score: '7.5' }], aliases: ['CVE-1', 'CVE-2', 'CVE-3', 'CVE-4'] }), { status: 200 });
    return new Response('unscripted', { status: 599 });
  };
  const fail = (res, error) => {
    calls.push(['fail', error && error.code, error && error.message]);
    if (res.headersSent) { res.destroy(); return; }
    res.status(error && error.status >= 400 && error.status < 600 ? error.status : 500).json({ code: error && error.code, error: error && error.message });
  };
  const pass = (_req, _res, next) => next();
  const guards = {
    providerSessionAccess: (req, _res, next) => {
      req.gh = { login: 'alice', provider: state.provider, authMethod: state.authMethod, token: 'tok' };
      if (state.alpha) req.alpha = { repositoryScopes: state.alpha };
      next();
    },
    alphaRepositoryAccess: pass, capabilityAccess: () => pass, capabilityAccessWhen: () => pass, githubSearchAccess: pass, auth: pass, mutationContext: () => pass
  };
  const account = req => req.gh;
  const commits = {
    commitTree: async (acct, owner, repo, branch, message, entries, expectedHeadSha, options) => {
      state.commits.push({ acct: typeof acct === 'string' ? `token:${acct}` : acct.login, owner, repo, branch, message, entries, expectedHeadSha, options });
      return { sha: 'commit-sha' };
    }
  };
  const gatewayChecks = [];
  const assertProviderMutation = target => { gatewayChecks.push(target.transport); return true; };
  const lfs = workbench.createLfsTransfer({ fetch: fetchT, gh, commits, assertProviderBoundLfs: () => true, assertProviderMutation, transferTimeoutMs: 60_000 });
  const nativePush = workbench.createNativePush({
    gh, fetch: fetchT, assertProviderMutation,
    assertGithubAccount: acct => { if (acct.provider !== 'github') throw refusal(401, 'Only GitHub accounts are supported. Sign in with GitHub.', { code: 'PROVIDER_UNSUPPORTED' }); },
    maxBytes: LIMITS.gitPushMaxBytes, maxMegabytes: 64
  });
  const scans = [];
  const app = express();
  app.use(express.json());
  const enforceProtectedPaths = (_req, paths) => {
    calls.push(['protect', paths]);
    if (paths.some(p => String(p).startsWith('locked/'))) throw refusal(423, 'locked/ is protected', { code: 'PROTECTED_PATH' });
  };
  workbench.registerCollaborationRoutes(app, {
    ...guards, account, fail, gh,
    alphaRepositories: req => (state.alpha ? githubRepositoryScopes(req.alpha.repositoryScopes) : null),
    protectedPatternsForReq: () => (state.protectedPaths ? ['locked/**'] : []), enforceProtectedPaths
  });
  workbench.registerUploadRoutes(app, {
    ...guards, account, fail, gh, commits, nativePush, lfs, limits: LIMITS, enforceProtectedPaths,
    intake: workbench.createUploadIntake({ concurrency: 1, timeoutMs: 60_000 }),
    scanUpload: async (_req, tmp, repoPath, size) => {
      scans.push({ tmp, repoPath, size, mode: fs.statSync(tmp).mode & 0o777 });
      if (state.scanBlocks) throw refusal(422, 'Upload blocked by malware signature rule: EICAR', { code: 'MALWARE_DETECTED' });
      return { builtin: { available: true, matches: 0 } };
    }
  });
  workbench.registerFolderMoveRoute(app, { ...guards, account, fail, gh, commits, enforceProtectedPaths });
  workbench.registerDependencyAuditRoute(app, { ...guards, account, fail, gh, fetch: fetchT });
  return { app, calls, state, scans, gatewayChecks };
}

async function serve(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, raw) => {
    const response = await fetch(`${base}${route}`, raw
      ? { method, headers: { 'content-type': 'application/octet-stream' }, body: raw }
      : { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, text, json };
  };
  try { await run(call); } finally { await new Promise(resolve => server.close(resolve)); }
}
const gone = file => new Promise(resolve => {
  let tries = 0;
  const check = () => (!fs.existsSync(file) || ++tries > 50 ? resolve(!fs.existsSync(file)) : setTimeout(check, 10));
  check();
});

/* The objects of a pack version 2, each inflated: what a push sent, read the way Git reads it. */
function unpack(pack) {
  assert.equal(pack.subarray(0, 4).toString(), 'PACK');
  assert.equal(pack.readUInt32BE(4), 2);
  const count = pack.readUInt32BE(8);
  assert.equal(crypto.createHash('sha1').update(pack.subarray(0, -20)).digest('hex'), pack.subarray(-20).toString('hex'), 'the pack closes with its own checksum');
  const types = { 1: 'commit', 2: 'tree', 3: 'blob' };
  const objects = [];
  let at = 12;
  for (let n = 0; n < count; n++) {
    let byte = pack[at++];
    const type = types[(byte >> 4) & 7];
    while (byte & 0x80) byte = pack[at++];
    const { buffer, engine } = zlib.inflateSync(pack.subarray(at), { info: true });
    at += engine.bytesWritten;
    objects.push({ type, bytes: buffer, sha: sha1(type, buffer) });
  }
  return objects;
}
function treeEntries(bytes) {
  const entries = [];
  let at = 0;
  while (at < bytes.length) {
    const nul = bytes.indexOf(0, at);
    const [mode, name] = bytes.subarray(at, nul).toString().split(' ');
    entries.push({ mode, name, sha: bytes.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return entries;
}

(async () => {
  /* ---- Search, pull requests and a merge ---- */
  {
    const { app, calls, state } = harness();
    await serve(app, async call => {
      const found = await call('GET', '/api/repo/Acme/Demo/search?q=needle');
      assert.deepEqual(found.json, [{ name: 'a.js', path: 'src/a.js' }], 'a result from another repository is not shown');
      assert.equal((await call('GET', '/api/repo/Acme/Demo/search?q=needle%20repo:other/repo')).status, 400, 'a query may not name another repository');

      const merged = await call('PUT', '/api/repo/acme/demo/pulls/5/merge', { method: 'squash', expectedHeadSha: ` ${A.toUpperCase()} ` });
      assert.deepEqual(merged.json, { ok: true, sha: C, message: 'Merged' });
      assert.deepEqual(calls.find(entry => entry[0] === 'gh' && entry[2].endsWith('/merge'))[3], { merge_method: 'squash', sha: A }, 'the merge is pinned to the reviewed head');
      assert.equal((await call('PUT', '/api/repo/acme/demo/pulls/5/merge', { expectedHeadSha: 'short' })).json.code, 'INVALID_EXPECTED_HEAD');
      state.mergeRefusal = refusal(409, 'Head branch was modified');
      assert.equal((await call('PUT', '/api/repo/acme/demo/pulls/5/merge', { expectedHeadSha: A })).json.code, 'PULL_HEAD_CHANGED');
      state.mergeRefusal = null;

      state.protectedPaths = true;
      state.pullFiles = [{ filename: 'docs/readme.md', previous_filename: 'locked/key.pem' }];
      calls.length = 0;
      const locked = await call('PUT', '/api/repo/acme/demo/pulls/5/merge', { expectedHeadSha: A });
      assert.deepEqual([locked.status, locked.json.code], [423, 'PROTECTED_PATH'], "a renamed file's old path is a path the merge changes");
      assert(!calls.some(entry => entry[0] === 'gh' && entry[2].endsWith('/merge')), 'GitHub is not asked to merge over a protected path');
      state.changedFiles = 1001;
      assert.equal((await call('PUT', '/api/repo/acme/demo/pulls/5/merge', { expectedHeadSha: A })).json.code, 'PROTECTED_PATH_SCAN_INCOMPLETE');

      assert.equal((await call('POST', '/api/repo/acme/demo/pulls/abc/reviews', { event: 'APPROVE' })).json.code, 'PULL_NUMBER_INVALID');
      assert.equal((await call('POST', '/api/repo/acme/demo/actions/x1/rerun')).json.code, 'WORKFLOW_RUN_INVALID');
      assert.deepEqual((await call('POST', '/api/repo/acme/demo/actions/123/rerun')).json, { ok: true });
    });
  }

  /* ---- Issues, releases and stars ---- */
  {
    const { app, calls, state } = harness();
    await serve(app, async call => {
      const issues = await call('GET', '/api/repo/acme/demo/issues?state=bogus');
      assert.deepEqual(issues.json.map(issue => issue.number), [1], 'a pull request is not listed as an issue');
      assert(calls.some(entry => entry[0] === 'gh' && entry[2].includes('/issues?state=open&')), 'an unknown state reads the open ones');
      assert.equal((await call('POST', '/api/repo/acme/demo/issues', { body: 'no title' })).status, 400);
      assert.deepEqual((await call('PATCH', '/api/repo/acme/demo/issues/1', { state: 'anything' })).json, { ok: true, state: 'open' });
      const release = await call('POST', '/api/repo/acme/demo/releases', { tag: 'v2', prerelease: 'yes' });
      assert.deepEqual(release.json, { ok: true, id: 9, tag: 'v2' });
      assert.deepEqual(calls.find(entry => entry[0] === 'gh' && entry[2].endsWith('/releases'))[3], { tag_name: 'v2', name: 'v2', body: '', target_commitish: undefined, prerelease: true });

      assert.deepEqual((await call('GET', '/api/repo/acme/demo/star')).json, { starred: false }, 'a 404 is not starred');
      state.authMethod = 'github-app';
      calls.length = 0;
      assert.deepEqual((await call('GET', '/api/repo/acme/demo/star')).json, { starred: false, unsupported: true });
      assert.equal((await call('PUT', '/api/repo/acme/demo/star')).json.code, 'GITHUB_APP_CAPABILITY_UNAVAILABLE');
      assert.equal((await call('DELETE', '/api/repo/acme/demo/star')).status, 403);
      assert.equal(calls.filter(entry => entry[0] === 'gh').length, 0, 'an installation is never asked to star');
    });
  }

  /*
   * ---- The requests a capability is made of, as the product sends them ----
   * Each capability's routes send GitHub the requests in the shared table
   * (test/fixtures/provider-requests.js) that the qualification's probes are
   * held to as well (test/capability-probes.test.js), so a claim earned by a
   * probe is a claim about what the product sends.
   */
  {
    const { app, calls } = harness();
    await serve(app, async call => {
      for (const [method, route, body] of [
        ['POST', '/api/repo/acme/demo/issues', { title: 'Bug', body: 'Steps to see it' }],
        ['POST', '/api/repo/acme/demo/issues/1/comments', { body: 'Seen' }],
        ['PATCH', '/api/repo/acme/demo/issues/1', { state: 'closed' }],
        ['POST', '/api/repo/acme/demo/pulls', { title: 'Feature', head: 'feature', base: 'main', body: 'Adds it' }],
        ['PUT', '/api/repo/acme/demo/pulls/5/merge', { method: 'merge', expectedHeadSha: A }],
        ['POST', '/api/repo/acme/demo/releases', { tag: 'v3', name: 'Three', body: 'Notes', target: 'main', prerelease: true }],
        ['PUT', '/api/repo/acme/demo/star'],
        ['POST', '/api/repo/acme/demo/actions/123/rerun']
      ]) {
        const answered = await call(method, route, body);
        assert.equal(answered.status, 200, `${method} ${route}: ${JSON.stringify(answered.json)}`);
      }
      const requests = calls.filter(entry => entry[0] === 'gh').map(([, method, path, body]) => ({ method, path, body }));
      for (const expectation of PROVIDER_REQUESTS) {
        assert(sent(expectation, requests), `the product sends ${expectation.capability} as the probes do: ${JSON.stringify(requests.filter(request => request.method === expectation.method))}`);
      }
      calls.length = 0;
      await call('GET', '/api/repo/Acme/Demo/search?q=needle');
      const query = new URLSearchParams(calls.find(entry => entry[0] === 'gh' && entry[2].startsWith('/search/code?'))[2].split('?')[1]).get('q');
      assert(scopedToRepository(query, 'Acme/Demo'), `a code search is held to its repository by GitHub's qualifier: ${query}`);
    });
  }

  /* ---- Notifications and global search, held to the invitation ---- */
  {
    const { app, calls, state } = harness();
    await serve(app, async call => {
      state.alpha = ['github:github.com/acme/demo'];
      const notifications = await call('GET', '/api/notifications');
      assert.equal(notifications.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(calls.filter(entry => entry[0] === 'gh').map(entry => entry[2]), ['/repos/acme/demo/notifications?per_page=30'],
        'an invited session reads only the repositories it was invited to');
      calls.length = 0;
      await call('GET', '/api/search?q=needle');
      assert(calls.filter(entry => entry[0] === 'gh').every(entry => decodeURIComponent(entry[2]).includes('repo:acme/demo')), 'global search is held to the invitation');
      state.alpha = 'not a list';
      assert.equal((await call('GET', '/api/notifications')).json.code, 'ALPHA_REPOSITORY_NOT_ALLOWED');
    });
  }

  /* ---- A blob, and the upload's limits, scan and temporary file ---- */
  {
    const { app, calls, state, scans } = harness();
    await serve(app, async call => {
      const blob = await call('POST', '/api/repo/acme/demo/blob?path=src/a.bin', undefined, Buffer.alloc(100, 'x'));
      assert.deepEqual([blob.json.ok, blob.json.size, blob.json.sha], [true, 100, sha1('blob', Buffer.alloc(100, 'x'))]);
      assert.equal(scans[0].mode, 0o600, 'an upload is written for this process alone');
      assert.equal(path.dirname(scans[0].tmp), os.tmpdir());
      assert(await gone(scans[0].tmp), 'the blob leaves no file behind');
      assert.equal((await call('POST', '/api/repo/acme/demo/blob', undefined, Buffer.alloc(LIMITS.blobMaxBytes + 1, 'x'))).status, 413);
      state.blobRefusal = refusal(422, 'Blob is too large');
      assert.match((await call('POST', '/api/repo/acme/demo/blob', undefined, Buffer.alloc(10, 'x'))).json.error, /pushed individually via Git LFS/);
      state.blobRefusal = null;

      state.scanBlocks = true;
      calls.length = 0;
      const blocked = await call('POST', '/api/repo/acme/demo/upload?path=a.bin&branch=main', undefined, Buffer.alloc(10, 'v'));
      assert.deepEqual([blocked.status, blocked.json.code], [422, 'MALWARE_DETECTED']);
      assert.equal(calls.filter(entry => entry[0] !== 'fail').length, 0, 'nothing is written for a blocked upload');
      assert(await gone(scans.at(-1).tmp));
      state.scanBlocks = false;
      assert.equal((await call('POST', '/api/repo/acme/demo/upload?path=a.bin&branch=main', undefined, Buffer.alloc(LIMITS.uploadMaxBytes + 1, 'x'))).status, 413);
      assert.equal((await call('POST', '/api/repo/acme/demo/upload?branch=main', undefined, Buffer.alloc(1, 'x'))).json.error, 'path and branch required');
      assert.equal((await call('POST', '/api/repo/acme/demo/upload?path=../x&branch=main', undefined, Buffer.alloc(1, 'x'))).json.code, 'INVALID_REPOSITORY_PATH');
    });
  }

  /* ---- A small file by the Git Data API ---- */
  {
    const { app, state, scans } = harness();
    await serve(app, async call => {
      const small = await call('POST', `/api/repo/acme/demo/upload?path=/src//note.txt&branch=main&expectedHeadSha=${A}`, undefined, Buffer.from('hello'));
      assert.equal(small.json.strategy, 'git-data-api');
      assert.deepEqual(small.json.transport, { requested: 'auto', fallback: null });
      assert.equal(scans[0].repoPath, 'src/note.txt', 'the scan sees the path that will be written');
      assert.deepEqual(state.commits[0].entries, [{ path: 'src/note.txt', mode: '100644', type: 'blob', sha: sha1('blob', Buffer.from('hello')) }]);
      assert.equal(state.commits[0].expectedHeadSha, A);
    });
  }

  /* ---- A file by native Git push: exactly its blob, trees and commit, on the head it read ---- */
  {
    const { app, calls, state, gatewayChecks } = harness();
    await serve(app, async call => {
      const bytes = crypto.randomBytes(3000);
      const pushed = await call('POST', `/api/repo/acme/demo/upload?path=src/new.bin&branch=main&lfs=git&expectedHeadSha=${A}`, undefined, bytes);
      assert.equal(pushed.json.strategy, 'git-push');
      assert.deepEqual(gatewayChecks, ['git-receive-pack']);
      const [advert, receive] = calls.filter(entry => entry[0] === 'fetch');
      assert.equal(advert[2], 'https://github.com/acme/demo.git/info/refs?service=git-receive-pack');
      assert.equal(advert[3].Authorization, `Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
      assert.equal(receive[5], 'error', 'a push follows no redirect');
      const body = receive[4];
      const length = parseInt(body.subarray(0, 4).toString(), 16);
      const command = body.subarray(4, length).toString();
      assert.equal(command, `${A} ${pushed.json.commit} refs/heads/main\0report-status agent=nebulaverse/4.6.0`);
      assert.equal(body.subarray(length, length + 4).toString(), '0000');
      const objects = unpack(body.subarray(length + 4));
      assert.deepEqual(objects.map(object => object.type), ['blob', 'tree', 'tree', 'commit']);
      const [blob, src, top, commit] = objects;
      assert(blob.bytes.equals(bytes), 'the blob is the uploaded file');
      assert.deepEqual(treeEntries(src.bytes), [
        { mode: '100644', name: 'a.js', sha: B }, { mode: '100644', name: 'new.bin', sha: blob.sha }, { mode: '100755', name: 'tool', sha: C }
      ]);
      assert.deepEqual(treeEntries(top.bytes), [
        { mode: '100644', name: 'README.md', sha: B }, { mode: '120000', name: 'link', sha: C }, { mode: '100755', name: 'run.sh', sha: C }, { mode: '40000', name: 'src', sha: src.sha }
      ], "the file's neighbours and their modes are kept");
      assert.equal(commit.sha, pushed.json.commit);
      assert.match(commit.bytes.toString(), new RegExp(`^tree ${top.sha}\\nparent ${A}\\nauthor alice <alice@users\\.noreply\\.github\\.com> \\d+ \\+0000\\n`));

      state.advertHead = B;
      calls.length = 0;
      const moved = await call('POST', `/api/repo/acme/demo/upload?path=src/new.bin&branch=main&lfs=git&expectedHeadSha=${A}`, undefined, bytes);
      assert.deepEqual([moved.status, moved.json.code], [409, 'BRANCH_CHANGED']);
      assert(!calls.some(entry => entry[0] === 'fetch' && entry[2].endsWith('/git-receive-pack')), 'nothing is pushed onto a head that moved');
      state.advertHead = A;
      /* A push that fails for any other reason ladders to the Git Data API, and says so. */
      const warnings = [];
      const consoleError = console.error;
      console.error = line => warnings.push(JSON.parse(line));
      try {
        const link = await call('POST', '/api/repo/acme/demo/upload?path=link&branch=main&lfs=git', undefined, bytes);
        assert.equal(link.json.strategy, 'git-data-blob', 'a symlink is not overwritten by a push; the Git Data API takes the file instead');
        state.receive = 'rejected';
        const rejected = await call('POST', '/api/repo/acme/demo/upload?path=src/new.bin&branch=main&lfs=git', undefined, bytes);
        assert.equal(rejected.json.strategy, 'git-data-blob', 'a refused push is carried by the Git Data API instead');
      } finally { console.error = consoleError; }
      assert.deepEqual(warnings.map(warning => [warning.warn, warning.err]), [
        ['native push failed, laddering', 'Refusing to overwrite a symlink or submodule entry — remove it first'],
        ['native push failed, laddering', 'git push rejected: non-fast-forward']
      ]);
    });
  }

  /* ---- A large file by Git LFS: storage over HTTPS, the pointer and its attribute committed once ---- */
  {
    const { app, calls, state, gatewayChecks } = harness();
    await serve(app, async call => {
      const bytes = crypto.randomBytes(6000);
      const oid = crypto.createHash('sha256').update(bytes).digest('hex');
      const stored = await call('POST', '/api/repo/acme/demo/upload?path=big/clip.mp4&branch=main', undefined, bytes);
      assert.deepEqual([stored.json.strategy, stored.json.oid], ['lfs', oid]);
      assert.deepEqual(gatewayChecks, ['git-lfs.batch', 'git-lfs.upload', 'git-lfs.verify']);
      const [batch, put, verify] = calls.filter(entry => entry[0] === 'fetch');
      assert.equal(batch[3].Authorization, `Basic ${Buffer.from('alice:tok').toString('base64')}`);
      assert.deepEqual(JSON.parse(batch[4]), { operation: 'upload', transfers: ['basic'], ref: { name: 'refs/heads/main' }, objects: [{ oid, size: 6000 }] });
      assert(put[4].equals(bytes), 'storage receives the file itself');
      assert.deepEqual([put[3]['Content-Length'], put[3].Authorization, put[5]], ['6000', 'RemoteAuth up', 'error']);
      assert.equal(verify[3].Authorization, undefined, "storage's own host is not sent the account's credentials");
      const [commit] = state.commits;
      assert.equal(commit.acct, 'token:tok');
      assert.deepEqual(commit.entries.map(entry => entry.path), ['big/clip.mp4', '.gitattributes']);
      assert.equal(commit.entries[0].content, `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 6000\n`);
      assert.equal(commit.entries[1].content, '/big/clip.mp4 filter=lfs diff=lfs merge=lfs -text\n');

      state.attributes = '*.psd filter=lfs\n/big/clip.mp4 filter=lfs diff=lfs merge=lfs -text';
      state.verifyHost = 'github.com';
      calls.length = 0;
      await call('POST', '/api/repo/acme/demo/upload?path=big/clip.mp4&branch=main', undefined, bytes);
      assert.deepEqual(state.commits[1].entries.map(entry => entry.path), ['big/clip.mp4'], 'an attribute already there is not written again');
      assert.equal(calls.filter(entry => entry[0] === 'fetch').at(-1)[3].Authorization, `Basic ${Buffer.from('alice:tok').toString('base64')}`, "GitHub's own verification is sent the account's credentials");
      state.lfsHref = 'http://lfs.example/store';
      assert.equal((await call('POST', '/api/repo/acme/demo/upload?path=big/clip.mp4&branch=main', undefined, bytes)).status, 502, 'storage over plain HTTP is refused');
      state.lfsHref = 'https://lfs.example/store';
      assert.equal((await call('POST', '/api/repo/acme/demo/upload?path=locked/clip.mp4&branch=main', undefined, bytes)).json.code, 'PROTECTED_PATH');
      state.provider = 'gitea';
      assert.match((await call('POST', '/api/repo/acme/demo/upload?path=big/clip.mp4&branch=main&lfs=lfs', undefined, bytes)).json.error, /require Git LFS/, 'no LFS, and over the Git ceiling: refused by the plan');
    });
  }

  /* ---- A folder move ---- */
  {
    const { app, state } = harness();
    await serve(app, async call => {
      assert.equal((await call('POST', '/api/repo/acme/demo/move-dir', { from: 'src', to: 'lib', branch: 'main' })).json.code, 'AGGREGATE_EXPECTED_HEAD_REQUIRED');
      const moved = await call('POST', '/api/repo/acme/demo/move-dir', { from: 'src', to: 'lib', branch: 'main', expectedHeadSha: A });
      assert.deepEqual(moved.json, { ok: true, commit: { sha: 'commit-sha' }, moved: 3 });
      const [commit] = state.commits;
      assert.deepEqual(commit.options, { mustNotExist: ['lib/f0.js', 'lib/f1.js', 'lib/f2.js'] }, 'a move never overwrites a file');
      assert.equal(commit.expectedHeadSha, A);
      assert.deepEqual(commit.entries.slice(0, 2), [
        { path: 'lib/f0.js', mode: '100755', type: 'blob', sha: B, forceMode: true }, { path: 'src/f0.js', mode: '100755', type: 'blob', sha: null, forceMode: true }
      ]);
      for (const file of ['f0.js', 'f1.js', 'f2.js']) assert(moves(commit.entries, `src/${file}`, `lib/${file}`), `the move takes src/${file} to lib/${file} as the probes do`);
      assert.match((await call('POST', '/api/repo/acme/demo/move-dir', { from: 'src', to: 'src/inner', branch: 'main', expectedHeadSha: A })).json.error, /inside itself/);
      assert.equal((await call('POST', '/api/repo/acme/demo/move-dir', { from: 'src', to: 'locked', branch: 'main', expectedHeadSha: A })).json.code, 'PROTECTED_PATH');
      state.folder = Array.from({ length: 801 }, (_, i) => ({ path: `src/f${i}.js`, type: 'blob', sha: B, mode: '100644' }));
      assert.equal((await call('POST', '/api/repo/acme/demo/move-dir', { from: 'src', to: 'lib', branch: 'main', expectedHeadSha: A })).status, 413);
      state.head = C;
      state.folder = state.folder.slice(0, 2);
      assert.equal((await call('POST', '/api/repo/acme/demo/move-dir', { from: 'src', to: 'lib', branch: 'main', expectedHeadSha: A })).json.code, 'BRANCH_CHANGED');
    });
  }

  /* ---- The dependency audit ---- */
  {
    const { app, calls, state } = harness();
    await serve(app, async call => {
      state.manifests.set('package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/a/node_modules/b': { version: '^1.0.0' } } }));
      state.manifests.set('requirements.txt', 'django==4.2.1\n');
      const audit = await call('GET', '/api/repo/acme/demo/audit-deps?ref=main');
      assert.deepEqual(audit.json.sources, [{ file: 'package-lock.json', packages: 2, approximate: false }], 'a lockfile ends the search');
      assert.equal(calls.filter(entry => entry[0] === 'gh' && entry[2].includes('/contents/')).length, 1);
      assert.deepEqual(audit.json.vulnerable, [{ name: 'lodash', version: '4.17.20', ecosystem: 'npm', ids: Array.from({ length: 8 }, (_, i) => `GHSA-lodash-${i}`) }]);
      assert.deepEqual(audit.json.details['GHSA-lodash-0'], { summary: 'A flaw', severity: '7.5', aliases: ['CVE-1', 'CVE-2', 'CVE-3'] });
      assert.deepEqual([audit.json.complete, audit.json.osv.available, audit.json.dependabot.alerts[0].package], [true, true, 'lodash']);

      state.manifests = new Map([['package.json', JSON.stringify({ dependencies: { lodash: '^4.17.20' }, devDependencies: { lodash: '4.17.20' } })]]);
      state.osv = 'down';
      state.dependabot = 'refused';
      const offline = await call('GET', '/api/repo/acme/demo/audit-deps');
      assert.deepEqual([offline.json.scanned, offline.json.approximate], [1, true], 'a package listed twice is checked once, and ranges are approximate');
      assert.deepEqual([offline.json.complete, offline.json.osv.error], [false, 'OSV service returned HTTP 503'], 'an audit nobody could answer is not called clean');
      assert.equal(offline.json.dependabot.available, false);
      state.provider = 'gitea';
      calls.length = 0;
      await call('GET', '/api/repo/acme/demo/audit-deps');
      assert(!calls.some(entry => entry[0] === 'gh' && entry[2].includes('dependabot')), 'Dependabot is asked of GitHub only');
    });
  }

  console.log('workbench collaboration routes passed');
})().catch(error => { console.error(error); process.exit(1); });
