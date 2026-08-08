'use strict';

const assert = require('assert');
let mutation = {};
try { mutation = require('../src/mutation-gateway'); } catch {}

for (const name of [
  'MutationGatewayError', 'MUTATION_ACTIONS', 'normalizeMutationDescriptor',
  'parseProviderRepositoryTarget', 'classifyProviderOperation', 'createMutationGateway'
]) assert(mutation[name], `${name} must be implemented`);

const {
  MutationGatewayError, MUTATION_ACTIONS, normalizeMutationDescriptor,
  parseProviderRepositoryTarget, classifyProviderOperation, createMutationGateway
} = mutation;

assert(Object.isFrozen(MUTATION_ACTIONS), 'mutation action registry must be immutable');
for (const action of [
  'repository.create', 'repository.delete', 'branch.create', 'branch.delete',
  'file.write', 'file.delete', 'file.rename', 'file.batch', 'commit.revert',
  'commit.restore', 'commit.restore-paths', 'branch.reset', 'pull.create',
  'pull.merge', 'issue.create', 'issue.comment', 'issue.update',
  'repository.star', 'repository.unstar', 'pull.review', 'workflow.rerun',
  'release.create', 'git.blob.create', 'file.upload', 'directory.move',
  'recovery.restore-refs', 'webhook.connect', 'webhook.disconnect',
  'governance.policy.create', 'governance.draft.create', 'governance.draft.update',
  'governance.draft.submit', 'governance.reviewer.assign', 'governance.approval.decide',
  'governance.policy.activate', 'governance.policy.rollback',
  'governance.exception.request', 'governance.exception.decide', 'governance.exception.revoke'
]) assert(MUTATION_ACTIONS[action], `missing mutation action ${action}`);

const authorizationSnapshot = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'oauth' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'write', providerRole: 'write', level: 30, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: false, activator: false, administrator: false },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T14:00:00.000Z', expiresAt: '2026-07-22T14:01:00.000Z', reasonCode: null }
};

const base = {
  mutationId: '11111111-1111-4111-8111-111111111111',
  action: 'file.write', provider: 'GitHub', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'PUT',
  route: '/api/repo/Acme/Demo/file', metadata: { branch: 'main', path: 'README.md' },
  authorization: authorizationSnapshot
};
const descriptor = normalizeMutationDescriptor(base);
assert.deepStrictEqual({
  action: descriptor.action, provider: descriptor.provider, authority: descriptor.authority,
  owner: descriptor.owner, repo: descriptor.repo, scopeKey: descriptor.scopeKey,
  actorLogin: descriptor.actorLogin, method: descriptor.method, route: descriptor.route,
  metadata: descriptor.metadata, risk: descriptor.risk, authorization: descriptor.authorization
}, {
  action: 'file.write', provider: 'github', authority: 'github.com',
  owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo',
  actorLogin: 'Alice', method: 'PUT', route: '/api/repo/Acme/Demo/file',
  metadata: { branch: 'main', path: 'README.md' }, risk: 'high', authorization: authorizationSnapshot
});
assert(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.metadata), 'descriptor must be deeply immutable');

assert.throws(
  () => normalizeMutationDescriptor({ ...base, action: 'unknown.write' }),
  error => error instanceof MutationGatewayError && error.code === 'MUTATION_ACTION_UNKNOWN'
);
assert.throws(
  () => normalizeMutationDescriptor({ ...base, metadata: { accessToken: 'ghp_secret' } }),
  error => error.code === 'MUTATION_SENSITIVE_FIELD'
);
assert.throws(
  () => normalizeMutationDescriptor({ ...base, actorIdentityKey: 'not-a-key' }),
  error => error.code === 'MUTATION_ACTOR_INVALID'
);
assert.throws(
  () => normalizeMutationDescriptor({
    ...base,
    authorization: {
      ...authorizationSnapshot,
      scope: { ...authorizationSnapshot.scope, owner: 'Other', scopeKey: 'github:github.com:other/demo' }
    }
  }),
  error => error.code === 'MUTATION_AUTHORIZATION_SCOPE_MISMATCH'
);
assert.throws(
  () => normalizeMutationDescriptor({ ...base, actorLogin: 'Mallory' }),
  error => error.code === 'MUTATION_AUTHORIZATION_ACTOR_MISMATCH'
);
assert.throws(
  () => normalizeMutationDescriptor({ ...base, actorIdentityKey: 'b'.repeat(64) }),
  error => error.code === 'MUTATION_AUTHORIZATION_ACTOR_MISMATCH'
);

