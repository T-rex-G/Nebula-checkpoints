'use strict';

const assert = require('assert');
const crypto = require('crypto');
let authorization = {};
try { authorization = require('../src/authorization-resolver'); } catch {}

for (const name of [
  'AuthorizationResolverError', 'AUTHORIZATION_SCHEMA_VERSION', 'GOVERNANCE_ROLE_NAMES',
  'normalizeAuthorizationSnapshot', 'createUnavailableAuthorizationSnapshot', 'createAuthorizationResolver'
]) assert(authorization[name], `${name} must be implemented`);

const {
  AuthorizationResolverError,
  normalizeAuthorizationSnapshot,
  createUnavailableAuthorizationSnapshot,
  createAuthorizationResolver
} = authorization;

const key = value => crypto.createHash('sha256').update(value).digest('hex');
const actorKey = key('github:alice');
const baseAccount = { provider: 'github', authMethod: 'oauth', login: 'alice', token: 'gho_secret' };
const scope = { owner: 'Acme', repo: 'Demo' };

function assertCredentialFree(value) {
  const encoded = JSON.stringify(value);
  for (const secret of ['gho_secret', 'ghs_secret', 'glpat-secret', 'gitea-secret']) {
    assert(!encoded.includes(secret), `snapshot must not contain ${secret}`);
  }
}

