/*
 * The paths a person has protected in a repository, read from the safety
 * settings their session keeps: the repository is matched by name whatever
 * its case, and each pattern is kept as a clean path.
 */
import { cleanPath, cleanText } from '../../../platform/values/text.ts';

export function protectedPatternsForRepository(protectedMap: unknown, owner: unknown, repo: unknown): string[] {
  const map = protectedMap && typeof protectedMap === 'object' ? protectedMap : {};
  const requested = `${cleanText(owner, 100)}/${cleanText(repo, 100)}`.toLowerCase();
  if (requested === '/') return [];
  const key = Object.keys(map).find(candidate => String(candidate).toLowerCase() === requested);
  const patterns: unknown = key === undefined ? undefined : Reflect.get(map, key);
  return key && Array.isArray(patterns)
    ? patterns.map(pattern => cleanPath(pattern)).filter(Boolean)
    : [];
}
