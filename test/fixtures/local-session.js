'use strict';
const crypto = require('crypto');

// For tests that deliberately seal a synthetic identity rather than logging in.
// Lifecycle tests use real login-issued cookies and do not use this helper.
function withLifetime(value) {
  if (!Array.isArray(value.accounts) || value.lifetime) return value;
  const issuedAt = Date.now();
  return { ...value, lifetime: { id: crypto.randomBytes(24).toString('hex'),
    issuedAt, expiresAt: issuedAt + 60 * 60 * 1000 } };
}
module.exports = { withLifetime };
