'use strict';

const assert = require('assert');

let providerMutations = null;
try {
  providerMutations = require('../src/provider-file-mutations');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' ||
      !String(error.message).includes('provider-file-mutations')) throw error;
}

assert(
  providerMutations && typeof providerMutations.createGiteaFileMutationAdapter === 'function',
  'a Gitea file mutation adapter must be implemented'
);

const HEAD = '1'.repeat(40);
const NEXT = '2'.repeat(40);
const BLOB = '3'.repeat(40);

function notFound() {
  return Object.assign(new Error('not found'), { status: 404 });
}

(async () => {
  const writes = [];
  let temporaryBranch = '';
  const request = async (apiPath, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET') writes.push({ apiPath, method, body: options.body });

    if (method === 'GET' && apiPath === '/repos/Acme/Demo/branches/main') {
      return { commit: { id: writes.some(item => item.apiPath.endsWith('/branches/main')) ? NEXT : HEAD } };
    }
    if (method === 'GET' &&
        apiPath === `/repos/Acme/Demo/contents/folder/a.txt?ref=${HEAD}`) {
      throw notFound();
    }
    if (method === 'POST' && apiPath === '/repos/Acme/Demo/branches') {
      temporaryBranch = options.body.new_branch_name;
      assert.match(temporaryBranch, /^nv-tx\/[0-9a-f]{24}$/);
      assert.deepStrictEqual(options.body, {
        new_branch_name: temporaryBranch,
        old_ref_name: HEAD
      });
      return { name: temporaryBranch, commit: { id: HEAD } };
    }
    if (method === 'PUT' &&
        apiPath === '/repos/Acme/Demo/contents/folder/a.txt') {
      assert.deepStrictEqual(options.body, {
        branch: temporaryBranch,
        content: Buffer.from('hello\n', 'utf8').toString('base64'),
        message: 'Create fixture'
      });
      return { content: { sha: BLOB }, commit: { sha: NEXT, parents: [{ sha: HEAD }] } };
    }
    if (method === 'PUT' && apiPath === '/repos/Acme/Demo/branches/main') {
      assert.deepStrictEqual(options.body, {
        new_commit_id: NEXT,
        old_commit_id: HEAD,
        force: false
      });
      return null;
    }
    if (method === 'DELETE' &&
        apiPath === `/repos/Acme/Demo/branches/${encodeURIComponent(temporaryBranch)}`) {
      return null;
    }
    throw new Error(`Unexpected request: ${method} ${apiPath}`);
  };

  const adapter = providerMutations.createGiteaFileMutationAdapter({ request });
  const result = await adapter.write({
    owner: 'Acme',
    repo: 'Demo',
    path: 'folder/a.txt',
    content: 'hello\n',
    message: 'Create fixture',
    branch: 'main',
    expectedHeadSha: HEAD
  });

  assert.deepStrictEqual(result, { commit: NEXT, sha: BLOB });
  assert.deepStrictEqual(writes.map(item => item.method), ['POST', 'PUT', 'PUT', 'DELETE']);
  assert.strictEqual(
    writes.filter(item => item.apiPath.includes('/git/')).length,
    0,
    'Gitea writes must not use read-only Git Data API endpoints'
  );
  console.log('Gitea create mutation regression passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

(async () => {
  const writes = [];
  let temporaryBranch = '';
  let targetMoved = false;
  const request = async (apiPath, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET') writes.push({ apiPath, method, body: options.body });

    if (method === 'GET' && apiPath === '/repos/Acme/Demo/branches/main') {
      return { commit: { id: targetMoved ? NEXT : HEAD } };
    }
    if (method === 'GET' &&
        apiPath === `/repos/Acme/Demo/contents/folder/a.txt?ref=${HEAD}`) {
      return { path: 'folder/a.txt', sha: BLOB, type: 'file' };
    }
    if (method === 'POST' && apiPath === '/repos/Acme/Demo/branches') {
      temporaryBranch = options.body.new_branch_name;
      return { name: temporaryBranch, commit: { id: HEAD } };
    }
    if (method === 'DELETE' &&
        apiPath === '/repos/Acme/Demo/contents/folder/a.txt') {
      assert.deepStrictEqual(options.body, {
        branch: temporaryBranch,
        message: 'Delete fixture',
        sha: BLOB
      });
      return { content: null, commit: { sha: NEXT, parents: [{ sha: HEAD }] } };
    }
    if (method === 'PUT' && apiPath === '/repos/Acme/Demo/branches/main') {
      targetMoved = true;
      assert.deepStrictEqual(options.body, {
        new_commit_id: NEXT,
        old_commit_id: HEAD,
        force: false
      });
      return null;
    }
    if (method === 'DELETE' &&
        apiPath === `/repos/Acme/Demo/branches/${encodeURIComponent(temporaryBranch)}`) {
      return null;
    }
    throw new Error(`Unexpected request: ${method} ${apiPath}`);
  };

  const adapter = providerMutations.createGiteaFileMutationAdapter({ request });
  assert.strictEqual(typeof adapter.delete, 'function', 'the Gitea adapter must support file deletion');
  const result = await adapter.delete({
    owner: 'Acme',
    repo: 'Demo',
    path: 'folder/a.txt',
    message: 'Delete fixture',
    branch: 'main',
    expectedHeadSha: HEAD
  });

  assert.deepStrictEqual(result, { commit: NEXT });
  assert.deepStrictEqual(writes.map(item => item.method), ['POST', 'DELETE', 'PUT', 'DELETE']);
  assert.strictEqual(
    writes.filter(item => item.apiPath.includes('/git/')).length,
    0,
    'Gitea deletes must not use read-only Git Data API endpoints'
  );
  console.log('Gitea delete mutation regression passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

(async () => {
  const ACTUAL_HEAD = '4'.repeat(40);
  const writes = [];
  const request = async (apiPath, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET') writes.push({ apiPath, method });
    if (method === 'GET' && apiPath === '/repos/Acme/Demo/branches/main') {
      return { commit: { id: ACTUAL_HEAD } };
    }
    throw new Error(`Unexpected request after stale-head discovery: ${method} ${apiPath}`);
  };
  const adapter = providerMutations.createGiteaFileMutationAdapter({ request });

  await assert.rejects(
    () => adapter.write({
      owner: 'Acme',
      repo: 'Demo',
      path: 'folder/stale.txt',
      content: 'must not commit\n',
      branch: 'main',
      expectedHeadSha: HEAD
    }),
    error => error && error.code === 'BRANCH_CHANGED'
  );
  assert.deepStrictEqual(writes, [], 'stale expected heads must be rejected before any provider write');
  console.log('Gitea stale-head regression passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

(async () => {
  const writes = [];
  let temporaryBranch = '';
  const request = async (apiPath, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET') writes.push({ apiPath, method });
    if (method === 'GET' && apiPath === '/repos/Acme/Demo/branches/main') {
      return { commit: { id: HEAD } };
    }
    if (method === 'GET' &&
        apiPath === `/repos/Acme/Demo/contents/folder/race.txt?ref=${HEAD}`) {
      throw notFound();
    }
    if (method === 'POST' && apiPath === '/repos/Acme/Demo/branches') {
      temporaryBranch = options.body.new_branch_name;
      return { name: temporaryBranch, commit: { id: HEAD } };
    }
    if (method === 'PUT' &&
        apiPath === '/repos/Acme/Demo/contents/folder/race.txt') {
      return { content: { sha: BLOB }, commit: { sha: NEXT, parents: [{ sha: HEAD }] } };
    }
    if (method === 'PUT' && apiPath === '/repos/Acme/Demo/branches/main') {
      throw Object.assign(new Error('target branch changed'), { status: 409 });
    }
    if (method === 'DELETE' &&
        apiPath === `/repos/Acme/Demo/branches/${encodeURIComponent(temporaryBranch)}`) {
      return null;
    }
    throw new Error(`Unexpected request: ${method} ${apiPath}`);
  };
  const adapter = providerMutations.createGiteaFileMutationAdapter({ request });

  await assert.rejects(
    () => adapter.write({
      owner: 'Acme',
      repo: 'Demo',
      path: 'folder/race.txt',
      content: 'must not replace newer work\n',
      branch: 'main',
      expectedHeadSha: HEAD
    }),
    error => error && error.code === 'BRANCH_CHANGED'
  );
  assert.deepStrictEqual(writes.map(item => item.method), ['POST', 'PUT', 'PUT', 'DELETE'],
    'a compare-and-swap conflict must clean the disposable branch without retrying the target write');
  console.log('Gitea compare-and-swap race regression passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