const githubAppAuthorization = {
  ...authorizationSnapshot,
  executionPrincipal: {
    kind: 'installation', identityKey: 'c'.repeat(64), login: 'Acme-App',
    authMethod: 'github-app', installationId: 77
  },
  governanceActor: { kind: 'human', identityKey: 'b'.repeat(64), login: 'Reviewer', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true },
  installationCapabilities: {
    repositorySelected: true, repositorySelection: 'selected', permissions: { metadata: 'read', contents: 'write' }
  }
};
const governanceDescriptor = normalizeMutationDescriptor({
  ...base,
  mutationId: '55555555-5555-4555-8555-555555555555',
  action: 'governance.draft.submit',
  actorIdentityKey: 'b'.repeat(64),
  actorLogin: 'Reviewer',
  method: 'POST',
  route: '/api/repo/Acme/Demo/governance/policies/p/drafts/d/submit',
  metadata: { policyId: '10000000-0000-4000-8000-000000000001', draftId: '20000000-0000-4000-8000-000000000002', expectedRevision: 0 },
  authorization: githubAppAuthorization
});
assert.strictEqual(governanceDescriptor.actorLogin, 'Reviewer');
assert.strictEqual(governanceDescriptor.category, 'governance');
const approvalDescriptor = normalizeMutationDescriptor({
  ...base,
  mutationId: '77777777-7777-4777-8777-777777777777',
  action: 'governance.approval.decide',
  actorIdentityKey: 'b'.repeat(64),
  actorLogin: 'Reviewer',
  method: 'POST',
  route: '/api/repo/Acme/Demo/governance/policies/p/versions/v/decisions',
  metadata: {
    policyId: '10000000-0000-4000-8000-000000000001',
    versionId: '20000000-0000-4000-8000-000000000002',
    decision: 'approve'
  },
  authorization: githubAppAuthorization
});
assert.strictEqual(approvalDescriptor.category, 'governance');
assert.strictEqual(approvalDescriptor.risk, 'high');
const activationDescriptor = normalizeMutationDescriptor({
  ...base,
  mutationId: '88888888-8888-4888-8888-888888888888',
  action: 'governance.policy.activate',
  actorIdentityKey: 'b'.repeat(64), actorLogin: 'Reviewer', method: 'POST',
  route: '/api/repo/Acme/Demo/governance/policies/p/versions/v/activate',
  metadata: { policyId: '10000000-0000-4000-8000-000000000001', versionId: '20000000-0000-4000-8000-000000000002', expectedRevision: 7, simulationHash: 'f'.repeat(64) },
  authorization: githubAppAuthorization
});
assert.strictEqual(activationDescriptor.risk, 'critical');
assert.strictEqual(activationDescriptor.actorLogin, 'Reviewer');
assert.deepStrictEqual(approvalDescriptor.metadata, {
  policyId: '10000000-0000-4000-8000-000000000001',
  versionId: '20000000-0000-4000-8000-000000000002',
  decision: 'approve'
});
assert.throws(
  () => normalizeMutationDescriptor({
    ...governanceDescriptor,
    mutationId: '66666666-6666-4666-8666-666666666666',
    actorIdentityKey: githubAppAuthorization.executionPrincipal.identityKey,
    actorLogin: githubAppAuthorization.executionPrincipal.login
  }),
  error => error.code === 'MUTATION_AUTHORIZATION_ACTOR_MISMATCH',
  'governance mutations must be bound to the verified human actor, not the installation identity'
);
assert.throws(
  () => normalizeMutationDescriptor({ ...base, security: { authorizedAt: 'not-a-number' } }),
  error => error.code === 'MUTATION_SECURITY_INVALID'
);
assert.throws(
  () => normalizeMutationDescriptor({ ...base, action: 'repository.delete', method: 'DELETE', metadata: {} }),
  error => error.code === 'MUTATION_STEP_UP_REQUIRED'
);
assert.throws(
  () => normalizeMutationDescriptor({
    ...base, action: 'repository.delete', method: 'DELETE', metadata: {},
    security: { stepUpAction: 'repository.delete', assurance: 'credential' }
  }),
  error => error.code === 'MUTATION_STEP_UP_REQUIRED'
);
const authorizedAt = Date.now();
const destructive = normalizeMutationDescriptor({
  ...base, action: 'repository.delete', method: 'DELETE', metadata: {},
  security: { stepUpAction: 'repository.delete', assurance: 'credential', authorizedAt }
});
assert.deepStrictEqual(destructive.security, {
  stepUpAction: 'repository.delete', assurance: 'credential', authorizedAt
});

