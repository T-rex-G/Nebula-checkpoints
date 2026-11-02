'use strict';
/*
 * The composed application, built in a test's own process: the function
 * main.ts listens with (apps/api/src/composition/application.ts), listening
 * on a port the system picks. A test asks it how the server behaves -- what a
 * service it built does, how a route it registered answers -- rather than
 * reading how the source is written.
 *
 * The application reads process.env, as the server does, so the environment
 * it is built from is this process's own: the helper replaces it with the one
 * given, keeping the path, before anything is built. Each test program is a
 * process of its own, so nothing leaks into another. With
 * NV_SERVER_RUNTIME=compiled it builds the compiled tree's application, as
 * test/helpers/server-entry.js starts the compiled server.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/* The tree the application runs from, and its application module, in the runtime under test. */
function applicationTree(root = ROOT) {
  if (process.env.NV_SERVER_RUNTIME === 'compiled') {
    const tree = path.join(root, 'dist', 'server');
    const module = path.join(tree, 'apps', 'api', 'src', 'composition', 'application.js');
    if (!fs.existsSync(module)) throw new Error('NV_SERVER_RUNTIME=compiled, but the compiled server is not built: run npm run build:server');
    return { tree, module };
  }
  return { tree: root, module: path.join(root, 'apps', 'api', 'src', 'composition', 'application.ts') };
}

async function composedApplication(environment, { listen = true, root = ROOT } = {}) {
  const { tree, module } = applicationTree(root);
  const runtime = process.env.NV_SERVER_RUNTIME;
  for (const name of Object.keys(process.env)) if (name !== 'PATH') delete process.env[name];
  Object.assign(process.env, environment, runtime ? { NV_SERVER_RUNTIME: runtime } : {});
  const express = require('express');
  const { registerApplication } = require(module);
  const app = express();
  let server = null;
  const composed = registerApplication(app, tree, { httpServer: () => server });
  if (listen) {
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  return {
    ...composed,
    app,
    url: server ? `http://127.0.0.1:${server.address().port}` : null,
    /*
     * Everything the application holds open, closed in the order the server's
     * own shutdown closes it: the job queues, the workers' work, the server and
     * its connections when it listens, then the database pool.
     */
    async close() {
      composed.records.jobs.site.close();
      composed.records.jobs.rendered.close();
      composed.core.codeAudit.jobs.close();
      await Promise.all([composed.core.governance.stop(), composed.core.exposure.stop()]);
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await composed.core.database.close();
    }
  };
}

/* The process's own fetch, before any test stands in for GitHub. */
const ownFetch = globalThis.fetch;

/*
 * A response's body, read as JSON. A body that is not JSON comes back as its
 * first words, so a check that fails says what was answered instead of failing
 * to read it.
 */
async function bodyOf(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { notJson: text.slice(0, 120) };
  }
}

/*
 * A page on the composed application: every request carries the app header
 * and the origin the page's own requests carry, and the session cookie the
 * server last set. A body is sent as JSON, or as it is when it is bytes, as
 * the page sends a file. signIn() signs in with a token the way the page does.
 */
function browser(application) {
  let cookie = '';
  async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const bytes = body instanceof Uint8Array;
    const response = await ownFetch(`${application.url}${pathname}`, {
      method,
      headers: {
        'x-nv': '1', origin: application.url,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': bytes ? 'application/octet-stream' : 'application/json' }),
        ...headers
      },
      body: body === undefined || bytes ? body : JSON.stringify(body)
    });
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(';')[0];
      if (pair.startsWith('nv_session=')) cookie = pair === 'nv_session=' ? '' : pair;
    }
    return response;
  }
  /*
   * A request's headers alone, declaring a body of `length` bytes and sending
   * none of it: what the server answers before it has read anything. Resolves
   * with the status, or with null when nothing is answered within `waitMs`.
   */
  function declare(pathname, length, { method = 'POST', headers = {}, waitMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (outcome, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.destroy();
        outcome(value);
      };
      const pending = http.request(`${application.url}${pathname}`, {
        method,
        headers: {
          'x-nv': '1', origin: application.url,
          ...(cookie ? { cookie } : {}),
          'content-type': 'application/octet-stream', 'content-length': String(length),
          ...headers
        }
      }, response => {
        response.resume();
        settle(resolve, response.statusCode);
      });
      const timer = setTimeout(() => settle(resolve, null), waitMs);
      pending.on('error', error => settle(reject, error));
      pending.flushHeaders();
    });
  }
  return {
    request,
    declare,
    get cookie() { return cookie; },
    set cookie(value) { cookie = value; },
    signIn: token => request('/api/login', { method: 'POST', body: { token } }),
    async csrf() {
      const answer = await request('/api/security/csrf');
      return (await answer.json()).token;
    }
  };
}

/*
 * What lies past this machine -- GitHub, a font host, a CDN -- as a test
 * describes it: each route answers what the test says, anything else is
 * answered 404, and every request that leaves the application is recorded.
 * Requests to this machine -- the application itself -- pass through, so a
 * stand-in can be put in place before the application is built, as one must
 * be for a service that keeps the fetch it was built with. restore() puts the
 * process's fetch back.
 */
function standInForOutbound(routes) {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(href)) return ownFetch(url, options);
    const method = String(options.method || 'GET').toUpperCase();
    requests.push({ method, url: href, authorization: new Headers(options.headers || {}).get('authorization'), body: options.body });
    for (const [pattern, answer] of routes) {
      const [routeMethod, routePattern] = pattern.split(' ');
      if (routeMethod === method && new RegExp(routePattern).test(href)) {
        const { status = 200, body = {}, headers = {} } = typeof answer === 'function' ? answer(href, options) : answer;
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
      }
    }
    return new Response(JSON.stringify({ message: 'not stood in for' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { requests, restore() { globalThis.fetch = ownFetch; } };
}

module.exports = { composedApplication, applicationTree, browser, standInForOutbound, bodyOf };
