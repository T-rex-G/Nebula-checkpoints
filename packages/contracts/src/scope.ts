/*
 * The repository a request, a policy or a piece of evidence is about.
 *
 * One scope names one repository at one provider authority, and its scopeKey
 * is how every store, cache and audit record compares two of them. Ported
 * from src/governance-model.js with its behaviour and codes unchanged.
 */
import { isPlainObject, refuseWithContractError } from './guards.ts';
import type { Refuse } from './guards.ts';
import { REPOSITORY_SEGMENT } from './ids.ts';

export const SCOPE_CONTRACT_VERSION = 1;

export const PROVIDERS = Object.freeze(['github'] as const);
export type Provider = (typeof PROVIDERS)[number];

export interface RepositoryScope {
  readonly provider: Provider;
  readonly authority: 'github.com';
  readonly owner: string;
  readonly repo: string;
  /* `provider:authority:owner/repo`, lower-cased: the one way two scopes are compared. */
  readonly scopeKey: string;
}

export interface ScopeInput {
  readonly provider?: unknown;
  readonly baseUrl?: unknown;
  readonly authority?: unknown;
  readonly owner?: unknown;
  readonly repo?: unknown;
}

/* The one platform object this needs. Every runtime that loads the contracts has it; the type is named here so the contracts stay free of any platform's. */
interface ParsedUrl {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly search: string;
  readonly hash: string;
  readonly port: string;
  readonly hostname: string;
  readonly pathname: string;
}
const WhatwgUrl = (globalThis as unknown as { URL: new (input: string) => ParsedUrl }).URL;

const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value);

/* Required text: present, bounded, and without control characters. */
export function normalizeRequiredText(value: unknown, label: string, max = 200, refuse: Refuse = refuseWithContractError): string {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    refuse(`${label} is invalid`, 'GOVERNANCE_INPUT_INVALID');
  }
  return text;
}

export function normalizePolicyScope(input: unknown, refuse: Refuse = refuseWithContractError): RepositoryScope {
  if (!isPlainObject(input)) return refuse('Policy scope is required', 'GOVERNANCE_SCOPE_INVALID');
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!isProvider(provider)) return refuse('Policy provider is unsupported', 'GOVERNANCE_SCOPE_INVALID');
  const owner = normalizeRequiredText(input.owner, 'Policy owner', 240, refuse);
  const repo = normalizeRequiredText(input.repo, 'Policy repository', 160, refuse);
  if (!REPOSITORY_SEGMENT.test(owner) || owner.split('/').some(part => part === '.' || part === '..') ||
      !REPOSITORY_SEGMENT.test(repo) || repo === '.' || repo === '..') {
    refuse('Policy repository scope is invalid', 'GOVERNANCE_SCOPE_INVALID');
  }

  const rawBase = String(input.baseUrl || (input.authority ? `https://${String(input.authority)}` : 'https://github.com')).trim();
  let parsed: ParsedUrl;
  try { parsed = new WhatwgUrl(rawBase); }
  catch { return refuse('Policy provider authority is invalid', 'GOVERNANCE_SCOPE_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port ||
      !['api.github.com', 'github.com'].includes(parsed.hostname.toLowerCase()) || parsed.pathname !== '/') {
    refuse('Policy provider authority must be GitHub', 'GOVERNANCE_SCOPE_INVALID');
  }
  const authority = 'github.com';
  return {
    provider,
    authority,
    owner,
    repo,
    scopeKey: `${provider}:${authority}:${owner.toLowerCase()}/${repo.toLowerCase()}`
  };
}
