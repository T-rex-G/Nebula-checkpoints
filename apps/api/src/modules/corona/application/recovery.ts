/*
 * Recovery: what a repository's references and default-branch files are now,
 * how a kept snapshot compares with that, and the single-use grant a restore
 * preview hands to the restore that follows it.
 *
 * A snapshot is read from the provider -- the repository, its branches and
 * tags a page at a time, and the default branch's tree when a manifest is
 * asked for -- and holds nothing but names, commit ids and file metadata. A
 * restore grant is sealed by the server and bound to the provider, the
 * repository, the identity and the exact branch actions it was previewed
 * for; it is spent once, at the point of use, so a preview that turns out to
 * be stale leaves it unspent.
 */
import crypto from 'node:crypto';
import { memorySingleUseStore } from '../../../platform/rate-limit/single-use-store.ts';
import { cleanText } from '../../../platform/values/text.ts';
import { member } from '../../../platform/values/fields.ts';
import { referenceSha } from '../../github-provider/index.ts';
import { normalizeBranchName, normalizeCommitSha } from '../domain/recovery-names.ts';
import { compareSnapshots } from '../domain/snapshots.ts';
import type { SnapshotComparison } from '../domain/snapshots.ts';

/* How long a restore preview's grant can be spent. */
export const RESTORE_AUTH_TTL_MS = 10 * 60 * 1000;
/* The snapshot kinds a comparison accepts. */
export const SNAPSHOT_KINDS: ReadonlySet<string> = new Set(['nebulaverse-snapshot', 'nebulaverse-emergency-manifest']);

/* A repository on the provider, as a request names it. */
export interface RepositoryTarget {
  readonly account: unknown;
  readonly owner: unknown;
  readonly repo: unknown;
}

/* A grant spent once: a key that answers true the first time it is consumed and false after. */
export interface SingleUse {
  consumeOnce(input: { readonly kind: string; readonly key: string; readonly expiresAt: number; readonly now: number }): Promise<unknown>;
}

export interface RecoveryDeps {
  gh(account: unknown, apiPath: string, options?: { readonly method?: string; readonly body?: unknown }): Promise<unknown>;
  seal(value: unknown): string;
  unseal(value: string): unknown;
  identityKey(account: unknown): string;
  readonly databaseConfigured: boolean;
  /* The single-use store every instance shares; used whenever a database is configured. */
  durableSingleUse(): SingleUse;
  /* How many default-branch files a manifest lists. */
  readonly manifestMax: number;
}

/* A branch action a restore performs: move an existing branch back, or recreate a deleted one. */
export interface RestoreAction {
  readonly name: string;
  readonly action: 'recreate' | 'reset';
  readonly from: string;
  readonly to: string;
}

export interface RestoreGrant {
  readonly actions: RestoreAction[];
  readonly expiresAt: unknown;
  readonly tokenHash: string;
}

export interface Recovery {
  captureRefsSnapshot(target: RepositoryTarget, includeManifest: unknown): Promise<RefsSnapshot>;
  validateSnapshot(target: RepositoryTarget, snapshot: unknown): unknown;
  compareWith(target: RepositoryTarget, snapshot: unknown): Promise<{ readonly baseline: unknown; readonly current: RefsSnapshot; readonly comparison: SnapshotComparison }>;
  createRestoreAuthorization(target: RepositoryTarget, actions: unknown): string;
  /* A grant read and checked against this repository session: its actions, unspent or not. */
  inspectRestoreAuthorization(target: RepositoryTarget, token: unknown): { readonly encoded: string; readonly actions: RestoreAction[]; readonly expiresAt: unknown };
  prepareRestoreAuthorization(target: RepositoryTarget, token: unknown): RestoreGrant;
  claimRestoreAuthorization(grant: RestoreGrant, now?: number): Promise<RestoreGrant>;
  preflightRestoreActions(target: RepositoryTarget, actions: readonly RestoreAction[]): Promise<Record<string, string>[]>;
}

