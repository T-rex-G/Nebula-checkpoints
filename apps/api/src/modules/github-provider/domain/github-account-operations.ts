import { parseRepositoryScope, parseStoredRepositoryScope } from '../../identity-access/index.ts';
import { property } from '../../../platform/values/fields.ts';

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const QUERY_LIMIT = 200;

type Fields = Readonly<Record<string, unknown>>;

/* A refusal the route answers as it is: nothing on the provider was changed unless it says so. */
export type Refusal = Error & {
  readonly code: string;
  readonly status: number;
  readonly providerChanged: boolean;
  nextAction?: string;
};

function refusal(message: string, code: string, status = 400, extra: Readonly<Record<string, unknown>> = {}): Refusal {
  return Object.assign(new Error(message), { code, status, providerChanged: false, ...extra });
}

/* One read or write of the provider's API, on the account's own credential. */
export type ProviderRequest = (path: string, options?: { readonly method?: string; readonly body?: unknown }) => Promise<unknown>;

export type TokenKind = 'installation' | 'oauth' | 'fine-grained' | 'classic' | 'unknown';

export function githubTokenKind(account: Fields = {}): TokenKind {
  if (account.authMethod === 'github-app') return 'installation';
  if (account.authMethod === 'oauth') return 'oauth';
  if (String(account.token || '').startsWith('github_pat_')) return 'fine-grained';
  if (String(account.token || '').startsWith('ghp_')) return 'classic';
  return 'unknown';
}

// Connection support is separate from feature maturity and repository rights.
// Never include the credential itself in a capability projection.
export function connectionRestriction(context: { readonly authMethod?: unknown; readonly tokenKind?: unknown }, feature: string): { readonly code: string; readonly reason: string } | null {
  if (context.authMethod === 'github-app' && feature === 'repository.create') {
    return { code: 'GITHUB_APP_CAPABILITY_UNAVAILABLE', reason: 'Personal repository creation needs a personal GitHub connection, not an installation connection.' };
  }
  if (feature === 'notifications' && (context.authMethod === 'github-app' || context.tokenKind === 'fine-grained')) {
    return { code: 'GITHUB_NOTIFICATIONS_CONNECTION_UNSUPPORTED', reason: 'GitHub notifications are not supported by installation or fine-grained-token connections. Use a supported personal connection with notification access.' };
  }
  return null;
}

export interface RepositoryCreation {
  readonly name: string;
  readonly description: string;
  readonly private: boolean;
  readonly auto_init: boolean;
}

export function validateRepositoryCreation(input: unknown): RepositoryCreation {
  const invalid = (): Refusal => refusal('Use a valid repository name, description, and boolean privacy/initialization choices.', 'REPOSITORY_CREATE_INVALID');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  if (Object.keys(input).some(key => !['name', 'description', 'isPrivate', 'autoInit'].includes(key))) throw invalid();
  const { name, description = '', isPrivate = true, autoInit = true } = input as Fields;
  if (typeof name !== 'string' || !REPOSITORY_NAME.test(name) || name === '.' || name === '..'
    || typeof description !== 'string' || description.length > 350 || /[\u0000-\u001f\u007f]/.test(description)
    || typeof isPrivate !== 'boolean' || typeof autoInit !== 'boolean') throw invalid();
  return { name, description, private: isPrivate, auto_init: autoInit };
}

function repositoryName(value: unknown): string {
  if (typeof value !== 'string') return '';
  try { return parseRepositoryScope(`github:github.com/${value}`).canonical.slice('github:github.com/'.length); }
  catch { return ''; }
}

