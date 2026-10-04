'use strict';

// Test-process boundary only. Application API requests are never intercepted.
// GitHub's fixed API origin goes over a real socket to the disposable provider;
// every other outbound fetch fails closed so this gate cannot touch live data.
const target = new URL(process.env.NV_INTEGRATION_PROVIDER_ORIGIN || '');
if (process.env.NODE_ENV !== 'test' || target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' || target.pathname !== '/' ||
    target.username || target.password || target.search || target.hash) {
  throw new Error('The integration provider must be a test-only loopback HTTP service');
}

const originalFetch = global.fetch;
global.fetch = (input, init) => {
  const source = new URL(String(input));
  if (source.origin !== 'https://api.github.com') {
    throw new Error(`Integration gate refused outbound fetch to ${source.origin}`);
  }
  return originalFetch(new URL(source.pathname + source.search, target), init);
};
