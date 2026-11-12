'use strict';
/*
 * The server never reads a request whose framing could be read two ways.
 *
 * Where one request ends and the next begins is decided by Node's HTTP
 * parser before any route or guard runs. A proxy in front -- Render's edge in
 * production -- decides it too, and where the two disagree a second request
 * can travel hidden inside the body of the first, past every check the proxy
 * makes (request smuggling). The server never turns on Node's lenient parser,
 * so each framing below is refused; this test holds that on whatever runtime
 * the project pins, so a Node update that loosened the parser would fail here
 * before it shipped.
 *
 * Every request is followed, on the same connection and in the same write, by
 * a request for /healthz, whose answer names the process's boot. A refused
 * request must leave that hidden request unanswered and the connection
 * closed; the same request framed correctly is answered, which shows the
 * hidden one would have been seen.
 */
const { serverEntry } = require('./helpers/server-entry');
const { freePort } = require('./helpers/free-port');

const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = freePort();
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

const TARGET = '/framing-probe';
const HIDDEN = 'GET /healthz HTTP/1.1\r\nHost: nebula.test\r\nConnection: close\r\n\r\n';
const HIDDEN_ANSWER = '"bootId"';

const post = (headers, body) => `POST ${TARGET} HTTP/1.1\r\nHost: nebula.test\r\n${headers}\r\n${body}`;
const get = headers => `GET ${TARGET} HTTP/1.1\r\nHost: nebula.test\r\n${headers}\r\n`;

/*
 * Framing the parser refuses as soon as it reads the headers: no route runs,
 * and the one answer is the parser's 400. These are the classic ways to make
 * a proxy and a server disagree on a request's length.
 */
const REFUSED_IN_THE_HEADERS = [
  ['a length given both as chunks and as a Content-Length', post('Transfer-Encoding: chunked\r\nContent-Length: 4\r\n', '0\r\n\r\n')],
  ['two different Content-Lengths', post('Content-Length: 1\r\nContent-Length: 2\r\n', 'xy')],
  ['a signed Content-Length', post('Content-Length: +1\r\n', 'x')],
  ['a negative Content-Length', post('Content-Length: -1\r\n', 'x')],
  ['chunked that is not the last coding', post('Transfer-Encoding: chunked, identity\r\n', '0\r\n\r\n')],
  ['chunked followed by a second Transfer-Encoding', post('Transfer-Encoding: chunked\r\nTransfer-Encoding: identity\r\n', '0\r\n\r\n')],
  ['an empty Transfer-Encoding', post('Transfer-Encoding: \r\n', '0\r\n\r\n')],
  ['a Transfer-Encoding that ends in a comma', post('Transfer-Encoding: chunked,\r\n', '0\r\n\r\n')],
  ['a Transfer-Encoding folded onto the line before', post('X-Note: a\r\n Transfer-Encoding: chunked\r\n', '0\r\n\r\n')],
  ['whitespace between Transfer-Encoding and its colon', post('Transfer-Encoding : chunked\r\n', '0\r\n\r\n')],
  ['lines ended by a bare line feed', `GET ${TARGET} HTTP/1.1\nHost: nebula.test\n\n`],
  ['a bare carriage return inside a header', get('X-Note: a\rb\r\n')],
  ['a NUL inside a header', get('X-Note: a\u0000b\r\n')],
  ['a control character inside a header', get('X-Note: a\u0001b\r\n')],
  ['a NUL inside the path', `GET /framing\u0000-probe HTTP/1.1\r\nHost: nebula.test\r\n\r\n`],
  ['an HTTP/1.1 request without a Host', `GET ${TARGET} HTTP/1.1\r\nX-Note: a\r\n\r\n`]
];

/*
 * Framing the parser refuses only when it reaches the body. The route may
 * answer first, before it reads a body it does not want; what may never
 * happen is that the bytes after the error are read as a request of their own.
 */