export function githubRepositoryScopes(scopes: unknown): string[] {
  try {
    if (!Array.isArray(scopes) || scopes.length > 20) throw new Error('Invalid scope collection');
    return [...new Set(Array.from(scopes as readonly unknown[], parseStoredRepositoryScope).filter(scope => scope !== null)
      .map(scope => `${scope.owner}/${scope.repo}`))];
  } catch {
    throw refusal('This invitation does not have a valid repository scope.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
  }
}

export function validateCodeQuery(query: unknown): string {
  if (typeof query !== 'string' || !query.trim() || query.length > QUERY_LIMIT || /[\u0000-\u001f\u007f]/.test(query)) {
    throw refusal('Enter a code search of 1–200 characters.', 'SEARCH_QUERY_INVALID');
  }
  return query.trim();
}

export function scopedCodeQuery(query: unknown, repository: unknown): string {
  const q = validateCodeQuery(query);
  // Invitation scope is supplied by the server, never composed from a user's
  // repo/user/org qualifier or a boolean expression that could override it.
  if (/(?:^|[\s("-])(?:repo|user|org)\s*:|\b(?:OR|NOT)\b/i.test(q)) {
    throw refusal('For a repository-restricted invitation, search code without repo/user/org qualifiers or OR/NOT operators.', 'SEARCH_QUERY_INVALID');
  }
  if (!repositoryName(repository)) throw refusal('Repository scope is invalid.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
  return `${q} repo:${String(repository)}`;
}

export async function createVerifiedRepository(request: ProviderRequest, account: Fields, input: unknown): Promise<{ readonly id: unknown; readonly full_name: unknown; readonly default_branch: string; readonly verified: true }> {
  const body = validateRepositoryCreation(input);
  const expected = repositoryName(`${String(account.login)}/${body.name}`);
  if (!expected) throw refusal('The connected GitHub identity is invalid.', 'PROVIDER_IDENTITY_MISMATCH', 403);
  const user = await request('/user');
  const userId = property(user, 'id');
  if (!user || String(property(user, 'login') || '').toLowerCase() !== String(account.login).toLowerCase()
    || !Number.isSafeInteger(userId) || Number(userId) <= 0
    || (Number(account.providerAccountId) > 0 && userId !== Number(account.providerAccountId))) {
    throw refusal('The GitHub credential no longer matches the connected account. Reconnect before creating a repository.', 'PROVIDER_IDENTITY_MISMATCH', 403);
  }
  let created: unknown;
  try {
    created = await request('/user/repos', { method: 'POST', body });
  } catch (error) {
    // A timeout may follow a successful provider mutation. Never encourage an
    // automatic second create or delete a repository as compensating cleanup.
    (error as { nextAction?: string }).nextAction = 'Check the repository on GitHub before retrying creation.';
    throw error;
  }
  try {
    const createdId = property(created, 'id');
    if (!created || !Number.isSafeInteger(createdId) || Number(createdId) <= 0 || repositoryName(property(created, 'full_name')) !== expected) throw new Error('Mismatched creation');
    const verified = await request(`/repos/${expected}`);
    const defaultBranch = property(verified, 'default_branch');
    if (!verified || property(verified, 'id') !== createdId || repositoryName(property(verified, 'full_name')) !== expected
      || typeof defaultBranch !== 'string' || !defaultBranch) throw new Error('Mismatched readback');
    return { id: property(verified, 'id'), full_name: property(verified, 'full_name'), default_branch: defaultBranch, verified: true };
  } catch {
    throw refusal('GitHub accepted creation, but its final repository state could not be verified.', 'REPOSITORY_CREATE_UNVERIFIED', 502, {
      providerChanged: true,
      nextAction: 'Check the repository on GitHub before retrying. No automatic cleanup was performed.'
    });
  }
}

// At most 20 invitation repositories, four reads in flight, bounded results.
async function boundedMap<T, R>(values: readonly T[], operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (index < values.length) { const current = index++; results[current] = await operation(values[current] as T); }
  }));
  return results;
}

export async function searchAccessibleCode(request: ProviderRequest, query: unknown, repositories: readonly string[] | null = null): Promise<{ readonly repo: unknown; readonly path: string }[]> {
  const q = validateCodeQuery(query);
  const targets = repositories === null ? [null] : repositories;
  if (!Array.isArray(targets) || targets.length > 20) throw refusal('Repository scope is invalid.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
  const queries = (targets as readonly (string | null)[]).map(repo => repo === null ? q : scopedCodeQuery(q, repo));
  const pages = await boundedMap(queries, async search => {
    const response = await request(`/search/code?q=${encodeURIComponent(search)}&per_page=25`);
    const items = property(response, 'items');
    if (!response || !Array.isArray(items)) throw refusal('GitHub returned an invalid search response.', 'PROVIDER_RESPONSE_INVALID', 502);
    return items as readonly unknown[];
  });
  const allowed = repositories === null ? null : new Set(repositories);
  const seen = new Set<string>();
  return pages.flat().filter(item => {
    const repo = repositoryName(property(property(item, 'repository'), 'full_name'));
    const key = `${repo}\0${String(property(item, 'path'))}`;
    if (!repo || (allowed && !allowed.has(repo)) || !item || typeof property(item, 'path') !== 'string' || !property(item, 'path') || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 25).map(item => ({ repo: property(property(item, 'repository'), 'full_name'), path: property(item, 'path') as string }));
}

export interface NotificationView {
  readonly id: unknown;
  readonly reason: unknown;
  readonly unread: unknown;
  readonly updated_at: unknown;
  readonly title: unknown;
  readonly type: unknown;
  readonly repo: unknown;
  readonly web: string;
}

export async function listAccessibleNotifications(request: ProviderRequest, repositories: readonly string[] | null = null): Promise<NotificationView[]> {
  const targets = repositories === null ? [null] : repositories;
  if (!Array.isArray(targets) || targets.length > 20) throw refusal('Repository scope is invalid.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
  const pages = await boundedMap(targets as readonly (string | null)[], async repo => {
    if (repo !== null && !repositoryName(repo)) throw refusal('Repository scope is invalid.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
    const list = await request(repo === null ? '/notifications?per_page=30' : `/repos/${repo}/notifications?per_page=30`);
    if (!Array.isArray(list)) throw refusal('GitHub returned an invalid notification response.', 'PROVIDER_RESPONSE_INVALID', 502);
    // Validate each repository response before combining it with another.
    return (list as readonly unknown[]).filter(item => item && repositoryName(property(property(item, 'repository'), 'full_name'))
      && (repo === null || repositoryName(property(property(item, 'repository'), 'full_name')) === repo));
  });
  const fullName = (item: unknown): unknown => property(property(item, 'repository'), 'full_name');
  const seen = new Set<string>();
  return pages.flat().sort((a, b) => String(property(b, 'updated_at') || '').localeCompare(String(property(a, 'updated_at') || '')))
    .filter(item => { const key = `${repositoryName(fullName(item))}:${String(property(item, 'id'))}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 30).map(item => ({
      id: property(item, 'id'), reason: property(item, 'reason'), unread: property(item, 'unread'), updated_at: property(item, 'updated_at'),
      title: property(item, 'subject') && property(property(item, 'subject'), 'title'), type: property(item, 'subject') && property(property(item, 'subject'), 'type'),
      repo: fullName(item), web: `https://github.com/${repositoryName(fullName(item))}`
    }));
}

export async function verifyRepositoryDeletion(request: ProviderRequest, fullName: unknown, account: Fields = {}): Promise<unknown> {
  const expected = repositoryName(fullName);
  if (!expected) throw refusal('Repository scope is invalid.', 'PROVIDER_REPOSITORY_MISMATCH', 403);
  const repo = await request(`/repos/${expected}`);
  const repoId = property(repo, 'id');
  if (!repo || repositoryName(property(repo, 'full_name')) !== expected || !Number.isSafeInteger(repoId) || Number(repoId) <= 0) {
    throw refusal('GitHub returned a different repository. Nothing was deleted.', 'PROVIDER_REPOSITORY_MISMATCH', 502);
  }
  let administrator = property(repo, 'permissions') && property(property(repo, 'permissions'), 'admin') === true;
  if (account.authMethod === 'github-app') {
    administrator = false;
    const login = account.authorizedByLogin;
    const installation = account.installation;
    if (typeof login === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(login)
      && installation && property(installation, 'permissions')
      && property(property(installation, 'permissions'), 'administration') === 'write') {
      // An installation's rights do not establish its human operator's rights.
      // Re-read that human's permission for this destructive operation.
      const human = await request(`/repos/${expected}/collaborators/${encodeURIComponent(login)}/permission`);
      administrator = !!(human && property(human, 'permission') === 'admin' && property(human, 'user')
        && String(property(property(human, 'user'), 'login') || '').toLowerCase() === login.toLowerCase());
    }
  }
  if (!administrator) {
    throw refusal('Repository deletion requires administrator access on the connected GitHub account.', 'REPOSITORY_DELETE_PERMISSION_REQUIRED', 403);
  }
  return repo;
}
