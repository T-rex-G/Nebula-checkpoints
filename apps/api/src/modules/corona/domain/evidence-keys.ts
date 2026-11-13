/*
 * The key a repository's evidence is kept under: the provider, then the owner
 * and the repository in lower case, and for the identity that holds it, at
 * most 80 characters of that identity (or "anonymous"). Live streams use the
 * same key, so an event reaches only the identity whose evidence it is.
 */

export function repoKey(provider: unknown, owner: unknown, repo: unknown): string {
  return `${provider || 'github'}:${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`;
}

export function scopedEvidenceKey(provider: unknown, owner: unknown, repo: unknown, identity: unknown): string {
  return `${repoKey(provider, owner, repo)}:${String(identity || 'anonymous').slice(0, 80)}`;
}
