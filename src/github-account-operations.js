'use strict';

const { parseRepositoryScope } = require('./alpha-access');
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const QUERY_LIMIT = 200;

function refusal(message, code, status = 400, extra = {}) {
  return Object.assign(new Error(message), { code, status, providerChanged: false, ...extra });
}

function githubTokenKind(account = {}) {
  if (account.authMethod === 'github-app') return 'installation';
  if (account.authMethod === 'oauth') return 'oauth';
  if (String(account.token || '').startsWith('github_pat_')) return 'fine-grained';
  if (String(account.token || '').startsWith('ghp_')) return 'classic';
  return 'unknown';
}

// Connection support is separate from feature maturity and repository rights.
// Never include the credential itself in a capability projection.
function connectionRestriction(context, feature) {
  if (context.authMethod === 'github-app' && feature === 'repository.create') {
    return { code: 'GITHUB_APP_CAPABILITY_UNAVAILABLE', reason: 'Personal repository creation needs a personal GitHub connection, not an installation connection.' };
  }
  if (feature === 'notifications' && (context.authMethod === 'github-app' || context.tokenKind === 'fine-grained')) {
    return { code: 'GITHUB_NOTIFICATIONS_CONNECTION_UNSUPPORTED', reason: 'GitHub notifications are not supported by installation or fine-grained-token connections. Use a supported personal connection with notification access.' };
  }
  return null;
}

function validateRepositoryCreation(input) {
  const invalid = () => refusal('Use a valid repository name, description, and boolean privacy/initialization choices.', 'REPOSITORY_CREATE_INVALID');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  if (Object.keys(input).some(key => !['name', 'description', 'isPrivate', 'autoInit'].includes(key))) throw invalid();
  const { name, description = '', isPrivate = true, autoInit = true } = input;
  if (typeof name !== 'string' || !REPOSITORY_NAME.test(name) || name === '.' || name === '..'
    || typeof description !== 'string' || description.length > 350 || /[\u0000-\u001f\u007f]/.test(description)
    || typeof isPrivate !== 'boolean' || typeof autoInit !== 'boolean') throw invalid();
  return { name, description, private: isPrivate, auto_init: autoInit };
}

function repositoryName(value) {
  if (typeof value !== 'string') return '';
  try { return parseRepositoryScope(`github:github.com/${value}`).canonical.slice('github:github.com/'.length); }
  catch { return ''; }
}

function githubRepositoryScopes(scopes) {
  try {
    if (!Array.isArray(scopes) || scopes.length > 20) throw new Error('Invalid scope collection');
    return [...new Set(scopes.map(parseRepositoryScope).filter(scope => scope.provider === 'github')
      .map(scope => `${scope.owner}/${scope.repo}`))];
  } catch {
    throw refusal('This invitation does not have a valid repository scope.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
  }
}

function validateCodeQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > QUERY_LIMIT || /[\u0000-\u001f\u007f]/.test(query)) {
    throw refusal('Enter a code search of 1–200 characters.', 'SEARCH_QUERY_INVALID');
  }
  return query.trim();
}