assert.deepStrictEqual(
  parseProviderRepositoryTarget('github', '/repos/Acme/Demo/git/refs'),
  { owner: 'Acme', repo: 'Demo' }
);
assert.deepStrictEqual(
  parseProviderRepositoryTarget('github', '/user/starred/Acme/Demo'),
  { owner: 'Acme', repo: 'Demo' }
);
assert.deepStrictEqual(
  parseProviderRepositoryTarget('gitlab', '/projects/Platform%2FSecurity%2FDemo/repository/files/a'),
  { owner: 'Platform/Security', repo: 'Demo' }
);
assert.strictEqual(parseProviderRepositoryTarget('github', '/user/repos'), null);
assert.strictEqual(classifyProviderOperation('github', '/repos/Acme/Demo', 'DELETE'), 'repository.delete');
assert.strictEqual(classifyProviderOperation('gitlab', '/projects/Acme%2FDemo/repository/files/a', 'PUT'), 'gitlab.file.write');
assert.strictEqual(
  classifyProviderOperation('gitea', '/repos/Acme/Demo/contents/folder/a.txt', 'PUT'),
  'gitea.file.write'
);
assert.strictEqual(
  classifyProviderOperation('gitea', '/repos/Acme/Demo/contents/folder/a.txt', 'DELETE'),
  'gitea.file.delete'
);
assert.strictEqual(
  classifyProviderOperation('gitea', '/repos/Acme/Demo/branches', 'POST'),
  'gitea.branch.create'
);
assert.strictEqual(
  classifyProviderOperation('gitea', '/repos/Acme/Demo/branches/main', 'PUT'),
  'gitea.branch.cas'
);
assert.strictEqual(
  classifyProviderOperation('gitea', '/repos/Acme/Demo/branches/nv-tx%2Ffixture', 'DELETE'),
  'gitea.branch.delete'
);
for (const operation of ['gitea.branch.create', 'gitea.file.write', 'gitea.branch.cas', 'gitea.branch.delete']) {
  assert(MUTATION_ACTIONS['file.write'].operations.includes(operation));
}
for (const operation of ['gitea.branch.create', 'gitea.file.delete', 'gitea.branch.cas', 'gitea.branch.delete']) {
  assert(MUTATION_ACTIONS['file.delete'].operations.includes(operation));
}

(async () => {
  const observed = [];
  const gateway = createMutationGateway({ eventSink: event => observed.push(event) });
  assert.strictEqual(gateway.current(), null);
  assert.throws(
    () => gateway.assertProviderMutation({ provider: 'github', method: 'POST', apiPath: '/repos/Acme/Demo/git/blobs' }),
    error => error.code === 'MUTATION_GATEWAY_REQUIRED'
  );

  const result = await gateway.run(base, async () => {
    await Promise.resolve();
    assert.strictEqual(gateway.current().mutationId, base.mutationId, 'context must survive async boundaries');
    const permit = gateway.assertProviderMutation({
      provider: 'github', method: 'POST', apiPath: '/repos/Acme/Demo/git/blobs'
    });
    assert.strictEqual(permit.action, 'file.write');
    assert.throws(
      () => gateway.assertProviderMutation({ provider: 'gitlab', method: 'POST', apiPath: '/projects/acme%2Fdemo' }),
      error => error.code === 'MUTATION_PROVIDER_MISMATCH'
    );
    assert.throws(
      () => gateway.assertProviderMutation({ provider: 'github', method: 'DELETE', apiPath: '/repos/Other/Demo' }),
      error => error.code === 'MUTATION_SCOPE_MISMATCH'
    );
    assert.throws(
      () => gateway.assertProviderMutation({ provider: 'github', method: 'DELETE', apiPath: '/repos/Acme/Demo' }),
      error => error.code === 'MUTATION_ACTION_MISMATCH'
    );
    await assert.rejects(
      () => gateway.run({ ...base, mutationId: '22222222-2222-4222-8222-222222222222' }, async () => true),
      error => error.code === 'MUTATION_CONTEXT_NESTED'
    );
    return 'ok';
  });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(gateway.current(), null, 'context must be cleared after execution');
  assert.deepStrictEqual(observed.map(event => event.type), ['mutation.entered', 'provider.write.authorized', 'mutation.completed']);
  assert(observed.every(event => !JSON.stringify(event).includes('ghp_secret')), 'events must not contain secrets');

  const governanceResult = await gateway.run(governanceDescriptor, async () => {
    assert.strictEqual(gateway.current().actorIdentityKey, 'b'.repeat(64));
    assert.strictEqual(gateway.current().authorization.executionPrincipal.kind, 'installation');
    return 'submitted';
  });
  assert.strictEqual(governanceResult, 'submitted');

  await assert.rejects(
    () => gateway.run({ ...base, metadata: { clientSecret: 'nope' } }, async () => true),
    error => error.code === 'MUTATION_SENSITIVE_FIELD'
  );

  await assert.rejects(
    () => gateway.run({
      ...base, mutationId: '33333333-3333-4333-8333-333333333333',
      action: 'repository.create', method: 'POST', route: '/api/repos', repo: 'Demo', metadata: { name: 'Demo' }
    }, async () => gateway.assertProviderMutation({
      provider: 'github', method: 'POST', apiPath: '/user/repos', body: { name: 'Other' }
    })),
    error => error.code === 'MUTATION_SCOPE_MISMATCH'
  );

  console.log('mutation gateway tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
