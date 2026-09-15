'use strict';

const assert = require('assert');
const {
  AlphaAccessError,
  parseInviteCode,
  digestInviteSecret,
  canonicalRepositoryScope,
  parseRepositoryScope,
  repositoryAllowed,
  inviteUnbound
} = require('../src/alpha-access');

function assertScopeInvalid(callback, label) {
  assert.throws(
    callback,
    error => error instanceof AlphaAccessError
      && error.code === 'ALPHA_SCOPE_INVALID'
      && error.status === 400,
    label
  );
}

const invite = 'nvx_alpha_01k123456789abcdefghjkmnpq.6KQJ8j-MVrSoxFmLw2vknjCieD7v4u_9h2A';
const parsed = parseInviteCode(invite);
assert.deepStrictEqual(parsed, {
  publicId: '01k123456789abcdefghjkmnpq',
  secret: '6KQJ8j-MVrSoxFmLw2vknjCieD7v4u_9h2A'
});

for (const malformed of [
  'wrong',
  `nvx_alpha_${'a'.repeat(19)}.${'A'.repeat(32)}`,
  `nvx_alpha_${'a'.repeat(41)}.${'A'.repeat(32)}`,
  `nvx_alpha_${'A'.repeat(20)}.${'A'.repeat(32)}`,
  `nvx_alpha_${'a'.repeat(20)}.${'A'.repeat(31)}`,
  `nvx_alpha_${'a'.repeat(20)}.${'A'.repeat(129)}`,
  `nvx_alpha_${'a'.repeat(20)}.${'A'.repeat(31)}=`,
  `nvx_alpha_${'a'.repeat(20)}.${'A'.repeat(31)}.`
]) {
  assert.throws(
    () => parseInviteCode(malformed),
    error => error instanceof AlphaAccessError
      && error.code === 'ALPHA_INVITE_INVALID'
      && error.status === 403,
    `invite must be rejected: ${malformed.slice(0, 60)}`
  );
}

const pepper = '0123456789abcdef0123456789abcdef';
assert.strictEqual(
  digestInviteSecret(pepper, parsed.publicId, parsed.secret),
  '9af5899d04ce5809bc8d0281cb6c24ce4482bc71b3842143b8612587e3f4c3e8'
);
assert.strictEqual(
  digestInviteSecret(pepper, parsed.publicId, parsed.secret),
  digestInviteSecret(pepper, parsed.publicId, parsed.secret)
);
assert.throws(
  () => digestInviteSecret('x'.repeat(31), parsed.publicId, parsed.secret),
  /at least 32 bytes/
);
assert.throws(
  () => digestInviteSecret(`${'é'.repeat(15)}a`, parsed.publicId, parsed.secret),
  /at least 32 bytes/
);
assert.match(
  digestInviteSecret('é'.repeat(16), parsed.publicId, parsed.secret),
  /^[0-9a-f]{64}$/
);
assert.throws(
  () => digestInviteSecret(pepper, 'a'.repeat(19), 'A'.repeat(32)),
  /invitation format/
);
assert.throws(
  () => digestInviteSecret(
    pepper,
    'a'.repeat(20),
    `${'A'.repeat(31)}\0`
  ),
  /invitation format/
);

assert.strictEqual(canonicalRepositoryScope({
  provider: 'GitHub',
  authority: 'GITHUB.COM',
  owner: 'Acme',
  repo: 'Demo'
}), 'github:github.com/acme/demo');
assertScopeInvalid(
  () => canonicalRepositoryScope({
    provider: 'github',
    authority: '',
    owner: 'ACME',
    repo: 'DEMO'
  }),
  'GitHub authority must be an explicit own string field'
);
assert.strictEqual(canonicalRepositoryScope({
  provider: 'gitea',
  authority: 'https://Gitea.Example.com/',
  owner: 'Acme',
  repo: 'Demo'
}), 'gitea:gitea.example.com/acme/demo');
assert.strictEqual(canonicalRepositoryScope({
  provider: 'GitLab',
  authority: 'GitLab.Example.com',
  owner: 'Acme',
  repo: 'Demo'
}), 'gitlab:gitlab.example.com/acme/demo');
assert.strictEqual(canonicalRepositoryScope({
  provider: 'gitea',
  authority: 'https://XN--BCHER-KVA.Example/',
  owner: 'Acme',
  repo: 'Demo'
}), 'gitea:xn--bcher-kva.example/acme/demo');

