'use strict';

// Synthetic provider boundary. The application, cookie codec and logout are real.
const originalFetch = global.fetch;
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === 'https://api.github.com' && url.pathname === '/user') {
    return new Response(JSON.stringify({ id: 910, login: 'session-fixture', avatar_url: '' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  throw new Error('Unexpected provider request in session regression');
};
