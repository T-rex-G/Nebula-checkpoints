/*
 * The workspace pulse: trust score, live signals, and activity.
 *
 * The reference design shows "Trust Score 92" and "48 Live signals". Nothing
 * computed either, so shipping those numbers would have meant printing a
 * constant that reads as measured -- the one thing a security product cannot
 * do. This module computes them from signals the session actually holds, and
 * is built so the figures stay honest under every partial state:
 *
 *   - A component with no input is `unknown`. It is shown as unknown and left
 *     out of the mean rather than counted as zero, because "not measured" and
 *     "measured and failing" are different claims.
 *   - With nothing measured at all the score is null and the tile says so. It
 *     never falls back to 0, which would read as a catastrophic result.
 *   - The score is never shown alone. Every component that produced it is on
 *     screen with its own reading, so the number can be argued with.
 */
'use strict';

(function workspacePulseModule(global) {
  const DAY = 86400000;

  /* Weights sum to 1 across the measured set; unknown components renormalise. */
  const COMPONENTS = Object.freeze([
    Object.freeze({ id: 'capabilities', label: 'Capabilities verified', weight: 0.25 }),
    Object.freeze({ id: 'scanning', label: 'Upload scanning', weight: 0.2 }),
    Object.freeze({ id: 'recovery', label: 'Recovery available', weight: 0.2 }),
    Object.freeze({ id: 'authentication', label: 'Authentication strength', weight: 0.2 }),
    Object.freeze({ id: 'visibility', label: 'Private by default', weight: 0.15 })
  ]);

  const ACTIVITY_BUCKETS = Object.freeze([
    Object.freeze({ id: 'day', label: 'Today', within: 1 }),
    Object.freeze({ id: 'week', label: 'This week', within: 7 }),
    Object.freeze({ id: 'month', label: 'This month', within: 30 }),
    Object.freeze({ id: 'quarter', label: 'This quarter', within: 90 }),
    Object.freeze({ id: 'older', label: 'Older', within: Infinity })
  ]);

  function ratioStatus(ratio) {
    if (ratio >= 0.85) return 'good';
    if (ratio >= 0.6) return 'warning';
    return 'critical';
  }

  function unknown(component, detail) {
    return Object.freeze({ ...component, ratio: null, status: 'unknown', detail });
  }

  function measured(component, ratio, detail) {
    const bounded = Math.min(1, Math.max(0, ratio));
    return Object.freeze({ ...component, ratio: bounded, status: ratioStatus(bounded), detail });
  }

  function componentById(id) {
    return COMPONENTS.find(component => component.id === id);
  }

  /*
   * Capability projection: how much of what this provider claims to offer is
   * actually verified here. Experimental counts as half -- it is reachable but
   * not evidenced, and rounding it up to "verified" would overstate the score.
   */
  function capabilityComponent(signals) {
    const component = componentById('capabilities');
    if (!signals || !signals.total) {
      return unknown(component, 'Capability projection has not loaded.');
    }
    const credit = (signals.supported + (signals.experimental * 0.5)) / signals.total;
    return measured(component, credit, `${signals.supported} of ${signals.total} verified for this provider.`);
  }

  function scanningComponent(scanner) {
    const component = componentById('scanning');
    if (!scanner || typeof scanner.active !== 'boolean') {
      return unknown(component, 'Scanner status has not loaded.');
    }
    if (!scanner.active) return measured(component, 0, 'Uploads are not scanned before provider writes.');
    return scanner.rulesConfigured
      ? measured(component, 1, 'Configured rules are applied to raw uploads.')
      : measured(component, 0.7, 'Built-in signatures are active; no custom rules are configured.');
  }

  function statusCredit(status) {
    if (status === 'Supported') return 1;
    if (status === 'Experimental') return 0.5;
    return 0;
  }

  function recoveryComponent(recoveryStatus) {
    const component = componentById('recovery');
    if (!recoveryStatus) return unknown(component, 'Recovery capability has not loaded.');
    const credit = statusCredit(recoveryStatus);
    return measured(component, credit, credit === 1
      ? 'Snapshots and restore are available here.'
      : `Recovery is ${String(recoveryStatus).toLowerCase()} for this provider.`);
  }

  /*
   * An installation-scoped credential can be revoked and narrowed per
   * repository; a personal token generally cannot. That is a real difference in
   * blast radius, so it is a real difference in the score.
   */
  function authenticationComponent(identity) {
    const component = componentById('authentication');
    if (!identity) return unknown(component, 'Identity has not loaded.');
    const app = !!(identity.installationId || identity.authMethod === 'github-app');
    return app
      ? measured(component, 1, 'Installation-scoped credential, revocable per repository.')
      : measured(component, 0.5, 'Personal access token: broader scope, revoked as a whole.');
  }

  function visibilityComponent(repos) {
    const component = componentById('visibility');
    if (!Array.isArray(repos) || repos.length === 0) {
      return unknown(component, 'No repositories have loaded.');
    }
    const priv = repos.filter(repo => repo && repo.private).length;
    return measured(component, priv / repos.length, `${priv} of ${repos.length} connected repositories are private.`);
  }

  function capabilitySignals(features) {
    if (!features || typeof features !== 'object') return null;
    const values = Object.values(features);
    if (!values.length) return null;
    const count = status => values.filter(entry => entry && entry.status === status).length;
    return Object.freeze({
      total: values.length,
      supported: count('Supported'),
      experimental: count('Experimental'),
      unavailable: count('Unavailable')
    });
  }

  function activity(repos, now) {
    const list = Array.isArray(repos) ? repos : [];
    const stamps = list
      .map(repo => Date.parse((repo && (repo.pushed_at || repo.pushedAt)) || ''))
      .filter(value => Number.isFinite(value));
    const buckets = ACTIVITY_BUCKETS.map(bucket => ({ ...bucket, count: 0 }));
    for (const stamp of stamps) {
      const age = (now - stamp) / DAY;
      const bucket = buckets.find(entry => age < entry.within) || buckets[buckets.length - 1];
      bucket.count += 1;
    }
    return Object.freeze({
      measured: stamps.length > 0,
      total: stamps.length,
      unknownCount: list.length - stamps.length,
      buckets: Object.freeze(buckets.map(bucket => Object.freeze(bucket)))
    });
  }

  function model(input = {}) {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const signals = capabilitySignals(input.features);
    const components = Object.freeze([
      capabilityComponent(signals),
      scanningComponent(input.scanner),
      recoveryComponent(input.recoveryStatus),
      authenticationComponent(input.identity),
      visibilityComponent(input.repos)
    ]);

    const known = components.filter(component => component.status !== 'unknown');
    const weight = known.reduce((total, component) => total + component.weight, 0);
    const score = weight > 0
      ? Math.round((known.reduce((total, c) => total + (c.ratio * c.weight), 0) / weight) * 100)
      : null;

    return Object.freeze({
      trust: Object.freeze({
        score,
        status: score === null ? 'unknown' : ratioStatus(score / 100),
        measuredCount: known.length,
        componentCount: components.length,
        components
      }),
      signals: Object.freeze({
        measured: !!signals,
        live: signals ? signals.supported : 0,
        total: signals ? signals.total : 0,
        breakdown: Object.freeze(signals ? [
          Object.freeze({ id: 'supported', label: 'Verified', count: signals.supported, status: 'good' }),
          Object.freeze({ id: 'experimental', label: 'Experimental', count: signals.experimental, status: 'warning' }),
          Object.freeze({ id: 'unavailable', label: 'Unavailable', count: signals.unavailable, status: 'muted' })
        ] : [])
      }),
      activity: activity(input.repos, now)
    });
  }

  /* ---------------------------------------------------------------- views */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /*
   * Status marks never carry meaning by colour alone: each one ships with a
   * glyph and a word, so the reading survives colour blindness, a mono print
   * and forced-colours mode.
   */
  const STATUS_GLYPH = Object.freeze({
    good: '\u2713', warning: '\u25B3', critical: '\u2715', unknown: '\u2014', muted: '\u25CB'
  });
  const STATUS_WORD = Object.freeze({
    good: 'Healthy', warning: 'Needs attention', critical: 'At risk', unknown: 'Not measured', muted: 'Not offered'
  });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attributes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, String(value));
    return node;
  }

  function statusMark(status) {
    const mark = element('span', `wp-mark wp-${status}`);
    const glyph = element('span', 'wp-mark-glyph', STATUS_GLYPH[status] || STATUS_GLYPH.unknown);
    glyph.setAttribute('aria-hidden', 'true');
    mark.append(glyph, element('span', 'wp-mark-word', STATUS_WORD[status] || STATUS_WORD.unknown));
    return mark;
  }

  /*
   * A meter, not a gauge: the fill carries severity and the track is a lighter
   * step of the same ramp, so the state reads across the whole bar rather than
   * only where the fill stops.
   */
  function meter(ratio, status) {
    const track = element('span', 'wp-meter');
    track.dataset.status = status;
    const fill = element('span', 'wp-meter-fill');
    fill.style.width = ratio === null ? '0%' : `${Math.round(ratio * 100)}%`;
    track.appendChild(fill);
    return track;
  }

  function numbersTable(caption, headings, rows) {
    const details = element('details', 'wp-numbers');
    details.appendChild(element('summary', null, 'Show the numbers'));
    const table = element('table');
    table.appendChild(element('caption', null, caption));
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const heading of headings) {
      const cell = element('th', null, heading);
      cell.setAttribute('scope', 'col');
      headRow.appendChild(cell);
    }
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      row.forEach((value, index) => {
        const cell = element(index === 0 ? 'th' : 'td', null, String(value));
        if (index === 0) cell.setAttribute('scope', 'row');
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    }
    table.append(head, body);
    details.appendChild(table);
    return details;
  }

  function renderTrust(host, trust) {
    host.textContent = '';
    const head = element('div', 'wp-hero');
    /*
     * One hero figure per view, in the body sans. When nothing has been
     * measured it says so in words rather than showing a zero, which would
     * read as a catastrophic result rather than an absent one.
     */
    const figure = element('p', 'wp-hero-figure', trust.score === null ? 'Not measured' : String(trust.score));
    figure.classList.toggle('wp-hero-empty', trust.score === null);
    head.append(element('p', 'wp-hero-label', 'Trust score'), figure);
    head.appendChild(element('p', 'wp-hero-note', trust.score === null
      ? 'No signal has loaded yet.'
      : `From ${trust.measuredCount} of ${trust.componentCount} signals measured in this session.`));
    host.appendChild(head);

    const list = element('ul', 'wp-components');
    for (const component of trust.components) {
      const item = element('li', 'wp-component');
      const top = element('div', 'wp-component-head');
      top.append(element('span', 'wp-component-label', component.label), statusMark(component.status));
      const reading = element('p', 'wp-component-detail', component.detail);
      item.append(top, meter(component.ratio, component.status), reading);
      list.appendChild(item);
    }
    host.appendChild(list);
    host.appendChild(numbersTable(
      'Trust score components',
      ['Signal', 'Reading', 'State'],
      trust.components.map(component => [
        component.label,
        component.ratio === null ? 'not measured' : `${Math.round(component.ratio * 100)}%`,
        STATUS_WORD[component.status]
      ])
    ));
  }

  /*
   * Part-to-whole across three states of one total. Segments are separated by a
   * surface-coloured gap so adjacent fills never blend into one mark.
   */
  function renderSignals(host, signals) {
    host.textContent = '';
    const head = element('div', 'wp-stat');
    const value = element('p', 'wp-stat-value', signals.measured ? String(signals.live) : 'Not measured');
    /*
     * An absent reading is set in prose rather than at figure size. Left at the
     * value's own scale it shouts louder than the measurement it is standing in
     * for, which reads as an alarm rather than as "nothing has loaded".
     */
    value.classList.toggle('wp-stat-empty', !signals.measured);
    head.append(element('p', 'wp-stat-label', 'Live signals'), value);
    head.appendChild(element('p', 'wp-stat-note', signals.measured
      ? `verified of ${signals.total} capabilities this provider projects`
      : 'The capability projection has not loaded.'));
    host.appendChild(head);
    if (!signals.measured) return;

    const total = signals.total || 1;
    const chart = svg('svg', {
      class: 'wp-segments', viewBox: '0 0 300 14', preserveAspectRatio: 'none',
      role: 'img', 'aria-label': signals.breakdown.map(part => `${part.count} ${part.label}`).join(', ')
    });
    let offset = 0;
    for (const part of signals.breakdown) {
      if (!part.count) continue;
      const width = (part.count / total) * 300;
      const bar = svg('rect', {
        x: offset, y: 0, width: Math.max(0, width - 2), height: 14, rx: 4,
        class: `wp-segment wp-fill-${part.status}`
      });
      bar.appendChild(svg('title', {})).textContent = `${part.label}: ${part.count} of ${signals.total}`;
      chart.appendChild(bar);
      offset += width;
    }
    host.appendChild(chart);

    const legend = element('ul', 'wp-legend');
    for (const part of signals.breakdown) {
      const item = element('li', 'wp-legend-item');
      const swatch = element('span', `wp-swatch wp-fill-${part.status}`);
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, element('span', 'wp-legend-label', part.label), element('span', 'wp-legend-value', String(part.count)));
      legend.appendChild(item);
    }
    host.append(legend, numbersTable(
      'Capability states',
      ['State', 'Capabilities'],
      signals.breakdown.map(part => [part.label, part.count])
    ));
  }

  /*
   * Magnitude across ordered buckets: one hue, stepped light-to-dark with
   * recency, so the ramp itself carries the ordering. Only the largest bucket
   * is labelled on the plot -- a number on every bar is noise.
   */
  function renderActivity(host, activity) {
    host.textContent = '';
    host.appendChild(element('p', 'wp-stat-label', 'Repository activity'));
    if (!activity.measured) {
      host.appendChild(element('p', 'wp-stat-note', 'No repository has reported a last-push time yet.'));
      return;
    }
    const peak = Math.max(...activity.buckets.map(bucket => bucket.count), 1);
    const chart = element('div', 'wp-bars');
    for (const bucket of activity.buckets) {
      const row = element('div', 'wp-bar-row');
      row.title = `${bucket.label}: ${bucket.count} of ${activity.total}`;
      const track = element('span', 'wp-bar-track');
      const fill = element('span', `wp-bar-fill wp-step-${bucket.id}`);
      fill.style.width = `${Math.max(bucket.count ? 3 : 0, (bucket.count / peak) * 100)}%`;
      track.appendChild(fill);
      row.append(
        element('span', 'wp-bar-label', bucket.label),
        track,
        element('span', `wp-bar-value${bucket.count === peak ? ' wp-bar-peak' : ''}`, String(bucket.count))
      );
      chart.appendChild(row);
    }
    host.appendChild(chart);
    if (activity.unknownCount > 0) {
      host.appendChild(element('p', 'wp-stat-note',
        `${activity.unknownCount} repository${activity.unknownCount === 1 ? '' : 's'} reported no last-push time and ${activity.unknownCount === 1 ? 'is' : 'are'} not counted above.`));
    }
    host.appendChild(numbersTable(
      'Repositories by last push',
      ['Period', 'Repositories'],
      activity.buckets.map(bucket => [bucket.label, bucket.count])
    ));
  }

  /*
   * Each card names itself through a heading that lives outside the region this
   * repaints. Clearing the whole card took that heading with it, and a card
   * with no accessible name is a card a screen reader cannot announce or a test
   * find -- so the redraw is confined to a body element that owns nothing but
   * the reading.
   */
  function body(host) {
    if (!host) return null;
    return host.querySelector('.wp-body') || host;
  }

  function render(roots, current) {
    if (!roots || typeof document === 'undefined') return current;
    if (roots.trust) renderTrust(body(roots.trust), current.trust);
    if (roots.signals) renderSignals(body(roots.signals), current.signals);
    if (roots.activity) renderActivity(body(roots.activity), current.activity);
    return current;
  }

  global.NebulaWorkspacePulse = Object.freeze({ COMPONENTS, ACTIVITY_BUCKETS, model, render });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaWorkspacePulse;
