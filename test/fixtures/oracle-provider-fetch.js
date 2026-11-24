'use strict';
/*
 * Synthetic GitHub for the negative-request matrix. Two accounts, one
 * repository, and nothing else: the reader may pull sandbox/demo, the
 * administrator may do anything to it, and every other provider path is a 404.
 * No request leaves the process, so the matrix records what the server decides,
 * not what the network happened to do.
 */
const ACCOUNTS = Object.freeze({
  'oracle-reader-token': Object.freeze({ id: 9101, login: 'oracle-reader', name: 'Oracle Reader', avatar_url: '' }),
  'oracle-admin-token': Object.freeze({ id: 9102, login: 'oracle-admin', name: 'Oracle Admin', avatar_url: '' })
});
const PERMISSIONS = Object.freeze({
  'oracle-reader-token': Object.freeze({ admin: false, maintain: false, push: false, triage: false, pull: true }),
  'oracle-admin-token': Object.freeze({ admin: true, maintain: true, push: true, triage: true, pull: true })
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function tokenOf(input, init) {
  const header = new Headers(init.headers || (input && input.headers) || {}).get('authorization') || '';
  return header.replace(/^(?:Bearer|token)\s+/i, '');
}

const originalFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
  const token = tokenOf(input, init);
  const method = String(init.method || 'GET').toUpperCase();
  if (url.hostname === 'api.github.com' && method === 'GET' && url.pathname === '/user' && ACCOUNTS[token]) {
    return json(ACCOUNTS[token]);
  }
  if (url.hostname === 'api.github.com' && method === 'GET' && url.pathname === '/repos/sandbox/demo' && PERMISSIONS[token]) {
    return json({
      id: 7001, name: 'demo', full_name: 'sandbox/demo', private: false, visibility: 'public',
      default_branch: 'main', owner: { login: 'sandbox', id: 7000, type: 'User' },
      permissions: PERMISSIONS[token]
    });
  }
  return json({ message: 'Not Found' }, 404);
};
