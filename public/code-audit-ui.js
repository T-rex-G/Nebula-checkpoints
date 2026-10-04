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
    access: 'M8 11V8a4 4 0 0 1 8 0v3M6 11h12v9.5H6zM12 14.6v2.6',
    licences: 'M12 4v16M6.5 20h11M5 7.5h14M7.5 7.5 4.5 14a3 3 0 0 0 6 0zM16.5 7.5l-3 6.5a3 3 0 0 0 6 0z'
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
    spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6',
    flame: 'M12 3c.8 3.3 5.5 5.4 5.5 10.2A5.5 5.5 0 0 1 6.5 13.2c0-2.3 1.1-3.9 2.5-5.1.2 1.8 1 2.9 2.4 3.4C10.8 8.9 11.2 5.9 12 3z',
    gauge: 'M4 17.5a8 8 0 1 1 16 0M12 17.5l4.2-5.3M12 17.6v.1',
    ransom: 'M6.5 10.8h11v9.2h-11zM8.8 10.8V8.2a3.2 3.2 0 0 1 6.4 0v2.6M12 13.6v2.6M12 18.4v.1',
    code: 'M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5',
    layers: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
    tool: 'M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17v3h3l5.5-5.5a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-.6-.6-2.4z',
    flask: 'M9.5 3.5h5M10.5 3.5v6L5.3 18.4a1.4 1.4 0 0 0 1.2 2.1h11a1.4 1.4 0 0 0 1.2-2.1L13.5 9.5v-6M8 15h8',
    unknown: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.7 9.7a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.4v.5M12 16.6v.1',
    watch: 'M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12zM12 9.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z',
    history: 'M3.8 12a8.2 8.2 0 1 0 2.4-5.8M3.8 4.6v3.8h3.8M12 7.8V12l2.9 1.9',
    refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v3.8h-3.8',
    news: 'M12 3.5l2.2 5.3 5.3 2.2-5.3 2.2L12 18.5l-2.2-5.3L4.5 11l5.3-2.2z',
    trash: 'M5 7h14M10 7V4.8h4V7M7 7l.8 12.2h8.4L17 7M10.2 10.5v5.6M13.8 10.5v5.6',
    clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.4V12l3.1 2',
    flag: 'M5.5 20.5V4M5.5 4.5h11l-2.2 4 2.2 4h-11',
    reopen: 'M3.8 12a8.2 8.2 0 1 0 2.4-5.8M3.8 4.6v3.8h3.8',
    timer: 'M12 6.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 10v3.5l2.2 1.4M9.5 3h5'
  });
  const STORE_PREFIX = 'nv_audit:';
  const SVG = 'http://www.w3.org/2000/svg';
  const ADVISORY_ID = /^[A-Za-z][A-Za-z0-9._-]{2,63}$/;
  const CVE_ID = /^CVE-\d{4}-\d{4,7}$/;

  /*
   * How close a vulnerable package is to the running code, as Uranus placed
   * it. None of these words says "unused": a package with no import found is
   * "installed", because frameworks load packages by convention.
   */
  const REACH_TIER = Object.freeze({
    imported: Object.freeze({ word: 'Imported', icon: 'M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5', tone: 'neutral' }),
    named: Object.freeze({ word: 'Named in code', icon: 'M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5', tone: 'neutral' }),
    bundled: Object.freeze({ word: 'Bundled', icon: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9M8 5.3l8 4.4', tone: 'neutral' }),
    transitive: Object.freeze({ word: 'Via a dependency', icon: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4', tone: 'neutral' }),
    installed: Object.freeze({ word: 'Installed', icon: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9', tone: 'neutral' }),
    unknown: Object.freeze({ word: 'Reach unknown', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.7 9.7a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.4v.5M12 16.6v.1', tone: 'pending' }),
    build: Object.freeze({ word: 'Build only', icon: 'M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17v3h3l5.5-5.5a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-.6-.6-2.4z', tone: 'neutral' }),
    test: Object.freeze({ word: 'Tests only', icon: 'M9.5 3.5h5M10.5 3.5v6L5.3 18.4a1.4 1.4 0 0 0 1.2 2.1h11a1.4 1.4 0 0 0 1.2-2.1L13.5 9.5v-6M8 15h8', tone: 'neutral' }),
    dev: Object.freeze({ word: 'Dev only', icon: 'M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17v3h3l5.5-5.5a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-.6-.6-2.4z', tone: 'neutral' })
  });
  /* Risk bands in the status tones, each with its word: never colour alone. */
  const RISK_BAND = Object.freeze({
    urgent: Object.freeze({ word: 'Urgent', tone: 'critical' }),
    high: Object.freeze({ word: 'High', tone: 'serious' }),
    moderate: Object.freeze({ word: 'Moderate', tone: 'warning' }),
    low: Object.freeze({ word: 'Low', tone: 'neutral' })
  });
  const RISK_ORDER = Object.freeze(['urgent', 'high', 'moderate', 'low']);
  const ECOSYSTEM_NAME = Object.freeze({ npm: 'npm', pypi: 'PyPI', go: 'Go', maven: 'Maven', packagist: 'Composer', rubygems: 'RubyGems', cargo: 'Cargo', nuget: 'NuGet' });
  const PRODUCTION_TIERS = new Set(['imported', 'named', 'bundled', 'transitive', 'installed', 'unknown']);

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
  const FOLDS = Object.freeze(['watch', 'first', 'risk', 'families', 'surface', 'licences', 'coverage', 'controls', 'owasp', 'findings', 'remediation', 'history', 'site']);
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
  /* 'POST,PUT' as a reader writes it: POST/PUT */
  const verbs = method => String(method || 'ANY').split(',').join('/');
  function reachChip(reach) {
    if (!reach || !REACH[reach.auth]) return null;
    const entry = REACH[reach.auth];
    const where = reach.route ? `${verbs(reach.method)} ${reach.route}` : reach.method === 'ACTION' ? 'a server action' : 'this endpoint';
    return chip(entry.tone, entry.word, { glyph: entry.icon, className: 'audit-reach', title: `Reached through ${where}` });
  }

  /* ---- Clocks and decisions --------------------------------------------------- */

  /*
   * Every open finding has a clock: the days its branch gives its severity,
   * from the day the kept history first saw it. A row says so only when it
   * matters -- due soon, or past due -- and the finding's body always says
   * where it stands.
   */
  const CLOCK = Object.freeze({
    overdue: Object.freeze({ tone: 'critical', word: 'Overdue' }),
    'due-soon': Object.freeze({ tone: 'warning', word: 'Due soon' }),
    'on-track': Object.freeze({ tone: 'neutral', word: 'On track' })
  });
  const dayWord = count => `${count} ${count === 1 ? 'day' : 'days'}`;
  function clockWords(clock) {
    const days = Math.abs(clock.daysLeft);
    if (clock.state === 'overdue') return `${dayWord(days || 1)} overdue`;
    return days === 0 ? 'Due today' : `Due in ${dayWord(days)}`;
  }
  function clockChip(finding) {
    const clock = finding && finding.clock;
    if (!clock || !CLOCK[clock.state] || clock.state === 'on-track') return null;
    return chip(CLOCK[clock.state].tone, clockWords(clock), {
      glyph: ICON.clock, className: 'audit-clock-chip', beam: clock.state === 'overdue',
      title: `Fix by ${when(clock.dueAt).short}: ${dayWord(clock.days)} from ${when(clock.firstSeenAt).short}, when it was first seen`
    });
  }
  function clockLine(finding) {
    const clock = finding && finding.clock;
    if (!clock || !CLOCK[clock.state]) return null;
    const line = element('p', 'audit-clock-line');
    line.dataset.state = clock.state;
    line.appendChild(icon(ICON.clock));
    const words = element('span', 'audit-clock-words');
    const state = element('b', 'audit-clock-state', clock.state === 'on-track' ? `Fix by ${when(clock.dueAt).short}` : clockWords(clock));
    const why = clock.clock === 'exploited'
      ? `${dayWord(clock.days)}, the critical clock, because it is exploited in the wild`
      : `${dayWord(clock.days)} for a ${finding.severity} finding`;
    words.append(state, document.createTextNode(` · first seen ${when(clock.firstSeenAt).short}${clock.state === 'on-track' ? '' : `, due ${when(clock.dueAt).short}`} · ${why}`));
    line.appendChild(words);
    return line;
  }
  /* A decision in the words the server sent, and who made it. */
  function reasonLabel(view, decision) {
    const vocabulary = view && view.triage && view.triage.vocabulary;
    const found = vocabulary && Array.isArray(vocabulary.reasons) ? vocabulary.reasons.find(reason => reason.id === decision.reason) : null;
    return found ? found.label : decision.reasonLabel || String(decision.reason || '').replace(/-/g, ' ');
  }
  const DISPOSITION = Object.freeze({
    'false-positive': Object.freeze({ word: 'False positive', tone: 'neutral' }),
    'accepted-risk': Object.freeze({ word: 'Risk accepted', tone: 'pending' })
  });
  function decisionSentence(decision, view) {
    const by = decision.decidedBy ? ` by ${decision.decidedBy}` : '';
    const on = decision.decidedAt ? ` on ${when(decision.decidedAt).short}` : '';
    const until = decision.disposition === 'accepted-risk' && decision.expiresAt
      ? decision.lapsed ? `; lapsed ${when(decision.expiresAt).short}` : `, until ${when(decision.expiresAt).short}` : '';
    return `${DISPOSITION[decision.disposition] ? DISPOSITION[decision.disposition].word : 'Decided'}${by}${on}${until} — ${reasonLabel(view, decision)}.`;
  }
  /* What the reader can do about a finding, when the team's decisions are open to them. */
  function canTriage(view, handlers) {
    return Boolean(view && view.triage && view.triage.status === 'ready' && view.triage.canDecide && handlers && handlers.onTriage);
  }

  /* ---- Exploit intelligence and reach ------------------------------------- */

  /* A probability as a reader says it: 21%, 3.4%, 0.04%. */
  function percent(value) {
    const number = Number(value) * 100;
    if (!Number.isFinite(number)) return '';
    if (number >= 10) return `${Math.round(number)}%`;
    if (number >= 1) return `${number.toFixed(1).replace(/\.0$/, '')}%`;
    if (number >= 0.01) return `${number.toFixed(2).replace(/0$/, '')}%`;
    return '<0.01%';
  }
  /* A rank among scored CVEs, rounded down so it never claims more than it is: 99.7%, never 100%. */
  function rank(value) {
    const number = Number(value) * 100;
    if (!Number.isFinite(number)) return '';
    return number >= 99 || number < 10 ? `${(Math.floor(number * 10) / 10).toString()}%` : `${Math.floor(number)}%`;
  }
  const intelOf = finding => (finding && finding.detail && finding.detail.intel) || null;
  const usageOf = finding => (finding && finding.detail && finding.detail.usage) || null;
  const riskOf = finding => (finding && finding.detail && finding.detail.risk) || null;
  /* Exploited in the wild, in something that ships: what holds the grade and leads the list. */
  function exploited(finding) {
    const intel = intelOf(finding);
    const usage = usageOf(finding);
    return Boolean(intel && intel.exploited && finding.rule !== 'DEP-005' && (!usage || PRODUCTION_TIERS.has(usage.tier)));
  }
  function kevChip(finding, options = {}) {
    const intel = intelOf(finding);
    if (!intel || !intel.exploited) return null;
    const title = intel.kev ? `CISA lists ${intel.kev.cve} as exploited in the wild${intel.kev.added ? ` since ${intel.kev.added}` : ''}` : 'Exploited in the wild';
    return chip('critical', options.short ? 'Exploited' : 'Exploited in the wild', { glyph: ICON.flame, beam: exploited(finding), className: 'audit-kev', title });
  }
  function epssChip(intel) {
    if (!intel || !intel.epss || !Number.isFinite(intel.epss.score)) return null;
    const score = intel.epss.score;
    const tone = score >= 0.1 ? 'serious' : score >= 0.01 ? 'warning' : 'neutral';
    const beyond = Number.isFinite(intel.epss.percentile) ? `, higher than ${rank(intel.epss.percentile)} of scored CVEs` : '';
    return chip(tone, `EPSS ${percent(score)}`, { glyph: ICON.gauge, className: 'audit-epss', title: `${percent(score)} chance ${intel.epss.cve} is exploited in the next 30 days${beyond}` });
  }
  function tierWord(usage) {
    if (!usage) return '';
    if (usage.tier === 'transitive' && usage.through && usage.through.length) return `Via ${usage.through[0]}`;
    return (REACH_TIER[usage.tier] || REACH_TIER.unknown).word;
  }
  function tierChip(usage) {
    if (!usage || !REACH_TIER[usage.tier]) return null;
    const entry = REACH_TIER[usage.tier];
    return chip(entry.tone, tierWord(usage), { glyph: entry.icon, className: 'audit-tier', title: tierSentence(usage) });
  }
  const names = (list, total) => {
    const shown = (list || []).filter(Boolean);
    if (!shown.length) return '';
    const text = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
    return total > shown.length ? `${shown.join(', ')} and ${total - shown.length} more` : text;
  };
  /* The reach, as one sentence that never claims more than the scan saw. */
  function tierSentence(usage) {
    if (!usage) return '';
    const files = names(usage.files, usage.count);
    const through = names(usage.through, usage.throughCount);
    switch (usage.tier) {
      case 'imported': return `Imported by the code${files ? `: ${files}` : ''}.`;
      case 'named': return usage.loader === 'bundler'
        ? `Loaded at boot by Bundler.require${files ? ` (${files})` : ''}, which requires every gem the Gemfile lists for production.`
        : `Named in the code where a framework loads it by name${files ? `: ${files}` : ''}.`;
      case 'bundled': return `Shipped by the build: bundled, or served from node_modules${files ? ` (${files})` : ''}.`;
      case 'transitive': return `Not imported itself; it comes with ${through || 'a dependency'}, which the code imports.`;
      case 'installed': return usage.seen === 'test'
        ? `Installed for production. Only tests import it${files ? ` (${files})` : ''}; frameworks load some packages by convention, so that is not proof it never runs.`
        : `Installed for production${through ? ` with ${through}` : ''}, and no import or reference was found in the files read. Frameworks load some packages by convention, so that is not proof it is unused.`;
      case 'unknown': return usage.reason === 'graph'
        ? 'The code does not import it, and the dependency files do not record which package requires it, so how it is reached is unknown.'
        : 'Some source files were not read, so whether the code imports it is unknown.';
      case 'build': return `Only build tooling references it${through ? ` (through ${through})` : files ? ` (${files})` : ''}: it runs when the project is built, not when it serves a request.`;
      case 'test': return `Only tests import it${files ? ` (${files})` : ''}.`;
      case 'dev': return `A development dependency${through ? `, through ${through}` : ''}: installed to build and test, not to run.`;
      default: return '';
    }
  }

  /* The reach in a few words, for a row in a list; the finding itself carries the whole sentence. */
  const fileName = filePath => String(filePath || '').slice(String(filePath || '').lastIndexOf('/') + 1);
  function tierPhrase(usage) {
    if (!usage) return '';
    const count = usage.count || (usage.files || []).length;
    const first = fileName((usage.files || [])[0]);
    const inFiles = first ? `${first}${count > 1 ? ` and ${plural(count - 1, 'more file', 'more files')}` : ''}` : '';
    const through = (usage.through || [])[0];
    switch (usage.tier) {
      case 'imported': return inFiles ? `Imported by ${inFiles}` : 'Imported by the code';
      case 'named': return usage.loader === 'bundler' ? 'Loaded at boot by Bundler.require' : inFiles ? `Named in ${inFiles}` : 'Named in the code';
      case 'bundled': return inFiles ? `Shipped by the build, from ${inFiles}` : 'Shipped by the build';
      case 'transitive': return through ? `Comes with ${through}, which the code imports` : 'Comes with a dependency the code imports';
      case 'installed': return usage.seen === 'test' ? 'Installed for production; only tests import it' : 'Installed for production; no import found';
      case 'unknown': return usage.reason === 'graph' ? 'Reach unknown: nothing records what requires it' : 'Reach unknown: some source files were not read';
      case 'build': return 'Build tooling only';
      case 'test': return 'Only tests import it';
      case 'dev': return through ? `Development only, through ${through}` : 'Development only';
      default: return '';
    }
  }

  /*
   * What is known about exploitation and reach for one vulnerable package:
   * the risk and the three factors it rests on, then the catalog, the EPSS
   * score and the reach, each as a fact with its source and date.
   */
  function intelBlock(finding, handlers) {
    const detail = finding.detail;
    const risk = detail.risk;
    const intel = detail.intel;
    const usage = detail.usage;
    const wrap = element('div', 'audit-intel');
    if (risk) {
      const head = element('div', 'audit-intel-head');
      const meter = element('span', 'audit-intel-meter');
      meter.dataset.band = risk.band;
      meter.style.setProperty('--risk', `${Math.max(0, Math.min(100, risk.score))}%`);
      meter.setAttribute('aria-hidden', 'true');
      const score = element('span', 'audit-intel-score');
      score.append(element('b', null, String(risk.score)), element('span', null, '/100'));
      const title = element('span', 'audit-intel-title', 'Exploit risk');
      head.append(title, score, chip(RISK_BAND[risk.band].tone, RISK_BAND[risk.band].word, { className: 'audit-band' }), meter);
      wrap.appendChild(head);
      const factors = element('p', 'audit-intel-factors');
      const impact = Number.isFinite(detail.cvss) ? `CVSS ${detail.cvss.toFixed(1)}` : 'severity (no CVSS published)';
      const threat = intel && intel.exploited ? 'exploited in the wild' : intel && intel.epss ? `EPSS ${percent(intel.epss.score)}` : 'no exploit score';
      factors.textContent = `From its impact (${impact}), the threat (${threat}) and its reach (${tierWord(usage).toLowerCase() || 'unknown'}).`;
      wrap.appendChild(factors);
    }
    const facts = element('ul', 'audit-intel-facts');
    const fact = (path, text, tone, extra) => {
      const item = element('li', 'audit-intel-fact');
      if (tone) item.dataset.tone = tone;
      const body = element('span', 'audit-intel-text', text);
      item.append(icon(path), body);
      if (extra) body.append(' ', extra);
      facts.appendChild(item);
      return item;
    };
    if (intel) {
      if (intel.exploited && intel.kev) {
        const link = element('a', 'audit-intel-link', 'CISA KEV');
        link.href = `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(CVE_ID.test(intel.kev.cve) ? intel.kev.cve : '')}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.append(icon(ICON.link, 'audit-ico audit-adv-out'));
        fact(ICON.flame, `CISA lists ${intel.kev.cve} as exploited in the wild${intel.kev.added ? `, added ${intel.kev.added}` : ''}${intel.kev.due ? `; US federal agencies had to fix it by ${intel.kev.due}` : ''}.${intel.ransomware ? ' Known to be used in ransomware campaigns.' : ''}`, 'critical', link);
      } else if (intel.catalog === 'unlisted') {
        fact(ICON.flame, `Not in CISA’s catalog of exploited vulnerabilities${intel.cves > 1 ? ` (${intel.cves} CVEs checked)` : ''}.`, null);
      } else {
        fact(ICON.flame, 'CISA’s catalog of exploited vulnerabilities could not be read for this audit: unknown, not clear.', 'pending');
      }
      if (intel.epss) {
        const beyond = Number.isFinite(intel.epss.percentile) ? `, higher than ${rank(intel.epss.percentile)} of scored CVEs` : '';
        fact(ICON.gauge, `EPSS: a ${percent(intel.epss.score)} chance ${intel.epss.cve} is exploited in the next 30 days${beyond}${intel.epss.date ? ` (FIRST, ${intel.epss.date})` : ''}.`, intel.epss.score >= 0.1 ? 'serious' : null);
      } else {
        fact(ICON.gauge, intel.scored === 0 && intel.catalog !== 'unknown' ? 'EPSS has no score for these CVEs yet.' : 'No EPSS score was available for this audit.', 'pending');
      }
    } else if (detail.advisories && detail.advisories.every(advisory => !advisory.cve) && finding.rule !== 'DEP-006') {
      fact(ICON.gauge, 'These advisories carry no CVE, so there is no exploit score or catalog entry to look up.', 'pending');
    }
    if (usage) {
      const tier = REACH_TIER[usage.tier] || REACH_TIER.unknown;
      const item = fact(tier.icon, tierSentence(usage), usage.tier === 'unknown' ? 'pending' : null);
      const openable = (usage.files || []).filter(Boolean);
      if (openable.length && handlers.onOpen) {
        const files = element('span', 'audit-intel-files');
        for (const path of openable) {
          const open = button('', 'audit-inline-file', () => handlers.onOpen({ path, line: null }));
          open.textContent = path;
          open.setAttribute('aria-label', `Open ${path}`);
          files.appendChild(open);
        }
        item.appendChild(files);
      }
      if (Array.isArray(usage.chain) && usage.chain.length > 1) {
        const chain = element('span', 'audit-intel-chain');
        chain.setAttribute('aria-label', `Dependency path: ${usage.chain.join(', then ')}`);
        usage.chain.forEach((name, index) => {
          if (index) chain.appendChild(icon(ICON.arrow, 'audit-ico audit-intel-step'));
          chain.appendChild(element('code', null, name));
        });
        item.appendChild(chain);
      }
    }
    if (facts.childNodes.length) wrap.appendChild(facts);
    return wrap;
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
    ['csv', ICON.table, 'CSV', 'For a spreadsheet or a tracker import', 'Export CSV'],
    ['cyclonedx', ICON.box, 'SBOM · CycloneDX 1.5', 'Every package, its licence and its vulnerabilities', 'Export CycloneDX SBOM'],
    ['spdx', ICON.box, 'SBOM · SPDX 2.3', 'The same bill of materials, for licence and procurement tools', 'Export SPDX SBOM']
  ]);
  const REPORT_EXPORTS = Object.freeze(['brief', 'sarif', 'csv']);
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
    if (engineIdentity(result) !== (previous.engine || null)) return null;
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
  function engineIdentity(result) {
    if (typeof result.engine === 'number') return `site:${result.engine}`;
    return result.engine && result.engine.version ? `repository:${result.engine.version}` : null;
  }
  function readPrevious(repoKey) {
    try { return JSON.parse(global.localStorage.getItem(storageKey(repoKey)) || 'null'); } catch { return null; }
  }
  function remember(repoKey, result) {
    try {
      global.localStorage.setItem(storageKey(repoKey), JSON.stringify({
        at: result.auditedAt || new Date().toISOString(),
        engine: engineIdentity(result),
        ids: result.findings.map(finding => finding.id).slice(0, 2000)
      }));
    } catch { /* private mode: no comparison next time, and nothing is lost */ }
  }

  /* ---- What a result rests on ------------------------------------------------ */

  function coverageLine(result) {
    const coverage = result.coverage || {};
    const rulesOnly = Number(coverage.rulesOnly) || 0;
    const parts = [`Read ${coverage.read} of ${coverage.eligible} files it audits at ${String(result.commitSha || '').slice(0, 7)}` +
      (rulesOnly ? ` (${coverage.read - rulesOnly} traced, ${rulesOnly} against the rules alone)` : '')];
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
    if (advisories.setAside) {
      parts.push(`${plural(advisories.setAside, 'manifest', 'manifests')} kept for tests set aside, as no install of the application`);
    }
    const components = Array.isArray(result.components) ? result.components : [];
    if (components.length) {
      const ecosystems = [...new Set(components.map(component => ECOSYSTEM_NAME[component.ecosystem] || component.ecosystem))];
      parts.push(`${plural(result.componentsTruncated || components.length, 'component', 'components')} in the bill of materials (${ecosystems.join(', ')})`);
    }
    const exploit = coverage.exploit;
    if (exploit && exploit.cves) {
      parts.push(`${exploit.asked} ${exploit.asked === 1 ? 'CVE' : 'CVEs'} checked against ${exploit.kev === 'ok' ? `CISA KEV${exploit.kevVersion ? ` ${exploit.kevVersion}` : ''}` : 'CISA KEV (unavailable)'} and EPSS (${exploit.scored} scored)`);
    }
    const licensing = result.licences && result.licences.status;
    if (licensing && licensing.versions) {
      parts.push(`${licensing.known} of ${licensing.versions} package ${licensing.versions === 1 ? 'version\u2019s licence' : 'versions\u2019 licences'} read`);
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
    if (coverage.packages && coverage.packages.unknown) notes.push(`${plural(coverage.packages.unknown, 'registry lookup', 'registry lookups')} went unanswered`);
    const advisories = coverage.advisories || {};
    if (advisories.unknown) notes.push(`${plural(advisories.unknown, 'advisory lookup', 'advisory lookups')} went unanswered`);
    if (advisories.notChecked) notes.push(`${plural(advisories.notChecked, 'package version', 'package versions')} beyond the advisory limit were not checked`);
    if (advisories.lockfiles > advisories.lockfilesRead) notes.push('a lockfile was not read (over 512 KB or past the budget), so declared ranges stood in for installed versions');
    const licensing = result.licences && result.licences.status;
    if (licensing && licensing.notAsked) notes.push(`${plural(licensing.notAsked, 'package version', 'package versions')} beyond the licence lookup limit were not checked`);
    const exploit = coverage.exploit;
    if (exploit && exploit.cves) {
      if (exploit.kev === 'unavailable') notes.push('CISA’s exploited-vulnerability catalog could not be read, so existing exploit evidence must be treated as last known rather than current');
      else if (exploit.kevStale) notes.push('the exploited-vulnerability catalog is an earlier copy, because a refresh failed');
      if (exploit.epss === 'unavailable') notes.push('EPSS could not be reached, so no exploit probability is shown');
      else if (exploit.epss === 'partial') notes.push('some EPSS requests went unanswered, so some CVEs have no exploit probability');
      if (exploit.cves > exploit.asked) notes.push(`${plural(exploit.cves - exploit.asked, 'CVE', 'CVEs')} beyond the lookup limit have no exploit data`);
    }
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
    const graded = result && Number.isFinite(result.score) && typeof result.grade === 'string';
    const wrap = element('div', `audit-grade audit-grade-${graded ? result.grade : 'none'}`);
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
    const score = graded ? Math.max(0, Math.min(100, result.score)) : status === 'running' ? 28 : 0;
    const start = animateFrom === null || reducedMotion() ? score : animateFrom;
    arc.style.strokeDasharray = `${start} 100`;
    /* A round cap on a zero-length arc is a dot, which reads as a score. */
    if (score === 0 && status !== 'running') arc.dataset.empty = 'true';
    if (start !== score) global.requestAnimationFrame(() => global.requestAnimationFrame(() => { arc.style.strokeDasharray = `${score} 100`; }));
    svg.append(track, arc);
    const face = element('div', 'audit-grade-face');
    face.append(element('span', 'audit-grade-letter', graded ? result.grade : '—'),
      element('span', 'audit-grade-score', graded ? `${result.score}/100` : status === 'running' ? 'reading' : result ? 'incomplete' : 'not audited'));
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
  const SCOPE = Object.freeze(['Traced injection', 'Endpoint access', 'SSRF & redirects', 'AI output', 'Committed secrets', 'Advisories in 8 ecosystems', 'Exploited CVEs (KEV, EPSS)', 'Dependency reach', 'SBOM (CycloneDX, SPDX)', 'Malicious packages', 'CI workflows', 'Supabase RLS', 'Firebase rules', 'Infrastructure', 'Hygiene']);

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
    { id: 'read', label: 'Read', stages: ['reading', 'rules'] },
    { id: 'ask', label: 'Check', stages: ['advisories', 'intel'] },
    { id: 'trace', label: 'Trace', stages: ['queued', 'analysing', 'patterns'] }
  ]);
  function stageLine(progress) {
    const p = progress || {};
    switch (p.stage) {
      case 'reading': return p.total ? `Reading files · ${p.done || 0} of ${p.total}` : 'Listing the files to read';
      case 'rules': return `Reading the rest of the branch against the rules · ${p.done || 0} of ${p.total || 0}`;
      case 'advisories': return 'Asking the package registries and OSV about each dependency';
      case 'intel': return 'Checking each CVE against CISA’s exploited-vulnerability catalog and its EPSS score';
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
      bar.setAttribute('aria-valuetext', p.stage === 'rules' ? `${done} of ${total} more files read for the rules` : `${current > 1 ? total : done} of ${total} files read`);
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
    const files = ['javascript', 'python', 'go', 'java', 'php'].reduce((sum, language) => sum + (traced[language] || 0), 0);
    const parts = [`${plural(files, 'file', 'files')} traced`];
    if (traced.functions) parts.push(`${plural(traced.functions, 'helper', 'helpers')} summarised`);
    parts.push(`${plural((traced.endpoints || 0) + (traced.actions || 0), 'entry point', 'entry points')} mapped`);
    if (traced.flows) parts.push(`${plural(traced.flows, 'path', 'paths')} to a sink${traced.crossFile ? `, ${traced.crossFile} across files` : ''}`);
    if (traced.failed) parts.push(`${plural(traced.failed, 'file', 'files')} it could not follow`);
    if (traced.cut) parts.push(`${plural(traced.cut, 'file', 'files')} left to the rules (${traced.limit === 'memory' ? 'memory' : 'time'} limit)`);
    if (traced.rulesOnly) parts.push(`${plural(traced.rulesOnly, 'more file', 'more files')} checked against the rules`);
    const line = element('p', 'audit-engine-line');
    /* Spaces between the parts: the flex gap separates them on screen, and
       without one a screen reader read the version and the count as a single
       number -- "Uranus 2.26 files traced". */
    line.append(uranusMark('audit-ico uranus-mark'), element('strong', null, `${engine.name} ${String(engine.version || '').replace(/\.0$/, '')}`), ' ', element('span', null, parts.join(' · ')));
    return line;
  }

  function renderSummary(host, view, handlers, previous) {
    const card = element('section', 'card audit-summary');
    card.setAttribute('aria-labelledby', 'auditSummaryHeading');
    const result = view.result;
    const status = view.status;
    /* The last kept audit stands in for a result until this page runs one: its grade and counts, never its report. */
    const stored = !result && status !== 'running' ? latestStored(view) : null;

    const layout = element('div', 'audit-grade-row');
    const label = result ? `Grade ${result.grade}, ${result.score} out of 100`
      : stored ? `Grade ${stored.grade}, ${stored.score} out of 100, from the last audit`
        : status === 'running' ? 'Auditing' : 'Not audited';
    const fresh = result && (!previous || previous.id !== resultId(result));
    layout.appendChild(status === 'running' ? scanning() : ring(result || stored, status, label, fresh ? 0 : null));
    if (stored) layout.dataset.stored = 'true';

    const read = element('div', 'audit-grade-read');
    const head = element('div', 'audit-summary-head');
    const heading = element('h2', 'audit-kicker', 'Repository audit');
    heading.id = 'auditSummaryHeading';
    head.appendChild(heading);
    const ref = (result && result.ref) || (stored && stored.ref);
    if (ref) head.appendChild(element('span', 'audit-ref', ref));
    read.appendChild(head);
    read.appendChild(element('p', 'audit-verdict', stored && status !== 'error' ? `Last audited ${when(stored.auditedAt).relative}` : verdict(result, status)));

    if (status === 'error') {
      const error = element('p', 'audit-lede audit-error', view.error || 'The audit could not be completed.');
      error.setAttribute('role', 'alert');
      read.appendChild(error);
    }
    if (status === 'running') {
      read.appendChild(progressBlock(view.progress));
    } else if (stored) {
      read.appendChild(countTally(stored.counts));
      const notes = element('div', 'audit-notes');
      if (stored.capReason) notes.appendChild(element('p', 'audit-cap', stored.capReason === 'exploited'
        ? 'Held below 50 while a vulnerability CISA lists as exploited in the wild shipped with the code.'
        : 'Held below 50 while a confirmed critical finding was open.'));
      notes.appendChild(element('p', 'audit-stored-note',
        `Kept from the audit of ${when(stored.auditedAt).absolute} at ${String(stored.commitSha).slice(0, 7)}. Audit again for the full report: traces, reach and fix prompts are worked out from the code each time and never stored.`));
      read.appendChild(notes);
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
      if (result.capped) notes.appendChild(element('p', 'audit-cap', result.capReason === 'exploited'
        ? 'Held below 50 while a vulnerability CISA lists as exploited in the wild ships with the code.'
        : 'Held below 50 while a confirmed critical finding is open.'));
      if (view.diff) {
        const since = view.diff.previousAt ? ` since the audit of ${new Date(view.diff.previousAt).toLocaleString()}` : '';
        notes.appendChild(element('p', 'audit-diff',
          `${plural(view.diff.newIds.size, 'new finding', 'new findings')}, ${view.diff.resolved} resolved${since}.`));
      }
      const suppressed = result.suppressed || [];
      const triaged = suppressed.filter(finding => finding.suppression && finding.suppression.triage).length;
      const waived = suppressed.length - triaged;
      if (waived || triaged) {
        const parts = [];
        if (waived) parts.push(`${plural(waived, 'finding', 'findings')} waived in code`);
        if (triaged) parts.push(`${plural(triaged, 'finding', 'findings')} triaged by the team`);
        notes.appendChild(element('p', 'audit-waived-note', `${parts.join(' and ')}, listed below and not scored.`));
      }
      const overdue = result.findings.filter(finding => finding.clock && finding.clock.state === 'overdue').length;
      const dueSoon = result.findings.filter(finding => finding.clock && finding.clock.state === 'due-soon').length;
      if (overdue || dueSoon) {
        const clocks = element('p', 'audit-clock-note');
        clocks.dataset.state = overdue ? 'overdue' : 'due-soon';
        clocks.append(icon(ICON.clock), element('span', null,
          [overdue ? `${plural(overdue, 'finding', 'findings')} past ${overdue === 1 ? 'its' : 'their'} deadline` : '', dueSoon ? `${dueSoon} due within days` : ''].filter(Boolean).join(', ') + '.'));
        notes.appendChild(clocks);
      }
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
    run.append(icon(ICON.run), element('span', 'audit-btn-label', status === 'running' ? 'Auditing…' : result || stored ? 'Audit again' : 'Audit this branch'));
    run.disabled = status === 'running';
    actions.appendChild(run);
    if (result) {
      actions.appendChild(exportMenu(handlers.onExport, 'export', Array.isArray(result.components) && result.components.length ? null : REPORT_EXPORTS));
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
    if (finding.category === 'licences' && detail.package) return `${detail.package} ${detail.version} · ${detail.licence || 'no licence'}`;
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
      const control = button('', 'audit-first-btn', () => revealFinding(root, handlers, finding.id));
      const toConfirm = verdictOf(finding) === 'needs-validation';
      control.setAttribute('aria-label', `${index + 1}. ${SEVERITY[finding.severity].word}${toConfirm ? ', to confirm' : ''}${exploited(finding) ? ', exploited in the wild' : ''}: ${finding.title}, ${location(finding)}`);
      const rank = element('span', 'audit-first-rank', String(index + 1));
      const tags = element('span', 'audit-first-tags');
      tags.appendChild(severityChip(finding.severity, { beam: (finding.severity === 'critical' && !toConfirm) || exploited(finding) }));
      const body = element('span', 'audit-first-body');
      body.append(element('span', 'audit-first-title', finding.title), element('span', 'audit-first-where', location(finding)));
      const extra = element('span', 'audit-first-extra');
      const detail = detailChip(finding);
      if (detail) extra.appendChild(element('span', 'audit-first-chip', detail));
      const kev = kevChip(finding, { short: true });
      if (kev) extra.appendChild(kev);
      if (toConfirm) extra.appendChild(verdictChip(finding));
      else if (finding.reach && finding.reach.auth === 'open') extra.appendChild(reachChip(finding.reach));
      else if (!kev && riskOf(finding) && usageOf(finding)) extra.appendChild(tierChip(usageOf(finding)));
      if (extra.childNodes.length) body.appendChild(extra);
      control.append(rank, tags, body, icon(ICON.arrow, 'audit-ico audit-first-go'));
      item.appendChild(control);
      list.appendChild(item);
    });
    card.appendChild(list);
    host.appendChild(foldable(card, 'first', head, 'Fix first'));
  }

  /*
   * Opens a finding from a card above the list. A finding the list is not
   * showing -- past the page, or hidden by a filter or a search -- is
   * brought into it first, so the click is never silently lost.
   */
  function revealFinding(root, handlers, id) {
    if (!root.querySelector(`details[data-finding-id="${CSS.escape(id)}"]`) && handlers.onReveal) handlers.onReveal(id);
    focusFinding(root, id);
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

  /* ---- Dependency risk ---------------------------------------------------- */

  const RISK_FOLD = 6;
  const expandedRisks = new Set();
  /* The vulnerable packages by risk: exploited in something that ships first, then the number. */
  /*
   * One row per package version: declared in two manifests it is still one
   * thing to upgrade. The row keeps the riskiest finding and counts the rest.
   */
  const placesOf = new WeakMap();
  function riskRanked(findings) {
    const ranked = findings.filter(finding => riskOf(finding))
      .sort((a, b) => Number(exploited(b)) - Number(exploited(a)) || riskOf(b).score - riskOf(a).score ||
        ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || String(a.detail.package).localeCompare(String(b.detail.package)));
    const first = new Map();
    const out = [];
    for (const finding of ranked) {
      const detail = finding.detail;
      const key = `${detail.ecosystem || ''}\0${String(detail.package).toLowerCase()}\0${detail.source === 'range' ? detail.range : detail.version}`;
      const kept = first.get(key);
      if (kept) { placesOf.set(kept, (placesOf.get(kept) || 1) + 1); continue; }
      first.set(key, finding);
      out.push(finding);
    }
    return out;
  }
  function intelSources(result) {
    const exploit = result.coverage && result.coverage.exploit;
    if (!exploit) return '';
    const kev = exploit.kev === 'ok'
      ? `CISA’s Known Exploited Vulnerabilities catalog${exploit.kevVersion ? ` ${exploit.kevVersion}` : ''}${exploit.kevCount ? ` (${exploit.kevCount.toLocaleString()} CVEs)` : ''}${exploit.kevStale ? ', an earlier copy because a refresh failed' : ''}`
      : exploit.kev === 'not-needed' ? '' : 'CISA’s catalog could not be read';
    const epss = exploit.epss === 'ok' || exploit.epss === 'partial'
      ? `FIRST EPSS scores for ${exploit.scored} of ${exploit.asked} CVEs${exploit.epss === 'partial' ? ' (some requests went unanswered)' : exploit.unscored ? ` (EPSS has not scored the other ${exploit.unscored} yet)` : ''}`
      : exploit.epss === 'not-needed' ? '' : 'EPSS could not be reached';
    return [kev, epss].filter(Boolean).join(' · ');
  }
  function renderRisk(host, view, handlers, root) {
    const result = view.result;
    if (!result || view.filter || view.owasp) return;
    const ranked = riskRanked(result.findings);
    if (!ranked.length) return;
    const card = element('section', 'card audit-risk');
    card.setAttribute('aria-labelledby', 'auditRiskHeading');
    const head = element('div', 'audit-card-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'Dependency risk');
    heading.id = 'auditRiskHeading';
    titles.append(heading, element('p', 'audit-card-lede', 'Each vulnerable package, ranked by whether it is exploited in the wild, how likely it is to be, and how close it sits to the code that runs.'));
    head.appendChild(titles);
    card.appendChild(head);

    const stats = element('div', 'audit-surface-stats audit-risk-stats');
    stats.setAttribute('role', 'list');
    const stat = node => {
      const item = element('div');
      item.setAttribute('role', 'listitem');
      item.appendChild(node);
      stats.appendChild(item);
    };
    const live = ranked.filter(exploited).length;
    const ransom = ranked.filter(finding => exploited(finding) && intelOf(finding).ransomware).length;
    const exploit = result.coverage && result.coverage.exploit;
    const catalogRead = Boolean(exploit && exploit.kev === 'ok');
    if (live || catalogRead) {
      const toggle = keyed(button('', 'audit-risk-stat', () => {
        if (!handlers.onExploit) return;
        const showing = !view.exploit;
        handlers.onExploit(showing ? 'kev' : null);
        /* The filter narrows the findings list further down: take the reader to what it now shows. */
        if (!showing) return;
        unfold('findings', root);
        const findings = root.querySelector('.audit-findings');
        if (findings) findings.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }), 'risk-exploited');
      toggle.appendChild(chip('critical', 'exploited in the wild', { glyph: ICON.flame, count: live, large: true, zero: !live, beam: live > 0 }));
      toggle.disabled = !live;
      toggle.setAttribute('aria-pressed', view.exploit ? 'true' : 'false');
      toggle.setAttribute('aria-label', live ? `${plural(live, 'package', 'packages')} exploited in the wild: show only these findings` : 'No package is exploited in the wild');
      stat(toggle);
    }
    else if (exploit && exploit.kev === 'unavailable') stat(chip('pending', 'Exploit catalog unavailable', { glyph: ICON.flame, large: true, title: 'CISA’s catalog could not be read: nothing is marked exploited, and nothing is marked clear' }));
    if (ransom) stat(chip('critical', 'used by ransomware', { glyph: ICON.ransom, count: ransom, large: true }));
    for (const band of RISK_ORDER) {
      const count = ranked.filter(finding => riskOf(finding).band === band).length;
      stat(chip(RISK_BAND[band].tone, RISK_BAND[band].word.toLowerCase(), { count, large: true, zero: !count, className: 'audit-band-stat' }));
    }
    card.appendChild(stats);

    const id = resultId(result);
    const all = expandedRisks.has(id) || ranked.length <= RISK_FOLD + 1;
    const list = element('ol', 'audit-risks');
    list.setAttribute('aria-label', 'Vulnerable packages by risk');
    ranked.forEach((finding, index) => {
      const detail = finding.detail;
      const risk = riskOf(finding);
      const item = element('li', 'audit-risk-row');
      item.dataset.band = risk.band;
      if (!all && index >= RISK_FOLD) item.hidden = true;
      const control = button('', 'audit-risk-btn', () => revealFinding(root, handlers, finding.id));
      const version = detail.source === 'range' ? `${detail.range}` : detail.version;
      control.setAttribute('aria-label', `Risk ${risk.score}, ${RISK_BAND[risk.band].word}: ${detail.package} ${version}${exploited(finding) ? ', exploited in the wild' : ''}. ${tierSentence(detail.usage)}`);
      const score = element('span', 'audit-risk-score');
      score.dataset.band = risk.band;
      score.style.setProperty('--risk', `${Math.max(0, Math.min(100, risk.score))}%`);
      score.append(element('b', null, String(risk.score)), element('span', 'audit-risk-band', RISK_BAND[risk.band].word));
      const main = element('span', 'audit-risk-main');
      const name = element('span', 'audit-risk-pkg');
      name.append(element('span', 'audit-risk-name', detail.package), element('span', 'audit-risk-ver', version));
      if (detail.fixed && finding.rule !== 'DEP-006') name.append(icon(ICON.arrow, 'audit-ico audit-risk-arrow'), element('span', 'audit-risk-fix', detail.fixed));
      const sub = element('span', 'audit-risk-sub', finding.rule === 'DEP-006' ? 'Known malicious: remove it and rotate what it could reach.' : tierPhrase(detail.usage));
      if (detail.usage) sub.title = tierSentence(detail.usage);
      main.append(name, sub);
      const places = placesOf.get(finding) || 1;
      if (places > 1) main.appendChild(element('span', 'audit-risk-places', `Declared in ${places} places; the finding below each one says where.`));
      const tags = element('span', 'audit-risk-tags');
      const kev = kevChip(finding, { short: true });
      if (kev) tags.appendChild(kev);
      if (intelOf(finding) && intelOf(finding).ransomware) tags.appendChild(chip('critical', 'Ransomware', { glyph: ICON.ransom }));
      const epss = epssChip(intelOf(finding));
      if (epss) tags.appendChild(epss);
      const tier = tierChip(detail.usage);
      if (tier) tags.appendChild(tier);
      control.append(score, main, tags, icon(ICON.arrow, 'audit-ico audit-risk-go'));
      item.appendChild(control);
      list.appendChild(item);
    });
    card.appendChild(list);
    if (!all) {
      const more = keyed(button('', 'btn btn-ghost audit-more', event => {
        expandedRisks.add(id);
        for (const row of list.querySelectorAll('.audit-risk-row[hidden]')) row.hidden = false;
        event.currentTarget.remove();
      }), 'risk-more');
      more.append(element('span', null, `Show all ${ranked.length}`), element('span', 'audit-more-of', `${RISK_FOLD} of ${ranked.length}`));
      card.appendChild(more);
    }
    const sources = intelSources(result);
    card.appendChild(element('p', 'audit-coverage audit-risk-note',
      `Risk is (40 × CVSS impact + 60 × threat) × reach, out of 100: threat is 1 for a vulnerability being exploited and otherwise EPSS on a log scale; reach is from the imports in the files read.${sources ? ` Sources: ${sources}.` : ''}`));
    host.appendChild(foldable(card, 'risk', head, 'Dependency risk'));
  }

  /* ---- The watch and the history ------------------------------------------- */

  const DAY_MS = 24 * 60 * 60 * 1000;
  /* A moment as a reader says it: "12 minutes ago", and in full for a title or a sentence. */
  function when(iso) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return { relative: 'at an unknown time', absolute: 'an unknown time', short: '—' };
    const seconds = Math.round((at - Date.now()) / 1000);
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    let relative = 'just now';
    if (Math.abs(seconds) >= 60) {
      const [unit, size] = units.find(([, span]) => Math.abs(seconds) >= span);
      try { relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(seconds / size), unit); }
      catch { relative = `${Math.abs(Math.round(seconds / size))} ${unit}s ago`; }
    }
    const date = new Date(at);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    const absolute = date.toLocaleString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' });
    const short = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return { relative, absolute, short };
  }
  function timeNode(iso, className, text) {
    const node = element('time', className, text || when(iso).relative);
    node.dateTime = iso;
    node.title = when(iso).absolute;
    return node;
  }
  function latestStored(view) {
    const history = view.history;
    return history && history.status === 'ready' && Array.isArray(history.audits) && history.audits.length ? history.audits[0] : null;
  }
  function countTally(counts) {
    const list = element('ul', 'audit-tally');
    const total = ORDER.reduce((sum, severity) => sum + (Number(counts[severity]) || 0), 0);
    list.setAttribute('aria-label', `${plural(total, 'finding', 'findings')}: ${ORDER.map(severity => `${Number(counts[severity]) || 0} ${severity}`).join(', ')}`);
    for (const severity of ORDER) {
      const count = Number(counts[severity]) || 0;
      const item = element('li', 'audit-tally-item');
      item.dataset.severity = severity;
      item.dataset.zero = count ? 'false' : 'true';
      item.appendChild(severityChip(severity, { count, large: true, zero: !count }));
      list.appendChild(item);
    }
    return list;
  }

  const WATCH_FOLD = 6;
  const expandedWatch = new Set();
  function watchSentence(alert) {
    if (alert.kind === 'exploited') {
      return `CISA added ${alert.cve} to its catalog of vulnerabilities exploited in the wild${alert.kevAdded ? ` on ${alert.kevAdded}` : ''}${alert.kevDue ? `; US federal agencies must fix it by ${alert.kevDue}` : ''}. The audit reported it before it was listed.`;
    }
    const where = alert.dev ? ' It is a development dependency.' : alert.direct ? '' : ' It comes in through another package.';
    const fix = alert.malicious ? ' Known malicious: remove it and rotate what it could reach.' : alert.fixed ? ` Fixed in ${alert.fixed}.` : ' No fixed version is published yet.';
    return `Published after the audit${alert.cve ? `, as ${alert.cve}` : ''}.${fix}${where}`;
  }
  function watchRow(alert) {
    const item = element('li', 'audit-watch-row');
    item.dataset.kind = alert.kind;
    const glyph = element('span', 'audit-watch-glyph');
    glyph.dataset.tone = alert.exploited ? 'critical' : alert.severity || 'pending';
    glyph.appendChild(icon(alert.kind === 'exploited' ? ICON.flame : ICON.news));
    const main = element('div', 'audit-watch-main');
    const name = element('p', 'audit-risk-pkg');
    name.append(element('span', 'audit-risk-name', alert.name), element('span', 'audit-risk-ver', alert.version));
    if (alert.fixed && !alert.malicious) name.append(icon(ICON.arrow, 'audit-ico audit-risk-arrow'), element('span', 'audit-risk-fix', alert.fixed));
    const sub = element('p', 'audit-watch-sub', watchSentence(alert));
    const refs = element('p', 'audit-watch-refs');
    if (alert.id) refs.appendChild(osvLink(alert.id));
    if (alert.cve && (alert.kind === 'exploited' || alert.exploited)) {
      const kev = element('a', 'audit-adv-id', 'CISA KEV');
      kev.href = `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(alert.cve)}`;
      kev.target = '_blank';
      kev.rel = 'noopener noreferrer';
      kev.append(icon(ICON.link, 'audit-ico audit-adv-out'));
      refs.appendChild(kev);
    }
    main.append(name, sub);
    if (refs.childNodes.length) main.appendChild(refs);
    const tags = element('div', 'audit-risk-tags');
    tags.appendChild(chip(alert.kind === 'exploited' ? 'critical' : 'info', alert.kind === 'exploited' ? 'Newly exploited' : 'New advisory',
      { glyph: alert.kind === 'exploited' ? ICON.flame : ICON.news, beam: alert.exploited && !alert.dev, className: 'audit-watch-kind' }));
    if (alert.severity && SEVERITY[alert.severity]) tags.appendChild(severityChip(alert.severity));
    if (alert.kind === 'advisory' && alert.exploited) tags.appendChild(chip('critical', 'Exploited', { glyph: ICON.flame, className: 'audit-kev' }));
    if (alert.ransomware) tags.appendChild(chip('critical', 'Ransomware', { glyph: ICON.ransom }));
    if (Number.isFinite(alert.epss)) tags.appendChild(epssChip({ epss: { score: alert.epss, cve: alert.cve } }));
    if (alert.dev) tags.appendChild(chip('neutral', 'Dev only', { glyph: REACH_TIER.dev.icon }));
    item.append(glyph, main, tags);
    return item;
  }
  function renderWatch(host, view, handlers) {
    const watch = view.watch;
    if (!watch || !['checking', 'ready', 'error'].includes(watch.status)) return;
    const data = watch.data || {};
    const audit = data.audit || latestStored(view);
    if (!audit) return;
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    const card = element('section', 'card audit-watch');
    card.setAttribute('aria-labelledby', 'auditWatchHeading');
    if (alerts.length) card.dataset.alerts = 'true';
    const head = element('div', 'audit-card-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'Since the last audit');
    heading.id = 'auditWatchHeading';
    titles.append(heading, element('p', 'audit-card-lede',
      `What has been published since the last audit of ${audit.ref}: new advisories for the package versions it found, and CVEs CISA has since listed as exploited. OSV and CISA are asked every six hours, by package name and version only.`));
    head.appendChild(titles);
    card.appendChild(head);

    const state = element('p', 'audit-watch-state');
    state.setAttribute('role', 'status');
    const components = Number(data.components) || audit.components || 0;
    const since = `since the audit of ${when(audit.auditedAt).absolute}`;
    if (watch.status === 'checking') {
      state.dataset.state = 'checking';
      state.append(element('span', 'audit-watch-pulse'), element('span', null, `Asking OSV and CISA about ${plural(components, 'package version', 'package versions')} of ${audit.ref}…`));
    } else if (watch.status === 'error') {
      state.dataset.state = 'error';
      state.appendChild(element('span', null, watch.error || 'The watch could not be checked. Nothing is marked new, and nothing is marked clear.'));
    } else {
      const checked = audit.watch || null;
      state.dataset.state = !checked ? 'pending' : alerts.length ? 'alerts' : checked.state;
      state.appendChild(icon(alerts.length ? ICON.news : checked && checked.state === 'ok' ? ICON.check : ICON.unknown, 'audit-ico audit-watch-state-ico'));
      const words = [];
      if (!checked) words.push(`Not checked yet ${since}.`);
      else if (alerts.length) words.push(`${plural(alerts.length, 'new item', 'new items')} for ${plural(components, 'package version', 'package versions')} ${since}.`);
      else if (checked.state === 'unavailable') words.push('OSV could not be reached. Nothing is marked new, and nothing is marked clear.');
      else words.push(`Nothing new for ${plural(components, 'package version', 'package versions')} ${since}.`);
      if (checked) {
        const sources = checked.kev === 'ok' ? 'OSV and CISA’s exploited catalog' : checked.kev === 'unavailable' ? 'OSV (CISA’s catalog could not be read)' : 'OSV';
        words.push(Date.parse(checked.checkedAt) <= Date.parse(audit.auditedAt) + 60000 ? `Last asked by the audit itself, ${when(checked.checkedAt).relative}.` : `Last asked of ${sources} ${when(checked.checkedAt).relative}.`);
        if (checked.state === 'partial' && Number.isFinite(checked.checked) && Number.isFinite(checked.total)) words.push(`${checked.checked} of ${checked.total} answered; the rest are asked again next time.`);
      }
      state.appendChild(element('span', null, words.join(' ')));
    }
    card.appendChild(state);

    if (alerts.length && watch.status !== 'checking') {
      const all = expandedWatch.has(audit.id) || alerts.length <= WATCH_FOLD + 1;
      const list = element('ol', 'audit-watch-list');
      list.setAttribute('aria-label', 'Published since the last audit');
      alerts.forEach((alert, index) => {
        const row = watchRow(alert);
        if (!all && index >= WATCH_FOLD) row.hidden = true;
        list.appendChild(row);
      });
      card.appendChild(list);
      if (!all) {
        const more = keyed(button('', 'btn btn-ghost audit-more', event => {
          expandedWatch.add(audit.id);
          for (const row of list.querySelectorAll('.audit-watch-row[hidden]')) row.hidden = false;
          event.currentTarget.remove();
        }), 'watch-more');
        more.append(element('span', null, `Show all ${alerts.length}`), element('span', 'audit-more-of', `${WATCH_FOLD} of ${alerts.length}`));
        card.appendChild(more);
      }
    }
    const actions = element('div', 'audit-watch-actions');
    const tooSoon = data.checkableAt && Date.parse(data.checkableAt) > Date.now();
    const check = keyed(iconButton(ICON.search, watch.status === 'checking' ? 'Checking…' : 'Check now', 'Check for new advisories now', 'btn btn-ghost audit-tool', handlers.onWatchCheck), 'watch-check');
    check.disabled = watch.status === 'checking' || Boolean(tooSoon);
    if (tooSoon) check.title = `Asked ${when(audit.watch && audit.watch.checkedAt).relative}; it can be asked again ${when(data.checkableAt).relative}.`;
    actions.appendChild(check);
    if (alerts.length && view.status !== 'running' && handlers.onRun) {
      const again = keyed(iconButton(ICON.run, 'Audit again', 'Audit again to rank these by reach and risk', 'btn btn-ghost audit-tool', handlers.onRun), 'watch-run');
      actions.appendChild(again);
    }
    card.appendChild(actions);
    host.appendChild(foldable(card, 'watch', head, 'Since the last audit'));
  }

  /*
   * The score over time: one series, so no legend -- the heading names it.
   * The line is drawn in a stretched SVG with a stroke that does not stretch;
   * the points are buttons laid over it, so each has a name, a focus ring and
   * a hit area larger than the mark, and says its audit in a tooltip. The
   * list below is the table view.
   */
  function trendChart(audits, handlers) {
    const series = audits.slice(0, 30).reverse();
    const scores = series.map(audit => Number(audit.score) || 0);
    const floor = Math.max(0, Math.min(50, Math.floor((Math.min(...scores) - 8) / 10) * 10));
    const y = score => 100 - ((score - floor) / (100 - floor)) * 100;
    const x = index => (series.length === 1 ? 50 : (index / (series.length - 1)) * 100);
    const figure = element('figure', 'audit-trend');
    const plot = element('div', 'audit-trend-plot');
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'audit-trend-svg');
    const axis = element('div', 'audit-trend-axis');
    axis.setAttribute('aria-hidden', 'true');
    for (const [grade, threshold] of [['A', 90], ['B', 80], ['C', 70], ['D', 60]]) {
      if (threshold <= floor) continue;
      const line = document.createElementNS(SVG, 'line');
      line.setAttribute('x1', '0');
      line.setAttribute('x2', '100');
      line.setAttribute('y1', String(y(threshold)));
      line.setAttribute('y2', String(y(threshold)));
      line.setAttribute('class', 'audit-trend-grid');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(line);
      const tick = element('span', 'audit-trend-tick', grade);
      tick.style.top = `${y(threshold)}%`;
      tick.title = `${grade}: ${threshold} and above`;
      axis.appendChild(tick);
    }
    if (series.length > 1) {
      const path = document.createElementNS(SVG, 'polyline');
      path.setAttribute('points', series.map((audit, index) => `${x(index)},${y(scores[index])}`).join(' '));
      path.setAttribute('class', 'audit-trend-line');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(path);
    }
    plot.appendChild(svg);
    const tip = element('div', 'audit-trend-tip');
    tip.setAttribute('aria-hidden', 'true');
    tip.hidden = true;
    const describe = audit => {
      const change = audit.diff ? ` · ${audit.diff.new} new, ${audit.diff.resolved} resolved` : '';
      return `${when(audit.auditedAt).absolute} · Grade ${audit.grade}, ${audit.score} · ${String(audit.commitSha).slice(0, 7)}${change}`;
    };
    series.forEach((audit, index) => {
      const dot = keyed(button('', 'audit-trend-dot', () => handlers.onHistoryOpen && handlers.onHistoryOpen(audit.id, { reveal: true })), `trend:${audit.id}`);
      dot.style.left = `${x(index)}%`;
      dot.style.top = `${y(scores[index])}%`;
      dot.dataset.grade = audit.grade;
      if (index === series.length - 1) dot.dataset.latest = 'true';
      dot.setAttribute('aria-label', `${describe(audit)}. Open this audit`);
      const show = () => {
        tip.textContent = describe(audit);
        tip.hidden = false;
        tip.style.top = `${y(scores[index])}%`;
        tip.dataset.side = x(index) > 66 ? 'end' : x(index) < 34 ? 'start' : 'middle';
        tip.style.left = `${x(index)}%`;
      };
      const hide = () => { tip.hidden = true; };
      dot.addEventListener('mouseenter', show);
      dot.addEventListener('focus', show);
      dot.addEventListener('mouseleave', hide);
      dot.addEventListener('blur', hide);
      plot.appendChild(dot);
    });
    plot.appendChild(tip);
    figure.append(axis, plot);
    const first = series[0];
    const last = series[series.length - 1];
    const caption = element('figcaption', 'audit-trend-caption', series.length > 1
      ? `Score over the last ${series.length} audits, from ${first.score} (${first.grade}) on ${when(first.auditedAt).short} to ${last.score} (${last.grade}) on ${when(last.auditedAt).short}.`
      : 'The trend appears after the next audit of this branch.');
    figure.appendChild(caption);
    return figure;
  }

  const HISTORY_FINDINGS = 40;
  const expandedHistory = new Set();
  function historyFindings(detail, audit) {
    const wrap = element('div', 'audit-hist-body');
    if (!detail || detail.status === 'loading') {
      const wait = element('p', 'audit-hist-wait', 'Reading what this audit kept…');
      wait.setAttribute('role', 'status');
      wrap.appendChild(wait);
      return wrap;
    }
    if (detail.status === 'error') {
      const error = element('p', 'audit-hist-wait audit-error', detail.error || 'This audit could not be read.');
      error.setAttribute('role', 'alert');
      wrap.appendChild(error);
      return wrap;
    }
    /* Waived rows are kept for their clocks; the list is what the audit found open. */
    const findings = (detail.findings || []).filter(finding => !finding.waived);
    const waivedCount = (detail.findings || []).length - findings.length;
    if (!findings.length) {
      wrap.appendChild(element('p', 'audit-hist-wait', waivedCount
        ? `Nothing open: ${plural(waivedCount, 'finding was', 'findings were')} waived in code or triaged by the team.`
        : 'This audit found nothing in what it read.'));
      return wrap;
    }
    const all = expandedHistory.has(audit.id) || findings.length <= HISTORY_FINDINGS + 1;
    const list = element('ul', 'audit-hist-findings');
    list.setAttribute('aria-label', `What the audit of ${when(audit.auditedAt).absolute} found`);
    findings.forEach((finding, index) => {
      const item = element('li', 'audit-hist-finding');
      if (!all && index >= HISTORY_FINDINGS) item.hidden = true;
      const title = element('span', 'audit-hist-title', finding.title);
      const where = finding.package
        ? `${finding.package.name} ${finding.package.version}${finding.package.fixed ? ` → ${finding.package.fixed}` : ''}`
        : finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''}` : '';
      const place = element('span', 'audit-hist-where', where);
      if (finding.package && finding.package.advisories.length) place.title = finding.package.advisories.join(', ');
      const severity = element('span', 'audit-hist-sev');
      severity.appendChild(severityChip(finding.severity));
      const main = element('span', 'audit-hist-text');
      main.append(title, place);
      const tags = element('span', 'audit-hist-tags');
      if (finding.verdict === 'needs-validation') tags.appendChild(chip(VERDICT['needs-validation'].tone, 'To confirm', { glyph: VERDICT['needs-validation'].icon }));
      if (finding.exploited) tags.appendChild(chip('critical', 'Exploited', { glyph: ICON.flame, className: 'audit-kev' }));
      if (finding.risk && RISK_BAND[finding.risk.band]) tags.appendChild(chip(RISK_BAND[finding.risk.band].tone, `Risk ${finding.risk.score}`, { className: 'audit-hist-risk' }));
      item.append(severity, main, tags);
      list.appendChild(item);
    });
    wrap.appendChild(list);
    if (!all) {
      const more = keyed(button('', 'btn btn-ghost audit-more', event => {
        expandedHistory.add(audit.id);
        for (const row of list.querySelectorAll('.audit-hist-finding[hidden]')) row.hidden = false;
        event.currentTarget.remove();
      }), `hist-more:${audit.id}`);
      more.append(element('span', null, `Show all ${findings.length}`), element('span', 'audit-more-of', `${HISTORY_FINDINGS} of ${findings.length}`));
      wrap.appendChild(more);
    }
    if (audit.findings && audit.findings.stored < audit.findings.total) {
      wrap.appendChild(element('p', 'audit-coverage', `${audit.findings.stored} of ${audit.findings.total} findings were kept, the most severe first.`));
    }
    if (waivedCount) wrap.appendChild(element('p', 'audit-coverage', `${plural(waivedCount, 'more was', 'more were')} waived in code or triaged by the team.`));
    return wrap;
  }
  function renderHistory(host, view, handlers) {
    const history = view.history;
    if (!history || history.status !== 'ready' || !Array.isArray(history.audits) || !history.audits.length) return;
    const audits = history.audits;
    const ref = audits[0].ref;
    const card = element('section', 'card audit-history');
    card.setAttribute('aria-labelledby', 'auditHistoryHeading');
    const head = element('div', 'audit-card-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'History');
    heading.id = 'auditHistoryHeading';
    titles.append(heading, element('p', 'audit-card-lede',
      `Every audit of ${ref} you ran, newest first. Each keeps its grade, its counts and every finding’s rule, place and package — never any of the code.`));
    head.appendChild(titles);
    card.appendChild(head);
    card.appendChild(trendChart(audits, handlers));

    const shownId = view.result && view.result.history && view.result.history.auditId;
    const open = view.historyOpen instanceof Set ? view.historyOpen : new Set();
    const list = element('ol', 'audit-hist-list');
    list.setAttribute('aria-label', `Audits of ${ref}`);
    audits.forEach((audit, index) => {
      const item = element('li', 'audit-hist-row');
      const details = element('details', 'audit-hist');
      details.dataset.auditId = audit.id;
      details.open = open.has(audit.id);
      const summary = element('summary', 'audit-hist-sum');
      const grade = element('span', 'audit-hist-grade', audit.grade);
      grade.dataset.grade = audit.grade;
      const score = element('span', 'audit-hist-score', String(audit.score));
      const main = element('span', 'audit-hist-main');
      const top = element('span', 'audit-hist-top');
      top.appendChild(timeNode(audit.auditedAt, 'audit-hist-when', when(audit.auditedAt).absolute));
      if (index === 0) top.appendChild(element('span', 'audit-hist-tag', 'Latest'));
      if (shownId && shownId === audit.id) top.appendChild(element('span', 'audit-hist-tag', 'Shown above'));
      const counts = ORDER.filter(severity => audit.counts[severity]).map(severity => `${audit.counts[severity]} ${severity}`);
      const sub = element('span', 'audit-hist-sub', [String(audit.commitSha).slice(0, 7), counts.length ? counts.join(' · ') : 'nothing found'].join(' · '));
      main.append(top, sub);
      const tags = element('span', 'audit-hist-tags');
      if (audit.diff) {
        if (audit.diff.new) tags.appendChild(chip('info', 'new', { count: audit.diff.new, glyph: ICON.news, className: 'audit-hist-new' }));
        if (audit.diff.resolved) tags.appendChild(chip('good', 'resolved', { count: audit.diff.resolved, glyph: ICON.check, className: 'audit-hist-resolved' }));
        if (!audit.diff.new && !audit.diff.resolved) tags.appendChild(chip('neutral', 'No change', { className: 'audit-hist-same' }));
      }
      if (audit.exploited) tags.appendChild(chip('critical', 'exploited', { count: audit.exploited, glyph: ICON.flame }));
      summary.append(grade, score, main, tags, icon(ICON.chevron, 'audit-ico audit-hist-chev'));
      summary.setAttribute('aria-label', `Audit of ${when(audit.auditedAt).absolute} at ${String(audit.commitSha).slice(0, 7)}: grade ${audit.grade}, ${audit.score} out of 100${audit.diff ? `, ${audit.diff.new} new, ${audit.diff.resolved} resolved` : ''}`);
      details.appendChild(summary);
      details.addEventListener('toggle', () => { if (handlers.onHistoryToggle) handlers.onHistoryToggle(audit.id, details.open); });
      if (details.open) details.appendChild(historyFindings(view.historyDetail && view.historyDetail.get(audit.id), audit));
      item.appendChild(details);
      list.appendChild(item);
    });
    card.appendChild(list);

    const others = (history.branches || []).filter(branch => branch.ref !== ref);
    const foot = element('div', 'audit-hist-foot');
    if (others.length) {
      foot.appendChild(element('p', 'audit-coverage', `Also audited: ${others.map(branch => `${branch.ref} (${plural(branch.audits, 'audit', 'audits')})`).join(', ')}. Open a branch to see its history.`));
    }
    foot.appendChild(element('p', 'audit-coverage', 'Kept for your account only: the 30 latest audits of each branch, for up to 400 days, and removed with your account.'));
    const armed = view.historyArmed === true;
    const clear = keyed(iconButton(ICON.trash, armed ? 'Press again to clear' : 'Clear history',
      armed ? 'Press again to delete every kept audit of this repository, on every branch' : 'Clear the kept audits of this repository',
      `btn btn-ghost audit-tool audit-hist-clear${armed ? ' is-armed' : ''}`, handlers.onHistoryClear), 'history-clear');
    clear.disabled = history.clearing === true;
    foot.appendChild(clear);
    card.appendChild(foot);
    host.appendChild(foldable(card, 'history', head, 'History'));
  }

  /* ---- Remediation ---------------------------------------------------------- */

  /*
   * How long a branch gives itself to fix what it finds, where it stands
   * against that, and how long fixing has taken: the clock per severity from
   * the branch's policy, the open findings past or near their deadline, and
   * the time from first seen to gone for every finding the kept audits saw
   * fixed in the last ninety days. Read from the kept history, so it exists
   * only where the history does.
   */
  function fixDays(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const number = Number(value);
    if (number < 1) return number < 1 / 24 ? 'under an hour' : `${Math.max(1, Math.round(number * 24))} h`;
    return `${number >= 10 ? Math.round(number) : number.toFixed(1).replace(/\.0$/, '')} d`;
  }
  function remediationTile(label, value, sub, tone) {
    const tile = element('li', 'audit-rem-tile');
    if (tone) tile.dataset.tone = tone;
    tile.append(element('span', 'audit-rem-label', label), element('strong', 'audit-rem-value', value));
    if (sub) tile.appendChild(element('span', 'audit-rem-sub', sub));
    return tile;
  }
  function renderRemediation(host, view, handlers) {
    const metrics = view.metrics;
    if (!metrics || metrics.status === 'idle' || metrics.status === 'unavailable') return;
    const history = view.history;
    if (!history || history.status !== 'ready' || !Array.isArray(history.audits) || !history.audits.length) return;
    const card = element('section', 'card audit-remediation');
    card.setAttribute('aria-labelledby', 'auditRemediationHeading');
    const head = element('div', 'audit-card-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'Remediation');
    heading.id = 'auditRemediationHeading';
    const ref = history.audits[0].ref;
    titles.append(heading, element('p', 'audit-card-lede',
      `How long ${ref} gives itself to fix what an audit finds, where its open findings stand against that, and how long fixing has taken.`));
    head.appendChild(titles);
    card.appendChild(head);
    if (metrics.status === 'loading' && !metrics.data) {
      const wait = element('p', 'audit-hist-wait', 'Reading the clocks…');
      wait.setAttribute('role', 'status');
      card.appendChild(wait);
      host.appendChild(foldable(card, 'remediation', head, 'Remediation'));
      return;
    }
    if (metrics.status === 'error') {
      const error = element('p', 'audit-hist-wait audit-error', metrics.error || 'The clocks could not be read.');
      error.setAttribute('role', 'alert');
      card.appendChild(error);
      host.appendChild(foldable(card, 'remediation', head, 'Remediation'));
      return;
    }
    const data = metrics.data || {};
    const open = data.open || null;
    const mttr = data.mttr || {};
    const sla = data.sla || null;
    const tiles = element('ul', 'audit-rem-tiles');
    tiles.setAttribute('aria-label', 'Open findings against their deadlines, and time to fix');
    if (open) {
      tiles.append(
        remediationTile('Overdue', String(open.overdue), open.overdue ? 'past their deadline' : 'none past due', open.overdue ? 'critical' : 'good'),
        remediationTile('Due soon', String(open.dueSoon), 'in the last stretch', open.dueSoon ? 'warning' : null),
        remediationTile('On track', String(open.onTrack), `of ${plural(open.total, 'open finding', 'open findings')}`, null)
      );
    }
    const all = mttr.all || { count: 0 };
    tiles.appendChild(remediationTile('Median time to fix', all.count ? fixDays(all.medianDays) : '—',
      all.count ? `${plural(all.count, 'finding', 'findings')} fixed in ${mttr.windowDays || 90} days` : `nothing fixed in ${mttr.windowDays || 90} days`, null));
    card.appendChild(tiles);

    const table = element('table', 'audit-rem-table');
    const caption = element('caption', 'sr-only', 'Clock, open findings and time to fix, by severity');
    table.appendChild(caption);
    const thead = element('thead');
    const headRow = element('tr');
    for (const name of ['Severity', 'Clock', 'Open', 'Overdue', 'Median fix', 'Fixed']) headRow.appendChild(element('th', null, name));
    for (const cell of headRow.children) cell.scope = 'col';
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = element('tbody');
    for (const severity of ORDER) {
      const row = element('tr');
      row.dataset.severity = severity;
      const name = element('th', 'audit-rem-sev');
      name.scope = 'row';
      name.appendChild(severityChip(severity));
      const counts = open && open.bySeverity ? open.bySeverity[severity] : null;
      const fix = mttr[severity] || { count: 0 };
      const cells = [
        ['Clock', sla ? dayWord(sla[severity]) : '—'],
        ['Open', counts ? String(counts.open) : '—'],
        ['Overdue', counts ? String(counts.overdue) : '—'],
        ['Median fix', fix.count ? fixDays(fix.medianDays) : '—'],
        ['Fixed', String(fix.count || 0)]
      ];
      row.appendChild(name);
      for (const [label, value] of cells) {
        const cell = element('td', null, value);
        cell.dataset.label = label;
        if (label === 'Overdue' && counts && counts.overdue) cell.dataset.alert = 'true';
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    card.appendChild(table);

    const notes = element('div', 'audit-rem-notes');
    if (sla) {
      const policy = view.result && view.result.policy;
      const source = sla.source === 'repository' ? 'set in .nebulaverse/audit.json on this branch'
        : sla.source === 'invalid' ? 'the defaults: .nebulaverse/audit.json could not be read'
          : 'the defaults; set your own in .nebulaverse/audit.json';
      notes.appendChild(element('p', 'audit-coverage', `Clock: ${dayWord(sla.critical)} for critical, ${dayWord(sla.serious)} for serious, ${dayWord(sla.warning)} for warnings — ${source}. A vulnerability exploited in the wild runs on the critical clock.`));
      if (policy && Array.isArray(policy.problems)) for (const problem of policy.problems) notes.appendChild(element('p', 'exposure-caveat', problem));
    }
    if (data.oldest && open && open.total) {
      notes.appendChild(element('p', 'audit-coverage', `Oldest open finding: ${dayWord(data.oldest.days)} since it was first seen (${data.oldest.rule}, ${data.oldest.severity}).`));
    }
    if (data.triage) {
      const t = data.triage;
      const parts = [];
      if (t.falsePositive) parts.push(plural(t.falsePositive, 'false positive', 'false positives'));
      if (t.acceptedRisk) parts.push(`${plural(t.acceptedRisk, 'risk accepted', 'risks accepted')}${t.expiringSoon ? `, ${t.expiringSoon} lapsing within two weeks` : ''}`);
      if (t.lapsed) parts.push(`${plural(t.lapsed, 'acceptance', 'acceptances')} lapsed`);
      notes.appendChild(element('p', 'audit-coverage', parts.length ? `Team decisions on this repository: ${parts.join(' · ')}.` : 'No team decisions on this repository yet.'));
    } else if (data.triageUnavailable) {
      notes.appendChild(element('p', 'exposure-caveat', 'The team’s decisions could not be read, so findings they cover are counted as open.'));
    }
    notes.appendChild(element('p', 'audit-coverage', 'Time to fix counts a finding as fixed when the next audit of the branch, by the same engine and reading every file, no longer finds it.'));
    card.appendChild(notes);
    host.appendChild(foldable(card, 'remediation', head, 'Remediation'));
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
      /* A family weighed at nothing -- licences -- is reported, not scored. */
      const graded = category.weight !== 0;
      if (graded) score.append(document.createTextNode(String(category.score)), element('span', 'audit-category-of', '/100'));
      else { score.classList.add('audit-category-ungraded'); score.textContent = 'Not graded'; }
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
      control.append(top, score, counts);
      if (graded) control.appendChild(meter);
      item.appendChild(control);
      list.appendChild(item);
    }
    const families = element('section', 'audit-families');
    families.setAttribute('aria-labelledby', 'auditFamiliesHeading');
    const head = element('div', 'audit-card-head audit-families-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'Families');
    heading.id = 'auditFamiliesHeading';
    titles.append(heading, element('p', 'audit-card-lede', result.categories.some(category => category.weight === 0)
      ? 'Each scored on its own out of 100; licences are reported but not graded. Choose one to narrow the findings to it.'
      : 'Each scored on its own out of 100. Choose one to narrow the findings to it.'));
    head.appendChild(titles);
    families.append(head, list);
    host.appendChild(foldable(families, 'families', head, 'Families'));
  }

  /* ---- Licences ------------------------------------------------------------- */

  /*
   * What each dependency may be used under, in the order of how much it asks,
   * with the tone a reader should give it. Public domain and permissive are
   * the quiet majority; a package that grants no licence is the loudest.
   */
  const LICENCE_FAMILY = Object.freeze({
    'public-domain': Object.freeze({ word: 'Public domain', tone: 'good' }),
    permissive: Object.freeze({ word: 'Permissive', tone: 'good' }),
    'weak-copyleft': Object.freeze({ word: 'Weak copyleft', tone: 'neutral' }),
    'strong-copyleft': Object.freeze({ word: 'Strong copyleft', tone: 'warning' }),
    'network-copyleft': Object.freeze({ word: 'Network copyleft', tone: 'serious' }),
    restricted: Object.freeze({ word: 'Restricted use', tone: 'serious' }),
    none: Object.freeze({ word: 'No licence', tone: 'critical' }),
    unknown: Object.freeze({ word: 'Unknown', tone: 'pending' })
  });
  const LICENCE_ORDER = Object.freeze(['none', 'restricted', 'network-copyleft', 'strong-copyleft', 'weak-copyleft', 'unknown', 'permissive', 'public-domain']);
  const LICENCE_FOLD = 8;
  const expandedLicences = new Set();

  /* A licence finding's facts, in the words the finding body and the brief share. */
  function licenceFactList(detail) {
    const family = LICENCE_FAMILY[detail.family] || LICENCE_FAMILY.unknown;
    const facts = [
      ['Licence', `${detail.licence || 'none stated'} (${family.word.toLowerCase()})`],
      ['Package', `${detail.package} ${detail.version}, ${detail.dev ? 'installed for development only' : detail.direct ? 'asked for by the project' : 'a transitive dependency'}`],
      ['Read from', detail.source === 'lockfile' ? 'the lockfile' : 'deps.dev']
    ];
    if (detail.project) facts.push(['Project licence', detail.project]);
    if (detail.policy) facts.push(['Policy', `${detail.reason === 'denied' ? 'refused by' : 'not allowed by'} ${detail.policy}`]);
    return facts;
  }
  function licenceFacts(detail) {
    const list = element('dl', 'audit-licence-basis audit-licence-facts');
    for (const [term, value] of licenceFactList(detail)) {
      const row = element('div', 'audit-licence-fact');
      row.append(element('dt', null, term), element('dd', null, value));
      list.appendChild(row);
    }
    return list;
  }

  /* The licence finding a listed package carries, if it has one, so its row can lead to it. */
  function licenceFinding(result, item) {
    return (result.findings || []).find(finding => finding.category === 'licences' && finding.detail &&
      finding.detail.package === item.package && finding.detail.version === item.version && finding.detail.ecosystem === item.ecosystem) || null;
  }

  function renderLicences(host, view, handlers, root) {
    const result = view.result;
    const summary = result && result.licences;
    if (!summary || !summary.status || !summary.status.versions || view.filter || view.owasp) return;
    const card = element('section', 'card audit-licences');
    card.setAttribute('aria-labelledby', 'auditLicencesHeading');
    const head = element('div', 'audit-card-head');
    const titles = element('div', 'audit-card-titles');
    const heading = element('h2', 'audit-kicker', 'Licences');
    heading.id = 'auditLicencesHeading';
    const policy = summary.policy && !summary.policy.invalid ? summary.policy : null;
    const project = summary.project;
    const against = policy ? `the policy in ${policy.path}`
      : project && project.expression ? `the project\u2019s own ${project.expression}` : 'use in proprietary code';
    titles.append(heading, element('p', 'audit-card-lede', `What each dependency may be used under, judged against ${against}. Reported, not graded.`));
    head.appendChild(titles);
    card.appendChild(head);

    const stats = element('div', 'audit-surface-stats audit-licence-stats');
    stats.setAttribute('role', 'list');
    for (const family of LICENCE_ORDER) {
      const count = summary.families[family] || 0;
      if (!count) continue;
      const entry = LICENCE_FAMILY[family];
      const node = chip(entry.tone, entry.word.toLowerCase(), { count, large: true, className: 'audit-licence-stat' });
      node.dataset.family = family;
      node.setAttribute('role', 'listitem');
      stats.appendChild(node);
    }
    card.appendChild(stats);

    /* What the dependencies were judged against, and how to change it. */
    const basis = element('dl', 'audit-licence-basis');
    const fact = (term, text, note) => {
      const row = element('div', 'audit-licence-fact');
      const value = element('dd', null, text);
      if (note) value.appendChild(element('span', 'audit-licence-note', note));
      row.append(element('dt', null, term), value);
      basis.appendChild(row);
    };
    if (project && project.expression) fact('Project', project.expression, project.source ? ` from ${project.source}` : '');
    else if (project && project.unread) fact('Project', 'Not recognised', ` ${project.source} names no licence this audit knows; judged as proprietary code.`);
    else fact('Project', 'None found', ' No licence file or manifest licence; judged as proprietary code, all rights reserved.');
    if (policy) {
      const parts = [];
      if (policy.allow !== null) parts.push(`${policy.allow} allowed`);
      if (policy.deny) parts.push(`${policy.deny} refused`);
      if (policy.cleared) parts.push(plural(policy.cleared, 'package cleared', 'packages cleared'));
      fact('Policy', policy.path, parts.length ? ` — ${parts.join(', ')}` : '');
    } else if (summary.policy && summary.policy.invalid) {
      fact('Policy', summary.policy.path, ' could not be read, so the default rules applied.');
    } else {
      fact('Policy', 'Default rules', ' Add .nebulaverse/licences.json to allow or refuse licences and clear packages by name.');
    }
    card.appendChild(basis);

    const listed = Array.isArray(summary.packages) ? summary.packages : [];
    if (listed.length) {
      const id = resultId(result);
      const all = expandedLicences.has(id) || listed.length <= LICENCE_FOLD + 1;
      const list = element('ul', 'audit-licence-list');
      list.setAttribute('aria-label', 'Dependencies that are not permissively licensed');
      listed.forEach((item, index) => {
        const row = element('li', 'audit-licence-row');
        row.dataset.family = item.family;
        if (!all && index >= LICENCE_FOLD) row.hidden = true;
        const entry = LICENCE_FAMILY[item.family] || LICENCE_FAMILY.unknown;
        const finding = licenceFinding(result, item);
        const control = finding ? button('', 'audit-licence-btn', () => revealFinding(root, handlers, finding.id)) : element('div', 'audit-licence-btn');
        const main = element('span', 'audit-licence-main');
        const name = element('span', 'audit-licence-pkg');
        name.append(element('span', 'audit-licence-name', item.package), element('span', 'audit-licence-ver', item.version));
        const expression = element('span', 'audit-licence-expr', item.licence || 'No licence stated');
        if (item.licence) expression.title = item.licence;
        main.append(name, expression);
        const tags = element('span', 'audit-licence-tags');
        tags.appendChild(chip(entry.tone, entry.word, { className: 'audit-licence-family' }));
        if (item.dev) tags.appendChild(chip('neutral', 'Development', { title: 'Installed for development only; it does not ship' }));
        else if (!item.direct) tags.appendChild(chip('neutral', 'Transitive', { title: 'Came with another dependency' }));
        control.append(main, tags);
        if (finding) {
          control.setAttribute('aria-label', `${item.package} ${item.version}: ${item.licence || 'no licence stated'}, ${entry.word}. Show the finding.`);
          control.appendChild(icon(ICON.arrow, 'audit-ico audit-licence-go'));
        }
        row.appendChild(control);
        list.appendChild(row);
      });
      card.appendChild(list);
      if (!all) {
        const more = keyed(button('', 'btn btn-ghost audit-more', event => {
          expandedLicences.add(id);
          for (const row of list.querySelectorAll('.audit-licence-row[hidden]')) row.hidden = false;
          event.currentTarget.remove();
        }), 'licences-more');
        more.append(element('span', null, `Show all ${listed.length}`), element('span', 'audit-more-of', `${LICENCE_FOLD} of ${listed.length}`));
        card.appendChild(more);
      }
    }
    const counted = summary.status;
    const open = counted.unknown + counted.notAsked;
    card.appendChild(element('p', 'audit-coverage audit-licence-foot',
      `${counted.known} of ${plural(counted.versions, 'package version', 'package versions')} read: ${counted.fromLock} from lockfiles, ${counted.fromRegistry} from deps.dev${open ? `; ${open} could not be read` : ''}. ` +
      'Only the package names and versions were asked about. Not legal advice: a lawyer decides what a licence allows.'));
    host.appendChild(foldable(card, 'licences', head, 'Licences'));
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
    serverless: 'Serverless', flask: 'Flask', fastapi: 'FastAPI', django: 'Django',
    'go-http': 'net/http', gin: 'Gin', echo: 'Echo', fiber: 'Fiber', chi: 'chi', gorilla: 'gorilla/mux',
    spring: 'Spring', jaxrs: 'JAX-RS', laravel: 'Laravel', symfony: 'Symfony'
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
        /* 'POST,PUT,DELETE' reads as one verb a line inside the pill */
        const method = element('span', 'audit-route-method', entry.action ? 'ACTION' : String(entry.method || 'ANY').split(',').join(' '));
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
    const intel = intelOf(finding);
    const risk = riskOf(finding);
    const advisories = finding.detail && Array.isArray(finding.detail.advisories) ? finding.detail.advisories.flatMap(advisory => [advisory.id, advisory.cve]) : [];
    return [finding.title, finding.rule, finding.where || location(finding), families && families.get(finding.category),
      standards.cwe, standards.cweName, standards.owasp, standards.owaspName, detailChip(finding), SEVERITY[finding.severity].word,
      VERDICT[verdictOf(finding)].word, reach && reach.word, finding.reach && finding.reach.route, ...advisories,
      intel && intel.exploited && 'exploited kev known exploited', intel && intel.ransomware && 'ransomware', intel && intel.epss && 'epss',
      risk && `risk ${RISK_BAND[risk.band].word}`, usageOf(finding) && tierWord(usageOf(finding))]
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
      if (Number.isFinite(advisory.cvss)) ids.appendChild(element('span', 'audit-adv-mark', `CVSS ${advisory.cvss.toFixed(1)}`));
      if (advisory.kev) {
        const kev = element('span', 'audit-adv-mark audit-adv-kev', 'KEV');
        kev.title = 'Listed by CISA as exploited in the wild';
        ids.appendChild(kev);
      }
      if (Number.isFinite(advisory.epss)) {
        const epss = element('span', 'audit-adv-mark', `EPSS ${percent(advisory.epss)}`);
        epss.title = 'Chance of exploitation in the next 30 days (FIRST EPSS)';
        ids.appendChild(epss);
      }
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
    const through = reach.route ? `${verbs(reach.method)} ${reach.route}` : reach.method === 'ACTION' ? 'a server action' : 'an endpoint';
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
  function findingList(findings, changes, handlers, families, view = {}) {
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
      const kev = kevChip(finding, { short: true });
      if (kev) tags.appendChild(kev);
      if (toConfirm) tags.appendChild(verdictChip(finding));
      else if (finding.reach && finding.reach.auth === 'open') tags.appendChild(reachChip(finding.reach));
      if (changes && changes.newIds.has(finding.id)) tags.appendChild(chip('info', 'New', { className: 'audit-new', beam: true }));
      const due = clockChip(finding);
      if (due) tags.appendChild(due);
      if (finding.triage && finding.triage.lapsed) tags.appendChild(chip('warning', 'Acceptance lapsed', { glyph: ICON.flag, className: 'audit-lapsed-chip' }));
      if (tags.childNodes.length) summary.appendChild(tags);
      details.appendChild(summary);

      const body = element('div', 'audit-body');
      body.appendChild(element('p', 'exposure-item-consequence', finding.why));
      const clock = clockLine(finding);
      if (clock) body.appendChild(clock);
      if (finding.triage && finding.triage.lapsed) {
        const lapsed = element('p', 'audit-triage-note');
        lapsed.dataset.state = 'lapsed';
        lapsed.append(icon(ICON.flag), element('span', null, `${decisionSentence(finding.triage, view)} It is open again.`));
        body.appendChild(lapsed);
      }
      if (finding.reach) body.appendChild(reachLine(finding.reach));
      if (finding.trace && finding.trace.length) body.appendChild(traceView(finding, handlers));
      if (toConfirm && (finding.blocker || finding.check)) body.appendChild(validation(finding));
      if (finding.category === 'licences' && finding.detail && finding.detail.package) body.appendChild(licenceFacts(finding.detail));
      if (finding.detail && finding.detail.package && Array.isArray(finding.detail.advisories)) {
        body.appendChild(advisoryList(finding.detail));
        if (finding.detail.risk || finding.detail.intel || finding.detail.usage) body.appendChild(intelBlock(finding, handlers));
      }
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
      const actions = element('div', 'audit-body-actions');
      if (canTriage(view, handlers)) {
        const decide = keyed(button('', 'btn btn-ghost small audit-triage-btn', () => handlers.onTriage(finding)), `triage:${finding.id}`);
        decide.append(icon(ICON.flag), element('span', 'audit-btn-label', finding.triage && finding.triage.lapsed ? 'Decide again' : 'Triage'));
        decide.setAttribute('aria-label', `Triage: ${finding.title}, ${location(finding)}`);
        actions.appendChild(decide);
      }
      const copy = button('', 'btn btn-ghost small audit-copy', event => handlers.onCopy(finding, event.currentTarget));
      copy.append(icon(ICON.copy), element('span', 'audit-btn-label', 'Copy fix prompt'));
      actions.appendChild(copy);
      foot.appendChild(actions);
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
      const live = inScope.filter(exploited).length;
      if (live || view.exploit) {
        const exploits = element('div', 'audit-segments audit-exploits');
        exploits.setAttribute('role', 'group');
        exploits.setAttribute('aria-label', 'Show by exploitation');
        const option = (value, text, total) => {
          const control = keyed(button('', 'audit-segment', () => handlers.onExploit && handlers.onExploit(value)), `exploit:${value || 'any'}`);
          control.setAttribute('aria-pressed', (view.exploit || null) === value ? 'true' : 'false');
          if (value) {
            control.dataset.exploit = value;
            control.append(icon(ICON.flame));
          }
          control.append(element('span', null, text), element('span', 'audit-segment-n', String(total)));
          /* "Any" is also the verdict group's first option: the name says which question it answers. */
          control.setAttribute('aria-label', value ? `Exploited in the wild, ${total}` : `Any exploitation, ${total}`);
          control.disabled = Boolean(value) && !total && view.exploit !== value;
          return control;
        };
        exploits.append(option(null, 'Any', inScope.length), option('kev', 'Exploited', live));
        tools.appendChild(exploits);
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
      && (!view.verdict || verdictOf(finding) === view.verdict) && (!view.exploit || exploited(finding)) && matches(finding, view.query, families));
    if (!shown.length) {
      const empty = view.query
        ? `Nothing matches “${String(view.query).trim()}”.`
        : view.filter || view.owasp ? 'Nothing found here, in what was read.' : 'Nothing found, in what was read.';
      card.appendChild(element('p', 'exposure-empty audit-empty', empty));
    } else {
      const limit = Math.max(PAGE, Number(view.limit) || PAGE);
      card.appendChild(findingList(shown.slice(0, limit), view.diff, handlers, families, view));
      if (shown.length > limit) {
        const more = keyed(button('', 'btn btn-ghost audit-more', () => handlers.onMore && handlers.onMore(limit + PAGE)), 'more');
        more.append(element('span', null, `Show ${Math.min(PAGE, shown.length - limit)} more`), element('span', 'audit-more-of', `${limit} of ${shown.length}`));
        card.appendChild(more);
      }
    }
    const suppressed = result.suppressed || [];
    const triaged = suppressed.filter(finding => finding.suppression && finding.suppression.triage);
    const waived = suppressed.filter(finding => !(finding.suppression && finding.suppression.triage));
    if (triaged.length) card.appendChild(triagedList(triaged, view, handlers));
    if (waived.length) card.appendChild(waivedList(waived));
    if (result.triage && result.triage.unavailable) {
      card.appendChild(element('p', 'exposure-caveat', 'The team’s decisions could not be read for this audit, so every finding is shown as found.'));
    }
    host.appendChild(foldable(card, 'findings', head, 'Findings'));
  }

  /*
   * What the team decided, finding by finding: who, when, why, and until
   * when. Listed, never scored, never hidden, and each one can be taken back
   * by anyone who could have made it.
   */
  function triagedList(items, view, handlers) {
    const wrap = element('details', 'audit-waived audit-triaged');
    const summary = element('summary', 'audit-waived-head');
    summary.append(icon(ICON.flag), element('span', 'audit-waived-title', 'Triaged by the team'), element('span', 'exposure-count', String(items.length)));
    wrap.appendChild(summary);
    const list = element('ul', 'audit-waived-list');
    for (const finding of items) {
      const decision = finding.suppression.triage;
      const item = element('li', 'audit-waived-item audit-triaged-item');
      item.dataset.severity = finding.severity;
      item.dataset.findingId = finding.id;
      const top = element('span', 'audit-waived-top');
      top.append(icon(SEVERITY[finding.severity].icon), element('span', 'audit-waived-name', finding.title));
      const state = DISPOSITION[decision.disposition];
      if (state) top.appendChild(chip(state.tone, state.word, { className: 'audit-triage-chip', glyph: ICON.flag }));
      const meta = element('span', 'audit-waived-meta');
      meta.append(element('span', 'audit-rule', finding.rule), element('span', 'audit-row-where', location(finding)));
      const reason = element('span', 'audit-waived-reason audit-triage-reason', decisionSentence(decision, view));
      item.append(top, meta, reason);
      const tools = element('span', 'audit-triage-tools');
      if (handlers.onTriageHistory && view.triage && view.triage.status === 'ready') {
        const history = keyed(button('', 'btn btn-ghost small audit-triage-history', () => handlers.onTriageHistory(finding)), `triage-history:${finding.id}`);
        history.append(icon(ICON.history), element('span', 'audit-btn-label', 'History'));
        history.setAttribute('aria-label', `Decisions about ${finding.title}, ${location(finding)}`);
        tools.appendChild(history);
      }
      if (canTriage(view, handlers) && handlers.onReopen) {
        const reopen = keyed(button('', 'btn btn-ghost small audit-reopen', () => handlers.onReopen(finding)), `reopen:${finding.id}`);
        reopen.append(icon(ICON.reopen), element('span', 'audit-btn-label', 'Reopen'));
        reopen.setAttribute('aria-label', `Reopen ${finding.title}, ${location(finding)}`);
        tools.appendChild(reopen);
      }
      if (tools.childNodes.length) item.appendChild(tools);
      list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
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
      /* A package cleared in the licence policy is waived there, not on its line. */
      if (finding.suppression && finding.suppression.policy) meta.appendChild(element('span', 'audit-row-where', `cleared in ${finding.suppression.policy}`));
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
  /* Legacy reports without coverage evidence cannot establish a passing grade. */
  function siteAssessment(result) {
    const raw = result.coverage || {};
    const complete = raw.complete === true && raw.state === 'complete';
    const state = complete ? 'complete' : raw.state === 'partial' ? 'partial' : 'unknown';
    const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter(reason => typeof reason === 'string') : [];
    if (!complete && !reasons.length) reasons.push('Coverage evidence is unavailable; run the check again.');
    return { state, complete, reasons, categories: raw.categories || {} };
  }
  function siteAssessmentLine(result) {
    const coverage = siteAssessment(result);
    if (coverage.complete) return 'Coverage complete within the stated request and resource limits. This is a bounded security check, not a security certification.';
    const observed = Number.isFinite(result.observedScore) ? ` Observed checks scored ${result.observedScore}/100; this is not an overall site score.` : '';
    return `Coverage ${coverage.state}. Overall grade withheld.${observed} ${coverage.reasons.join(' ')}`;
  }

  function siteCoverage(result) {
    const hops = result.redirects
      ? ` after ${plural(result.redirects, 'redirect', 'redirects')}${result.requested && result.requested !== result.origin ? ` from ${result.requested}` : ''}`
      : '';
    const took = Number.isFinite(result.durationMs) ? ` in ${Math.max(1, Math.round(result.durationMs / 1000))} s` : '';
    return `${plural(result.requests, 'anonymous request', 'anonymous requests')}${took}; the page answered ${result.status}${hops}.`;
  }

  /*
   * Where a running site check is, as the server reports it: four steps in
   * the audit's own language, a line in words and a count where there is one.
   */
  const SITE_STEPS = Object.freeze([
    { id: 'connect', label: 'Connect', stages: ['page', 'transport'] },
    { id: 'probe', label: 'Probe', stages: ['paths'] },
    { id: 'crawl', label: 'Read', stages: ['pages', 'scripts'] },
    { id: 'lookup', label: 'Look up', stages: ['libraries', 'email'] }
  ]);
  function siteStageLine(progress) {
    const p = progress || {};
    switch (p.stage) {
      case 'transport': return 'Checking the certificate, plain HTTP and cross-origin reads';
      case 'paths': return p.total ? `Asking for files that should never be served · ${p.done || 0} of ${p.total}` : 'Asking for files that should never be served';
      case 'pages': return p.total ? `Reading the pages the site links to · ${p.done || 0} of ${p.total}` : 'Reading the pages the site links to';
      case 'scripts': return p.total ? `Reading the site’s JavaScript for secrets and libraries · ${p.done || 0} of ${p.total}` : 'Looking for the site’s JavaScript';
      case 'libraries': return 'Asking OSV about the libraries found';
      case 'email': return 'Looking up the domain’s SPF and DMARC records';
      default: return 'Requesting the page a visitor lands on';
    }
  }
  function siteProgressBlock(progress) {
    const wrap = element('div', 'audit-progress audit-site-progress');
    const steps = element('ol', 'audit-steps');
    steps.setAttribute('aria-label', 'Site check steps');
    for (const step of SITE_STEPS) {
      const item = element('li', 'audit-step');
      item.dataset.step = step.id;
      item.append(element('span', 'audit-step-dot'), element('span', 'audit-step-label', step.label));
      steps.appendChild(item);
    }
    const line = element('p', 'audit-progress-line');
    const bar = element('div', 'audit-progress-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Site check progress');
    bar.appendChild(element('span', 'audit-progress-fill'));
    const announce = element('span', 'sr-only');
    announce.setAttribute('role', 'status');
    wrap.append(steps, line, bar, announce);
    updateSiteProgress(wrap, progress);
    return wrap;
  }
  function updateSiteProgress(wrap, progress) {
    const p = progress && progress.stage ? progress : { stage: 'page' };
    const current = Math.max(0, SITE_STEPS.findIndex(step => step.stages.includes(p.stage)));
    wrap.dataset.stage = p.stage;
    wrap.querySelectorAll('.audit-step').forEach((item, index) => {
      item.dataset.state = index < current ? 'done' : index === current ? 'active' : 'next';
      if (index === current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    const text = siteStageLine(p);
    const line = wrap.querySelector('.audit-progress-line');
    if (line.textContent !== text) line.textContent = text;
    /* The bar moves through the steps, and within one by its count. */
    const total = Math.max(0, Number(p.total) || 0);
    const done = Math.min(total, Math.max(0, Number(p.done) || 0));
    const fraction = Math.min(1, (current + (total ? done / total : 0.5)) / SITE_STEPS.length);
    const bar = wrap.querySelector('.audit-progress-bar');
    bar.style.setProperty('--audit-read', fraction.toFixed(4));
    bar.dataset.busy = 'false';
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    bar.setAttribute('aria-valuetext', text);
    const announce = wrap.querySelector('[role="status"]');
    if (announce.dataset.step !== SITE_STEPS[current].id) {
      announce.dataset.step = SITE_STEPS[current].id;
      announce.textContent = text;
    }
  }
  /* A poll's answer, painted into the running site card without redrawing it. */
  function siteProgress(root, value) {
    const wrap = root && root.querySelector('.audit-site .audit-site-progress');
    if (!wrap) return false;
    updateSiteProgress(wrap, value);
    return true;
  }

  /* What was checked, each as passed, failed, worth a look, skipped or not answered -- so a short findings list is never read as a clean site. */
  const LEDGER_NAMES = Object.freeze({
    certificate: 'Certificate', protocol: 'TLS', 'plain-http': 'Plain HTTP', hsts: 'HSTS', headers: 'Security headers', cookies: 'Cookies',
    cors: 'Cross-origin reads', paths: 'Exposed files', errors: 'Error pages', robots: 'Crawler instructions', pages: 'Pages read', scripts: 'JavaScript', maps: 'Source maps',
    libraries: 'Libraries', contact: 'Security contact', email: 'Email spoofing'
  });
  const LEDGER_GLYPH = Object.freeze({ pass: '✓', fail: '✕', warn: '!', skip: '–', unknown: '?' });
  const LEDGER_STATE = Object.freeze({ pass: 'Passed', fail: 'Failed', warn: 'Worth a look', skip: 'Skipped', unknown: 'Not answered' });
  function siteLedger(result) {
    const entries = Array.isArray(result.ledger) ? result.ledger : [];
    if (!entries.length) return null;
    const wrap = element('div', 'audit-site-ledger');
    const title = element('h3', 'audit-site-list-title', 'What was checked');
    const counts = entries.reduce((total, entry) => { total[entry.state] = (total[entry.state] || 0) + 1; return total; }, {});
    const summary = element('span', 'audit-site-ledger-sum', [counts.pass ? `${counts.pass} passed` : '', counts.fail ? `${counts.fail} failed` : '', counts.warn ? `${counts.warn} worth a look` : '', counts.unknown ? `${counts.unknown} unknown` : '', counts.skip ? `${counts.skip} skipped` : ''].filter(Boolean).join(' · '));
    const head = element('div', 'audit-site-ledger-head');
    head.append(title, summary);
    const list = element('ul', 'audit-site-ledger-list');
    list.setAttribute('aria-label', 'What was checked');
    for (const entry of entries) {
      const item = element('li', 'audit-site-ledger-row');
      item.dataset.state = entry.state;
      const glyph = element('span', 'audit-site-ledger-glyph', LEDGER_GLYPH[entry.state] || '?');
      glyph.setAttribute('aria-hidden', 'true');
      const text = element('span', 'audit-site-ledger-text');
      text.append(element('span', 'audit-site-ledger-name', LEDGER_NAMES[entry.id] || entry.id), element('span', 'audit-site-ledger-detail', entry.detail || ''));
      const state = element('span', 'sr-only', `${LEDGER_STATE[entry.state] || entry.state}: `);
      item.append(glyph, state, text);
      list.appendChild(item);
    }
    wrap.append(head, list);
    return wrap;
  }
  /* The browser libraries recognised, each with what the advisory database says of its version. */
  function siteLibraries(result) {
    const libraries = Array.isArray(result.libraries) ? result.libraries : [];
    if (!libraries.length) return null;
    const list = element('ul', 'audit-site-libs');
    list.setAttribute('aria-label', 'Browser libraries');
    for (const library of libraries) {
      const item = element('li', 'audit-site-lib');
      item.dataset.state = library.state;
      const name = element('span', 'audit-site-lib-name', `${library.name} ${library.version}`);
      const state = element('span', 'audit-site-lib-state', library.state === 'vulnerable'
        ? `${plural(library.advisories, 'advisory', 'advisories')}${library.fixed ? ` · fixed in ${library.fixed}` : ''}`
        : library.state === 'clean' ? 'No advisory' : 'Not checked');
      item.title = library.source === 'address' ? 'Recognised from the address it is served from' : 'Recognised from its own banner';
      item.append(name, state);
      list.appendChild(item);
    }
    return list;
  }

  function renderSite(host, site, handlers, previous) {
    const card = element('section', 'card audit-site');
    const idPrefix = site.standalone ? 'standaloneSite' : 'auditSite';
    card.setAttribute('aria-labelledby', `${idPrefix}Heading`);
    const head = element('div', 'audit-site-head');
    const mark = element('span', 'audit-site-mark');
    mark.appendChild(icon(ICON.globe));
    const titles = element('div', 'audit-site-titles');
    /* On its own page the hero above already says what is checked; the card says how. */
    const heading = element('h2', 'exposure-heading', site.standalone ? 'Check a site' : 'Deployed site');
    heading.id = `${idPrefix}Heading`;
    titles.append(heading, element('p', 'audit-site-lede', site.standalone
      ? 'Anonymous GET requests only \u2014 at most sixty, in under a minute \u2014 and nothing it reads is kept.'
      : 'The certificate, headers, exposed files, the pages and scripts a visitor loads, their libraries and the domain’s email policy. Anonymous requests only; nothing kept.'));
    head.append(mark, titles);
    card.appendChild(head);

    const form = element('form', 'audit-site-form');
    form.noValidate = true;
    const label = element('label', 'audit-site-label', 'Site address');
    label.htmlFor = `${idPrefix}Url`;
    const field = element('div', 'audit-site-field');
    const input = element('input', 'audit-site-input');
    input.id = `${idPrefix}Url`;
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
    if (site.standalone && !site.result && site.status !== 'running') form.appendChild(element('p', 'audit-site-hint', 'Any site you may test: it is asked only what any visitor’s browser asks, and nothing is submitted, guessed or tried.'));
    form.addEventListener('submit', event => { event.preventDefault(); handlers.onSiteCheck(input.value); });
    card.appendChild(form);

    if (site.status === 'running') {
      card.appendChild(siteProgressBlock(site.progress));
    } else if (site.status === 'error') {
      const error = element('p', 'audit-lede audit-error', site.error || 'The site could not be checked.');
      error.setAttribute('role', 'alert');
      card.appendChild(error);
    }

    const result = site.result;
    if (result && site.status !== 'running') {
      const row = element('div', 'audit-grade-row audit-site-grade');
      const fresh = !previous || previous.siteId !== `${result.origin}|${result.checkedAt}`;
      const assessment = siteAssessment(result);
      const graded = assessment.complete && Number.isFinite(result.score) && typeof result.grade === 'string';
      row.appendChild(ring(graded ? result : { ...result, grade: null, score: null }, 'done', graded
        ? `Site grade ${result.grade}, ${result.score} out of 100`
        : `Site coverage ${assessment.state}; overall grade withheld`, fresh ? 0 : null));
      const read = element('div', 'audit-grade-read');
      const total = result.findings.length;
      const origin = element('span', 'audit-origin');
      origin.append(icon(ICON.globe), element('span', null, result.origin.replace(/^https:\/\//, '')));
      origin.title = result.origin;
      read.append(origin, element('p', 'audit-verdict audit-verdict-sm', total ? verdict(result, 'done') : assessment.complete ? 'Nothing found in the completed checks' : 'No findings in the checks completed so far'));
      read.appendChild(severityTally(result.findings));
      const notes = element('div', 'audit-notes');
      if (result.capped && graded) notes.appendChild(element('p', 'audit-cap', 'Held below 50 while a critical finding is open.'));
      if (site.diff) {
        const since = site.diff.previousAt ? ` since the check of ${new Date(site.diff.previousAt).toLocaleString()}` : '';
        notes.appendChild(element('p', 'audit-diff',
          assessment.complete
            ? `${plural(site.diff.newIds.size, 'new finding', 'new findings')}, ${site.diff.resolved} resolved${since}.`
            : `${plural(site.diff.newIds.size, 'new finding', 'new findings')}${since}. Resolution cannot be established from this incomplete check.`));
      }
      notes.appendChild(element('p', 'audit-coverage', siteCoverage(result)));
      read.appendChild(notes);
      row.appendChild(read);
      card.appendChild(row);
      const caveat = element('p', assessment.complete ? 'audit-coverage audit-site-assessment' : 'exposure-caveat audit-site-assessment', siteAssessmentLine(result));
      caveat.dataset.coverage = assessment.state;
      card.appendChild(caveat);

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
      const ledger = siteLedger(result);
      if (ledger) card.appendChild(ledger);
      const libraries = siteLibraries(result);
      if (libraries) card.appendChild(libraries);

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
        if (exportable) actions.appendChild(exportMenu(handlers.onExport, 'site-export', REPORT_EXPORTS));
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
    host.appendChild(site.standalone ? card : foldable(card, 'site', head, 'Deployed site'));
  }

  /* The site check on its own page: the same card, for any address. */
  const drawnSites = new WeakMap();
  function renderSiteScan(root, site, handlers) {
    if (!root) return;
    const previous = drawnSites.get(root) || null;
    root.replaceChildren();
    renderSite(root, { ...site, standalone: true }, handlers, previous);
    drawnSites.set(root, { siteId: site.result ? `${site.result.origin}|${site.result.checkedAt}` : null });
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
      renderWatch(root, view, handlers);
      renderPriorities(root, view, handlers, root);
      renderRisk(root, view, handlers, root);
      renderCategories(root, view, handlers);
      renderSurface(root, view, handlers);
      renderLicences(root, view, handlers, root);
      renderCoverage(root, view, handlers);
      renderStandards(root, view, handlers);
      renderFindings(root, view, handlers);
      renderRemediation(root, view, handlers);
      renderHistory(root, view, handlers);
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
   * What the kept history and the watch change, redrawn in place: an answer
   * that arrives while the reader has a menu open or a field focused replaces
   * its own cards and nothing else. The summary is among them only while it
   * is showing the kept grade rather than this page's own result.
   */
  const PARTS = Object.freeze({
    summary: { select: ':scope > .audit-summary', draw: (host, view, handlers, root) => renderSummary(host, view, handlers, drawn.get(root) || null) },
    watch: { select: ':scope > [data-fold="watch"]', draw: (host, view, handlers) => renderWatch(host, view, handlers) },
    remediation: { select: ':scope > [data-fold="remediation"]', draw: (host, view, handlers) => renderRemediation(host, view, handlers) },
    history: { select: ':scope > [data-fold="history"]', draw: (host, view, handlers) => renderHistory(host, view, handlers) }
  });
  function update(root, view, handlers) {
    if (!root) return;
    if (view.unavailable || view.status === 'running' || !root.querySelector(':scope > .audit-summary')) return render(root, view, handlers);
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const key = active && active.dataset.key ? active.dataset.key : null;
    for (const name of view.result ? ['watch', 'remediation', 'history'] : ['summary', 'watch', 'remediation', 'history']) {
      const part = PARTS[name];
      const scratch = document.createElement('div');
      part.draw(scratch, view, handlers, root);
      const fresh = scratch.firstElementChild;
      const old = root.querySelector(part.select);
      if (old) {
        if (fresh) old.replaceWith(fresh); else old.remove();
        continue;
      }
      if (!fresh) continue;
      if (name === 'summary') root.prepend(fresh);
      else if (name === 'watch') root.querySelector(':scope > .audit-summary').after(fresh);
      else if (name === 'remediation') {
        const history = root.querySelector(':scope > [data-fold="history"]');
        const site = root.querySelector(':scope > [data-fold="site"]');
        if (history) history.before(fresh); else if (site) site.before(fresh); else root.appendChild(fresh);
      } else {
        const site = root.querySelector(':scope > [data-fold="site"]');
        if (site) site.before(fresh); else root.appendChild(fresh);
      }
    }
    if (key && !root.contains(active)) {
      const again = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
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
      if (finding.clock) {
        lines.push(`- **Due by:** ${String(finding.clock.dueAt).slice(0, 10)}${finding.clock.state === 'overdue' ? ' (overdue)' : ''} — ${finding.clock.days} days from ${String(finding.clock.firstSeenAt).slice(0, 10)}, when it was first seen`);
      }
      if (finding.reach) {
        const reach = REACH[finding.reach.auth];
        lines.push(`- **Reached through:** ${finding.reach.route ? `\`${verbs(finding.reach.method)} ${finding.reach.route}\`` : 'a server action'}${reach ? ` — ${reach.word.toLowerCase()}` : ''}`);
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
      if (detail && detail.package && finding.category === 'licences') {
        for (const [term, value] of licenceFactList(detail)) lines.push(`- **${term}:** ${value}`);
      }
      if (detail && detail.package && Array.isArray(detail.advisories)) {
        lines.push(`- **Package:** ${detail.package} ${detail.source === 'range' ? `${detail.range} (lowest accepted ${detail.version})` : detail.version}${detail.direct ? '' : ' (transitive)'}`);
        if (detail.fixed) lines.push(`- **Fixed in:** ${detail.fixed}`);
        lines.push(`- **Advisories:** ${detail.advisories.map(advisory => `${advisory.id}${advisory.cve ? ` (${advisory.cve})` : ''}`).join(', ')}${detail.more ? ` and ${detail.more} more` : ''}`);
        if (detail.risk) lines.push(`- **Risk:** ${detail.risk.score}/100, ${RISK_BAND[detail.risk.band].word.toLowerCase()}`);
        const intel = detail.intel;
        if (intel && intel.exploited && intel.kev) lines.push(`- **Exploited in the wild:** ${intel.kev.cve}, in CISA’s catalog since ${intel.kev.added || 'an unknown date'}${intel.ransomware ? '; used in ransomware campaigns' : ''}`);
        if (intel && intel.epss) lines.push(`- **EPSS:** ${percent(intel.epss.score)} (${intel.epss.cve}${intel.epss.date ? `, ${intel.epss.date}` : ''})`);
        if (detail.usage) lines.push(`- **Reach:** ${tierSentence(detail.usage)}${detail.usage.chain && detail.usage.chain.length > 1 ? ` Path: ${detail.usage.chain.join(' → ')}.` : ''}`);
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
        `Grade **${result.grade}** — ${result.score}/100${result.capped ? result.capReason === 'exploited' ? ' (held below 50 by a vulnerability exploited in the wild)' : ' (held below 50 by a confirmed critical finding)' : ''}.`,
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
      const risky = riskRanked(result.findings);
      if (risky.length) {
        const sources = intelSources(result);
        lines.push('## Dependency risk', '', 'Ranked by exploitation in the wild, exploit probability and reach. Risk is (40 × CVSS impact + 60 × threat) × reach, out of 100.', '',
          ...(sources ? [`Sources: ${sources}.`, ''] : []),
          '| Risk | Package | Exploited | EPSS | Reach |', '| --- | --- | --- | --- | --- |',
          ...risky.map(finding => {
            const detail = finding.detail;
            const intel = intelOf(finding);
            const epss = intel && intel.epss ? `${percent(intel.epss.score)} (${intel.epss.cve})` : '—';
            const kev = intel && intel.exploited ? `yes — ${intel.kev.cve}${intel.ransomware ? ', ransomware' : ''}` : intel && intel.catalog === 'unknown' ? 'unknown' : 'no';
            return `| ${detail.risk.score} ${RISK_BAND[detail.risk.band].word.toLowerCase()} | ${cell(`${detail.package} ${detail.source === 'range' ? detail.range : detail.version}`)} | ${kev} | ${epss} | ${cell(tierWord(detail.usage))} |`;
          }), '');
      }
      const licensing = result.licences;
      if (licensing && licensing.status && licensing.status.versions) {
        const policy = licensing.policy && !licensing.policy.invalid ? licensing.policy : null;
        const project = licensing.project;
        const tally = LICENCE_ORDER.filter(family => licensing.families[family])
          .map(family => `${licensing.families[family]} ${LICENCE_FAMILY[family].word.toLowerCase()}`).join(' · ');
        lines.push('## Licences', '',
          `Judged against ${policy ? `the policy in \`${policy.path}\`` : project && project.expression ? `the project\u2019s own ${project.expression}${project.source ? ` (from \`${project.source}\`)` : ''}` : 'use in proprietary code: no project licence was found'}. Reported, not graded.`, '',
          `${licensing.status.known} of ${plural(licensing.status.versions, 'package version', 'package versions')} read: ${tally}.`, '');
        const listed = Array.isArray(licensing.packages) ? licensing.packages : [];
        if (listed.length) {
          lines.push('| Package | Licence | Family | Kind |', '| --- | --- | --- | --- |',
            ...listed.map(item => `| ${cell(`${item.package} ${item.version}`)} | ${cell(item.licence || 'none stated')} | ${(LICENCE_FAMILY[item.family] || LICENCE_FAMILY.unknown).word} | ${item.dev ? 'development' : item.direct ? 'direct' : 'transitive'} |`), '');
        }
      }
      if (!result.findings.length) lines.push('No findings in what was read.', '');
      findingSection(result.findings, lines, '', finding => finding.path ? `\`${location(finding)}\`` : 'whole repository');
      const triaged = (result.suppressed || []).filter(finding => finding.suppression && finding.suppression.triage);
      if (triaged.length) {
        lines.push('## Triaged by the team', '', 'Not scored. Each was decided by a person with reviewer access to the repository: a false positive, or a risk accepted until a date, after which it is open again.', '',
          '| Rule | Finding | Where | Decision |', '| --- | --- | --- | --- |',
          ...triaged.map(finding => `| ${finding.rule} | ${cell(finding.title)} | \`${location(finding)}\` | ${cell(triageJustification(finding.suppression.triage))} |`), '');
      }
      const waived = (result.suppressed || []).filter(finding => !(finding.suppression && finding.suppression.triage));
      if (waived.length) {
        lines.push('## Waived in code', '', 'Not scored. Each was waived by an `nv-audit-ignore` comment naming its rule, or, for a licence, cleared by name in the repository\u2019s licence policy.', '',
          '| Rule | Finding | Where | Reason |', '| --- | --- | --- | --- |',
          ...waived.map(finding => `| ${finding.rule} | ${cell(finding.title)} | \`${location(finding)}\` | ${cell((finding.suppression && finding.suppression.reason) || 'none given')} |`), '');
      }
    }
    if (site) {
      lines.push(
        `# Deployed site: ${site.origin}`,
        '',
        siteAssessment(site).complete && Number.isFinite(site.score) && typeof site.grade === 'string'
          ? `Grade **${site.grade}** — ${site.score}/100${site.capped ? ' (held below 50 by a critical finding)' : ''}.`
          : '**Overall grade withheld.**',
        siteAssessmentLine(site),
        `Checked ${site.checkedAt || new Date().toISOString()}: ${siteCoverage(site)}`,
        '',
        '| Header | Sent |',
        '| --- | --- |',
        ...(site.headers || []).map(header => `| ${HEADER_NAMES[header.name] || header.name} | ${header.present ? 'yes' : 'no'} |`),
        ''
      );
      if (Array.isArray(site.ledger) && site.ledger.length) {
        lines.push('## What was checked', '', '| Check | Result | Detail |', '| --- | --- | --- |',
          ...site.ledger.map(entry => `| ${LEDGER_NAMES[entry.id] || entry.id} | ${LEDGER_STATE[entry.state] || entry.state} | ${String(entry.detail || '').replace(/\|/g, '\\|')} |`), '');
      }
      if (Array.isArray(site.libraries) && site.libraries.length) {
        lines.push('## Browser libraries', '', ...site.libraries.map(library => `- ${library.name} ${library.version}: ${library.state === 'vulnerable'
          ? `${plural(library.advisories, 'advisory', 'advisories')}${library.ids && library.ids.length ? ` (${library.ids.join(', ')})` : ''}${library.fixed ? `, fixed in ${library.fixed}` : ''}`
          : library.state === 'clean' ? 'no published advisory' : 'not checked'}`), '');
      }
      if (!site.findings.length) lines.push(siteAssessment(site).complete ? 'No findings in the completed checks.' : 'No findings in the checks completed so far. Incomplete checks cannot establish that the site is clear.', '');
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
      /* A licence is compliance: a dashboard files it apart from security alerts, and gives it no security severity. */
      const compliance = finding.category === 'licences';
      const tags = [compliance ? 'compliance' : 'security', finding.category, standards.cwe && `external/cwe/${standards.cwe.toLowerCase()}`,
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
          tags, precision: 'high', 'problem.severity': finding.severity === 'warning' ? 'warning' : 'error', ...(compliance ? {} : { 'security-severity': SECURITY_SEVERITY[finding.severity] }),
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
  function triageJustification(decision) {
    const what = decision.disposition === 'false-positive' ? 'False positive' : 'Risk accepted';
    const who = decision.decidedBy ? ` by ${decision.decidedBy}` : '';
    const on = decision.decidedAt ? ` on ${String(decision.decidedAt).slice(0, 10)}` : '';
    const until = decision.expiresAt ? `, until ${String(decision.expiresAt).slice(0, 10)}` : '';
    return `${what}${who}${on}${until}: ${decision.reasonLabel || String(decision.reason || '').replace(/-/g, ' ')}.`;
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
        ...(toConfirm && finding.check ? { howToConfirm: finding.check } : {}),
        ...(riskOf(finding) ? { risk: riskOf(finding).score, riskBand: riskOf(finding).band } : {}),
        ...(intelOf(finding) ? {
          knownExploited: Boolean(intelOf(finding).exploited),
          ...(intelOf(finding).kev ? { kev: intelOf(finding).kev } : {}),
          ...(intelOf(finding).epss ? { epss: intelOf(finding).epss.score, epssPercentile: intelOf(finding).epss.percentile, epssCve: intelOf(finding).epss.cve } : {})
        } : {}),
        ...(usageOf(finding) ? { dependencyReach: usageOf(finding).tier } : {}),
        ...(finding.clock ? { firstSeen: finding.clock.firstSeenAt, dueBy: finding.clock.dueAt, clock: finding.clock.state } : {})
      }
    };
    /* A dependency's own CVSS is a better sort key for a dashboard than the family's default. */
    if (finding.detail && Number.isFinite(finding.detail.cvss)) result.properties['security-severity'] = finding.detail.cvss.toFixed(1);
    /* A team decision is an external suppression, accepted, with who and why; a waiver in the code is one in source. */
    if (suppression && suppression.triage) result.suppressions = [{ kind: 'external', status: 'accepted', justification: triageJustification(suppression.triage) }];
    else if (suppression) result.suppressions = [{ kind: 'inSource', justification: suppression.reason || 'Waived in code without a reason.' }];
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
          grade: result.grade, score: result.score, capped: Boolean(result.capped), ...(result.capReason ? { capReason: result.capReason } : {}),
          ...(result.coverage && result.coverage.exploit ? { exploitSources: result.coverage.exploit } : {}),
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
        invocations: [{ executionSuccessful: siteAssessment(site).complete }],
        properties: { origin: site.origin, grade: siteAssessment(site).complete ? site.grade : null, score: siteAssessment(site).complete ? site.score : null,
          observedScore: Number.isFinite(site.observedScore) ? site.observedScore : null, capped: Boolean(site.capped), coverage: siteAssessment(site) }
      });
    }
    return JSON.stringify({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs }, null, 2);
  }

  /*
   * The bill of materials, in the two formats supply-chain tools read. Every
   * component the manifests and lockfiles name, by package URL, with its
   * licence where the lockfile states one, what it depends on, and -- in
   * CycloneDX -- the vulnerabilities this audit found against it with their
   * exploit intelligence and reach. Names, versions and licences only; never
   * a line of the code.
   */
  const SPDX_EXPRESSION = /^\(?[A-Za-z0-9][A-Za-z0-9.+-]*(\s+(AND|OR|WITH)\s+\(?[A-Za-z0-9][A-Za-z0-9.+-]*\)?)*\)?$/;
  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const licencesOf = component => (Array.isArray(component.license) ? component.license : component.license ? [component.license] : [])
    .map(value => String(value).trim()).filter(Boolean);
  /* CycloneDX and SPDX split a coordinate into a group and a name where the ecosystem has one. */
  function coordinates(component) {
    const name = String(component.name);
    if (component.ecosystem === 'maven' && name.includes(':')) return { group: name.split(':')[0], name: name.split(':')[1] };
    if ((component.ecosystem === 'npm' && name.startsWith('@')) || component.ecosystem === 'packagist') {
      const at = name.indexOf('/');
      if (at > 0) return { group: name.slice(0, at), name: name.slice(at + 1) };
    }
    return { group: null, name };
  }
  const CDX_SEVERITY = Object.freeze({ critical: 'critical', serious: 'high', warning: 'medium' });

  function dependencyFindings(result) {
    return (result.findings || []).filter(finding => finding.detail && finding.detail.purl && Array.isArray(finding.detail.advisories));
  }

  function cyclonedx(result, meta = {}) {
    const components = Array.isArray(result && result.components) ? result.components : [];
    const refs = new Set(components.map(component => component.purl).filter(Boolean));
    const engine = result.engine || {};
    const property = (name, value) => ({ name: `nebulaverse:${name}`, value: String(value) });
    const bomComponents = components.filter(component => component.purl).map(component => {
      const { group, name } = coordinates(component);
      const licences = licencesOf(component);
      const licenses = licences.length === 1 && /\s(AND|OR|WITH)\s/.test(licences[0])
        ? [{ expression: licences[0] }]
        : licences.map(value => (SPDX_EXPRESSION.test(value) && !/\s/.test(value) ? { license: { id: value } } : { license: { name: value } }));
      return {
        type: 'library', 'bom-ref': component.purl, ...(group ? { group } : {}), name, version: component.version, purl: component.purl,
        scope: component.dev ? 'optional' : 'required',
        ...(licenses.length ? { licenses } : {}),
        properties: [property('ecosystem', component.ecosystem), property('direct', Boolean(component.direct)), property('source', component.source), ...(component.path ? [property('declared-in', component.path)] : [])]
      };
    });
    /* One vulnerability per advisory, affecting every component it was found in. */
    const vulnerabilities = new Map();
    for (const finding of dependencyFindings(result)) {
      const detail = finding.detail;
      if (!refs.has(detail.purl)) continue;
      for (const advisory of detail.advisories) {
        const known = vulnerabilities.get(advisory.id);
        if (known) { if (!known.affects.some(item => item.ref === detail.purl)) known.affects.push({ ref: detail.purl }); continue; }
        const intel = detail.intel || null;
        const properties = [];
        if (Number.isFinite(advisory.epss)) properties.push(property('epss', advisory.epss));
        if (advisory.kev) properties.push(property('cisa-kev', true));
        if (intel && intel.ransomware && intel.kev && intel.kev.cve === advisory.cve) properties.push(property('ransomware', true));
        if (detail.risk) properties.push(property('risk', detail.risk.score), property('risk-band', detail.risk.band));
        if (detail.usage) properties.push(property('reach', detail.usage.tier));
        vulnerabilities.set(advisory.id, {
          'bom-ref': `vuln:${advisory.id}`,
          id: advisory.id,
          source: { name: 'OSV', url: `https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}` },
          ...(advisory.cve ? { references: [{ id: advisory.cve, source: { name: 'NVD', url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(advisory.cve)}` } }] } : {}),
          ratings: [{ source: { name: 'OSV' }, ...(Number.isFinite(advisory.cvss) ? { score: advisory.cvss, method: 'CVSSv3' } : {}), severity: CDX_SEVERITY[advisory.severity] || 'unknown' }],
          ...(advisory.summary ? { description: advisory.summary } : {}),
          ...(detail.fixed && finding.rule !== 'DEP-006' ? { recommendation: `Upgrade ${detail.package} to ${detail.fixed} or later.` } : {}),
          affects: [{ ref: detail.purl }],
          ...(properties.length ? { properties } : {})
        });
      }
    }
    const root = { type: 'application', 'bom-ref': 'root', name: meta.name || 'repository', ...(result.commitSha ? { version: result.commitSha } : {}) };
    const dependencies = [
      { ref: 'root', dependsOn: components.filter(component => component.direct && component.purl).map(component => component.purl) },
      ...components.filter(component => component.purl && Array.isArray(component.dependsOn) && component.dependsOn.length)
        .map(component => ({ ref: component.purl, dependsOn: component.dependsOn.filter(target => refs.has(target)) }))
    ];
    return JSON.stringify({
      $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
      bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${uuid()}`, version: 1,
      metadata: {
        timestamp: result.auditedAt || new Date().toISOString(),
        tools: { components: [{ type: 'application', name: 'Nebulaverse-X Uranus', ...(engine.version ? { version: engine.version } : {}) }] },
        component: root,
        properties: [...(meta.ref ? [property('ref', meta.ref)] : []), ...(result.componentsTruncated ? [property('components-truncated', result.componentsTruncated)] : [])]
      },
      components: bomComponents,
      dependencies,
      vulnerabilities: [...vulnerabilities.values()]
    }, null, 2);
  }

  function spdx(result, meta = {}) {
    const components = (Array.isArray(result && result.components) ? result.components : []).filter(component => component.purl);
    const engine = result.engine || {};
    const id = new Map(components.map((component, index) => [component.purl, `SPDXRef-Package-${index + 1}`]));
    const advisoriesByPurl = new Map();
    for (const finding of dependencyFindings(result)) {
      const list = advisoriesByPurl.get(finding.detail.purl) || [];
      for (const advisory of finding.detail.advisories) if (!list.includes(advisory.id)) list.push(advisory.id);
      advisoriesByPurl.set(finding.detail.purl, list);
    }
    const declared = component => {
      const licences = licencesOf(component);
      const expression = licences.length > 1 ? licences.map(value => (/\s/.test(value) ? `(${value})` : value)).join(' AND ') : licences[0];
      return expression && SPDX_EXPRESSION.test(expression.replace(/[()]/g, '')) ? expression : 'NOASSERTION';
    };
    const packages = [
      {
        name: meta.name || 'repository', SPDXID: 'SPDXRef-Root', versionInfo: result.commitSha || 'NOASSERTION', downloadLocation: meta.repositoryUri || 'NOASSERTION',
        filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', primaryPackagePurpose: 'APPLICATION'
      },
      ...components.map(component => ({
        name: component.name, SPDXID: id.get(component.purl), versionInfo: component.version, downloadLocation: 'NOASSERTION',
        filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: declared(component), copyrightText: 'NOASSERTION', primaryPackagePurpose: 'LIBRARY',
        externalRefs: [
          { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: component.purl },
          ...(advisoriesByPurl.get(component.purl) || []).map(advisory => ({ referenceCategory: 'SECURITY', referenceType: 'advisory', referenceLocator: `https://osv.dev/vulnerability/${encodeURIComponent(advisory)}` }))
        ]
      }))
    ];
    const relationships = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Root' }];
    for (const component of components) {
      if (component.direct) {
        relationships.push(component.dev
          ? { spdxElementId: id.get(component.purl), relationshipType: 'DEV_DEPENDENCY_OF', relatedSpdxElement: 'SPDXRef-Root' }
          : { spdxElementId: 'SPDXRef-Root', relationshipType: 'DEPENDS_ON', relatedSpdxElement: id.get(component.purl) });
      }
      for (const target of component.dependsOn || []) {
        if (id.has(target)) relationships.push({ spdxElementId: id.get(component.purl), relationshipType: 'DEPENDS_ON', relatedSpdxElement: id.get(target) });
      }
    }
    const slug = String(meta.name || 'repository').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
    return JSON.stringify({
      spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: `${meta.name || 'repository'} dependencies`,
      documentNamespace: `https://spdx.org/spdxdocs/${slug}-${uuid()}`,
      creationInfo: { created: String(result.auditedAt || new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z'), creators: [`Tool: Nebulaverse-X-Uranus${engine.version ? `-${engine.version}` : ''}`] },
      packages, relationships
    }, null, 2);
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
    const rows = [['Source', 'Status', 'Severity', 'Verdict', 'Rule', 'Title', 'Detail', 'Family', 'CWE', 'CWE Top 25 (2025)', 'OWASP', 'Location', 'Line', 'Reached through', 'Risk', 'Known exploited', 'EPSS', 'Dependency reach', 'How to confirm', 'Reason waived', 'Due by', 'Fix']];
    const row = (source, status, finding, family) => {
      const standards = finding.standards || {};
      const reach = finding.reach ? `${finding.reach.route ? `${verbs(finding.reach.method)} ${finding.reach.route}` : 'server action'} (${finding.reach.auth})` : '';
      rows.push([source, status, finding.severity, verdictOf(finding) === 'needs-validation' ? 'to confirm' : 'confirmed', finding.rule, finding.title, detailChip(finding) || '', family || '', standards.cwe || '',
        standards.top25 ? `#${standards.top25.rank}` : '', standards.owasp || '',
        finding.path || finding.where || 'whole repository', finding.line || '', reach,
        riskOf(finding) ? `${riskOf(finding).score} ${riskOf(finding).band}` : '',
        intelOf(finding) ? intelOf(finding).exploited ? `yes (${intelOf(finding).kev.cve})` : intelOf(finding).catalog === 'unknown' ? 'unknown' : 'no' : '',
        intelOf(finding) && intelOf(finding).epss ? `${(intelOf(finding).epss.score * 100).toFixed(2)}% (${intelOf(finding).epss.cve})` : '',
        usageOf(finding) ? usageOf(finding).tier : '',
        verdictOf(finding) === 'needs-validation' ? finding.check || '' : '',
        finding.suppression ? finding.suppression.triage ? triageJustification(finding.suppression.triage) : finding.suppression.reason || '' : '',
        finding.clock ? `${String(finding.clock.dueAt).slice(0, 10)}${finding.clock.state === 'overdue' ? ' (overdue)' : ''}` : '',
        finding.fix]);
    };
    if (result) {
      const families = new Map((result.categories || []).map(category => [category.id, category.label]));
      for (const finding of result.findings) row('repository', changes && changes.newIds.has(finding.id) ? 'new' : 'open', finding, families.get(finding.category));
      for (const finding of result.suppressed || []) {
        const decision = finding.suppression && finding.suppression.triage;
        row('repository', decision ? (decision.disposition === 'false-positive' ? 'false positive' : 'risk accepted') : 'waived', finding, families.get(finding.category));
      }
    }
    if (site) {
      for (const finding of site.findings) row(site.origin, 'open', finding, 'Deployed site');
      const coverage = siteAssessment(site);
      if (!coverage.complete) {
        const summary = Array(rows[0].length).fill('');
        summary[0] = site.origin; summary[1] = `coverage-${coverage.state}`;
        summary[5] = 'Overall grade withheld'; summary[6] = siteAssessmentLine(site);
        summary[7] = 'Coverage';
        rows.push(summary);
      }
    }
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

  global.NebulaCodeAudit = Object.freeze({ STORE_PREFIX, render, update, progress, siteProgress, renderSiteScan, brief, sarif, csv, cyclonedx, spdx, exposureCsv, exposureSarif, exportMenu, allPrompts, diff, readPrevious, remember, storageKey });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaCodeAudit;