const REFUSED_IN_THE_BODY = [
  ['a quoted transfer coding', post('Transfer-Encoding: "chunked"\r\n', '0\r\n\r\n')],
  ['chunks in an HTTP/1.0 request', `POST ${TARGET} HTTP/1.0\r\nHost: nebula.test\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`],
  ['a chunk size past 64 bits', post('Transfer-Encoding: chunked\r\n', 'ffffffffffffffffff\r\nx\r\n0\r\n\r\n')],
  ['a chunk size that is not hexadecimal', post('Transfer-Encoding: chunked\r\n', '1g\r\nx\r\n0\r\n\r\n')],
  ['chunk lines ended by a bare line feed', post('Transfer-Encoding: chunked\r\n', '1\nx\n0\n\n')],
  ['a line feed inside a chunk extension', post('Transfer-Encoding: chunked\r\n', '1;a\nx\r\nx\r\n0\r\n\r\n')],
  ['chunk data longer than its size', post('Transfer-Encoding: chunked\r\n', '1\r\nxy0\r\n\r\n')]
];

/* The same requests framed correctly: each is answered, and so is the request after it. */
const ANSWERED = [
  ['a body in chunks', post('Transfer-Encoding: chunked\r\n', '1\r\nx\r\n0\r\n\r\n')],
  ['a body in chunks with a trailer', post('Transfer-Encoding: chunked\r\n', '1\r\nx\r\n0\r\nX-Trailer: a\r\n\r\n')],
  ['a body of a stated length', post('Content-Length: 1\r\n', 'x')],
  ['no body', get('')]
];

/* Writes a request and the hidden one after it in one segment; reads everything until the server closes. */
function exchange(raw) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    const received = [];
    let settled = false;
    const done = closed => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const text = Buffer.concat(received).toString('latin1');
      resolve({ text, closed, statuses: [...text.matchAll(/^HTTP\/1\.1 (\d{3}) /gm)].map(match => match[1]) });
    };
    socket.setTimeout(5000, () => done(false));
    socket.on('data', chunk => received.push(chunk));
    socket.on('close', () => done(true));
    socket.on('error', () => done(true));
    socket.write(Buffer.from(raw + HIDDEN, 'latin1'));
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

(async () => {
  try {
    await waitForServer();
    for (const [label, raw] of REFUSED_IN_THE_HEADERS) {
      const answer = await exchange(raw);
      assert(answer.closed, `${label}: the server waited for more of a request it should have refused`);
      assert.deepStrictEqual(answer.statuses, ['400'], `${label}: refused by the parser, with its 400 and nothing else (${JSON.stringify(answer.text.slice(0, 200))})`);
      assert(!answer.text.includes(HIDDEN_ANSWER), `${label}: the request hidden behind it was answered`);
    }
    for (const [label, raw] of REFUSED_IN_THE_BODY) {
      const answer = await exchange(raw);
      assert(answer.closed, `${label}: the server waited for more of a request it should have refused`);
      assert(!answer.text.includes(HIDDEN_ANSWER), `${label}: the request hidden behind it was answered (${JSON.stringify(answer.statuses)})`);
    }
    for (const [label, raw] of ANSWERED) {
      const answer = await exchange(raw);
      assert(answer.closed, `${label}: the server did not close after the request that asked it to`);
      assert.strictEqual(answer.statuses.length, 2, `${label}: both requests are answered (${JSON.stringify(answer.statuses)})`);
      assert(answer.text.includes(HIDDEN_ANSWER), `${label}: the request after a well-framed one is answered`);
    }
    assert.strictEqual(child.exitCode, null, `the server is still running after every framing\n${logs}`);
    assert(await healthy(), 'the server still answers after every framing');
    console.log(`http framing server tests passed (${REFUSED_IN_THE_HEADERS.length + REFUSED_IN_THE_BODY.length} framings refused, ${ANSWERED.length} answered)`);
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
})();