export interface RefsSnapshot {
  readonly kind: 'nebulaverse-snapshot';
  readonly version: 2;
  readonly capturedAt: string;
  readonly owner: unknown;
  readonly repo: unknown;
  readonly provider: unknown;
  readonly defaultBranch: unknown;
  readonly refs: { readonly name: unknown; readonly sha: string; readonly protected: boolean }[];
  readonly refsTruncated: boolean;
  readonly tags: { readonly name: unknown; readonly sha: string }[];
  readonly tagsAvailable: boolean;
  readonly tagsError: string;
  readonly tagsTruncated: boolean;
  readonly manifest: Record<string, unknown> | null;
}

/* An error a route answers with its own status, and a code when it has one. */
function refusal(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), code ? { status, code } : { status });
}

/* `value.filter(...)`, as JavaScript calls it on a provider's answer: anything but a list has no such method. */
function listed(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what}.filter is not a function`);
  return value;
}

/* A repository's API path. */
function repositoryPath(target: RepositoryTarget): string {
  return `/repos/${String(target.owner)}/${String(target.repo)}`;
}

/* A branch action as a grant states it, normalized as the preview and the restore both read it. */
function normalizedAction(action: unknown): RestoreAction {
  const kind = action && member(action, 'action') === 'recreate' ? 'recreate' : 'reset';
  const name = normalizeBranchName(action && member(action, 'name'), 'recovery branch');
  const to = normalizeCommitSha(action && member(action, 'to'), 'recovery target SHA');
  const from = kind === 'reset' ? normalizeCommitSha(action && member(action, 'from'), 'preview branch SHA') : '';
  return { name, action: kind, from, to };
}

export function createRecovery(deps: RecoveryDeps): Recovery {
  const usedAuthorizations = new Map<string, unknown>();
  const providerOf = (target: RepositoryTarget): unknown => member(target.account, 'provider') || 'github';

  /* A paged provider list, up to ten pages of a hundred. */
  const pagedRepoList = async (target: RepositoryTarget, resource: string, maxPages = 10): Promise<{ items: unknown[]; truncated: boolean }> => {
    const pageSize = 100;
    const items: unknown[] = [];
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const query = `per_page=${pageSize}&page=${page}`;
      const batch = await deps.gh(target.account, `${repositoryPath(target)}/${resource}?${query}`);
      if (!Array.isArray(batch)) break;
      items.push(...batch);
      if (batch.length < pageSize) return { items, truncated: false };
      if (page === maxPages) truncated = true;
    }
    return { items, truncated };
  };

  const captureRefsSnapshot: Recovery['captureRefsSnapshot'] = async (target, includeManifest) => {
    const [info, branchPage] = await Promise.all([
      deps.gh(target.account, `${repositoryPath(target)}`),
      pagedRepoList(target, 'branches')
    ]);
    let tagPage: { items: unknown[]; truncated: boolean } = { items: [], truncated: false };
    let tagsAvailable = true;
    let tagsError = '';
    try { tagPage = await pagedRepoList(target, 'tags'); }
    catch (error) {
      tagsAvailable = false;
      tagsError = cleanText((error && member(error, 'message')) || 'Tag inventory unavailable', 240);
    }
    const refs = branchPage.items.map(branch => ({ name: member(branch, 'name'), sha: referenceSha(branch), protected: !!member(branch, 'protected') })).filter(ref => ref.name && ref.sha);
    let manifest: Record<string, unknown> | null = null;
    if (includeManifest) {
      const head = refs.find(ref => ref.name === member(info, 'default_branch')) || refs[0];
      if (head) {
        const tree = await deps.gh(target.account, `${repositoryPath(target)}/git/trees/${head.sha}?recursive=1`);
        const allFiles = listed(member(tree, 'tree') || [], 't.tree').filter(entry => member(entry, 'type') === 'blob' || member(entry, 'type') === 'commit');
        manifest = {
          branch: head.name,
          truncated: !!member(tree, 'truncated') || allFiles.length > deps.manifestMax,
          providerTreeTruncated: !!member(tree, 'truncated'),
          totalFiles: allFiles.length,
          files: allFiles.slice(0, deps.manifestMax).map(entry => ({ path: member(entry, 'path'), sha: member(entry, 'sha'), size: member(entry, 'size') || 0, mode: member(entry, 'mode'), type: member(entry, 'type') }))
        };
      }
    }
    return {
      kind: 'nebulaverse-snapshot', version: 2, capturedAt: new Date().toISOString(),
      owner: target.owner, repo: target.repo, provider: providerOf(target), defaultBranch: member(info, 'default_branch'),
      refs,
      refsTruncated: branchPage.truncated,
      tags: tagPage.items.map(tag => ({ name: member(tag, 'name'), sha: referenceSha(tag) })).filter(tag => tag.name && tag.sha),
      tagsAvailable,
      tagsError,
      tagsTruncated: tagPage.truncated,
      manifest
    };
  };

  const validateSnapshot: Recovery['validateSnapshot'] = (target, snapshot) => {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(member(snapshot, 'refs'))) {
      throw refusal('A valid Nebulaverse-X snapshot with refs is required', 400, 'INVALID_SNAPSHOT');
    }
    if (!SNAPSHOT_KINDS.has(String(member(snapshot, 'kind') || ''))) {
      throw refusal('Unsupported recovery snapshot kind', 400, 'SNAPSHOT_KIND_INVALID');
    }
    if (String(member(snapshot, 'owner') || '').toLowerCase() !== String(target.owner || '').toLowerCase() ||
        String(member(snapshot, 'repo') || '').toLowerCase() !== String(target.repo || '').toLowerCase()) {
      throw refusal('Snapshot repository does not match the open repository', 409, 'SNAPSHOT_REPOSITORY_MISMATCH');
    }
    if (member(snapshot, 'provider') && String(member(snapshot, 'provider')).toLowerCase() !== String(member(target.account, 'provider') || 'github').toLowerCase()) {
      throw refusal('Snapshot provider does not match the active repository provider', 409, 'SNAPSHOT_PROVIDER_MISMATCH');
    }
    if (Number(member(member(snapshot, 'refs'), 'length')) > 1000) throw refusal('Snapshot contains too many branch refs', 413);
    return snapshot;
  };

  const compareWith: Recovery['compareWith'] = async (target, snapshot) => {
    const baseline = validateSnapshot(target, snapshot);
    const kept = member(baseline, 'manifest');
    const compareManifest = !!(kept && Array.isArray(member(kept, 'files')));
    const current = await captureRefsSnapshot(target, compareManifest);
    return { baseline, current, comparison: compareSnapshots(baseline, current) };
  };

  const createRestoreAuthorization: Recovery['createRestoreAuthorization'] = (target, actions) => {
    const normalized = (Array.isArray(actions) ? actions : []).map(normalizedAction);
    if (!normalized.length || normalized.length > 50) {
      throw refusal('Recovery authorization requires between 1 and 50 branch actions', 400, 'RESTORE_ACTION_LIMIT');
    }
    return deps.seal({
      kind: 'nebulaverse-restore-authorization', version: 1,
      expiresAt: Date.now() + RESTORE_AUTH_TTL_MS,
      provider: providerOf(target), owner: target.owner, repo: target.repo,
      identityKey: deps.identityKey(target.account), nonce: crypto.randomUUID(), actions: normalized
    });
  };

  const inspectRestoreAuthorization: Recovery['inspectRestoreAuthorization'] = (target, token) => {
    const encoded = String(token || '');
    if (!encoded || encoded.length > 65536) {
      throw refusal('A valid recovery preview authorization is required', 400, 'RESTORE_AUTHORIZATION_REQUIRED');
    }
    const payload = deps.unseal(encoded);
    const expiresAt = payload && member(payload, 'expiresAt');
    if (!payload || member(payload, 'kind') !== 'nebulaverse-restore-authorization' || member(payload, 'version') !== 1 ||
        !Number.isFinite(expiresAt) || Number(expiresAt) <= Date.now()) {
      throw refusal('Recovery preview authorization is invalid or expired', 409, 'RESTORE_AUTHORIZATION_INVALID');
    }
    if (String(member(payload, 'owner') || '').toLowerCase() !== String(target.owner || '').toLowerCase() ||
        String(member(payload, 'repo') || '').toLowerCase() !== String(target.repo || '').toLowerCase() ||
        String(member(payload, 'provider') || '').toLowerCase() !== String(member(target.account, 'provider') || 'github').toLowerCase() ||
        member(payload, 'identityKey') !== deps.identityKey(target.account)) {
      throw refusal('Recovery preview authorization does not match this repository session', 409, 'RESTORE_AUTHORIZATION_SCOPE');
    }
    const stated = member(payload, 'actions');
    const actions = (Array.isArray(stated) ? stated : []).map(normalizedAction);
    if (!actions.length || actions.length > 50 || new Set(actions.map(action => action.name)).size !== actions.length) {
      throw refusal('Recovery preview authorization contains invalid actions', 400, 'RESTORE_AUTHORIZATION_ACTIONS');
    }
    return { encoded, actions, expiresAt: member(payload, 'expiresAt') };
  };

  /*
   * Preparation does not consult the single-use store. The check and the
   * record were once separated by the preflight, a series of provider reads,
   * and two requests carrying one grant both passed the check while the first
   * waited on the network -- one process was enough, because an await is all
   * it takes to interleave a read and a write. So preparation validates and
   * hashes the grant, and the claim happens as one operation at the point of
   * use.
   */
  const prepareRestoreAuthorization: Recovery['prepareRestoreAuthorization'] = (target, token) => {
    const inspected = inspectRestoreAuthorization(target, token);
    const tokenHash = crypto.createHash('sha256').update(inspected.encoded).digest('hex');
    return { actions: inspected.actions, expiresAt: inspected.expiresAt, tokenHash };
  };

  /*
   * Claimed immediately before the refs are written and never before the
   * preflight, so a preview that turns out to be stale leaves its grant
   * unspent -- the reader is told to regenerate it, and nothing has been
   * consumed on their behalf. Without a database the grants are this
   * instance's; with one, every instance's.
   */
  const claimRestoreAuthorization: Recovery['claimRestoreAuthorization'] = async (grant, now = Date.now()) => {
    let claimed: unknown;
    try {
      const store = deps.databaseConfigured ? deps.durableSingleUse() : memorySingleUseStore(usedAuthorizations, { maxEntries: 5000 });
      claimed = await store.consumeOnce({
        kind: 'restore-authorization',
        key: grant.tokenHash,
        expiresAt: Number(grant.expiresAt),
        now: Number(now)
      });
    } catch {
      throw refusal('Recovery authorization cannot be verified right now; retry shortly', 503, 'RESTORE_AUTHORIZATION_UNAVAILABLE');
    }
    if (!claimed) {
      throw refusal('Recovery preview authorization has already been used; generate a fresh preview before retrying', 409, 'RESTORE_AUTHORIZATION_REPLAY');
    }
    return grant;
  };

  const preflightRestoreActions: Recovery['preflightRestoreActions'] = async (target, actions) => {
    const conflicts: Record<string, string>[] = [];
    for (const action of actions) {
      let current: unknown = null;
      try { current = await deps.gh(target.account, `${repositoryPath(target)}/git/ref/heads/${encodeURIComponent(action.name)}`); }
      catch (error) {
        if (member(error, 'status') !== 404) throw error;
      }
      const currentSha = current ? referenceSha(current) : '';
      if (action.action === 'reset' && currentSha !== action.from) {
        conflicts.push({ name: action.name, expected: action.from, current: currentSha, reason: currentSha ? 'branch moved after preview' : 'branch was deleted after preview' });
      } else if (action.action === 'recreate' && currentSha) {
        conflicts.push({ name: action.name, expected: '', current: currentSha, reason: 'branch was created after preview' });
      }
    }
    return conflicts;
  };

  return { captureRefsSnapshot, validateSnapshot, compareWith, createRestoreAuthorization, inspectRestoreAuthorization, prepareRestoreAuthorization, claimRestoreAuthorization, preflightRestoreActions };
}
