'use strict';

const crypto = require('crypto');
const { domainToASCII, domainToUnicode } = require('url');

class AlphaAccessError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'AlphaAccessError';
    this.code = code;
    this.status = status;
  }
}

const PUBLIC_ID_RX = /^[0-9a-z]{20,40}$/;
const SECRET_RX = /^[A-Za-z0-9_-]{32,128}$/;
const REPO_PART_RX = /^[A-Za-z0-9_.-]{1,200}$/;
const HOSTNAME_RX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const IPV4_ALIAS_RX = /^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}$/i;
const SCOPE_FIELDS = Object.freeze(['provider', 'authority', 'owner', 'repo']);

function invalidInvite() {
  return new AlphaAccessError(
    'Invitation could not be redeemed',
    'ALPHA_INVITE_INVALID',
    403
  );
}

function invalidScope(message) {
  return new AlphaAccessError(message, 'ALPHA_SCOPE_INVALID');
}

function parseInviteCode(code) {
  const match = /^nvx_alpha_([0-9a-z]{20,40})\.([A-Za-z0-9_-]{32,128})$/
    .exec(String(code || '').trim());
  if (!match || !PUBLIC_ID_RX.test(match[1]) || !SECRET_RX.test(match[2])) {
    throw invalidInvite();
  }
  return { publicId: match[1], secret: match[2] };
}

function digestInviteSecret(pepper, publicId, secret) {
  const key = String(pepper || '');
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new TypeError('invite pepper must contain at least 32 bytes');
  }
  if (
    !PUBLIC_ID_RX.test(String(publicId || ''))
    || !SECRET_RX.test(String(secret || ''))
  ) {
    throw new TypeError('invite public id and secret must use the invitation format');
  }
  return crypto.createHmac('sha256', key)
    .update(`alpha-invite-v1\0${publicId}\0${secret}`, 'utf8')
    .digest('hex');
}

function parseAuthority(raw) {
  if (typeof raw !== 'string' || !raw) {
    throw invalidScope('Repository authority is required');
  }

  let hostname = raw;
  if (raw.startsWith('https://')) {
    hostname = raw.slice('https://'.length);
    if (hostname.endsWith('/')) hostname = hostname.slice(0, -1);
  }
  if (
    !hostname
    || !/^[\x00-\x7f]+$/.test(hostname)
    || !/^[A-Za-z0-9.-]+$/.test(hostname)
  ) {
    throw invalidScope('Repository authority is invalid');
  }

  hostname = hostname.toLowerCase();
  if (!HOSTNAME_RX.test(hostname)) {
    throw invalidScope('Repository authority is invalid');
  }
  if (IPV4_ALIAS_RX.test(hostname)) {
    throw invalidScope('Repository authority must be a DNS hostname');
  }

  // Unicode U-labels are rejected above. Canonical ASCII A-labels are
  // accepted only when they survive a complete IDNA round trip unchanged.
  if (hostname.split('.').some(label => label.startsWith('xn--'))) {
    const unicode = domainToUnicode(hostname);
    if (!unicode || domainToASCII(unicode) !== hostname) {
      throw invalidScope('Repository authority contains an invalid IDNA A-label');
    }
  }
  return hostname;
}

function normalizeAuthority(provider, raw) {
  const authority = parseAuthority(raw);
  if (provider === 'github' && authority !== 'github.com') {
    throw invalidScope('GitHub repository authority must be github.com');
  }
  return authority;
}

function readScopeFields(input) {
  try {
    if (
      input === null
      || typeof input !== 'object'
      || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw invalidScope('Repository scope input must be a plain object');
    }

    const fields = {};
    for (const field of SCOPE_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
        throw invalidScope(`Repository ${field} must be an own string field`);
      }
      fields[field] = descriptor.value;
    }
    return fields;
  } catch (error) {
    if (error instanceof AlphaAccessError) throw error;
    throw invalidScope('Repository scope input is invalid');
  }
}

function canonicalRepositoryScope(input) {
  const fields = readScopeFields(input);
  const provider = fields.provider.trim().toLowerCase();
  if (!['github', 'gitlab', 'gitea'].includes(provider)) {
    throw invalidScope('Repository provider is invalid');
  }

  const owner = fields.owner.trim().toLowerCase();
  const repo = fields.repo.trim().toLowerCase();
  if (
    !REPO_PART_RX.test(owner)
    || !REPO_PART_RX.test(repo)
    || owner === '.'
    || owner === '..'
    || repo === '.'
    || repo === '..'
  ) {
    throw invalidScope('Repository owner or name is invalid');
  }

  return `${provider}:${normalizeAuthority(provider, fields.authority)}/${owner}/${repo}`;
}

function parseRepositoryScope(scope) {
  if (typeof scope !== 'string') {
    throw invalidScope('Repository scope must be a string');
  }
  const match = /^(github|gitlab|gitea):([^/]+)\/([^/]+)\/([^/]+)$/i
    .exec(scope.trim());
  if (!match) {
    throw invalidScope('Repository scope is invalid');
  }

  const canonical = canonicalRepositoryScope({
    provider: match[1],
    authority: match[2],
    owner: match[3],
    repo: match[4]
  });
  const canonicalMatch = /^(github|gitlab|gitea):([^/]+)\/([^/]+)\/([^/]+)$/
    .exec(canonical);
  return {
    provider: canonicalMatch[1],
    authority: canonicalMatch[2],
    owner: canonicalMatch[3],
    repo: canonicalMatch[4],
    canonical
  };
}

/*
 * An invitation that carries no repository scope is unbound: the tester was
 * never handed a list to stay inside, so there is nothing to check them
 * against and any repository their own credentials reach is theirs to test.
 *
 * An EMPTY list, specifically -- never a missing one. A scope list that failed
 * to load must read as "refuse", not as "permit", so anything that is not an
 * array of length zero is not unbound.
 */
function inviteUnbound(allowedScopes) {
  return Array.isArray(allowedScopes) && allowedScopes.length === 0;
}

function repositoryAllowed(allowedScopes, target) {
  const canonical = canonicalRepositoryScope(target);
  if (!Array.isArray(allowedScopes)) return false;

  try {
    const canonicalScopes = new Set(
      allowedScopes.map(scope => parseRepositoryScope(scope).canonical)
    );
    return canonicalScopes.has(canonical);
  } catch (error) {
    if (error instanceof AlphaAccessError) return false;
    throw error;
  }
}

module.exports = Object.freeze({
  AlphaAccessError,
  parseInviteCode,
  digestInviteSecret,
  canonicalRepositoryScope,
  parseRepositoryScope,
  repositoryAllowed,
  inviteUnbound
});
