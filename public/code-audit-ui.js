/*
 * The repository audit, drawn.
 *
 * The order is the argument, as it is on the Exposure screen: the grade and
 * how much of the repository it rests on come first, then the three jobs to
 * do first, then the six families the grade was built from and the OWASP
 * Top 10 map of the same findings, then every finding, searchable, each
 * filed under its CWE. A findings list alone invites the reading "nothing here, so
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
    infrastructure: 'M4 5.5h16v5H4zM4 13.5h16v5H4zM7.5 8h.1M7.5 16h.1M11 8h5.5M11 16h5.5',
    hygiene: 'M7 4h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 3.5h6M9 12.5l2.1 2.1 4-4.3'
  });
  /*
   * The OWASP Top 10 (2021), in the short words a tile has room for, and the
   * page on owasp.org each links to.
   */
  const OWASP = Object.freeze([
    ['A01', 'Access control', 'A01_2021-Broken_Access_Control'],
    ['A02', 'Cryptography', 'A02_2021-Cryptographic_Failures'],
    ['A03', 'Injection', 'A03_2021-Injection'],
    ['A04', 'Insecure design', 'A04_2021-Insecure_Design'],
    ['A05', 'Misconfiguration', 'A05_2021-Security_Misconfiguration'],
    ['A06', 'Outdated components', 'A06_2021-Vulnerable_and_Outdated_Components'],
    ['A07', 'Authentication', 'A07_2021-Identification_and_Authentication_Failures'],
    ['A08', 'Integrity', 'A08_2021-Software_and_Data_Integrity_Failures'],
    ['A09', 'Logging', 'A09_2021-Security_Logging_and_Monitoring_Failures'],
    ['A10', 'SSRF', 'A10_2021-Server-Side_Request_Forgery_%28SSRF%29']
  ]);
  const OWASP_SLUG = Object.freeze(Object.fromEntries(OWASP.map(([id, , slug]) => [id, slug])));
  /* What a finding list shows at once; the rest is a click away. */
  const PAGE = 40;
  const SITE_FOLD = 5;
  /* Site results the reader unfolded, by origin and time, so a redraw keeps them open. */
  const expandedSites = new Set();
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
    check: 'M5 12.5l4.2 4.2L19 7',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.3 15.3L20 20',
    chevron: 'M7 10l5 5 5-5',
    waive: 'M12 3.3l7.2 3v5.3c0 4.3-3 7.9-7.2 9.4-4.2-1.5-7.2-5.1-7.2-9.4V6.3zM9 12h6',
    markdown: 'M4 6h16v12H4zM7 15V9l2.5 3L12 9v6M16 9v6M14.2 13.2L16 15l1.8-1.8',
    table: 'M4 5h16v14H4zM4 10h16M4 14.5h16M10 5v14',
    sarif: 'M8 4H6a2 2 0 0 0-2 2v4l-1.5 2L4 14v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4l1.5 2-1.5 2v4a2 2 0 0 1-2 2h-2M9 12h6'
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
  /*
   * A control that survives a redraw: the render puts focus back on the
   * control with the same key, so a keyboard reader filtering the list is not
   * thrown back to the top of the page on every press.
   */
  function keyed(node, key) {
    node.dataset.key = key;
    return node;
  }

  /*
   * The export menu: the brief to read, SARIF for a code-scanning dashboard,
   * CSV for a spreadsheet. A button that opens a small menu; Escape, a click
   * elsewhere or a choice closes it. While open the menu lives on the body:
   * a card's blur makes it the frame a fixed child is placed in, and its edge
   * would cut the menu off.
   */
  let closeOpenMenu = null;
  const EXPORTS = Object.freeze([
    ['brief', ICON.markdown, 'Developer brief', 'Markdown for a person or an assistant', 'Export developer brief'],
    ['sarif', ICON.sarif, 'SARIF 2.1.0', 'For GitHub code scanning and other dashboards', 'Export SARIF'],
    ['csv', ICON.table, 'CSV', 'For a spreadsheet or a tracker import', 'Export CSV']
  ]);
  function exportMenu(onExport, key) {
    const wrap = element('div', 'audit-export');
    const trigger = keyed(button('', 'btn btn-ghost audit-tool audit-export-btn'), key);
    trigger.append(icon(ICON.download), element('span', 'audit-btn-label', 'Export'), icon(ICON.chevron, 'audit-ico audit-export-chev'));
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Export');
    trigger.title = 'Export';
    const menu = element('div', 'audit-export-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const items = EXPORTS.map(([kind, path, word, hint, name]) => {
      const item = button('', 'audit-export-item', () => { close(); onExport(kind); });
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-label', name);
      item.tabIndex = -1;
      const text = element('span', 'audit-export-text');
      text.append(element('span', 'audit-export-word', word), element('span', 'audit-export-hint', hint));
      item.append(icon(path), text);
      menu.appendChild(item);
      return item;
    });
    const outside = event => { if (!wrap.contains(event.target) && !menu.contains(event.target)) close(); };
    /* A scroll carries the menu with its button; once the button is off screen, the menu goes. */
    let frame = 0;
    const follow = () => {
      if (frame) return;
      frame = global.requestAnimationFrame(() => {
        frame = 0;
        if (menu.hidden) return;
        const box = trigger.getBoundingClientRect();
        if (!trigger.isConnected || box.bottom < 0 || box.top > global.innerHeight) close();
        else place();
      });
    };
    /*
     * Placed against the viewport, not the card, so no card's clipping cuts
     * it off: under the button when there is room, above it when there is
     * not, and kept inside the screen's width.
     */
    function place() {
      const box = trigger.getBoundingClientRect();
      const width = Math.min(290, global.innerWidth - 24);
      menu.style.width = `${width}px`;
      menu.style.left = `${Math.max(12, Math.min(box.left, global.innerWidth - width - 12))}px`;
      const below = global.innerHeight - box.bottom;
      const height = menu.offsetHeight || 190;
      menu.style.top = below < height + 16 && box.top > height + 16 ? `${box.top - height - 6}px` : `${box.bottom + 6}px`;
    }
    function close(returnFocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      wrap.appendChild(menu);
      if (closeOpenMenu === close) closeOpenMenu = null;
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      global.removeEventListener('resize', follow);
      global.removeEventListener('scroll', follow, true);
      if (returnFocus) trigger.focus();
    }
    function open() {
      if (closeOpenMenu) closeOpenMenu();
      closeOpenMenu = close;
      document.body.appendChild(menu);
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      place();
      document.addEventListener('pointerdown', outside, true);
      global.addEventListener('resize', follow);
      global.addEventListener('scroll', follow, true);
      items[0].focus({ preventScroll: true });
    }
    trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
    const keys = event => {
      if (menu.hidden) return;
      const at = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); items[(at + 1) % items.length].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
      else if (event.key === 'Home') { event.preventDefault(); items[0].focus(); }
      else if (event.key === 'End') { event.preventDefault(); items[items.length - 1].focus(); }
      else if (event.key === 'Tab') close();
    };
    wrap.addEventListener('keydown', keys);
    menu.addEventListener('keydown', keys);
    wrap.append(trigger, menu);
    return wrap;
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
      const waived = (result.suppressed || []).length;
      if (waived) notes.appendChild(element('p', 'audit-waived-note', `${plural(waived, 'finding', 'findings')} waived in code, listed below and not scored.`));
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
      actions.appendChild(exportMenu(handlers.onExport, 'export'));
      if (result.findings.length) actions.appendChild(keyed(iconButton(ICON.copy, 'Prompts', 'Copy all fix prompts', 'btn btn-ghost audit-tool', handlers.onCopyAll), 'prompts'));
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
      const control = keyed(button('', 'audit-category-btn', () => handlers.onFilter(view.filter === category.id ? null : category.id)), `family:${category.id}`);
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

  /* ---- Standards ------------------------------------------------------------ */

  /*
   * The same findings on the OWASP Top 10: a tile per category, lit by the
   * worst finding under it, each a filter. The engine files every rule under
   * a CWE; a category with nothing under it says clear rather than going
   * blank, because an empty tile reads as "not checked".
   */
  function renderStandards(host, view, handlers) {
    const result = view.result;
    if (!result || !result.findings.some(finding => finding.standards)) return;
    const card = element('section', 'card audit-owasp');
    card.setAttribute('aria-labelledby', 'auditOwaspHeading');
    const head = element('div', 'audit-owasp-head');
    const heading = element('h2', 'audit-kicker', 'OWASP Top 10 · 2021');
    heading.id = 'auditOwaspHeading';
    const cwes = new Set(result.findings.map(finding => finding.standards && finding.standards.cwe).filter(Boolean));
    head.append(heading, element('span', 'audit-owasp-cwe', `${plural(cwes.size, 'CWE', 'CWEs')} across ${plural(result.findings.length, 'finding', 'findings')}`));
    card.appendChild(head);
    const list = element('ul', 'audit-owasp-grid');
    list.setAttribute('aria-label', 'OWASP Top 10 categories');
    for (const [id, word] of OWASP) {
      const under = result.findings.filter(finding => finding.standards && finding.standards.owasp === `${id}:2021`);
      const counts = severityCounts(under);
      const worst = ORDER.find(severity => counts[severity]) || 'clear';
      const item = element('li', 'audit-owasp-item');
      const control = keyed(button('', 'audit-owasp-btn', () => handlers.onOwasp && handlers.onOwasp(view.owasp === id ? null : id)), `owasp:${id}`);
      control.dataset.status = worst;
      control.setAttribute('aria-pressed', view.owasp === id ? 'true' : 'false');
      control.setAttribute('aria-label', `${id} ${word}: ${under.length ? plural(under.length, 'finding', 'findings') : 'clear'}`);
      control.disabled = !under.length && view.owasp !== id;
      control.append(element('span', 'audit-owasp-id', id), element('span', 'audit-owasp-word', word),
        element('span', 'audit-owasp-n', under.length ? String(under.length) : '✓'));
      item.appendChild(control);
      list.appendChild(item);
    }
    card.appendChild(list);
    host.appendChild(card);
  }

  /* A finding's CWE and OWASP category, each a link to its definition. */
  function standardsChips(standards) {
    if (!standards) return null;
    const wrap = element('span', 'audit-std');
    const cweNumber = /^CWE-(\d{1,5})$/.exec(standards.cwe || '');
    if (cweNumber) {
      const cwe = element('a', 'audit-std-chip', standards.cwe);
      cwe.href = `https://cwe.mitre.org/data/definitions/${cweNumber[1]}.html`;
      cwe.target = '_blank';
      cwe.rel = 'noopener noreferrer';
      cwe.title = standards.cweName ? `${standards.cwe}: ${standards.cweName}` : standards.cwe;
      wrap.appendChild(cwe);
    }
    const owaspId = /^(A\d{2}):2021$/.exec(standards.owasp || '');
    if (owaspId && OWASP_SLUG[owaspId[1]]) {
      const owasp = element('a', 'audit-std-chip audit-std-owasp', `OWASP ${owaspId[1]}`);
      owasp.href = `https://owasp.org/Top10/${OWASP_SLUG[owaspId[1]]}/`;
      owasp.target = '_blank';
      owasp.rel = 'noopener noreferrer';
      owasp.title = `${standards.owasp} ${standards.owaspName}`;
      wrap.appendChild(owasp);
    }
    return wrap.childNodes.length ? wrap : null;
  }

  /* ---- Findings ------------------------------------------------------------- */

  /* Every word a reader might search a finding by. */
  function searchText(finding, families) {
    const standards = finding.standards || {};
    return [finding.title, finding.rule, finding.where || location(finding), families && families.get(finding.category),
      standards.cwe, standards.cweName, standards.owasp, standards.owaspName, detailChip(finding), SEVERITY[finding.severity].word]
      .filter(Boolean).join(' ').toLowerCase();
  }
  function matches(finding, query, families) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const text = searchText(finding, families);
    return terms.every(term => text.includes(term));
  }

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
      const chips = standardsChips(finding.standards);
      if (chips) where.appendChild(chips);
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
    const owaspLabel = view.owasp ? `OWASP ${view.owasp} ${(OWASP.find(([id]) => id === view.owasp) || [])[1] || ''}`.trim() : '';
    const scope = [familyLabel, owaspLabel].filter(Boolean).join(' · ');
    const title = element('h2', 'exposure-heading', scope ? `Findings — ${scope}` : 'Findings');
    title.id = 'auditFindingsHeading';
    titleWrap.appendChild(title);
    const families = new Map(result.categories.map(category => [category.id, category.label]));
    const inScope = result.findings.filter(finding => (!view.filter || finding.category === view.filter)
      && (!view.owasp || (finding.standards && finding.standards.owasp === `${view.owasp}:2021`)));
    const count = element('span', 'exposure-count', String(inScope.length));
    count.setAttribute('aria-hidden', 'true');
    titleWrap.appendChild(count);
    head.appendChild(titleWrap);
    if (view.filter || view.owasp) head.appendChild(keyed(button('Show all', 'btn btn-ghost small', () => handlers.onFilter(null)), 'show-all'));
    card.appendChild(head);

    /* Severity is a second filter over the family one, as a segmented control; the search narrows both. */
    if (inScope.length) {
      const tools = element('div', 'audit-find-tools');
      const counts = severityCounts(inScope);
      const segments = element('div', 'audit-segments');
      segments.setAttribute('role', 'group');
      segments.setAttribute('aria-label', 'Show by severity');
      const segment = (value, text, total) => {
        const control = keyed(button('', 'audit-segment', () => handlers.onSeverity && handlers.onSeverity(value)), `severity:${value || 'all'}`);
        control.setAttribute('aria-pressed', (view.severity || null) === value ? 'true' : 'false');
        if (value) {
          control.dataset.severity = value;
          control.append(icon(SEVERITY[value].icon));
        }
        control.append(element('span', null, text), element('span', 'audit-segment-n', String(total)));
        control.disabled = Boolean(value) && !total;
        return control;
      };
      segments.appendChild(segment(null, 'All', inScope.length));
      for (const severity of ORDER) segments.appendChild(segment(severity, SEVERITY[severity].word, counts[severity]));
      tools.appendChild(segments);
      if (inScope.length > 3 || view.query) {
        const search = element('label', 'audit-search');
        search.append(icon(ICON.search));
        const input = keyed(element('input', 'audit-search-input'), 'search');
        input.type = 'search';
        input.placeholder = 'Search rule, file, CWE…';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = view.query || '';
        input.setAttribute('aria-label', 'Search findings');
        let timer = 0;
        input.addEventListener('input', () => {
          global.clearTimeout(timer);
          timer = global.setTimeout(() => handlers.onQuery && handlers.onQuery(input.value), 140);
        });
        input.addEventListener('keydown', event => {
          if (event.key === 'Escape' && input.value) { event.preventDefault(); input.value = ''; handlers.onQuery && handlers.onQuery(''); }
        });
        search.appendChild(input);
        tools.appendChild(search);
      }
      card.appendChild(tools);
    }

    const shown = inScope.filter(finding => (!view.severity || finding.severity === view.severity) && matches(finding, view.query, families));
    if (!shown.length) {
      const empty = view.query
        ? `Nothing matches “${String(view.query).trim()}”.`
        : view.filter || view.owasp ? 'Nothing found here, in what was read.' : 'Nothing found, in what was read.';
      card.appendChild(element('p', 'exposure-empty audit-empty', empty));
    } else {
      const limit = Math.max(PAGE, Number(view.limit) || PAGE);
      card.appendChild(findingList(shown.slice(0, limit), view.diff, handlers, families));
      if (shown.length > limit) {
        const more = keyed(button('', 'btn btn-ghost audit-more', () => handlers.onMore && handlers.onMore(limit + PAGE)), 'more');
        more.append(element('span', null, `Show ${Math.min(PAGE, shown.length - limit)} more`), element('span', 'audit-more-of', `${limit} of ${shown.length}`));
        card.appendChild(more);
      }
    }
    const waived = result.suppressed || [];
    if (waived.length) card.appendChild(waivedList(waived));
    host.appendChild(card);
  }

  /*
   * What the repository waived in its own code, with the reason it wrote.
   * Listed, never scored, never hidden: a waiver is a decision somebody made,
   * and a reviewer should be able to read every one of them.
   */
  function waivedList(waived) {
    const wrap = element('details', 'audit-waived');
    const summary = element('summary', 'audit-waived-head');
    summary.append(icon(ICON.waive), element('span', 'audit-waived-title', 'Waived in code'), element('span', 'exposure-count', String(waived.length)));
    wrap.appendChild(summary);
    const list = element('ul', 'audit-waived-list');
    for (const finding of waived) {
      const item = element('li', 'audit-waived-item');
      item.dataset.severity = finding.severity;
      const top = element('span', 'audit-waived-top');
      top.append(icon(SEVERITY[finding.severity].icon), element('span', 'audit-waived-name', finding.title));
      const meta = element('span', 'audit-waived-meta');
      meta.append(element('span', 'audit-rule', finding.rule), element('span', 'audit-row-where', location(finding)));
      const reason = finding.suppression && finding.suppression.reason;
      item.append(top, meta, element('span', `audit-waived-reason${reason ? '' : ' audit-waived-bare'}`, reason ? `“${reason}”` : 'No reason given'));
      list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
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
    'permissions-policy': 'Permissions-Policy',
    'cross-origin-opener-policy': 'Cross-Origin-Opener-Policy',
    'cross-origin-resource-policy': 'Cross-Origin-Resource-Policy'
  });
  /* A header's job in three words, under its name on the tile. */
  const HEADER_JOBS = Object.freeze({
    'strict-transport-security': 'HTTPS only',
    'content-security-policy': 'Script sources',
    'x-frame-options': 'No framing',
    'x-content-type-options': 'No sniffing',
    'referrer-policy': 'Leaks no URLs',
    'permissions-policy': 'Device features',
    'cross-origin-opener-policy': 'Window isolation',
    'cross-origin-resource-policy': 'Resource isolation'
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
      const origin = element('span', 'audit-origin');
      origin.append(icon(ICON.globe), element('span', null, result.origin.replace(/^https:\/\//, '')));
      origin.title = result.origin;
      read.append(origin, element('p', 'audit-verdict audit-verdict-sm', total ? verdict(result, 'done') : 'Nothing found'));
      read.appendChild(severityTally(result.findings));
      const notes = element('div', 'audit-notes');
      if (result.capped) notes.appendChild(element('p', 'audit-cap', 'Held below 50 while a critical finding is open.'));
      if (site.diff) {
        const since = site.diff.previousAt ? ` since the check of ${new Date(site.diff.previousAt).toLocaleString()}` : '';
        notes.appendChild(element('p', 'audit-diff',
          `${plural(site.diff.newIds.size, 'new finding', 'new findings')}, ${site.diff.resolved} resolved${since}.`));
      }
      notes.appendChild(element('p', 'audit-coverage', siteCoverage(result)));
      read.appendChild(notes);
      row.appendChild(read);
      card.appendChild(row);

      const headers = element('ul', 'audit-headers');
      headers.setAttribute('aria-label', 'Security headers');
      for (const header of result.headers || []) {
        const item = element('li', 'audit-header');
        const covered = !header.present && header.via;
        item.dataset.present = header.present || covered ? 'true' : 'false';
        if (covered) item.dataset.via = 'true';
        const text = element('span', 'audit-header-text');
        text.append(element('span', 'audit-header-name', HEADER_NAMES[header.name] || header.name),
          element('span', 'audit-header-job', HEADER_JOBS[header.name] || ''));
        const state = header.present ? 'sent' : covered ? `via ${header.via === 'content-security-policy' ? 'CSP' : header.via}` : 'not sent';
        item.append(element('span', 'audit-header-glyph', header.present || covered ? '✓' : '✕'), text, element('span', 'audit-header-state', state));
        if (covered) item.title = `Not sent, but ${HEADER_NAMES[header.via] || header.via} does its job`;
        headers.appendChild(item);
      }
      card.appendChild(headers);

      const exportable = handlers.onExport && !site.hasRepositoryResult;
      if (total || exportable) {
        const listHead = element('div', 'audit-site-list-head');
        const listTitle = element('h3', 'audit-site-list-title', 'Findings');
        const listCount = element('span', 'exposure-count', String(total));
        listCount.setAttribute('aria-hidden', 'true');
        const titleWrap = element('div', 'exposure-findings-title');
        titleWrap.append(listTitle, listCount);
        const actions = element('div', 'audit-actions');
        if (total) actions.appendChild(keyed(iconButton(ICON.copy, 'Prompts', 'Copy all fix prompts', 'btn btn-ghost audit-tool', handlers.onSiteCopyAll), 'site-prompts'));
        if (exportable) actions.appendChild(exportMenu(handlers.onExport, 'site-export'));
        listHead.append(titleWrap, actions);
        card.appendChild(listHead);
      }
      if (total) {
        /* The worst first; past five, the rest fold behind one button so the page stays readable. */
        const siteId = `${result.origin}|${result.checkedAt}`;
        const all = expandedSites.has(siteId) || total <= SITE_FOLD;
        card.appendChild(findingList(all ? result.findings : result.findings.slice(0, SITE_FOLD), site.diff, { onCopy: handlers.onCopy }));
        if (!all) {
          const more = keyed(button('', 'btn btn-ghost audit-more', () => { expandedSites.add(siteId); handlers.onSiteExpand && handlers.onSiteExpand(); }), 'site-more');
          more.append(element('span', null, `Show ${total - SITE_FOLD} more`), element('span', 'audit-more-of', `${SITE_FOLD} of ${total}`));
          card.appendChild(more);
        }
      }
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
    const waivedOpen = Boolean(root.querySelector('details.audit-waived[open]'));
    const previous = drawn.get(root) || null;
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const focus = active && active.dataset.key ? {
      key: active.dataset.key,
      start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
    } : null;
    if (closeOpenMenu) closeOpenMenu();
    root.replaceChildren();
    if (view.unavailable) {
      renderUnavailable(root, view.unavailable);
    } else {
      renderSummary(root, view, handlers, previous);
      renderPriorities(root, view, handlers, root);
      renderCategories(root, view, handlers);
      renderStandards(root, view, handlers);
      renderFindings(root, view, handlers);
    }
    if (view.site) renderSite(root, { ...view.site, hasRepositoryResult: Boolean(view.result) }, handlers, previous);
    for (const id of open) {
      const details = root.querySelector(`details[data-finding-id="${CSS.escape(id)}"]`);
      if (details) details.open = true;
    }
    if (waivedOpen) { const waived = root.querySelector('details.audit-waived'); if (waived) waived.open = true; }
    if (focus) {
      const again = root.querySelector(`[data-key="${CSS.escape(focus.key)}"]`);
      if (again && !again.disabled) {
        again.focus({ preventScroll: true });
        if (focus.start !== null && typeof again.setSelectionRange === 'function') {
          try { again.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
        }
      }
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
      const standards = finding.standards;
      if (standards) {
        lines.push(`- **Standards:** ${[standards.cwe && `${standards.cwe}${standards.cweName ? ` (${standards.cweName})` : ''}`,
          standards.owasp && `OWASP ${standards.owasp} ${standards.owaspName}`].filter(Boolean).join(' · ')}`);
      }
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
      const waived = result.suppressed || [];
      if (waived.length) {
        lines.push('## Waived in code', '', 'Not scored. Each was waived by an `nv-audit-ignore` comment naming its rule.', '',
          '| Rule | Finding | Where | Reason |', '| --- | --- | --- | --- |',
          ...waived.map(finding => `| ${finding.rule} | ${cell(finding.title)} | \`${location(finding)}\` | ${cell((finding.suppression && finding.suppression.reason) || 'none given')} |`), '');
      }
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

  /* A Markdown table cell: pipes escaped, one line. */
  function cell(text) {
    return String(text || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  }

  /*
   * SARIF 2.1.0, the format code-scanning dashboards read. One run per
   * source: the repository, with each result at its file and line, and the
   * deployed site, with each result at its logical place (a header, a path).
   * Waived findings travel as results with an in-source suppression, so a
   * dashboard shows them as dismissed rather than losing them. Rules carry
   * their CWE and OWASP tags and a security-severity GitHub sorts by.
   */
  const SARIF_LEVEL = Object.freeze({ critical: 'error', serious: 'error', warning: 'warning' });
  const SECURITY_SEVERITY = Object.freeze({ critical: '9.5', serious: '7.5', warning: '4.0' });

  function sarifRules(findings) {
    const rules = new Map();
    for (const finding of findings) {
      if (rules.has(finding.rule)) continue;
      const standards = finding.standards || {};
      const tags = ['security', finding.category, standards.cwe && `external/cwe/${standards.cwe.toLowerCase()}`, standards.owasp && `owasp-${standards.owasp.replace(':', '-').toLowerCase()}`].filter(Boolean);
      rules.set(finding.rule, {
        id: finding.rule,
        name: finding.rule.replace('-', ''),
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.why },
        help: { text: finding.fix, markdown: `**Fix.** ${finding.fix}` },
        ...(standards.cwe ? { helpUri: `https://cwe.mitre.org/data/definitions/${standards.cwe.slice(4)}.html` } : {}),
        defaultConfiguration: { level: SARIF_LEVEL[finding.severity] },
        properties: { tags, precision: 'high', 'problem.severity': finding.severity === 'warning' ? 'warning' : 'error', 'security-severity': SECURITY_SEVERITY[finding.severity] }
      });
    }
    return [...rules.values()];
  }

  function sarifResult(finding, ruleIndex, place, suppression) {
    const result = {
      ruleId: finding.rule,
      ruleIndex,
      level: SARIF_LEVEL[finding.severity],
      message: { text: `${finding.title}. ${finding.why}` },
      ...place,
      partialFingerprints: { 'nebulaverseFinding/v1': finding.id || `${finding.rule}:${finding.where || location(finding)}` },
      properties: { severity: finding.severity, family: finding.category || 'site' }
    };
    if (suppression) result.suppressions = [{ kind: 'inSource', justification: suppression.reason || 'Waived in code without a reason.' }];
    return result;
  }

  function sarif(result, site, meta = {}) {
    const driver = rules => ({
      driver: {
        name: 'Nebulaverse-X Audit',
        informationUri: meta.informationUri || 'https://github.com/T-rex-G/Nebula-checkpoints',
        ...(meta.version ? { semanticVersion: meta.version } : {}),
        rules
      }
    });
    const runs = [];
    if (result) {
      const all = [...result.findings, ...(result.suppressed || [])];
      const rules = sarifRules(all);
      const index = new Map(rules.map((rule, at) => [rule.id, at]));
      const place = finding => finding.path ? {
        locations: [{ physicalLocation: { artifactLocation: { uri: finding.path, uriBaseId: 'SRCROOT' }, ...(finding.line ? { region: { startLine: finding.line } } : {}) } }]
      } : {};
      runs.push({
        tool: driver(rules),
        automationDetails: { id: `nebulaverse-audit/${meta.ref || result.ref || 'branch'}/` },
        ...(meta.repositoryUri ? { versionControlProvenance: [{ repositoryUri: meta.repositoryUri, revisionId: result.commitSha, ...(result.ref ? { branch: result.ref } : {}) }] } : {}),
        originalUriBaseIds: { SRCROOT: { uri: 'file:///' } },
        results: [
          ...result.findings.map(finding => sarifResult(finding, index.get(finding.rule), place(finding))),
          ...(result.suppressed || []).map(finding => sarifResult(finding, index.get(finding.rule), place(finding), finding.suppression))
        ],
        properties: { grade: result.grade, score: result.score, capped: Boolean(result.capped) }
      });
    }
    if (site) {
      const rules = sarifRules(site.findings);
      const index = new Map(rules.map((rule, at) => [rule.id, at]));
      runs.push({
        tool: driver(rules),
        automationDetails: { id: `nebulaverse-site/${site.origin}/` },
        results: site.findings.map(finding => sarifResult(finding, index.get(finding.rule), {
          locations: [{ logicalLocations: [{ name: finding.where, fullyQualifiedName: `${site.origin} ${finding.where}`, kind: 'resource' }] }]
        })),
        properties: { origin: site.origin, grade: site.grade, score: site.score, capped: Boolean(site.capped) }
      });
    }
    return JSON.stringify({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs }, null, 2);
  }

  /*
   * CSV, one finding a row. A cell that opens with =, +, -, @ or a control
   * character is prefixed with an apostrophe: a path or a title from a
   * repository is somebody else's text, and a spreadsheet must not run it
   * as a formula.
   */
  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  function csv(result, site, changes) {
    const rows = [['Source', 'Status', 'Severity', 'Rule', 'Title', 'Family', 'CWE', 'OWASP', 'Location', 'Line', 'Reason waived', 'Fix']];
    const row = (source, status, finding, family) => {
      const standards = finding.standards || {};
      rows.push([source, status, finding.severity, finding.rule, finding.title, family || '', standards.cwe || '', standards.owasp || '',
        finding.path || finding.where || 'whole repository', finding.line || '',
        finding.suppression ? finding.suppression.reason || '' : '', finding.fix]);
    };
    if (result) {
      const families = new Map((result.categories || []).map(category => [category.id, category.label]));
      for (const finding of result.findings) row('repository', changes && changes.newIds.has(finding.id) ? 'new' : 'open', finding, families.get(finding.category));
      for (const finding of result.suppressed || []) row('repository', 'waived', finding, families.get(finding.category));
    }
    if (site) for (const finding of site.findings) row(site.origin, 'open', finding, 'Deployed site');
    return `${rows.map(cells => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  function allPrompts(result) {
    return (result ? result.findings : []).map((finding, index) => `${index + 1}. ${finding.prompt}`).join('\n\n');
  }

  global.NebulaCodeAudit = Object.freeze({ STORE_PREFIX, render, brief, sarif, csv, allPrompts, diff, readPrevious, remember, storageKey });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaCodeAudit;
