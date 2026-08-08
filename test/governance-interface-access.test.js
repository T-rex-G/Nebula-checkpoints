'use strict';
const assert = require('assert');
const crypto = require('crypto');
let api = {};
try { api = require('../src/governance-interface'); } catch {}
assert(api.projectGovernanceInterfaceAccess, 'projectGovernanceInterfaceAccess must be implemented');
const { projectGovernanceInterfaceAccess } = api;
const key = value => crypto.createHash('sha256').update(value).digest('hex');
const now = Date.parse('2026-07-23T00:40:00.000Z');
function snapshot(overrides = {}) {
  const actorKey = key('alice');
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
    executionPrincipal: { kind: 'user', identityKey: actorKey, login: 'alice', authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey: actorKey, login: 'alice', verified: true },
    repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
    governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true },
    installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: '2026-07-23T00:39:30.000Z', expiresAt: '2026-07-23T00:41:00.000Z', reasonCode: null },
    ...overrides
  };
}
const access = projectGovernanceInterfaceAccess(snapshot(), () => now);
assert.deepStrictEqual(access.capabilities, {
  read: true, author: true, review: true, activate: true, administer: true
});
assert.strictEqual(access.actor.login, 'alice');
assert.strictEqual(access.evidence.status, 'current');
assert(Object.isFrozen(access) && Object.isFrozen(access.capabilities));
const serialized = JSON.stringify(access);
for (const forbidden of ['token', 'cookie', 'authorization', 'installationCapabilities', 'identityKey', 'source']) {
  assert(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `access envelope leaked ${forbidden}`);
}
const stale = projectGovernanceInterfaceAccess(snapshot({
  evidence: { status: 'resolved', fetchedAt: '2026-07-23T00:30:00.000Z', expiresAt: '2026-07-23T00:39:59.000Z', reasonCode: null }
}), () => now);
assert.strictEqual(stale.evidence.status, 'stale');
assert.deepStrictEqual(stale.capabilities, { read: false, author: false, review: false, activate: false, administer: false });
const appActorKey = key('human-authorizer');
const appAccess = projectGovernanceInterfaceAccess(snapshot({
  executionPrincipal: { kind: 'installation', identityKey: key('installation:7'), login: 'acme-app', authMethod: 'github-app', installationId: 7 },
  governanceActor: { kind: 'human', identityKey: appActorKey, login: 'reviewer-human', verified: true },
  installationCapabilities: { repositorySelected: true, repositorySelection: 'selected', permissions: { metadata: 'read', contents: 'write' } }
}), () => now);
assert.strictEqual(appAccess.actor.login, 'reviewer-human');
assert.strictEqual(appAccess.execution.kind, 'installation');
assert.strictEqual(appAccess.execution.authMethod, 'github-app');
assert(!JSON.stringify(appAccess).includes('acme-app'), 'installation login must not be exposed as the human actor');
console.log('governance interface access tests passed');
