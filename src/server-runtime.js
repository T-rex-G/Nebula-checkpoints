'use strict';

/*
 * Which server is running, and from what (ADR-088).
 *
 * Natively the server runs its source as tracked: the TypeScript contracts by
 * type stripping, the rest as written. The fallback runs the tree
 * scripts/build-server.js compiles from that source into dist/server, laid out
 * as the source is so every path a module reads beside itself still resolves.
 *
 * Both modes name what they run from bytes read at startup, never from a
 * digest the build wrote down. The release fingerprint is always the source
 * tree's: the compiled server reads the checkout it was built in, two levels
 * above it. A compiled server also names its own tree (serverBuildSha256), so
 * qualification can require the very build it measured.
 */

const path = require('path');
const { directoryDigest } = require('./directory-digest');

const COMPILED_DIRECTORY = path.join('dist', 'server');

function isCompiledRoot(serverRoot) {
  const root = path.resolve(serverRoot);
  return path.basename(root) === path.basename(COMPILED_DIRECTORY) &&
    path.basename(path.dirname(root)) === path.dirname(COMPILED_DIRECTORY);
}

function serverBuildDigest(compiledRoot) {
  return directoryDigest(compiledRoot, 'the compiled server');
}

function describeServerRuntime(serverRoot) {
  const root = path.resolve(serverRoot);
  if (!isCompiledRoot(root)) {
    return Object.freeze({ mode: 'native-ts', serverRoot: root, sourceRoot: root, buildSha256: null });
  }
  return Object.freeze({
    mode: 'compiled',
    serverRoot: root,
    sourceRoot: path.resolve(root, '..', '..'),
    buildSha256: serverBuildDigest(root)
  });
}

module.exports = Object.freeze({ COMPILED_DIRECTORY, describeServerRuntime, isCompiledRoot, serverBuildDigest });
