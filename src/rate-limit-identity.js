'use strict';

const crypto = require('crypto');

/*
 * The API rate limiter keyed its buckets on the session cookie as it arrived:
 *
 *   const key = (getCookie(req, 'nv_session') || req.ip || '').slice(0, 40);
 *
 * Two independent failures followed from that one expression.
 *
 * The cookie is caller-controlled text and nothing required it to unseal, so
 * any value at all opened a fresh bucket and a caller that varied it per
 * request was never limited at all. Those forged keys also accumulated in the
 * bucket map, whose overflow path deletes oldest-first, so unauthenticated
 * traffic could evict the counters of authenticated callers.
 *
 * The prefix also carried no session identity. `seal` is AES-256-GCM with a
 * random 12-byte IV, and 40 base64url characters cover 30 bytes: the IV, the
 * whole 16-byte authentication tag, and two bytes of ciphertext. Both of those
 * fields are drawn fresh on every seal, so re-issuing a cookie for an unchanged
 * session produced a different key and returned that session to zero — which
 * the server does on its own whenever it writes a session back.
 *
 * Identity therefore has to be read from inside the sealed payload, which a
 * caller cannot forge without SESSION_SECRET, and from a field that survives a
 * reseal. `sid` is that field when a database holds the session, and setSession
 * carries it across writes rather than minting a new one. `sessionNonce` is
 * that field when the cookie carries the session itself, and
 * ensureSessionSecurity issues it once and leaves it alone. The active account
 * covers the window after sign-in and before a nonce exists. A request with no
 * session, or one whose cookie does not unseal, is counted against its address.
 *
 * Keys are HMACs under a purpose-derived key rather than the identifiers
 * themselves, so the bucket map holds no session id, nonce or login, and a
 * value taken from one namespace cannot be replayed into another.
 */

const IDENTITY_KINDS = Object.freeze({
  SESSION: 'session',
  ACCOUNT: 'account',
  ADDRESS: 'address',
  UNATTRIBUTED: 'unattributed'
});

const MAX_IDENTITY_BYTES = 512;
const DIGEST_CHARS = 32;

/* A field is only usable as identity if it is text the payload actually holds. */
function stableText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_IDENTITY_BYTES) return '';
  return text;
}

function activeAccount(session) {
  const accounts = Array.isArray(session.accounts) ? session.accounts : [];
  if (!accounts.length) return null;
  const index = Number.isInteger(session.active) && session.active >= 0 && session.active < accounts.length
    ? session.active
    : 0;
  const account = accounts[index];
  return account && typeof account === 'object' ? account : null;
}

/*
 * Precedence runs from the most session-scoped field to the least. Returning
 * the kind alongside the parts keeps the namespace in the signed message, so a
 * session identity and an address identity cannot collide even if their
 * remaining parts were ever to match.
 */
function identityOf(session, address) {
  if (session && typeof session === 'object') {
    const sid = stableText(session.sid);
    if (sid) return { kind: IDENTITY_KINDS.SESSION, parts: ['sid', sid] };

    const security = session.security && typeof session.security === 'object' ? session.security : {};
    const nonce = stableText(security.sessionNonce);
    if (nonce) return { kind: IDENTITY_KINDS.SESSION, parts: ['nonce', nonce] };

    const account = activeAccount(session);
    if (account) {
      const login = stableText(account.login);
      if (login) {
        return {
          kind: IDENTITY_KINDS.ACCOUNT,
          parts: [stableText(account.provider) || 'github', stableText(account.baseUrl), login]
        };
      }
    }
  }

  const ip = stableText(address);
  if (ip) return { kind: IDENTITY_KINDS.ADDRESS, parts: [ip] };

  /*
   * Express populates req.ip from the trusted hop, so this is reached only if
   * the socket has no remote address. One shared bucket is the safe reading:
   * an unattributable request must not get a private allowance.
   */
  return { kind: IDENTITY_KINDS.UNATTRIBUTED, parts: [] };
}

/*
 * Parts are length-prefixed before hashing so that no arrangement of one
 * identity's fields can produce another's message — a login containing the
 * separator would otherwise be able to impersonate a provider and login pair.
 */
function identityMessage(kind, parts) {
  return [kind, ...parts].map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

/*
 * Returns the bucket key for a request, and the kind it was attributed to so a
 * caller can keep namespaces apart or report on attribution without holding the
 * identity itself.
 */
function rateLimitIdentity({ session, address, hmacKey, namespace = 'api' }) {
  if (!Buffer.isBuffer(hmacKey) && typeof hmacKey !== 'string') {
    throw new TypeError('Rate limit identity requires a derived HMAC key');
  }
  const scope = stableText(namespace);
  if (!scope) throw new TypeError('Rate limit identity requires a namespace');

  const { kind, parts } = identityOf(session, address);
  const digest = crypto
    .createHmac('sha256', hmacKey)
    .update(identityMessage(kind, parts), 'utf8')
    .digest('base64url')
    .slice(0, DIGEST_CHARS);

  return { key: `${scope}:${kind}:${digest}`, kind };
}

module.exports = Object.freeze({
  IDENTITY_KINDS,
  MAX_IDENTITY_BYTES,
  rateLimitIdentity
});
