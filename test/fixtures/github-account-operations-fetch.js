'use strict';

const fs = require('fs');
const log = process.env.NV_ACCOUNT_OPERATIONS_LOG;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.github.com') throw new Error('Unexpected external fixture request');
  const method = options.method || 'GET';
  const authorization = new Headers(options.headers || {}).get('authorization') || '';
  const readOnly = authorization.endsWith('fixture-read-only');
  const noDeletion = authorization.endsWith('fixture-no-deletion');
  if (log) fs.appendFileSync(log, JSON.stringify({ method, path: url.pathname, query: url.search, readOnly }) + '\n');
  if (url.pathname === '/user') return json({ id: 7, login: 'alice' });
  if (url.pathname === '/user/repos' && method === 'POST') {
    const body = JSON.parse(options.body);
    return json({ id: 12, full_name: `alice/${body.name}`, default_branch: 'main' }, 201);
  }
  if (url.pathname.endsWith('/collaborators/alice/permission')) return json({
    permission: readOnly ? 'read' : 'admin', role_name: readOnly ? 'read' : 'admin', user: { login: 'alice' }
  });
  if (/^\/repos\/alice\/[^/]+\/branches$/.test(url.pathname)) return json([{ name: 'main', commit: { sha: 'a'.repeat(40) } }]);
  if (/^\/repos\/alice\/[^/]+$/.test(url.pathname)) {
    if (method === 'DELETE') return noDeletion ? json({ message: 'Missing delete_repo permission' }, 403) : new Response(null, { status: 204 });
    return json({ id: 12, full_name: url.pathname.slice('/repos/'.length), default_branch: 'main', permissions: { admin: !readOnly } });
  }
  if (url.pathname === '/search/code') return json({ items: [{ repository: { full_name: 'team/project' }, path: 'README.md' }] });
  if (url.pathname === '/notifications') return json([{ id: 'n1', repository: { full_name: 'team/project' }, subject: { title: 'Review requested', type: 'PullRequest' } }]);
  return json({ message: `Unexpected fixture request: ${method} ${url.pathname}` }, 598);
};
