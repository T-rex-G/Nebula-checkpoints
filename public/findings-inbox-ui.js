/*
 * The findings inbox: every open finding across the workspace, in one list a
 * person can work through.
 *
 * The server decides what each finding is (src/findings-inbox.js); this
 * decides what is on screen. Filters live in the address, so a filtered view
 * can be reloaded, bookmarked and sent to someone. Owners come from each
 * repository's CODEOWNERS file, fetched only for the repositories on screen.
 * Decisions go through each repository's own triage route, one finding at a
 * time, with the same permissions as the audit screen -- the inbox adds a way
 * to reach them in bulk, not a second way to decide.
 *
 * Loaded on its own and tested on its own.
 */
(function (global) {
  'use strict';

  const SEVERITIES = Object.freeze(['critical', 'serious', 'warning']);
  const SEVERITY_WORD = Object.freeze({ critical: 'Critical', serious: 'Serious', warning: 'Warning' });
  const STATE_WORD = Object.freeze({
    regressed: 'Seen again', new: 'New', open: 'Open', 'accepted-risk': 'Risk accepted', 'false-positive': 'Not a problem'
  });
  /* The views a person picks between; "open work" is where the inbox opens. */
  const VIEWS = Object.freeze([
    Object.freeze({ id: 'open', label: 'Open work', match: item => !item.decision }),
    Object.freeze({ id: 'regressed', label: 'Seen again', match: item => item.state === 'regressed' }),
    Object.freeze({ id: 'new', label: 'New this week', match: item => item.state === 'new' }),
    Object.freeze({ id: 'decided', label: 'Decided', match: item => Boolean(item.decision) }),
    Object.freeze({ id: 'all', label: 'Everything', match: () => true })
  ]);
  const KIND_LABEL = Object.freeze({
    'supply-chain': 'Supply chain', code: 'Code security', access: 'Access control', secrets: 'Secrets in code',
    dependencies: 'Dependencies', infrastructure: 'Infrastructure', hygiene: 'Project hygiene', licences: 'Licences',
    ai: 'AI and model output', 'leaked-credentials': 'Leaked credentials'
  });
  const PAGE = 50;

  function kindLabel(kind) {
    return KIND_LABEL[kind] || String(kind || 'Other').replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase());
  }

  /* The address's query, into filters. Anything unrecognised is dropped, not kept. */
  function parseFilters(query) {
    const params = new URLSearchParams(String(query || '').replace(/^\?/, ''));
    const severities = String(params.get('severity') || '').split(',').filter(value => SEVERITIES.includes(value));
    const view = VIEWS.some(entry => entry.id === params.get('view')) ? params.get('view') : 'open';
    const kind = /^[a-z][a-z-]{1,40}$/.test(params.get('kind') || '') ? params.get('kind') : '';
    const repo = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(params.get('repo') || '') ? params.get('repo') : '';
    const q = String(params.get('q') || '').slice(0, 120);
    const pages = Math.min(40, Math.max(1, Number.parseInt(params.get('pages') || '1', 10) || 1));
    return { severities: [...new Set(severities)], view, kind, repo, q, pages };
  }

  function serializeFilters(filters) {
    const params = new URLSearchParams();
    if (filters.view && filters.view !== 'open') params.set('view', filters.view);
    if (filters.severities && filters.severities.length) params.set('severity', SEVERITIES.filter(s => filters.severities.includes(s)).join(','));
    if (filters.kind) params.set('kind', filters.kind);
    if (filters.repo) params.set('repo', filters.repo);
    if (filters.q) params.set('q', filters.q);
    if (filters.pages > 1) params.set('pages', String(filters.pages));
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  function searchable(item, label) {
    return [label, item.rule, item.owner, item.repo, `${item.owner}/${item.repo}`, item.path, kindLabel(item.kind),
      item.package && item.package.name, ...(item.cves || [])].filter(Boolean).join(' ').toLowerCase();
  }

  /*
   * What is on screen. `labelOf` names an exposure rule the way the findings
   * screen does; `ownersOf` answers from the CODEOWNERS files fetched so far.
   */
  function model(inbox, filters, options = {}) {
    if (!inbox) return { state: 'loading' };
    if (inbox.available === false) {
      const reasons = {
        'not-configured': 'Findings are kept in the server database, and this deployment has none.',
        'database-unavailable': 'The server database did not answer, so the findings could not be read. They are read again when you come back.',
        offline: 'You are offline, so the findings could not be read.'
      };
      return { state: 'unavailable', reason: reasons[inbox.reason] || 'The findings could not be read just now.' };
    }
    const labelOf = typeof options.labelOf === 'function' ? options.labelOf : item => item.title || item.rule;
    const ownersOf = typeof options.ownersOf === 'function' ? options.ownersOf : () => null;
    const all = (Array.isArray(inbox.findings) ? inbox.findings : []).map(item => ({ ...item, label: item.title || labelOf(item) }));
    const view = VIEWS.find(entry => entry.id === filters.view) || VIEWS[0];
    const terms = String(filters.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const inView = all.filter(item => view.match(item));
    const matching = inView.filter(item =>
      (!filters.severities.length || filters.severities.includes(item.severity))
      && (!filters.kind || item.kind === filters.kind)
      && (!filters.repo || `${item.owner}/${item.repo}`.toLowerCase() === filters.repo.toLowerCase())
      && terms.every(term => searchable(item, item.label).includes(term)));
    const shown = matching.slice(0, PAGE * filters.pages).map(item => ({ ...item, owners: item.path ? ownersOf(item) : [] }));
    const facet = pick => {
      const counts = new Map();
      for (const item of inView) counts.set(pick(item), (counts.get(pick(item)) || 0) + 1);
      return counts;
    };
    const sources = inbox.sources || {};
    const notes = [];
    if (sources.audit === 'unavailable') notes.push('Audits could not be read; their findings are not listed.');
    if (sources.exposure === 'unavailable') notes.push('Exposure scans could not be read; leaked credentials are not listed.');
    if (inbox.truncated) notes.push('There are more findings than one list holds. The most severe and oldest are shown; narrow the list to reach the rest.');
    return {
      state: all.length ? 'ready' : (sources.audit === 'unavailable' && sources.exposure === 'unavailable' ? 'unmeasured' : 'empty'),
      filters,
      total: all.length,
      undecided: all.filter(item => !item.decision).length,
      views: VIEWS.map(entry => ({ id: entry.id, label: entry.label, count: all.filter(entry.match).length })),
      severities: SEVERITIES.map(severity => ({ id: severity, label: SEVERITY_WORD[severity], count: facet(item => item.severity).get(severity) || 0 })),
      kinds: [...facet(item => item.kind).entries()].map(([id, count]) => ({ id, label: kindLabel(id), count })).sort((a, b) => b.count - a.count),
      repositories: [...facet(item => `${item.owner}/${item.repo}`).entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
      matching: matching.length,
      shown,
      more: Math.max(0, matching.length - shown.length),
      vocabulary: inbox.vocabulary || null,
      notes
    };
  }

  /* ------------------------------------------------------------------ DOM */

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    const node = element('button', className, text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function days(count) {
    if (count === null || count === undefined) return '';
    if (count === 0) return 'today';
    return count === 1 ? '1 day ago' : `${count} days ago`;
  }

  function date(iso) {
    const time = Date.parse(iso || '');
    if (!Number.isFinite(time)) return '';
    return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function where(item) {
    if (!item.path) return `${item.owner}/${item.repo}`;
    return `${item.owner}/${item.repo} · ${item.path}${item.line ? `:${item.line}` : ''}`;
  }

  /* The record of one finding, oldest first, from what the inbox already holds. */
  function timelineEvents(item) {
    const events = [];
    /* A finding that came back is first seen again after its fix: its clock restarted there. */
    if (item.regressedAfter) {
      events.push({ at: item.regressedAfter, text: item.timesFixed > 1 ? `Fixed ${item.timesFixed} times, most recently here` : 'Fixed' });
      if (item.firstSeenAt) events.push({ at: item.firstSeenAt, text: 'Seen again after the fix' });
    } else if (item.firstSeenAt) {
      events.push({ at: item.firstSeenAt, text: item.source === 'exposure' ? 'First found by an exposure scan' : `First seen by an audit of ${item.ref || 'the branch'}` });
    }
    if (item.decision) {
      const word = STATE_WORD[item.decision.disposition] || 'Decided';
      events.push({
        at: item.decision.decidedAt || null,
        text: `${word}${item.decision.expiresAt ? ` until ${date(item.decision.expiresAt)}` : ''}${item.decision.reason ? ` — ${item.decision.reason.replace(/-/g, ' ')}` : ''}`
      });
    }
    return events.sort((a, b) => (Date.parse(a.at || '') || Infinity) - (Date.parse(b.at || '') || Infinity));
  }

  function chip(className, text) {
    return element('span', `fi-chip ${className}`, text);
  }

  function row(item, state, actions) {
    const li = element('li', `fi-item fi-sev-${item.severity}`);
    li.dataset.key = item.key;
    li.dataset.state = item.state;
    const head = element('div', 'fi-item-head');
    const selectable = item.source === 'audit' && !item.decision;
    if (selectable) {
      const box = element('input', 'fi-select');
      box.type = 'checkbox';
      box.checked = state.selected.has(item.key);
      box.setAttribute('aria-label', `Select ${item.label} in ${item.owner}/${item.repo}`);
      box.addEventListener('change', () => actions.select(item, box.checked));
      head.appendChild(box);
    } else {
      head.appendChild(element('span', 'fi-select-gap'));
    }
    const sev = element('span', `fi-sev fi-sev-mark-${item.severity}`, SEVERITY_WORD[item.severity]);
    head.appendChild(sev);
    const main = element('div', 'fi-main');
    main.append(element('p', 'fi-title', item.label), element('p', 'fi-where', where(item)));
    const chips = element('div', 'fi-chips');
    chips.appendChild(chip(`fi-state fi-state-${item.state}`, STATE_WORD[item.state] || item.state));
    chips.appendChild(chip('fi-kind', kindLabel(item.kind)));
    if (item.historyOnly) chips.appendChild(chip('fi-note', 'In history only'));
    if (item.exploited) chips.appendChild(chip('fi-note fi-exploited', 'Exploited in the wild'));
    if (item.ageDays !== null && item.ageDays !== undefined) chips.appendChild(chip('fi-age', `First seen ${days(item.ageDays)}`));
    if (Array.isArray(item.owners) && item.owners.length) chips.appendChild(chip('fi-owner', `Owner ${item.owners.join(', ')}`));
    main.appendChild(chips);
    head.appendChild(main);
    head.appendChild(button('btn btn-ghost small fi-open', 'Open', () => actions.open(item)));
    li.appendChild(head);

    const details = element('details', 'fi-details');
    details.open = state.expanded.has(item.key);
    const summary = element('summary', null, 'Record');
    details.appendChild(summary);
    /* Kept when pressed, so a repaint before the toggle event lands keeps the record open. */
    summary.addEventListener('click', () => actions.expand(item, !details.open));
    const body = element('div', 'fi-record');
    const list = element('ol', 'fi-timeline');
    for (const event of timelineEvents(item)) {
      const entry = element('li');
      if (event.at) entry.appendChild(element('time', 'fi-when', date(event.at)));
      entry.appendChild(element('span', null, event.text));
      list.appendChild(entry);
    }
    body.appendChild(list);
    if (item.package) {
      body.appendChild(element('p', 'fi-fact', `${item.package.name} ${item.package.version}${item.package.fixed ? `, fixed in ${item.package.fixed}` : ', no fixed version published'}${item.cves.length ? ` · ${item.cves.join(', ')}` : ''}`));
    }
    const decisions = element('div', 'fi-decisions');
    body.appendChild(decisions);
    details.appendChild(body);
    details.addEventListener('toggle', () => {
      actions.expand(item, details.open);
      if (details.open && item.source === 'audit' && actions.events) actions.events(item, decisions);
    });
    li.appendChild(details);
    return li;
  }

  function filterChip(label, count, pressed, onClick) {
    const node = button('fi-filter', `${label} ${count}`, onClick);
    node.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    return node;
  }

  function bulkBar(view, state, actions) {
    const bar = element('div', 'fi-bulk');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Decide the selected findings');
    const count = state.selected.size;
    bar.hidden = count === 0;
    bar.appendChild(element('p', 'fi-bulk-count', `${count} selected`));
    const vocabulary = view.vocabulary;
    if (!vocabulary) {
      bar.appendChild(element('p', 'wp-stat-note', 'Decisions are not available here.'));
      return bar;
    }
    const form = element('div', 'fi-bulk-form');
    const disposition = element('select', 'fi-bulk-disposition');
    disposition.setAttribute('aria-label', 'Decision');
    for (const entry of vocabulary.dispositions) {
      const option = element('option', null, entry.label);
      option.value = entry.id;
      disposition.appendChild(option);
    }
    disposition.value = state.disposition || 'accepted-risk';
    const reason = element('select', 'fi-bulk-reason');
    reason.setAttribute('aria-label', 'Reason');
    const daysPick = element('select', 'fi-bulk-days');
    daysPick.setAttribute('aria-label', 'Accept for');
    for (const choice of vocabulary.acceptDays.choices) {
      const option = element('option', null, `${choice} days`);
      option.value = String(choice);
      daysPick.appendChild(option);
    }
    daysPick.value = String(vocabulary.acceptDays.default);
    const fillReasons = () => {
      reason.textContent = '';
      for (const entry of vocabulary.reasons.filter(item => item.disposition === disposition.value)) {
        const option = element('option', null, entry.label);
        option.value = entry.id;
        reason.appendChild(option);
      }
      daysPick.hidden = disposition.value !== 'accepted-risk';
    };
    fillReasons();
    disposition.addEventListener('change', () => { state.disposition = disposition.value; fillReasons(); });
    const apply = button('btn btn-primary small fi-bulk-apply', 'Decide', () => actions.decide({
      disposition: disposition.value,
      reason: reason.value,
      expiresInDays: disposition.value === 'accepted-risk' ? Number(daysPick.value) : undefined
    }));
    const clear = button('btn btn-ghost small fi-bulk-clear', 'Clear selection', () => actions.clearSelection());
    form.append(disposition, reason, daysPick, apply, clear);
    bar.appendChild(form);
    const progress = element('p', 'fi-bulk-progress');
    progress.setAttribute('role', 'status');
    progress.textContent = state.progress || '';
    bar.appendChild(progress);
    return bar;
  }

  function render(host, view, state, actions) {
    if (!host || typeof document === 'undefined') return;
    host.textContent = '';
    host.dataset.state = view.state;
    if (view.state === 'loading') {
      host.appendChild(element('p', 'wp-stat-note', 'Reading every finding the audits and scans have kept…'));
      return;
    }
    if (view.state === 'unavailable') {
      host.appendChild(element('p', 'wp-stat-note', view.reason));
      return;
    }
    if (view.state === 'empty' || view.state === 'unmeasured') {
      const box = element('div', 'fi-empty');
      box.append(
        element('p', 'fi-empty-title', view.state === 'empty' ? 'No findings' : 'The findings could not be read'),
        element('p', 'fi-empty-text', view.state === 'empty'
          ? 'Nothing any audit or exposure scan has kept is open. Audit or scan a repository and what it finds is listed here.'
          : 'Neither the audits nor the exposure scans answered. Nothing here means the workspace is clean.')
      );
      host.appendChild(box);
      return;
    }
    const filters = view.filters;
    const bar = element('div', 'fi-filters');
    const views = element('div', 'fi-views');
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', 'Which findings');
    for (const entry of view.views) {
      views.appendChild(filterChip(entry.label, entry.count, filters.view === entry.id, () => actions.filter({ view: entry.id, pages: 1 })));
    }
    const severities = element('div', 'fi-severities');
    severities.setAttribute('role', 'group');
    severities.setAttribute('aria-label', 'Severity');
    for (const entry of view.severities) {
      const on = filters.severities.includes(entry.id);
      severities.appendChild(filterChip(entry.label, entry.count, on, () => actions.filter({
        severities: on ? filters.severities.filter(value => value !== entry.id) : [...filters.severities, entry.id], pages: 1
      })));
    }
    const selects = element('div', 'fi-selects');
    const kind = element('select', 'fi-kind-select');
    kind.setAttribute('aria-label', 'Kind of finding');
    kind.appendChild(Object.assign(element('option', null, 'Every kind'), { value: '' }));
    for (const entry of view.kinds) kind.appendChild(Object.assign(element('option', null, `${entry.label} (${entry.count})`), { value: entry.id }));
    kind.value = filters.kind;
    kind.addEventListener('change', () => actions.filter({ kind: kind.value, pages: 1 }));
    const repo = element('select', 'fi-repo-select');
    repo.setAttribute('aria-label', 'Repository');
    repo.appendChild(Object.assign(element('option', null, 'Every repository'), { value: '' }));
    for (const entry of view.repositories) repo.appendChild(Object.assign(element('option', null, `${entry.id} (${entry.count})`), { value: entry.id }));
    repo.value = filters.repo;
    repo.addEventListener('change', () => actions.filter({ repo: repo.value, pages: 1 }));
    const search = element('input', 'fi-search');
    search.type = 'search';
    search.placeholder = 'Search title, path, package or CVE';
    search.setAttribute('aria-label', 'Search findings');
    search.value = filters.q;
    let typing = 0;
    search.addEventListener('input', () => {
      clearTimeout(typing);
      typing = setTimeout(() => actions.filter({ q: search.value.trim(), pages: 1 }, { keepFocus: true }), 250);
    });
    selects.append(kind, repo, search);
    bar.append(views, severities, selects);
    host.appendChild(bar);

    const filtered = filters.severities.length || filters.kind || filters.repo || filters.q;
    const summary = element('div', 'fi-summary');
    summary.appendChild(element('p', 'fi-count', `${view.matching} of ${view.total} ${view.total === 1 ? 'finding' : 'findings'}`));
    if (filtered) summary.appendChild(button('btn btn-ghost small fi-clear', 'Clear filters', () => actions.filter({ severities: [], kind: '', repo: '', q: '', pages: 1 })));
    host.appendChild(summary);

    host.appendChild(bulkBar(view, state, actions));

    if (!view.shown.length) {
      host.appendChild(element('p', 'wp-stat-note fi-none', 'Nothing matches these filters.'));
    } else {
      const list = element('ol', 'fi-list');
      list.setAttribute('aria-label', 'Findings');
      for (const item of view.shown) list.appendChild(row(item, state, actions));
      host.appendChild(list);
    }
    if (view.more) host.appendChild(button('btn btn-ghost fi-more', `Show ${Math.min(PAGE, view.more)} more of ${view.more}`, () => actions.filter({ pages: filters.pages + 1 }, { keepScroll: true })));
    for (const note of view.notes) host.appendChild(element('p', 'wp-stat-note', note));
  }

  global.NebulaFindingsInbox = Object.freeze({
    PAGE, VIEWS, SEVERITIES, STATE_WORD, parseFilters, serializeFilters, model, render, kindLabel, timelineEvents
  });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaFindingsInbox;
