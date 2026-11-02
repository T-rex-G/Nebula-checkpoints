'use strict';
/*
 * The file a process starts to run the server: apps/api/src/main.ts as
 * written, or, with NV_SERVER_RUNTIME=compiled, what scripts/build-server.js
 * emitted for it into dist/server (ADR-088), which must have been built.
 * Tests that spawn the server name it through here, so the same tests drive
 * both runtimes.
 */
const fs = require('fs');
const path = require('path');

function serverEntry(root = path.resolve(__dirname, '..', '..')) {
  if (process.env.NV_SERVER_RUNTIME === 'compiled') {
    const entry = path.join(root, 'dist', 'server', 'apps', 'api', 'src', 'main.js');
    if (!fs.existsSync(entry)) throw new Error('NV_SERVER_RUNTIME=compiled, but the compiled server is not built: run npm run build:server');
    return entry;
  }
  return path.join(root, 'apps', 'api', 'src', 'main.ts');
}

/* What /api/version must say about the runtime the tests started: its mode, and in the compiled one its tree's digest. */
function serverIdentity(root = path.resolve(__dirname, '..', '..')) {
  const { describeServerRuntime } = require('../../apps/api/src/platform/release/server-runtime.ts');
  const runtime = describeServerRuntime(process.env.NV_SERVER_RUNTIME === 'compiled' ? path.join(root, 'dist', 'server') : root);
  return runtime.buildSha256 ? { serverRuntime: runtime.mode, serverBuildSha256: runtime.buildSha256 } : { serverRuntime: runtime.mode };
}

module.exports = { serverEntry, serverIdentity };
