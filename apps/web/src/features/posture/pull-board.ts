/*
 * Open pull requests across the workspace, on the Overview: what the board
 * reads and what it decides. Drawn by PullBoard.tsx.
 *
 * The workbench lists one repository's pull requests. This reads the same
 * list route for the repositories most recently pushed to and lays what is
 * open in three columns: waiting on a reviewer, open with nobody asked, and
 * drafts. It is read-only. A card opens that pull request in its own
 * repository, where reviewing and merging already live, behind their own
 * checks.
 *
 * What it says is bounded by what the list route returns. Whether a reviewer
 * was asked is on the list; what a reviewer decided is not, and nothing here
 * claims it. A repository that could not be read is named as such, never
 * drawn as one with nothing open, and when the inventory is larger than the
 * repositories read, the card says how many it read.
 */
import { inventory as listInventory, repoKey } from '../repositories/repo-inventory.ts';
import type { InventoryEntry } from '../repositories/repo-inventory.ts';
import { field, items } from '../../platform/values.ts';

/* How many repositories one reading asks, most recently pushed first, and how many at a time. */
export const REPOSITORY_LIMIT = 12;
export const CONCURRENCY = 4;
/*
 * One page of the list route (per_page in the workbench's collaboration routes), most recently updated
 * first. A repository that fills it may hold more, and the ones left out are
 * the least recently touched.
 */
export const LIST_PAGE = 30;
/* A column shows this many before it offers the rest. */
export const COLUMN_SHOWN = 5;
/* A pull request nobody has touched for this long is called idle. */
export const IDLE_DAYS = 14;
const DAY_MS = 86400000;
export const LABELS_SHOWN = 3;

export type ColumnId = 'review' | 'unrequested' | 'draft';

export interface ColumnDefinition {
  readonly id: ColumnId;
  readonly title: string;
  readonly hint: string;
  readonly empty: string;
}

export const COLUMNS: readonly ColumnDefinition[] = Object.freeze([
  Object.freeze({ id: 'review', title: 'Waiting on review', hint: 'A reviewer was asked; longest waiting first.', empty: 'No pull request is waiting on a reviewer.' }),
  Object.freeze({ id: 'unrequested', title: 'No review requested', hint: 'Open, with nobody asked to review; oldest first.', empty: 'Every open pull request has a reviewer asked.' }),
  Object.freeze({ id: 'draft', title: 'Drafts', hint: 'Still being written; most recently updated first.', empty: 'No drafts open.' })
]);

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/* The inventory, most recently pushed first, without duplicates. */
function inventory(repos: unknown): InventoryEntry[] {
  return listInventory(repos).sort((a, b) => b.pushedAt - a.pushedAt || a.key.localeCompare(b.key));
}

export interface Repository {
  owner: string;
  repo: string;
  key: string;
}

/* Which repositories one reading asks: the most recently pushed, up to the limit. */
export function pickRepositories(repos: unknown, limit: number = REPOSITORY_LIMIT): Repository[] {
  return inventory(repos).slice(0, Math.max(0, limit)).map(({ owner, repo, key }) => ({ owner, repo, key }));
}