function scopedCodeQuery(query, repository) {
  const q = validateCodeQuery(query);
  // Invitation scope is supplied by the server, never composed from a user's
  // repo/user/org qualifier or a boolean expression that could override it.
  if (/(?:^|[\s("-])(?:repo|user|org)\s*:|\b(?:OR|NOT)\b/i.test(q)) {
    throw refusal('For a repository-restricted invitation, search code without repo/user/org qualifiers or OR/NOT operators.', 'SEARCH_QUERY_INVALID');
  }
  if (!repositoryName(repository)) throw refusal('Repository scope is invalid.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
  return `${q} repo:${repository}`;
}

async function createVerifiedRepository(request, account, input) {
  const body = validateRepositoryCreation(input);
  const expected = repositoryName(`${account.login}/${body.name}`);
  if (!expected) throw refusal('The connected GitHub identity is invalid.', 'PROVIDER_IDENTITY_MISMATCH', 403);
  const user = await request('/user');
  if (!user || String(user.login || '').toLowerCase() !== String(account.login).toLowerCase()
    || !Number.isSafeInteger(user.id) || user.id <= 0
    || (Number(account.providerAccountId) > 0 && user.id !== Number(account.providerAccountId))) {
    throw refusal('The GitHub credential no longer matches the connected account. Reconnect before creating a repository.', 'PROVIDER_IDENTITY_MISMATCH', 403);
  }
  let created;
  try {
    created = await request('/user/repos', { method: 'POST', body });
  } catch (error) {
    // A timeout may follow a successful provider mutation. Never encourage an
    // automatic second create or delete a repository as compensating cleanup.
    error.nextAction = 'Check the repository on GitHub before retrying creation.';
    throw error;
  }
  try {
    if (!created || !Number.isSafeInteger(created.id) || created.id <= 0 || repositoryName(created.full_name) !== expected) throw new Error('Mismatched creation');
    const verified = await request(`/repos/${expected}`);
    if (!verified || verified.id !== created.id || repositoryName(verified.full_name) !== expected
      || typeof verified.default_branch !== 'string' || !verified.default_branch) throw new Error('Mismatched readback');
    return { id: verified.id, full_name: verified.full_name, default_branch: verified.default_branch, verified: true };
  } catch {
    throw refusal('GitHub accepted creation, but its final repository state could not be verified.', 'REPOSITORY_CREATE_UNVERIFIED', 502, {
      providerChanged: true,
      nextAction: 'Check the repository on GitHub before retrying. No automatic cleanup was performed.'
    });
  }
}

// At most 20 invitation repositories, four reads in flight, bounded results.
async function boundedMap(values, operation) {
  const results = new Array(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (index < values.length) { const current = index++; results[current] = await operation(values[current]); }
  }));
  return results;
}

async function searchAccessibleCode(request, query, repositories = null) {
  const q = validateCodeQuery(query);
  const targets = repositories === null ? [null] : repositories;
  if (!Array.isArray(targets) || targets.length > 20) throw refusal('Repository scope is invalid.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
  const queries = targets.map(repo => repo === null ? q : scopedCodeQuery(q, repo));
  const pages = await boundedMap(queries, async search => {
    const response = await request(`/search/code?q=${encodeURIComponent(search)}&per_page=25`);
    if (!response || !Array.isArray(response.items)) throw refusal('GitHub returned an invalid search response.', 'PROVIDER_RESPONSE_INVALID', 502);
    return response.items;
  });
  const allowed = repositories === null ? null : new Set(repositories);
  const seen = new Set();
  return pages.flat().filter(item => {
    const repo = repositoryName(item && item.repository && item.repository.full_name);
    const key = `${repo}\0${item && item.path}`;
    if (!repo || (allowed && !allowed.has(repo)) || !item || typeof item.path !== 'string' || !item.path || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 25).map(item => ({ repo: item.repository.full_name, path: item.path }));
}

async function listAccessibleNotifications(request, repositories = null) {
  const targets = repositories === null ? [null] : repositories;
  if (!Array.isArray(targets) || targets.length > 20) throw refusal('Repository scope is invalid.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
  const pages = await boundedMap(targets, async repo => {
    if (repo !== null && !repositoryName(repo)) throw refusal('Repository scope is invalid.', 'ALPHA_REPOSITORY_NOT_ALLOWED', 403);
    const list = await request(repo === null ? '/notifications?per_page=30' : `/repos/${repo}/notifications?per_page=30`);
    if (!Array.isArray(list)) throw refusal('GitHub returned an invalid notification response.', 'PROVIDER_RESPONSE_INVALID', 502);
    // Validate each repository response before combining it with another.
    return list.filter(item => item && repositoryName(item.repository && item.repository.full_name)
      && (repo === null || repositoryName(item.repository.full_name) === repo));
  });
  const seen = new Set();
  return pages.flat().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .filter(item => { const key = `${repositoryName(item.repository.full_name)}:${item.id}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 30).map(item => ({
      id: item.id, reason: item.reason, unread: item.unread, updated_at: item.updated_at,
      title: item.subject && item.subject.title, type: item.subject && item.subject.type,
      repo: item.repository.full_name, web: `https://github.com/${repositoryName(item.repository.full_name)}`
    }));
}

async function verifyRepositoryDeletion(request, fullName, account = {}) {
  const expected = repositoryName(fullName);
  if (!expected) throw refusal('Repository scope is invalid.', 'PROVIDER_REPOSITORY_MISMATCH', 403);
  const repo = await request(`/repos/${expected}`);
  if (!repo || repositoryName(repo.full_name) !== expected || !Number.isSafeInteger(repo.id) || repo.id <= 0) {
    throw refusal('GitHub returned a different repository. Nothing was deleted.', 'PROVIDER_REPOSITORY_MISMATCH', 502);
  }
  let administrator = repo.permissions && repo.permissions.admin === true;
  if (account.authMethod === 'github-app') {
    administrator = false;
    const login = account.authorizedByLogin;
    if (typeof login === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(login)
      && account.installation && account.installation.permissions
      && account.installation.permissions.administration === 'write') {
      // An installation's rights do not establish its human operator's rights.
      // Re-read that human's permission for this destructive operation.
      const human = await request(`/repos/${expected}/collaborators/${encodeURIComponent(login)}/permission`);
      administrator = !!(human && human.permission === 'admin' && human.user
        && String(human.user.login || '').toLowerCase() === login.toLowerCase());
    }
  }
  if (!administrator) {
    throw refusal('Repository deletion requires administrator access on the connected GitHub account.', 'REPOSITORY_DELETE_PERMISSION_REQUIRED', 403);
  }
  return repo;
}

module.exports = Object.freeze({
  githubTokenKind, connectionRestriction, validateRepositoryCreation,
  githubRepositoryScopes, validateCodeQuery, scopedCodeQuery, createVerifiedRepository,
  searchAccessibleCode, listAccessibleNotifications, verifyRepositoryDeletion
});
