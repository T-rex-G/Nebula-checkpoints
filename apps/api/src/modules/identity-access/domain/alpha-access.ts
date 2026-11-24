import { createHmac } from 'node:crypto';
import { domainToASCII, domainToUnicode } from 'node:url';

export class AlphaAccessError extends Error {
  override readonly name = 'AlphaAccessError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const PUBLIC_ID_RX = /^[0-9a-z]{20,40}$/;
const SECRET_RX = /^[A-Za-z0-9_-]{32,128}$/;
const REPO_PART_RX = /^[A-Za-z0-9_.-]{1,200}$/;
const HOSTNAME_RX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const IPV4_ALIAS_RX = /^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}$/i;
const SCOPE_FIELDS = Object.freeze(['provider', 'authority', 'owner', 'repo'] as const);
const SCOPE_RX = /^(github):([^/]+)\/([^/]+)\/([^/]+)$/;

type ScopeField = (typeof SCOPE_FIELDS)[number];
type ScopeFields = Record<ScopeField, string>;

/* A repository an invitation names, read back from its canonical text. */
export interface ParsedRepositoryScope {
  readonly provider: string;
  readonly authority: string;
  readonly owner: string;
  readonly repo: string;
  readonly canonical: string;
}

function invalidInvite(): AlphaAccessError {
  return new AlphaAccessError(
    'Invitation could not be redeemed',
    'ALPHA_INVITE_INVALID',
    403
  );
}

function invalidScope(message: string): AlphaAccessError {
  return new AlphaAccessError(message, 'ALPHA_SCOPE_INVALID');
}

export function parseInviteCode(code: unknown): { readonly publicId: string; readonly secret: string } {
  const match = /^nvx_alpha_([0-9a-z]{20,40})\.([A-Za-z0-9_-]{32,128})$/
    .exec(String(code || '').trim());
  const [, publicId = '', secret = ''] = match ?? [];
  if (!match || !PUBLIC_ID_RX.test(publicId) || !SECRET_RX.test(secret)) {
    throw invalidInvite();
  }
  return { publicId, secret };
}

export function digestInviteSecret(pepper: unknown, publicId: unknown, secret: unknown): string {
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
  return createHmac('sha256', key)
    .update(`alpha-invite-v1\0${String(publicId)}\0${String(secret)}`, 'utf8')
    .digest('hex');
}

function parseAuthority(raw: unknown): string {
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

function normalizeAuthority(provider: string, raw: unknown): string {
  const authority = parseAuthority(raw);
  if (provider === 'github' && authority !== 'github.com') {
    throw invalidScope('GitHub repository authority must be github.com');
  }
  return authority;
}

function readScopeFields(input: unknown): ScopeFields {
  try {
    if (
      input === null
      || typeof input !== 'object'
      || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw invalidScope('Repository scope input must be a plain object');
    }

    const fields: Partial<ScopeFields> = {};
    for (const field of SCOPE_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
        throw invalidScope(`Repository ${field} must be an own string field`);
      }
      fields[field] = descriptor.value;
    }
    return fields as ScopeFields;
  } catch (error) {
    if (error instanceof AlphaAccessError) throw error;
    throw invalidScope('Repository scope input is invalid');
  }
}

function normalizeRepositoryParts(ownerInput: string, repoInput: string): { readonly owner: string; readonly repo: string } {
  const owner = ownerInput.trim().toLowerCase();
  const repo = repoInput.trim().toLowerCase();
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

  return { owner, repo };
}

export function canonicalRepositoryScope(input: unknown): string {
  const fields = readScopeFields(input);
  const provider = fields.provider.trim().toLowerCase();
  if (!['github'].includes(provider)) {
    throw invalidScope('Repository provider is invalid');
  }

  const { owner, repo } = normalizeRepositoryParts(fields.owner, fields.repo);

  return `${provider}:${normalizeAuthority(provider, fields.authority)}/${owner}/${repo}`;
}

export function parseRepositoryScope(scope: unknown): ParsedRepositoryScope {
  if (typeof scope !== 'string') {
    throw invalidScope('Repository scope must be a string');
  }
  const match = /^(github):([^/]+)\/([^/]+)\/([^/]+)$/i
    .exec(scope.trim());
  if (!match) {
    throw invalidScope('Repository scope is invalid');
  }

  const [, provider = '', authority = '', owner = '', repo = ''] = match;
  const canonical = canonicalRepositoryScope({ provider, authority, owner, repo });
  /* The canonical text is built in exactly this shape, so every group is present. */
  const [, canonicalProvider = '', canonicalAuthority = '', canonicalOwner = '', canonicalRepo = ''] = SCOPE_RX.exec(canonical) ?? [];
  return {
    provider: canonicalProvider,
    authority: canonicalAuthority,
    owner: canonicalOwner,
    repo: canonicalRepo,
    canonical
  };
}

/*
 * Read-only compatibility for grants stored before provider retirement. Validate
 * every entry, but a retired grant can never match a live repository. This is
 * deliberately separate from the parser used to create new invitations.
 */
export function parseStoredRepositoryScope(scope: unknown): ParsedRepositoryScope | null {
  const retired = typeof scope === 'string'
    ? /^(?:gitlab|gitea):([^/]+)\/([^/]+)\/([^/]+)$/i.exec(scope.trim())
    : null;
  if (retired) {
    const [, authority = '', owner = '', repo = ''] = retired;
    parseAuthority(authority);
    normalizeRepositoryParts(owner, repo);
    return null;
  }
  return parseRepositoryScope(scope);
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
export function inviteUnbound(allowedScopes: unknown): boolean {
  return Array.isArray(allowedScopes) && allowedScopes.length === 0;
}

export function repositoryAllowed(allowedScopes: unknown, target: unknown): boolean {
  const canonical = canonicalRepositoryScope(target);
  if (!Array.isArray(allowedScopes)) return false;

  try {
    const canonicalScopes = new Set<string>();
    for (const scope of allowedScopes as readonly unknown[]) {
      const stored = parseStoredRepositoryScope(scope);
      if (stored !== null) canonicalScopes.add(stored.canonical);
    }
    return canonicalScopes.has(canonical);
  } catch (error) {
    if (error instanceof AlphaAccessError) return false;
    throw error;
  }
}
