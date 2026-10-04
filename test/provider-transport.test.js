'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { createProviderTransport } = require('../src/provider-transport');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-provider-tls-'));
  let server;
  let requests = [];
  try {
    const keyPath = path.join(directory, 'key.pem');
    const certPath = path.join(directory, 'cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=provider.fixture.test',
      '-addext', 'subjectAltName=DNS:provider.fixture.test'], { stdio: 'ignore' });
    assert.strictEqual(generated.status, 0, 'openssl must create the ephemeral TLS fixture');
    const cert = fs.readFileSync(certPath);
    server = https.createServer({ key: fs.readFileSync(keyPath), cert }, (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
          token: req.headers['private-token'], body: Buffer.concat(chunks) });
        if (req.url === '/redirect') { res.writeHead(302, { location: 'https://elsewhere.fixture.test/' }); res.end(); }
        else if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(zlib.gzipSync('decoded response')); }
        else if (req.url === '/large') res.end('x'.repeat(100));
        else if (req.url === '/headers-only') { res.writeHead(200); res.flushHeaders(); }
        else if (req.method === 'HEAD') res.end();
        else res.end('ok');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    let lookups = 0, connections = 0;
    const bridge = (options, callback) => {
      connections++;
      assert.strictEqual(options.rejectUnauthorized, true);
      assert.strictEqual(options.servername, 'provider.fixture.test');
      assert.strictEqual(options.agent, false);
      // Inspect the actual socket lookup callback before the test-only bridge
      // directs that socket to the disposable TLS service. It must be the
      // validated address, without another resolver call.
      options.lookup('provider.fixture.test', { all: true }, (error, answers) => {
        assert.ifError(error);
        assert.deepStrictEqual(answers, [{ address: '93.184.216.34', family: 4 }]);
      });
      return https.request({ ...options, hostname: '127.0.0.1', port, lookup: undefined, ca: cert }, callback);
    };
    const transport = createProviderTransport({
      lookup: async () => { lookups++; return lookups === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; },
      request: bridge
    });
    const binary = Buffer.from([0, 1, 255, 42]);
    const result = await transport('https://provider.fixture.test/git-receive-pack', {
      method: 'POST', headers: { Authorization: 'synthetic-only', 'content-type': 'application/x-git-receive-pack-request' }, body: binary
    });
    assert.strictEqual(await result.text(), 'ok');
    assert.strictEqual(lookups, 1, 'a request must not resolve again after validating DNS');
    assert.deepStrictEqual(requests[0], { method: 'POST', url: '/git-receive-pack', authorization: 'synthetic-only', token: undefined, body: binary });
    await assert.rejects(transport('https://provider.fixture.test/api/v4/user', {
      headers: { 'PRIVATE-TOKEN': 'synthetic-only' }
    }), error => error.code === 'PROVIDER_ADDRESS_BLOCKED');
    assert.strictEqual(requests.length, 1, 'a subsequent private DNS answer must deliver no credential or request');
    assert.strictEqual(connections, 1);

    const valid = createProviderTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: bridge });
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const response = await valid('https://provider.fixture.test/api/v4/projects/one?ref=main', {
        method, headers: { 'PRIVATE-TOKEN': 'synthetic-token' }, ...(method !== 'GET' ? { body: '{"content":"Ω"}' } : {})
      });
      assert.strictEqual(await response.text(), 'ok');
      assert.strictEqual(requests.at(-1).method, method);
      assert.strictEqual(requests.at(-1).token, 'synthetic-token');
      assert.strictEqual(requests.at(-1).url, '/api/v4/projects/one?ref=main');
    }
    const decompressed = await valid('https://provider.fixture.test/gzip');
    assert.strictEqual(await decompressed.text(), 'decoded response');
    assert.strictEqual(decompressed.headers.get('content-encoding'), null);
    assert.strictEqual(decompressed.headers.get('content-length'), null);
    await assert.rejects(valid('https://provider.fixture.test/redirect'), error => error.code === 'PROVIDER_REDIRECT_BLOCKED');
    await assert.rejects(async () => (await valid('https://provider.fixture.test/large', { maxResponseBytes: 32 })).text(),
      error => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
    await assert.rejects(async () => (await valid('https://provider.fixture.test/headers-only', {}, 150)).text(),
      error => error.code === 'PROVIDER_REQUEST_TIMEOUT');
    const noTrust = createProviderTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (options, callback) => https.request({ ...options, hostname: '127.0.0.1', port, lookup: undefined }, callback) });
    await assert.rejects(noTrust('https://provider.fixture.test/'), error => error.code === 'PROVIDER_CONNECTION_FAILED');
    const deniedBefore = requests.length;
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:7f00:1', '2002:7f00:1::']) {
      const denied = createProviderTransport({ lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }], request: bridge });
      await assert.rejects(denied('https://provider.fixture.test/'), error => error.code === 'PROVIDER_ADDRESS_BLOCKED');
    }
    assert.strictEqual(requests.length, deniedBefore);
    await assert.rejects(valid('http://provider.fixture.test/'));
    await assert.rejects(valid('https://user:pass@provider.fixture.test/'));
    await assert.rejects(valid('https://provider.fixture.test/', { headers: { host: 'other.fixture.test' } }));
    await assert.rejects(valid('https://provider.fixture.test/', { redirect: 'follow' }));
    console.log('provider TLS, DNS pinning/rebinding, methods, binary writes, redirects, bounds and deadline tests passed');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
