'use strict';

/*
 * The capability probes, falsified one condition at a time.
 *
 * Every probe here was written in the same change as the fixture it runs
 * against, which is the arrangement that has manufactured confidence before.
 * So each condition is broken on purpose, against a fixture that is otherwise
 * correct, and the run has to fail naming that condition. A perturbation that
 * leaves the run green means the condition is decorative.
 */

const assert = require('assert');
const crypto = require('crypto');
const { createProviderFetchFixture } = require('../ci/alpha17-fixtures');
const { runGithubValidation } = require('../ci/run-github-alpha17-validation');

const RUN_ID = 'run-4096';
const NOW = '2026-09-26T12:00:00.000Z';

function environment() {
  const repository = 'fixture-owner/nvx-alpha17-github-qualification';
  const env = {
    NV_PUBLIC_ALPHA_SUBJECT_SHA256: 'a'.repeat(64),
    NV_PUBLIC_ALPHA_SOURCE_COMMIT: 'b'.repeat(40),
    NV_ALPHA17_WORKFLOW_RUN_ID: RUN_ID,
    NV_ALPHA17_REPOSITORY: repository,
    NV_ALPHA17_BRANCH: `nvx-alpha17-${RUN_ID}-proof`,
    NV_ALPHA17_MUTATION_CREDENTIAL: 'fixture-mutation-credential',
    NV_ALPHA17_READ_ONLY_CREDENTIAL: 'fixture-readonly-credential',
    NV_ALPHA17_GITHUB_API_URL: 'https://github.fixture.invalid',
    NV_ALPHA17_GITHUB_LFS_URL: 'https://github-lfs.fixture.invalid',
    /* Only so a run that never finishes is falsified in seconds, not minutes. */
    NV_ALPHA17_RUN_OBSERVATION_ATTEMPTS: '3'
  };
  env.NV_ALPHA17_SIGNED_TARGET_SHA256 = crypto.createHash('sha256').update(JSON.stringify({
    apiUrl: env.NV_ALPHA17_GITHUB_API_URL,
    jobName: 'github',
    repository
  })).digest('hex');
  return env;
}

function fixtureFor(env) {
  return createProviderFetchFixture({
    provider: 'github',
    repository: env.NV_ALPHA17_REPOSITORY,
    defaultBranch: 'main',
    runId: RUN_ID,
    mutationCredential: env.NV_ALPHA17_MUTATION_CREDENTIAL,
    readOnlyCredential: env.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
}

function reply(status, body) {
  if (status === 204) return new Response(null, { status });
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }
  });
}

/*
 * A request as the middleware sees it: enough to recognise one call among the
 * hundred a run makes, and a way to pass it through or answer it instead.
 */
function describe(url, init) {
  const parsed = new URL(url);
  const headers = new Headers(init.headers || {});
  return {
    pathname: decodeURIComponent(parsed.pathname),
    search: parsed.searchParams,
    method: String(init.method || 'GET').toUpperCase(),
    reader: (headers.get('user-agent') || '').includes('Exposure-Reader'),
    authorization: headers.get('authorization') || '',
    body: (() => {
      /* Most bodies are JSON; the LFS object upload is the raw bytes. */
      if (!init.body || Buffer.isBuffer(init.body)) return null;
      try { return JSON.parse(String(init.body)); } catch { return null; }
    })()
  };
}

async function run(middleware, prepare) {
  const env = environment();
  const fixture = fixtureFor(env);
  if (prepare) prepare(fixture);
  const context = { fixture, env, memo: {} };
  const fetchImpl = async (url, init = {}) => {
    const request = describe(url, init);
    const answered = await middleware(request, () => fixture.fetch(url, init), context, url, init);
    return answered || fixture.fetch(url, init);
  };
  const result = await runGithubValidation({ env, fetchImpl, now: () => new Date(NOW) });
  return { result, fixture };
}

