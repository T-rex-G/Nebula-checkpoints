/*
 * Open pull requests across the workspace, on the Overview.
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
 *
 * Loaded on its own and tested on its own, like the posture card above it.
 */
(function (global) {
  'use strict';

  /* Shared with the other Overview cards, so they agree about which repositories exist. */
  const Inventory = global.NebulaRepoInventory || (typeof require === 'function' ? require('./repo-inventory') : null);

  /* How many repositories one reading asks, most recently pushed first, and how many at a time. */
  const REPOSITORY_LIMIT = 12;
  const CONCURRENCY = 4;
  /*
   * One page of the list route (per_page in server.js), most recently updated
   * first. A repository that fills it may hold more, and the ones left out are
   * the least recently touched.
   */
  const LIST_PAGE = 30;
  /* A column shows this many before it offers the rest. */
  const COLUMN_SHOWN = 5;
  /* A pull request nobody has touched for this long is called idle. */
  const IDLE_DAYS = 14;
  const DAY_MS = 86400000;
  const LABELS_SHOWN = 3;

  const COLUMNS = Object.freeze([
    Object.freeze({ id: 'review', title: 'Waiting on review', hint: 'A reviewer was asked; longest waiting first.', empty: 'No pull request is waiting on a reviewer.' }),
    Object.freeze({ id: 'unrequested', title: 'No review requested', hint: 'Open, with nobody asked to review; oldest first.', empty: 'Every open pull request has a reviewer asked.' }),
    Object.freeze({ id: 'draft', title: 'Drafts', hint: 'Still being written; most recently updated first.', empty: 'No drafts open.' })
  ]);

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  const repoKey = Inventory.repoKey;

  /* The inventory, most recently pushed first, without duplicates. */
  /* The inventory, most recently pushed first (public/repo-inventory.js reads it). */
  function inventory(repos) {
    return Inventory.inventory(repos).sort((a, b) => b.pushedAt - a.pushedAt || a.key.localeCompare(b.key));
  }

  /* Which repositories one reading asks: the most recently pushed, up to the limit. */
  function pickRepositories(repos, limit = REPOSITORY_LIMIT) {
    return inventory(repos).slice(0, Math.max(0, limit)).map(({ owner, repo, key }) => ({ owner, repo, key }));
  }

  function wholeDays(from, now) {
    const at = Date.parse(String(from || ''));
    if (!Number.isFinite(at)) return null;
    return Math.max(0, Math.floor((now - at) / DAY_MS));
  }

  function ago(daysCount) {
    if (daysCount === null) return null;
    if (daysCount === 0) return 'today';
    if (daysCount === 1) return 'yesterday';
    return `${daysCount} days ago`;
  }

  function item(owner, repo, pull, now) {
    const number = Number(pull.number);
    const createdAt = pull.created_at || null;
    const updatedAt = pull.updated_at || null;
    const reviewers = Math.max(0, Math.floor(Number(pull.reviewers) || 0));
    const idleDays = wholeDays(updatedAt, now);
    return {
      key: `${repoKey(owner, repo)}#${number}`,
      owner,
      repo,
      number,
      title: String(pull.title || `Pull request #${number}`),
      author: pull.user ? String(pull.user) : null,
      head: pull.head ? String(pull.head) : null,
      base: pull.base ? String(pull.base) : null,
      draft: pull.draft === true,
      reviewers,
      labels: Array.isArray(pull.labels) ? pull.labels.map(String).filter(Boolean) : [],
      createdAt,
      updatedAt,
      ageDays: wholeDays(createdAt, now),
      idleDays,
      idle: idleDays !== null && idleDays >= IDLE_DAYS
    };
  }

  function column(entry) {
    if (entry.draft) return 'draft';
    return entry.reviewers > 0 ? 'review' : 'unrequested';
  }

  function stamp(value, fallback) {
    const at = Date.parse(String(value || ''));
    return Number.isFinite(at) ? at : fallback;
  }

  /*
   * The board, decided. `results` holds one entry per repository asked:
   * `{ owner, repo, pulls }` when it answered, `{ owner, repo, error }` when
   * it did not, with `error` one of 'scope', 'offline', 'limited' or
   * 'unreadable' -- a limited one carrying the `retryAfter` GitHub gave.
   * `results` is null while the reading is on its way.
   */
  function model({ results, repos, limit = REPOSITORY_LIMIT, now = Date.now() } = {}) {
    const known = inventory(repos);
    if (!known.length) return { state: 'no-repositories' };
    if (!Array.isArray(results)) return { state: 'loading', asked: Math.min(limit, known.length), inventory: known.length };
    const read = results.filter(result => Array.isArray(result.pulls));
    const refused = results.filter(result => !Array.isArray(result.pulls) && result.error === 'scope').map(result => `${result.owner}/${result.repo}`);
    const failed = results.filter(result => !Array.isArray(result.pulls) && result.error !== 'scope');
    const unreadable = failed.filter(result => result.error !== 'limited').map(result => `${result.owner}/${result.repo}`);
    const limited = failed.filter(result => result.error === 'limited');
    const offline = results.some(result => result.error === 'offline');
    const capped = read.filter(result => result.pulls.length >= LIST_PAGE).map(result => `${result.owner}/${result.repo}`);
    const coverage = {
      read: read.length, asked: results.length, inventory: known.length, refused, unreadable, capped,
      limited: limited.map(result => `${result.owner}/${result.repo}`),
      /* The longest wait GitHub named: reading again sooner would be refused again. */
      retryAfter: limited.reduce((longest, result) => Math.max(longest, Number(result.retryAfter) || 0), 0)
    };
    if (!read.length) {
      const reason = offline ? 'offline' : refused.length === results.length ? 'scope' : !unreadable.length && limited.length ? 'limited' : 'unreadable';
      return { state: 'unavailable', coverage, reason };
    }
    const entries = [];
    for (const result of read) {
      for (const pull of result.pulls) {
        if (!pull || pull.state !== 'open' || !Number.isFinite(Number(pull.number))) continue;
        entries.push(item(result.owner, result.repo, pull, now));
      }
    }
    const columns = COLUMNS.map(definition => {
      const items = entries.filter(entry => column(entry) === definition.id);
      if (definition.id === 'draft') items.sort((a, b) => stamp(b.updatedAt, 0) - stamp(a.updatedAt, 0) || a.key.localeCompare(b.key));
      else items.sort((a, b) => stamp(a.createdAt, Infinity) - stamp(b.createdAt, Infinity) || a.key.localeCompare(b.key));
      return { id: definition.id, title: definition.title, hint: definition.hint, empty: definition.empty, items };
    });
    const repositories = new Set(entries.map(entry => repoKey(entry.owner, entry.repo))).size;
    const waiting = columns[0].items;
    return {
      state: entries.length ? 'ready' : 'empty',
      total: entries.length,
      repositories,
      waiting: waiting.length,
      longestWait: waiting.length ? waiting[0].ageDays : null,
      idle: entries.filter(entry => entry.idle).length,
      columns,
      coverage
    };
  }

  /* The card's first line: how much is open and how long the longest wait has been. */
  function sentence(view) {
    if (view.state === 'empty') return `No open pull requests in the ${plural(view.coverage.read, 'repository', 'repositories')} read.`;
    /* A repository cut at one page makes every count a floor and the longest wait the longest shown. */
    const cut = Boolean(view.coverage && view.coverage.capped && view.coverage.capped.length);
    const count = plural(view.total, 'open pull request', 'open pull requests');
    const open = `${cut ? `At least ${count}` : count.charAt(0).toUpperCase() + count.slice(1)} in ${plural(view.repositories, 'repository', 'repositories')}`;
    if (!view.waiting) return `${open}; none waiting on a reviewer${cut ? ' among those shown' : ''}.`;
    const shown = cut ? 'the longest shown' : 'the longest';
    const longest = view.longestWait === null ? '' : view.longestWait === 0 ? `, ${shown} since today` : `, ${shown} for ${plural(view.longestWait, 'day', 'days')}`;
    return `${open}: ${view.waiting} waiting on review${longest}.`;
  }

  function notes(view) {
    const out = [];
    const coverage = view.coverage;
    if (!coverage) return out;
    if (coverage.inventory > coverage.asked) {
      out.push(`Read from the ${coverage.asked} most recently pushed of ${coverage.inventory} repositories.`);
    }
    const names = list => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
    if (coverage.refused.length) {
      out.push(`${plural(coverage.refused.length, 'repository is', 'repositories are')} outside this session's repository scope: ${names(coverage.refused)}.`);
    }
    if (coverage.unreadable.length) {
      out.push(`${plural(coverage.unreadable.length, 'repository', 'repositories')} could not be read just now: ${names(coverage.unreadable)}.`);
    }
    if (coverage.limited && coverage.limited.length) {
      out.push(`GitHub is limiting requests for this account, so ${plural(coverage.limited.length, 'repository was', 'repositories were')} not read: ${names(coverage.limited)}. Read again in ${waitPhrase(coverage.retryAfter)}.`);
    }
    if (coverage.capped && coverage.capped.length) {
      out.push(coverage.capped.length === 1
        ? `${coverage.capped[0]} has more open pull requests than one list holds; these are its ${LIST_PAGE} most recently updated.`
        : `${names(coverage.capped)} have more open pull requests than one list holds; each shows its ${LIST_PAGE} most recently updated.`);
    }
    return out;
  }

  /*
   * How long, said the way a reader says it. A limit that named no wait is
   * read again after a minute, which is what GitHub asks of a client that was
   * given none.
   */
  function waitPhrase(seconds) {
    const value = Math.ceil(Number(seconds) || 0);
    if (value <= 0) return 'a minute';
    if (value === 1) return 'a second';
    if (value < 60) return `${value} seconds`;
    const minutes = Math.ceil(value / 60);
    if (minutes === 1) return 'a minute';
    if (minutes < 60) return `${minutes} minutes`;
    return minutes === 60 ? 'an hour' : 'more than an hour';
  }

  /* Read the repositories a few at a time; one that fails is recorded, not fatal. */
  async function readAll(repositories, fetchPulls, concurrency = CONCURRENCY) {
    const results = new Array(repositories.length);
    let next = 0;
    async function worker() {
      while (next < repositories.length) {
        const index = next++;
        const { owner, repo } = repositories[index];
        try {
          const pulls = await fetchPulls(owner, repo);
          results[index] = Array.isArray(pulls) ? { owner, repo, pulls } : { owner, repo, error: 'unreadable' };
        } catch (error) {
          const code = String(error && error.code || '');
          if (code === 'PROVIDER_RATE_LIMITED') {
            results[index] = { owner, repo, error: 'limited', retryAfter: Math.max(0, Number(error.retryAfter) || 0) };
            continue;
          }
          const kind = /^ALPHA_REPOSITORY_/.test(code) ? 'scope' : error && error.offline ? 'offline' : 'unreadable';
          results[index] = { owner, repo, error: kind };
        }
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, repositories.length); i += 1) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  /* ------------------------------------------------------------------ DOM */

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* Which columns a reader has opened past the first few. Kept for the page's life only. */
  const expandedColumns = new Set();

  function card(entry, actions) {
    const li = element('li', `pb-item${entry.idle ? ' pb-idle' : ''}`);
    const open = element('button', 'pb-open');
    open.type = 'button';
    open.setAttribute('aria-label', `Open pull request #${entry.number} in ${entry.owner}/${entry.repo}: ${entry.title}`);
    open.appendChild(element('span', 'pb-title', entry.title));
    open.appendChild(element('span', 'pb-where', `${entry.owner}/${entry.repo} #${entry.number}`));
    const meta = [];
    if (entry.author) meta.push(entry.author);
    const opened = ago(entry.ageDays);
    if (opened) meta.push(`opened ${opened}`);
    if (entry.reviewers) meta.push(plural(entry.reviewers, 'reviewer asked', 'reviewers asked'));
    if (meta.length) open.appendChild(element('span', 'pb-meta', meta.join(' · ')));
    if (entry.head && entry.base) open.appendChild(element('span', 'pb-branch', `${entry.head} → ${entry.base}`));
    open.addEventListener('click', () => { if (actions && actions.open) actions.open(entry.owner, entry.repo, entry.number); });
    li.appendChild(open);
    const chips = [];
    if (entry.idle) chips.push(element('span', 'pb-chip pb-chip-idle', `Idle ${plural(entry.idleDays, 'day', 'days')}`));
    for (const label of entry.labels.slice(0, LABELS_SHOWN)) chips.push(element('span', 'pb-chip', label));
    if (entry.labels.length > LABELS_SHOWN) chips.push(element('span', 'pb-chip pb-chip-more', `+${entry.labels.length - LABELS_SHOWN}`));
    if (chips.length) {
      const row = element('div', 'pb-chips');
      row.append(...chips);
      li.appendChild(row);
    }
    return li;
  }

  function columnSection(definition, actions, repaint) {
    const section = element('section', `pb-col pb-col-${definition.id}`);
    const titleId = `pbCol-${definition.id}`;
    section.setAttribute('aria-labelledby', titleId);
    const head = element('div', 'pb-col-head');
    const title = element('h3', 'pb-col-title', definition.title);
    title.id = titleId;
    const countNode = element('span', 'pb-col-count', String(definition.items.length));
    countNode.setAttribute('aria-label', plural(definition.items.length, 'pull request', 'pull requests'));
    head.append(title, countNode);
    section.appendChild(head);
    section.appendChild(element('p', 'pb-col-hint', definition.hint));
    if (!definition.items.length) {
      section.appendChild(element('p', 'pb-col-empty', definition.empty));
      return section;
    }
    const expanded = expandedColumns.has(definition.id);
    const shown = expanded ? definition.items : definition.items.slice(0, COLUMN_SHOWN);
    const list = element('ol', 'pb-list');
    for (const entry of shown) list.appendChild(card(entry, actions));
    section.appendChild(list);
    if (definition.items.length > COLUMN_SHOWN) {
      const more = element('button', 'btn btn-ghost small pb-more',
        expanded ? 'Show fewer' : `Show ${definition.items.length - COLUMN_SHOWN} more`);
      more.type = 'button';
      more.setAttribute('aria-expanded', String(expanded));
      more.addEventListener('click', () => {
        if (expanded) expandedColumns.delete(definition.id);
        else expandedColumns.add(definition.id);
        repaint();
      });
      section.appendChild(more);
    }
    return section;
  }

  const UNAVAILABLE = Object.freeze({
    offline: 'You are offline, so the pull requests could not be read.',
    scope: 'Every repository asked is outside this session\'s repository scope.',
    unreadable: 'The pull requests could not be read just now.'
  });

  function render(host, view, actions) {
    if (!host || typeof document === 'undefined') return;
    const repaint = () => render(host, view, actions);
    host.textContent = '';
    host.dataset.state = view.state;
    const head = element('div', 'wp-head pb-head');
    head.append(element('span', 'wp-label', 'PULL REQUESTS'));
    if (actions && actions.refresh && view.state !== 'loading' && view.state !== 'no-repositories') {
      const again = element('button', 'btn btn-ghost small pb-refresh', 'Read again');
      again.type = 'button';
      again.setAttribute('aria-label', 'Read the pull requests again');
      again.addEventListener('click', () => actions.refresh());
      head.append(again);
    }
    host.appendChild(head);
    if (view.state === 'no-repositories') {
      host.appendChild(element('p', 'wp-stat-note', 'No repositories in this inventory yet, so there is nothing to read.'));
      return;
    }
    if (view.state === 'loading') {
      host.appendChild(element('p', 'wp-stat-note', `Reading the open pull requests of ${plural(view.asked, 'repository', 'repositories')}…`));
      return;
    }
    if (view.state === 'unavailable' && view.reason === 'limited') {
      host.appendChild(element('p', 'wp-stat-note', `GitHub is limiting requests for this account, so the pull requests could not be read. Read again in ${waitPhrase(view.coverage.retryAfter)}.`));
    } else if (view.state === 'unavailable') {
      host.appendChild(element('p', 'wp-stat-note', UNAVAILABLE[view.reason] || UNAVAILABLE.unreadable));
    } else {
      host.appendChild(element('p', 'pb-sentence', sentence(view)));
      if (view.state === 'ready') {
        const grid = element('div', 'pb-columns');
        for (const definition of view.columns) grid.appendChild(columnSection(definition, actions, repaint));
        host.appendChild(grid);
      }
    }
    const lines = notes(view);
    if (lines.length) {
      const list = element('ul', 'pb-notes');
      for (const line of lines) list.appendChild(element('li', null, line));
      host.appendChild(list);
    }
  }

  global.NebulaPullBoard = Object.freeze({
    COLUMNS, REPOSITORY_LIMIT, CONCURRENCY, COLUMN_SHOWN, IDLE_DAYS, LIST_PAGE,
    pickRepositories, readAll, model, sentence, notes, render, waitPhrase
  });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaPullBoard;
