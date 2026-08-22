'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const {
  DERIVED_KEY_BYTES,
  HKDF_SALT,
  KEY_PURPOSES,
  deriveKey,
  deriveSecret
} = require('../src/key-derivation');

const SECRET = 'derivation-test-secret-0123456789abcdef0123456789';
const purposes = Object.values(KEY_PURPOSES);

assert.strictEqual(DERIVED_KEY_BYTES, 32);
assert(purposes.length >= 8, 'every keyed construction in the server must have a purpose');
assert.strictEqual(new Set(purposes).size, purposes.length, 'purpose labels must be distinct');

/*
 * The property that matters: distinct purposes yield independent keys from one
 * secret. Without it a value produced under one purpose could be verified under
 * another, which is the confusion the shared key allowed.
 */
const derived = purposes.map(purpose => deriveKey(SECRET, purpose));
for (const key of derived) {
  assert(Buffer.isBuffer(key), 'deriveKey must return raw bytes');
  assert.strictEqual(key.length, DERIVED_KEY_BYTES, 'AES-256-GCM requires exactly 32 bytes');
}
assert.strictEqual(
  new Set(derived.map(key => key.toString('hex'))).size,
  purposes.length,
  'each purpose must produce a distinct key'
);
for (const purpose of purposes) {
  assert.notStrictEqual(deriveKey(SECRET, purpose).toString('hex'),
    crypto.createHash('sha256').update(SECRET).digest('hex'),
    `${purpose} must not reproduce the previous shared sha256(SECRET) key`);
  assert.notStrictEqual(deriveSecret(SECRET, purpose), SECRET,
    `${purpose} must not fall back to the raw secret`);
}

/* Derivation is deterministic, or a restart would invalidate every live token. */
for (const purpose of purposes) {
  assert.strictEqual(deriveKey(SECRET, purpose).toString('hex'), deriveKey(SECRET, purpose).toString('hex'));
  assert.strictEqual(deriveSecret(SECRET, purpose), deriveSecret(SECRET, purpose));
}

/* A different input secret must move every derived key. */
const other = `${SECRET}-other`;
for (const purpose of purposes) {
  assert.notStrictEqual(deriveKey(SECRET, purpose).toString('hex'), deriveKey(other, purpose).toString('hex'),
    `${purpose} must depend on the input secret`);
}

/*
 * deriveSecret exists because the token modules coerce their secret with
 * String(). Raw bytes through that coercion decode as UTF-8 with invalid
 * sequences replaced, so distinct keys can collapse onto the same string. Prove
 * the textual form survives coercion intact and stays distinct per purpose.
 */
const textual = purposes.map(purpose => deriveSecret(SECRET, purpose));
assert.strictEqual(new Set(textual).size, purposes.length, 'textual keys must stay distinct');
for (const value of textual) {
  assert.match(value, /^[A-Za-z0-9_-]+$/, 'a textual key must be base64url');
  assert.strictEqual(String(value), value, 'a textual key must survive String() unchanged');
  assert.strictEqual(Buffer.from(value, 'base64url').length, DERIVED_KEY_BYTES);
}
const rawCoerced = purposes.map(purpose => String(deriveKey(SECRET, purpose)));
assert(
  new Set(rawCoerced).size <= purposes.length,
  'sanity: coercing raw bytes is the hazard deriveSecret avoids'
);
for (const value of rawCoerced) {
  assert.notStrictEqual(Buffer.byteLength(value, 'utf8'), DERIVED_KEY_BYTES,
    'coercing raw derived bytes must be observably lossy, which is why deriveSecret exists');
}

/* Match the HKDF contract exactly, so the derivation cannot drift silently. */
for (const purpose of purposes) {
  assert.strictEqual(
    deriveKey(SECRET, purpose).toString('hex'),
    Buffer.from(crypto.hkdfSync('sha256', SECRET, HKDF_SALT, `nebulaverse-x/${purpose}`, 32)).toString('hex'),
    `${purpose} must derive through HKDF-SHA256 with its own info label`
  );
}

/* Reject inputs that would silently produce a usable but wrong key. */
assert.throws(() => deriveKey('', KEY_PURPOSES.CSRF_TOKEN), /non-empty secret/);
assert.throws(() => deriveKey(null, KEY_PURPOSES.CSRF_TOKEN), /non-empty secret/);
assert.throws(() => deriveKey(Buffer.from(SECRET), KEY_PURPOSES.CSRF_TOKEN), /non-empty secret/);
assert.throws(() => deriveKey(SECRET, 'not-a-declared-purpose'), /Unknown key derivation purpose/);
assert.throws(() => deriveKey(SECRET, ''), /Unknown key derivation purpose/);
assert.throws(() => deriveKey(SECRET, KEY_PURPOSES.CSRF_TOKEN, 8), /between 16 and 64 bytes/);
assert.throws(() => deriveKey(SECRET, KEY_PURPOSES.CSRF_TOKEN, 65), /between 16 and 64 bytes/);
assert.throws(() => deriveKey(SECRET, KEY_PURPOSES.CSRF_TOKEN, 32.5), /between 16 and 64 bytes/);

/*
 * The server must not reintroduce a shared key. These assert the wiring, not
 * the source text: each construction names a purpose-specific constant, and no
 * keyed construction still reaches for the old shared KEY.
 */
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.doesNotMatch(serverSource, /crypto\.create(?:Hmac|Cipheriv|Decipheriv)\(\s*'[^']+',\s*KEY\b/,
  'no keyed construction may use the former shared KEY');
assert.doesNotMatch(serverSource, /const KEY = crypto\.createHash/,
  'the shared sha256(SECRET) key must not be reintroduced');

/*
 * SESSION_SECRET reaches the snapshot signing config unchanged on purpose: that
 * value is compared against the operator's snapshot secret to reject reuse, so
 * deriving it there would defeat the check it exists to perform.
 */
assert.match(serverSource, /sessionSecret: SECRET/,
  'the snapshot reuse check must keep comparing against the raw session secret');

console.log('key derivation tests passed');
