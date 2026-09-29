/*
 * The repository audit, drawn: what Uranus, the audit engine, found.
 *
 * The order is the argument, as it is on the Exposure screen: the grade and
 * how much of the repository it rests on come first, then the three jobs to
 * do first, then the families the grade was built from, the endpoints a
 * caller can reach, what was looked at and how closely, what is already in
 * place, and the OWASP Top 10 map of the same findings; then every finding,
 * searchable, each filed under its CWE, each saying whether it is confirmed
 * or still to confirm and, when Uranus traced it, the path it took. A
 * findings list alone invites the reading "nothing here, so nothing is
 * wrong", which a partial read does not support.
 *
 * The screen talks in shapes before words -- a ring for the score, a tile per
 * family, an outlined chip per status -- and every shape carries its word as
 * well, so nothing is said by colour alone.
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
  /*
   * How sure a finding is, as Uranus says it: confirmed when the file states
   * it or the whole path was traced, to confirm when the pattern is there and
   * one decisive fact is not. A result from before Uranus carries no verdict
   * and reads as confirmed, which is what it was presented as then.
   */
  const VERDICT = Object.freeze({
    confirmed: Object.freeze({ word: 'Confirmed', tone: 'info', icon: 'M12 3.3l7.2 3v5.3c0 4.3-3 7.9-7.2 9.4-4.2-1.5-7.2-5.1-7.2-9.4V6.3zM9.3 12l2 2 3.5-3.8' }),
    'needs-validation': Object.freeze({ word: 'To confirm', tone: 'pending', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.7 9.7a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.4v.5M12 16.6v.1' })
  });
  const verdictOf = finding => (finding && finding.verdict === 'needs-validation' ? 'needs-validation' : 'confirmed');
  /* Who can reach the line a traced value entered on. */
  const LOCK = 'M6.5 10.8h11v9.2h-11zM8.8 10.8V8.2a3.2 3.2 0 0 1 6.4 0v2.6';
  const REACH = Object.freeze({
    open: Object.freeze({ word: 'Open to anyone', tone: 'critical', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.6 2.4 3.8 5.3 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.3-3.8-8.5S9.4 5.9 12 3.5z' }),
    guarded: Object.freeze({ word: 'After sign-in', tone: 'neutral', icon: LOCK }),
    unknown: Object.freeze({ word: 'Guard to confirm', tone: 'pending', icon: LOCK }),
    platform: Object.freeze({ word: 'Platform-guarded', tone: 'neutral', icon: LOCK })
  });
  const LEDGER_STATUS = Object.freeze({
    covered: Object.freeze({ word: 'Checked', tone: 'good', icon: 'M5 12.5l4.2 4.2L19 7' }),
    traced: Object.freeze({ word: 'Traced', tone: 'good', icon: 'M5 6.5h4a3 3 0 0 1 3 3v5a3 3 0 0 0 3 3h4M17 15.5l2 2-2 2M4.5 6.5h.1' }),
    mapped: Object.freeze({ word: 'Mapped', tone: 'good', icon: 'M5 5h5a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h11M16 14l3 3-3 3' }),
    partial: Object.freeze({ word: 'Partly traced', tone: 'warning', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17V3.5z' }),
    patterns: Object.freeze({ word: 'Patterns only', tone: 'pending', icon: 'M4 7h16M4 12h10M4 17h6' }),
    'not-applicable': Object.freeze({ word: 'Nothing to check', tone: 'neutral', icon: 'M6 12h12' }),
    'not-assessed': Object.freeze({ word: 'Not assessed', tone: 'pending', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.7 9.7a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.4v.5M12 16.6v.1' })
  });
  /* The classes Uranus follows values through, as opposed to checking files for. */
  const TRACED_CLASSES = new Set(['injection', 'requests', 'browser', 'objects', 'ai']);
  /* One drawn mark per family, so the tiles read before their labels do. */
  const FAMILY_ICON = Object.freeze({
    'supply-chain': 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
    code: 'M8.5 7l-5 5 5 5M15.5 7l5 5-5 5M13.4 4.5l-2.8 15',
    secrets: 'M8 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM11.5 12h9M17.5 12v3M14.5 12v2.2',
    dependencies: 'M6 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM18 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM12 15.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM7 8l4 7.8M17 8l-4 7.8M8.2 6h7.6',
    infrastructure: 'M4 5.5h16v5H4zM4 13.5h16v5H4zM7.5 8h.1M7.5 16h.1M11 8h5.5M11 16h5.5',
    hygiene: 'M7 4h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 3.5h6M9 12.5l2.1 2.1 4-4.3',
    access: 'M8 11V8a4 4 0 0 1 8 0v3M6 11h12v9.5H6zM12 14.6v2.6'
  });
  /*
   * The OWASP Top 10:2025, in the short words a tile has room for, and the
   * page on top10.owasp.org each links to. A result saved before the 2025
   * edition still carries 2021 labels; its chips link to the 2021 pages, and
   * the map, which is 2025's, counts only 2025 placements.
   */
  const OWASP_EDITION = '2025';
  const OWASP = Object.freeze([
    ['A01', 'Access control', 'A01_2025-Broken_Access_Control'],
    ['A02', 'Misconfiguration', 'A02_2025-Security_Misconfiguration'],
    ['A03', 'Supply chain', 'A03_2025-Software_Supply_Chain_Failures'],
    ['A04', 'Cryptography', 'A04_2025-Cryptographic_Failures'],
    ['A05', 'Injection', 'A05_2025-Injection'],
    ['A06', 'Insecure design', 'A06_2025-Insecure_Design'],
    ['A07', 'Authentication', 'A07_2025-Authentication_Failures'],
    ['A08', 'Integrity', 'A08_2025-Software_or_Data_Integrity_Failures'],
    ['A09', 'Logging & alerting', 'A09_2025-Security_Logging_and_Alerting_Failures'],
    ['A10', 'Exceptional conditions', 'A10_2025-Mishandling_of_Exceptional_Conditions']
  ]);
  const OWASP_URL = Object.freeze({
    2025: Object.freeze(Object.fromEntries(OWASP.map(([id, , slug]) => [id, `https://top10.owasp.org/2025/${slug}/`]))),
    2021: Object.freeze({
      A01: 'A01_2021-Broken_Access_Control', A02: 'A02_2021-Cryptographic_Failures', A03: 'A03_2021-Injection',
      A04: 'A04_2021-Insecure_Design', A05: 'A05_2021-Security_Misconfiguration', A06: 'A06_2021-Vulnerable_and_Outdated_Components',
      A07: 'A07_2021-Identification_and_Authentication_Failures', A08: 'A08_2021-Software_and_Data_Integrity_Failures',
      A09: 'A09_2021-Security_Logging_and_Monitoring_Failures', A10: 'A10_2021-Server-Side_Request_Forgery_%28SSRF%29'
    })
  });
  const owaspUrl = (id, year) => {
    const table = OWASP_URL[year];
    if (!table || !table[id]) return null;
    return year === '2021' ? `https://owasp.org/Top10/${table[id]}/` : table[id];
  };
  /* Why a finding sits in its category, in a line a tooltip has room for. */
  const OWASP_BASIS = Object.freeze({
    cwe: cwe => `OWASP maps ${cwe} to this category`,
    text: () => 'A02 names missing or weak security headers outright',
    scope: cwe => `${cwe} is on no 2025 list; filed by the category's scope`
  });
  const TOP25_URL = 'https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html';
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
    sarif: 'M8 4H6a2 2 0 0 0-2 2v4l-1.5 2L4 14v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4l1.5 2-1.5 2v4a2 2 0 0 1-2 2h-2M9 12h6',
    route: 'M5 5h5a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h11M16 14l3 3-3 3',
    lock: LOCK,
    write: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6'
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
   * Every section below the summary folds to its heading. Which ones are
   * folded is kept for this browser by section name only -- never a
   * repository, a path or a finding -- so a redraw, the next audit and the
   * next visit find the page as the reader left it. Folding animates the
   * height, then takes the body out of the tab order and the accessibility
   * tree; the toggle says which way it will go.
   */
  const FOLD_STORE = 'nv_ui:audit-folded';
  const FOLDS = Object.freeze(['first', 'families', 'surface', 'coverage', 'controls', 'owasp', 'findings', 'site']);
  const folded = new Set();
  try {
    const stored = JSON.parse(global.localStorage.getItem(FOLD_STORE) || '[]');
    if (Array.isArray(stored)) for (const id of stored) if (FOLDS.includes(id)) folded.add(id);
  } catch { /* no storage: every section starts open */ }
  function keepFolds() {
    try { global.localStorage.setItem(FOLD_STORE, JSON.stringify([...folded])); } catch { /* the choice lasts this page */ }
  }
  function paintFold(card, open) {
    const body = card.querySelector(':scope > .audit-fold');
    const toggle = card.querySelector(':scope .audit-fold-toggle');
    card.dataset.folded = open ? 'false' : 'true';
    if (body) body.inert = !open;
    if (toggle) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${toggle.dataset.name}`);
      toggle.title = open ? 'Collapse' : 'Expand';
    }
  }
  /* Opens a section that something is about to show a result in. */
  function unfold(id, root) {
    if (!folded.delete(id)) return;
    keepFolds();
    const card = root && root.querySelector(`[data-fold="${id}"]`);
    if (card) paintFold(card, true);
  }
  /*
   * Moves everything after `head` into a folding body and puts the toggle at
   * the end of `head`. `name` is what the toggle folds, in words.
   */
  function foldable(card, id, head, name) {
    card.classList.add('audit-foldable');
    card.dataset.fold = id;
    const body = element('div', 'audit-fold');
    body.id = `auditFold-${id}`;
    const inner = element('div', 'audit-fold-inner');
    let node = head.nextSibling;
    while (node) {
      const next = node.nextSibling;
      inner.appendChild(node);
      node = next;
    }
    body.appendChild(inner);
    card.appendChild(body);
    const toggle = keyed(button('', 'audit-fold-toggle', () => {
      const open = card.dataset.folded === 'true';
      if (open) folded.delete(id); else folded.add(id);
      keepFolds();
      paintFold(card, open);
    }), `fold:${id}`);
    toggle.dataset.name = name;
    toggle.setAttribute('aria-controls', body.id);
    toggle.appendChild(icon(ICON.chevron, 'audit-ico audit-fold-chev'));
    head.appendChild(toggle);
    paintFold(card, !folded.has(id));
    return card;
  }

  /*
   * A status as an outline: the tone on its edge and its glyph, the words in
   * ink. `beam` sends light round the edge, for the few statuses the eye
   * should go to first.
   */
  function chip(tone, word, options = {}) {
    const node = element('span', `nv-chip${options.large ? ' nv-chip-lg' : ''}${options.className ? ` ${options.className}` : ''}`);
    node.dataset.tone = tone;
    if (options.beam) node.dataset.beam = 'on';
    if (options.zero) node.dataset.zero = 'true';
    if (options.glyph) node.appendChild(icon(options.glyph));
    if (options.count !== undefined) node.appendChild(element('b', null, String(options.count)));
    /* A space the flex layout ignores, so the chip reads "3 serious" to a screen reader and a copy. */
    if (options.count !== undefined && word) node.appendChild(document.createTextNode(' '));
    if (word) node.appendChild(element('span', null, word));
    if (options.title) node.title = options.title;
    return node;
  }
  function severityChip(severity, options = {}) {
    return chip(severity, SEVERITY[severity].word, { glyph: SEVERITY[severity].icon, ...options });
  }
  function verdictChip(finding, options = {}) {
    const verdict = VERDICT[verdictOf(finding)];
    return chip(verdict.tone, verdict.word, { glyph: verdict.icon, className: 'audit-verdict-chip', ...options });
  }
  function reachChip(reach) {
    if (!reach || !REACH[reach.auth]) return null;
    const entry = REACH[reach.auth];
    const where = reach.route ? `${reach.method} ${reach.route}` : reach.method === 'ACTION' ? 'a server action' : 'this endpoint';
    return chip(entry.tone, entry.word, { glyph: entry.icon, className: 'audit-reach', title: `Reached through ${where}` });
  }

  /*
   * Uranus's mark: a planet turned on its side, its ring near upright. Drawn
   * as line art so it takes the colour it sits on.
   */
  function uranusMark(className = 'audit-ico uranus-mark') {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', className);
    const planet = document.createElementNS(SVG, 'circle');
    planet.setAttribute('cx', '12');
    planet.setAttribute('cy', '12');
    planet.setAttribute('r', '5.2');
    const band = document.createElementNS(SVG, 'path');
    band.setAttribute('d', 'M7.4 10.4c3 1.2 6.2 1.2 9.2 0');
    const ring = document.createElementNS(SVG, 'ellipse');
    ring.setAttribute('cx', '12');
    ring.setAttribute('cy', '12');
    ring.setAttribute('rx', '10.4');
    ring.setAttribute('ry', '2.5');
    ring.setAttribute('transform', 'rotate(-76 12 12)');
    svg.append(planet, band, ring);
    return svg;
  }

  /*
   * While Uranus reads: a planet of dots lit from one side, so it reads as a
   * sphere, with bands of light running pole to pole the way the planet
   * turns, and its near-upright ring of dots lit one after another. The
   * ring's far side is hidden where the planet stands in front of it. It
   * says "working" and nothing more -- the audit is one request, and the
   * screen does not invent the progress it cannot see. Held still without
   * motion.
   */
  function uranusLoader() {
    const wrap = element('div', 'uranus-loader');
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('class', 'uranus-loader-art');
    const radius = 31;
    const light = [-0.52, -0.58, 0.63];
    const planet = document.createElementNS(SVG, 'g');
    planet.setAttribute('class', 'uranus-loader-planet');
    const step = 6.2;
    for (let row = -5; row <= 5; row += 1) {
      for (let col = -5; col <= 5; col += 1) {
        const x = col * step;
        const y = row * step;
        const d = Math.hypot(x, y);
        if (d > radius) continue;
        const nx = x / radius;
        const ny = y / radius;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const lit = Math.max(0, nx * light[0] + ny * light[1] + nz * light[2]);
        const dot = document.createElementNS(SVG, 'circle');
        dot.setAttribute('cx', (60 + x).toFixed(1));
        dot.setAttribute('cy', (60 + y).toFixed(1));
        dot.setAttribute('r', (0.95 + lit * 1.25).toFixed(2));
        dot.style.setProperty('--lit', (0.34 + lit * 0.66).toFixed(2));
        dot.style.setProperty('--col', String(col + 5));
        planet.appendChild(dot);
      }
    }
    const ring = document.createElementNS(SVG, 'g');
    ring.setAttribute('class', 'uranus-loader-ring');
    const tilt = -76 * Math.PI / 180;
    const count = 34;
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const lx = Math.cos(angle) * 55;
      const ly = Math.sin(angle) * 12.5;
      const x = lx * Math.cos(tilt) - ly * Math.sin(tilt);
      const y = lx * Math.sin(tilt) + ly * Math.cos(tilt);
      const behind = Math.sin(angle) < 0;
      /* The planet hides the far half of the ring where it stands in front of it. */
      if (behind && Math.hypot(x, y) < radius + 2) continue;
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', (60 + x).toFixed(1));
      dot.setAttribute('cy', (60 + y).toFixed(1));
      dot.setAttribute('r', behind ? '1.25' : '1.7');
      dot.style.setProperty('--i', String(index));
      if (behind) dot.setAttribute('class', 'is-back');
      ring.appendChild(dot);
    }
    svg.append(planet, ring);
    wrap.appendChild(svg);
    return wrap;
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
  function exportMenu(onExport, key, kinds) {
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
    const items = EXPORTS.filter(([kind]) => !kinds || kinds.includes(kind)).map(([kind, path, word, hint, name]) => {
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
    const traced = result.engine && result.engine.traced;
    if (traced && traced.cut) notes.push(`tracing reached the server's ${traced.limit === 'memory' ? 'memory' : 'time'} limit, so ${plural(traced.cut, 'file was', 'files were')} checked against the rules without being traced`);
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
    const surface = result.surface && result.surface.counts;
    if (surface) {
      const reached = surface.endpoints + surface.actions;
      add(ICON.route, 'Endpoints', reached ? `${reached} mapped` : 'None found', 'Endpoints and server actions a caller can reach, each with the guard in front of it');
    }
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

  /* The headline counts what is confirmed; a lead to confirm is named as one, never as an issue. */
  function verdict(result, status) {
    if (status === 'running') return 'Auditing this branch…';
    if (!result) return 'Not audited yet';
    const confirmed = result.findings.filter(finding => verdictOf(finding) === 'confirmed');
    const counts = severityCounts(confirmed);
    const leads = result.findings.length - confirmed.length;
    if (counts.critical) return `${plural(counts.critical, 'critical issue', 'critical issues')} to fix`;
    if (counts.serious) return `${plural(counts.serious, 'serious issue', 'serious issues')} to fix`;
    if (counts.warning) return `${plural(counts.warning, 'warning', 'warnings')}, nothing serious`;
    if (leads) return `${plural(leads, 'lead', 'leads')} to confirm, nothing confirmed`;
    return 'Nothing found in what was read';
  }

  /* Confirmed against to confirm, for a result that carries verdicts. */
  function verdictSplit(findings) {
    const leads = findings.filter(finding => verdictOf(finding) === 'needs-validation').length;
    if (!findings.length) return null;
    const row = element('div', 'audit-split');
    row.setAttribute('aria-label', `${findings.length - leads} confirmed, ${leads} to confirm`);
    row.append(chip(VERDICT.confirmed.tone, 'confirmed', { glyph: VERDICT.confirmed.icon, count: findings.length - leads, zero: findings.length === leads }),
      chip(VERDICT['needs-validation'].tone, 'to confirm', { glyph: VERDICT['needs-validation'].icon, count: leads, zero: !leads }));
    return row;
  }

  function severityTally(findings) {
    const counts = severityCounts(findings);
    const list = element('ul', 'audit-tally');
    list.setAttribute('aria-label', `${plural(findings.length, 'finding', 'findings')}: ${ORDER.map(severity => `${counts[severity]} ${severity}`).join(', ')}`);
    for (const severity of ORDER) {
      const item = element('li', 'audit-tally-item');
      item.dataset.severity = severity;
      item.dataset.zero = counts[severity] ? 'false' : 'true';
      item.appendChild(severityChip(severity, { count: counts[severity], large: true, zero: !counts[severity], beam: severity === 'critical' && counts.critical > 0 }));
      list.appendChild(item);
    }
    return list;
  }

  /* What the audit reads, for the moment before it has read anything. */
  const SCOPE = Object.freeze(['Traced injection', 'Endpoint access', 'SSRF & redirects', 'AI output', 'Committed secrets', 'OSV advisories', 'Malicious packages', 'CI workflows', 'Supabase RLS', 'Firebase rules', 'Infrastructure', 'Hygiene']);

  /* The ring's place while Uranus reads. */
  function scanning() {
    const wrap = element('div', 'audit-grade audit-grade-scan');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', 'Auditing');
    wrap.dataset.running = 'true';
    wrap.appendChild(uranusLoader());
    return wrap;
  }

  /*
   * Where a running audit is, as the server reports it: four steps, the
   * current one lit, a line in words, and how many of the files have been
   * read. Numbers and stage names only -- the server sends nothing else
   * while it works. Updated in place between polls, so the loader keeps
   * turning instead of restarting with every answer.
   */
  const STAGE_STEPS = Object.freeze([
    { id: 'resolve', label: 'Resolve', stages: ['resolving'] },
    { id: 'read', label: 'Read', stages: ['reading'] },
    { id: 'ask', label: 'Check', stages: ['advisories'] },
    { id: 'trace', label: 'Trace', stages: ['queued', 'analysing', 'patterns'] }
  ]);
  function stageLine(progress) {
    const p = progress || {};
    switch (p.stage) {
      case 'reading': return p.total ? `Reading files · ${p.done || 0} of ${p.total}` : 'Listing the files to read';
      case 'advisories': return 'Asking the package registries and OSV about each dependency';
      case 'queued': return p.position > 1 ? `Waiting for ${p.position} audits ahead of this one` : 'Waiting for another audit to finish';
      case 'analysing': return 'Mapping endpoints and tracing each value to what uses it';
      case 'patterns': return `Tracing needed more ${p.limit === 'time' ? 'time' : 'memory'} than this server gives one audit, so every file is being checked against the rules instead`;
      default: return 'Resolving the branch to a commit';
    }
  }
  function progressBlock(progress) {
    const wrap = element('div', 'audit-progress');
    const steps = element('ol', 'audit-steps');
    steps.setAttribute('aria-label', 'Audit steps');
    for (const step of STAGE_STEPS) {
      const item = element('li', 'audit-step');
      item.dataset.step = step.id;
      item.append(element('span', 'audit-step-dot'), element('span', 'audit-step-label', step.label));
      steps.appendChild(item);
    }
    const line = element('p', 'audit-progress-line');
    const bar = element('div', 'audit-progress-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Files read');
    bar.appendChild(element('span', 'audit-progress-fill'));
    /* Only a change of step is announced; the running count would be noise. */
    const announce = element('span', 'sr-only');
    announce.setAttribute('role', 'status');
    wrap.append(steps, line, bar, announce);
    updateProgress(wrap, progress);
    return wrap;
  }
  function updateProgress(wrap, progress) {
    const p = progress && progress.stage ? progress : { stage: 'resolving' };
    const current = Math.max(0, STAGE_STEPS.findIndex(step => step.stages.includes(p.stage)));
    wrap.dataset.stage = p.stage;
    wrap.querySelectorAll('.audit-step').forEach((item, index) => {
      item.dataset.state = index < current ? 'done' : index === current ? 'active' : 'next';
      if (index === current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    const text = stageLine(p);
    const line = wrap.querySelector('.audit-progress-line');
    if (line.textContent !== text) line.textContent = text;
    const bar = wrap.querySelector('.audit-progress-bar');
    const total = Math.max(0, Number(p.total) || 0);
    const done = Math.min(total, Math.max(0, Number(p.done) || 0));
    const fraction = current > 1 ? 1 : current === 1 && total ? done / total : 0;
    bar.style.setProperty('--audit-read', fraction.toFixed(4));
    bar.dataset.busy = current > 1 ? 'true' : 'false';
    if (total) {
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(total));
      bar.setAttribute('aria-valuenow', String(current > 1 ? total : done));
      bar.setAttribute('aria-valuetext', `${current > 1 ? total : done} of ${total} files read`);
    } else {
      ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].forEach(name => bar.removeAttribute(name));
    }
    const announce = wrap.querySelector('[role="status"]');
    const step = STAGE_STEPS[current].label;
    if (announce.dataset.step !== `${step}:${p.stage}`) {
      announce.dataset.step = `${step}:${p.stage}`;
      announce.textContent = p.stage === 'reading' ? 'Reading files' : text;
    }
  }
  /* A poll's answer, painted into the running card without redrawing it. */
  function progress(root, value) {
    const wrap = root && root.querySelector('.audit-summary .audit-progress');
    if (!wrap) return false;
    updateProgress(wrap, value);
    return true;
  }

  /* Which engine read the branch, and how far it followed values. */
  function engineLine(result) {
    const engine = result.engine;
    if (!engine || !engine.traced) return null;
    const traced = engine.traced;
    const files = (traced.javascript || 0) + (traced.python || 0);
    const parts = [`${plural(files, 'file', 'files')} traced`];
    if (traced.functions) parts.push(`${plural(traced.functions, 'helper', 'helpers')} summarised`);
    parts.push(`${plural((traced.endpoints || 0) + (traced.actions || 0), 'entry point', 'entry points')} mapped`);
    if (traced.flows) parts.push(`${plural(traced.flows, 'path', 'paths')} to a sink${traced.crossFile ? `, ${traced.crossFile} across files` : ''}`);
    if (traced.failed) parts.push(`${plural(traced.failed, 'file', 'files')} it could not follow`);
    if (traced.cut) parts.push(`${plural(traced.cut, 'file', 'files')} left to the rules (${traced.limit === 'memory' ? 'memory' : 'time'} limit)`);
    const line = element('p', 'audit-engine-line');
    line.append(uranusMark('audit-ico uranus-mark'), element('strong', null, `${engine.name} ${String(engine.version || '').replace(/\.0$/, '')}`), element('span', null, parts.join(' · ')));
    return line;
  }

  function renderSummary(host, view, handlers, previous) {
    const card = element('section', 'card audit-summary');
    card.setAttribute('aria-labelledby', 'auditSummaryHeading');
    const result = view.result;
    const status = view.status;

    const layout = element('div', 'audit-grade-row');
    const label = result ? `Grade ${result.grade}, ${result.score} out of 100` : status === 'running' ? 'Auditing' : 'Not audited';
    const fresh = result && (!previous || previous.id !== resultId(result));
    layout.appendChild(status === 'running' ? scanning() : ring(result, status, label, fresh ? 0 : null));

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
      read.appendChild(progressBlock(view.progress));
    } else if (!result) {
      const scope = element('ul', 'audit-scope');
      scope.setAttribute('aria-label', 'What the audit checks');
      for (const item of SCOPE) scope.appendChild(element('li', null, item));
      read.appendChild(scope);
    } else {
      read.appendChild(severityTally(result.findings));
      const split = result.engine ? verdictSplit(result.findings) : null;
      if (split) read.appendChild(split);
      const notes = element('div', 'audit-notes');
      if (result.capped) notes.appendChild(element('p', 'audit-cap', 'Held below 50 while a confirmed critical finding is open.'));
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
      const engine = engineLine(result);
      if (engine) card.appendChild(engine);
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
    const head = element('div', 'audit-card-head audit-first-head');
    const heading = element('h2', 'audit-kicker', 'Fix first');
    heading.id = 'auditFirstHeading';
    head.appendChild(heading);
    card.appendChild(head);
    const list = element('ol', 'audit-first-list');
    chosen.forEach((finding, index) => {
      const item = element('li', 'audit-first-item');
      item.dataset.severity = finding.severity;
      const control = button('', 'audit-first-btn', () => focusFinding(root, finding.id));
      const toConfirm = verdictOf(finding) === 'needs-validation';
      control.setAttribute('aria-label', `${index + 1}. ${SEVERITY[finding.severity].word}${toConfirm ? ', to confirm' : ''}: ${finding.title}, ${location(finding)}`);
      const rank = element('span', 'audit-first-rank', String(index + 1));
      const tags = element('span', 'audit-first-tags');
      tags.appendChild(severityChip(finding.severity, { beam: finding.severity === 'critical' && !toConfirm }));
      const body = element('span', 'audit-first-body');
      body.append(element('span', 'audit-first-title', finding.title), element('span', 'audit-first-where', location(finding)));
      const extra = element('span', 'audit-first-extra');
      const detail = detailChip(finding);
      if (detail) extra.appendChild(element('span', 'audit-first-chip', detail));
      if (toConfirm) extra.appendChild(verdictChip(finding));
      else if (finding.reach && finding.reach.auth === 'open') extra.appendChild(reachChip(finding.reach));
      if (extra.childNodes.length) body.appendChild(extra);
      control.append(rank, tags, body, icon(ICON.arrow, 'audit-ico audit-first-go'));
      item.appendChild(control);
      list.appendChild(item);
    });
    card.appendChild(list);
    host.appendChild(foldable(card, 'first', head, 'Fix first'));
  }

  /* Opens a finding in the list and brings it into view, with focus on its row. */
  function focusFinding(root, id) {
    const details = root.querySelector(`details[data-finding-id="${CSS.escape(id)}"]`);
    if (!details) return;
    unfold('findings', root);
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
      const control = keyed(button('', 'audit-category-btn', () => {
        /* The narrowed list is where the answer appears: it opens if it was folded. */
        unfold('findings');
        handlers.onFilter(view.filter === category.id ? null : category.id);
      }), `family:${category.id}`);
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
        counts.appendChild(chip('good', 'Clear', { glyph: ICON.check, className: 'audit-category-ok' }));
      } else {
        for (const severity of ORDER) {
          if (!category.counts[severity]) continue;
          const count = chip(severity, severity, { glyph: SEVERITY[severity].icon, count: category.counts[severity], className: 'audit-category-count' });
          count.dataset.severity = severity;
          counts.appendChild(count);
        }
      }
      const leads = category.toConfirm ? ORDER.reduce((total, severity) => total + (category.toConfirm[severity] || 0), 0) : 0;
      if (leads) counts.appendChild(element('span', 'audit-category-leads', `${leads} to confirm`));
      const meter = element('span', 'audit-category-meter');
      meter.setAttribute('aria-hidden', 'true');
      meter.style.setProperty('--audit-fill', `${category.score}%`);
      control.append(top, score, counts, meter);
      item.appendChild(control);
      list.appendChild(item);
    }
    const families = element('section', 'audit-families');
    families.setAttribute('aria-labelledby', 'auditFamiliesHeading');
    const head = element('div', 'audit-card-head audit-families-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'Families');
    heading.id = 'auditFamiliesHeading';
    titles.append(heading, element('p', 'audit-card-lede', 'Each scored on its own out of 100. Choose one to narrow the findings to it.'));
    head.appendChild(titles);
    families.append(head, list);
    host.appendChild(foldable(families, 'families', head, 'Families'));
  }

  /* ---- Attack surface ------------------------------------------------------- */

  /* An endpoint's guard, in the endpoint list's words. */
  const ENDPOINT_AUTH = Object.freeze({
    guarded: Object.freeze({ word: 'Signed in', tone: 'neutral', icon: LOCK }),
    open: Object.freeze({ word: 'Open', tone: 'warning', icon: REACH.open.icon }),
    unknown: Object.freeze({ word: 'Guard to confirm', tone: 'pending', icon: LOCK }),
    platform: Object.freeze({ word: 'Platform', tone: 'neutral', icon: LOCK })
  });
  const FRAMEWORK_NAME = Object.freeze({
    express: 'Express', fastify: 'Fastify', koa: 'Koa', hono: 'Hono', next: 'Next.js', 'next-pages': 'Next.js',
    'server-action': 'Server action', sveltekit: 'SvelteKit', remix: 'Remix', 'supabase-edge': 'Edge function',
    serverless: 'Serverless', flask: 'Flask', fastapi: 'FastAPI', django: 'Django'
  });
  const SURFACE_FOLD = 6;
  /* Surfaces the reader unfolded, by result, so a redraw keeps them open. */
  const expandedSurfaces = new Set();
  /* What needs a look first: open and writing, then a guard to confirm, then open, then the rest. */
  const surfaceRank = entry => (entry.auth === 'open' && entry.mutation && !entry.publicByDesign ? 0
    : entry.auth === 'unknown' ? 1 : entry.auth === 'open' && !entry.publicByDesign ? 2 : entry.auth === 'open' ? 3 : 4);

  function renderSurface(host, view, handlers) {
    const result = view.result;
    const surface = result && result.surface;
    if (!surface || !surface.counts) return;
    const counts = surface.counts;
    const total = counts.endpoints + counts.actions;
    if (!total) return;
    const card = element('section', 'card audit-surface');
    card.setAttribute('aria-labelledby', 'auditSurfaceHeading');
    const head = element('div', 'audit-card-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'Attack surface');
    heading.id = 'auditSurfaceHeading';
    titles.append(heading, element('p', 'audit-card-lede', 'Every endpoint and server action a caller can reach, and what stands in front of it.'));
    head.appendChild(titles);
    card.appendChild(head);

    const stats = element('div', 'audit-surface-stats');
    stats.setAttribute('role', 'list');
    const stat = (node) => { node.setAttribute('role', 'listitem'); stats.appendChild(node); };
    stat(chip('neutral', counts.endpoints === 1 ? 'endpoint' : 'endpoints', { glyph: ICON.route, count: counts.endpoints, large: true }));
    if (counts.actions) stat(chip('neutral', counts.actions === 1 ? 'server action' : 'server actions', { glyph: ICON.spark, count: counts.actions, large: true }));
    stat(chip('neutral', 'signed in', { glyph: LOCK, count: counts.guarded, large: true, zero: !counts.guarded }));
    stat(chip('warning', 'open', { glyph: REACH.open.icon, count: counts.open, large: true, zero: !counts.open }));
    if (counts.unknown) stat(chip('pending', 'guard to confirm', { glyph: LOCK, count: counts.unknown, large: true }));
    stat(chip('neutral', counts.mutating === 1 ? 'writes data' : 'write data', { glyph: ICON.write, count: counts.mutating, large: true, zero: !counts.mutating }));
    card.appendChild(stats);

    if (Array.isArray(surface.globalGuards) && surface.globalGuards.length) {
      const guards = element('p', 'audit-surface-guards');
      guards.append(icon(ICON.shield), element('span', null, 'Guarded across the app by '));
      surface.globalGuards.slice(0, 4).forEach((guard, index) => {
        if (index) guards.appendChild(document.createTextNode(index === surface.globalGuards.length - 1 || index === 3 ? ' and ' : ', '));
        if (guard.path && handlers.onOpen) {
          const open = button('', 'audit-inline-file', () => handlers.onOpen({ path: guard.path, line: null }));
          open.textContent = guard.path;
          open.setAttribute('aria-label', `Open ${guard.path}`);
          guards.appendChild(open);
        } else guards.appendChild(element('code', null, guard.path || 'a shared guard'));
      });
      guards.appendChild(document.createTextNode('.'));
      card.appendChild(guards);
    }

    const entries = [...(surface.endpoints || [])].sort((a, b) => surfaceRank(a) - surfaceRank(b));
    if (entries.length) {
      const id = resultId(result);
      const all = expandedSurfaces.has(id) || entries.length <= SURFACE_FOLD + 1;
      const list = element('ul', 'audit-routes');
      list.setAttribute('aria-label', 'Endpoints');
      entries.forEach((entry, index) => {
        const item = element('li', 'audit-route');
        if (!all && index >= SURFACE_FOLD) item.hidden = true;
        const method = element('span', 'audit-route-method', entry.action ? 'ACTION' : String(entry.method || 'ANY'));
        const where = element('span', 'audit-route-main');
        where.append(element('span', 'audit-route-path', entry.route || (entry.action ? 'Server action' : '—')));
        const meta = element('span', 'audit-route-meta');
        if (FRAMEWORK_NAME[entry.framework]) meta.appendChild(element('span', 'audit-route-fw', FRAMEWORK_NAME[entry.framework]));
        if (entry.path && handlers.onOpen) {
          const open = button('', 'audit-inline-file', () => handlers.onOpen(entry));
          open.textContent = location(entry);
          open.setAttribute('aria-label', `Open ${location(entry)}`);
          meta.appendChild(open);
        } else if (entry.path) meta.appendChild(element('span', 'audit-route-file', location(entry)));
        where.appendChild(meta);
        const tags = element('span', 'audit-route-tags');
        const auth = entry.auth === 'open' && entry.publicByDesign ? { word: 'Public by design', tone: 'neutral', icon: REACH.open.icon } : ENDPOINT_AUTH[entry.auth] || ENDPOINT_AUTH.unknown;
        tags.appendChild(chip(auth.tone, auth.word, { glyph: auth.icon, beam: entry.auth === 'open' && entry.mutation && !entry.publicByDesign }));
        if (entry.mutation) tags.appendChild(chip('neutral', 'Writes', { glyph: ICON.write }));
        if (entry.admin) tags.appendChild(chip('serious', 'Admin', { glyph: ICON.shield }));
        item.append(method, where, tags);
        list.appendChild(item);
      });
      card.appendChild(list);
      if (!all) {
        const more = keyed(button('', 'btn btn-ghost audit-more', event => {
          expandedSurfaces.add(id);
          for (const row of list.querySelectorAll('.audit-route[hidden]')) row.hidden = false;
          event.currentTarget.remove();
        }), 'surface-more');
        more.append(element('span', null, `Show all ${entries.length}`), element('span', 'audit-more-of', `${SURFACE_FOLD} of ${entries.length}`));
        card.appendChild(more);
      }
      if (surface.truncated) card.appendChild(element('p', 'audit-coverage', `The first ${entries.length} are listed; the counts above include every one.`));
    }
    host.appendChild(foldable(card, 'surface', head, 'Attack surface'));
  }

  /* ---- Coverage and controls ---------------------------------------------- */

  /*
   * What was looked at, and how closely: each class of attack traced, only
   * pattern-checked, not present, or out of reach for rules. Next to it,
   * what the repository already does right. A clean findings list means
   * little without the first, and a reviewer weighs the second.
   */
  function ledgerStatus(entry) {
    if (entry.status === 'covered' && TRACED_CLASSES.has(entry.id)) return 'traced';
    if (entry.status === 'covered' && entry.id === 'access') return 'mapped';
    return LEDGER_STATUS[entry.status] ? entry.status : 'not-assessed';
  }
  function renderCoverage(host, view, handlers) {
    const result = view.result;
    if (!result || !Array.isArray(result.ledger) || !result.ledger.length) return;

    const card = element('section', 'card audit-ledger');
    card.setAttribute('aria-labelledby', 'auditLedgerHeading');
    const head = element('div', 'audit-card-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'Coverage');
    heading.id = 'auditLedgerHeading';
    titles.append(heading, element('p', 'audit-card-lede', 'What this read looked at, and how closely. Nothing reported is not the same as clear.'));
    head.appendChild(titles);
    card.appendChild(head);
    const list = element('ul', 'audit-ledger-list');
    for (const entry of result.ledger) {
      const status = LEDGER_STATUS[ledgerStatus(entry)];
      const item = element('li', 'audit-ledger-item');
      item.dataset.status = ledgerStatus(entry);
      const mark = element('span', 'audit-ledger-mark');
      mark.dataset.tone = status.tone;
      mark.appendChild(icon(status.icon));
      const text = element('span', 'audit-ledger-text');
      const top = element('span', 'audit-ledger-top');
      top.append(element('span', 'audit-ledger-name', entry.label), chip(status.tone, status.word, { className: 'audit-ledger-chip' }));
      text.append(top, element('span', 'audit-ledger-detail', entry.detail || ''));
      const found = [];
      if (entry.confirmed) found.push(`${entry.confirmed} confirmed`);
      if (entry.toConfirm) found.push(`${entry.toConfirm} to confirm`);
      if (found.length) text.appendChild(element('span', 'audit-ledger-found', found.join(' · ')));
      item.append(mark, text);
      list.appendChild(item);
    }
    card.appendChild(list);
    host.appendChild(foldable(card, 'coverage', head, 'Coverage'));

    const side = element('section', 'card audit-controls');
    side.setAttribute('aria-labelledby', 'auditControlsHeading');
    const sideHead = element('div', 'audit-card-head');
    const sideTitles = element('div', 'audit-card-titles');
    const sideHeading = element('h2', 'audit-kicker', 'Already in place');
    sideHeading.id = 'auditControlsHeading';
    sideTitles.append(sideHeading, element('p', 'audit-card-lede', 'Defences the read recognised, each with where it was first seen.'));
    sideHead.appendChild(sideTitles);
    side.appendChild(sideHead);
    const controlsFound = Array.isArray(result.controls) ? result.controls : [];
    if (!controlsFound.length) {
      side.appendChild(element('p', 'audit-controls-none', 'None recognised. The read knows the common libraries and settings by name, so a defence of your own may still be there.'));
    } else {
      const items = element('ul', 'audit-controls-list');
      for (const control of controlsFound) {
        const item = element('li', 'audit-control');
        const mark = element('span', 'audit-control-mark');
        mark.appendChild(icon(ICON.check));
        const text = element('span', 'audit-control-text');
        text.appendChild(element('span', 'audit-control-name', control.label));
        if (control.path && handlers.onOpen) {
          const open = button('', 'audit-inline-file', () => handlers.onOpen({ path: control.path, line: null }));
          open.textContent = control.path;
          open.setAttribute('aria-label', `Open ${control.path}`);
          text.appendChild(open);
        } else text.appendChild(element('span', 'audit-control-where', control.path || 'Across the repository'));
        item.append(mark, text);
        items.appendChild(item);
      }
      side.appendChild(items);
    }
    host.appendChild(foldable(side, 'controls', sideHead, 'Already in place'));
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
    const heading = element('h2', 'audit-kicker', `OWASP Top 10 · ${OWASP_EDITION}`);
    heading.id = 'auditOwaspHeading';
    const cwes = new Set(result.findings.map(finding => finding.standards && finding.standards.cwe).filter(Boolean));
    const top25 = result.findings.filter(finding => finding.standards && finding.standards.top25).length;
    const titles = element('div', 'audit-card-titles audit-owasp-titles');
    titles.append(heading, element('span', 'audit-owasp-cwe', `${plural(cwes.size, 'CWE', 'CWEs')} across ${plural(result.findings.length, 'finding', 'findings')}`
      + (top25 ? ` · ${plural(top25, 'finding', 'findings')} in the CWE Top 25` : '')));
    head.appendChild(titles);
    card.appendChild(head);
    const list = element('ul', 'audit-owasp-grid');
    list.setAttribute('aria-label', 'OWASP Top 10 categories');
    for (const [id, word] of OWASP) {
      const under = result.findings.filter(finding => finding.standards && finding.standards.owasp === `${id}:${OWASP_EDITION}`);
      const counts = severityCounts(under);
      const worst = ORDER.find(severity => counts[severity]) || 'clear';
      const item = element('li', 'audit-owasp-item');
      const control = keyed(button('', 'audit-owasp-btn', () => {
        unfold('findings');
        if (handlers.onOwasp) handlers.onOwasp(view.owasp === id ? null : id);
      }), `owasp:${id}`);
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
    host.appendChild(foldable(card, 'owasp', head, 'OWASP Top 10'));
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
    const owaspId = /^(A\d{2}):(2021|2025)$/.exec(standards.owasp || '');
    const owaspHref = owaspId && owaspUrl(owaspId[1], owaspId[2]);
    if (owaspHref) {
      const owasp = element('a', 'audit-std-chip audit-std-owasp', `OWASP ${owaspId[1]}`);
      owasp.href = owaspHref;
      owasp.target = '_blank';
      owasp.rel = 'noopener noreferrer';
      const basis = OWASP_BASIS[standards.owaspBasis];
      owasp.title = `${standards.owasp} ${standards.owaspName}${basis ? ` — ${basis(standards.cwe)}` : ''}`;
      wrap.appendChild(owasp);
    }
    const rank = standards.top25 && Number(standards.top25.rank);
    if (rank >= 1 && rank <= 25) {
      const top = element('a', 'audit-std-chip audit-std-top25', `Top 25 #${rank}`);
      top.href = TOP25_URL;
      top.target = '_blank';
      top.rel = 'noopener noreferrer';
      top.title = `${standards.cwe} is number ${rank} in the 2025 CWE Top 25 Most Dangerous Software Weaknesses`;
      wrap.appendChild(top);
    }
    return wrap.childNodes.length ? wrap : null;
  }

  /* ---- Findings ------------------------------------------------------------- */

  /* Every word a reader might search a finding by. */
  function searchText(finding, families) {
    const standards = finding.standards || {};
    const reach = finding.reach && REACH[finding.reach.auth];
    return [finding.title, finding.rule, finding.where || location(finding), families && families.get(finding.category),
      standards.cwe, standards.cweName, standards.owasp, standards.owaspName, detailChip(finding), SEVERITY[finding.severity].word,
      VERDICT[verdictOf(finding)].word, reach && reach.word, finding.reach && finding.reach.route]
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

  /* Who reaches the line: the method, the route and the guard in front of it. */
  function reachLine(reach) {
    const line = element('p', 'audit-reach-line');
    const entry = REACH[reach.auth];
    const through = reach.route ? `${reach.method} ${reach.route}` : reach.method === 'ACTION' ? 'a server action' : 'an endpoint';
    line.append(icon(ICON.route), element('span', null, 'Reached through '), element('code', 'audit-reach-route', through));
    if (FRAMEWORK_NAME[reach.framework]) line.appendChild(element('span', 'audit-reach-fw', FRAMEWORK_NAME[reach.framework]));
    if (entry) line.appendChild(chip(entry.tone, entry.word, { glyph: entry.icon }));
    return line;
  }

  /*
   * The path Uranus followed, step by step: where the value entered, what it
   * passed through, the line that used it. Places and words only -- no step
   * carries the code it points at.
   */
  const STEP_ROLE = Object.freeze({ entrypoint: 'Enters', propagation: 'Passes', sink: 'Reaches' });
  function traceView(finding, handlers) {
    const wrap = element('div', 'audit-trace');
    const head = element('p', 'audit-trace-head');
    head.append(icon(ICON.route), element('span', null, finding.source ? `Traced from a ${finding.source}` : 'Traced path'));
    wrap.appendChild(head);
    const list = element('ol', 'audit-trace-list');
    const steps = finding.trace.slice(0, 12);
    steps.forEach((step, index) => {
      const item = element('li', 'audit-trace-step');
      item.dataset.role = step.role || 'propagation';
      const role = element('span', 'audit-trace-role', STEP_ROLE[step.role] || 'Passes');
      const note = String(step.note || '');
      const text = element('span', 'audit-trace-note', note.charAt(0).toUpperCase() + note.slice(1));
      const place = step.line ? `${step.path}:${step.line}` : step.path;
      let where;
      if (step.path && handlers.onOpen) {
        where = button('', 'audit-inline-file', () => handlers.onOpen({ path: step.path, line: step.line }));
        where.textContent = place;
        where.setAttribute('aria-label', `Open ${place}, step ${index + 1} of the traced path`);
      } else where = element('span', 'audit-trace-where', place || '');
      item.append(role, text, where);
      list.appendChild(item);
    });
    wrap.appendChild(list);
    if (finding.trace.length > steps.length) wrap.appendChild(element('p', 'audit-coverage', `and ${finding.trace.length - steps.length} more steps`));
    return wrap;
  }

  /* For a lead: the one fact the read could not settle, and the local check that settles it. */
  function validation(finding) {
    const wrap = element('div', 'audit-validate');
    if (finding.blocker) {
      const unknown = element('div', 'audit-validate-part');
      unknown.append(element('span', 'audit-validate-label', 'What is unknown'), element('p', null, finding.blocker));
      wrap.appendChild(unknown);
    }
    if (finding.check) {
      const check = element('div', 'audit-validate-part');
      check.append(element('span', 'audit-validate-label', 'How to confirm'), element('p', null, finding.check));
      wrap.appendChild(check);
    }
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
      const toConfirm = verdictOf(finding) === 'needs-validation';
      if (toConfirm) item.dataset.verdict = 'needs-validation';
      const pill = severityChip(finding.severity, { className: `audit-pill audit-pill-${finding.severity}` });
      const main = element('span', 'audit-row-main');
      main.appendChild(element('span', 'exposure-item-title', finding.title));
      const sub = element('span', 'audit-row-sub');
      sub.appendChild(element('span', 'audit-row-where', finding.where || location(finding)));
      const family = families && families.get(finding.category);
      if (family) sub.appendChild(element('span', 'audit-row-family', family));
      main.appendChild(sub);
      summary.append(pill, main);
      const tags = element('span', 'audit-row-tags');
      const detail = detailChip(finding);
      if (detail) {
        const tag = element('span', 'audit-row-chip', detail);
        tag.title = detail;
        tags.appendChild(tag);
      }
      if (toConfirm) tags.appendChild(verdictChip(finding));
      else if (finding.reach && finding.reach.auth === 'open') tags.appendChild(reachChip(finding.reach));
      if (changes && changes.newIds.has(finding.id)) tags.appendChild(chip('info', 'New', { className: 'audit-new', beam: true }));
      if (tags.childNodes.length) summary.appendChild(tags);
      details.appendChild(summary);

      const body = element('div', 'audit-body');
      body.appendChild(element('p', 'exposure-item-consequence', finding.why));
      if (finding.reach) body.appendChild(reachLine(finding.reach));
      if (finding.trace && finding.trace.length) body.appendChild(traceView(finding, handlers));
      if (toConfirm && (finding.blocker || finding.check)) body.appendChild(validation(finding));
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
      && (!view.owasp || (finding.standards && finding.standards.owasp === `${view.owasp}:${OWASP_EDITION}`)));
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
      const leads = inScope.filter(finding => verdictOf(finding) === 'needs-validation').length;
      if (leads || view.verdict) {
        const verdicts = element('div', 'audit-segments audit-verdicts');
        verdicts.setAttribute('role', 'group');
        verdicts.setAttribute('aria-label', 'Show by verdict');
        const option = (value, text, total) => {
          const control = keyed(button('', 'audit-segment', () => handlers.onVerdict && handlers.onVerdict(value)), `verdict:${value || 'all'}`);
          control.setAttribute('aria-pressed', (view.verdict || null) === value ? 'true' : 'false');
          if (value) {
            control.dataset.verdict = value;
            control.append(icon(VERDICT[value].icon));
          }
          control.append(element('span', null, text), element('span', 'audit-segment-n', String(total)));
          control.disabled = Boolean(value) && !total && view.verdict !== value;
          return control;
        };
        verdicts.append(option(null, 'Any', inScope.length), option('confirmed', 'Confirmed', inScope.length - leads), option('needs-validation', 'To confirm', leads));
        tools.appendChild(verdicts);
      }
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

    const shown = inScope.filter(finding => (!view.severity || finding.severity === view.severity)
      && (!view.verdict || verdictOf(finding) === view.verdict) && matches(finding, view.query, families));
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
    host.appendChild(foldable(card, 'findings', head, 'Findings'));
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
    host.appendChild(foldable(card, 'site', head, 'Deployed site'));
  }

  /*
   * A redraw keeps what the reader had open, and grows the ring only for a
   * result it has not drawn before.
   */
  const drawn = new WeakMap();
  /*
   * The findings the reader opened, kept per screen while a filter hides
   * them, so narrowing the list and widening it again does not fold what
   * they were reading.
   */
  const openFindings = new WeakMap();
  function openSet(root) {
    let ids = openFindings.get(root);
    if (ids) return ids;
    ids = new Set([...root.querySelectorAll('details[open][data-finding-id]')].map(node => node.dataset.findingId));
    root.addEventListener('toggle', event => {
      const details = event.target;
      if (!details || details.tagName !== 'DETAILS' || !details.dataset.findingId) return;
      if (details.open) ids.add(details.dataset.findingId);
      else ids.delete(details.dataset.findingId);
    }, true);
    openFindings.set(root, ids);
    return ids;
  }
  function render(root, view, handlers) {
    if (!root) return;
    const open = openSet(root);
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
      renderSurface(root, view, handlers);
      renderCoverage(root, view, handlers);
      renderStandards(root, view, handlers);
      renderFindings(root, view, handlers);
    }
    if (view.site) renderSite(root, { ...view.site, hasRepositoryResult: Boolean(view.result) }, handlers, previous);
    for (const id of [...open]) {
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
        ...(finding.verdict ? [`- **Verdict:** ${VERDICT[verdictOf(finding)].word.toLowerCase()}${finding.evidence ? ` (${EVIDENCE_WORD[finding.evidence] || finding.evidence})` : ''}`] : []),
        `- **Rule:** ${finding.rule}`,
        `- **Where:** ${place(finding)}`
      );
      if (finding.reach) {
        const reach = REACH[finding.reach.auth];
        lines.push(`- **Reached through:** ${finding.reach.route ? `\`${finding.reach.method} ${finding.reach.route}\`` : 'a server action'}${reach ? ` — ${reach.word.toLowerCase()}` : ''}`);
      }
      if (Array.isArray(finding.trace) && finding.trace.length) {
        lines.push(`- **Traced path:** ${finding.trace.map(step => `${STEP_ROLE[step.role] || 'Passes'} \`${step.line ? `${step.path}:${step.line}` : step.path}\` (${step.note})`).join(' → ')}`);
      }
      const standards = finding.standards;
      if (standards) {
        lines.push(`- **Standards:** ${[standards.cwe && `${standards.cwe}${standards.cweName ? ` (${standards.cweName})` : ''}`,
          standards.owasp && `OWASP ${standards.owasp} ${standards.owaspName}`,
          standards.top25 && `CWE Top 25 (2025) #${standards.top25.rank}`].filter(Boolean).join(' · ')}`);
      }
      const detail = finding.detail;
      if (detail && finding.rule === 'SCR-001') lines.push(`- **Credential:** ${detail.credential}`);
      if (detail && finding.rule === 'DEP-004') lines.push(`- **Looks like:** ${detail.resembles}`);
      if (detail && detail.package && Array.isArray(detail.advisories)) {
        lines.push(`- **Package:** ${detail.package} ${detail.source === 'range' ? `${detail.range} (lowest accepted ${detail.version})` : detail.version}${detail.direct ? '' : ' (transitive)'}`);
        if (detail.fixed) lines.push(`- **Fixed in:** ${detail.fixed}`);
        lines.push(`- **Advisories:** ${detail.advisories.map(advisory => `${advisory.id}${advisory.cve ? ` (${advisory.cve})` : ''}`).join(', ')}${detail.more ? ` and ${detail.more} more` : ''}`);
      }
      lines.push('', finding.why, '');
      if (verdictOf(finding) === 'needs-validation') {
        if (finding.blocker) lines.push(`**What is unknown.** ${finding.blocker}`, '');
        if (finding.check) lines.push(`**How to confirm.** ${finding.check}`, '');
      }
      lines.push(
        `**Fix.** ${finding.fix}`,
        '',
        '```text',
        finding.prompt,
        '```',
        ''
      );
    });
  }

  const EVIDENCE_WORD = Object.freeze({ traced: 'path traced', surface: 'endpoint map', fact: 'stated in the file', pattern: 'pattern only' });

  function brief(result, repoLabel, site) {
    const lines = [`# Security audit: ${repoLabel}`, ''];
    if (result) {
      const leads = result.findings.filter(finding => verdictOf(finding) === 'needs-validation').length;
      const engine = result.engine && result.engine.traced ? result.engine : null;
      lines.push(
        `Grade **${result.grade}** — ${result.score}/100${result.capped ? ' (held below 50 by a confirmed critical finding)' : ''}.`,
        `Commit \`${result.commitSha}\`, audited ${result.auditedAt || new Date().toISOString()}${engine ? ` by ${engine.name} ${engine.version}` : ''}.`,
        ...(engine ? [`${result.findings.length - leads} confirmed, ${leads} to confirm. A finding to confirm weighs half and names the check that settles it.`] : []),
        '',
        coverageLine(result),
        coverageCaveat(result),
        '',
        '| Family | Score | Critical | Serious | Warning |',
        '| --- | --- | --- | --- | --- |',
        ...result.categories.map(category => `| ${category.label} | ${category.score} | ${category.counts.critical} | ${category.counts.serious} | ${category.counts.warning} |`),
        ''
      );
      if (Array.isArray(result.ledger) && result.ledger.length) {
        lines.push('## Coverage', '', '| Class | Status | What was read |', '| --- | --- | --- |',
          ...result.ledger.map(entry => `| ${entry.label} | ${LEDGER_STATUS[ledgerStatus(entry)].word} | ${cell(entry.detail)} |`), '');
      }
      if (result.surface && result.surface.counts && (result.surface.counts.endpoints + result.surface.counts.actions)) {
        const counts = result.surface.counts;
        lines.push(`**Attack surface:** ${plural(counts.endpoints, 'endpoint', 'endpoints')}${counts.actions ? ` and ${plural(counts.actions, 'server action', 'server actions')}` : ''}; ${counts.guarded} signed in, ${counts.open} open${counts.unknown ? `, ${counts.unknown} behind a guard to confirm` : ''}; ${counts.mutating} write data.`, '');
      }
      if (Array.isArray(result.controls) && result.controls.length) {
        lines.push('**Already in place:**', '', ...result.controls.map(control => `- ${control.label}${control.path ? ` (\`${control.path}\`)` : ''}`), '');
      }
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
      const tags = ['security', finding.category, standards.cwe && `external/cwe/${standards.cwe.toLowerCase()}`,
        standards.owasp && `owasp-${standards.owasp.replace(':', '-').toLowerCase()}`, standards.top25 && 'cwe-top25-2025'].filter(Boolean);
      rules.set(finding.rule, {
        id: finding.rule,
        name: finding.rule.replace('-', ''),
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.why },
        help: { text: finding.fix, markdown: `**Fix.** ${finding.fix}` },
        ...(standards.cwe ? { helpUri: `https://cwe.mitre.org/data/definitions/${standards.cwe.slice(4)}.html` } : {}),
        defaultConfiguration: { level: SARIF_LEVEL[finding.severity] },
        properties: {
          tags, precision: 'high', 'problem.severity': finding.severity === 'warning' ? 'warning' : 'error', 'security-severity': SECURITY_SEVERITY[finding.severity],
          ...(standards.owaspBasis ? { 'owasp-basis': standards.owaspBasis } : {}),
          ...(standards.top25 ? { 'cwe-top25-2025-rank': standards.top25.rank } : {})
        }
      });
    }
    return [...rules.values()];
  }

  /* A traced path as a SARIF code flow, which code-scanning dashboards draw step by step. */
  function sarifFlow(trace) {
    return [{ threadFlows: [{ locations: trace.map(step => ({
      location: {
        physicalLocation: { artifactLocation: { uri: step.path, uriBaseId: 'SRCROOT' }, ...(step.line ? { region: { startLine: step.line } } : {}) },
        message: { text: step.note || STEP_ROLE[step.role] || 'step' }
      },
      kinds: [step.role === 'entrypoint' ? 'source' : step.role === 'sink' ? 'sink' : 'pass-through']
    })) }] }];
  }
  function sarifResult(finding, ruleIndex, place, suppression) {
    const toConfirm = verdictOf(finding) === 'needs-validation';
    const result = {
      ruleId: finding.rule,
      ruleIndex,
      /* A lead is a note, not an error: a dashboard should not fail a build on something unconfirmed. */
      level: toConfirm ? 'note' : SARIF_LEVEL[finding.severity],
      ...(toConfirm ? { kind: 'review' } : {}),
      message: { text: `${finding.title}. ${finding.why}${toConfirm && finding.blocker ? ` To confirm: ${finding.blocker}` : ''}` },
      ...place,
      ...(Array.isArray(finding.trace) && finding.trace.length && place.locations && place.locations[0].physicalLocation ? { codeFlows: sarifFlow(finding.trace) } : {}),
      partialFingerprints: { 'nebulaverseFinding/v1': finding.id || `${finding.rule}:${finding.where || location(finding)}` },
      properties: {
        severity: finding.severity, family: finding.category || 'site',
        ...(finding.verdict ? { verdict: verdictOf(finding), evidence: finding.evidence || null } : {}),
        ...(finding.reach ? { reach: { method: finding.reach.method, route: finding.reach.route, auth: finding.reach.auth } } : {}),
        ...(toConfirm && finding.check ? { howToConfirm: finding.check } : {})
      }
    };
    if (suppression) result.suppressions = [{ kind: 'inSource', justification: suppression.reason || 'Waived in code without a reason.' }];
    return result;
  }

  function sarif(result, site, meta = {}) {
    const driver = rules => ({
      driver: {
        name: 'Nebulaverse-X Uranus',
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
        properties: {
          grade: result.grade, score: result.score, capped: Boolean(result.capped),
          ...(result.engine ? { engine: `${result.engine.name} ${result.engine.version}`, traced: result.engine.traced || null } : {}),
          ...(Array.isArray(result.ledger) ? { coverage: result.ledger.map(entry => ({ class: entry.id, status: entry.status })) } : {})
        }
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
    const rows = [['Source', 'Status', 'Severity', 'Verdict', 'Rule', 'Title', 'Family', 'CWE', 'CWE Top 25 (2025)', 'OWASP', 'Location', 'Line', 'Reached through', 'How to confirm', 'Reason waived', 'Fix']];
    const row = (source, status, finding, family) => {
      const standards = finding.standards || {};
      const reach = finding.reach ? `${finding.reach.route ? `${finding.reach.method} ${finding.reach.route}` : 'server action'} (${finding.reach.auth})` : '';
      rows.push([source, status, finding.severity, verdictOf(finding) === 'needs-validation' ? 'to confirm' : 'confirmed', finding.rule, finding.title, family || '', standards.cwe || '',
        standards.top25 ? `#${standards.top25.rank}` : '', standards.owasp || '',
        finding.path || finding.where || 'whole repository', finding.line || '', reach,
        verdictOf(finding) === 'needs-validation' ? finding.check || '' : '',
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

  /*
   * Exposure findings as CSV and SARIF. The rows arrive already made safe by
   * the caller: a rule, a displayable path (never the raw one, which can be
   * named with the credential), a line, a status. Nothing here could carry a
   * secret because nothing here is given one.
   */
  const EXPOSURE_COLUMNS = ['Severity', 'Credential', 'Rule', 'Location', 'Line', 'Status', 'Where', 'Introduced in', 'Provider says', 'Fingerprint'];
  function exposureCsv(rows) {
    const lines = [EXPOSURE_COLUMNS, ...rows.map(row => [row.severity, row.label, row.rule, row.where, row.line || '', row.status,
      [row.inTree === false ? 'history only' : 'tree', row.archive ? 'archive' : '', row.encoded ? 'base64' : ''].filter(Boolean).join(' + '),
      row.commit || '', row.verified || '', row.fingerprint])];
    return `${lines.map(cells => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }
  function exposureSarif(rows, meta = {}) {
    const rules = [];
    const index = new Map();
    for (const row of rows) {
      if (index.has(row.rule)) continue;
      index.set(row.rule, rules.length);
      rules.push({
        id: row.rule,
        name: row.label,
        shortDescription: { text: `${row.label} committed to the repository` },
        help: { text: 'Revoke the credential with its issuer, replace it, then remove it from the repository and its history.' },
        helpUri: 'https://cwe.mitre.org/data/definitions/798.html',
        defaultConfiguration: { level: SARIF_LEVEL[row.severity] || 'error' },
        properties: { tags: ['security', 'secret', 'external/cwe/cwe-798', 'owasp-a07-2025'], precision: 'high', 'security-severity': SECURITY_SEVERITY[row.severity] || '7.5' }
      });
    }
    const results = rows.map(row => {
      const result = {
        ruleId: row.rule,
        ruleIndex: index.get(row.rule),
        level: SARIF_LEVEL[row.severity] || 'error',
        message: { text: `${row.label} in ${row.where}${row.inTree === false ? ', only in history' : ''}.` },
        locations: [{ physicalLocation: { artifactLocation: { uri: row.where, uriBaseId: 'SRCROOT' }, ...(row.line ? { region: { startLine: row.line } } : {}) } }],
        partialFingerprints: { 'nebulaverseExposure/v1': row.fingerprint },
        properties: { severity: row.severity, status: row.status, inTree: row.inTree !== false, ...(row.commit ? { introducedIn: row.commit } : {}), ...(row.verified ? { providerSays: row.verified } : {}) }
      };
      if (row.status === 'accepted-risk') result.suppressions = [{ kind: 'external', justification: row.acceptedBy ? `Risk accepted by ${row.acceptedBy}` : 'Risk accepted' }];
      return result;
    });
    return JSON.stringify({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{
      tool: { driver: { name: 'Nebulaverse-X Exposure', informationUri: meta.informationUri || 'https://github.com/T-rex-G/Nebula-checkpoints', rules } },
      automationDetails: { id: `nebulaverse-exposure/${meta.ref || 'branch'}/` },
      ...(meta.repositoryUri && meta.commitSha ? { versionControlProvenance: [{ repositoryUri: meta.repositoryUri, revisionId: meta.commitSha, ...(meta.ref ? { branch: meta.ref } : {}) }] } : {}),
      originalUriBaseIds: { SRCROOT: { uri: 'file:///' } },
      results
    }] }, null, 2);
  }

  function allPrompts(result) {
    return (result ? result.findings : []).map((finding, index) => `${index + 1}. ${finding.prompt}`).join('\n\n');
  }

  global.NebulaCodeAudit = Object.freeze({ STORE_PREFIX, render, progress, brief, sarif, csv, exposureCsv, exposureSarif, exportMenu, allPrompts, diff, readPrevious, remember, storageKey });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaCodeAudit;
