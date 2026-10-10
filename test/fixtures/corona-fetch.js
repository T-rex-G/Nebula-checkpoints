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
  return providerFetch(input, options);
};
