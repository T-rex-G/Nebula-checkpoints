'use strict';
/*
 * The session cookie (apps/api/src/platform/authorization/session-cookie.ts):
 * its seal, which opens only under its own key and reads anything else as no
 * value; how a cookie is read from the request; and how the session cookie is
 * written.
 */
const assert = require('assert');
const crypto = require('crypto');
const {
  createSessionSeal, readCookie, createSessionCookieWriter, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE
} = require('../apps/api/src/platform/authorization/session-cookie.ts');
const { deriveKey, KEY_PURPOSES } = require('../apps/api/src/platform/crypto/key-derivation.ts');

const key = deriveKey('k'.repeat(48), KEY_PURPOSES.SESSION_CONTENT);
const { seal, unseal } = createSessionSeal(key);

/* The seal: AES-256-GCM, IV then tag then ciphertext, base64url -- the format every test cookie in this repository builds. */
{
  const value = { sid: 'a'.repeat(48), nested: { list: [1, 'two', null] } };
  const sealed = seal(value);
  assert.match(sealed, /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  assert.deepStrictEqual(unseal(sealed), value);
  const raw = Buffer.from(sealed, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  assert.deepStrictEqual(JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')), value,
    'twelve bytes of IV, sixteen of tag, then the ciphertext');
  assert.strictEqual(raw.length, 12 + 16 + Buffer.byteLength(JSON.stringify(value)));
  assert.notStrictEqual(seal(value), sealed, 'each seal draws its own IV');
  assert.deepStrictEqual(unseal(seal('text')), 'text');
  assert.strictEqual(unseal(seal(null)), null);
}

/* Anything that does not open is no value: another key, a changed byte, a cut, nothing, or not JSON. */
{
  const sealed = seal({ sid: 'b'.repeat(48) });
  assert.strictEqual(createSessionSeal(deriveKey('other'.repeat(10), KEY_PURPOSES.SESSION_CONTENT)).unseal(sealed), null);
  const raw = Buffer.from(sealed, 'base64url');
  raw[raw.length - 1] ^= 1;
  assert.strictEqual(unseal(raw.toString('base64url')), null, 'a changed ciphertext byte');
  const tag = Buffer.from(sealed, 'base64url');
  tag[20] ^= 1;
  assert.strictEqual(unseal(tag.toString('base64url')), null, 'a changed tag byte');
  assert.strictEqual(unseal(sealed.slice(0, 30)), null);
  assert.strictEqual(unseal(''), null);
  assert.strictEqual(unseal('not base64url at all!'), null);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update('{not json', 'utf8'), cipher.final()]);
  assert.strictEqual(unseal(Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')), null, 'opens, but is not JSON');
}

/* Reading a cookie: the first of a name, trimmed, and nothing for what is not there. */
{
  const req = cookie => ({ headers: cookie === undefined ? {} : { cookie } });
  assert.strictEqual(readCookie(req(undefined), 'nv_session'), null);
  assert.strictEqual(readCookie(req(''), 'nv_session'), null);
  assert.strictEqual(readCookie(req('theme=dark'), 'nv_session'), null);
  assert.strictEqual(readCookie(req('nv_session=abc'), 'nv_session'), 'abc');
  assert.strictEqual(readCookie(req('theme=dark;   nv_session=abc  ; x=1'), 'nv_session'), 'abc');
  assert.strictEqual(readCookie(req('nv_session=first; nv_session=second'), 'nv_session'), 'first');
  assert.strictEqual(readCookie(req('nosuchpair; =x; nv_session=v=with=equals'), 'nv_session'), 'v=with=equals');
  assert.strictEqual(readCookie(req('nv_session_other=1; xnv_session=2'), 'nv_session'), null, 'a name is matched whole');
  assert.strictEqual(readCookie(req('nv_session='), 'nv_session'), '', 'an empty value is a value');
}

/* Writing it: HTTP-only, Lax, the whole site, thirty days unless told, and Secure only in production, asked each time. */
{
  let production = false;
  const write = createSessionCookieWriter(() => production);
  const headers = [];
  const res = { setHeader: (name, value) => headers.push([name, value]) };
  write(res, 'abc');
  production = true;
  write(res, 'def', 60);
  write(res, '', 0);
  assert.deepStrictEqual(headers, [
    ['Set-Cookie', 'nv_session=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000'],
    ['Set-Cookie', 'nv_session=def; HttpOnly; SameSite=Lax; Path=/; Max-Age=60; Secure'],
    ['Set-Cookie', 'nv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure']
  ]);
  assert.strictEqual(SESSION_COOKIE, 'nv_session');
  assert.strictEqual(SESSION_COOKIE_MAX_AGE, 30 * 24 * 60 * 60);
}

console.log('session cookie tests passed');
