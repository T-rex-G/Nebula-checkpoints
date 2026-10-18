'use strict';

const fs = require('fs');

const fixtureLog = process.env.NV_CAPABILITY_FIXTURE_LOG;
const lfsObject = 'fixture bytes';
const lfsPointer = `version https://git-lfs.github.com/spec/v1
oid sha256:${'a'.repeat(64)}
size ${Buffer.byteLength(lfsObject)}
`;


function authorizationHeader(options) {
  return new Headers(options.headers || {}).get('authorization');
}

function record(method, url, options) {
  if (fixtureLog) {
    fs.appendFileSync(fixtureLog, `${JSON.stringify({
      method,
      url,
      hasAuthorization: authorizationHeader(options) !== null
    })}\n`);
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'github.com' && url.hostname !== 'codeload.github.com' &&
      url.hostname !== 'api.github.com') {
    throw new Error('Unexpected provider transport in GitHub-only fixture');
  }

  const method = String(options.method || 'GET').toUpperCase();
  record(method, url.toString(), options);

  if (url.hostname === 'api.github.com' &&
      method === 'GET' && url.pathname === '/repos/Acme/Demo/contents/large.bin') {
    return new Response(lfsPointer, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    });
  }
  if (url.hostname === 'api.github.com' &&
      method === 'GET' && url.pathname === '/repos/Acme/Demo/zipball/main') {
    if (options.redirect !== 'manual' || authorizationHeader(options) !== 'Bearer fixture-github-token') {
      throw new Error('GitHub archive API request must use an authenticated non-following redirect mode');
    }
    return new Response(null, {
      status: 302,
      headers: { location: 'https://codeload.github.com/Acme/Demo/legacy.zip/refs/heads/main' }
    });
  }
  if (url.hostname === 'codeload.github.com' &&
      method === 'GET' && url.pathname === '/Acme/Demo/legacy.zip/refs/heads/main') {
    if (options.redirect !== 'error' || authorizationHeader(options) !== null) {
      throw new Error('Codeload archive request must reject redirects and omit provider credentials');
    }
    return new Response('zip-fixture', {
      status: 200,
      headers: { 'content-type': 'application/zip' }
    });
  }
  if (url.hostname === 'github.com' &&
      method === 'POST' && url.pathname === '/Acme/Demo.git/info/lfs/objects/batch') {
    if (options.redirect !== 'error') throw new Error('LFS batch requests must reject redirects');
    return json(200, {
      objects: [{
        oid: 'a'.repeat(64),
        size: Buffer.byteLength(lfsObject),
        actions: { download: { href: 'https://github.com/fixture-lfs-object', header: {} } }
      }]
    });
  }
  if (url.hostname === 'github.com' &&
      method === 'GET' && url.pathname === '/fixture-lfs-object') {
    return new Response(lfsObject, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    });
  }

  return json(599, { message: `cross-provider transport reached: ${method} ${url.pathname}` });
};
