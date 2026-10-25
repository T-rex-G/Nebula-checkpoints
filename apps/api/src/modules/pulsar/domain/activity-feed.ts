/*
 * The activity feed — what happened, across the repositories a session holds.
 *
 * The overview already carried a "Repository activity" card, and it answered a
 * different question than the one a reader arriving at it asks. It plots how
 * many repositories were pushed as a trailing seven-day count: a measure of
 * volume, computed entirely from the `pushed_at` field the inventory already
 * had. It can tell you the workspace has been busy. It can never tell you what
 * anyone did.
 *
 * This builds the other half: individual events, newest first, across
 * repositories. It is a pure merge -- given per-repository results it produces
 * one ordered feed -- so the shape of the answer can be tested without a
 * provider, a network, or a session.
 *
 * Three rules decide everything here.
 *
 * Nothing is invented. An event with no usable timestamp is not placed at the
 * top of the feed under `Date.now()`, and it is not quietly dropped either:
 * undated entries are counted and reported, because a feed that silently omits
 * what it could not order is a feed that lies about being complete.
 *
 * A failure is a fact, not a gap. When one repository's read fails the others
 * still have something to say, so the feed is built from what arrived and the
 * repositories that did not answer are named. A card that shows four events
 * and says nothing about the fifth repository that errored is telling the
 * reader the workspace was quiet when it was not.
 *
 * The feed never outranks its own evidence. Every event carries the repository
 * it came from and the kind of thing it was, so a reader can go and check. No
 * entry is summarised into a sentence whose source cannot be recovered.
 */
import { listOf, member, read } from '../../../platform/values/fields.ts';

export const KINDS = Object.freeze(['commit', 'pull', 'issue', 'release'] as const);
export type EventKind = (typeof KINDS)[number];

/*
 * The per-repository cost of a feed is what limits how wide it can be. Each
 * repository is a separate provider round trip, so the fan-out is bounded here
 * rather than by whatever the caller happens to pass: an inventory of two
 * hundred repositories must not become two hundred requests because someone
 * opened the overview.
 */
export const MAX_REPOSITORIES = 6;
export const MAX_EVENTS = 24;

function text(value: unknown, limit = 200): string {
  const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return out.length > limit ? `${out.slice(0, limit - 1)}…` : out;
}

/*
 * A timestamp or nothing.
 *
 * Date.parse returns NaN for anything it cannot read, and NaN sorts
 * unpredictably rather than failing -- an unparsed date does not throw, it
 * just quietly lands somewhere in the order. So the parse is checked here and
 * the caller is handed either a finite number or null, never NaN.
 */
