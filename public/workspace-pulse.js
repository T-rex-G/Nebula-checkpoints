/*
 * The workspace pulse: trust score, capabilities, and activity.
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

  /*
   * Weights sum to 1 across the measured set; unknown components renormalise.
   *
   * Leaked credentials carry the most weight because they are the one reading
   * here that is an incident rather than a posture: a live key in a public
   * tree is being used by somebody else today, whatever else is configured.
   */
  const COMPONENTS = Object.freeze([
    Object.freeze({ id: 'exposure', label: 'Leaked credentials', weight: 0.25 }),
    Object.freeze({ id: 'capabilities', label: 'Verified capabilities', weight: 0.15 }),
    Object.freeze({ id: 'scanning', label: 'Upload scanning', weight: 0.15 }),
    Object.freeze({ id: 'recovery', label: 'Recovery points', weight: 0.15 }),
    Object.freeze({ id: 'authentication', label: 'Credential reach', weight: 0.15 }),
    Object.freeze({ id: 'visibility', label: 'Private repositories', weight: 0.15 })
  ]);

  /*
   * An open critical finding holds the score below this, however well the
   * rest reads. Averaging let five healthy components outvote a leaked
   * production key and print a reassuring number over an active incident.
   */
  const CRITICAL_CAP = 49;

  const GRADES = Object.freeze([
    Object.freeze({ grade: 'A', min: 90 }),
    Object.freeze({ grade: 'B', min: 80 }),
    Object.freeze({ grade: 'C', min: 70 }),
    Object.freeze({ grade: 'D', min: 60 }),
    Object.freeze({ grade: 'F', min: 0 })
  ]);

  function gradeOf(score) {
    if (!Number.isFinite(score)) return null;
    return GRADES.find(entry => score >= entry.min).grade;
  }

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

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  /* owner/name, lower-cased: how every per-repository reading is matched. */
  function repoKey(owner, name) {
    return `${String(owner || '')}/${String(name || '')}`.toLowerCase();
  }

  function connectedKeys(repos) {
    const keys = new Set();
    for (const repo of Array.isArray(repos) ? repos : []) {
      if (!repo) continue;
      const owner = repo.owner && typeof repo.owner === 'object' ? repo.owner.login : repo.owner;
      if (owner && repo.name) keys.add(repoKey(owner, repo.name));
      else if (repo.full_name) keys.add(String(repo.full_name).toLowerCase());
    }
    return keys;
  }

  /*
   * Capability projection: how much of what this provider offers is verified
   * here. The denominator is what is offered -- a capability the provider does
   * not have is a missing feature, not a weakness in this workspace -- and
   * Experimental earns nothing: reachable is not the same as evidenced, and
   * the old half credit is how the dial came to read 79 over a line that said
   * 20 of 35.
   */
  function capabilityComponent(signals) {
    const component = componentById('capabilities');
    if (!signals || !signals.total) {
      return unknown(component, 'Capability projection has not loaded.');
    }
    const offered = signals.supported + signals.experimental;
    if (!offered) return measured(component, 0, 'This provider offers none of the projected capabilities.');
    const parts = [`${signals.supported} of ${offered} offered capabilities verified`];
    if (signals.experimental) parts.push(`${signals.experimental} experimental`);
    if (signals.unavailable) parts.push(`${signals.unavailable} not offered by this provider`);
    return measured(component, signals.supported / offered, `${parts.join(' \u00b7 ')}.`);
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

  /*
   * Leaked credentials, from this person's newest finished scan of each
   * connected repository. Severity decides the reading; coverage bounds it --
   * one clean repository out of thirty is not a clean workspace, and saying
   * "healthy" over twenty-nine unread trees would be the score making a claim
   * the scanner never made.
   */
  function exposureComponent(posture, repos) {
    const component = componentById('exposure');
    if (!posture || !posture.exposure) return unknown(component, 'The exposure summary has not loaded.');
    if (!posture.exposure.available) {
      return unknown(component, 'Exposure scanning needs the server database, so nothing has been scanned here.');
    }
    const keys = connectedKeys(repos);
    const all = Array.isArray(posture.exposure.repositories) ? posture.exposure.repositories : [];
    const scanned = keys.size ? all.filter(entry => keys.has(repoKey(entry.owner, entry.repo))) : all;
    if (!scanned.length) {
      return unknown(component, 'No connected repository has been scanned for leaked credentials yet.');
    }
    const open = { critical: 0, serious: 0, warning: 0 };
    let partial = 0;
    for (const entry of scanned) {
      for (const severity of Object.keys(open)) {
        const count = Math.floor(Number(entry.open && entry.open[severity]));
        if (Number.isFinite(count) && count > 0) open[severity] += count;
      }
      if (entry.partial) partial += 1;
    }
    const total = open.critical + open.serious + open.warning;
    const connected = keys.size || scanned.length;
    const coverage = Math.min(1, scanned.length / connected);
    const read = scanned.length === connected
      ? (connected === 1 ? 'the connected repository was scanned' : `all ${connected} connected repositories scanned`)
      : `${scanned.length} of ${connected} repositories scanned`;
    const partialNote = partial ? `, ${plural(partial, 'scan', 'scans')} partial` : '';
    if (total) {
      const worst = open.critical ? 'critical' : open.serious ? 'serious' : 'warning';
      const counts = ['critical', 'serious', 'warning']
        .filter(severity => open[severity])
        .map(severity => `${open[severity]} ${severity}`)
        .join(', ');
      const ratio = worst === 'critical' ? 0 : worst === 'serious' ? 0.4 : 0.75;
      return Object.freeze({
        ...measured(component, ratio, `${plural(total, 'leaked credential', 'leaked credentials')} still exposed (${counts}); ${read}${partialNote}.`),
        open: Object.freeze(open)
      });
    }
    return Object.freeze({
      ...measured(component, 0.6 + (0.4 * coverage), `No open leaked credentials; ${read}${partialNote}.`),
      open: Object.freeze(open)
    });
  }

  /*
   * Recovery points that exist, not recovery the provider could offer. The
   * old reading was the capability alone, which let the overview print
   * "healthy" beside a topology that said Gap for the same repository.
   */
  function recoveryComponent(recoveryStatus, posture, repos, localSnapshots) {
    const component = componentById('recovery');
    if (!recoveryStatus) return unknown(component, 'Recovery capability has not loaded.');
    if (recoveryStatus === 'Unavailable') return measured(component, 0, 'Recovery is not offered for this provider.');
    const keys = connectedKeys(repos);
    if (!keys.size) return unknown(component, 'No repositories have loaded.');
    const local = localSnapshots instanceof Set ? localSnapshots : new Set();
    const server = posture && posture.recovery && Array.isArray(posture.recovery.repositories)
      ? posture.recovery.repositories : [];
    if (!posture && !local.size) return unknown(component, 'Recovery points have not loaded.');
    const serverKeys = new Set(server.map(entry => repoKey(entry.owner, entry.repo)));
    let signed = 0;
    let covered = 0;
    for (const key of keys) {
      if (serverKeys.has(key)) { signed += 1; covered += 1; }
      else if (local.has(key)) covered += 1;
    }
    const parts = [keys.size === 1
      ? (covered ? 'The connected repository has a recovery point' : 'The connected repository has no recovery point')
      : `${covered} of ${keys.size} repositories have a recovery point`];
    if (covered && signed < covered) parts.push(`${covered - signed} held only in this browser`);
    if (posture && posture.recovery && posture.recovery.available === false) parts.push('signed snapshots need the server database');
    return measured(component, covered / keys.size, `${parts.join('; ')}.`);
  }

  /*
   * The credential's reach, as the provider reported it for the token that is
   * signed in: its kind, its scopes and its expiry. An installation is scored
   * from the identity alone when the posture has not loaded, because an
   * installation is limited by construction; a token is not scored until its
   * report arrives, because a guess is how every token came to be described as
   * "broader scope" whatever it actually was.
   */
  function authenticationComponent(identity, posture) {
    const component = componentById('authentication');
    if (!identity) return unknown(component, 'Identity has not loaded.');
    const credential = posture && posture.credential;
    if (credential && typeof credential.detail === 'string') {
      return Number.isFinite(credential.rating)
        ? measured(component, credential.rating, credential.detail)
        : unknown(component, credential.detail);
    }
    if (identity.installationId || identity.authMethod === 'github-app') {
      return measured(component, 1, 'GitHub App installation: short-lived tokens, limited to the repositories the installation was given.');
    }
    return unknown(component, 'The credential\u2019s scopes and expiry have not loaded.');
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
      exposureComponent(input.posture, input.repos),
      capabilityComponent(signals),
      scanningComponent(input.scanner),
      recoveryComponent(input.recoveryStatus, input.posture, input.repos, input.localSnapshots),
      authenticationComponent(input.identity, input.posture),
      visibilityComponent(input.repos)
    ]);

    const known = components.filter(component => component.status !== 'unknown');
    const weight = known.reduce((total, component) => total + component.weight, 0);
    const mean = weight > 0
      ? Math.round((known.reduce((total, c) => total + (c.ratio * c.weight), 0) / weight) * 100)
      : null;
    const exposure = components[0];
    const capped = mean !== null && !!(exposure.open && exposure.open.critical) && mean > CRITICAL_CAP;
    const score = capped ? CRITICAL_CAP : mean;

    return Object.freeze({
      trust: Object.freeze({
        score,
        grade: gradeOf(score),
        capped,
        status: score === null ? 'unknown' : ratioStatus(score / 100),
        measuredCount: known.length,
        componentCount: components.length,
        attention: components.filter(c => c.status === 'warning' || c.status === 'critical').length,
        components
      }),
      signals: Object.freeze({
        measured: !!signals,
        live: signals ? signals.supported : 0,
        total: signals ? signals.total : 0,
        breakdown: Object.freeze(signals ? [
          Object.freeze({ id: 'supported', label: 'Verified', count: signals.supported, status: 'good' }),
          Object.freeze({ id: 'experimental', label: 'Experimental', count: signals.experimental, status: 'warning' }),
          Object.freeze({ id: 'unavailable', label: 'Not offered', count: signals.unavailable, status: 'muted' })
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

  function numbersTable(caption, headings, rows, note) {
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
    if (note) details.appendChild(element('p', 'wp-numbers-note', note));
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
    if (trust.grade) {
      /*
       * The letter is the score read at a coarser grain, not a second
       * measurement: the bands are fixed and printed in the table below, so a
       * reader can check the one against the other.
       */
      const grade = element('p', `wp-grade wp-${trust.status}`);
      grade.append(element('span', 'wp-grade-letter', trust.grade), element('span', 'wp-grade-word', 'grade'));
      grade.setAttribute('aria-label', `Grade ${trust.grade}`);
      readout.appendChild(grade);
    }
    readout.appendChild(element('p', 'wp-hero-note', trust.score === null
      ? 'No signal has loaded yet.'
      : `From ${trust.measuredCount} of ${trust.componentCount} signals measured in this session.`));
    if (trust.capped) {
      readout.appendChild(element('p', 'wp-hero-note wp-cap-note',
        'Held below 50 while a critical leaked credential is still exposed. Rotate it, or record that the provider rejects it, to lift the cap.'));
    }
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
      ['Signal', 'Weight', 'Reading', 'State'],
      trust.components.map(component => [
        component.label,
        `${Math.round(component.weight * 100)}%`,
        component.ratio === null ? 'not measured' : `${Math.round(component.ratio * 100)}%`,
        STATUS_WORD[component.status]
      ]),
      `Weights renormalise across the signals measured. Grades: ${GRADES.map((entry, index) => (
        index === GRADES.length - 1 ? `${entry.grade} below ${GRADES[index - 1].min}` : `${entry.grade} ${entry.min}+`
      )).join(', ')}. An open critical leaked credential caps the score at ${CRITICAL_CAP}.`
    ));
  }

  /*
   * Part-to-whole across three states of one total. Segments are separated by a
   * surface-coloured gap so adjacent fills never blend into one mark.
   */
  function renderSignals(host, signals) {
    host.textContent = '';
    const head = element('div', 'wp-stat');
    head.appendChild(element('span', 'wp-label', 'CAPABILITIES'));
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
   * The area the design draws across the bottom of the card: a one-hue
   * stroke, dark to light, over a fade of the same hue, bled past the card's padding so the plot reads
   * as the card's own surface rather than as a boxed widget sitting on it.
   *
   * Gradient ids are namespaced per card. Two cards with the same id would have
   * the second silently paint with the first's ramp, which is the kind of bug
   * that looks like a rendering quirk and never gets traced.
   */
  /*
   * The spacing at which a dot is still its own mark rather than a bead on a
   * chain. Below this the line is left to carry the shape by itself.
   */
  const DOT_SPACING = 12;
  const FEED_FOLD_KEY = 'nv_feed_rows_open';
  let areaSequence = 0;

  /*
   * The shared marks every chart on this card is drawn from.
   *
   * One <defs> factory rather than a gradient declared inside each chart: the
   * three cards are rendered independently and re-rendered on refresh, and
   * duplicated gradient ids across a document resolve to whichever one the
   * browser parsed last -- which is how a card ends up borrowing another
   * card's colours after a repaint.
   *
   * The pieces here are the whole visual vocabulary: a stroke gradient along
   * the series, a fill that fades the same hue to nothing, a 45-degree hatch
   * for a period that is not finished yet, and a soft outer glow. All of them
   * are ordinary SVG, which is the same technique the rest of this module
   * already uses -- there is no library behind any of it.
   */
  function chartDefs(id, options) {
    const settings = options || {};
    const defs = svg('defs', {});

    const stroke = svg('linearGradient', { id: `${id}-s`, x1: 0, y1: 0, x2: 1, y2: 0 });
    /* One hue, dark to light along the series, so the latest end is the
       brightest. The colours are the stylesheet's: see .wp-stroke-*. */
    stroke.appendChild(svg('stop', { offset: '0%', class: 'wp-stroke-from' }));
    stroke.appendChild(svg('stop', { offset: '100%', class: 'wp-stroke-to' }));
    defs.appendChild(stroke);

    const fill = svg('linearGradient', { id: `${id}-f`, x1: 0, y1: 0, x2: 0, y2: 1 });
    fill.appendChild(svg('stop', { offset: '0%', class: 'wp-fade-stop', 'stop-opacity': '.34' }));
    fill.appendChild(svg('stop', { offset: '72%', class: 'wp-fade-stop', 'stop-opacity': '.05' }));
    fill.appendChild(svg('stop', { offset: '100%', class: 'wp-fade-stop', 'stop-opacity': '0' }));
    defs.appendChild(fill);

    /*
     * The glow is drawn wide enough to hold the blur. A filter region defaults
     * to a tenth of the box on each side, which clips the bloom off the ends
     * of a stroke that runs to the edge of its viewBox and leaves a visible
     * square shadow where the region stops.
     */
    if (settings.glow) {
      const glow = svg('filter', {
        id: `${id}-g`, x: '-30%', y: '-30%', width: '160%', height: '160%',
        filterUnits: 'objectBoundingBox'
      });
      glow.appendChild(svg('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: settings.glow, result: 'b' }));
      const merge = svg('feMerge', {});
      merge.appendChild(svg('feMergeNode', { in: 'b' }));
      merge.appendChild(svg('feMergeNode', { in: 'SourceGraphic' }));
      glow.appendChild(merge);
      defs.appendChild(glow);
    }
    return defs;
  }

  /*
   * Motion has one owner on this page already -- the data-motion setting and
   * the OS preference -- so a chart asks rather than decides. A reveal that
   * ignores either is a chart that animates for a reader who asked it not to.
   */
  function motionAllowed() {
    if (document.documentElement.dataset.motion === 'off') return false;
    try {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return true; }
  }

  /*
   * A hairline grid, drawn solid.
   *
   * Dashed gridlines are the house style of most chart libraries and they are
   * a mistake: a dash reads as a threshold or a projection, so a grid drawn
   * that way says "target" four times on a chart that has no target. One
   * shade off the surface, solid, and the eye stops seeing it as soon as it
   * has used it.
   */
  function gridLines(chart, geometry, ticks) {
    for (const tick of ticks) {
      chart.appendChild(svg('line', {
        class: 'wp-grid-line',
        x1: geometry.padX, y1: tick.y, x2: geometry.width - geometry.padX, y2: tick.y,
        'vector-effect': 'non-scaling-stroke'
      }));
    }
  }

  /*
   * A monotone curve, not a spline.
   *
   * The block this composition follows uses a curved line. The usual way to
   * get one -- Catmull-Rom through the points -- can overshoot: its tangents
   * are set from the neighbours without regard to direction, so between a zero
   * and a spike the curve is free to swing past both, and a chart of counts
   * can draw itself going negative.
   *
   * Fritsch-Carlson clamps each tangent where the direction changes and zeroes
   * it across flat runs, so the curve provably cannot leave the interval its
   * own readings define. It is chosen for that property rather than for a
   * defect observed here: against this product's series -- a trailing count,
   * which moves as plateaus rather than isolated spikes -- both fits measure
   * the same, and no fixture was found where the unclamped one leaves the
   * plot. The guarantee is the point. A future series with sharper steps is
   * exactly the case that would have needed it, and it will not be obvious
   * that it did.
   */
  function monotonePath(points) {
    if (points.length < 2) return points.length ? `M${points[0].x},${points[0].y}` : '';
    const n = points.length;
    const slope = [];
    for (let i = 0; i < n - 1; i += 1) {
      const dx = points[i + 1].x - points[i].x;
      slope.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx);
    }
    const tangent = [slope[0]];
    for (let i = 1; i < n - 1; i += 1) {
      if (slope[i - 1] * slope[i] <= 0) {
        /* A turning point: a zero tangent is what stops the curve carrying
           its previous direction past the reading and overshooting it. */
        tangent.push(0);
      } else {
        tangent.push((slope[i - 1] + slope[i]) / 2);
      }
    }
    tangent.push(slope[n - 2]);
    for (let i = 0; i < n - 1; i += 1) {
      if (slope[i] === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
      const a = tangent[i] / slope[i];
      const b = tangent[i + 1] / slope[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        tangent[i] = (3 / h) * a * slope[i];
        tangent[i + 1] = (3 / h) * b * slope[i];
      }
    }
    let path = `M${points[0].x},${points[0].y}`;
    for (let i = 0; i < n - 1; i += 1) {
      const dx = (points[i + 1].x - points[i].x) / 3;
      path += ` C${round(points[i].x + dx)},${round(points[i].y + tangent[i] * dx)}`
        + ` ${round(points[i + 1].x - dx)},${round(points[i + 1].y - tangent[i + 1] * dx)}`
        + ` ${points[i + 1].x},${points[i + 1].y}`;
    }
    return path;
  }

  const round = value => Math.round(value * 10) / 10;

  /*
   * The area chart.
   *
   * Not stretched. preserveAspectRatio="none" made the card's width scale the
   * viewBox horizontally and not vertically, so a 2-unit stroke arrived on
   * screen as a 2-unit vertical and a much thinner horizontal, and every
   * circle came out an ellipse -- which is why the old endpoint mark had to be
   * drawn in screen units to survive. The box keeps its ratio now and the
   * marks are simply the size they say they are.
   */
  function areaChart(values, label, options) {
    const settings = options || {};
    /*
     * Drawn at the width it will be shown at. A fixed 380-unit box scaled to
     * a card three times that wide arrived with its axis labels at three
     * times their size, its dots as coins and its stroke as a bar: every mark
     * grew with the card. With the box matched to the card, a unit is a
     * pixel, and the plot grows taller only in step and within bounds.
     */
    const width = Math.max(280, Math.min(1600, Math.round(settings.width || 380)));
    const plotH = Math.round(Math.max(96, Math.min(176, width * 0.2)));
    const padX = 16;
    const padTop = 14;
    /* The band the x labels sit in is part of the box. A container sized to
       the plot alone gives the card its own small vertical scrollbar. */
    const axisBand = 18;
    const height = padTop + plotH + axisBand;
    const plotW = width - padX * 2;
    const id = `wp-area-${areaSequence += 1}`;
    const peak = Math.max(...values, 1);
    const step = values.length > 1 ? plotW / (values.length - 1) : plotW;
    const at = (value, index) => ({
      x: Math.round((padX + index * step) * 10) / 10,
      y: Math.round((padTop + (1 - value / peak) * plotH) * 10) / 10
    });
    const points = values.map(at);
    const baseY = padTop + plotH;

    const chart = svg('svg', {
      class: 'wp-area', viewBox: `0 0 ${width} ${height}`,
      role: 'img', 'aria-label': label
    });
    chart.appendChild(chartDefs(id, { glow: 2.4 }));

    /* Three lines: the peak, the middle and the floor. More than that on a
       96-unit plot is chrome competing with the series. */
    gridLines(chart, { padX, width }, [0, 0.5, 1].map(fraction => ({
      y: Math.round((padTop + fraction * plotH) * 10) / 10
    })));

    const curve = monotonePath(points);
    chart.appendChild(svg('path', {
      d: `${curve} L${width - padX},${baseY} L${padX},${baseY} Z`, fill: `url(#${id}-f)`
    }));

    const line = svg('path', {
      class: 'wp-area-line', d: curve,
      fill: 'none', stroke: `url(#${id}-s)`,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      filter: `url(#${id}-g)`
    });
    chart.appendChild(line);

    /*
     * The reveal draws the line on rather than fading the card in: a wipe
     * follows the direction the data is read in, so the eye arrives at the
     * most recent reading last. It is one animated presentation attribute on
     * one element, and it is skipped entirely when motion is off.
     */
    if (motionAllowed() && settings.reveal !== false && points.length > 1) {
      /*
       * Measured off the curve, not the chord. Summing the straight-line gaps
       * under-counts a curved path, and a dasharray shorter than the path it
       * hides leaves the tail of the line drawn before the reveal starts.
       */
      const length = typeof line.getTotalLength === 'function'
        ? line.getTotalLength()
        : points.reduce((total, point, index) => index === 0 ? 0
          : total + Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y), 0);
      line.setAttribute('stroke-dasharray', String(length));
      line.setAttribute('stroke-dashoffset', String(length));
      const draw = svg('animate', {
        attributeName: 'stroke-dashoffset', from: String(length), to: '0',
        dur: '.7s', fill: 'freeze', calcMode: 'spline',
        keySplines: '.22 .61 .36 1', keyTimes: '0;1', values: `${length};0`
      });
      line.appendChild(draw);
    }

    /*
     * Dots only when they can be read as dots.
     *
     * They exist to say where the readings are, because without them a flat
     * run cannot be told from a line drawn between two distant points. At the
     * sixty-day window this series actually uses, the readings are under six
     * units apart and a 2.2-unit dot on each one is not sixty marks, it is a
     * bead chain laid over the line -- chrome pretending to be data. Below
     * the spacing where a dot is still its own mark, they are drawn; above
     * it, the line carries the shape on its own and the endpoint carries the
     * reading. A value is never printed on every point either way.
     */
    if (step >= DOT_SPACING) {
      for (const point of points) {
        chart.appendChild(svg('circle', {
          class: 'wp-area-dot', cx: point.x, cy: point.y, r: 2.2
        }));
      }
    }
    const last = points[points.length - 1];
    if (last) {
      /*
       * The latest reading pings. A halo that breathes under a solid core says
       * "this end is live" without a label saying so -- and it is the one mark
       * on the card that moves, so it cannot be confused with decoration. It
       * is drawn before the core, and it is dropped entirely when motion is
       * off rather than left as a static ring the reader has to interpret.
       */
      if (motionAllowed()) {
        const halo = svg('circle', { class: 'wp-area-ping', cx: last.x, cy: last.y, r: 4 });
        halo.appendChild(svg('animate', {
          attributeName: 'r', values: '4;11;4', dur: '2.4s', repeatCount: 'indefinite',
          calcMode: 'spline', keyTimes: '0;.5;1', keySplines: '.4 0 .6 1;.4 0 .6 1'
        }));
        halo.appendChild(svg('animate', {
          attributeName: 'opacity', values: '.5;0;.5', dur: '2.4s', repeatCount: 'indefinite',
          calcMode: 'spline', keyTimes: '0;.5;1', keySplines: '.4 0 .6 1;.4 0 .6 1'
        }));
        chart.appendChild(halo);
      }
      chart.appendChild(svg('circle', { class: 'wp-area-head', cx: last.x, cy: last.y, r: 4 }));
      /*
       * The endpoint is labelled only when nothing above it already says the
       * number. With the header carrying the figure, a readout here prints it
       * twice within a couple of centimetres -- and a reader who sees the same
       * value in two places starts looking for the difference between them.
       */
      if (!settings.headline) {
        const readout = svg('text', {
          class: 'wp-area-value', x: Math.min(last.x, width - padX - 2), y: Math.max(last.y - 10, 10),
          'text-anchor': last.x > width - padX - 24 ? 'end' : 'middle'
        });
        readout.textContent = String(values[values.length - 1]);
        chart.appendChild(readout);
      }
    }

    /*
     * The hover layer: a crosshair, a ring on the reading and a label that
     * names the day and the count. The marks are hit by column, not by dot --
     * a target the width of a day, the full height of the plot -- so a reader
     * does not have to land on a 2-unit circle. It is a mouse affordance; the
     * same numbers are in the table under the chart for every reader.
     */
    if (points.length > 1 && typeof chart.addEventListener === 'function') {
      const hover = svg('g', { class: 'wp-hover', 'aria-hidden': 'true' });
      const rule = svg('line', { class: 'wp-hover-rule', x1: 0, y1: padTop, x2: 0, y2: baseY });
      const ring = svg('circle', { class: 'wp-hover-dot', cx: 0, cy: 0, r: 4.5 });
      const tip = svg('g', { class: 'wp-hover-tip' });
      const plate = svg('rect', { class: 'wp-hover-plate', x: 0, y: 0, width: 10, height: 24, rx: 7 });
      const text = svg('text', { class: 'wp-hover-text', x: 0, y: 0 });
      tip.append(plate, text);
      hover.append(rule, ring, tip);
      chart.appendChild(hover);
      /*
       * The target the pointer lands on: the whole plot, transparent. SVG hit
       * tests only what is painted, and the empty space of a chart -- above
       * the line, right of the last reading -- is most of it; Chrome 149
       * stopped treating that space as the <svg> element's, so a pointer
       * arriving there reached nothing and the reading never showed.
       */
      chart.appendChild(svg('rect', {
        class: 'wp-hit', x: 0, y: 0, width, height, fill: 'transparent'
      }));
      const name = index => (settings.labels && settings.labels[index] !== undefined ? settings.labels[index] : '');
      const show = index => {
        const at = points[index];
        if (!at) return;
        hover.classList.add('is-on');
        chart.dataset.hover = String(index);
        rule.setAttribute('x1', at.x); rule.setAttribute('x2', at.x);
        ring.setAttribute('cx', at.x); ring.setAttribute('cy', at.y);
        const said = name(index);
        text.textContent = said ? `${said} \u00b7 ${values[index]}` : String(values[index]);
        const textWidth = typeof text.getComputedTextLength === 'function' ? text.getComputedTextLength() : text.textContent.length * 6.4;
        const boxW = Math.ceil(textWidth + 18);
        const left = Math.max(2, Math.min(width - boxW - 2, at.x - boxW / 2));
        const top = Math.max(2, at.y - 36);
        plate.setAttribute('x', left); plate.setAttribute('y', top); plate.setAttribute('width', boxW);
        text.setAttribute('x', left + 9); text.setAttribute('y', top + 16);
      };
      const hide = () => {
        hover.classList.remove('is-on');
        delete chart.dataset.hover;
      };
      const follow = event => {
        if (event.pointerType && event.pointerType !== 'mouse') return;
        const box = chart.getBoundingClientRect();
        if (!box.width) return;
        const x = (event.clientX - box.left) * (width / box.width);
        show(Math.max(0, Math.min(points.length - 1, Math.round((x - padX) / step))));
      };
      chart.addEventListener('pointerenter', follow);
      chart.addEventListener('pointermove', follow);
      chart.addEventListener('pointerleave', hide);
      /* A refit replaces the chart under a pointer that may not move again;
         the replacement is told which reading was showing (fittedArea). */
      chart.addEventListener('wp-hover', event => show(event.detail));
    }

    if (settings.axis && settings.axis.length) {
      for (const mark of settings.axis) {
        const text = svg('text', {
          class: 'wp-area-axis',
          x: at(0, mark.index).x, y: height - 5,
          'text-anchor': mark.index === 0 ? 'start' : (mark.index === values.length - 1 ? 'end' : 'middle')
        });
        text.textContent = mark.label;
        chart.appendChild(text);
      }
    }
    return chart;
  }

  /*
   * An area chart that fits its card, and refits when the card changes width
   * by more than a hair -- a rail collapsing, a window resized, a phone turned.
   * The redraw replaces the chart in place and skips the draw-on reveal: the
   * reader has already seen the line arrive once.
   */
  function fittedArea(host, values, label, options) {
    const measure = () => Math.round(host.getBoundingClientRect ? host.getBoundingClientRect().width : 0) || 380;
    let drawn = measure();
    let chart = areaChart(values, label, Object.assign({}, options, { width: drawn }));
    host.appendChild(chart);
    if (typeof ResizeObserver === 'function') {
      const watcher = new ResizeObserver(() => {
        if (!chart.isConnected) { watcher.disconnect(); return; }
        const now = measure();
        if (Math.abs(now - drawn) < 24) return;
        drawn = now;
        const next = areaChart(values, label, Object.assign({}, options, { width: now, reveal: false }));
        const showing = chart.dataset.hover;
        chart.replaceWith(next);
        chart = next;
        if (showing !== undefined && typeof CustomEvent === 'function') {
          next.dispatchEvent(new CustomEvent('wp-hover', { detail: Number(showing) }));
        }
      });
      watcher.observe(host);
    }
    return chart;
  }

  /*
   * Languages across the connected set, as a radar.
   *
   * This replaced a tile that read "Languages 7". Seven is true and it is not
   * an answer: it cannot say which seven, nor that one of them is nearly the
   * whole estate and the rest are a file each. A radar puts every language on
   * its own spoke against a shared scale, so the shape of the estate is the
   * thing you see rather than a number you have to go and expand.
   *
   * Three spokes minimum, because a polygon needs three corners: with one or
   * two languages the chart is a line or a dot pretending to be a shape, and
   * the caller is told to keep its tile instead. Eight maximum, because past
   * that the labels collide and every extra spoke is a slice of angle nobody
   * can measure -- the tail folds into one "Other" spoke that says how many
   * it stands for.
   */
  const RADAR_MIN_AXES = 3;
  const RADAR_MAX_AXES = 8;

  function languageSpread(repos) {
    const counts = new Map();
    for (const repo of Array.isArray(repos) ? repos : []) {
      const name = repo && typeof repo.language === 'string' ? repo.language.trim() : '';
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const ranked = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    if (ranked.length <= RADAR_MAX_AXES) {
      return ranked.map(([label, count]) => ({ label, count }));
    }
    const kept = ranked.slice(0, RADAR_MAX_AXES - 1).map(([label, count]) => ({ label, count }));
    const rest = ranked.slice(RADAR_MAX_AXES - 1);
    kept.push({
      label: 'Other',
      count: rest.reduce((total, entry) => total + entry[1], 0),
      folded: rest.length
    });
    return kept;
  }

  /*
   * A language name is as long as it is.
   *
   * "TypeScript" at the nine-o'clock spoke is anchored to its end, so it grows
   * leftwards from the web -- and in a square box it grew straight off the
   * edge and arrived as "eScript". The box is wider than it is tall now, with
   * the extra width spent entirely on the gutters the side labels sit in, and
   * anything past the cap is elided with its full name kept on the mark.
   */
  const RADAR_LABEL_MAX = 13;

  function radarChart(axes, label) {
    const width = 340;
    const height = 272;
    const centre = { x: width / 2, y: height / 2 };
    const radius = 74;
    const id = `wp-radar-${areaSequence += 1}`;
    const peak = Math.max(...axes.map(axis => axis.count), 1);
    const step = (Math.PI * 2) / axes.length;
    /* Start at twelve o'clock: a polygon that begins at three reads as
       rotated, and a reader compares spokes against vertical without being
       asked to. */
    const point = (index, ratio) => {
      const angle = -Math.PI / 2 + index * step;
      return {
        x: Math.round((centre.x + Math.cos(angle) * radius * ratio) * 10) / 10,
        y: Math.round((centre.y + Math.sin(angle) * radius * ratio) * 10) / 10
      };
    };
    const ring = ratio => axes.map((_, index) => {
      const at = point(index, ratio);
      return `${at.x},${at.y}`;
    }).join(' ');

    const chart = svg('svg', {
      class: 'wp-radar', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label
    });

    const defs = svg('defs', {});
    /*
     * A tint laid across the shape, not a light behind it.
     *
     * The fill was a radial gradient bright at the centre, and over a violet
     * card that centre read as a magenta core sitting inside the polygon --
     * a second object, brighter than the outline that is supposed to carry
     * the reading. It runs along the same diagonal as the stroke now, at an
     * alpha low enough that the fill says "inside" and nothing else.
     */
    /*
     * Classed rather than written as attributes, so the stylesheet owns the
     * colour and the alpha. The theme can be toggled after the chart is on
     * screen -- app.js sets data-theme and does not redraw the overview -- and
     * an attribute written at build time would keep whichever theme's value
     * was current then. The light surface needs a stronger fill than the dark
     * one to read as the same tint; the stylesheet says how much.
     */
    const fill = svg('linearGradient', { id: `${id}-r`, x1: 0, y1: 0, x2: 1, y2: 1 });
    fill.appendChild(svg('stop', { offset: '0%', class: 'wp-radar-fill-from' }));
    fill.appendChild(svg('stop', { offset: '100%', class: 'wp-radar-fill-to' }));
    defs.appendChild(fill);
    const stroke = svg('linearGradient', { id: `${id}-s`, x1: 0, y1: 0, x2: 1, y2: 1 });
    stroke.appendChild(svg('stop', { offset: '0%', class: 'wp-stroke-from' }));
    stroke.appendChild(svg('stop', { offset: '100%', class: 'wp-stroke-to' }));
    defs.appendChild(stroke);
    chart.appendChild(defs);

    /* Four rings and one spoke per axis, solid hairlines. The library this is
       modelled on dashes them; a dash reads as a threshold, and a web made of
       thresholds is four rings of meaning that is not there. */
    for (const ratio of [0.25, 0.5, 0.75, 1]) {
      chart.appendChild(svg('polygon', { class: 'wp-radar-ring', points: ring(ratio) }));
    }
    axes.forEach((_, index) => {
      const outer = point(index, 1);
      chart.appendChild(svg('line', {
        class: 'wp-radar-spoke', x1: centre.x, y1: centre.y, x2: outer.x, y2: outer.y
      }));
    });

    const shape = svg('polygon', {
      class: 'wp-radar-area', points: ring(0).split(' ').length ? ring(0) : '',
      fill: `url(#${id}-r)`, stroke: `url(#${id}-s)`
    });
    const full = axes.map((axis, index) => {
      const at = point(index, axis.count / peak);
      return `${at.x},${at.y}`;
    }).join(' ');
    shape.setAttribute('points', full);
    chart.appendChild(shape);

    /*
     * The reveal grows the polygon out of the centre rather than fading it in,
     * so the vertices stay on the shape while it arrives instead of hanging in
     * their final positions over a growing fill.
     */
    if (motionAllowed()) {
      shape.setAttribute('points', ring(0));
      shape.appendChild(svg('animate', {
        attributeName: 'points', dur: '.8s', fill: 'freeze',
        calcMode: 'spline', keyTimes: '0;1', keySplines: '.22 .61 .36 1',
        values: `${ring(0)};${full}`
      }));
    }

    axes.forEach((axis, index) => {
      const at = point(index, axis.count / peak);
      const dot = svg('circle', { class: 'wp-radar-dot', cx: at.x, cy: at.y, r: 3.2 });
      dot.appendChild(svg('title', {})).textContent =
        `${axis.label}: ${axis.count} repositor${axis.count === 1 ? 'y' : 'ies'}` +
        (axis.folded ? ` across ${axis.folded} languages` : '');
      chart.appendChild(dot);
      /* The label sits just past its own spoke, anchored by which side of the
         circle it is on, so nothing overlaps the web it belongs to. */
      const seat = point(index, 1.18);
      const text = svg('text', {
        class: 'wp-radar-label', x: seat.x, y: seat.y + 3,
        'text-anchor': Math.abs(seat.x - centre.x) < 6 ? 'middle' : (seat.x > centre.x ? 'start' : 'end')
      });
      text.textContent = axis.label.length > RADAR_LABEL_MAX
        ? `${axis.label.slice(0, RADAR_LABEL_MAX - 1)}\u2026` : axis.label;
      /* The full name stays reachable on the label as well as the vertex, so
         an elided spoke is never a language the reader cannot identify. */
      if (text.textContent !== axis.label) {
        text.appendChild(svg('title', {})).textContent = axis.label;
      }
      chart.appendChild(text);
    });
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
    /*
     * The figure leads, the sentence explains.
     *
     * The card used to open with a sentence carrying a number inside it, which
     * puts the one fact a reader came for behind a clause they have to parse.
     * The count sits on its own now, right-aligned against the description, so
     * the card answers "how much" before it is read at all -- and the sentence
     * underneath still says what the count is of and over what window, because
     * a bare figure with no grain is the other way to mislead.
     */
    const stat = element('div', 'wp-area-head-row');
    const said = element('div', 'wp-area-head-said');
    said.append(
      element('p', 'wp-area-head-title', 'Repositories pushed'),
      element('p', 'wp-area-head-desc',
        `trailing ${activity.rollingDays}-day count, last ${activity.windowDays} days`)
    );
    const figure = element('p', 'wp-area-head-figure', String(activity.windowTotal));
    figure.append(element('span', 'wp-area-head-of', `of ${activity.total}`));
    stat.append(said, figure);
    host.appendChild(stat);
    /*
     * Two labels, not thirty. The series is one reading per day over a month,
     * and a tick under every one of them is a band of unreadable text that
     * tells the reader nothing the ends do not already say.
     */
    fittedArea(host,
      activity.series,
      `Repositories pushed, as a trailing ${activity.rollingDays}-day count over the last ${activity.windowDays} days.`,
      {
        headline: true,
        labels: activity.series.map((_, index) => {
          const back = activity.series.length - 1 - index;
          return back === 0 ? 'today' : `${back}d ago`;
        }),
        axis: [
          { index: 0, label: `${activity.windowDays}d ago` },
          { index: activity.series.length - 1, label: 'today' }
        ]
      }
    );

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
  /*
   * The feed's own events, counted into days.
   *
   * Derived rather than requested: a second read would be a second set of
   * provider round trips for numbers this card already holds, and two reads
   * of a moving target disagree. Days are walked backwards from now so the
   * last slot is today whatever hour it is, and an event with no usable time
   * is left out of the count rather than dropped into the nearest day -- the
   * feed reports those separately and this chart must not quietly absorb them.
   */
  function dailyCommits(events, now, days) {
    const span = Math.max(1, Math.min(Number(days) || 7, 60));
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const today = midnight.getTime();
    const bars = [];
    for (let back = span - 1; back >= 0; back -= 1) {
      const at = today - back * DAY;
      bars.push({
        at,
        count: 0,
        partial: back === 0,
        label: back === 0 ? 'today'
          : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      });
    }
    for (const event of Array.isArray(events) ? events : []) {
      const at = Number.isFinite(event && event.at) ? event.at : Date.parse((event && event.at) || '');
      if (!Number.isFinite(at)) continue;
      const age = Math.floor((today - new Date(at).setHours(0, 0, 0, 0)) / DAY);
      if (age >= 0 && age < span) bars[span - 1 - age].count += 1;
    }
    return bars;
  }

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
      /*
       * The shape first, then the rows.
       *
       * The list answers "what changed" one entry at a time, which is right
       * for reading a single change and wrong for seeing a week: thirty rows
       * of text cannot show that the middle of the week was quiet. The bars
       * are the same events counted per day, so nothing new is fetched and
       * nothing can disagree -- and the last bar is hatched because today is
       * still being counted, which is the difference between a short bar and
       * a finished one.
       */
      /*
       * The same block as the card above it, not a second chart language.
       *
       * These two cards sit one under the other and answer the same kind of
       * question over the same kind of window, so drawing one as bars and the
       * other as an area made the overview read as two products. The bars also
       * lost: at one slot per day most of them are a thin sliver on a baseline,
       * and the shape of a week is carried by the gaps rather than by anything
       * drawn. The area gives the same counts a line to follow.
       *
       * The header carries the figure, as it does above, so the plot is not
       * asked to print a number as well as draw one.
       */
      const bars = dailyCommits(current.events, now, current.days);
      const stat = element('div', 'wp-area-head-row');
      const said = element('div', 'wp-area-head-said');
      said.append(
        element('p', 'wp-area-head-title', 'Commits'),
        /* The window and the caveat belong together on the description line.
           "today still counting" under the figure was as wide as the figure's
           whole column and collided with this line beside it. */
        element('p', 'wp-area-head-desc', `last ${current.days} days · today still counting`)
      );
      const figure = element('p', 'wp-area-head-figure', String(current.events.length));
      figure.append(element('span', 'wp-area-head-of',
        `${current.repositories.length} repositor${current.repositories.length === 1 ? 'y' : 'ies'}`));
      stat.append(said, figure);
      host.appendChild(stat);
      fittedArea(host,
        bars.map(bar => bar.count),
        `Commits per day over the last ${current.days} days.`,
        {
          headline: true,
          labels: bars.map(bar => bar.label),
          axis: [
            { index: 0, label: bars[0] ? bars[0].label : '' },
            { index: bars.length - 1, label: 'today' }
          ]
        }
      );
      /*
       * The rows are the evidence, not the headline.
       *
       * Every row carries a repository, a short sha and an author so a claim
       * can be checked, and that is exactly why they cannot be deleted -- but
       * thirty of them stacked under the chart is a wall the reader scrolls
       * past, and it buries the card below. Folded away, the card is the
       * shape; opened, it is the ledger. <details> rather than a button and a
       * hidden list: it is the element that already means this, it is
       * keyboard-operable and announced without any code from here, and find-
       * in-page opens it on its own.
       */
      const fold = element('details', 'wp-feed-fold');
      const summary = element('summary', 'wp-feed-summary');
      summary.append(
        element('span', 'wp-feed-summary-word',
          `${current.events.length} commit${current.events.length === 1 ? '' : 's'}`),
        element('span', 'wp-feed-summary-hint', 'with repository, sha and author')
      );
      fold.appendChild(summary);
      const list = element('ul', 'wp-feed');
      current.events.forEach(event => list.appendChild(feedRow(event, now)));
      fold.appendChild(list);
      /*
       * The choice sticks. A reader who opened the ledger did so to read it,
       * and re-folding it under them on the next repaint -- a refresh, a
       * revisit -- is the card taking that back. Stored per browser, guarded
       * because storage throws in a private window.
       */
      try {
        fold.open = localStorage.getItem(FEED_FOLD_KEY) === 'open';
      } catch { /* private mode: closed, as designed */ }
      fold.addEventListener('toggle', () => {
        try { localStorage.setItem(FEED_FOLD_KEY, fold.open ? 'open' : 'closed'); } catch { /* ignore */ }
      });
      host.appendChild(fold);
    }

    if (current.inventoryCount) {
      /*
       * The bounds, twice: a line and a sentence.
       *
       * The full sentence is what stops this card implying it saw everything,
       * so it does not get deleted -- but five lines of prose under a chart is
       * the wall this card was just rescued from, and a reader scanning the
       * shape has already scrolled past it. The line carries the three facts
       * that change how the chart is read, including the word "sample"; the
       * sentence that says it at length sits with the rows, where somebody who
       * opened the ledger is reading carefully anyway.
       */
      const scope = element('p', 'wp-stat-note wp-feed-scope',
        `${current.days}d · ${current.repositories.length} of ${current.inventoryCount} repositor${current.inventoryCount === 1 ? 'y' : 'ies'} · bounded sample`);
      host.appendChild(scope);
      const detail = element('p', 'wp-stat-note wp-feed-scope-full',
        `Commits from the last ${current.days} days across ${current.repositories.length} of ${current.inventoryCount} repositor${current.inventoryCount === 1 ? 'y' : 'ies'} in the first inventory page. Up to ${current.perRepositoryLimit || 20} commits per repository${current.truncated ? `; showing ${current.events.length} of ${current.totalEvents} returned commits` : ''}. This is a bounded sample, not a complete activity history.`);
      const fold = host.querySelector('.wp-feed-fold');
      if (fold) fold.appendChild(detail); else host.appendChild(detail);
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
    COMPONENTS, ACTIVITY_BUCKETS, CRITICAL_CAP, gradeOf, model, render, renderActivityFeed,
    languageSpread, radarChart, RADAR_MIN_AXES
  });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaWorkspacePulse;