(async () => {
  let now = Date.UTC(2026, 6, 22, 14, 0, 0);
  const calls = [];
  const resolver = createAuthorizationResolver({
    now: () => now,
    cacheTtlMs: 60000,
    maxEntries: 10,
    request: async ({ account, apiPath }) => {
      calls.push({ provider: account.provider, login: account.login, apiPath });
      if (apiPath === '/repos/Acme/Demo/collaborators/alice/permission') {
        return { permission: 'write', role_name: 'maintain', user: { login: 'alice' } };
      }
      throw new Error(`Unexpected path ${apiPath}`);
    }
  });

  const github = await resolver.resolve({ account: baseAccount, ...scope, actorIdentityKey: actorKey });
  assert.strictEqual(github.schemaVersion, 1);
  assert.strictEqual(github.scope.scopeKey, 'github:github.com:acme/demo');
  assert.deepStrictEqual(github.executionPrincipal, {
    kind: 'user', identityKey: actorKey, login: 'alice', authMethod: 'oauth'
  });
  assert.deepStrictEqual(github.governanceActor, {
    kind: 'human', identityKey: actorKey, login: 'alice', verified: true
  });
  assert.deepStrictEqual(github.repositoryAccess, {
    baseRole: 'maintain', providerRole: 'maintain', level: 40,
    source: 'github.collaborator.permission', complete: true
  });
  assert.deepStrictEqual(github.governanceRoles, {
    reader: true, author: true, reviewer: true, activator: false, administrator: false
  });
  assert.strictEqual(github.installationCapabilities, null);
  assert.strictEqual(github.evidence.status, 'resolved');
  assert(Object.isFrozen(github) && Object.isFrozen(github.scope) && Object.isFrozen(github.governanceRoles));
  assertCredentialFree(github);

  const cached = await resolver.resolve({ account: baseAccount, ...scope, actorIdentityKey: actorKey });
  assert.strictEqual(cached, github, 'valid cache entry should be reused');
  assert.strictEqual(calls.length, 1);

  now += 60001;
  await resolver.resolve({ account: baseAccount, ...scope, actorIdentityKey: actorKey });
  assert.strictEqual(calls.length, 2, 'expired cache entry must refresh');

  const customRoleResolver = createAuthorizationResolver({
    request: async () => ({ permission: 'write', role_name: 'security-manager', user: { login: 'alice' } })
  });
  const customRole = await customRoleResolver.resolve({ account: baseAccount, ...scope, actorIdentityKey: actorKey });
  assert.strictEqual(customRole.repositoryAccess.baseRole, 'write');
  assert.strictEqual(customRole.repositoryAccess.providerRole, 'security-manager');
  assert.strictEqual(customRole.governanceRoles.reviewer, false, 'unknown custom role must not elevate write access');

  const gitlab = await createAuthorizationResolver({
    request: async ({ apiPath }) => {
      assert.strictEqual(apiPath, '/projects/Platform%2FSecurity%2FDemo');
      return { permissions: { project_access: { access_level: 30 }, group_access: { access_level: 40 } } };
    }
  }).resolve({
    account: { provider: 'gitlab', authMethod: 'token', login: 'alice', token: 'glpat-secret', baseUrl: 'https://gitlab.example/team' },
    owner: 'Platform/Security', repo: 'Demo', actorIdentityKey: key('gitlab:alice')
  });
  assert.strictEqual(gitlab.scope.authority, 'gitlab.example/team');
  assert.deepStrictEqual(gitlab.repositoryAccess, {
    baseRole: 'maintain', providerRole: 'maintainer', level: 40,
    source: 'gitlab.project.permissions', complete: true
  });
  assert.strictEqual(gitlab.governanceRoles.reviewer, true);
  assert.strictEqual(gitlab.governanceRoles.activator, false);
  assert.strictEqual(gitlab.governanceRoles.administrator, false);
  assertCredentialFree(gitlab);

  const gitlabOwner = await createAuthorizationResolver({
    request: async () => ({ permissions: { project_access: { access_level: 50 }, group_access: null } })
  }).resolve({
    account: { provider: 'gitlab', authMethod: 'token', login: 'owner', token: 'glpat-secret', baseUrl: 'https://gitlab.example' },
    owner: 'Platform', repo: 'Demo', actorIdentityKey: key('gitlab:owner')
  });
  assert.strictEqual(gitlabOwner.repositoryAccess.baseRole, 'admin');
  assert.strictEqual(gitlabOwner.repositoryAccess.level, 50);
  assert.strictEqual(gitlabOwner.governanceRoles.administrator, true);

  const gitea = await createAuthorizationResolver({
    request: async ({ apiPath }) => {
      assert.strictEqual(apiPath, '/repos/acme/demo/collaborators/alice/permission');
      return { permission: 'admin', role_name: 'admin', user: { login: 'alice' } };
    }
  }).resolve({
    account: { provider: 'gitea', authMethod: 'token', login: 'alice', token: 'gitea-secret', baseUrl: 'https://git.example' },
    owner: 'acme', repo: 'demo', actorIdentityKey: key('gitea:alice')
  });
  assert.strictEqual(gitea.repositoryAccess.level, 50);
  assert.strictEqual(gitea.governanceRoles.activator, true);

  const caseSensitiveGitea = await createAuthorizationResolver({
    request: async ({ apiPath }) => {
      assert.strictEqual(apiPath, '/repos/Acme/Demo/collaborators/alice/permission');
      return { permission: 'write', role_name: 'write', user: { login: 'alice' } };
    }
  }).resolve({
    account: { provider: 'gitea', authMethod: 'token', login: 'alice', token: 'gitea-secret', baseUrl: 'https://git.example/GitRoot' },
    owner: 'Acme', repo: 'Demo', actorIdentityKey: key('gitea:case-sensitive')
  });
  assert.strictEqual(caseSensitiveGitea.scope.authority, 'git.example/GitRoot');
  assert.strictEqual(caseSensitiveGitea.scope.scopeKey, 'gitea:git.example/GitRoot:acme/demo');
  assert.strictEqual(caseSensitiveGitea.governanceRoles.author, true);

  const authorizerIdentityKey = key('github:authorizer');
  const appCalls = [];
  const appAccount = {
    provider: 'github', authMethod: 'github-app', login: 'nebula-org', token: 'ghs_secret',
    installationId: 77, installationAccountId: 501,
    authorizedByLogin: 'reviewer', authorizedByIdentityKey: authorizerIdentityKey,
    installation: {
      id: 77, appId: 10,
      account: { login: 'nebula-org', id: 501, type: 'Organization', avatarUrl: '' },
      repositorySelection: 'selected', permissions: { contents: 'write', metadata: 'read' },
      suspendedAt: '', htmlUrl: ''
    }
  };
  const appSnapshot = await createAuthorizationResolver({
    request: async ({ apiPath }) => {
      appCalls.push(apiPath);
      if (apiPath === '/repos/Acme/Demo') return { full_name: 'Acme/Demo' };
      if (apiPath === '/repos/Acme/Demo/collaborators/reviewer/permission') {
        return { permission: 'admin', role_name: 'admin', user: { login: 'reviewer' } };
      }
      throw new Error(`Unexpected app path ${apiPath}`);
    }
  }).resolve({ account: appAccount, ...scope, actorIdentityKey: key('installation:77:authorizer') });
  assert.strictEqual(appSnapshot.executionPrincipal.kind, 'installation');
  assert.strictEqual(appSnapshot.executionPrincipal.login, 'nebula-org');
  assert.strictEqual(appSnapshot.executionPrincipal.installationId, 77);
  assert.notStrictEqual(appSnapshot.executionPrincipal.identityKey, appSnapshot.governanceActor.identityKey);
  assert.deepStrictEqual(appSnapshot.governanceActor, {
    kind: 'human', identityKey: authorizerIdentityKey, login: 'reviewer', verified: true
  });
  assert.deepStrictEqual(appSnapshot.installationCapabilities, {
    repositorySelected: true,
    repositorySelection: 'selected',
    permissions: { contents: 'write', metadata: 'read' }
  });
  assert.deepStrictEqual(appCalls, [
    '/repos/Acme/Demo',
    '/repos/Acme/Demo/collaborators/reviewer/permission'
  ]);
  assertCredentialFree(appSnapshot);

  let incompleteRepositoryPermissionRequested = false;
  const incompleteRepository = await createAuthorizationResolver({
    request: async ({ apiPath }) => {
      if (apiPath === '/repos/Acme/Demo') return {};
      incompleteRepositoryPermissionRequested = true;
      return { permission: 'admin', role_name: 'admin', user: { login: 'reviewer' } };
    }
  }).resolve({ account: appAccount, ...scope, actorIdentityKey: key('installation:77:incomplete-repository') });
  assert.strictEqual(incompleteRepository.evidence.status, 'partial');
  assert.strictEqual(incompleteRepository.evidence.reasonCode, 'AUTHORIZATION_PROVIDER_RESPONSE_INCOMPLETE');
  assert.strictEqual(incompleteRepository.installationCapabilities.repositorySelected, false);
  assert.strictEqual(incompleteRepositoryPermissionRequested, false, 'human permission must not be queried until repository selection is proven');

  const missingInstallation = await createAuthorizationResolver({ request: async () => { throw new Error('must not request'); } })
    .resolve({ account: { ...appAccount, installation: undefined }, ...scope, actorIdentityKey: key('installation-missing') });
  assert.strictEqual(missingInstallation.evidence.status, 'unavailable');
  assert.strictEqual(missingInstallation.evidence.reasonCode, 'AUTHORIZATION_INSTALLATION_EVIDENCE_UNAVAILABLE');
  assert.deepStrictEqual(missingInstallation.governanceRoles, {
    reader: false, author: false, reviewer: false, activator: false, administrator: false
  });

  const forbidden = await createAuthorizationResolver({
    request: async () => { throw Object.assign(new Error('provider body must not leak'), { status: 403, body: { token: 'gho_secret' } }); }
  }).resolve({ account: baseAccount, ...scope, actorIdentityKey: actorKey });
  assert.strictEqual(forbidden.evidence.status, 'unavailable');
  assert.strictEqual(forbidden.evidence.reasonCode, 'AUTHORIZATION_PROVIDER_FORBIDDEN');
  assertCredentialFree(forbidden);

  const malformed = await createAuthorizationResolver({ request: async () => ({ permission: 'owner', role_name: 'owner' }) })
    .resolve({ account: baseAccount, ...scope, actorIdentityKey: actorKey });
  assert.strictEqual(malformed.evidence.status, 'partial');
  assert.strictEqual(malformed.evidence.reasonCode, 'AUTHORIZATION_PROVIDER_RESPONSE_INCOMPLETE');
  assert.strictEqual(malformed.governanceRoles.administrator, false);

  const unavailable = createUnavailableAuthorizationSnapshot({
    account: baseAccount, ...scope, actorIdentityKey: actorKey,
    reasonCode: 'AUTHORIZATION_SCOPE_NOT_APPLICABLE', now: () => now, ttlMs: 1000
  });
  assert.strictEqual(unavailable.evidence.status, 'unavailable');
  assert.strictEqual(unavailable.scope.scopeKey, 'github:github.com:acme/demo');

  assert.throws(
    () => normalizeAuthorizationSnapshot({ ...github, accessToken: 'gho_secret' }),
    error => error instanceof AuthorizationResolverError && error.code === 'AUTHORIZATION_SENSITIVE_FIELD'
  );

  assert.throws(
    () => normalizeAuthorizationSnapshot({
      ...github,
      repositoryAccess: { ...github.repositoryAccess, baseRole: 'read', level: 50 }
    }),
    error => error instanceof AuthorizationResolverError && error.code === 'AUTHORIZATION_SNAPSHOT_INVALID',
    'base role and normalized access level must be consistent'
  );

  assert.throws(
    () => normalizeAuthorizationSnapshot({
      ...github,
      governanceRoles: { ...github.governanceRoles, activator: true }
    }),
    error => error instanceof AuthorizationResolverError && error.code === 'AUTHORIZATION_SNAPSHOT_INVALID',
    'governance roles must be derived from normalized access rather than accepted as independent claims'
  );

  assert.throws(
    () => normalizeAuthorizationSnapshot({
      ...github,
      executionPrincipal: { ...github.executionPrincipal, identityKey: key('github:other-user') }
    }),
    error => error instanceof AuthorizationResolverError && error.code === 'AUTHORIZATION_SNAPSHOT_INVALID',
    'user execution and governance identities must remain bound'
  );

  let release;
  let requestCount = 0;
  const concurrent = createAuthorizationResolver({
    request: async ({ account }) => {
      requestCount += 1;
      if (requestCount > 1) return { permission: 'read', role_name: 'read', user: { login: account.login } };
      return new Promise(resolve => { release = () => resolve({ permission: 'read', role_name: 'read', user: { login: 'alice' } }); });
    }
  });
  const pendingA = concurrent.resolve({ account: baseAccount, ...scope, actorIdentityKey: actorKey });
  const pendingB = concurrent.resolve({ account: baseAccount, ...scope, actorIdentityKey: actorKey });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(requestCount, 1, 'concurrent identical resolution must coalesce');
  release();
  const [concurrentA, concurrentB] = await Promise.all([pendingA, pendingB]);
  assert.strictEqual(concurrentA, concurrentB);

  await concurrent.resolve({ account: { ...baseAccount, login: 'bob' }, ...scope, actorIdentityKey: key('github:bob') });
  assert.strictEqual(requestCount, 2, 'different identities must not share authorization cache entries');

  console.log('authorization resolver tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
