'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/workspace-ui.js'), 'utf8');
const binding = { principalId: 'p1', workspaceId: 'w1', connectionId: 'c1' };
const context = { ...binding, role: 'owner', connection: { id: 'c1' } };

async function harness(reply, sessionContext = context) {
  const calls = [];
  const window = { fetch: async (url, options) => {
    calls.push({ url, options });
    const result = url === '/api/workspace/session'
      ? { status: 200, body: { authenticated: true, csrfToken: 'owner-csrf', context: sessionContext } }
      : await reply(url, options, calls);
    return { ok: result.status >= 200 && result.status < 300, status: result.status,
      json: async () => { if (result.badJson) throw new Error('response lost'); return result.body; } };
  } };
  vm.runInNewContext(source, { window });
  const ui = window.NebulaWorkspaceUI;
  await ui.probe();
  return { ui, calls };
}

(async () => {
  const h = await harness(async () => ({ status: 201, body: { verified: true, full_name: 'owner/demo' } }));
  await h.ui.workbench('/api/repos', { method: 'POST', body: { name: 'demo' }, headers: { 'x-nv-csrf': 'cohort-csrf' } }, binding);
  const sent = h.calls[1];
  assert.strictEqual(sent.url, '/api/workspace/workbench/repos');
  assert.strictEqual(sent.options.headers['x-nv-csrf'], 'owner-csrf');
  assert.strictEqual(sent.options.headers['x-nv-connection'], 'c1');
  assert.strictEqual(sent.options.headers['x-nv-workspace'], 'w1');
  assert.strictEqual(sent.options.cache, 'no-store');
  assert.strictEqual(sent.options.headers['x-nv-offline-cache'], undefined);
  await assert.rejects(() => h.ui.workbench('/api/repos', {}, { ...binding, connectionId: 'other' }), { code: 'WORKSPACE_EXECUTION_CHANGED' });
  await assert.rejects(() => h.ui.workbench('https://unrelated.invalid/api/repos', {}, binding), { code: 'WORKSPACE_INPUT_INVALID' });
  assert.strictEqual(h.calls.length, 2);

  for (const reply of [async () => { throw new Error('lost reply'); }, async () => ({ status: 200, badJson: true }),
    async () => ({ status: 200, body: { ok: true } }), async () => ({ status: 502, body: { code: 'WORKSPACE_WRITE_UNCERTAIN' } })]) {
    const x = await harness(reply);
    await assert.rejects(() => x.ui.workbench('/api/repos', { method: 'POST', body: { name: 'demo' } }, binding), { code: 'WORKSPACE_WRITE_UNCERTAIN' });
    await assert.rejects(() => x.ui.workbench('/api/repos', { method: 'POST', body: { name: 'demo' } }, binding), { code: 'WORKSPACE_WRITE_UNCERTAIN' });
    assert.strictEqual(x.calls.filter(c => c.options.method === 'POST').length, 1, 'uncertain writes lock further writes and never replay');
    assert(x.calls.every(c => c.url.startsWith('/api/workspace/')));
  }
  let posts = 0;
  const retry = await harness(async () => ++posts === 1 ? { status: 403, body: { code: 'CSRF_EXPIRED' } }
    : { status: 201, body: { verified: true, full_name: 'owner/demo' } });
  await retry.ui.workbench('/api/repos', { method: 'POST', body: { name: 'demo' } }, binding);
  assert.strictEqual(posts, 2, 'only a definitive CSRF refusal permits one bounded retry');
  assert.strictEqual(retry.calls.filter(c => c.url === '/api/workspace/session').length, 2);
  const stale = await harness(async () => ({ status: 403, body: { code: 'CSRF_EXPIRED' } }));
  await assert.rejects(() => stale.ui.workbench('/api/repos', { method: 'POST', body: { name: 'demo' } }, binding), { code: 'CSRF_EXPIRED' });
  assert.strictEqual(stale.calls.filter(c => c.options.method === 'POST').length, 2);
  const tester = await harness(async () => { throw new Error('must not fetch'); }, { ...context, role: 'tester' });
  await assert.rejects(() => tester.ui.workbench('/api/repos', {}, binding), { code: 'WORKSPACE_SESSION_REQUIRED' });
  assert.strictEqual(tester.calls.length, 1);
  console.log('owner workbench transport tests passed (pins, separate CSRF, no fallback or replay)');
})().catch(error => { console.error(error); process.exitCode = 1; });
