'use strict';
/*
 * Which server is running (src/server-runtime.js): the source natively, or the
 * tree compiled into dist/server. The mode is read from where the server runs,
 * the release fingerprint always names the source, and a compiled tree names
 * itself by the digest of its own bytes.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeServerRuntime, isCompiledRoot, serverBuildDigest } = require('../src/server-runtime');
const { serverEntry } = require('./helpers/server-entry');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-server-runtime-'));
try {
  const source = path.join(scratch, 'checkout');
  const compiled = path.join(source, 'dist', 'server');
  fs.mkdirSync(path.join(compiled, 'src'), { recursive: true });
  fs.writeFileSync(path.join(compiled, 'server.js'), 'one\n');
  fs.writeFileSync(path.join(compiled, 'src', 'a.js'), 'two\n');

  assert.deepEqual(describeServerRuntime(source), { mode: 'native-ts', serverRoot: source, sourceRoot: source, buildSha256: null });
  const runtime = describeServerRuntime(compiled);
  assert.equal(runtime.mode, 'compiled');
  assert.equal(runtime.sourceRoot, source, 'the compiled server names the source it was built from');
  assert.match(runtime.buildSha256, /^[0-9a-f]{64}$/);
  assert(Object.isFrozen(runtime));

  /* The digest is of the bytes and their paths: equal trees agree, any change to either is seen. */
  const before = serverBuildDigest(compiled);
  assert.equal(before, runtime.buildSha256);
  fs.writeFileSync(path.join(compiled, 'src', 'a.js'), 'two!\n');
  assert.notEqual(serverBuildDigest(compiled), before);
  fs.writeFileSync(path.join(compiled, 'src', 'a.js'), 'two\n');
  assert.equal(serverBuildDigest(compiled), before);
  fs.renameSync(path.join(compiled, 'src', 'a.js'), path.join(compiled, 'src', 'b.js'));
  assert.notEqual(serverBuildDigest(compiled), before);

  /* Only dist/server is the compiled tree: a directory merely named "server" is not. */
  assert.equal(isCompiledRoot(path.join(scratch, 'server')), false);
  assert.equal(isCompiledRoot(path.join(scratch, 'dist', 'servers')), false);

  /* The helper starts the tree the runtime names, and refuses a compiled run that was never built. */
  assert.equal(serverEntry(source), path.join(source, 'server.js'));
  process.env.NV_SERVER_RUNTIME = 'compiled';
  assert.equal(serverEntry(source), path.join(compiled, 'server.js'));
  assert.throws(() => serverEntry(path.join(scratch, 'elsewhere')), /not built/);
  delete process.env.NV_SERVER_RUNTIME;
} finally {
  delete process.env.NV_SERVER_RUNTIME;
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('server runtime tests passed');
