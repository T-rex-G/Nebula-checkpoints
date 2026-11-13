'use strict';
/*
 * A port for a test that starts a server: below the kernel's ephemeral range,
 * and held by no listener when it is handed out.
 *
 * Below the ephemeral range (32768 and up on Linux), because a port there can
 * be the local end of an outbound connection -- the tests' own PostgreSQL
 * clients among them -- and the server then exits on EADDRINUSE half a second
 * in (test/test-matrix.test.js holds this helper to that).
 *
 * Held by no listener, because the tests used to draw a random port from
 * ranges of their own, and the ranges overlap. When the port drawn was still
 * held by a server another test had not finished stopping, the wait for
 * /healthz was satisfied by that server, and the assertions ran against a
 * server the test had not configured: a failure in a tenth of a second that
 * said nothing about the code. Each candidate is bound before it is handed
 * out, on every interface as the server binds it, and another is drawn when
 * one is taken.
 *
 * Synchronous, so a test keeps its `const port` beside the rest of its setup.
 */
const { execFileSync } = require('child_process');

const PORT_RANGE = Object.freeze({ low: 16384, high: 32767 });

const PROBE = `
const net = require('net');
const [low, high] = process.argv.slice(1).map(Number);
let tries = 0;
(function attempt() {
  if (++tries > 64) { process.exitCode = 1; return; }
  const port = low + Math.floor(Math.random() * (high - low + 1));
  const server = net.createServer();
  server.once('error', attempt);
  server.listen(port, () => { process.stdout.write(String(port)); server.close(); });
})();
`;

/* A port from low to high that no listener holds; test-matrix.test.js names a one-port range to check a held one is refused. */
function findFreePort(low, high) {
  let output = '';
  try {
    output = execFileSync(process.execPath, ['-e', PROBE, String(low), String(high)], { encoding: 'utf8' });
  } catch { /* every candidate drawn was held */ }
  const port = Number(output);
  if (!output || !Number.isInteger(port) || port < low || port > high) {
    throw new Error(`no free port was found from ${low} to ${high}: ${JSON.stringify(output)}`);
  }
  return port;
}

function freePort() {
  return findFreePort(PORT_RANGE.low, PORT_RANGE.high);
}

module.exports = { freePort, findFreePort, PORT_RANGE };