for (const authority of [
  'http://gitea.example.com',
  'ftp://gitea.example.com',
  'https://user@gitea.example.com',
  'https://user:password@gitea.example.com',
  'https://gitea.example.com:443',
  'https://gitea.example.com/path',
  'https://gitea.example.com/.',
  'https://gitea.example.com/%2e%2e',
  'https://gitea.example.com?',
  'https://gitea.example.com?query=yes',
  'https://gitea.example.com#',
  'https://gitea.example.com#fragment',
  '//gitea.example.com',
  'gitea.example.com/path',
  'gitea_example.com',
  'gitea..example.com'
]) {
  assertScopeInvalid(
    () => canonicalRepositoryScope({
      provider: 'gitea',
      authority,
      owner: 'acme',
      repo: 'demo'
    }),
    `authority must be rejected: ${authority}`
  );
}

for (const authority of [
  'https://gitea.example.com/./',
  'gitea.example.com/./',
  'https://gitea.example.com/../admin',
  'gitea.example.com/../admin',
  'https://gitea.example.com/%2e',
  'gitea.example.com/%2e',
  'https://gitea.example.com/%2e%2e/admin',
  'gitea.example.com/%2e%2e/admin',
  'https://gitea.example.com/%2fadmin',
  'gitea.example.com/%2fadmin',
  'https://gitea.example.com\\@evil.example',
  'gitea.example.com\\@evil.example',
  'https://gitea%2eexample.com',
  'gitea%2eexample.com',
  'https://gitea.example.com%2f.evil.example',
  'gitea.example.com%2f.evil.example',
  'https://gitea.example.com\t.evil.example',
  'gitea.example.com\t.evil.example',
  'https://gitea.example.com\n.evil.example',
  'gitea.example.com\n.evil.example',
  'https://gitea.example.com\0.evil.example',
  'gitea.example.com\0.evil.example',
  '127.0.0.1',
  'https://127.0.0.1',
  '127.1',
  'https://127.1',
  '2130706433',
  'https://2130706433',
  '0x7f000001',
  'https://0x7f000001',
  'bücher.example',
  'https://bücher.example',
  'xn--',
  'https://xn--'
]) {
  assertScopeInvalid(
    () => canonicalRepositoryScope({
      provider: 'gitea',
      authority,
      owner: 'acme',
      repo: 'demo'
    }),
    `lexically unsafe Gitea authority must be rejected: ${JSON.stringify(authority)}`
  );
}

for (const authority of [
  'https://github.com/./',
  'github.com/./',
  'https://github.com/%2e%2e/admin',
  'github.com/%2e%2e/admin',
  'https://github.com/%2fadmin',
  'github.com/%2fadmin',
  'https://github.com\\@evil.example',
  'github.com\\@evil.example',
  'https://github%2ecom',
  'github%2ecom',
  'https://github.com\t.evil.example',
  'github.com\n.evil.example',
  'https://github.com\0.evil.example',
  '127.1',
  'https://127.1',
  '2130706433',
  'https://2130706433',
  'github.com/team'
]) {
  assertScopeInvalid(
    () => canonicalRepositoryScope({
      provider: 'github',
      authority,
      owner: 'acme',
      repo: 'demo'
    }),
    `lexically unsafe GitHub authority must be rejected: ${JSON.stringify(authority)}`
  );
}

assertScopeInvalid(
  () => canonicalRepositoryScope({
    provider: 'github',
    authority: 'gitlab.com',
    owner: 'acme',
    repo: 'demo'
  }),
  'GitHub authority must remain pinned to github.com'
);

