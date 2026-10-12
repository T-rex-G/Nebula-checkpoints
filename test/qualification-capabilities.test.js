'use strict';

/*
 * The one exception to "only what is Supported is served": a qualification
 * deployment serving a capability that awaits the hosted proof only it can
 * give. What it may name, what it refuses to start with, that it is said in
 * /api/config, and that it changes the gate for that feature and no other.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { AWAITING_HOSTED_PROOF, loadQualificationCapabilities } = require('../src/qualification-capabilities');
const { loadCapabilityDocument, assertCapabilityAvailable } = require('../src/capability-registry');

const root = path.join(__dirname, '..');
const document = loadCapabilityDocument(path.join(root, 'config', 'public-alpha-capabilities.json'));
const github = { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', authMethod: 'token', tokenKind: 'fine-grained' };

/* ---- What may be named ---------------------------------------------------- */
assert.deepStrictEqual([...AWAITING_HOSTED_PROOF], ['live-events'], 'only a capability that needs a reachable deployment may be served ahead of its proof');
assert.deepStrictEqual([...loadQualificationCapabilities({}, document)], []);
assert.deepStrictEqual([...loadQualificationCapabilities({ NV_QUALIFICATION_CAPABILITIES: '  ' }, document)], []);
assert.deepStrictEqual([...loadQualificationCapabilities({ NV_QUALIFICATION_CAPABILITIES: 'live-events, live-events' }, document)], ['live-events']);
for (const named of ['notifications', 'repository.create', 'pulls.read', 'everything', 'live-events,notifications']) {
  assert.throws(() => loadQualificationCapabilities({ NV_QUALIFICATION_CAPABILITIES: named }, document), /may name only live-events/, `${named} is not awaiting hosted proof`);
}
/* Once live events are promoted, a deployment still naming them is told to stop. */
const promoted = JSON.parse(JSON.stringify(document));
promoted.providers.github['hosted-alpha']['live-events'][0] = 'Supported';
assert.throws(() => loadQualificationCapabilities({ NV_QUALIFICATION_CAPABILITIES: 'live-events' }, promoted), /no longer awaiting qualification/);

/* ---- The exception, and only it ------------------------------------------- */
assert.throws(() => assertCapabilityAvailable(document, { ...github, feature: 'live-events' }), error => error.code === 'PROVIDER_CAPABILITY_EXPERIMENTAL');
assert.strictEqual(assertCapabilityAvailable(document, { ...github, feature: 'live-events' }, { qualification: ['live-events'] }).status, 'Experimental',
  'served, and still described as Experimental');
assert.throws(() => assertCapabilityAvailable(document, { ...github, tokenKind: 'classic', feature: 'notifications' }, { qualification: ['live-events'] }),
  error => error.code === 'PROVIDER_CAPABILITY_EXPERIMENTAL', 'naming one feature serves no other');
assert.strictEqual(assertCapabilityAvailable(document, { ...github, feature: 'pulls.read' }, { qualification: ['live-events'] }).status, 'Supported');

/* ---- A real server ------------------------------------------------------- */
function start(env) {
  const port = 24000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['-r', './test/fixtures/provider-stream-fetch.js', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '', NV_ALPHA_ACCESS_MODE: 'off', NV_DEPLOYMENT_PROFILE: 'local',
      SESSION_SECRET: crypto.randomBytes(40).toString('hex'), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  return { child, origin: `http://127.0.0.1:${port}`, logs: () => logs };
}
async function ready(server) {
  const until = Date.now() + 10000;
  for (;;) {
    if (server.child.exitCode !== null) return false;
    try { const response = await fetch(`${server.origin}/healthz`, { signal: AbortSignal.timeout(2000) }); await response.body.cancel(); if (response.ok) return true; } catch {}
    if (Date.now() > until) throw new Error(`server did not start\n${server.logs()}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function stop(server) {
  if (server.child.exitCode === null) { server.child.kill('SIGTERM'); await new Promise(resolve => server.child.once('exit', resolve)); }
}

(async () => {
  /* A name it does not accept stops the server before it serves anything. */
  const refused = start({ NV_QUALIFICATION_CAPABILITIES: 'notifications' });
  assert.strictEqual(await ready(refused), false, 'a server told to serve notifications ahead of their proof must not start');
  assert.match(refused.logs(), /may name only live-events/);
  await stop(refused);

  for (const qualifying of [false, true]) {
    const server = start(qualifying ? { NV_QUALIFICATION_CAPABILITIES: 'live-events' } : {});
    try {
      assert.strictEqual(await ready(server), true, server.logs());
      const config = await (await fetch(`${server.origin}/api/config`)).json();
      assert.deepStrictEqual(config.qualification, qualifying ? { capabilities: ['live-events'] } : undefined, 'the deployment says what it serves ahead of its proof');
      const login = await fetch(`${server.origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nv': '1' },
        body: JSON.stringify({ provider: 'github', token: 'stream-fixture-only' }) });
      assert.strictEqual(login.status, 200, await login.clone().text());
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const read = async route => {
        const response = await fetch(`${server.origin}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
        const body = await response.json().catch(() => ({}));
        return { status: response.status, code: body.code };
      };
      const live = await read('/api/repo/Acme/Demo/live-events/status');
      if (qualifying) assert.notStrictEqual(live.code, 'PROVIDER_CAPABILITY_EXPERIMENTAL', 'the qualification deployment serves live events');
      else assert.deepStrictEqual(live, { status: 409, code: 'PROVIDER_CAPABILITY_EXPERIMENTAL' });
      assert.deepStrictEqual(await read('/api/notifications'), { status: 409, code: 'PROVIDER_CAPABILITY_EXPERIMENTAL' }, 'and nothing else');
    } finally {
      await stop(server);
    }
  }
  console.log('qualification capability tests passed');
})().catch(error => { console.error(error); process.exit(1); });
