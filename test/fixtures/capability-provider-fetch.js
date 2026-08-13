'use strict';

const dns = require('dns').promises;
const fs = require('fs');

const realFetch = global.fetch;
const fixtureLog = process.env.NV_CAPABILITY_FIXTURE_LOG;
const giteaOrigin = 'https://gitea.example';
const lfsObject = 'fixture bytes';
const lfsPointer = `version https://git-lfs.github.com/spec/v1
oid sha256:${'a'.repeat(64)}
size ${Buffer.byteLength(lfsObject)}
`;

dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function record(method, url) {
  if (fixtureLog) fs.appendFileSync(fixtureLog, `${method} ${url}\n`);
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== giteaOrigin && url.hostname !== 'github.com' && url.hostname !== 'codeload.github.com' &&
      url.hostname !== 'api.github.com') {
    return realFetch(input, options);
  }

  const method = String(options.method || 'GET').toUpperCase();
  record(method, url.toString());

  if (url.origin === giteaOrigin) {
    const route = url.pathname.replace(/^\/api\/v1/, '');
    if (method === 'GET' && route === '/repos/Acme/Demo/commits') {
      return json(200, [{
        sha: '1'.repeat(40),
        commit: {
          message: 'Qualified Gitea activity',
          author: { name: 'Fixture User', date: '2026-07-29T10:00:00.000Z' }
        }
      }]);
    }
    if (method === 'GET' && route === `/repos/Acme/Demo/commits/${'1'.repeat(40)}`) {
      return json(200, {
        sha: '1'.repeat(40),
        commit: {
          message: 'Qualified Gitea commit detail',
          author: { name: 'Fixture User', date: '2026-07-29T10:00:00.000Z' }
        },
        stats: { total: 1, additions: 1, deletions: 0 },
        files: [{
          filename: 'README.md',
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: '@@ fixture @@'
        }]
      });
    }
    if (method === 'GET' && route === '/repos/Acme/Demo/contents/large.bin') {
      return new Response(lfsPointer, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      });
    }
    return json(598, { message: `unavailable capability transport reached: ${method} ${route}` });
  }

  if (url.hostname === 'api.github.com' &&
      method === 'GET' && url.pathname === '/repos/Acme/Demo/contents/large.bin') {
    return new Response(lfsPointer, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    });
  }
  if (url.hostname === 'api.github.com' &&
      method === 'GET' && url.pathname === '/repos/Acme/Demo/zipball/main') {
    if (options.redirect !== 'manual' || options.headers.Authorization !== 'Bearer fixture-github-token') {
      throw new Error('GitHub archive API request must use an authenticated non-following redirect mode');
    }
    return new Response(null, {
      status: 302,
      headers: { location: 'https://codeload.github.com/Acme/Demo/legacy.zip/refs/heads/main' }
    });
  }
  if (url.hostname === 'codeload.github.com' &&
      method === 'GET' && url.pathname === '/Acme/Demo/legacy.zip/refs/heads/main') {
    if (options.redirect !== 'error' || options.headers.Authorization) {
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
