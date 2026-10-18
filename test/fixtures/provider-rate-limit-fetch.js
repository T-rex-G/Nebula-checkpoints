'use strict';
/*
 * Synthetic GitHub answers for the rate-limit boundary. No request in this
 * process reaches an external provider. The repository name picks the answer:
 *
 *   primary    403, x-ratelimit-remaining: 0, reset 42 s from now
 *   secondary  403, retry-after: 30, the secondary-limit message
 *   too-many   429, retry-after: 7
 *   denied     403 with no limit headers: a permission refusal
 *
 * Every provider request is counted on stdout, so the test can tell that the
 * server answered without retrying on its own.
 */
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
async function providerFetch(input) {
  process.stdout.write('RATE_FIXTURE_REQUEST\n');
  const url = new URL(input);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/user') return json({ id: 41, login: 'tester', name: 'Rate Tester', avatar_url: '' });
  const match = /^\/repos\/acme\/([a-z-]+)(\/|$)/.exec(pathname);
  if (match) {
    const now = Math.floor(Date.now() / 1000);
    switch (match[1]) {
      case 'primary': return json({ message: 'API rate limit exceeded for user ID 41.' }, 403,
        { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now + 42) });
      case 'secondary': return json({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }, 403,
        { 'retry-after': '30' });
      case 'too-many': return json({ message: 'Too many requests' }, 429, { 'retry-after': '7' });
      case 'denied': return json({ message: 'Resource not accessible by personal access token' }, 403,
        { 'x-ratelimit-remaining': '4999' });
      default: break;
    }
  }
  throw new Error('Unexpected synthetic provider rate-limit request');
}
global.fetch = providerFetch;
