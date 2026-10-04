'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { loadTrustedProxies } = require('../src/config');
const port = 29000 + Math.floor(Math.random() * 900);
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '',
    NV_ALPHA_ACCESS_MODE: 'off', NV_DEPLOYMENT_PROFILE: 'local', NV_TRUSTED_PROXIES: '', RENDER: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', value => { logs += value; });
child.stderr.on('data', value => { logs += value; });

async function main() {
  let proxyServer;
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      if (await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (let i = 0; i <= 300; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
        headers: { 'x-forwarded-for': `203.0.${Math.floor(i / 250)}.${i % 250 + 1}` }
      });
      await response.body.cancel();
      assert.strictEqual(response.status, i === 300 ? 429 : 401,
        `direct clients cannot rotate their rate-limit bucket with X-Forwarded-For (request ${i + 1})`);
    }

    assert.strictEqual(loadTrustedProxies('', {}), false);
    assert.strictEqual(loadTrustedProxies('', { RENDER: 'false' }), false);
    /* Render's ingress is the only route in and appends the hop it accepted; one hop, never more. */
    assert.strictEqual(loadTrustedProxies('', { RENDER: 'true' }), 1);
    assert.deepStrictEqual(loadTrustedProxies('10.0.0.0/8', { RENDER: 'true' }), ['10.0.0.0/8'], 'an explicit list wins');
    for (const invalid of ['1', 'true', '0.0.0.0/0', '::/0', 'example.com', '10.0.0.1/999', 'loopback,']) {
      assert.throws(() => loadTrustedProxies(invalid), /NV_TRUSTED_PROXIES/);
    }
    const app = express();
    app.set('trust proxy', loadTrustedProxies('127.0.0.1/32,::1/128'));
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    proxyServer = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const endpoint = `http://127.0.0.1:${proxyServer.address().port}`;
    const legitimate = await fetch(endpoint, { headers: { 'x-forwarded-for': '198.51.100.27' } });
    assert.strictEqual((await legitimate.json()).ip, '198.51.100.27');
    const shorterPath = await fetch(endpoint);
    assert.strictEqual((await shorterPath.json()).ip, '127.0.0.1');
    const spoofedPrefix = await fetch(endpoint, { headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.27' } });
    assert.strictEqual((await spoofedPrefix.json()).ip, '198.51.100.27', 'the closest untrusted hop bounds the chain');
    app.set('trust proxy', loadTrustedProxies('10.0.0.0/8'));
    const untrusted = await fetch(endpoint, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual((await untrusted.json()).ip, '127.0.0.1', 'a shorter direct path must ignore forwarding headers');
    app.set('trust proxy', loadTrustedProxies('', { RENDER: 'true' }));
    const behindRender = await fetch(endpoint, { headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.27' } });
    assert.strictEqual((await behindRender.json()).ip, '198.51.100.27', 'on Render only the hop its ingress appended is believed');
    console.log('proxy trust topology and direct-port rate-limit regressions passed');
  } finally {
    if (proxyServer) await new Promise(resolve => proxyServer.close(resolve));
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
