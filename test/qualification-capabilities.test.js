'use strict';

/*
 * The one exception to "only what is Supported is served": a qualification
 * deployment serving a capability that awaits the hosted proof only it can
 * give. Live events were that capability until the hosted gate proved them;
 * none awaits that proof now. So any name is refused at start, the mechanism
 * still serves exactly what it names and nothing else on a registry that holds
 * one back, and a real server serves live events with the variable unset.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { AWAITING_HOSTED_PROOF, loadQualificationCapabilities } = require('../src/qualification-capabilities');
const { loadCapabilityDocument, validateCapabilityDocument, assertCapabilityAvailable } = require('../src/capability-registry');

const root = path.join(__dirname, '..');
const document = loadCapabilityDocument(path.join(root, 'config', 'public-alpha-capabilities.json'));
const github = { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', authMethod: 'token', tokenKind: 'fine-grained' };

/* ---- What may be named: nothing, now ------------------------------------- */
assert.deepStrictEqual([...AWAITING_HOSTED_PROOF], [], 'no capability awaits hosted proof');
assert.deepStrictEqual([...loadQualificationCapabilities({}, document)], []);
assert.deepStrictEqual([...loadQualificationCapabilities({ NV_QUALIFICATION_CAPABILITIES: '  ' }, document)], []);
for (const named of ['live-events', 'notifications', 'repository.create', 'pulls.read', 'everything', 'live-events,notifications']) {
  assert.throws(() => loadQualificationCapabilities({ NV_QUALIFICATION_CAPABILITIES: named }, document), /no capability awaits hosted proof; remove it/,
    `${named} is refused: a deployment still carrying the variable was not brought up to date with the promotion`);
}

/* ---- The exception, and only it, on a registry that holds two back ------- */
const heldBack = structuredClone(require('../config/public-alpha-capabilities.json'));
for (const feature of ['live-events', 'notifications']) {
  heldBack.providers.github['hosted-alpha'][feature] = ['Experimental', 'Inferred', 'Held back for this demonstration.'];
}
const experimental = validateCapabilityDocument(heldBack);
assert.throws(() => assertCapabilityAvailable(experimental, { ...github, feature: 'live-events' }), error => error.code === 'PROVIDER_CAPABILITY_EXPERIMENTAL');
assert.strictEqual(assertCapabilityAvailable(experimental, { ...github, feature: 'live-events' }, { qualification: ['live-events'] }).status, 'Experimental',
  'served, and still described as Experimental');
assert.throws(() => assertCapabilityAvailable(experimental, { ...github, tokenKind: 'classic', feature: 'notifications' }, { qualification: ['live-events'] }),
  error => error.code === 'PROVIDER_CAPABILITY_EXPERIMENTAL', 'naming one feature serves no other');
assert.strictEqual(assertCapabilityAvailable(experimental, { ...github, feature: 'pulls.read' }, { qualification: ['live-events'] }).status, 'Supported');
/* And on the real registry, live events are served with nothing named. */
assert.strictEqual(assertCapabilityAvailable(document, { ...github, feature: 'live-events' }).status, 'Supported');

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
  /* A deployment still carrying the variable stops before it serves anything. */
  const refused = start({ NV_QUALIFICATION_CAPABILITIES: 'live-events' });
  assert.strictEqual(await ready(refused), false, 'a server still naming a promoted capability must not start');
  assert.match(refused.logs(), /no capability awaits hosted proof; remove it/);
  await stop(refused);

  const server = start({});
  try {
    assert.strictEqual(await ready(server), true, server.logs());
    const config = await (await fetch(`${server.origin}/api/config`)).json();
    assert.strictEqual(config.qualification, undefined, 'nothing is served ahead of its proof');
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
    assert.notStrictEqual(live.code, 'PROVIDER_CAPABILITY_EXPERIMENTAL', 'live events are served as any Supported capability is');
    const notifications = await read('/api/notifications');
    assert.notStrictEqual(notifications.code, 'PROVIDER_CAPABILITY_EXPERIMENTAL', 'and so are notifications');
  } finally {
    await stop(server);
  }
  console.log('qualification capability tests passed');
})().catch(error => { console.error(error); process.exit(1); });
