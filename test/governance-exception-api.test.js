'use strict';
const assert = require('assert');
const { createGovernanceApiService } = require('../src/governance-api');
function authorization(level, actor = 'a') {
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
    executionPrincipal: { kind: 'user', identityKey: actor.repeat(64), login: actor, authMethod: 'token' },
    governanceActor: { kind: 'human', identityKey: actor.repeat(64), login: actor, verified: true },
    repositoryAccess: { baseRole: level === 50 ? 'admin' : 'write', providerRole: level === 50 ? 'admin' : 'write', level, source: 'provider', complete: true },
    governanceRoles: { reader: true, author: level >= 30, reviewer: level >= 40, activator: level >= 50, administrator: level >= 50 }, installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T21:00:00.000Z', reasonCode: null }
  };
}
const calls = [];
const store = new Proxy({}, { get(_t, prop) { return async input => { calls.push([prop, input]); return { ok: true }; }; } });
const service = createGovernanceApiService({ store, now: () => Date.parse('2026-07-22T19:00:00.000Z') });
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
(async () => {
  await service.createException({ authorization: authorization(30), scope, policyId: '10000000-0000-4000-8000-000000000001', versionId: '20000000-0000-4000-8000-000000000002', input: { kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], target: { path: 'README.md' }, reason: 'repair', expiresAt: '2026-07-22T20:00:00.000Z' } });
  assert.strictEqual(calls.at(-1)[0], 'createExceptionRequest');
  assert.strictEqual(calls.at(-1)[1].actor.identityKey, 'a'.repeat(64));
  await service.decideException({ authorization: authorization(50, 'b'), scope, exceptionId: '30000000-0000-4000-8000-000000000003', input: { decision: 'approve', reason: 'approved' } });
  assert.strictEqual(calls.at(-1)[0], 'decideException');
  await service.revokeException({ authorization: authorization(50, 'c'), scope, exceptionId: '30000000-0000-4000-8000-000000000003', input: { reason: 'no longer required' } });
  assert.strictEqual(calls.at(-1)[0], 'revokeException');
  await assert.rejects(() => service.decideException({ authorization: authorization(30), scope, exceptionId: '30000000-0000-4000-8000-000000000003', input: { decision: 'approve', reason: 'x' } }), error => error.code === 'GOVERNANCE_ROLE_REQUIRED');
  await assert.rejects(() => service.createException({ authorization: authorization(30), scope, policyId: '10000000-0000-4000-8000-000000000001', versionId: '20000000-0000-4000-8000-000000000002', input: { kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], target: { path: 'README.md' }, reason: 'x', expiresAt: '2026-07-22T20:00:00.000Z', actorIdentityKey: 'd'.repeat(64) } }), error => error.code === 'GOVERNANCE_EXCEPTION_IDENTITY_FORBIDDEN');
  console.log('governance exception api tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
