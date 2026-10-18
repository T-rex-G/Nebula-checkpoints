'use strict';
/*
 * The file a process starts to run the server. Tests that spawn the server name
 * it through here, so the monolith and the decomposed entry point are driven by
 * the same tests while one replaces the other.
 */
const fs = require('fs');
const path = require('path');

function serverEntry(root = path.resolve(__dirname, '..', '..')) {
  const compiled = process.env.NV_SERVER_RUNTIME === 'compiled'
    ? path.join(root, 'dist', 'server', 'apps', 'api', 'src', 'main.js')
    : null;
  if (compiled) return compiled;
  const decomposed = path.join(root, 'apps', 'api', 'src', 'main.ts');
  if (fs.existsSync(decomposed)) return decomposed;
  return path.join(root, 'server.js');
}

module.exports = { serverEntry };
