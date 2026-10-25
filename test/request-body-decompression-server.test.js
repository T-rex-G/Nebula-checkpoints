'use strict';
/*
 * A compressed request body cannot take the server down.
 *
 * The body parsers inflate a body sent with `Content-Encoding: gzip` (or
 * deflate) before any route or session check runs. A body made of one valid
 * compressed frame followed by trailing bytes decodes, and the request is
 * answered; then the trailing bytes reach the finished decoder, which emits an
 * error nothing listens for, and in body-parser before 1.20.9 that error was
 * an uncaught exception that ended the process (GHSA-27r3-jxmh-p828). One
 * unauthenticated request was enough. Both parsers the server mounts are
 * driven: the JSON parser every route stands behind, and the raw parser of the
 * GitHub webhook receiver, on an API path with the app header an attacker
 * can send as easily as the page does, and on a path outside the API. After
 * each, the same process must still answer.
 */
const { serverEntry } = require('./helpers/server-entry');

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 16000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [serverEntry()], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    SESSION_SECRET: crypto.randomBytes(40).toString('hex'),
    DATABASE_URL: '',
    NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

/*
 * One request on its own connection, its body written in parts with a pause
 * between them, answered with its status or the error that ended it. The
 * pause is what the attack needs: the decoder finishes on the first part, and
 * only then do the bytes after it arrive.
 */
function post(pathname, headers, parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  return new Promise(resolve => {
    let settled = false;
    const done = outcome => { if (!settled) { settled = true; resolve(outcome); } };
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { ...headers, 'content-length': length, connection: 'close' } }, response => {
      response.resume();
      response.on('end', () => done({ status: response.statusCode }));
    });
    request.on('error', error => done({ error: error.code || error.message }));
    (async () => {
      for (const [index, part] of parts.entries()) {
        if (index) await new Promise(next => setTimeout(next, 250));
        if (!request.destroyed) request.write(part);
      }
      request.end();
    })();
  });
}

async function healthy() {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early\n${logs}`);
    if (await healthy()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready\n${logs}`);
}

/*
 * A valid gzip frame of a small JSON body, a zero byte that ends the gzip
 * member, then 100 KB that arrive in later segments, after the decoder has
 * finished: the shape that ended the process before body-parser 1.20.9.
 */
const frame = zlib.gzipSync(Buffer.from('{"probe":true}'));
const payload = [Buffer.concat([frame, Buffer.from([0x00]), Buffer.alloc(100 * 1024, 0x58)])];

(async () => {
  try {
    await waitForServer();
    for (const [label, pathname, extra] of [
      ['the JSON parser behind the API', '/api/request-body-probe', { 'x-nv': '1' }],
      ['the JSON parser outside the API', '/request-body-probe', {}],
      ['the webhook parser', '/hooks/github/request-body-probe', {}]
    ]) {
      const answer = await post(pathname, { 'content-type': 'application/json', 'content-encoding': 'gzip', ...extra }, payload);
      /* Whatever the request is answered with, the process that answered it must still be there. */
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.strictEqual(child.exitCode, null, `${label}: a compressed body with trailing bytes ended the server (${JSON.stringify(answer)})\n${logs}`);
      assert(await healthy(), `${label}: the server stopped answering after a compressed body with trailing bytes\n${logs}`);
    }
    /* The ordinary case still works: a compressed body without trailing bytes is inflated and parsed. */
    const plain = await post('/api/request-body-probe', { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-nv': '1' }, [frame]);
    assert(plain.status >= 200 && plain.status < 500, `a well-formed compressed body is answered, not refused by the parser (${JSON.stringify(plain)})`);
    console.log('request body decompression server tests passed');
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
})();
