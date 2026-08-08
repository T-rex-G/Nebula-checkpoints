'use strict';

const dns = require('dns').promises;

const realFetch = global.fetch;
const HEAD = '1'.repeat(40);
const CREATED = '2'.repeat(40);
const DELETED = '4'.repeat(40);
const BLOB = '3'.repeat(40);
const API_ORIGIN = 'https://gitea.example';
const FILE_PATH = '/repos/Acme/Demo/contents/folder/a.txt';

let mainHead = HEAD;
let filePresent = false;
const temporaryBranches = new Map();

dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function json(status, body) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: body == null ? {} : { 'content-type': 'application/json' }
  });
}

async function bodyOf(options) {
  if (!options || options.body == null) return {};
  return JSON.parse(String(options.body));
}

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== API_ORIGIN) return realFetch(input, options);
  const method = String(options.method || 'GET').toUpperCase();
  const route = url.pathname.replace(/^\/api\/v1/, '');
  const body = await bodyOf(options);

  if (method !== 'GET' && route.includes('/git/')) {
    return json(400, { message: 'Gitea Git Data endpoints are read-only' });
  }
  if (method === 'GET' && route === '/user') {
    return json(200, { login: 'tester', name: 'Gitea Tester', avatar_url: '' });
  }
  if (method === 'GET' &&
      route === '/repos/Acme/Demo/collaborators/tester/permission') {
    return json(200, {
      permission: 'admin',
      role_name: 'admin',
      user: { login: 'tester' }
    });
  }
  if (method === 'GET' && route === '/repos/Acme/Demo/branches/main') {
    return json(200, { name: 'main', commit: { id: mainHead } });
  }
  if (method === 'GET' && route === FILE_PATH) {
    const ref = url.searchParams.get('ref');
    const presentAtRef = filePresent && (ref === CREATED || ref === mainHead);
    return presentAtRef
      ? json(200, {
        path: 'folder/a.txt',
        type: 'file',
        sha: BLOB,
        encoding: 'base64',
        content: Buffer.from('hello\n', 'utf8').toString('base64')
      })
      : json(404, { message: 'not found' });
  }
  if (method === 'POST' && route === '/repos/Acme/Demo/branches') {
    if (!/^nv-tx\/[0-9a-f]{24}$/.test(String(body.new_branch_name || ''))) {
      return json(422, { message: 'invalid temporary branch' });
    }
    if (String(body.old_ref_name || '') !== mainHead) {
      return json(409, { message: 'stale branch base' });
    }
    temporaryBranches.set(body.new_branch_name, { head: mainHead, deleted: false });
    return json(201, { name: body.new_branch_name, commit: { id: mainHead } });
  }
  if (method === 'PUT' && route === FILE_PATH) {
    const temporary = temporaryBranches.get(body.branch);
    if (!temporary || temporary.deleted) return json(404, { message: 'temporary branch missing' });
    const next = filePresent ? DELETED : CREATED;
    temporary.head = next;
    temporary.deleted = false;
    return json(filePresent ? 200 : 201, {
      content: { path: 'folder/a.txt', sha: BLOB },
      commit: { sha: next, parents: [{ sha: mainHead }] }
    });
  }
  if (method === 'DELETE' && route === FILE_PATH) {
    const temporary = temporaryBranches.get(body.branch);
    if (!temporary || temporary.deleted || body.sha !== BLOB) {
      return json(422, { message: 'invalid delete request' });
    }
    temporary.head = DELETED;
    temporary.deleted = true;
    return json(200, {
      content: null,
      commit: { sha: DELETED, parents: [{ sha: mainHead }] }
    });
  }
  if (method === 'PUT' && route === '/repos/Acme/Demo/branches/main') {
    if (body.force !== false || body.old_commit_id !== mainHead) {
      return json(409, { message: 'branch changed' });
    }
    const temporary = [...temporaryBranches.values()]
      .find(item => item.head === body.new_commit_id);
    if (!temporary) return json(422, { message: 'commit not found' });
    mainHead = body.new_commit_id;
    filePresent = !temporary.deleted;
    return json(204, null);
  }
  if (method === 'DELETE' && route.startsWith('/repos/Acme/Demo/branches/')) {
    const name = decodeURIComponent(route.slice('/repos/Acme/Demo/branches/'.length));
    if (!temporaryBranches.delete(name)) return json(404, { message: 'branch not found' });
    return json(204, null);
  }
  return json(500, { message: `unexpected fixture request: ${method} ${route}` });
};
