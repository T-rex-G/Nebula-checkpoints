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
    /* Everything the application holds open: its job queues and, when it listens, the server and its connections. */
    async close() {
      composed.records.jobs.site.close();
      composed.records.jobs.rendered.close();
      composed.core.codeAudit.jobs.close();
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  };
}

module.exports = { composedApplication, applicationTree };
