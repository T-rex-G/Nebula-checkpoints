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
  /*
   * A radial gauge, drawn as one arc.
   *
   * A flat bar answers "how far along" and nothing else: at a glance every bar
   * on the page is the same object at a different length, and a score that is
   * the page's headline figure read as a loading indicator. An arc gives the
   * figure a shape of its own -- the number sits in the middle of its own
   * measurement rather than above a line about it.
   *
   * One path, animated by stroke-dashoffset. That is a single presentation
   * attribute on a single element, so the browser has nothing to lay out and
   * nothing to composite; there is no library here and none is needed.
   */
  const GAUGE_R = 52;
  const GAUGE_C = 2 * Math.PI * GAUGE_R;
  /* Three-quarters of the circle, opened at the bottom, so the gap reads as a
     deliberate dial rather than as a ring that failed to close. */
  const GAUGE_SWEEP = 0.75;

  function gauge(ratio, status, options) {
    const settings = options || {};
    const measured = typeof ratio === 'number' && isFinite(ratio);
    const value = measured ? Math.max(0, Math.min(1, ratio)) : 0;
    const box = element('div', settings.compact ? 'wp-gauge wp-gauge-sm' : 'wp-gauge');
    box.dataset.status = measured ? status : 'unknown';

    const art = svg('svg', {
      class: 'wp-gauge-art', viewBox: '0 0 128 128', 'aria-hidden': 'true', focusable: 'false'
    });
    const geometry = {
      cx: 64, cy: 64, r: GAUGE_R, fill: 'none', 'stroke-linecap': 'round',
      transform: 'rotate(135 64 64)'
    };
    art.appendChild(svg('circle', Object.assign({ class: 'wp-gauge-track' }, geometry, {
      'stroke-dasharray': `${GAUGE_C * GAUGE_SWEEP} ${GAUGE_C}`
    })));
    /*
     * An unmeasured gauge draws its track and no arc at all. Drawing a
     * zero-length arc would be a reading of zero, and "not measured" is not
     * zero -- that distinction is the whole reason this model reports absence.
     */
    if (measured) {
      art.appendChild(svg('circle', Object.assign({ class: 'wp-gauge-arc' }, geometry, {
        'stroke-dasharray': `${GAUGE_C * GAUGE_SWEEP * value} ${GAUGE_C}`
      })));
    }
    box.appendChild(art);

    const core = element('div', 'wp-gauge-core');
    const figure = element('p', 'wp-gauge-figure', settings.figure === undefined
      ? (measured ? String(Math.round(value * 100)) : '\u2014')
      : String(settings.figure));
    figure.classList.toggle('wp-gauge-empty', !measured);
    core.appendChild(figure);
    if (settings.unit) core.appendChild(element('span', 'wp-gauge-unit', settings.unit));
    if (settings.caption) core.appendChild(element('p', 'wp-gauge-caption', settings.caption));
    box.appendChild(core);
    return box;
  }

  /*
   * Part-to-whole as a ring rather than a bar. Each state is an arc on the same
   * circle, offset by what came before it, so the reader sees the shares of one
   * total instead of three lengths that have to be added up by eye.
   */
  function donut(parts, total) {
    const whole = total || 1;
    const art = svg('svg', {
      class: 'wp-donut', viewBox: '0 0 128 128', role: 'img',
      'aria-label': parts.map(part => `${part.count} ${part.label}`).join(', ')
    });
    art.appendChild(svg('circle', {
      class: 'wp-donut-track', cx: 64, cy: 64, r: GAUGE_R, fill: 'none'
    }));
    let consumed = 0;
    for (const part of parts) {
      if (!part.count) continue;
      const share = part.count / whole;
      /*
       * The state travels as a data attribute, not as the shared wp-fill-*
       * class the legend swatches use. That class sets `fill`, and a class
       * rule outranks a presentation attribute, so fill="none" lost and every
       * arc painted itself as a filled disc -- the ring came out solid.
       */
      const arc = svg('circle', {
        class: 'wp-donut-arc', 'data-status': part.status,
        cx: 64, cy: 64, r: GAUGE_R, fill: 'none',
        'stroke-linecap': 'butt',
        /* A gap of two units keeps adjacent arcs from blending into one mark,
           and is clamped so a one-capability share is not erased by it. */
        'stroke-dasharray': `${Math.max(0, GAUGE_C * share - 2)} ${GAUGE_C}`,
        'stroke-dashoffset': -GAUGE_C * consumed,
        transform: 'rotate(-90 64 64)'
      });
      arc.appendChild(svg('title', {})).textContent = `${part.label}: ${part.count} of ${total}`;
      art.appendChild(arc);
      consumed += share;
    }
    return art;
  }

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
    head.appendChild(row);
    /*
     * The score is the page's headline reading, so it is drawn as its own
     * measurement rather than set above a line about it. Out of 100 by
     * definition, which is what makes an arc the honest shape for it.
     */
    const dial = element('div', 'wp-dial');
    dial.append(gauge(trust.score === null ? null : trust.score / 100, trust.status, {
      figure: trust.score === null ? '\u2014' : trust.score,
      caption: trust.score === null ? 'not measured' : 'out of 100'
    }));
    const readout = element('div', 'wp-dial-read');
    readout.appendChild(element('p', 'wp-hero-note', trust.score === null
      ? 'No signal has loaded yet.'
      : `From ${trust.measuredCount} of ${trust.componentCount} signals measured in this session.`));
    dial.appendChild(readout);
    head.appendChild(dial);
    host.appendChild(head);

    /*
     * Five signals, five dials. Stacked full-width bars turned the card into a
     * column of coloured lines: at a glance they were one repeated object and
     * the reader had to read every label to find which line was the bad one. A
     * small dial per signal carries its own reading and its own colour in one
     * mark, and puts the percentage where the eye already is.
     */
    const list = element('ul', 'wp-components');
    for (const component of trust.components) {
      const item = element('li', 'wp-component');
      item.appendChild(gauge(component.ratio, component.status, { compact: true }));
      const text = element('div', 'wp-component-text');
      const top = element('div', 'wp-component-head');
      top.append(element('span', 'wp-component-label', component.label), statusMark(component.status));
      text.append(top, element('p', 'wp-component-detail', component.detail));
      item.appendChild(text);
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
    head.appendChild(element('span', 'wp-label', 'LIVE SIGNALS'));
    /*
     * The count moves into the middle of the ring that measures it, so the
     * figure is not printed twice on one card. An absent reading has no ring to
     * sit in and is set in prose rather than at figure size: left at the
     * value's own scale it shouts louder than the measurement it stands in for,
     * which reads as an alarm rather than as "nothing has loaded".
     */
    if (!signals.measured) {
      const value = element('p', 'wp-stat-value wp-stat-empty', 'Not measured');
      head.append(value, element('p', 'wp-stat-note', 'The capability projection has not loaded.'));
      host.appendChild(head);
      return;
    }
    head.appendChild(element('p', 'wp-stat-note',
      `verified of ${signals.total} capabilities this provider projects`));
    host.appendChild(head);

    const ring = element('div', 'wp-ring');
    ring.appendChild(donut(signals.breakdown, signals.total));
    const core = element('div', 'wp-ring-core');
    core.append(
      element('p', 'wp-ring-figure', String(signals.live)),
      element('span', 'wp-ring-unit', `of ${signals.total}`)
    );
    ring.appendChild(core);
    host.appendChild(ring);

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
    /*
     * The horizontal inset was four units of a 380-unit box, which the card
     * stretches to its own width: the last point landed about five pixels from
     * the frame, so a series that ends on its only non-zero reading drew what
     * looked like a stray line down the card's border. There is room for the
     * endpoint to be a point now.
     */
    const padX = 16;
    const padTop = 16;
    const padBottom = 11;
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
    /*
     * The latest reading gets a mark of its own. A workspace with one
     * repository produces a series that is zero until its final value, and a
     * bare polyline renders that as a cliff with nothing at the top of it --
     * the shape a reader takes for a rendering fault rather than for one push.
     * The circle is drawn in screen units so the chart's horizontal stretch
     * cannot flatten it into an ellipse.
     */
    const last = points[points.length - 1];
    if (last) {
      const [lastX, lastY] = last.split(',');
      chart.appendChild(svg('circle', {
        class: 'wp-area-head', cx: lastX, cy: lastY, r: 3.5,
        fill: '#22D3EE', 'vector-effect': 'non-scaling-stroke'
      }));
    }
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

  /* --------------------------------------------------------------- the feed */

  /*
   * How long ago, in words.
   *
   * Written here rather than reused from the application because this module
   * is loaded on its own and tested on its own -- reaching into app.js for a
   * formatter would make the card depend on the whole shell to render one row.
   * Absolute dates past a month: "63d ago" is arithmetic the reader has to do,
   * and by then the exact day is the more useful fact anyway.
   */
  function since(at, now) {
    if (!Number.isFinite(at)) return '';
    const seconds = Math.max(0, (now - at) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(at).toLocaleDateString();
  }

  const KIND_LABEL = Object.freeze({
    commit: 'Commit', pull: 'Pull request', issue: 'Issue', release: 'Release'
  });

  function feedRow(event, now) {
    const row = element('li', 'wp-feed-row');
    const head = element('p', 'wp-feed-head');
    head.append(element('span', `wp-feed-kind wp-feed-kind-${event.kind}`,
      KIND_LABEL[event.kind] || event.kind));
    head.append(element('span', 'wp-feed-repo', event.repo));
    /*
     * The time carries a machine-readable stamp as well as the words. "3h ago"
     * is unreadable to anything that is not a person reading it at this moment,
     * and this card is the one place on the overview where when it happened is
     * the whole point.
     */
    const when = element('time', 'wp-feed-when', since(event.at, now));
    if (Number.isFinite(event.at)) {
      when.setAttribute('datetime', new Date(event.at).toISOString());
      when.setAttribute('title', new Date(event.at).toLocaleString());
    }
    head.append(when);
    row.appendChild(head);

    row.appendChild(element('p', 'wp-feed-title', event.title || event.ref));

    /*
     * The evidence line: which commit, which number, who. Without it the row is
     * a claim the reader cannot go and check, which is the one thing this
     * surface is not allowed to be.
     */
    // Deduplicate the reference, never the actor: a user's name can happen
    // to be a prefix of a hash and remains a different fact.
    const ref = String(event.ref || '').trim();
    const detail = String(event.detail || '').trim();
    const marks = [ref, detail && !ref.startsWith(detail) ? detail : '', event.actor].filter(Boolean);
    if (marks.length) row.appendChild(element('p', 'wp-feed-meta', marks.join(' \u00b7 ')));
    return row;
  }

  /*
   * The feed is fetched, not computed, so unlike the cards above it has a state
   * before it has an answer. All four are drawn rather than left blank: loading,
   * nothing readable, nothing happened, and something happened.
   */
  function renderFeed(host, current) {
    if (!host) return;
    host.textContent = '';
    if (!current || current.loading) {
      host.appendChild(element('p', 'wp-stat-note', 'Reading recent activity\u2026'));
      return;
    }
    if (current.error) {
      host.appendChild(element('p', 'wp-stat-note', current.error));
      return;
    }
    if (!current.inventoryCount && !current.failed?.length) {
      host.appendChild(element('p', 'wp-stat-note',
        'No repositories are available to this session yet. Connect a sandbox repository to see recent activity.'));
    } else if (!current.measured) {
      /* Not measured is not "nothing happened": no repository answered, and
         saying "no recent activity" here would be inventing a quiet week. */
      host.appendChild(element('p', 'wp-stat-note',
        'No repository could be read, so recent activity is not measured.'));
    } else if (!current.events.length) {
      host.appendChild(element('p', 'wp-stat-note',
        `No commits in the last ${current.days} days across the ${current.repositories.length} most recently pushed repositor${current.repositories.length === 1 ? 'y' : 'ies'}.`));
    } else {
      const now = Number.isFinite(current.now) ? current.now : Date.now();
      const list = element('ul', 'wp-feed');
      current.events.forEach(event => list.appendChild(feedRow(event, now)));
      host.appendChild(list);
    }

    if (current.inventoryCount) {
      host.appendChild(element('p', 'wp-stat-note wp-feed-scope',
        `Commits from the last ${current.days} days across ${current.repositories.length} of ${current.inventoryCount} repositor${current.inventoryCount === 1 ? 'y' : 'ies'} in the first inventory page. Up to ${current.perRepositoryLimit || 20} commits per repository${current.truncated ? `; showing ${current.events.length} of ${current.totalEvents} returned commits` : ''}. This is a bounded sample, not a complete activity history.`));
    }
    const readAt = Date.parse(current.generatedAt);
    if (Number.isFinite(readAt)) {
      const stamp = element('time', 'wp-stat-note wp-feed-updated', `Updated ${new Date(readAt).toLocaleString()}`);
      stamp.setAttribute('datetime', new Date(readAt).toISOString());
      host.appendChild(stamp);
    }

    if (current.undated > 0) {
      host.appendChild(element('p', 'wp-stat-note',
        `${current.undated} event${current.undated === 1 ? '' : 's'} reported no time and ${current.undated === 1 ? 'is' : 'are'} not listed above.`));
    }
    if (current.failed && current.failed.length) {
      host.appendChild(element('p', 'wp-stat-note',
        `Not read: ${current.failed.map(entry => `${entry.repo} (${entry.reason})`).join('; ')}.`));
    }
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

  /*
   * The feed renders on its own clock. It arrives from the network while the
   * cards above are already computed from what the session holds, so folding it
   * into render() would mean either holding the whole grid back until a request
   * lands, or repainting cards that have not changed every time it does.
   */
  function renderActivityFeed(root, current) {
    if (!root || typeof document === 'undefined') return current;
    renderFeed(body(root), current);
    return current;
  }

  global.NebulaWorkspacePulse = Object.freeze({
    COMPONENTS, ACTIVITY_BUCKETS, model, render, renderActivityFeed
  });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaWorkspacePulse;
