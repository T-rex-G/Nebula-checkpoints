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
 * and the origin the page's own requests carry, and the cookies the server
 * set, as a browser keeps them -- the provider session's and, invite-only,
 * the alpha's access session's. A body is sent as JSON, or as it is when it
 * is bytes, as the page sends a file. A redirect is answered, not followed.
 * signIn() signs in with a token the way the page does.
 */
function browser(application) {
  const jar = new Map();
  const header = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const cookie = header();
    const bytes = body instanceof Uint8Array;
    const response = await ownFetch(`${application.url}${pathname}`, {
      method,
      headers: {
        'x-nv': '1', origin: application.url,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': bytes ? 'application/octet-stream' : 'application/json' }),
        ...headers
      },
      body: body === undefined || bytes ? body : JSON.stringify(body),
      /* A redirect is the answer a test reads, never one it follows: past it may lie the internet. */
      redirect: 'manual'
    });
    /* A cookie set empty, or to expire now, is cleared, as a browser clears it. */
    for (const set of response.headers.getSetCookie()) {
      const [pair, ...attributes] = set.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attributes.some(attribute => /^\s*max-age=0\s*$/i.test(attribute));
      if (!value || expired) jar.delete(name); else jar.set(name, value);
    }
    return response;
  }
  /*
   * A request's headers alone, declaring a body of `length` bytes and sending
   * none of it: what the server answers before it has read anything. Resolves
   * with the status, or with null when nothing is answered within `waitMs`.
   */
  function declare(pathname, length, { method = 'POST', headers = {}, waitMs = 10000 } = {}) {
    const cookie = header();
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
    /* The Cookie header the page sends; set, it replaces every cookie the page holds. */
    get cookie() { return header(); },
    set cookie(value) {
      jar.clear();
      for (const pair of String(value).split(';')) {
        const at = pair.indexOf('=');
        if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    },
    /* One cookie's value, or '' when the page holds none by that name. */
    cookieValue: name => jar.get(name) || '',
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

/*
 * Names a test says resolve, resolved so in this process: the governance
 * service looks a webhook's destination up before it keeps the webhook. Every
 * other name is asked of the system, as it would be, so a name the test does
 * not stand in for fails as it would.
 */
function standInForNames(names) {
  const { promises } = require('node:dns');
  const { isIP } = require('node:net');
  const ownLookup = promises.lookup;
  promises.lookup = async (hostname, options = {}) => {
    if (!Object.hasOwn(names, hostname)) return ownLookup.call(promises, hostname, options);
    const addresses = names[hostname].map(address => ({ address, family: isIP(address) }));
    return options && options.all ? addresses : addresses[0];
  };
  return { restore() { promises.lookup = ownLookup; } };
}

/*
 * The guarded transport (apps/api/src/platform/network/guarded-fetch.ts)
 * stood in for, in this process: what the server reads and asks of a provider
 * through it rather than through fetch -- exposure scanning's repository
 * reads, a credential's verification, a readability probe. The transport
 * resolves a name to a public address before it connects, so each name given
 * resolves to the address given; its HTTPS requests are then answered here, by
 * route, as standInForOutbound answers fetch's, and a request no route matches
 * is answered 404. Nothing leaves the machine.
 */
function standInForGuardedTransport(routes, { names = {} } = {}) {
  const https = require('node:https');
  const { syncBuiltinESMExports } = require('node:module');
  const { PassThrough } = require('node:stream');
  const { EventEmitter } = require('node:events');
  const resolving = standInForNames(Object.fromEntries(Object.entries(names).map(([name, address]) => [name, [address]])));
  const ownRequest = https.request;
  const requests = [];
  https.request = (options, respond) => {
    const request = new EventEmitter();
    const chunks = [];
    request.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    request.setTimeout = () => request;
    request.destroy = () => request;
    request.end = body => {
      if (body != null) chunks.push(Buffer.from(body));
      const method = String(options.method || 'GET').toUpperCase();
      const href = `https://${options.hostname}${options.path || '/'}`;
      const authorization = Object.entries(options.headers || {}).find(([name]) => name.toLowerCase() === 'authorization');
      const sent = { method, url: href, authorization: authorization ? String(authorization[1]) : null, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(sent);
      const route = routes.find(([pattern]) => {
        const [routeMethod, routePattern] = pattern.split(' ');
        return routeMethod === method && new RegExp(routePattern).test(href);
      });
      const answer = route ? (typeof route[1] === 'function' ? route[1](href, sent) : route[1]) : { status: 404, body: { message: 'not stood in for' } };
      const { status = 200, body: answered = {}, headers = {} } = answer;
      const text = typeof answered === 'string';
      setImmediate(() => {
        const response = new PassThrough();
        response.statusCode = status;
        response.headers = { 'content-type': text ? 'text/plain' : 'application/json', ...headers };
        respond(response);
        response.end(Buffer.isBuffer(answered) ? answered : Buffer.from(text ? answered : JSON.stringify(answered)));
      });
      return request;
    };
    return request;
  };
  syncBuiltinESMExports();
  return {
    requests,
    restore() {
      https.request = ownRequest;
      syncBuiltinESMExports();
      resolving.restore();
    }
  };
}

module.exports = { composedApplication, applicationTree, browser, standInForOutbound, standInForNames, standInForGuardedTransport, bodyOf };
