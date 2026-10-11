/*
 * The security posture on the Overview.
 *
 * The cards above it say how the session stands -- its credential, its
 * recovery points, what the deployment offers. This says how the code stands:
 * what the audits and exposure scans have open across every repository this
 * identity has looked at, how that moved week by week, how long fixing has
 * taken, where the open findings are, and which repositories have never been
 * looked at at all.
 *
 * Every figure comes from GET /api/workspace/security-posture, which reads
 * what the stores already hold (src/posture-summary.js decides the numbers).
 * Nothing here computes a finding. What it adds is the one thing the server
 * cannot know: the repositories in the inventory that neither system has
 * read, because the inventory is the browser's.
 *
 * Loaded on its own and tested on its own, like the pulse beside it.
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SEVERITIES = Object.freeze(['critical', 'serious', 'warning']);
  const SEVERITY_WORD = Object.freeze({ critical: 'critical', serious: 'serious', warning: 'warning' });
  const CATEGORY_LABEL = Object.freeze({
    'supply-chain': 'Supply chain',
    code: 'Code security',
    access: 'Access control',
    secrets: 'Secrets in code',
    dependencies: 'Dependencies',
    infrastructure: 'Infrastructure',
    hygiene: 'Project hygiene',
    licences: 'Licences',
    ai: 'AI and model output',
    'leaked-credentials': 'Leaked credentials'
  });
  /* How many repositories the "not yet looked at" row names before it counts the rest. */
  const UNREAD_SHOWN = 6;

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  function repoKey(owner, name) {
    return `${String(owner || '')}/${String(name || '')}`.toLowerCase();
  }

  function inventory(repos) {
    const list = [];
    const seen = new Set();
    for (const repo of Array.isArray(repos) ? repos : []) {
      if (!repo) continue;
      let owner = repo.owner && typeof repo.owner === 'object' ? repo.owner.login : repo.owner;
      let name = repo.name;
      if ((!owner || !name) && repo.full_name) [owner, name] = String(repo.full_name).split('/');
      if (!owner || !name) continue;
      const key = repoKey(owner, name);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ owner: String(owner), repo: String(name), key, pushedAt: Date.parse(repo.pushed_at || repo.updated_at || '') || 0 });
    }
    return list;
  }

  function categoryLabel(id) {
    return CATEGORY_LABEL[id] || String(id || 'Other').replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase());
  }

  function days(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    const number = Number(value);
    if (number < 1) return 'under a day';
    return `${number % 1 === 0 ? number : number.toFixed(1)} ${number === 1 ? 'day' : 'days'}`;
  }

  /*
   * The reading, decided. `summary` is the route's answer (or null while it is
   * on its way), `repos` the inventory the session holds.
   */
  function model(summary, repos) {
    if (!summary) return { state: 'loading' };
    if (summary.available === false) {
      const reasons = {
        'not-configured': 'Security posture is kept in the server database, and this deployment has none.',
        'database-unavailable': 'The server database did not answer, so the posture could not be read. It is read again with the overview.',
        offline: 'You are offline, so the posture could not be read. It is read again when the connection returns.'
      };
      return { state: 'unavailable', reason: reasons[summary.reason] || 'The posture could not be read just now. It is read again with the overview.' };
    }
    const listed = Array.isArray(summary.repositories) ? summary.repositories : [];
    const read = new Set(listed.map(entry => repoKey(entry.owner, entry.repo)));
    const known = inventory(repos);
    const unread = known
      .filter(entry => !read.has(entry.key))
      .sort((a, b) => b.pushedAt - a.pushedAt || a.key.localeCompare(b.key));
    const covered = known.filter(entry => read.has(entry.key)).length;
    const sources = summary.sources || {};
    const measured = sources.audit === 'measured' || sources.exposure === 'measured' || sources.exposure === 'partial';
    if (!listed.length) {
      return {
        state: measured ? 'empty' : 'unmeasured',
        unread: unread.slice(0, UNREAD_SHOWN),
        unreadMore: Math.max(0, unread.length - UNREAD_SHOWN),
        inventory: known.length
      };
    }
    const open = summary.open || { critical: 0, serious: 0, warning: 0, total: 0 };
    const week = summary.week || {};
    const trend = Array.isArray(summary.trend) ? summary.trend : [];
    const notes = [];
    if (sources.audit !== 'measured') notes.push('Audits could not be read; their findings are not counted.');
    if (sources.exposure === 'unavailable') notes.push('Exposure scans could not be read; leaked credentials are not counted.');
    else if (sources.exposure === 'partial') notes.push('The exposure trend could not be read; credentials are counted, not charted.');
    if (sources.governance !== 'measured') notes.push('Governance decisions could not be read; gated merges are not counted.');
    return {
      state: 'ready',
      weeks: summary.weeks || trend.length,
      open,
      triaged: summary.triaged || { acceptedRisk: 0, falsePositive: 0 },
      week: {
        opened: Number(week.opened) || 0,
        fixed: Number(week.fixed) || 0,
        gated: week.gated === null || week.gated === undefined ? null : Number(week.gated) || 0
      },
      window: summary.window || { opened: 0, fixed: 0 },
      trend,
      timeToFix: summary.timeToFix || null,
      categories: (Array.isArray(summary.categories) ? summary.categories : []).filter(entry => entry.total > 0).slice(0, 6),
      top: Array.isArray(summary.top) ? summary.top : [],
      readCount: listed.length,
      covered,
      inventory: known.length,
      unread: unread.slice(0, UNREAD_SHOWN),
      unreadMore: Math.max(0, unread.length - UNREAD_SHOWN),
      notes
    };
  }

  /* The headline sentence: what moved this week, in words a reader can repeat. */
  function weekSentence(view) {
    const parts = [
      plural(view.week.opened, 'new finding', 'new findings'),
      `${view.week.fixed} fixed`
    ];
    if (view.week.gated !== null) parts.push(plural(view.week.gated, 'merge attempt gated', 'merge attempts gated'));
    return `This week: ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts[parts.length - 1]}.`;
  }

  /* ------------------------------------------------------------------ DOM */

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

  const openNumbers = new Set();
  function numbersTable(caption, headings, rows) {
    const details = element('details', 'wp-numbers');
    details.appendChild(element('summary', null, 'Show the numbers'));
    details.open = openNumbers.has(caption);
    details.addEventListener('toggle', () => {
      if (details.open) openNumbers.add(caption);
      else openNumbers.delete(caption);
    });
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

  /*
   * One bar split by severity, with a 2px gap between segments so adjacent
   * fills never merge. The text beside it carries the same counts, so the
   * colour is never the only way to read them.
   */
  function severityBar(open, scale) {
    const bar = element('span', 'pp-sevbar');
    bar.setAttribute('aria-hidden', 'true');
    const total = Math.max(1, scale || open.total || 0);
    for (const severity of SEVERITIES) {
      const count = Number(open[severity]) || 0;
      if (!count) continue;
      const part = element('span', `pp-sevbar-part pp-sev-${severity}`);
      part.style.flexGrow = String(count);
      part.style.maxWidth = `${(count / total) * 100}%`;
      bar.appendChild(part);
    }
    return bar;
  }

  function severityWords(open) {
    const words = SEVERITIES.filter(severity => open[severity]).map(severity => `${open[severity]} ${SEVERITY_WORD[severity]}`);
    return words.length ? words.join(' · ') : 'nothing open';
  }

  function tile(label, figure, detail, className) {
    const node = element('div', `pp-tile${className ? ` ${className}` : ''}`);
    node.append(element('p', 'pp-tile-label', label));
    const value = element('p', 'pp-tile-figure', figure);
    node.append(value);
    if (detail) node.append(detail instanceof Node ? detail : element('p', 'pp-tile-detail', detail));
    return node;
  }

  /*
   * Opened and fixed per week: two bars to a week, side by side, on one axis
   * that starts at zero. Each week is a hit target the full height of the
   * plot, so a reader does not have to land on a two-pixel bar to read it.
   */
  function trendChart(view, measuredWidth) {
    const wrap = element('div', 'pp-chart');
    const weeks = view.trend;
    const max = Math.max(1, ...weeks.map(entry => Math.max(entry.opened, entry.fixed)));
    /* Whole-number steps of 1, 2 or 5 times a power of ten, three or four of them. */
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, max / 3))));
    const fraction = Math.max(1, max / 3) / magnitude;
    const step = Math.max(1, Math.round((fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude));
    const top = step * Math.ceil(max / step);
    const width = Math.max(240, Math.round(measuredWidth || 480));
    const height = width < 420 ? 150 : 180;
    const pad = { left: 30, right: 6, top: 10, bottom: 22 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const column = plotW / Math.max(1, weeks.length);
    const barW = Math.max(3, Math.min(14, (column - 6) / 2));
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'pp-chart-svg', role: 'img' });
    chart.setAttribute('aria-label',
      `Findings opened and fixed per week over the last ${weeks.length} weeks: ${view.window.opened} opened and ${view.window.fixed} fixed in all.`);
    const y = value => pad.top + plotH - (value / top) * plotH;
    for (let value = 0; value <= top; value += step) {
      chart.appendChild(svg('line', { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: value === 0 ? 'pp-axis' : 'pp-gridline' }));
      const label = svg('text', { x: pad.left - 6, y: y(value) + 3, class: 'pp-tick', 'text-anchor': 'end' });
      label.textContent = String(value);
      chart.appendChild(label);
    }
    /* The pointer's reading. Kept out of the accessibility tree: the table
       under the chart says the same for every week, without a pointer. */
    const tip = element('div', 'pp-tip');
    tip.hidden = true;
    tip.setAttribute('aria-hidden', 'true');
    weeks.forEach((entry, index) => {
      const x0 = pad.left + index * column + (column - (barW * 2 + 2)) / 2;
      const bar = (value, x, kind) => {
        if (!value) return;
        const h = Math.max(1, (value / top) * plotH);
        const r = Math.min(4, barW / 2, h);
        const yTop = pad.top + plotH - h;
        /* Rounded where the data ends, square on the baseline. */
        chart.appendChild(svg('path', {
          class: `pp-bar pp-bar-${kind}`,
          d: `M${x},${pad.top + plotH}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + barW - r}Q${x + barW},${yTop} ${x + barW},${yTop + r}V${pad.top + plotH}Z`
        }));
      };
      bar(entry.opened, x0, 'opened');
      bar(entry.fixed, x0 + barW + 2, 'fixed');
      const when = entry.weeksAgo === 0 ? 'This week' : entry.weeksAgo === 1 ? 'Last week' : `${entry.weeksAgo} weeks ago`;
      const hit = svg('rect', {
        x: pad.left + index * column, y: pad.top, width: column, height: plotH, class: 'pp-hit', 'data-week': entry.weeksAgo
      });
      const show = () => {
        tip.textContent = `${when}: ${entry.opened} opened, ${entry.fixed} fixed`;
        tip.hidden = false;
        const share = (index + 0.5) / weeks.length;
        tip.style.left = `${Math.min(86, Math.max(14, share * 100))}%`;
        hit.classList.add('is-hover');
      };
      const hide = () => { tip.hidden = true; hit.classList.remove('is-hover'); };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointerleave', hide);
      chart.appendChild(hit);
    });
    const first = svg('text', { x: pad.left, y: height - 6, class: 'pp-tick', 'text-anchor': 'start' });
    first.textContent = `${weeks.length} weeks ago`;
    const last = svg('text', { x: width - pad.right, y: height - 6, class: 'pp-tick', 'text-anchor': 'end' });
    last.textContent = 'this week';
    chart.append(first, last);
    wrap.append(chart, tip);
    return wrap;
  }

  /*
   * The chart drawn at the width its panel has, and drawn again when that
   * width changes by more than a hair: a viewBox stretched to fit would scale
   * the axis labels with it, to a smudge on a phone and a shout on a monitor.
   */
  function fittedTrend(host, view) {
    const measure = () => Math.round(host.getBoundingClientRect ? host.getBoundingClientRect().width : 0) || 480;
    let drawn = measure();
    let chart = trendChart(view, drawn);
    host.appendChild(chart);
    if (typeof ResizeObserver === 'function') {
      let redraw = 0;
      const watcher = new ResizeObserver(() => {
        if (!chart.isConnected) { watcher.disconnect(); cancelAnimationFrame(redraw); return; }
        cancelAnimationFrame(redraw);
        redraw = requestAnimationFrame(() => {
          if (!chart.isConnected) { watcher.disconnect(); return; }
          const now = measure();
          if (Math.abs(now - drawn) < 24) return;
          drawn = now;
          const next = trendChart(view, now);
          chart.replaceWith(next);
          chart = next;
        });
      });
      watcher.observe(host);
    }
  }

  function legend() {
    const node = element('div', 'pp-legend');
    for (const [kind, label] of [['opened', 'Opened'], ['fixed', 'Fixed']]) {
      const item = element('span', 'pp-legend-item');
      const swatch = element('span', `pp-swatch pp-swatch-${kind}`);
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, element('span', null, label));
      node.appendChild(item);
    }
    return node;
  }

  function repositoryButton(owner, repo, actions, className) {
    const button = element('button', className);
    button.type = 'button';
    button.textContent = `${owner}/${repo}`;
    button.title = `Open the audit of ${owner}/${repo}`;
    button.addEventListener('click', () => { if (actions && actions.audit) actions.audit(owner, repo); });
    return button;
  }

  function unreadRow(view, actions) {
    if (!view.unread.length) return null;
    const row = element('div', 'pp-unread');
    row.append(element('p', 'pp-unread-label', 'Not yet audited or scanned'));
    const list = element('div', 'pp-unread-list');
    for (const entry of view.unread) list.appendChild(repositoryButton(entry.owner, entry.repo, actions, 'pp-chip'));
    if (view.unreadMore) list.appendChild(element('span', 'pp-chip-more', `+${view.unreadMore} more`));
    row.appendChild(list);
    return row;
  }

  function renderEmpty(host, view, actions) {
    const box = element('div', 'pp-empty');
    box.append(
      element('p', 'pp-empty-title', view.state === 'unmeasured' ? 'The posture could not be read' : 'Nothing audited or scanned yet'),
      element('p', 'pp-empty-text', view.state === 'unmeasured'
        ? 'Neither the audits nor the exposure scans answered. Nothing here means the workspace is clean.'
        : 'Audit a repository, or scan it for leaked credentials, and what they find is summarised here across the whole workspace.')
    );
    host.appendChild(box);
    const row = unreadRow(view, actions);
    if (row) host.appendChild(row);
  }

  function render(host, view, actions) {
    if (!host || typeof document === 'undefined') return;
    host.textContent = '';
    host.dataset.state = view.state;
    const head = element('div', 'wp-head pp-head');
    head.append(element('span', 'wp-label', 'SECURITY POSTURE'));
    head.append(element('span', 'pp-scope', 'Audits, exposure scans and governance'));
    host.appendChild(head);
    if (view.state === 'loading') {
      host.appendChild(element('p', 'wp-stat-note', 'Reading the audits and scans this account has kept…'));
      return;
    }
    if (view.state === 'unavailable') {
      host.appendChild(element('p', 'wp-stat-note', view.reason));
      return;
    }
    if (view.state === 'empty' || view.state === 'unmeasured') {
      renderEmpty(host, view, actions);
      return;
    }

    host.appendChild(element('p', 'pp-week', weekSentence(view)));

    const tiles = element('div', 'pp-tiles');
    const openDetail = element('div', 'pp-tile-detail');
    openDetail.append(severityBar(view.open), element('span', 'pp-sevwords', severityWords(view.open)));
    tiles.appendChild(tile('Open findings', String(view.open.total), openDetail, 'pp-tile-open'));
    tiles.appendChild(tile('Decided', String(view.triaged.acceptedRisk + view.triaged.falsePositive),
      `${view.triaged.acceptedRisk} accepted ${view.triaged.acceptedRisk === 1 ? 'risk' : 'risks'} · ${view.triaged.falsePositive} not a problem`));
    const fix = view.timeToFix && view.timeToFix.all;
    tiles.appendChild(tile('Median time to fix', fix && fix.count ? days(fix.medianDays) : '—',
      fix && fix.count
        ? `${plural(fix.count, 'finding', 'findings')} fixed in ${view.timeToFix.windowDays} days`
        : `Nothing fixed in the last ${view.timeToFix ? view.timeToFix.windowDays : 90} days`));
    tiles.appendChild(tile('Repositories read', view.inventory ? `${view.covered} of ${view.inventory}` : String(view.readCount),
      view.inventory ? 'in this inventory, audited or scanned' : 'audited or scanned'));
    host.appendChild(tiles);

    const grid = element('div', 'pp-grid');
    const trend = element('section', 'pp-panel pp-trend');
    trend.setAttribute('aria-labelledby', 'ppTrendTitle');
    const trendHead = element('div', 'pp-panel-head');
    const trendTitle = element('h4', 'pp-panel-title', `Opened and fixed, last ${view.trend.length} weeks`);
    trendTitle.id = 'ppTrendTitle';
    trendHead.append(trendTitle, legend());
    trend.appendChild(trendHead);
    const plot = element('div', 'pp-plot');
    trend.appendChild(plot);
    trend.appendChild(numbersTable('Findings opened and fixed per week', ['Week', 'Opened', 'Fixed'],
      view.trend.slice().reverse().map(entry => [
        entry.weeksAgo === 0 ? 'This week' : entry.weeksAgo === 1 ? 'Last week' : `${entry.weeksAgo} weeks ago`,
        entry.opened, entry.fixed
      ])));
    grid.appendChild(trend);

    const where = element('section', 'pp-panel pp-where');
    where.setAttribute('aria-labelledby', 'ppWhereTitle');
    const whereTitle = element('h4', 'pp-panel-title', 'Where the open findings are');
    whereTitle.id = 'ppWhereTitle';
    where.appendChild(whereTitle);
    if (view.top.length) {
      const list = element('ol', 'pp-repos');
      const scale = Math.max(...view.top.map(entry => entry.open.total));
      for (const entry of view.top) {
        const item = element('li', 'pp-repo');
        const name = repositoryButton(entry.owner, entry.repo, actions, 'pp-repo-name');
        const count = element('span', 'pp-repo-count', String(entry.open.total));
        count.setAttribute('aria-label', `${entry.open.total} open: ${severityWords(entry.open)}`);
        item.append(name, count, severityBar(entry.open, scale));
        list.appendChild(item);
      }
      where.appendChild(list);
    } else {
      where.appendChild(element('p', 'wp-stat-note', 'Nothing is open in any repository that has been read.'));
    }
    if (view.categories.length) {
      const categoryTitle = element('h5', 'pp-sub-title', 'By kind');
      const bars = element('ul', 'pp-cats');
      const scale = Math.max(...view.categories.map(entry => entry.total));
      for (const entry of view.categories) {
        const item = element('li', 'pp-cat');
        const fill = element('span', 'pp-cat-fill');
        fill.style.width = `${Math.max(4, (entry.total / scale) * 100)}%`;
        const track = element('span', 'pp-cat-track');
        track.setAttribute('aria-hidden', 'true');
        track.appendChild(fill);
        item.append(element('span', 'pp-cat-name', categoryLabel(entry.category)), track, element('span', 'pp-cat-count', String(entry.total)));
        bars.appendChild(item);
      }
      where.append(categoryTitle, bars);
    }
    where.appendChild(numbersTable('Open findings by repository', ['Repository', 'Critical', 'Serious', 'Warning', 'Total'],
      view.top.map(entry => [`${entry.owner}/${entry.repo}`, entry.open.critical, entry.open.serious, entry.open.warning, entry.open.total])));
    grid.appendChild(where);
    host.appendChild(grid);
    fittedTrend(plot, view);

    const row = unreadRow(view, actions);
    if (row) host.appendChild(row);
    for (const note of view.notes) host.appendChild(element('p', 'wp-stat-note', note));
  }

  global.NebulaSecurityPosture = Object.freeze({ model, render, weekSentence, categoryLabel, UNREAD_SHOWN });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaSecurityPosture;
