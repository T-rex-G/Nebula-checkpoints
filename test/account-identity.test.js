'use strict';
/*
 * Who an account is and which accounts are served
 * (identity-access/domain/account-identity.ts), and how a hosted session
 * written by two requests at once is merged (domain/hosted-session-merge.ts).
 */
const assert = require('assert');
const {
  identityKey, stableProviderIdentityKey, providerAuthority, assertGithubAccount, isGithubAccount,
  githubSession, persistedSession, mergeHostedSessionValue, hostedAccountKey, recomputeHostedSessionMutation
} = require('../apps/api/src/modules/identity-access/index.ts');
const { hashJson } = require('../apps/api/src/platform/values/stable-hash.ts');

/* The identity key: the account's own when it carries one in shape, else the digest of what identifies it. */
{
  const own = 'a'.repeat(64);
  assert.strictEqual(identityKey({ identityKey: own, login: 'alice' }), own);
  assert.strictEqual(identityKey({ identityKey: 'A'.repeat(64), login: 'alice' }), hashJson({ provider: 'github', baseUrl: '', login: 'alice' }),
    'a key out of shape is not trusted');
  assert.strictEqual(identityKey({ login: 'alice' }), hashJson({ provider: 'github', baseUrl: '', login: 'alice' }));
  assert.strictEqual(identityKey(null), hashJson({ provider: 'github', baseUrl: '', login: '' }));
  assert.strictEqual(identityKey({ provider: 'gitea', baseUrl: 'https://git.example', login: 'bob' }),
    hashJson({ provider: 'gitea', baseUrl: 'https://git.example', login: 'bob' }));
  assert.strictEqual(identityKey({ login: 'alice', authMethod: 'github-app', installationId: '12', authorizedByLogin: 'Alice' }),
    hashJson({ provider: 'github', baseUrl: '', login: 'alice', authMethod: 'github-app', installationId: 12, authorizedByLogin: 'alice' }));
  assert.strictEqual(identityKey({ login: 'alice', authMethod: 'github-app' }),
    hashJson({ provider: 'github', baseUrl: '', login: 'alice', authMethod: 'github-app', installationId: 0, authorizedByLogin: '' }));
  assert.notStrictEqual(identityKey({ login: 'alice' }), identityKey({ login: 'Alice' }), 'a login is kept as it is written');
}

/* The provider's host: github.com for GitHub, the base URL's host otherwise, nothing when it cannot be read. */
{
  assert.strictEqual(providerAuthority({}), 'github.com');
  assert.strictEqual(providerAuthority(null), 'github.com');
  assert.strictEqual(providerAuthority({ provider: 'github', baseUrl: 'https://ghe.example' }), 'github.com');
  assert.strictEqual(providerAuthority({ provider: 'gitea', baseUrl: 'https://Git.Example.com:8443/x' }), 'git.example.com:8443');
  assert.strictEqual(providerAuthority({ provider: 'gitea', baseUrl: 'not a url' }), '');
  assert.strictEqual(providerAuthority({ provider: 'gitea' }), '');
}

/* The stable identity the alpha binds: the installation for an App, the provider's account id, else the identity key. */
{
  const app = { login: 'erin', authMethod: 'github-app', installationId: '10', installationAccountId: 5, authorizedByLogin: 'x' };
  assert.strictEqual(stableProviderIdentityKey(app), hashJson({
    domain: 'nv-alpha-provider-identity/github-app/v1', provider: 'github', authority: 'github.com',
    authMethod: 'github-app', installationId: 10, installationAccountId: 5
  }));
  assert.strictEqual(stableProviderIdentityKey({ ...app, authorizedByLogin: 'someone else', login: 'other' }), stableProviderIdentityKey(app),
    'an installation is the same identity whoever authorized it');
  assert.strictEqual(stableProviderIdentityKey({ login: 'alice', providerAccountId: 42 }),
    hashJson({ domain: 'nv-alpha-provider-identity/account/v1', provider: 'github', authority: 'github.com', providerAccountId: 42 }));
  assert.strictEqual(stableProviderIdentityKey({ login: 'renamed', providerAccountId: '42' }), stableProviderIdentityKey({ login: 'alice', providerAccountId: 42 }),
    'a renamed login is the same person');
  for (const providerAccountId of [0, -3, 1.5, 2 ** 60, 'x', undefined]) {
    assert.strictEqual(stableProviderIdentityKey({ login: 'alice', providerAccountId }), identityKey({ login: 'alice' }), String(providerAccountId));
  }
}

/* Served accounts: GitHub on github.com, by refusal codes a request can be given. */
{
  for (const account of [{}, { provider: 'github' }, { baseUrl: 'https://github.com' }, { provider: 'github', baseUrl: '' }]) {
    assert.doesNotThrow(() => assertGithubAccount(account));
    assert.strictEqual(isGithubAccount(account), true);
  }
  for (const account of [null, undefined, 'text', 7, [], ['github'], { provider: 'gitea' }, { provider: null }]) {
    assert.throws(() => assertGithubAccount(account), error => error.status === 401 && error.code === 'PROVIDER_UNSUPPORTED'
      && error.message === 'Only GitHub accounts are supported. Sign in with GitHub.', JSON.stringify(account));
    assert.strictEqual(isGithubAccount(account), false);
  }
  assert.throws(() => assertGithubAccount({ baseUrl: 'https://ghe.example' }),
    error => error.status === 401 && error.code === 'PROVIDER_AUTHORITY_UNSUPPORTED' && error.message === 'Custom Git server URLs are not supported');
}

