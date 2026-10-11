'use strict';

/* All provider traffic stays synthetic. The barrier pauses reauthentication
   after the HTTP server has read a session, so revocation can race its save. */
require('./github-account-operations-fetch');
const fs = require('fs');
const path = require('path');
const providerFetch = global.fetch;
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const authorization = new Headers(options.headers || {}).get('authorization') || '';
  if (url.origin === 'https://api.github.com' && url.pathname === '/user'
      && authorization.endsWith('fixture-delayed')) {
    const directory = process.env.NV_CORONA_BARRIER;
    fs.writeFileSync(path.join(directory, 'reauth-started'), 'ready');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(directory, 'reauth-release'))) {
      if (Date.now() >= deadline) throw new Error('Corona test reauthentication barrier timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  /* What emergency containment reads to sign its manifest. */
  const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.origin === 'https://api.github.com' && /^\/repos\/alice\/[^/]+\/tags$/.test(url.pathname)) return reply([]);
  if (url.origin === 'https://api.github.com' && /^\/repos\/alice\/[^/]+\/git\/trees\/[0-9a-f]{40}$/.test(url.pathname)) {
    return reply({ truncated: false, tree: [{ path: 'README.md', type: 'blob', sha: 'b'.repeat(40), size: 12, mode: '100644' }] });
  }
  return providerFetch(input, options);
};
