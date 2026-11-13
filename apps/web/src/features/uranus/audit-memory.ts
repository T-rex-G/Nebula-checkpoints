/*
 * What this browser remembers of the last audit of a repository, and what
 * changed since: which findings are new, and how many earlier ones are gone.
 * Identities only -- the stored record is a list of fingerprints, the
 * engine that made them and a time, nothing a repository wrote -- and the
 * account-boundary purge removes it with every other key under the prefix.
 */
import { field, items } from '../../platform/values.ts';
import { plural, text } from './audit-terms.ts';

/* What changed since the last audit of the branch: the identities that are new, and how many earlier ones are gone (null when that could not be established). */
export interface AuditChanges {
  readonly previousAt: unknown;
  readonly newIds: ReadonlySet<unknown>;
  readonly resolved: number | null;
}

export const STORE_PREFIX = 'nv_audit:';

/* At most this many identities are kept: enough for any audit the page draws. */
const KEPT_IDS = 2000;

export function storageKey(repoKey: unknown): string {
  return `${STORE_PREFIX}${String(repoKey || '').toLowerCase()}`;
}

/* Which engine made a result's identities: two engines' fingerprints are not compared. */
export function engineIdentity(result: unknown): string | null {
  const engine = field(result, 'engine');
  if (typeof engine === 'number') return `site:${engine}`;
  const version = field(engine, 'version');
  return engine && version ? `repository:${text(version)}` : null;
}

/* The last audit this browser kept of the repository, or nothing: private mode and a damaged record read as none. */
export function readPrevious(repoKey: unknown): unknown {
  try {
    return JSON.parse(globalThis.localStorage.getItem(storageKey(repoKey)) || 'null');
  } catch {
    return null;
  }
}

/* Keep this result's identities for the next comparison. A result without its findings is not one to compare with. */
export function remember(repoKey: unknown, result: unknown): void {
  const findings = field(result, 'findings');
  if (!Array.isArray(findings)) return;
  try {
    globalThis.localStorage.setItem(storageKey(repoKey), JSON.stringify({
      at: field(result, 'auditedAt') || new Date().toISOString(),
      engine: engineIdentity(result),
      ids: items(findings).map(finding => field(finding, 'id')).slice(0, KEPT_IDS)
    }));
  } catch { /* private mode: no comparison next time, and nothing is lost */ }
}

/* What changed since the record: none when there is no record, it was made by another engine, or the result has no findings to compare. */
export function diff(result: unknown, previous: unknown): AuditChanges | null {
  const ids = field(previous, 'ids');
  const findings = field(result, 'findings');
  if (!previous || !Array.isArray(ids) || !Array.isArray(findings)) return null;
  if (engineIdentity(result) !== (field(previous, 'engine') || null)) return null;
  const before = new Set(items(ids));
  const now = new Set(items(findings).map(finding => field(finding, 'id')));
  return {
    previousAt: field(previous, 'at') || null,
    newIds: new Set([...now].filter(id => !before.has(id))),
    resolved: [...before].filter(id => !now.has(id)).length
  };
}

/* A time as this reader's clock says it, or nothing when the value is no time. */
function localTime(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleString() : '';
}

/*
 * What changed since the last audit of the branch. A resolved count the
 * server could not establish (the audit lacked the evidence to prove a fix)
 * is said to be unknown, never shown as zero.
 */
export function diffSentence(changes: AuditChanges): string {
  const when = localTime(changes.previousAt);
  const since = when ? ` since the audit of ${when}` : '';
  const added = plural(changes.newIds.size, 'new finding', 'new findings');
  return Number.isSafeInteger(changes.resolved)
    ? `${added}, ${text(changes.resolved)} resolved${since}.`
    : `${added}${since}. Nothing is counted as resolved: this audit did not have the evidence to prove a fix.`;
}