export function instant(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function repositoryName(entry: unknown): string {
  return text((entry && (read(entry, 'repo') || read(entry, 'full_name') || read(entry, 'fullName'))) || '', 140);
}

/* ------------------------------------------------------------- the events */

export interface FeedEvent {
  readonly kind: EventKind;
  readonly repo: string;
  readonly title: string;
  readonly detail: string;
  readonly actor: string;
  readonly at: number | null;
  readonly ref: string;
}

/* A pull request's or an issue's number, as the feed shows it; a null entry fails the read, as it always has. */
function numbered(item: unknown): string {
  return Number.isFinite(Number(item && read(item, 'number'))) ? `#${Number(member(item, 'number'))}` : '';
}

function commitEvents(repo: string, list: unknown): FeedEvent[] {
  return listOf(list).map(item => {
    const sha = text(item && read(item, 'sha'), 40);
    return {
      kind: 'commit',
      repo,
      /* The subject line only. A commit body belongs to the commit, not to a
         feed entry, and pasting one in makes every row a different height. */
      title: text(String((item && read(item, 'message')) || '').split(/\r?\n/, 1)[0], 120),
      detail: sha ? sha.slice(0, 7) : '',
      actor: text(item && read(item, 'author'), 80),
      at: instant(item && read(item, 'date')),
      ref: sha
    };
  });
}

function pullEvents(repo: string, list: unknown): FeedEvent[] {
  return listOf(list).map(item => ({
    kind: 'pull',
    repo,
    title: text(item && read(item, 'title'), 120),
    /* merged / open / closed, as the route already resolved it -- this does
       not re-derive state from a merged_at field it was never given. */
    detail: text(item && read(item, 'state'), 20),
    actor: '',
    at: instant(item && read(item, 'updated')),
    ref: numbered(item)
  }));
}

function issueEvents(repo: string, list: unknown): FeedEvent[] {
  return listOf(list).map(item => ({
    kind: 'issue',
    repo,
    title: text(item && read(item, 'title'), 120),
    detail: text(item && read(item, 'state'), 20),
    actor: '',
    at: instant(item && read(item, 'updated')),
    ref: numbered(item)
  }));
}

function releaseEvents(repo: string, list: unknown): FeedEvent[] {
  return listOf(list).map(item => ({
    kind: 'release',
    repo,
    title: text((item && (read(item, 'name') || read(item, 'tag'))) || '', 120),
    detail: text(item && read(item, 'tag'), 60),
    actor: '',
    at: instant(item && read(item, 'published')),
    ref: text(item && read(item, 'tag'), 60)
  }));
}

/* --------------------------------------------------------------- the feed */

/*
 * `Number(limit) || MAX` was the obvious way to write the bound and it is
 * wrong in the one direction that costs something: it turns a 0 -- which is
 * what a miscomputed caller passes -- into the maximum, so a bug asking for
 * nothing quietly buys six provider round trips. A finite number is clamped;
 * only a genuinely absent one falls back.
 */
function bound(value: unknown, max: number): number {
  const asked = Number(value);
  return Number.isFinite(asked) ? Math.max(1, Math.min(max, asked)) : max;
}

export interface SelectedRepository {
  readonly full_name: string;
  readonly owner: string;
  readonly name: string;
  readonly pushedAt: number | null;
}

/*
 * Which repositories are worth asking about.
 *
 * Most recently pushed first, because that is the only ordering the inventory
 * can supply without spending a request. A repository with no push time is not
 * treated as brand new -- it sorts last, where an unknown belongs, rather than
 * displacing a repository that demonstrably moved this morning.
 */
export function selectRepositories(repos: unknown, limit: unknown = MAX_REPOSITORIES): SelectedRepository[] {
  const count = bound(limit, MAX_REPOSITORIES);
  return listOf(repos)
    .map(repo => {
      const owner = repo && read(repo, 'owner');
      return {
        full_name: repositoryName(repo),
        owner: text((repo && (owner && read(owner, 'login') ? read(owner, 'login') : owner)) || '', 80),
        name: text(repo && read(repo, 'name'), 80),
        pushedAt: instant(repo && (read(repo, 'pushed_at') || read(repo, 'pushedAt')))
      };
    })
    .filter(repo => repo.full_name && repo.owner && repo.name)
    .sort((a, b) => {
      if (a.pushedAt === b.pushedAt) return a.full_name.localeCompare(b.full_name);
      if (a.pushedAt === null) return 1;
      if (b.pushedAt === null) return -1;
      return b.pushedAt - a.pushedAt;
    })
    .slice(0, count)
    .map(repo => Object.freeze(repo));
}

export interface Feed {
  readonly measured: boolean;
  readonly events: readonly FeedEvent[];
  readonly truncated: boolean;
  readonly totalEvents: number;
  readonly undated: number;
  readonly repositories: readonly string[];
  readonly failed: readonly { readonly repo: string; readonly reason: string }[];
}

/*
 * One ordered feed out of many per-repository answers.
 *
 * `results` is one entry per repository that was asked, each either an
 * activity payload or an error. Both are kept: the payloads become events and
 * the errors become named repositories the reader is told about.
 */
export function feed(results: unknown, options: unknown = {}): Feed {
  const limit = bound(options && read(options, 'limit'), MAX_EVENTS);
  const answered: string[] = [];
  const failed: { readonly repo: string; readonly reason: string }[] = [];
  let undated = 0;
  const events: (FeedEvent & { readonly at: number })[] = [];

  for (const result of listOf(results)) {
    const repo = repositoryName(result);
    if (!repo) continue;
    if (!result || read(result, 'error')) {
      failed.push(Object.freeze({
        repo,
        /* The reason, as given. Not "something went wrong": a reader who can
           see "rate limit exceeded" knows to wait, and one who sees "not
           found" knows the repository moved. */
        reason: text((result && read(result, 'error')) || 'unavailable', 160)
      }));
      continue;
    }
    answered.push(repo);
    const batch = [
      ...commitEvents(repo, read(result, 'commits')),
      ...pullEvents(repo, read(result, 'pulls')),
      ...issueEvents(repo, read(result, 'issues')),
      ...releaseEvents(repo, read(result, 'releases'))
    ];
    for (const event of batch) {
      if (!event.title && !event.ref) continue;
      const at = event.at;
      if (at === null) { undated += 1; continue; }
      events.push({ ...event, at });
    }
  }

  events.sort((a, b) => (b.at - a.at) || a.repo.localeCompare(b.repo) || a.kind.localeCompare(b.kind));
  const shown = events.slice(0, limit);

  return Object.freeze({
    /*
     * Measured means a repository answered, not that it had something to say.
     * A workspace where nothing happened this week is a real answer and reads
     * as "no activity"; a workspace nothing could be read from is not, and
     * reads as the failure it is.
     */
    measured: answered.length > 0,
    events: Object.freeze(shown.map(event => Object.freeze(event))),
    truncated: events.length > shown.length,
    totalEvents: events.length,
    undated,
    repositories: Object.freeze(answered.slice()),
    failed: Object.freeze(failed)
  });
}
