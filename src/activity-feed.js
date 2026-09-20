'use strict';

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

const KINDS = Object.freeze(['commit', 'pull', 'issue', 'release']);

/*
 * The per-repository cost of a feed is what limits how wide it can be. Each
 * repository is a separate provider round trip, so the fan-out is bounded here
 * rather than by whatever the caller happens to pass: an inventory of two
 * hundred repositories must not become two hundred requests because someone
 * opened the overview.
 */
const MAX_REPOSITORIES = 6;
const MAX_EVENTS = 24;

function text(value, limit = 200) {
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
function instant(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function repositoryName(entry) {
  return text((entry && (entry.repo || entry.full_name || entry.fullName)) || '', 140);
}

/* ------------------------------------------------------------- the events */

function commitEvents(repo, list) {
  return (Array.isArray(list) ? list : []).map(item => {
    const sha = text(item && item.sha, 40);
    return {
      kind: 'commit',
      repo,
      /* The subject line only. A commit body belongs to the commit, not to a
         feed entry, and pasting one in makes every row a different height. */
      title: text(String((item && item.message) || '').split(/\r?\n/, 1)[0], 120),
      detail: sha ? sha.slice(0, 7) : '',
      actor: text(item && item.author, 80),
      at: instant(item && item.date),
      ref: sha
    };
  });
}

function pullEvents(repo, list) {
  return (Array.isArray(list) ? list : []).map(item => ({
    kind: 'pull',
    repo,
    title: text(item && item.title, 120),
    /* merged / open / closed, as the route already resolved it -- this does
       not re-derive state from a merged_at field it was never given. */
    detail: text(item && item.state, 20),
    actor: '',
    at: instant(item && item.updated),
    ref: Number.isFinite(Number(item && item.number)) ? `#${Number(item.number)}` : ''
  }));
}

function issueEvents(repo, list) {
  return (Array.isArray(list) ? list : []).map(item => ({
    kind: 'issue',
    repo,
    title: text(item && item.title, 120),
    detail: text(item && item.state, 20),
    actor: '',
    at: instant(item && item.updated),
    ref: Number.isFinite(Number(item && item.number)) ? `#${Number(item.number)}` : ''
  }));
}

function releaseEvents(repo, list) {
  return (Array.isArray(list) ? list : []).map(item => ({
    kind: 'release',
    repo,
    title: text((item && (item.name || item.tag)) || '', 120),
    detail: text(item && item.tag, 60),
    actor: '',
    at: instant(item && item.published),
    ref: text(item && item.tag, 60)
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
function bound(value, max) {
  const asked = Number(value);
  return Number.isFinite(asked) ? Math.max(1, Math.min(max, asked)) : max;
}

/*
 * Which repositories are worth asking about.
 *
 * Most recently pushed first, because that is the only ordering the inventory
 * can supply without spending a request. A repository with no push time is not
 * treated as brand new -- it sorts last, where an unknown belongs, rather than
 * displacing a repository that demonstrably moved this morning.
 */
function selectRepositories(repos, limit = MAX_REPOSITORIES) {
  const count = bound(limit, MAX_REPOSITORIES);
  return (Array.isArray(repos) ? repos : [])
    .map(repo => ({
      full_name: repositoryName(repo),
      owner: text((repo && (repo.owner && repo.owner.login ? repo.owner.login : repo.owner)) || '', 80),
      name: text(repo && repo.name, 80),
      pushedAt: instant(repo && (repo.pushed_at || repo.pushedAt))
    }))
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

/*
 * One ordered feed out of many per-repository answers.
 *
 * `results` is one entry per repository that was asked, each either an
 * activity payload or an error. Both are kept: the payloads become events and
 * the errors become named repositories the reader is told about.
 */
function feed(results, options = {}) {
  const limit = bound(options && options.limit, MAX_EVENTS);
  const answered = [];
  const failed = [];
  let undated = 0;
  const events = [];

  for (const result of Array.isArray(results) ? results : []) {
    const repo = repositoryName(result);
    if (!repo) continue;
    if (!result || result.error) {
      failed.push(Object.freeze({
        repo,
        /* The reason, as given. Not "something went wrong": a reader who can
           see "rate limit exceeded" knows to wait, and one who sees "not
           found" knows the repository moved. */
        reason: text((result && result.error) || 'unavailable', 160)
      }));
      continue;
    }
    answered.push(repo);
    const batch = [
      ...commitEvents(repo, result.commits),
      ...pullEvents(repo, result.pulls),
      ...issueEvents(repo, result.issues),
      ...releaseEvents(repo, result.releases)
    ];
    for (const event of batch) {
      if (!event.title && !event.ref) continue;
      if (event.at === null) { undated += 1; continue; }
      events.push(event);
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

module.exports = {
  KINDS,
  MAX_REPOSITORIES,
  MAX_EVENTS,
  instant,
  selectRepositories,
  feed
};