function wholeDays(from: unknown, now: number): number | null {
  const at = Date.parse(String(from || ''));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

export function ago(daysCount: number | null): string | null {
  if (daysCount === null) return null;
  if (daysCount === 0) return 'today';
  if (daysCount === 1) return 'yesterday';
  return `${daysCount} days ago`;
}

/* One open pull request, as a card shows it. */
export interface PullEntry {
  key: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  head: string | null;
  base: string | null;
  draft: boolean;
  reviewers: number;
  labels: string[];
  createdAt: unknown;
  updatedAt: unknown;
  ageDays: number | null;
  idleDays: number | null;
  idle: boolean;
}

function item(owner: string, repo: string, pull: unknown, now: number): PullEntry {
  const number = Number(field(pull, 'number'));
  const createdAt = field(pull, 'created_at') || null;
  const updatedAt = field(pull, 'updated_at') || null;
  const reviewers = Math.max(0, Math.floor(Number(field(pull, 'reviewers')) || 0));
  const idleDays = wholeDays(updatedAt, now);
  const text = (name: string): string | null => {
    const value = field(pull, name);
    return value ? String(value) : null;
  };
  const labels = field(pull, 'labels');
  return {
    key: `${repoKey(owner, repo)}#${number}`,
    owner,
    repo,
    number,
    title: String(field(pull, 'title') || `Pull request #${number}`),
    author: text('user'),
    head: text('head'),
    base: text('base'),
    draft: field(pull, 'draft') === true,
    reviewers,
    /* The server sends label names; anything else in the list is not a label to draw. */
    labels: items(labels).filter((label): label is string => typeof label === 'string' && label !== ''),
    createdAt,
    updatedAt,
    ageDays: wholeDays(createdAt, now),
    idleDays,
    idle: idleDays !== null && idleDays >= IDLE_DAYS
  };
}

function column(entry: PullEntry): ColumnId {
  if (entry.draft) return 'draft';
  return entry.reviewers > 0 ? 'review' : 'unrequested';
}

function stamp(value: unknown, fallback: number): number {
  const at = Date.parse(String(value || ''));
  return Number.isFinite(at) ? at : fallback;
}

export type ReadError = 'scope' | 'offline' | 'limited' | 'unreadable';

/* One repository asked: its open pull requests when it answered, why not when it did not. */
export type ReadResult =
  | { owner: string; repo: string; pulls: unknown[]; error?: undefined; retryAfter?: undefined }
  | { owner: string; repo: string; pulls?: undefined; error: ReadError; retryAfter?: number };

export interface Coverage {
  read: number;
  asked: number;
  inventory: number;
  refused: string[];
  unreadable: string[];
  capped: string[];
  limited: string[];
  /* The longest wait GitHub named: reading again sooner would be refused again. */
  retryAfter: number;
}

export interface BoardColumn extends ColumnDefinition {
  readonly items: PullEntry[];
}

export type BoardView =
  | { state: 'no-repositories' }
  | { state: 'loading'; asked: number; inventory: number }
  | { state: 'unavailable'; coverage: Coverage; reason: Exclude<ReadError, 'limited'> | 'limited' }
  | {
    state: 'ready' | 'empty';
    total: number;
    repositories: number;
    waiting: number;
    longestWait: number | null;
    idle: number;
    columns: BoardColumn[];
    coverage: Coverage;
  };

export interface ModelInput {
  results?: readonly ReadResult[] | null;
  repos?: unknown;
  limit?: number;
  now?: number;
}

const named = (result: ReadResult): string => `${result.owner}/${result.repo}`;

/*
 * The board, decided. `results` holds one entry per repository asked:
 * `{ owner, repo, pulls }` when it answered, `{ owner, repo, error }` when
 * it did not, with `error` one of 'scope', 'offline', 'limited' or
 * 'unreadable' -- a limited one carrying the `retryAfter` GitHub gave.
 * `results` is null while the reading is on its way.
 */
export function model({ results, repos, limit = REPOSITORY_LIMIT, now = Date.now() }: ModelInput = {}): BoardView {
  const known = inventory(repos);
  if (!known.length) return { state: 'no-repositories' };
  if (!Array.isArray(results)) return { state: 'loading', asked: Math.min(limit, known.length), inventory: known.length };
  const asked: readonly ReadResult[] = results;
  const read = asked.filter((result): result is ReadResult & { pulls: unknown[] } => Array.isArray(result.pulls));
  const refused = asked.filter(result => !Array.isArray(result.pulls) && result.error === 'scope').map(named);
  const failed = asked.filter(result => !Array.isArray(result.pulls) && result.error !== 'scope');
  const unreadable = failed.filter(result => result.error !== 'limited').map(named);
  const limited = failed.filter(result => result.error === 'limited');
  const offline = asked.some(result => result.error === 'offline');
  const capped = read.filter(result => result.pulls.length >= LIST_PAGE).map(named);
  const coverage: Coverage = {
    read: read.length, asked: asked.length, inventory: known.length, refused, unreadable, capped,
    limited: limited.map(named),
    retryAfter: limited.reduce((longest, result) => Math.max(longest, Number(result.retryAfter) || 0), 0)
  };
  if (!read.length) {
    const reason = offline ? 'offline' : refused.length === asked.length ? 'scope' : !unreadable.length && limited.length ? 'limited' : 'unreadable';
    return { state: 'unavailable', coverage, reason };
  }
  const entries: PullEntry[] = [];
  for (const result of read) {
    for (const pull of result.pulls) {
      if (!pull || field(pull, 'state') !== 'open' || !Number.isFinite(Number(field(pull, 'number')))) continue;
      entries.push(item(result.owner, result.repo, pull, now));
    }
  }
  const columns: BoardColumn[] = COLUMNS.map(definition => {
    const listed = entries.filter(entry => column(entry) === definition.id);
    if (definition.id === 'draft') listed.sort((a, b) => stamp(b.updatedAt, 0) - stamp(a.updatedAt, 0) || a.key.localeCompare(b.key));
    else listed.sort((a, b) => stamp(a.createdAt, Infinity) - stamp(b.createdAt, Infinity) || a.key.localeCompare(b.key));
    return { id: definition.id, title: definition.title, hint: definition.hint, empty: definition.empty, items: listed };
  });
  const repositories = new Set(entries.map(entry => repoKey(entry.owner, entry.repo))).size;
  const waiting = columns[0]?.items ?? [];
  return {
    state: entries.length ? 'ready' : 'empty',
    total: entries.length,
    repositories,
    waiting: waiting.length,
    longestWait: waiting[0] ? waiting[0].ageDays : null,
    idle: entries.filter(entry => entry.idle).length,
    columns,
    coverage
  };
}

/* The card's first line: how much is open and how long the longest wait has been. */
export function sentence(view: BoardView): string {
  if (view.state !== 'ready' && view.state !== 'empty') return '';
  if (view.state === 'empty') return `No open pull requests in the ${plural(view.coverage.read, 'repository', 'repositories')} read.`;
  /* A repository cut at one page makes every count a floor and the longest wait the longest shown. */
  const cut = view.coverage.capped.length > 0;
  const count = plural(view.total, 'open pull request', 'open pull requests');
  const open = `${cut ? `At least ${count}` : count.charAt(0).toUpperCase() + count.slice(1)} in ${plural(view.repositories, 'repository', 'repositories')}`;
  if (!view.waiting) return `${open}; none waiting on a reviewer${cut ? ' among those shown' : ''}.`;
  const shown = cut ? 'the longest shown' : 'the longest';
  const longest = view.longestWait === null ? '' : view.longestWait === 0 ? `, ${shown} since today` : `, ${shown} for ${plural(view.longestWait, 'day', 'days')}`;
  return `${open}: ${view.waiting} waiting on review${longest}.`;
}

export function notes(view: BoardView): string[] {
  const out: string[] = [];
  if (!('coverage' in view)) return out;
  const coverage = view.coverage;
  if (coverage.inventory > coverage.asked) {
    out.push(`Read from the ${coverage.asked} most recently pushed of ${coverage.inventory} repositories.`);
  }
  const names = (list: readonly string[]): string => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
  if (coverage.refused.length) {
    out.push(`${plural(coverage.refused.length, 'repository is', 'repositories are')} outside this session's repository scope: ${names(coverage.refused)}.`);
  }
  if (coverage.unreadable.length) {
    out.push(`${plural(coverage.unreadable.length, 'repository', 'repositories')} could not be read just now: ${names(coverage.unreadable)}.`);
  }
  if (coverage.limited.length) {
    out.push(`GitHub is limiting requests for this account, so ${plural(coverage.limited.length, 'repository was', 'repositories were')} not read: ${names(coverage.limited)}. Read again in ${waitPhrase(coverage.retryAfter)}.`);
  }
  if (coverage.capped.length) {
    out.push(coverage.capped.length === 1
      ? `${coverage.capped[0] ?? ''} has more open pull requests than one list holds; these are its ${LIST_PAGE} most recently updated.`
      : `${names(coverage.capped)} have more open pull requests than one list holds; each shows its ${LIST_PAGE} most recently updated.`);
  }
  return out;
}

/*
 * How long, said the way a reader says it. A limit that named no wait is
 * read again after a minute, which is what GitHub asks of a client that was
 * given none.
 */
export function waitPhrase(seconds: unknown): string {
  const value = Math.ceil(Number(seconds) || 0);
  if (value <= 0) return 'a minute';
  if (value === 1) return 'a second';
  if (value < 60) return `${value} seconds`;
  const minutes = Math.ceil(value / 60);
  if (minutes === 1) return 'a minute';
  if (minutes < 60) return `${minutes} minutes`;
  return minutes === 60 ? 'an hour' : 'more than an hour';
}

export type FetchPulls = (owner: string, repo: string) => Promise<unknown>;

/* Read the repositories a few at a time; one that fails is recorded, not fatal. */
export async function readAll(repositories: readonly Repository[], fetchPulls: FetchPulls, concurrency: number = CONCURRENCY): Promise<ReadResult[]> {
  const results: ReadResult[] = new Array<ReadResult>(repositories.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < repositories.length) {
      const index = next++;
      const asked = repositories[index];
      if (!asked) continue;
      const { owner, repo } = asked;
      try {
        const pulls = await fetchPulls(owner, repo);
        results[index] = Array.isArray(pulls) ? { owner, repo, pulls } : { owner, repo, error: 'unreadable' };
      } catch (error) {
        const code = String(field(error, 'code') || '');
        if (code === 'PROVIDER_RATE_LIMITED') {
          results[index] = { owner, repo, error: 'limited', retryAfter: Math.max(0, Number(field(error, 'retryAfter')) || 0) };
          continue;
        }
        const kind: ReadError = /^ALPHA_REPOSITORY_/.test(code) ? 'scope' : field(error, 'offline') ? 'offline' : 'unreadable';
        results[index] = { owner, repo, error: kind };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, repositories.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}