/* The session as a request may act through it. */
{
  const alice = { login: 'alice' };
  const bob = { login: 'bob', provider: 'github' };
  const retired = { login: 'old', provider: 'gitea', baseUrl: 'https://git.example' };
  const whole = { accounts: [alice, bob], active: 1, security: { stepUp: { action: 'x' } } };
  assert.strictEqual(githubSession(whole), whole, 'a session of GitHub accounts only is returned as it is');
  assert.strictEqual(githubSession(null), null);
  assert.strictEqual(githubSession({ accounts: 'none' }), null);
  assert.strictEqual(githubSession({ accounts: [retired] }), null, 'nothing a request may act through');
  assert.deepStrictEqual(githubSession({ accounts: [retired, alice, bob], active: 2, security: { sessionNonce: 'n', stepUp: { action: 'x' } }, other: 1 }), {
    accounts: [alice, bob], active: 1, retiredSelection: false, security: { sessionNonce: 'n', stepUp: null }, other: 1
  }, 'a retired account is left out, the selection follows its account, and step-up is dropped');
  assert.deepStrictEqual(githubSession({ accounts: [alice, retired], active: 1 }), {
    accounts: [alice], active: 0, retiredSelection: true, security: { stepUp: null }
  }, 'a retired selection is said, not replaced');
  /* The selection is clamped into the list before it is followed: [alice, retired, bob] read as [alice, bob]. */
  for (const [active, expected, retiredSelection] of [[-1, 0, false], [0, 0, false], ['1', 0, true], [2, 1, false], [9, 1, false], [undefined, 0, false], [Number.NaN, 0, false]]) {
    const read = githubSession({ accounts: [alice, retired, bob], active });
    assert.deepStrictEqual([read.active, read.retiredSelection], [expected, retiredSelection], String(active));
  }
  assert.deepStrictEqual(persistedSession({ accounts: [alice], retiredSelection: true, active: 0 }), { accounts: [alice], active: 0 });
  const plain = { accounts: [alice] };
  assert.strictEqual(persistedSession(plain), plain);
  assert.strictEqual(persistedSession(null), null);
  assert.strictEqual(persistedSession('text'), 'text');
}

/* Merging a field: the request's changes to what it read win; what it left alone keeps the other request's value. */
{
  assert.deepStrictEqual(mergeHostedSessionValue({ a: 1 }, { a: 1 }, { a: 2, b: 3 }), { a: 2, b: 3 }, 'nothing changed: the current value');
  assert.deepStrictEqual(mergeHostedSessionValue({ a: 1, b: 1 }, { a: 5, b: 1 }, { a: 2, b: 9, c: 4 }), { a: 5, b: 9, c: 4 });
  assert.deepStrictEqual(mergeHostedSessionValue({ a: 1, b: 1 }, { b: 2 }, { a: 7, b: 1 }), { b: 2 }, 'a field the request removed is removed');
  assert.deepStrictEqual(mergeHostedSessionValue({ a: { x: 1, y: 1 } }, { a: { x: 2, y: 1 } }, { a: { x: 1, y: 3 } }), { a: { x: 2, y: 3 } }, 'objects within objects');
  assert.deepStrictEqual(mergeHostedSessionValue([1], [2], [3]), [2], 'a list is replaced, not merged');
  assert.deepStrictEqual(mergeHostedSessionValue({ a: 1 }, { a: 2 }, 'text'), { a: 2 });
  const current = { deep: { list: [1] } };
  const merged = mergeHostedSessionValue({ x: 1 }, { x: 1 }, current);
  assert.notStrictEqual(merged.deep, current.deep, 'the result shares nothing with its inputs');
}

/* Merging the accounts: by who they are, the request's order first, and the selection by its account. */
{
  const a = { login: 'a' };
  const b = { login: 'b' };
  const c = { login: 'c' };
  const d = { login: 'd' };
  assert.strictEqual(hostedAccountKey(a), `github\0${identityKey(a)}`);
  assert.strictEqual(hostedAccountKey({ provider: 'gitea', login: 'a' }), `gitea\0${identityKey({ provider: 'gitea', login: 'a' })}`);
  const base = { accounts: [a, b], active: 0, theme: 'dark' };
  const desired = { accounts: [b, c], active: 1, theme: 'dark' };
  const current = { accounts: [a, b, d], active: 2, theme: 'light' };
  assert.deepStrictEqual(recomputeHostedSessionMutation(base, desired, current), {
    theme: 'light', accounts: [b, c, d], active: 1
  }, 'a removed, c added, d (the other request\'s) kept after; c selected where it now sits');
  const changed = { login: 'b', token: 'new' };
  assert.deepStrictEqual(recomputeHostedSessionMutation(base, { accounts: [a, changed], active: 0 }, { accounts: [a, { login: 'b', token: 'other' }] }).accounts,
    [a, changed], 'an account the request changed is written');
  assert.deepStrictEqual(recomputeHostedSessionMutation(base, { accounts: [a, b], active: 0 }, { accounts: [{ login: 'b', token: 'other' }, a] }).accounts,
    [a, { login: 'b', token: 'other' }], 'an account it left alone keeps the other request\'s value');
  assert.strictEqual(recomputeHostedSessionMutation(base, { accounts: [b], active: 0 }, { accounts: [] }).active, 0);
  assert.strictEqual(recomputeHostedSessionMutation(base, { accounts: [a], active: 4 }, { accounts: [a, d] }).active, 0, 'no selected account: the first');
  assert.deepStrictEqual(recomputeHostedSessionMutation(null, desired, current), desired, 'without a base, the request wins');
  assert.notStrictEqual(recomputeHostedSessionMutation({ accounts: 'none' }, desired, current), desired, 'a copy, not the request\'s object');
}

console.log('account identity tests passed');
