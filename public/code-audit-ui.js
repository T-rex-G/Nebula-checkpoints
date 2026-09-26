/*
 * The repository audit, drawn.
 *
 * The order is the argument, as it is on the Exposure screen: the grade and
 * how much of the repository it rests on come first, then the three jobs to
 * do first, then the five families the grade was built from, then every
 * finding. A findings list alone invites the reading "nothing here, so
 * nothing is wrong", which a partial read does not support.
 *
 * The screen talks in shapes before words -- a ring for the score, a tile per
 * family, a stripe and an icon per severity -- and every shape carries its
 * word as well, so nothing is said by colour alone.
 *
 * Everything is built with textContent. The audit's words are the rules' own,
 * paths come from a repository and advisory summaries from a public database,
 * and none of them is ever parsed as markup.
 */
'use strict';

(function codeAuditModule(global) {
  const SEVERITY = Object.freeze({
    critical: Object.freeze({ glyph: '✕', word: 'Critical', icon: 'M8.6 3.5h6.8l5.1 5.1v6.8l-5.1 5.1H8.6l-5.1-5.1V8.6zM9.4 9.4l5.2 5.2M14.6 9.4l-5.2 5.2' }),
    serious: Object.freeze({ glyph: '△', word: 'Serious', icon: 'M12 4l9 15.5H3zM12 10v4.2M12 16.9v.1' }),
    warning: Object.freeze({ glyph: '○', word: 'Warning', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 11v5M12 7.9v.1' })
  });
  const ORDER = Object.freeze(['critical', 'serious', 'warning']);
  /* One drawn mark per family, so the tiles read before their labels do. */
  const FAMILY_ICON = Object.freeze({
    'supply-chain': 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
    code: 'M8.5 7l-5 5 5 5M15.5 7l5 5-5 5M13.4 4.5l-2.8 15',
    secrets: 'M8 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM11.5 12h9M17.5 12v3M14.5 12v2.2',
    dependencies: 'M6 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM18 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM12 15.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM7 8l4 7.8M17 8l-4 7.8M8.2 6h7.6',
    hygiene: 'M7 4h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 3.5h6M9 12.5l2.1 2.1 4-4.3'
  });
  const ICON = Object.freeze({
    download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
    copy: 'M9 9h9.5a1.5 1.5 0 0 1 1.5 1.5V20a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 20v-9.5A1.5 1.5 0 0 1 9 9zM16.5 9V5.5A1.5 1.5 0 0 0 15 4H5.5A1.5 1.5 0 0 0 4 5.5V15a1.5 1.5 0 0 0 1.5 1.5H7.5',
    run: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
    file: 'M7 3.5h6.5L18 8v12.5H7zM13.5 3.5V8H18',
    box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
    shield: 'M12 3.3l7.2 3v5.3c0 4.3-3 7.9-7.2 9.4-4.2-1.5-7.2-5.1-7.2-9.4V6.3zM9.3 12l2 2 3.5-3.8',
    commit: 'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zM3.5 12h5.1M15.4 12h5.1',
    globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.6 2.4 3.8 5.3 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.3-3.8-8.5S9.4 5.9 12 3.5z',
    arrow: 'M5 12h13M13 6.5l5.5 5.5-5.5 5.5',
    link: 'M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    check: 'M5 12.5l4.2 4.2L19 7'
  });
  const STORE_PREFIX = 'nv_audit:';
  const SVG = 'http://www.w3.org/2000/svg';
  const ADVISORY_ID = /^[A-Za-z][A-Za-z0-9._-]{2,63}$/;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(path, className = 'audit-ico') {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', className);
    const shape = document.createElementNS(SVG, 'path');
    shape.setAttribute('d', path);
    svg.appendChild(shape);
    return svg;
  }
  function button(label, className, onClick) {
    const node = element('button', className, label);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }
  /* An icon and a short word; the accessible name says the whole action. */
  function iconButton(path, word, name, className, onClick) {
    const node = button('', className, onClick);
    node.append(icon(path), element('span', 'audit-btn-label', word));
    node.setAttribute('aria-label', name);
    node.title = name;
    return node;
  }
  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }
  function location(finding) {
    if (!finding.path) return 'Whole repository';
    return finding.line ? `${finding.path}:${finding.line}` : finding.path;
  }
  function severityCounts(findings) {
    const counts = { critical: 0, serious: 0, warning: 0 };
    for (const finding of findings) counts[finding.severity] += 1;
    return counts;
  }
  function reducedMotion() {
    return document.documentElement.dataset.motion === 'off' ||
      Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /*
   * What changed since this browser last audited the same repository: which
   * findings are new, and how many earlier ones are gone. Identities only --
   * the stored record is a list of fingerprints and a time, nothing a
   * repository wrote -- and the account-boundary purge removes it.
   */
  function diff(result, previous) {
    if (!previous || !Array.isArray(previous.ids)) return null;
    const before = new Set(previous.ids);
    const now = new Set(result.findings.map(finding => finding.id));
    return {
      previousAt: previous.at || null,
      newIds: new Set([...now].filter(id => !before.has(id))),
      resolved: [...before].filter(id => !now.has(id)).length
    };
  }
  function storageKey(repoKey) {
    return `${STORE_PREFIX}${String(repoKey || '').toLowerCase()}`;
  }
  function readPrevious(repoKey) {
    try { return JSON.parse(global.localStorage.getItem(storageKey(repoKey)) || 'null'); } catch { return null; }
  }
  function remember(repoKey, result) {
    try {
      global.localStorage.setItem(storageKey(repoKey), JSON.stringify({
        at: result.auditedAt || new Date().toISOString(),
        ids: result.findings.map(finding => finding.id).slice(0, 2000)
      }));
    } catch { /* private mode: no comparison next time, and nothing is lost */ }
  }

  /* ---- What a result rests on ------------------------------------------------ */

  function coverageLine(result) {
    const coverage = result.coverage || {};
    const parts = [`Read ${coverage.read} of ${coverage.eligible} files it audits at ${String(result.commitSha || '').slice(0, 7)}`];
    const packages = coverage.packages || {};
    if (packages.declared) {
      parts.push(`${packages.checked} of ${packages.declared} packages checked against their registry` +
        (packages.unknown ? ` (${packages.unknown} unanswered, not counted as missing)` : ''));
    }
    const advisories = coverage.advisories || {};
    if (advisories.versions) {
      parts.push(`${advisories.checked} of ${advisories.versions} package versions checked against OSV` +
        (advisories.unknown ? ` (${advisories.unknown} unanswered)` : ''));
    }
    return `${parts.join(' · ')}.`;
  }
  function coverageCaveat(result) {
    const coverage = result.coverage || {};
    const notes = [];
    if (coverage.treeTruncated) notes.push('the provider truncated the file listing');
    if (coverage.skipped && coverage.skipped.budget) notes.push(`${plural(coverage.skipped.budget, 'file', 'files')} beyond the audit budget were not read`);
    if (coverage.skipped && coverage.skipped.oversize) notes.push(`${plural(coverage.skipped.oversize, 'file', 'files')} over 512 KB were not read`);
    if (coverage.unreadable) notes.push(`${plural(coverage.unreadable, 'file', 'files')} could not be read`);
    if (coverage.packages && coverage.packages.notChecked) notes.push(`${plural(coverage.packages.notChecked, 'package', 'packages')} beyond the lookup limit were not checked`);
    const advisories = coverage.advisories || {};
    if (advisories.notChecked) notes.push(`${plural(advisories.notChecked, 'package version', 'package versions')} beyond the advisory limit were not checked`);
    if (advisories.lockfiles > advisories.lockfilesRead) notes.push('a lockfile was not read (over 512 KB or past the budget), so declared ranges stood in for installed versions');
    return notes.length ? `Not a complete read: ${notes.join('; ')}. A finding-free section here is not a finding-free repository.` : '';
  }

  /*
   * The evidence as four figures a reader takes in at a glance. The sentence
   * above is what the brief carries; on screen it is the title of the strip,
   * so it is there on hover and to a screen reader without being read twice.
   */
  function evidence(result) {
    const coverage = result.coverage || {};
    const strip = element('dl', 'audit-evidence');
    strip.setAttribute('aria-label', coverageLine(result));
    const add = (path, term, value, title) => {
      const item = element('div', 'audit-evidence-item');
      item.title = title;
      const dt = element('dt');
      dt.append(icon(path), element('span', null, term));
      item.append(dt, element('dd', null, value));
      strip.appendChild(item);
    };
    add(ICON.file, 'Files', `${coverage.read} of ${coverage.eligible}`, 'Files read of the files the audit reads');
    const packages = coverage.packages || {};
    add(ICON.box, 'Registry', packages.declared ? `${packages.checked} of ${packages.declared}` : 'None declared', 'Declared packages the public registry answered for');
    const advisories = coverage.advisories || {};
    add(ICON.shield, 'Advisories', advisories.versions ? `${advisories.checked} versions` : 'Not asked', 'Package versions checked against the OSV vulnerability database');
    add(ICON.commit, 'Commit', String(result.commitSha || '').slice(0, 7) || '—', 'The commit this audit read');
    return strip;
  }

  /* ---- The score ------------------------------------------------------------ */

  /*
   * The score as a ring: the arc is the score, the letter the grade. The arc
   * grows into place once, when a result first arrives, and not on a redraw
   * that only changed a filter.
   */
  function ring(result, status, label, animateFrom) {
    const wrap = element('div', `audit-grade audit-grade-${result ? result.grade : 'none'}`);
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', label);
    if (status === 'running') wrap.dataset.running = 'true';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'audit-ring');
    const track = document.createElementNS(SVG, 'circle');
    const arc = document.createElementNS(SVG, 'circle');
    for (const circle of [track, arc]) {
      circle.setAttribute('cx', '60');
      circle.setAttribute('cy', '60');
      circle.setAttribute('r', '52');
      circle.setAttribute('pathLength', '100');
    }
    track.setAttribute('class', 'audit-ring-track');
    arc.setAttribute('class', 'audit-ring-arc');
    arc.setAttribute('transform', 'rotate(-90 60 60)');
    const score = result ? Math.max(0, Math.min(100, Number(result.score) || 0)) : status === 'running' ? 28 : 0;
    const start = animateFrom === null || reducedMotion() ? score : animateFrom;
    arc.style.strokeDasharray = `${start} 100`;
    /* A round cap on a zero-length arc is a dot, which reads as a score. */
    if (score === 0 && status !== 'running') arc.dataset.empty = 'true';
    if (start !== score) global.requestAnimationFrame(() => global.requestAnimationFrame(() => { arc.style.strokeDasharray = `${score} 100`; }));
    svg.append(track, arc);
    const face = element('div', 'audit-grade-face');
    face.append(element('span', 'audit-grade-letter', result ? result.grade : '—'),
      element('span', 'audit-grade-score', result ? `${result.score}/100` : status === 'running' ? 'reading' : 'not audited'));
    wrap.append(svg, face);
    return wrap;
  }

  function verdict(result, status) {
    if (status === 'running') return 'Auditing this branch…';
    if (!result) return 'Not audited yet';
    const counts = severityCounts(result.findings);
    if (counts.critical) return `${plural(counts.critical, 'critical issue', 'critical issues')} to fix`;
    if (counts.serious) return `${plural(counts.serious, 'serious issue', 'serious issues')} to fix`;
    if (counts.warning) return `${plural(counts.warning, 'warning', 'warnings')}, nothing serious`;
    return 'Nothing found in what was read';
  }

  function severityTally(findings) {
    const counts = severityCounts(findings);
    const list = element('ul', 'audit-tally');
    list.setAttribute('aria-label', `${plural(findings.length, 'finding', 'findings')}: ${ORDER.map(severity => `${counts[severity]} ${severity}`).join(', ')}`);
    for (const severity of ORDER) {
      const item = element('li', 'audit-tally-item');
      item.dataset.severity = severity;
      item.dataset.zero = counts[severity] ? 'false' : 'true';
      item.append(icon(SEVERITY[severity].icon), element('span', 'audit-tally-n', String(counts[severity])), element('span', 'audit-tally-w', SEVERITY[severity].word));
      list.appendChild(item);
    }
    return list;
  }

  /* What the audit reads, for the moment before it has read anything. */
  const SCOPE = Object.freeze(['Install scripts', 'CI workflows', 'Injection & XSS', 'Committed secrets', 'OSV advisories', 'Malicious packages', 'Typosquats', 'Supabase RLS', 'Firebase rules', 'Hygiene']);

  function renderSummary(host, view, handlers, previous) {
    const card = element('section', 'card audit-summary');
    card.setAttribute('aria-labelledby', 'auditSummaryHeading');
    const result = view.result;
    const status = view.status;

    const layout = element('div', 'audit-grade-row');
    const label = result ? `Grade ${result.grade}, ${result.score} out of 100` : status === 'running' ? 'Auditing' : 'Not audited';
    const fresh = result && (!previous || previous.id !== resultId(result));
    layout.appendChild(ring(result, status, label, fresh ? 0 : null));

    const read = element('div', 'audit-grade-read');
    const head = element('div', 'audit-summary-head');
    const heading = element('h2', 'audit-kicker', 'Repository audit');
    heading.id = 'auditSummaryHeading';
    head.appendChild(heading);
    if (result && result.ref) head.appendChild(element('span', 'audit-ref', result.ref));
    read.appendChild(head);
    read.appendChild(element('p', 'audit-verdict', verdict(result, status)));

    if (status === 'error') {
      const error = element('p', 'audit-lede audit-error', view.error || 'The audit could not be completed.');
      error.setAttribute('role', 'alert');
      read.appendChild(error);
    }
    if (status === 'running') {
      read.appendChild(element('p', 'audit-lede audit-muted', 'Reading files, asking the registries and OSV.'));
    } else if (!result) {
      const scope = element('ul', 'audit-scope');
      scope.setAttribute('aria-label', 'What the audit checks');
      for (const item of SCOPE) scope.appendChild(element('li', null, item));
      read.appendChild(scope);
    } else {
      read.appendChild(severityTally(result.findings));
      const notes = element('div', 'audit-notes');
      if (result.capped) notes.appendChild(element('p', 'audit-cap', 'Held below 50 while a critical finding is open.'));
      if (view.diff) {
        const since = view.diff.previousAt ? ` since the audit of ${new Date(view.diff.previousAt).toLocaleString()}` : '';
        notes.appendChild(element('p', 'audit-diff',
          `${plural(view.diff.newIds.size, 'new finding', 'new findings')}, ${view.diff.resolved} resolved${since}.`));
      }
      if (notes.childNodes.length) read.appendChild(notes);
    }
    layout.appendChild(read);
    card.appendChild(layout);

    if (result && status !== 'running') {
      card.appendChild(evidence(result));
      const caveat = coverageCaveat(result);
      if (caveat) card.appendChild(element('p', 'exposure-caveat', caveat));
    }

    const actions = element('div', 'audit-actions');
    const run = button('', 'btn btn-primary audit-run', handlers.onRun);
    run.append(icon(ICON.run), element('span', 'audit-btn-label', status === 'running' ? 'Auditing…' : result ? 'Audit again' : 'Audit this branch'));
    run.disabled = status === 'running';
    actions.appendChild(run);
    if (result) {
      actions.appendChild(iconButton(ICON.download, 'Brief', 'Export developer brief', 'btn btn-ghost audit-tool', handlers.onExport));
      if (result.findings.length) actions.appendChild(iconButton(ICON.copy, 'Prompts', 'Copy all fix prompts', 'btn btn-ghost audit-tool', handlers.onCopyAll));
    }
    card.appendChild(actions);
    host.appendChild(card);
  }

  function resultId(result) {
    return `${result.commitSha || ''}|${result.auditedAt || ''}|${result.score}`;
  }

  /* ---- Fix first ------------------------------------------------------------ */

  function detailChip(finding) {
    const detail = finding.detail;
    if (!detail) return null;
    if (finding.rule === 'SCR-001' && detail.credential) return detail.credential;
    if (finding.rule === 'DEP-004') return `${detail.package} ≈ ${detail.resembles}`;
    if (detail.package) {
      if (finding.rule === 'DEP-006') return `${detail.package} ${detail.version}`;
      return detail.fixed ? `${detail.package} ${detail.version} → ${detail.fixed}` : `${detail.package} ${detail.version}`;
    }
    return null;
  }

  function renderPriorities(host, view, handlers, root) {
    const result = view.result;
    if (!result || !Array.isArray(result.priorities) || !result.priorities.length || view.filter || view.severity) return;
    const byId = new Map(result.findings.map(finding => [finding.id, finding]));
    const chosen = result.priorities.map(id => byId.get(id)).filter(Boolean);
    if (!chosen.length) return;
    const card = element('section', 'card audit-first');
    card.setAttribute('aria-labelledby', 'auditFirstHeading');
    const heading = element('h2', 'audit-kicker', 'Fix first');
    heading.id = 'auditFirstHeading';
    card.appendChild(heading);
    const list = element('ol', 'audit-first-list');
    chosen.forEach((finding, index) => {
      const item = element('li', 'audit-first-item');
      item.dataset.severity = finding.severity;
      const control = button('', 'audit-first-btn', () => focusFinding(root, finding.id));
      control.setAttribute('aria-label', `${index + 1}. ${SEVERITY[finding.severity].word}: ${finding.title}, ${location(finding)}`);
      const rank = element('span', 'audit-first-rank', String(index + 1));
      const body = element('span', 'audit-first-body');
      body.append(element('span', 'audit-first-title', finding.title), element('span', 'audit-first-where', location(finding)));
      const chip = detailChip(finding);
      if (chip) body.appendChild(element('span', 'audit-first-chip', chip));
      control.append(rank, icon(SEVERITY[finding.severity].icon, 'audit-ico audit-first-sev'), body, icon(ICON.arrow, 'audit-ico audit-first-go'));
      item.appendChild(control);
      list.appendChild(item);
    });
    card.appendChild(list);
    host.appendChild(card);
  }

  /* Opens a finding in the list and brings it into view, with focus on its row. */
  function focusFinding(root, id) {
    const details = root.querySelector(`details[data-finding-id="${CSS.escape(id)}"]`);
    if (!details) return;
    details.open = true;
    const summary = details.querySelector('summary');
    details.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    if (summary) summary.focus({ preventScroll: true });
  }

  /* ---- Families ------------------------------------------------------------- */

  function renderCategories(host, view, handlers) {
    const result = view.result;
    if (!result) return;
    const list = element('ul', 'audit-categories');
    list.setAttribute('aria-label', 'Audit families');
    for (const category of result.categories) {
      const item = element('li', 'audit-category');
      const control = button('', 'audit-category-btn', () => handlers.onFilter(view.filter === category.id ? null : category.id));
      control.setAttribute('aria-pressed', view.filter === category.id ? 'true' : 'false');
      const status = category.counts.critical ? 'critical' : category.counts.serious ? 'serious' : category.counts.warning ? 'warning' : 'clear';
      control.dataset.status = status;
      control.dataset.family = category.id;
      const top = element('span', 'audit-category-top');
      top.append(icon(FAMILY_ICON[category.id] || ICON.shield, 'audit-ico audit-category-ico'), element('span', 'audit-category-label', category.label));
      const score = element('span', 'audit-category-score');
      score.append(document.createTextNode(String(category.score)), element('span', 'audit-category-of', '/100'));
      const counts = element('span', 'audit-category-counts');
      if (status === 'clear') {
        counts.append(icon(ICON.check, 'audit-ico audit-category-clear'), element('span', null, 'Clear'));
      } else {
        for (const severity of ORDER) {
          if (!category.counts[severity]) continue;
          const count = element('span', 'audit-category-count');
          count.dataset.severity = severity;
          count.append(icon(SEVERITY[severity].icon), element('span', null, `${category.counts[severity]} ${severity}`));
          counts.appendChild(count);
        }
      }
      const meter = element('span', 'audit-category-meter');
      meter.setAttribute('aria-hidden', 'true');
      meter.style.setProperty('--audit-fill', `${category.score}%`);
      control.append(top, score, counts, meter);
      item.appendChild(control);
      list.appendChild(item);
    }
    host.appendChild(list);
  }

  /* ---- Findings ------------------------------------------------------------- */

  function osvLink(id) {
    if (!ADVISORY_ID.test(String(id))) return element('span', 'audit-adv-id', String(id));
    const link = element('a', 'audit-adv-id', id);
    link.href = `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append(icon(ICON.link, 'audit-ico audit-adv-out'));
    return link;
  }

  /* The advisories behind a dependency finding: id, CVE, how bad, what. */
  function advisoryList(detail) {
    const wrap = element('div', 'audit-adv');
    const head = element('p', 'audit-adv-head');
    const version = detail.source === 'range' ? `${detail.range} (lowest accepted ${detail.version})` : detail.version;
    head.append(element('strong', 'audit-adv-pkg', `${detail.package} ${version}`));
    if (detail.fixed) head.append(icon(ICON.arrow, 'audit-ico audit-adv-arrow'), element('strong', 'audit-adv-fixed', detail.fixed));
    const tags = [];
    tags.push(detail.direct ? 'direct' : 'transitive');
    if (detail.dev) tags.push('dev only');
    if (detail.unfixed) tags.push('no fix for every advisory');
    for (const tag of tags) head.appendChild(element('span', 'audit-tag', tag));
    wrap.appendChild(head);
    const list = element('ul', 'audit-adv-list');
    for (const advisory of detail.advisories || []) {
      const item = element('li', 'audit-adv-item');
      item.dataset.severity = advisory.severity || 'unrated';
      const ids = element('span', 'audit-adv-ids');
      ids.appendChild(osvLink(advisory.id));
      if (advisory.cve) ids.appendChild(element('span', 'audit-adv-cve', advisory.cve));
      item.append(icon(advisory.severity ? SEVERITY[advisory.severity].icon : SEVERITY.warning.icon), ids,
        element('span', 'audit-adv-summary', advisory.summary || (advisory.severity ? '' : 'Not rated in this audit')));
      list.appendChild(item);
    }
    if (detail.more) list.appendChild(element('li', 'audit-adv-more', `and ${detail.more} more`));
    wrap.appendChild(list);
    return wrap;
  }

  /*
   * One finding: a row that says how bad, what and where, opened into its
   * reason, its fix, the advisories behind it and a prompt. A repository
   * finding's place opens the file; a site finding's place is a header or a
   * path on the site, and is shown, not followed.
   */
  function findingList(findings, changes, handlers, families) {
    const list = element('ul', 'exposure-list audit-list');
    for (const finding of findings) {
      const item = element('li', 'exposure-item audit-item');
      item.dataset.severity = finding.severity;
      const details = element('details', 'audit-details');
      if (finding.id) details.dataset.findingId = finding.id;
      const summary = element('summary', 'audit-summary-row');
      const pill = element('span', `audit-pill audit-pill-${finding.severity}`);
      pill.append(icon(SEVERITY[finding.severity].icon, 'audit-ico audit-pill-glyph'), element('span', null, SEVERITY[finding.severity].word));
      const main = element('span', 'audit-row-main');
      main.appendChild(element('span', 'exposure-item-title', finding.title));
      const sub = element('span', 'audit-row-sub');
      sub.appendChild(element('span', 'audit-row-where', finding.where || location(finding)));
      const family = families && families.get(finding.category);
      if (family) sub.appendChild(element('span', 'audit-row-family', family));
      main.appendChild(sub);
      summary.append(pill, main);
      const chip = detailChip(finding);
      if (chip) {
        const tag = element('span', 'audit-row-chip', chip);
        tag.title = chip;
        summary.appendChild(tag);
      }
      if (changes && changes.newIds.has(finding.id)) summary.appendChild(element('span', 'audit-new', 'New'));
      details.appendChild(summary);

      const body = element('div', 'audit-body');
      body.appendChild(element('p', 'exposure-item-consequence', finding.why));
      if (finding.detail && finding.detail.package && Array.isArray(finding.detail.advisories)) body.appendChild(advisoryList(finding.detail));
      const fix = element('div', 'exposure-item-action audit-fix');
      fix.append(element('span', 'audit-fix-label', 'Fix'), element('p', null, finding.fix));
      body.appendChild(fix);
      const foot = element('div', 'audit-body-foot');
      const where = element('p', 'exposure-item-where');
      where.appendChild(element('span', 'audit-rule', finding.rule));
      if (finding.path && handlers.onOpen) {
        const open = button('', 'audit-location', () => handlers.onOpen(finding));
        open.append(icon(ICON.file), element('span', null, location(finding)));
        open.setAttribute('aria-label', `Open ${location(finding)}`);
        where.appendChild(open);
      } else {
        where.appendChild(element('span', 'audit-location-static', finding.where || location(finding)));
      }
      foot.appendChild(where);
      const copy = button('', 'btn btn-ghost small audit-copy', event => handlers.onCopy(finding, event.currentTarget));
      copy.append(icon(ICON.copy), element('span', 'audit-btn-label', 'Copy fix prompt'));
      foot.appendChild(copy);
      body.appendChild(foot);
      details.appendChild(body);
      item.appendChild(details);
      list.appendChild(item);
    }
    return list;
  }

  function renderFindings(host, view, handlers) {
    const result = view.result;
    if (!result) return;
    const card = element('section', 'card exposure-findings audit-findings');
    card.setAttribute('aria-labelledby', 'auditFindingsHeading');
    const head = element('div', 'exposure-section-head audit-findings-head');
    const titleWrap = element('div', 'exposure-findings-title');
    const familyLabel = view.filter ? (result.categories.find(category => category.id === view.filter) || {}).label : '';
    const title = element('h2', 'exposure-heading', familyLabel ? `Findings — ${familyLabel}` : 'Findings');
    title.id = 'auditFindingsHeading';
    titleWrap.appendChild(title);
    const inFamily = result.findings.filter(finding => !view.filter || finding.category === view.filter);
    const count = element('span', 'exposure-count', String(inFamily.length));
    count.setAttribute('aria-hidden', 'true');
    titleWrap.appendChild(count);
    head.appendChild(titleWrap);
    if (view.filter) head.appendChild(button('Show all', 'btn btn-ghost small', () => handlers.onFilter(null)));
    card.appendChild(head);

    /* Severity is a second filter over the family one, as a segmented control. */
    if (inFamily.length) {
      const counts = severityCounts(inFamily);
      const segments = element('div', 'audit-segments');
      segments.setAttribute('role', 'group');
      segments.setAttribute('aria-label', 'Show by severity');
      const segment = (value, text, total) => {
        const control = button('', 'audit-segment', () => handlers.onSeverity && handlers.onSeverity(value));
        control.setAttribute('aria-pressed', (view.severity || null) === value ? 'true' : 'false');
        if (value) {
          control.dataset.severity = value;
          control.append(icon(SEVERITY[value].icon));
        }
        control.append(element('span', null, text), element('span', 'audit-segment-n', String(total)));
        control.disabled = Boolean(value) && !total;
        return control;
      };
      segments.appendChild(segment(null, 'All', inFamily.length));
      for (const severity of ORDER) segments.appendChild(segment(severity, SEVERITY[severity].word, counts[severity]));
      card.appendChild(segments);
    }

    const shown = inFamily.filter(finding => !view.severity || finding.severity === view.severity);
    if (!shown.length) {
      card.appendChild(element('p', 'exposure-empty audit-empty', view.filter ? 'Nothing found in this family, in what was read.' : 'Nothing found, in what was read.'));
      host.appendChild(card);
      return;
    }
    const families = new Map(result.categories.map(category => [category.id, category.label]));
    card.appendChild(findingList(shown, view.diff, handlers, families));
    host.appendChild(card);
  }

  /* Where the provider has no repository reader, the audit says so rather than showing an empty -- and therefore clean -- result. */
  function renderUnavailable(host, reason) {
    const card = element('section', 'card audit-summary audit-unavailable');
    card.setAttribute('aria-labelledby', 'auditSummaryHeading');
    const heading = element('h2', 'audit-kicker', 'Repository audit');
    heading.id = 'auditSummaryHeading';
    card.append(heading,
      element('p', 'audit-verdict', 'Not available for this provider yet.'),
      element('p', 'audit-coverage', reason),
      element('p', 'audit-coverage', 'The deployed-site check below does not read the repository and works here.'));
    host.appendChild(card);
  }

  /* ---- The deployed site ---------------------------------------------------- */

  const HEADER_NAMES = Object.freeze({
    'strict-transport-security': 'Strict-Transport-Security',
    'content-security-policy': 'Content-Security-Policy',
    'x-frame-options': 'X-Frame-Options',
    'x-content-type-options': 'X-Content-Type-Options',
    'referrer-policy': 'Referrer-Policy',
    'permissions-policy': 'Permissions-Policy'
  });

  /*
   * The deployed site: an address, the grade its responses earn, which of
   * the headers a browser enforces were sent, and the findings. The address
   * is the only thing typed here, and only its origin is ever requested.
   */
  function siteCoverage(result) {
    const hops = result.redirects
      ? ` after ${plural(result.redirects, 'redirect', 'redirects')}${result.requested && result.requested !== result.origin ? ` from ${result.requested}` : ''}`
      : '';
    return `${plural(result.requests, 'anonymous request', 'anonymous requests')}; the page answered ${result.status}${hops}.`;
  }

  function renderSite(host, site, handlers, previous) {
    const card = element('section', 'card audit-site');
    card.setAttribute('aria-labelledby', 'auditSiteHeading');
    const head = element('div', 'audit-site-head');
    const mark = element('span', 'audit-site-mark');
    mark.appendChild(icon(ICON.globe));
    const titles = element('div', 'audit-site-titles');
    const heading = element('h2', 'exposure-heading', 'Deployed site');
    heading.id = 'auditSiteHeading';
    titles.append(heading, element('p', 'audit-site-lede', 'Headers, cookies and exposed files, as any visitor’s browser sees them. Ten anonymous requests; nothing kept.'));
    head.append(mark, titles);
    card.appendChild(head);

    const form = element('form', 'audit-site-form');
    form.noValidate = true;
    const label = element('label', 'audit-site-label', 'Site address');
    label.htmlFor = 'auditSiteUrl';
    const field = element('div', 'audit-site-field');
    const input = element('input', 'audit-site-input');
    input.id = 'auditSiteUrl';
    input.type = 'url';
    input.inputMode = 'url';
    input.autocomplete = 'url';
    input.spellcheck = false;
    input.placeholder = 'https://your-app.example.com';
    input.value = site.url || '';
    input.disabled = site.status === 'running';
    input.addEventListener('input', () => handlers.onSiteInput(input.value));
    const submit = element('button', 'btn btn-primary', site.status === 'running' ? 'Checking…' : site.result ? 'Check again' : 'Check site');
    submit.type = 'submit';
    submit.disabled = site.status === 'running';
    field.append(input, submit);
    form.append(label, field);
    if (site.suggested && !site.result) form.appendChild(element('p', 'audit-site-hint', 'Filled in from the repository’s homepage.'));
    form.addEventListener('submit', event => { event.preventDefault(); handlers.onSiteCheck(input.value); });
    card.appendChild(form);

    if (site.status === 'running') {
      card.appendChild(element('p', 'audit-lede audit-muted', 'Requesting the page and the paths that should never be served…'));
    } else if (site.status === 'error') {
      const error = element('p', 'audit-lede audit-error', site.error || 'The site could not be checked.');
      error.setAttribute('role', 'alert');
      card.appendChild(error);
    }

    const result = site.result;
    if (result && site.status !== 'running') {
      const row = element('div', 'audit-grade-row audit-site-grade');
      const fresh = !previous || previous.siteId !== `${result.origin}|${result.checkedAt}`;
      row.appendChild(ring(result, 'done', `Site grade ${result.grade}, ${result.score} out of 100`, fresh ? 0 : null));
      const read = element('div', 'audit-grade-read');
      const total = result.findings.length;
      read.appendChild(element('p', 'audit-verdict audit-verdict-sm', total
        ? `${plural(total, 'finding', 'findings')} on ${result.origin}.`
        : `Nothing found on ${result.origin}.`));
      if (total) read.appendChild(severityTally(result.findings));
      if (result.capped) read.appendChild(element('p', 'audit-cap', 'Held below 50 while a critical finding is open.'));
      read.appendChild(element('p', 'audit-coverage', siteCoverage(result)));
      if (site.diff) {
        const since = site.diff.previousAt ? ` since the check of ${new Date(site.diff.previousAt).toLocaleString()}` : '';
        read.appendChild(element('p', 'audit-diff',
          `${plural(site.diff.newIds.size, 'new finding', 'new findings')}, ${site.diff.resolved} resolved${since}.`));
      }
      row.appendChild(read);
      card.appendChild(row);

      const headers = element('ul', 'audit-headers');
      headers.setAttribute('aria-label', 'Security headers');
      for (const header of result.headers || []) {
        const item = element('li', 'audit-header');
        item.dataset.present = header.present ? 'true' : 'false';
        item.append(element('span', 'audit-header-glyph', header.present ? '✓' : '✕'),
          element('span', 'audit-header-name', HEADER_NAMES[header.name] || header.name),
          element('span', 'audit-header-state', header.present ? 'sent' : 'not sent'));
        headers.appendChild(item);
      }
      card.appendChild(headers);

      const actions = element('div', 'audit-actions');
      if (total) actions.appendChild(iconButton(ICON.copy, 'Prompts', 'Copy all fix prompts', 'btn btn-ghost audit-tool', handlers.onSiteCopyAll));
      if (handlers.onExport && !site.hasRepositoryResult) actions.appendChild(iconButton(ICON.download, 'Brief', 'Export developer brief', 'btn btn-ghost audit-tool', handlers.onExport));
      if (actions.childNodes.length) card.appendChild(actions);
      if (total) card.appendChild(findingList(result.findings, site.diff, { onCopy: handlers.onCopy }));
    }
    host.appendChild(card);
  }

  /*
   * A redraw keeps what the reader had open, and grows the ring only for a
   * result it has not drawn before.
   */
  const drawn = new WeakMap();
  function render(root, view, handlers) {
    if (!root) return;
    const open = new Set([...root.querySelectorAll('details[open][data-finding-id]')].map(node => node.dataset.findingId));
    const previous = drawn.get(root) || null;
    root.replaceChildren();
    if (view.unavailable) {
      renderUnavailable(root, view.unavailable);
    } else {
      renderSummary(root, view, handlers, previous);
      renderPriorities(root, view, handlers, root);
      renderCategories(root, view, handlers);
      renderFindings(root, view, handlers);
    }
    if (view.site) renderSite(root, { ...view.site, hasRepositoryResult: Boolean(view.result) }, handlers, previous);
    for (const id of open) {
      const details = root.querySelector(`details[data-finding-id="${CSS.escape(id)}"]`);
      if (details) details.open = true;
    }
    drawn.set(root, {
      id: view.result ? resultId(view.result) : null,
      siteId: view.site && view.site.result ? `${view.site.result.origin}|${view.site.result.checkedAt}` : null
    });
  }

  /*
   * The developer brief: the audit as a Markdown document a reader can hand
   * to whoever fixes it, or to an assistant. Rules, places, reasons, fixes,
   * advisories and the prompts -- the same words the screen shows, and still
   * no code.
   */
  function findingSection(findings, lines, prefix, place) {
    findings.forEach((finding, index) => {
      lines.push(
        `## ${prefix}${index + 1}. ${finding.title}`,
        '',
        `- **Severity:** ${finding.severity}`,
        `- **Rule:** ${finding.rule}`,
        `- **Where:** ${place(finding)}`
      );
      const detail = finding.detail;
      if (detail && finding.rule === 'SCR-001') lines.push(`- **Credential:** ${detail.credential}`);
      if (detail && finding.rule === 'DEP-004') lines.push(`- **Looks like:** ${detail.resembles}`);
      if (detail && detail.package && Array.isArray(detail.advisories)) {
        lines.push(`- **Package:** ${detail.package} ${detail.source === 'range' ? `${detail.range} (lowest accepted ${detail.version})` : detail.version}${detail.direct ? '' : ' (transitive)'}`);
        if (detail.fixed) lines.push(`- **Fixed in:** ${detail.fixed}`);
        lines.push(`- **Advisories:** ${detail.advisories.map(advisory => `${advisory.id}${advisory.cve ? ` (${advisory.cve})` : ''}`).join(', ')}${detail.more ? ` and ${detail.more} more` : ''}`);
      }
      lines.push(
        '',
        finding.why,
        '',
        `**Fix.** ${finding.fix}`,
        '',
        '```text',
        finding.prompt,
        '```',
        ''
      );
    });
  }

  function brief(result, repoLabel, site) {
    const lines = [`# Security audit: ${repoLabel}`, ''];
    if (result) {
      lines.push(
        `Grade **${result.grade}** — ${result.score}/100${result.capped ? ' (held below 50 by a critical finding)' : ''}.`,
        `Commit \`${result.commitSha}\`, audited ${result.auditedAt || new Date().toISOString()}.`,
        '',
        coverageLine(result),
        coverageCaveat(result),
        '',
        '| Family | Score | Critical | Serious | Warning |',
        '| --- | --- | --- | --- | --- |',
        ...result.categories.map(category => `| ${category.label} | ${category.score} | ${category.counts.critical} | ${category.counts.serious} | ${category.counts.warning} |`),
        ''
      );
      const byId = new Map(result.findings.map(finding => [finding.id, finding]));
      const first = (result.priorities || []).map(id => byId.get(id)).filter(Boolean);
      if (first.length) {
        lines.push('**Fix first:**', '', ...first.map((finding, index) => `${index + 1}. ${finding.title} — ${finding.path ? `\`${location(finding)}\`` : 'whole repository'}`), '');
      }
      if (!result.findings.length) lines.push('No findings in what was read.', '');
      findingSection(result.findings, lines, '', finding => finding.path ? `\`${location(finding)}\`` : 'whole repository');
    }
    if (site) {
      lines.push(
        `# Deployed site: ${site.origin}`,
        '',
        `Grade **${site.grade}** — ${site.score}/100${site.capped ? ' (held below 50 by a critical finding)' : ''}.`,
        `Checked ${site.checkedAt || new Date().toISOString()}: ${siteCoverage(site)}`,
        '',
        '| Header | Sent |',
        '| --- | --- |',
        ...(site.headers || []).map(header => `| ${HEADER_NAMES[header.name] || header.name} | ${header.present ? 'yes' : 'no'} |`),
        ''
      );
      if (!site.findings.length) lines.push('No findings on the site.', '');
      findingSection(site.findings, lines, 'S', finding => `\`${finding.where}\``);
    }
    return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
  }

  function allPrompts(result) {
    return (result ? result.findings : []).map((finding, index) => `${index + 1}. ${finding.prompt}`).join('\n\n');
  }

  global.NebulaCodeAudit = Object.freeze({ STORE_PREFIX, render, brief, allPrompts, diff, readPrevious, remember, storageKey });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaCodeAudit;
