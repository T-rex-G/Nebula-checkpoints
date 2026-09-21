'use strict';

const assert = require('assert');
const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');
const { IDENTITY_KINDS, MAX_IDENTITY_BYTES, rateLimitIdentity } = require('../src/rate-limit-identity');

const hmacKey = deriveKey('rate-limit-identity-test-secret-0123456789abcdef', KEY_PURPOSES.RATE_LIMIT_IDENTITY);
const account = { provider: 'gitea', authMethod: 'token', login: 'fixture-user', token: 'fixture-token', baseUrl: 'https://gitea.example' };

function keyFor(session, address = '198.51.100.7', namespace = 'api') {
  return rateLimitIdentity({ session, address, hmacKey, namespace });
}

/* A database-backed session identifies itself by sid, which setSession carries across writes. */
{
  const a = keyFor({ sid: 'a'.repeat(48) });
  const b = keyFor({ sid: 'a'.repeat(48) }, '203.0.113.9');
  assert.strictEqual(a.kind, IDENTITY_KINDS.SESSION);
  assert.strictEqual(a.key, b.key, 'a sid identifies a session wherever the request came from');
  assert.notStrictEqual(a.key, keyFor({ sid: 'b'.repeat(48) }).key, 'distinct sids are distinct buckets');
}

/* A cookie-borne session identifies itself by the nonce ensureSessionSecurity issues once. */
{
  const nonce = 'c'.repeat(48);
  const first = keyFor({ accounts: [account], active: 0, security: { sessionNonce: nonce, stepUp: null } });
  const afterStepUp = keyFor({
    accounts: [account, { ...account, login: 'second' }],
    active: 1,
    security: { sessionNonce: nonce, stepUp: { scope: 'x' } }
  });
  assert.strictEqual(first.kind, IDENTITY_KINDS.SESSION);
  assert.strictEqual(
    first.key, afterStepUp.key,
    'a nonce outlives the session content around it, which is what survives a reseal'
  );
}

/* sid wins over a nonce: the database is the session's identity when there is one. */
{
  const withBoth = keyFor({ sid: 'd'.repeat(48), security: { sessionNonce: 'e'.repeat(48) } });
  assert.strictEqual(withBoth.key, keyFor({ sid: 'd'.repeat(48) }).key, 'sid takes precedence over a nonce');
}

/* Between sign-in and the first nonce, the active account is the stable field. */
{
  const signedIn = keyFor({ accounts: [account], active: 0 });
  assert.strictEqual(signedIn.kind, IDENTITY_KINDS.ACCOUNT);
  assert.strictEqual(signedIn.key, keyFor({ accounts: [account], active: 0 }, '203.0.113.9').key);
  assert.notStrictEqual(
    signedIn.key, keyFor({ accounts: [{ ...account, login: 'other' }], active: 0 }).key,
    'a different login is a different bucket'
  );
  /* An out-of-range active index must resolve, not throw or read undefined. */
  assert.strictEqual(keyFor({ accounts: [account], active: 7 }).key, signedIn.key);
  assert.strictEqual(keyFor({ accounts: [account], active: -1 }).key, signedIn.key);
}

/*
 * The defect this module exists to close: a cookie that does not unseal gives
 * no session at all, so every such request lands in one bucket per address.
 */
{
  const forged = keyFor(null);
  assert.strictEqual(forged.kind, IDENTITY_KINDS.ADDRESS);
  assert.strictEqual(forged.key, keyFor(undefined).key);
  assert.strictEqual(forged.key, keyFor('not-a-session').key);
  assert.strictEqual(forged.key, keyFor({}).key, 'an object with no usable field is not an identity');
  assert.strictEqual(forged.key, keyFor({ accounts: [] }).key);
  assert.strictEqual(forged.key, keyFor({ sid: '   ' }).key, 'blank text is not a sid');
  assert.strictEqual(forged.key, keyFor({ sid: 42 }).key, 'a non-string sid is not a sid');
  assert.notStrictEqual(forged.key, keyFor(null, '203.0.113.9').key, 'addresses stay independent');
}

/* An oversized field cannot be used as identity, and falls through to the next one. */
{
  const huge = 'x'.repeat(MAX_IDENTITY_BYTES + 1);
  assert.strictEqual(keyFor({ sid: huge }).key, keyFor(null).key, 'an oversized sid is not an identity');
  assert.strictEqual(
    keyFor({ sid: huge, security: { sessionNonce: 'f'.repeat(48) } }).key,
    keyFor({ security: { sessionNonce: 'f'.repeat(48) } }).key,
    'an unusable sid falls through to the nonce rather than to the address'
  );
}

/* A request with neither a session nor an address shares one bucket, never a private allowance. */
{
  const unattributed = keyFor(null, '');
  assert.strictEqual(unattributed.kind, IDENTITY_KINDS.UNATTRIBUTED);
  assert.strictEqual(
    unattributed.key,
    rateLimitIdentity({ session: null, hmacKey, namespace: 'api' }).key,
    'an absent address and a blank one are the same non-identity'
  );
  assert.notStrictEqual(unattributed.key, keyFor(null).key);
}

/* Namespaces keep separate limiters apart, so the API budget is not the webhook budget. */
{
  const api = keyFor({ sid: 'g'.repeat(48) }, '198.51.100.7', 'api');
  const webhook = keyFor({ sid: 'g'.repeat(48) }, '198.51.100.7', 'webhook');
  assert.notStrictEqual(api.key, webhook.key);
  assert.strictEqual(api.key.startsWith('api:'), true);
  assert.strictEqual(webhook.key.startsWith('webhook:'), true);
}

/*
 * Parts are length-prefixed before hashing. Under a plain separator these two
 * accounts produce the same message, so one could spend the other's budget.
 */
{
  const split = keyFor({ accounts: [{ provider: 'a', baseUrl: 'b|c', login: 'd' }], active: 0 });
  const shifted = keyFor({ accounts: [{ provider: 'a', baseUrl: 'b', login: 'c|d' }], active: 0 });
  assert.notStrictEqual(
    split.key, shifted.key,
    'a separator inside a field must not let one identity produce another'
  );
}

/* The map holds a digest, never the identifier that produced it. */
{
  const sid = 'h'.repeat(48);
  const login = 'leakable-login';
  assert.strictEqual(keyFor({ sid }).key.includes(sid), false, 'a bucket key must not carry the sid');
  assert.strictEqual(
    keyFor({ accounts: [{ ...account, login }], active: 0 }).key.includes(login), false,
    'a bucket key must not carry a login'
  );
  assert.strictEqual(
    keyFor(null).key.includes('198.51.100.7'), false, 'a bucket key must not carry an address'
  );
}

/* Derivation is keyed: the same identity under a different secret is a different bucket. */
{
  const other = deriveKey('a-different-secret-0123456789abcdef-0123', KEY_PURPOSES.RATE_LIMIT_IDENTITY);
  assert.notStrictEqual(
    keyFor({ sid: 'i'.repeat(48) }).key,
    rateLimitIdentity({ session: { sid: 'i'.repeat(48) }, address: '198.51.100.7', hmacKey: other, namespace: 'api' }).key
  );
}

/* Misconfiguration fails loudly rather than collapsing every caller into one bucket. */
assert.throws(() => rateLimitIdentity({ session: null, address: '1.2.3.4', namespace: 'api' }), /derived HMAC key/);
assert.throws(() => rateLimitIdentity({ session: null, address: '1.2.3.4', hmacKey, namespace: '' }), /namespace/);

console.log('rate-limit-identity: ok');
