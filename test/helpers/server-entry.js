'use strict';
/*
 * The file a process starts to run the server. Tests that spawn the server name
 * it through here, so the monolith and the decomposed entry point -- natively,
 * or compiled into dist/server by scripts/build-server.js -- are driven by the
 * same tests while one replaces the other.
 *
 * NV_SERVER_RUNTIME=compiled runs the compiled tree; it must have been built.
 */
const fs = require('fs');
const path = require('path');

function serverEntry(root = path.resolve(__dirname, '..', '..')) {
  if (process.env.NV_SERVER_RUNTIME === 'compiled') {
    const compiledRoot = path.join(root, 'dist', 'server');
    const entry = [path.join(compiledRoot, 'apps', 'api', 'src', 'main.js'), path.join(compiledRoot, 'server.js')].find(fs.existsSync);
    if (!entry) throw new Error('NV_SERVER_RUNTIME=compiled, but the compiled server is not built: run npm run build:server');
    return entry;
  }
  const decomposed = path.join(root, 'apps', 'api', 'src', 'main.ts');
  if (fs.existsSync(decomposed)) return decomposed;
  return path.join(root, 'server.js');
}

/* What /api/version must say about the runtime the tests started: its mode, and in the compiled one its tree's digest. */
function serverIdentity(root = path.resolve(__dirname, '..', '..')) {
  const { describeServerRuntime } = require('../../src/server-runtime');
  const runtime = describeServerRuntime(process.env.NV_SERVER_RUNTIME === 'compiled' ? path.join(root, 'dist', 'server') : root);
  return runtime.buildSha256 ? { serverRuntime: runtime.mode, serverBuildSha256: runtime.buildSha256 } : { serverRuntime: runtime.mode };
}

module.exports = { serverEntry, serverIdentity };
