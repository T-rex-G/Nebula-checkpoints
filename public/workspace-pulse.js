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

  /*
   * A daily series over the trailing window, for the area chart the design
   * draws across the card. The buckets below still carry the same repositories
   * -- they are the same measurement read at two grains, so the summary and the
   * plot can never disagree.
   */
  const SERIES_DAYS = 60;

  const ROLLING_DAYS = 7;

  function dailySeries(stamps, now) {
    const counts = new Array(SERIES_DAYS).fill(0);
    for (const stamp of stamps) {
      const age = Math.floor((now - stamp) / DAY);
      if (age >= 0 && age < SERIES_DAYS) counts[SERIES_DAYS - 1 - age] += 1;
    }
    /*
     * Read as a trailing seven-day count rather than a raw daily one. Pushes
     * are bursty, so the raw series is a flat line with a few spikes, which
     * says less about activity than it appears to. The window is named in the
     * caption and in the chart's description -- a smoothed series presented as
     * a raw one would be the chart lying about its own grain.
     */
    const rolling = counts.map((_, index) => {
      let total = 0;
      for (let back = 0; back < ROLLING_DAYS; back += 1) {
        const at = index - back;
        if (at >= 0) total += counts[at];
      }
      return total;
    });
    /*
     * The window total counts repositories, not plotted points. Summing the
     * rolling series instead would count each push once per day it stays in
     * the window -- which is how a card ends up claiming more repositories
     * than the workspace has.
     */
    return { rolling, total: counts.reduce((sum, value) => sum + value, 0) };
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
    const daily = dailySeries(stamps, now);
    return Object.freeze({
      measured: stamps.length > 0,
      total: stamps.length,
      unknownCount: list.length - stamps.length,
      windowDays: SERIES_DAYS,
      rollingDays: ROLLING_DAYS,
      windowTotal: daily.total,
      series: Object.freeze(daily.rolling),
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
    /*
     * The label row the design uses everywhere: a mono caption on the left and
     * the live reading on the right. The dot pulses only while there is a
     * reading to pulse about -- animating an unmeasured state would suggest
     * something is live when nothing is.
     */
    const row = element('div', 'wp-head');
    row.append(element('span', 'wp-label', 'TRUST SCORE'));
    if (trust.score !== null) {
      const live = element('span', `wp-live wp-${trust.status}`);
      const dot = element('span', 'wp-dot');
      dot.setAttribute('aria-hidden', 'true');
      live.append(dot, element('span', null, STATUS_WORD[trust.status]));
      row.appendChild(live);
    }
    head.append(row, figure);
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
    head.append(element('span', 'wp-label', 'LIVE SIGNALS'), value);
    head.appendChild(element('p', 'wp-stat-note', signals.measured
      ? `verified of ${signals.total} capabilities this provider projects`
      : 'The capability projection has not loaded.'));
    host.appendChild(head);
    if (!signals.measured) return;

    const total = signals.total || 1;
    const chart = svg('svg', {
      class: 'wp-segments', viewBox: '0 0 300 8', preserveAspectRatio: 'none',
      role: 'img', 'aria-label': signals.breakdown.map(part => `${part.count} ${part.label}`).join(', ')
    });
    let offset = 0;
    for (const part of signals.breakdown) {
      if (!part.count) continue;
      const width = (part.count / total) * 300;
      const bar = svg('rect', {
        x: offset, y: 0, width: Math.max(0, width - 3), height: 8, rx: 4,
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
  /*
   * The area the design draws across the bottom of the card: a violet-to-cyan
   * stroke over an indigo fade, bled past the card's padding so the plot reads
   * as the card's own surface rather than as a boxed widget sitting on it.
   *
   * Gradient ids are namespaced per card. Two cards with the same id would have
   * the second silently paint with the first's ramp, which is the kind of bug
   * that looks like a rendering quirk and never gets traced.
   */
  let areaSequence = 0;

  function areaChart(values, label) {
    const width = 380;
    const height = 120;
    /*
     * The plot is inset on every side. Drawn edge to edge, a series that is
     * mostly zero laid its baseline exactly on the bottom of the frame, where
     * the card's overflow clipped it away, and a single trailing spike landed
     * exactly on the right edge -- so the whole reading appeared as one stray
     * vertical line at the border of the card. The data was right; there was
     * nowhere for it to be drawn.
     */
    const padX = 4;
    const padTop = 14;
    const padBottom = 9;
    const plotW = width - padX * 2;
    const plotH = height - padTop - padBottom;
    const id = `wp-area-${areaSequence += 1}`;
    const peak = Math.max(...values, 1);
    const step = values.length > 1 ? plotW / (values.length - 1) : plotW;
    const points = values.map((value, index) => {
      const x = Math.round((padX + index * step) * 10) / 10;
      const y = Math.round((padTop + (1 - value / peak) * plotH) * 10) / 10;
      return `${x},${y}`;
    });
    const baseY = padTop + plotH;

    const chart = svg('svg', {
      class: 'wp-area', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none',
      role: 'img', 'aria-label': label
    });
    const defs = svg('defs', {});
    const stroke = svg('linearGradient', { id: `${id}-s`, x1: 0, y1: 0, x2: 1, y2: 0 });
    for (const [offset, color] of [['0%', '#8B5CF6'], ['55%', '#6366F1'], ['100%', '#22D3EE']]) {
      stroke.appendChild(svg('stop', { offset, 'stop-color': color }));
    }
    const fill = svg('linearGradient', { id: `${id}-f`, x1: 0, y1: 0, x2: 0, y2: 1 });
    fill.appendChild(svg('stop', { offset: '0%', 'stop-color': '#6366F1', 'stop-opacity': '.45' }));
    fill.appendChild(svg('stop', { offset: '100%', 'stop-color': '#6366F1', 'stop-opacity': '0' }));
    defs.append(stroke, fill);
    chart.appendChild(defs);
    /* A zero line, so a flat stretch reads as measured zero and not as no data. */
    chart.appendChild(svg('line', {
      x1: padX, y1: baseY, x2: width - padX, y2: baseY,
      stroke: 'currentColor', 'stroke-width': 1, opacity: '.22',
      'vector-effect': 'non-scaling-stroke'
    }));
    chart.appendChild(svg('polygon', {
      points: `${points.join(' ')} ${width - padX},${baseY} ${padX},${baseY}`, fill: `url(#${id}-f)`
    }));
    chart.appendChild(svg('polyline', {
      points: points.join(' '), fill: 'none', stroke: `url(#${id}-s)`,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke'
    }));
    return chart;
  }

  function renderActivity(host, activity) {
    host.textContent = '';
    const head = element('div', 'wp-head');
    head.append(element('span', 'wp-label', 'REPOSITORY ACTIVITY'));
    host.appendChild(head);
    if (!activity.measured) {
      host.appendChild(element('p', 'wp-stat-note', 'No repository has reported a last-push time yet.'));
      return;
    }
    host.appendChild(element('p', 'wp-stat-note',
      `${activity.windowTotal} of ${activity.total} repositories pushed in the last ${activity.windowDays} days, shown as a trailing ${activity.rollingDays}-day count.`));
    host.appendChild(areaChart(
      activity.series,
      `Repositories pushed, as a trailing ${activity.rollingDays}-day count over the last ${activity.windowDays} days.`
    ));

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
