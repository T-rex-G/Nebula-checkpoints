/*
 * A repository named the way people paste one: owner/name, any web address
 * inside it on the signed-in provider's host (a file, a branch, an issue), or
 * a clone address. Anything else is no reference and nothing is requested for
 * it; an address on another host says so, because this session can only read
 * through the provider it is signed in to.
 */

/* An owner or a repository name as the provider writes one: words, dots and dashes, owners nested by slashes. */
export const REPO_PART = /^[\w.-]+(\/[\w.-]+)*$/;

/* The host this session reads repositories on. */
export function sessionHost(): string { return 'github.com'; }

export type RepositoryReference =
  | { readonly owner: string; readonly name: string; readonly kind: 'address' | 'name'; readonly wrongHost?: undefined }
  | { readonly wrongHost: string; readonly owner?: undefined; readonly name?: undefined; readonly kind?: undefined };

/* What a pasted text names: a repository, an address on another host, or nothing (null). */
export function repositoryReference(text: unknown): RepositoryReference | null {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 400 || /\s/.test(raw)) return null;
  const host = sessionHost();
  let path: string;
  let kind: 'address' | 'name' = 'address';
  const clone = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/](.+)$/i.exec(raw);
  if (clone) {
    const cloneHost = (clone[1] ?? '').toLowerCase();
    if (cloneHost !== host) return { wrongHost: cloneHost };
    path = clone[2] ?? '';
  } else if (/^https?:\/\//i.test(raw) || /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(raw)) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
    const found = url.hostname.toLowerCase().replace(/^www\./, '');
    if (found !== host) return { wrongHost: found };
    path = url.pathname;
  } else {
    if (raw.split('/').length !== 2) return null;
    path = raw;
    kind = 'name';
  }
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  /* Owner and name; an address with only an owner leaves the owner empty, which no repository has. */
  const parts = decoded.replace(/\.git\/?$/i, '').split('/').filter(Boolean).slice(0, 2);
  const name = parts[parts.length - 1] ?? '';
  const owner = parts.slice(0, -1).join('/');
  if (!REPO_PART.test(owner) || !REPO_PART.test(name) || /^\.+$/.test(name)) return null;
  return { owner, name, kind };
}
