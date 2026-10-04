'use strict';

const crypto = require('crypto');
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Database-free sessions are a single-process profile. Starting a new process
// invalidates its predecessor's cookies, including any revoked by that process.
// Keep revocations until absolute expiry; never evict a live revocation to admit
// another, since that would silently make a logged-out cookie usable again.
function createLocalSessionPolicy({ now = Date.now, maxRevocations = 10000 } = {}) {
  const startedAt = now();
  const revoked = new Map();
  function valid(data) {
    const lifetime = data && data.lifetime;
    const time = now();
    return Boolean(lifetime && /^[0-9a-f]{48}$/.test(lifetime.id || '')
      && Number.isSafeInteger(lifetime.issuedAt) && Number.isSafeInteger(lifetime.expiresAt)
      && lifetime.issuedAt >= startedAt && lifetime.issuedAt <= time
      && lifetime.expiresAt > time && lifetime.expiresAt - lifetime.issuedAt <= ABSOLUTE_TTL_MS
      && !revoked.has(lifetime.id));
  }
  function prepare(data) {
    if (data.lifetime) {
      if (!valid(data)) throw Object.assign(new Error('Session expired; sign in again'), { status: 401 });
      return data;
    }
    const issuedAt = now();
    return { ...data, lifetime: { id: crypto.randomBytes(24).toString('hex'),
      issuedAt, expiresAt: issuedAt + ABSOLUTE_TTL_MS } };
  }
  function revoke(data) {
    if (!valid(data)) return;
    const time = now();
    for (const [id, expiresAt] of revoked) if (expiresAt <= time) revoked.delete(id);
    if (revoked.size >= maxRevocations) {
      throw Object.assign(new Error('Session revocation is unavailable; sign-out was not completed'), {
        status: 503, code: 'SESSION_REVOCATION_UNAVAILABLE'
      });
    }
    revoked.set(data.lifetime.id, data.lifetime.expiresAt);
  }
  return Object.freeze({ valid, prepare, revoke });
}

module.exports = { ABSOLUTE_TTL_MS, createLocalSessionPolicy };