async function expectUnmet(label, probe, condition, middleware, prepare) {
  await assert.rejects(
    () => run(middleware, prepare),
    error => {
      const named = Boolean(error) && error.code === 'ALPHA17_PROVIDER_PROBE_FAILED' &&
        error.message.includes(`provider probe ${probe} did not pass`) &&
        new RegExp(`unmet: [^)]*\\b${condition}\\b`).test(error.message);
      if (!named) console.error(`${label}: ${error && error.code} ${error && error.message}`);
      return named;
    },
    label
  );
}

const BRANCH = `nvx-alpha17-${RUN_ID}-proof`;
const PREFIX = `nvx-alpha17-${RUN_ID}`;

(async () => {
  /* ---- The chain as a whole, against a fixture that behaves ------------- */
  {
    const { result, fixture } = await run(async () => null);
    assert.strictEqual(result.status, 'pass');
    const byKey = new Map(result.checks.map(check => [check.key, check]));
    assert.deepStrictEqual({ ...byKey.get('exposure-read') }, {
      key: 'exposure-read', status: 'pass', statusClass: '2xx',
      refResolved: true, treeBound: true, blobTextMatched: true, historyReached: true
    });
    assert.strictEqual(byKey.get('folder-move').filesMoved, 2, 'the move must carry a nested path and a second file');
    for (const key of ['file-rename', 'folder-move', 'issue-write', 'pull-write', 'release-write', 'star-toggle', 'code-search', 'workflow-rerun']) {
      const check = byKey.get(key);
      assert(check && check.status === 'pass', `${key} must pass against a correct provider`);
      for (const [field, value] of Object.entries(check)) {
        if (typeof value === 'boolean') assert.strictEqual(value, true, `${key}.${field}`);
      }
    }
    /* And the provider is left as it was found: nothing the probes made survives but a closed issue and a merged pull request. */
    assert.deepStrictEqual([...fixture.state.branches.keys()], ['main']);
    assert.strictEqual(fixture.state.starred, false);
    assert.deepStrictEqual([...fixture.state.tags.keys()], ['fixture']);
    assert.deepStrictEqual([...fixture.state.releases.keys()], [21]);
    const made = [...fixture.state.issues.values()].filter(issue => issue.number !== 11);
    assert.strictEqual(made.length, 1);
    assert.strictEqual(made[0].state, 'closed');
    const pulls = [...fixture.state.pulls.values()].filter(pull => pull.number !== 7);
    assert.strictEqual(pulls.length, 1);
    assert.strictEqual(pulls[0].merged, true);
    const reruns = [...fixture.state.runs.values()].filter(entry => entry.id !== 31);
    assert.strictEqual(reruns.length, 1);
    assert.strictEqual(reruns[0].run_attempt, 2);
    assert.strictEqual(fixture.state.runs.get(31).run_attempt, 1, 'the permanent fixture run is never the one re-run');
  }

  /* ---- exposure-read ----------------------------------------------------- */
  /*
   * The head's own parent: a real commit, whose tree still holds the proof
   * file and whose history still reaches the commit that added it -- so the
   * only condition that can fail is the one under test.
   */
  await expectUnmet('a ref resolved to a commit other than the head', 'exposure-read', 'refResolved', async (request, pass, context, url) => {
    if (!request.reader || !/\/commits\/[^/]+$/.test(request.pathname) || request.search.has('per_page')) return null;
    const detail = await context.fixture.fetch(url, { method: 'GET', headers: { accept: 'application/vnd.github+json' } });
    const parent = (await detail.json()).parents[0].sha;
    return new Response(parent, { status: 200, headers: { 'content-type': 'text/plain' } });
  });
  await expectUnmet('a tree the reader is told was truncated', 'exposure-read', 'treeBound', async (request, pass) => {
    if (!request.reader || !request.pathname.includes('/git/trees/')) return null;
    const listing = await (await pass()).json();
    return reply(200, { ...listing, truncated: true });
  });
  await expectUnmet('a blob that reads back as other bytes', 'exposure-read', 'blobTextMatched', async (request, pass) => {
    if (!request.reader || !request.pathname.includes('/git/blobs/')) return null;
    const blob = await (await pass()).json();
    return reply(200, { ...blob, content: Buffer.from('other text\n').toString('base64') });
  });
  await expectUnmet('a history that never shows the file being added', 'exposure-read', 'historyReached', async (request, pass) => {
    if (!request.reader || !/\/commits\/[0-9a-f]{40}$/.test(request.pathname) || !request.search.has('per_page')) return null;
    const commit = await (await pass()).json();
    return reply(200, { ...commit, files: [] });
  });

  /* ---- file-rename ------------------------------------------------------- */
  const renamed = `${PREFIX}-tree/nested/inline.txt`;
  await expectUnmet('a renamed path that carries a different object', 'file-rename', 'identityPreserved', async request => {
    if (request.method !== 'GET' || !request.pathname.endsWith(`/contents/${renamed}`)) return null;
    return reply(200, { content: Buffer.from('x').toString('base64'), sha: 'e'.repeat(40) });
  });
  await expectUnmet('a source path still present after the rename', 'file-rename', 'sourceRemoved', async (request, pass, context) => {
    if (request.method === 'POST' && request.pathname.endsWith('/git/trees') &&
      ((request.body && request.body.tree) || []).some(entry => entry.path === renamed)) context.memo.renamed = true;
    if (!context.memo.renamed || request.method !== 'GET' || !request.pathname.endsWith(`/contents/${PREFIX}-batch-inline.txt`)) return null;
    return reply(200, { content: Buffer.from('still here').toString('base64'), sha: 'f'.repeat(40) });
  });
  await expectUnmet('a rename committed onto a parent other than the observed head', 'file-rename', 'parentIsObservedHead', async (request, pass, context) => {
    if (request.method === 'POST' && request.pathname.endsWith('/git/trees') &&
      ((request.body && request.body.tree) || []).some(entry => entry.path === renamed)) context.memo.renameTree = true;
    if (context.memo.renameTree && request.method === 'POST' && request.pathname.endsWith('/git/commits')) {
      const response = await pass();
      context.memo.renameCommit = (await response.clone().json()).sha;
      context.memo.renameTree = false;
      return response;
    }
    if (!context.memo.renameCommit || request.method !== 'GET' || !request.pathname.endsWith(`/git/commits/${context.memo.renameCommit}`)) return null;
    const commit = await (await pass()).json();
    return reply(200, { ...commit, parents: [{ sha: '9'.repeat(40) }] });
  });

  /* ---- folder-move ------------------------------------------------------- */
  const moveTree = request => request.method === 'POST' && request.pathname.endsWith('/git/trees') &&
    ((request.body && request.body.tree) || []).some(entry => entry.path.startsWith(`${PREFIX}-moved/`));
  const trackMove = async (request, pass, context) => {
    if (moveTree(request)) context.memo.moveTree = true;
    if (context.memo.moveTree && request.method === 'POST' && request.pathname.endsWith('/git/commits')) {
      const response = await pass();
      context.memo.moveCommit = (await response.clone().json()).sha;
      context.memo.moveTree = false;
      return response;
    }
    return null;
  };
  const afterMoveListing = (request, context) => context.memo.moveCommit && request.method === 'GET' &&
    request.pathname.endsWith(`/git/trees/${context.memo.moveCommit}`) && !request.reader;
  await expectUnmet('a moved file that lands under another identity', 'folder-move', 'identitiesPreserved', async (request, pass, context) => {
    const tracked = await trackMove(request, pass, context);
    if (tracked) return tracked;
    if (!afterMoveListing(request, context)) return null;
    const listing = await (await pass()).json();
    return reply(200, { ...listing, tree: listing.tree.map(entry => (entry.path.startsWith(`${PREFIX}-moved/`) && entry.type === 'blob' ? { ...entry, sha: 'a'.repeat(40) } : entry)) });
  });
  await expectUnmet('a folder that still holds a file after the move', 'folder-move', 'sourceEmptied', async (request, pass, context) => {
    const tracked = await trackMove(request, pass, context);
    if (tracked) return tracked;
    if (!afterMoveListing(request, context)) return null;
    const listing = await (await pass()).json();
    return reply(200, { ...listing, tree: [...listing.tree, { path: `${PREFIX}-tree/left-behind.txt`, mode: '100644', type: 'blob', sha: 'b'.repeat(40) }] });
  });
  await expectUnmet('a move committed onto a parent other than the observed head', 'folder-move', 'parentIsObservedHead', async (request, pass, context) => {
    const tracked = await trackMove(request, pass, context);
    if (tracked) return tracked;
    if (!context.memo.moveCommit || request.method !== 'GET' || !request.pathname.endsWith(`/git/commits/${context.memo.moveCommit}`)) return null;
    const commit = await (await pass()).json();
    return reply(200, { ...commit, parents: [{ sha: '8'.repeat(40) }] });
  });

  /* ---- issue-write ------------------------------------------------------- */
  const issueDetail = request => request.method === 'GET' && /\/issues\/(1\d\d)$/.test(request.pathname);
  await expectUnmet('an issue that reads back under another title', 'issue-write', 'createdReadBack', async (request, pass) => {
    if (!issueDetail(request)) return null;
    const issue = await (await pass()).json();
    return reply(200, { ...issue, title: 'someone else' });
  });
  await expectUnmet('a comment that never appears', 'issue-write', 'commentReadBack', async request => (
    request.method === 'GET' && /\/issues\/\d+\/comments$/.test(request.pathname) ? reply(200, []) : null
  ));
  await expectUnmet('a close that is acknowledged and not applied', 'issue-write', 'closedReadBack', async request => (
    request.method === 'PATCH' && /\/issues\/\d+$/.test(request.pathname) ? reply(200, { state: 'closed' }) : null
  ));
  await expectUnmet('a read-only credential that can open an issue', 'issue-write', 'readOnlyRefused', async (request, pass, context, url, init) => {
    if (request.method !== 'POST' || !request.pathname.endsWith('/issues') || !request.authorization.includes(context.env.NV_ALPHA17_READ_ONLY_CREDENTIAL)) return null;
    return context.fixture.fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${context.env.NV_ALPHA17_MUTATION_CREDENTIAL}` } });
  });

  /* ---- pull-write -------------------------------------------------------- */
  await expectUnmet('a pull request that reads back against another base', 'pull-write', 'createdReadBack', async (request, pass) => {
    if (request.method !== 'GET' || !/\/pulls\/1\d\d$/.test(request.pathname)) return null;
    const pull = await (await pass()).json();
    return reply(200, { ...pull, base: { ...pull.base, ref: 'main' } });
  });
  await expectUnmet('a review that is not recorded as a comment', 'pull-write', 'reviewRecorded', async request => (
    request.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(request.pathname) ? reply(200, { id: 5, state: 'PENDING' }) : null
  ));
  await expectUnmet('a merge accepted against a head the provider no longer has', 'pull-write', 'staleHeadRefused', async (request, pass, context, url, init) => {
    if (request.method !== 'PUT' || !request.pathname.endsWith('/merge')) return null;
    const { sha, ...rest } = request.body;
    void sha;
    return context.fixture.fetch(url, { ...init, body: JSON.stringify(rest) });
  });
  await expectUnmet('a merge that reports a commit the base never reaches', 'pull-write', 'mergedIntoBase', async (request, pass) => {
    if (request.method !== 'PUT' || !request.pathname.endsWith('/merge')) return null;
    const response = await pass();
    if (response.status !== 200) return response;
    return reply(200, { ...(await response.json()), sha: '7'.repeat(40) });
  });
  await expectUnmet('a branch delete that is acknowledged and not applied', 'pull-write', 'refsRemoved', async request => (
    request.method === 'DELETE' && request.pathname.endsWith(`/git/refs/heads/${BRANCH}-pr-head`) ? reply(204) : null
  ));

  /* ---- release-write ----------------------------------------------------- */
  await expectUnmet('a release that reads back as a full release', 'release-write', 'createdReadBack', async (request, pass) => {
    if (request.method !== 'GET' || !/\/releases\/1\d\d$/.test(request.pathname)) return null;
    const response = await pass();
    if (response.status !== 200) return response;
    return reply(200, { ...(await response.json()), prerelease: false });
  });
  await expectUnmet('a tag created somewhere other than the target', 'release-write', 'tagAtTarget', async request => (
    request.method === 'GET' && request.pathname.endsWith(`/git/ref/tags/${PREFIX}-release`) ? reply(200, { object: { sha: '6'.repeat(40) } }) : null
  ));
  await expectUnmet('a tag delete that is acknowledged and not applied', 'release-write', 'cleanupAbsent', async request => (
    request.method === 'DELETE' && request.pathname.endsWith(`/git/refs/tags/${PREFIX}-release`) ? reply(204) : null
  ));

  /* ---- star-toggle ------------------------------------------------------- */
  const starPath = '/user/starred/fixture-owner/nvx-alpha17-github-qualification';
  await expectUnmet('a star that is acknowledged and not set', 'star-toggle', 'starVisible', async request => (
    request.method === 'PUT' && request.pathname === starPath ? reply(204) : null
  ));
  await expectUnmet('an unstar that is acknowledged and not applied', 'star-toggle', 'unstarVisible', async request => (
    request.method === 'DELETE' && request.pathname === starPath ? reply(204) : null
  ));
  await expectUnmet('a star the probe found and did not put back', 'star-toggle', 'initialStateRestored', async (request, pass, context) => {
    if (request.method !== 'PUT' || request.pathname !== starPath) return null;
    context.memo.puts = (context.memo.puts || 0) + 1;
    return context.memo.puts === 2 ? reply(204) : null;
  }, fixture => { fixture.state.starred = true; });

  /* ---- code-search ------------------------------------------------------- */
  const searching = request => request.method === 'GET' && request.pathname === '/search/code';
  await expectUnmet('a search that finds the fixture under another path', 'code-search', 'fixtureFound', async (request, pass) => {
    if (!searching(request)) return null;
    const found = await (await pass()).json();
    return reply(200, { ...found, items: found.items.map(item => ({ ...item, path: 'elsewhere.md' })) });
  });
  await expectUnmet('a search that answers from another repository', 'code-search', 'resultsScoped', async (request, pass) => {
    if (!searching(request)) return null;
    const found = await (await pass()).json();
    return reply(200, { ...found, items: [...found.items, { name: 'x.md', path: 'x.md', repository: { full_name: 'someone/else' } }] });
  });
  await expectUnmet('a search that answers every query with the same list', 'code-search', 'absentDiscriminated', async request => (
    searching(request)
      ? reply(200, { total_count: 1, items: [{ name: 'NVX_SEARCH_FIXTURE.md', path: 'NVX_SEARCH_FIXTURE.md', repository: { full_name: 'fixture-owner/nvx-alpha17-github-qualification' } }] })
      : null
  ));

  /* ---- workflow-rerun ---------------------------------------------------- */
  await expectUnmet('a dispatched run that never finishes', 'workflow-rerun', 'dispatchedRunCompleted', async (request, pass) => {
    if (request.method !== 'GET' || !/\/actions\/runs\/1\d\d$/.test(request.pathname)) return null;
    return reply(200, { ...(await (await pass()).json()), status: 'in_progress' });
  });
  await expectUnmet('a re-run the provider refuses', 'workflow-rerun', 'rerunAccepted', async request => (
    request.method === 'POST' && request.pathname.endsWith('/rerun') ? reply(403, { message: 'refused' }) : null
  ));
  await expectUnmet('a re-run that is acknowledged and never starts', 'workflow-rerun', 'attemptAdvanced', async request => (
    request.method === 'POST' && request.pathname.endsWith('/rerun') ? reply(201, {}) : null
  ));

  /* ---- GitLab: the same write proofs through GitLab's own requests ------- */
  {
    const { runGitlabValidation } = require('../ci/run-gitlab-alpha17-validation');
    const gitlabEnvironment = () => {
      const repository = 'fixture-owner/nvx-alpha17-gitlab-qualification';
      const env = {
        ...environment(),
        NV_ALPHA17_REPOSITORY: repository,
        NV_ALPHA17_GITLAB_API_URL: 'https://gitlab.fixture.invalid/api/v4'
      };
      env.NV_ALPHA17_SIGNED_TARGET_SHA256 = crypto.createHash('sha256').update(JSON.stringify({
        apiUrl: env.NV_ALPHA17_GITLAB_API_URL, jobName: 'gitlab', repository
      })).digest('hex');
      return env;
    };
    const runGitlab = async middleware => {
      const env = gitlabEnvironment();
      const fixture = createProviderFetchFixture({
        provider: 'gitlab', repository: env.NV_ALPHA17_REPOSITORY, defaultBranch: 'main', runId: RUN_ID,
        mutationCredential: env.NV_ALPHA17_MUTATION_CREDENTIAL, readOnlyCredential: env.NV_ALPHA17_READ_ONLY_CREDENTIAL
      });
      const context = { fixture, env, memo: {} };
      const fetchImpl = async (url, init = {}) => {
        const request = describe(url, init);
        request.token = new Headers(init.headers || {}).get('private-token') || '';
        return (await middleware(request, () => fixture.fetch(url, init), context, url, init)) || fixture.fetch(url, init);
      };
      return { result: await runGitlabValidation({ env, fetchImpl, now: () => new Date(NOW) }), fixture };
    };
    const { result, fixture } = await runGitlab(async () => null);
    const byKey = new Map(result.checks.map(check => [check.key, check]));
    for (const key of ['issue-write', 'pull-write']) {
      assert(byKey.get(key) && byKey.get(key).status === 'pass', `GitLab ${key} must pass against a correct provider`);
    }
    assert.deepStrictEqual([...fixture.state.branches.keys()], ['main']);
    const merged = [...fixture.state.glMergeRequests.values()].filter(request => request.iid !== 1);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].state, 'merged');

    const gitlabUnmet = async (label, probe, condition, middleware) => assert.rejects(
      () => runGitlab(middleware),
      error => {
        const named = Boolean(error) && error.code === 'ALPHA17_PROVIDER_PROBE_FAILED' &&
          error.message.includes(`provider probe ${probe} did not pass`) &&
          new RegExp(`unmet: [^)]*\\b${condition}\\b`).test(error.message);
        if (!named) console.error(`${label}: ${error && error.code} ${error && error.message}`);
        return named;
      },
      label
    );
    await gitlabUnmet('a GitLab issue that reads back under another title', 'issue-write', 'createdReadBack', async (request, pass) => {
      if (request.method !== 'GET' || !/\/issues\/1\d\d$/.test(request.pathname)) return null;
      return reply(200, { ...(await (await pass()).json()), title: 'someone else' });
    });
    await gitlabUnmet('a GitLab close that is acknowledged and not applied', 'issue-write', 'closedReadBack', async request => (
      request.method === 'PUT' && /\/issues\/\d+$/.test(request.pathname) ? reply(200, { state: 'closed' }) : null
    ));
    await gitlabUnmet('a read_api token that can open an issue', 'issue-write', 'readOnlyRefused', async (request, pass, context, url, init) => {
      if (request.method !== 'POST' || !request.pathname.endsWith('/issues') || request.token !== context.env.NV_ALPHA17_READ_ONLY_CREDENTIAL) return null;
      return context.fixture.fetch(url, { ...init, headers: { ...init.headers, 'PRIVATE-TOKEN': context.env.NV_ALPHA17_MUTATION_CREDENTIAL } });
    });
    await gitlabUnmet('a merge request that never finishes its mergeability check', 'pull-write', 'createdReadBack', async (request, pass) => {
      if (request.method !== 'GET' || !/\/merge_requests\/1\d\d$/.test(request.pathname)) return null;
      return reply(200, { ...(await (await pass()).json()), detailed_merge_status: 'checking', sha: 'a'.repeat(40) });
    });
    await gitlabUnmet('a review note that never appears', 'pull-write', 'reviewRecorded', async request => (
      request.method === 'GET' && /\/merge_requests\/\d+\/notes$/.test(request.pathname) ? reply(200, []) : null
    ));
    await gitlabUnmet('a GitLab merge accepted against a head it no longer has', 'pull-write', 'staleHeadRefused', async (request, pass, context, url, init) => {
      if (request.method !== 'PUT' || !request.pathname.endsWith('/merge')) return null;
      const { sha, ...rest } = request.body;
      void sha;
      return context.fixture.fetch(url, { ...init, body: JSON.stringify(rest) });
    });
    await gitlabUnmet('a GitLab merge commit that is not the base and the source', 'pull-write', 'mergedIntoBase', async (request, pass) => {
      if (request.method !== 'GET' || !/\/repository\/commits\/[0-9a-f]{40}$/.test(request.pathname)) return null;
      const response = await pass();
      if (response.status !== 200) return response;
      const commit = await response.json();
      return reply(200, commit.parent_ids && commit.parent_ids.length === 2 ? { ...commit, parent_ids: [commit.parent_ids[1], commit.parent_ids[0]] } : commit);
    });
  }

  /*
   * ---- The probes send what the product sends -------------------------------
   *
   * A probe that reached the provider by another route would prove GitHub works
   * and leave the product's route unproven while the registry said otherwise.
   * These hold each probe to the route it earns a claim for.
   */
  {
    const fs = require('fs');
    const path = require('path');
    const { scopedCodeQuery } = require('../src/github-account-operations');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const harness = fs.readFileSync(path.join(__dirname, '..', 'ci', 'run-github-alpha17-validation.js'), 'utf8');
    const route = (method, routePath) => {
      const start = server.indexOf(`app.${method}('${routePath}'`);
      assert(start >= 0, `missing ${method.toUpperCase()} ${routePath}`);
      return server.slice(start, server.indexOf('\n});', start));
    };

    /* Rename: the source found a level at a time, re-linked by identity on the observed head, destination required free. */
    const rename = route('post', '/api/repo/:owner/:repo/rename');
    assert.match(rename, /gitTreeEntryByPath\(/);
    assert.match(rename, /\{ path: to, sha: entry\.sha, preserveFrom: from \}/);
    assert.match(rename, /\{ path: from, sha: null, preserveFrom: from \}/);
    assert.match(rename, /observedHead, \{ mustNotExist: \[to\] \}/);
    assert.match(harness, /\{ path: to, sha: sourceSha, preserveFrom: from \}/);
    assert.match(harness, /\{ path: from, sha: null, preserveFrom: from \}/);

    /* Folder move: the recursive tree of the observed head, entries forced, source removed. */
    const move = route('post', '/api/repo/:owner/:repo/move-dir');
    assert.match(move, /git\/trees\/\$\{ref\.object\.sha\}\?recursive=1/);
    assert.match(move, /entries\.push\(\{ path: destinationPath, mode: e\.mode, type: e\.type, sha: e\.sha, forceMode: true \}\)/);
    assert.match(harness, /entries\.push\(\{ path: destinationPath, mode: entry\.mode, type: entry\.type, sha: entry\.sha, forceMode: true \}\)/);
    assert.match(move, /mustNotExist: destinations/);

    /* Issues: create, comment and close with the bodies the product sends. */
    assert.match(route('post', '/api/repo/:owner/:repo/issues'), /\/issues`, \{ method: 'POST', body: \{ title, body: body \|\| '' \} \}/);
    assert.match(route('post', '/api/repo/:owner/:repo/issues/:num/comments'), /\/comments`, \{ method: 'POST', body: \{ body \} \}/);
    assert.match(route('patch', '/api/repo/:owner/:repo/issues/:num'), /method: 'PATCH', body: \{ state \}/);

    /* Pull requests: the merge carries the pinned head, and the review a comment event. */
    const merge = route('put', '/api/repo/:owner/:repo/pulls/:num/merge');
    assert.match(merge, /body: \{ merge_method: method, \.\.\.\(expected \? \{ sha: expected \} : \{\}\) \}/);
    assert.match(merge, /error\.status === 409\) throw headMoved\(\)/);
    assert.match(harness, /merge_method: 'merge', sha: reportedHead/);
    assert.match(route('post', '/api/repo/:owner/:repo/pulls'), /body: \{ title, head, base, body: body \|\| '', draft: !!draft \}/);

    /* Releases: the same create body, a prerelease on a branch. */
    assert.match(route('post', '/api/repo/:owner/:repo/releases'),
      /body: \{ tag_name: tag, name: name \|\| tag, body: body \|\| '', target_commitish: target \|\| undefined, prerelease: !!prerelease \}/);

    /* Stars and re-runs: the same endpoints. */
    assert.match(route('put', '/api/repo/:owner/:repo/star'), /`\/user\/starred\/\$\{req\.params\.owner\}\/\$\{req\.params\.repo\}`, \{ method: 'PUT' \}/);
    assert.match(harness, /const starPath = `user\/starred\/\$\{repositoryPath\}`/);
    assert.match(route('post', '/api/repo/:owner/:repo/actions/:runId/rerun'), /\/actions\/runs\/\$\{req\.params\.runId\}\/rerun`, \{ method: 'POST' \}/);

    /* Search: the probe's query is the one the product's guard composes. */
    const search = route('get', '/api/repo/:owner/:repo/search');
    assert.match(search, /scopedCodeQuery\(req\.query\.q, repository\)/);
    assert.strictEqual(scopedCodeQuery('nvx-alpha17-search-fixture', 'owner/name'), 'nvx-alpha17-search-fixture repo:owner/name');
    assert.match(harness, /url\.searchParams\.set\('q', `\$\{words\} repo:\$\{repository\}`\)/);

    /* GitLab: the issue, note, close, merge-request, review-note and merge requests the product sends. */
    const gitlabHarness = fs.readFileSync(path.join(__dirname, '..', 'ci', 'run-gitlab-alpha17-validation.js'), 'utf8');
    assert.match(route('post', '/api/repo/:owner/:repo/issues'), /\/issues`, \{ method: 'POST', body: \{ title, description: body \|\| '' \} \}/);
    assert.match(route('patch', '/api/repo/:owner/:repo/issues/:num'), /body: \{ state_event: state === 'closed' \? 'close' : 'reopen' \}/);
    assert.match(gitlabHarness, /\{ state_event: 'close' \}/);
    assert.match(route('post', '/api/repo/:owner/:repo/pulls'), /body: \{ title, source_branch: head, target_branch: base, description: body \|\| '' \}/);
    assert.match(merge, /body: \{ squash: method === 'squash', \.\.\.\(expected \? \{ sha: expected \} : \{\}\) \}/);
    assert.match(gitlabHarness, /\{ squash: false, sha: reportedHead \}/);
    assert.match(route('post', '/api/repo/:owner/:repo/pulls/:num/reviews'), /merge_requests\/\$\{req\.params\.num\}\/notes`, \{ method: 'POST', body: \{ body: text \} \}/);
    assert.match(gitlabHarness, /merge_requests\/\$\{iid\}\/notes`, \{ body: reviewNote \}/);

    /* Exposure: the probe runs the product's reader module, not a copy of it. */
    assert.match(harness, /const exposureReader = require\('\.\.\/src\/exposure-reader'\);/);
    for (const call of ['resolveCommit', 'readTree', 'readBlob', 'listCommits', 'readCommitChanges']) {
      assert(harness.includes(`exposureReader.${call}(`), `the exposure probe must call the reader's ${call}`);
    }
  }

  console.log('capability probe tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