for (const invalid of [
  { provider: 'bitbucket', authority: 'bitbucket.org', owner: 'acme', repo: 'demo' },
  { provider: 'github', authority: 'github.com', owner: '', repo: 'demo' },
  { provider: 'github', authority: 'github.com', owner: 'acme/team', repo: 'demo' },
  { provider: 'github', authority: 'github.com', owner: 'acme', repo: '' },
  { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo repo' },
  { provider: 'github', authority: 'github.com', owner: '.', repo: 'demo' },
  { provider: 'github', authority: 'github.com', owner: 'acme', repo: '..' },
  { provider: 'github', authority: 'github.com', owner: 'a'.repeat(201), repo: 'demo' },
  { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'démo' }
]) {
  assertScopeInvalid(
    () => canonicalRepositoryScope(invalid),
    'invalid repository field must fail with ALPHA_SCOPE_INVALID'
  );
}

const inheritedScope = Object.create({
  provider: 'github',
  authority: 'github.com',
  owner: 'acme',
  repo: 'demo'
});
const inheritedAuthority = Object.create({ authority: 'github.com' });
Object.assign(inheritedAuthority, {
  provider: 'github',
  owner: 'acme',
  repo: 'demo'
});
const accessorScope = {
  provider: 'github',
  owner: 'acme',
  repo: 'demo'
};
Object.defineProperty(accessorScope, 'authority', {
  enumerable: true,
  get: () => 'github.com'
});
const nullPrototypeScope = Object.assign(Object.create(null), {
  provider: 'github',
  authority: 'github.com',
  owner: 'acme',
  repo: 'demo'
});

for (const invalid of [
  null,
  undefined,
  'github:github.com/acme/demo',
  [],
  inheritedScope,
  inheritedAuthority,
  accessorScope,
  nullPrototypeScope,
  {
    provider: new String('github'),
    authority: 'github.com',
    owner: 'acme',
    repo: 'demo'
  },
  {
    provider: 'github',
    authority: null,
    owner: 'acme',
    repo: 'demo'
  },
  {
    provider: 'github',
    authority: 'github.com',
    owner: 7,
    repo: 'demo'
  }
]) {
  assertScopeInvalid(
    () => canonicalRepositoryScope(invalid),
    'repository scope input must be a plain object with own string fields'
  );
}

assert.deepStrictEqual(
  parseRepositoryScope('GitLab:GITLAB.COM/Acme/Demo'),
  {
    provider: 'gitlab',
    authority: 'gitlab.com',
    owner: 'acme',
    repo: 'demo',
    canonical: 'gitlab:gitlab.com/acme/demo'
  }
);
assert.throws(
  () => parseRepositoryScope('github:github.com/acme/demo/extra'),
  error => error instanceof AlphaAccessError
    && error.code === 'ALPHA_SCOPE_INVALID'
);
for (const invalid of [
  null,
  undefined,
  7,
  new String('github:github.com/acme/demo'),
  { toString: () => 'github:github.com/acme/demo' }
]) {
  assertScopeInvalid(
    () => parseRepositoryScope(invalid),
    'stored repository scope must be a primitive string'
  );
}

assert.strictEqual(repositoryAllowed(
  [
    'github:github.com/acme/demo',
    'GitHub:GITHUB.COM/ACME/DEMO'
  ],
  { provider: 'github', authority: 'github.com', owner: 'ACME', repo: 'DEMO' }
), true);
assert.strictEqual(repositoryAllowed(
  ['github:github.com/acme/demo'],
  { provider: 'gitlab', authority: 'github.com', owner: 'acme', repo: 'demo' }
), false);
assert.strictEqual(repositoryAllowed(
  ['github:github.com/acme/demo'],
  { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'production' }
), false);
assert.strictEqual(repositoryAllowed(
  ['github:github.com/acme/demo', 'not-a-scope'],
  { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' }
), false);
assert.strictEqual(repositoryAllowed(
  'github:github.com/acme/demo',
  { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' }
), false);

/*
 * An unbound invitation: no scopes, so no list to stay inside. The whole of
 * the repository restriction lived in the database -- the column required
 * between one and twenty scopes -- so this predicate is the application half
 * of relaxing that floor to zero.
 */
assert.strictEqual(inviteUnbound([]), true, 'an empty scope list is unbound');

/*
 * And nothing else is. A scope list that failed to load must read as "refuse",
 * never as "permit": undefined is what a missing field looks like, and it is
 * the shape most likely to appear if the session store ever changes.
 */
[undefined, null, 0, '', false, {}, 'github:github.com/acme/demo', [''], ['github:github.com/acme/demo']]
  .forEach(value => {
    assert.strictEqual(inviteUnbound(value), false,
      `${JSON.stringify(value) || String(value)} must not read as an unbound invitation`);
  });

/* A scoped invitation is unchanged: it is bound, and still checked. */
assert.strictEqual(inviteUnbound(['github:github.com/acme/demo']), false);
assert.strictEqual(repositoryAllowed(
  ['github:github.com/acme/demo'],
  { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' }
), true);

console.log('alpha access domain tests passed');
