import { read as field } from '../../../platform/values/fields.ts';
import {
  CONTROLS, githubClassic, githubRulesets, merge, off, on, plural, unknown,
  type ControlId, type ControlReading
} from '../domain/branch-rules.ts';

/*
 * What the provider enforces on a branch, read and never changed.
 *
 * Nebulaverse-X's own safeguards (read-only mode, protected paths) hold only
 * while a change goes through Nebulaverse-X. The provider's branch rules hold
 * for every client -- a laptop's `git push --force`, an automation token, an
 * administrator in the web editor -- so the Safeguards panel shows them beside
 * its own, control by control, in the words a reviewer would use.
 *
 * Each control is `on`, `off` or `unknown`. `unknown` is what a reader
 * without administration access sees for the details a provider hides from
 * it; it is never counted as `on`, so a restricted token never makes a branch
 * look better defended than it is. GitHub's classic protection and its
 * rulesets are both read, and a control is on when either turns it on.
 *
 * The provider is reached only through `read(path)`, which the caller binds
 * to the open repository and its session; this module builds paths relative
 * to that repository and never sees a credential.
 */

/* Fetches a path relative to the repository; fails with an error carrying the provider's `status`. */
export type RepositoryRead = (path: string) => Promise<unknown>;

/* A read that answers null for "not there" and "not allowed", and throws for anything else. */
async function optional(read: RepositoryRead, path: string): Promise<{ value: unknown; status: number }> {
  try { return { value: await read(path), status: 200 }; }
  catch (error) {
    const status = Number(field(error, 'status'));
    if (status === 404 || status === 403 || status === 401) return { value: null, status };
    throw error;
  }
}

interface ProviderReading {
  readonly protected: boolean;
  readonly access: 'partial' | 'full';
  readonly sources: readonly string[];
  /* Every control, once read: the loop that builds it assigns each one. */
  readonly controls: Readonly<Partial<Record<ControlId, ControlReading>>>;
}

/* ---- GitHub ------------------------------------------------------------------------- */

async function readGithub({ read, branch }: { read: RepositoryRead; branch: string }): Promise<ProviderReading> {
  const summary = await read(`/branches/${encodeURIComponent(branch)}`);
  const isProtected = Boolean(summary && field(summary, 'protected'));
  const [classic, rulesets] = await Promise.all([
    isProtected ? optional(read, `/branches/${encodeURIComponent(branch)}/protection`) : Promise.resolve({ value: null, status: 404 }),
    optional(read, `/rules/branches/${encodeURIComponent(branch)}`)
  ]);
  const fromClassic = githubClassic(classic.value);
  const fromRules = githubRulesets(rulesets.value);
  const hidden = !!(isProtected && !classic.value && classic.status !== 404);
  /* The branch summary names required checks even to readers who cannot see the rest. */
  const visibleContexts = field(field(field(summary, 'protection'), 'required_status_checks'), 'contexts');
  const visibleChecks = Array.isArray(visibleContexts) ? visibleContexts : [];
  if (visibleChecks.length) fromRules.checks = merge(fromRules.checks, on(plural(visibleChecks.length, 'check')));
  const controls: Partial<Record<ControlId, ControlReading>> = {};
  for (const [id] of CONTROLS) {
    const reading = merge(fromClassic[id], fromRules[id]);
    if (reading && reading.state === 'on') controls[id] = reading;
    else if (hidden) controls[id] = unknown('needs administration access to read');
    else controls[id] = reading || off();
  }
  const rulesetIds = Array.isArray(rulesets.value) ? rulesets.value.map(rule => rule && field(rule, 'ruleset_id')).filter(Boolean) : [];
  const rulesetCount = new Set(rulesetIds).size;
  return {
    protected: isProtected || rulesetCount > 0,
    access: hidden ? 'partial' : 'full',
    sources: [classic.value ? 'branch protection' : '', rulesetCount ? plural(rulesetCount, 'ruleset') : ''].filter(Boolean),
    controls
  };
}

/* ---- The reading ---------------------------------------------------------------------- */

/* A Map, so a provider is looked up by its own name and never by one inherited from Object.prototype. */
const READERS: ReadonlyMap<string, (input: { read: RepositoryRead; branch: string }) => Promise<ProviderReading>> = new Map([['github', readGithub]]);

function settingsUrl({ webBase, owner, repo }: { webBase: unknown; owner: unknown; repo: unknown }): string | null {
  const base = String(webBase || '').replace(/\/+$/, '');
  if (!base) return null;
  const slug = `${encodeURIComponent(String(owner))}/${encodeURIComponent(String(repo))}`;
  return `${base}/${slug}/settings/branches`;
}

export interface BranchProtectionInput {
  readonly provider?: string;
  readonly owner?: unknown;
  readonly repo?: unknown;
  readonly branch?: unknown;
  readonly read?: RepositoryRead | null;
  readonly webBase?: unknown;
}

/*
 * The provider's rules for one branch. `read(path)` fetches a path relative to
 * the repository (`''` is the repository itself) and throws an error carrying
 * `status` on failure. When `branch` is empty the default branch is read.
 */
export async function readBranchProtection({ provider = 'github', owner, repo, branch, read, webBase }: BranchProtectionInput) {
  const reader = READERS.get(provider);
  if (!reader) throw Object.assign(new Error('Branch rules are not available for this provider'), { status: 501, code: 'BRANCH_RULES_UNSUPPORTED' });
  if (typeof read !== 'function') throw new TypeError('read is required');
  let name = String(branch || '').trim();
  if (!name) {
    const repository = await read('');
    name = String((repository && field(repository, 'default_branch')) || '').trim();
    if (!name) throw Object.assign(new Error('The repository has no default branch yet'), { status: 404, code: 'BRANCH_NOT_FOUND' });
  }
  const reading = await reader({ read, branch: name });
  const controls = CONTROLS.map(([id, label]) => ({ id, label, ...reading.controls[id] }));
  const counted = controls.filter(control => control.state !== 'unknown');
  return {
    provider,
    branch: name,
    protected: reading.protected,
    access: reading.access,
    sources: reading.sources,
    controls,
    enforced: controls.filter(control => control.state === 'on').length,
    known: counted.length,
    settingsUrl: settingsUrl({ webBase, owner, repo })
  };
}
