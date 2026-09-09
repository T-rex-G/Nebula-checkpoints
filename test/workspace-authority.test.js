'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { workspaceExecutionAuthority, assertWorkspaceExecutionPin } = require('../src/workspace-authority');

const context = { role: 'owner', principalId: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
  connection: { id: crypto.randomUUID(), provider: 'github', instance: 'https://github.com', providerUserId: '99', login: 'before' } };
const first = workspaceExecutionAuthority(context);
assert.match(first.identityKey, /^[0-9a-f]{64}$/);
assert.strictEqual(first.kind, 'workspace');
assert.strictEqual(first.principalId, context.principalId);
assert.strictEqual(workspaceExecutionAuthority({ ...context, connection: { ...context.connection, login: 'renamed' } }).identityKey, first.identityKey);
for (const field of ['principalId', 'workspaceId']) {
  assert.notStrictEqual(workspaceExecutionAuthority({ ...context, [field]: crypto.randomUUID() }).identityKey, first.identityKey);
}
assert.notStrictEqual(workspaceExecutionAuthority({ ...context, connection: { ...context.connection, id: crypto.randomUUID() } }).identityKey, first.identityKey);
assert.throws(() => workspaceExecutionAuthority({ ...context, role: 'tester' }), { code: 'WORKSPACE_SESSION_REQUIRED' });
assert.throws(() => workspaceExecutionAuthority({ ...context, connection: null }), { code: 'WORKSPACE_CONNECTION_REQUIRED' });
const headers = { 'x-nv-workspace': context.workspaceId, 'x-nv-connection': context.connection.id };
assertWorkspaceExecutionPin(first, headers);
for (const key of Object.keys(headers)) {
  assert.throws(() => assertWorkspaceExecutionPin(first, { ...headers, [key]: crypto.randomUUID() }), { code: 'WORKSPACE_EXECUTION_CHANGED' });
}
assert.throws(() => assertWorkspaceExecutionPin(first, {}), { code: 'WORKSPACE_EXECUTION_CHANGED' });
const legacyKey = crypto.createHash('sha256').update(JSON.stringify({ provider: 'github', baseUrl: '', login: 'before' })).digest('hex');
assert.notStrictEqual(first.identityKey, legacyKey, 'owner resources do not adopt the legacy provider identity namespace');
assert(Object.isFrozen(first));
console.log('workspace authority and execution pin tests passed');
