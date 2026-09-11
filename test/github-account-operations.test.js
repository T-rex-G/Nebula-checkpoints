'use strict';

const assert = require('assert');
const {
  validateRepositoryCreation, connectionRestriction, githubTokenKind,
  githubRepositoryScopes, scopedCodeQuery, createVerifiedRepository,
  searchAccessibleCode, listAccessibleNotifications, verifyRepositoryDeletion
} = require('../src/github-account-operations');

async function main() {
  assert.deepStrictEqual(validateRepositoryCreation({ name: 'demo' }), {
    name: 'demo', description: '', private: true, auto_init: true
  });
  for (const body of [null, [], { name: '../demo' }, { name: 'demo', owner: 'someone-else' },
    { name: 'demo', isPrivate: 'false' }, { name: '.' }, { name: 'demo', autoInit: 1 }]) {
    assert.throws(() => validateRepositoryCreation(body), { code: 'REPOSITORY_CREATE_INVALID' });
  }
  assert.strictEqual(githubTokenKind({ token: 'github_pat_fixture' }), 'fine-grained');
  assert(connectionRestriction({ authMethod: 'github-app' }, 'repository.create'));
  assert(connectionRestriction({ tokenKind: 'fine-grained' }, 'notifications'));
  assert.strictEqual(connectionRestriction({ authMethod: 'token', tokenKind: 'classic' }, 'notifications'), null);
  const scopes = githubRepositoryScopes(['github:github.com/Acme/Demo', 'gitlab:gitlab.com/team/repo']);
  assert.deepStrictEqual(scopes, ['acme/demo']);
  assert.throws(() => githubRepositoryScopes(['github:github.com/acme/demo', 'invalid']), { code: 'ALPHA_REPOSITORY_NOT_ALLOWED' });
  assert.strictEqual(scopedCodeQuery('hello world', 'acme/demo'), 'hello world repo:acme/demo');
  for (const q of ['secret repo:other/private', 'secret OR password', 'user:other', 'hello\nworld']) {
    assert.throws(() => scopedCodeQuery(q, 'acme/demo'), { code: 'SEARCH_QUERY_INVALID' });
  }

  const account = { login: 'alice', providerAccountId: 7 };
  const created = { id: 12, full_name: 'alice/demo', default_branch: 'main' };
  const calls = [];
  const request = async (route, options = {}) => {
    calls.push({ route, options });
    if (route === '/user') return { id: 7, login: 'alice' };
    return created;
  };
  assert.deepStrictEqual(await createVerifiedRepository(request, account, { name: 'demo' }), {
    id: 12, full_name: 'alice/demo', default_branch: 'main', verified: true
  });
  assert.deepStrictEqual(calls.map(c => c.route), ['/user', '/user/repos', '/repos/alice/demo']);
  assert.strictEqual(calls[1].options.body.private, true);
  await assert.rejects(createVerifiedRepository(async route => route === '/user'
    ? { id: 8, login: 'mallory' } : created, account, { name: 'demo' }), { code: 'PROVIDER_IDENTITY_MISMATCH' });
  await assert.rejects(createVerifiedRepository(async route => route === '/user'
    ? { id: 7, login: 'alice' } : route === '/user/repos' ? created : { ...created, id: 99 },
  account, { name: 'demo' }), error => error.code === 'REPOSITORY_CREATE_UNVERIFIED' && error.providerChanged === true);

  const searchCalls = [];
  const hits = await searchAccessibleCode(async route => {
    searchCalls.push(route);
    return { items: [
      { repository: { full_name: 'acme/demo' }, path: 'README.md' },
      { repository: { full_name: 'other/private' }, path: 'secret.txt' }
    ] };
  }, 'hello', scopes);
  assert.deepStrictEqual(hits, [{ repo: 'acme/demo', path: 'README.md' }]);
  assert(new URL(searchCalls[0], 'https://api.github.com').searchParams.get('q').endsWith('repo:acme/demo'));
  const callsBeforeEmpty = searchCalls.length;
  assert.deepStrictEqual(await searchAccessibleCode(async r => { searchCalls.push(r); }, 'hello', []), []);
  assert.strictEqual(searchCalls.length, callsBeforeEmpty);
  let openQuery;
  await searchAccessibleCode(async route => { openQuery = route; return { items: [] }; }, 'hello', null);
  assert.strictEqual(new URL(openQuery, 'https://api.github.com').searchParams.get('q'), 'hello');

  const notificationCalls = [];
  const inbox = await listAccessibleNotifications(async route => {
    notificationCalls.push(route);
    return [{ id: '1', repository: { full_name: 'acme/demo', html_url: 'https://evil.example' },
      subject: { title: 'Allowed update', type: 'Issue' }, unread: true, reason: 'mention', updated_at: '2026-09-10T00:00:00Z' },
    { id: '2', repository: { full_name: 'other/private' }, subject: { title: 'Secret' } }];
  }, scopes);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].web, 'https://github.com/acme/demo');
  assert.deepStrictEqual(notificationCalls, ['/repos/acme/demo/notifications?per_page=30']);
  await assert.rejects(verifyRepositoryDeletion(async () => ({ ...created, permissions: { admin: false } }), 'alice/demo'),
    { code: 'REPOSITORY_DELETE_PERMISSION_REQUIRED' });
  await assert.rejects(verifyRepositoryDeletion(async () => ({ ...created, full_name: 'other/demo', permissions: { admin: true } }), 'alice/demo'),
    { code: 'PROVIDER_REPOSITORY_MISMATCH' });
  assert.strictEqual((await verifyRepositoryDeletion(async () => ({ ...created, permissions: { admin: true } }), 'alice/demo')).id, 12);
  const installation = { authMethod: 'github-app', authorizedByLogin: 'alice', installation: { permissions: { administration: 'write' } } };
  const installationRequest = async route => route.endsWith('/permission')
    ? { permission: 'admin', user: { login: 'alice' } } : created;
  assert.strictEqual((await verifyRepositoryDeletion(installationRequest, 'alice/demo', installation)).id, 12);
  await assert.rejects(verifyRepositoryDeletion(async route => route.endsWith('/permission')
    ? { permission: 'read', user: { login: 'alice' } } : { ...created, permissions: { admin: true } },
  'alice/demo', installation), { code: 'REPOSITORY_DELETE_PERMISSION_REQUIRED' });
  await assert.rejects(verifyRepositoryDeletion(installationRequest, 'alice/demo', { ...installation, authorizedByLogin: 'bob' }),
    { code: 'REPOSITORY_DELETE_PERMISSION_REQUIRED' });
  console.log('GitHub account operations tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
