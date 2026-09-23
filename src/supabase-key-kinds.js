'use strict';

/*
 * What kind of Supabase key a string is, and nothing else.
 *
 * This lives apart from `src/anonymous-readability-probe.js` for one reason
 * that is worth stating: telling an anonymous key from a service-role key is
 * knowledge about text, and the probe module is knowledge about contacting a
 * service. The scanner needs the first and must never acquire the second --
 * a scan runs over somebody's whole repository, and the module that walks it
 * should not have an outbound transport anywhere in its import graph.
 *
 * The same separation is the probe's own design: discovery is free because
 * nobody has agreed to anything yet, and contact is not. This file is the
 * free half, so both callers share one definition of what a key is rather
 * than growing a second one that drifts.
 */

const KEY_KINDS = Object.freeze({
  ANON: 'anon',
  PUBLISHABLE: 'publishable',
  SERVICE_ROLE: 'service-role',
  SECRET: 'secret',
  USER_SESSION: 'user-session',
  UNKNOWN: 'unknown'
});

/*
 * The shape a key can have, used both to find one in a file and to bound what
 * is decoded. Two forms: the current prefixed keys -- publishable and secret,
 * which look alike and are nothing alike -- and a JWT, whose
 * header and payload both begin `eyJ` because both are base64url of a JSON
 * object. The lookarounds rather than `\b` because a key ends in characters
 * `\b` does not treat as a boundary, and `\b` after a trailing `-` would
 * refuse a perfectly ordinary key.
 */
const KEY_PATTERN = /(?<![A-Za-z0-9_.-])(?:sb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/;

/* A JWT nobody should be decoding in one gulp. A key is short; anything this
   long is not one, and the decode is skipped rather than attempted. */
const MAX_KEY_LENGTH = 8 * 1024;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function claimsOf(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/*
 * A public anonymous key is not a leaked administrator secret, and treating it
 * as one would make every project in every repository a critical finding.
 *
 * The opposite mistake is worse. Probing with a service-role key bypasses
 * every policy, so a row comes back whatever the project's configuration is:
 * the probe would prove nothing and would have used an administrator
 * credential to do it. A user session is refused for a related reason -- it
 * answers as a person, so a row proves that person can read, which is not the
 * question.
 */
function classifyKey(key) {
  const token = text(key);
  if (!token || token.length > MAX_KEY_LENGTH) return Object.freeze({ kind: KEY_KINDS.UNKNOWN, usable: false });
  if (/^sb_secret_/.test(token)) return Object.freeze({ kind: KEY_KINDS.SECRET, usable: false });
  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(token)) {
    return Object.freeze({ kind: KEY_KINDS.PUBLISHABLE, usable: true });
  }
  const claims = claimsOf(token);
  if (!claims) return Object.freeze({ kind: KEY_KINDS.UNKNOWN, usable: false });
  /* A subject means a person. Whatever its role says, it is somebody's
     session and not the anonymous role. */
  if (text(claims.sub)) return Object.freeze({ kind: KEY_KINDS.USER_SESSION, usable: false });
  const role = text(claims.role);
  if (role === 'service_role') return Object.freeze({ kind: KEY_KINDS.SERVICE_ROLE, usable: false });
  if (role === 'anon') return Object.freeze({ kind: KEY_KINDS.ANON, usable: true });
  if (role) return Object.freeze({ kind: KEY_KINDS.USER_SESSION, usable: false });
  return Object.freeze({ kind: KEY_KINDS.UNKNOWN, usable: false });
}

module.exports = Object.freeze({ KEY_KINDS, KEY_PATTERN, MAX_KEY_LENGTH, classifyKey });
