'use strict';
/*
 * Synthetic GitHub for a sign-in: the token's account, and nothing else. No
 * request in this process reaches an external provider; anything but /user is
 * named on stderr and refused, so a test sees what the server asked for.
 *
 * A token ending in "second" is a second GitHub account; any other token is
 * the first.
 */
const ACCOUNTS = Object.freeze({
  first: Object.freeze({ id: 77, login: 'disconnect-tester', name: 'Disconnect Tester', avatar_url: '' }),
  second: Object.freeze({ id: 78, login: 'second-tester', name: 'Second Tester', avatar_url: '' })
});
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
async function providerFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.pathname === '/user') {
    const authorization = new Headers(init.headers || (input && input.headers) || {}).get('authorization') || '';
    return json(/second$/.test(authorization) ? ACCOUNTS.second : ACCOUNTS.first);
  }
  process.stderr.write(`IDENTITY_FIXTURE_UNEXPECTED ${(init.method || 'GET').toUpperCase()} ${url.pathname}\n`);
  return json({ message: 'Not Found' }, 404);
}
global.fetch = providerFetch;
