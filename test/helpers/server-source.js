'use strict';
/*
 * The server's composition root, as a list of its files.
 *
 * The root is apps/api/src/main.ts and the composition it calls in
 * apps/api/src/composition/ (server.js was the root until D13 replaced it).
 * The checks that read every source file for what it says -- the error codes,
 * the contracts, the provider-route inventory, the route surface -- take the
 * root's files from here, among all the others.
 *
 * Nothing here reads how the server is wired. D14 replaced every check that
 * did with one that asks the composed server how it behaves, or, for what no
 * request can show, with a rule over the root's syntax tree
 * (test/composition-root.test.js); test/composition-reads.test.js keeps it so.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPOSITION = path.join('apps', 'api', 'src', 'composition');

/* The root's files, relative to the tree: main.ts, then the composition's, in name order. */
function serverFiles(root = ROOT) {
  const composition = path.join(root, COMPOSITION);
  const parts = fs.existsSync(composition)
    ? fs.readdirSync(composition).filter(name => name.endsWith('.ts')).sort().map(name => path.posix.join('apps', 'api', 'src', 'composition', name))
    : [];
  return [path.posix.join('apps', 'api', 'src', 'main.ts'), ...parts];
}

module.exports = { serverFiles };
