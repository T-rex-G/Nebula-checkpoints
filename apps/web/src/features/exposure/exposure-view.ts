/*
 * The Exposure screen drawn. The screen leads with what was proven, not with
 * a list: the proof line and the coverage come first, a partial scan says so
 * in the same breath, and an empty list under partial coverage never reads as
 * an all-clear. Then the history, newest first and grouped by day, each scan
 * a disclosure that opens into its report; the findings toolbar, built once
 * and updated in place so a poll never takes the cursor out of the search
 * box; and the findings, worst first, each a native disclosure whose summary
 * is what a reader scans down and whose body explains and, on the current
 * list, offers the two-press controls.
 *
 * Nothing drawn here is built from a credential. The server sends a
 * placeholder, bounded locations and a narration drawn from a lookup table;
 * everything is inserted as text, never as markup, because a path is bytes a
 * repository chose. Every table is looked up by its own names only.
 */
import { field, items } from '../../platform/values.ts';
import { GLYPHS, orbitChip } from './orbit-chip.ts';
import type { ChipDocument } from './orbit-chip.ts';
import {
  COVERAGE_WORDS, DISPOSITION_FALLBACK, DISPOSITION_TONE, DISPOSITION_WORDS, PROBE_FALLBACK, SEVERITY_WORDS, SKIPPED_WORDS, STATE_WORDS, VERIFICATION_FALLBACK,
  answerFresh, breakdownLine, dayLabel, filtered, firstLine, proofLine, refLabel, ruleLabel, scanCounts, severityOf, sortFindings, wordFor
} from './exposure-words.ts';
import type { ExposureState } from './exposure-controller.ts';

type Rec = Record<string, unknown>;

/* The parts of an element this screen uses. */
export interface ViewNode {
  className: string;
  id: string;
  type: string;
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  open: boolean;
  checked: boolean;
  value: string;
  title: string;
  dateTime: string;
  placeholder: string;
  autocomplete: string;
  spellcheck: boolean;
  readonly dataset: Record<string, string | undefined>;
  readonly classList: { add(name: string): void; toggle(name: string, on: boolean): unknown };
  readonly style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  appendChild(node: unknown): unknown;
  append(...nodes: unknown[]): void;
  add(option: unknown): void;
  querySelector(selector: string): ViewNode | null;
  querySelectorAll(selector: string): Iterable<ViewNode>;
  addEventListener(type: string, listener: () => void): void;
}
export interface ViewDocument extends ChipDocument {
  createElement(tag: string): ViewNode;
  createElementNS(namespace: string, tag: string): ViewNode;
  readonly activeElement: unknown;
}

export interface ExposureViewDeps {
  readonly doc: ViewDocument;
  /* An element of the page by its selector. */
  readonly $: (selector: string) => ViewNode | null;
  readonly current: () => ExposureState;
  readonly work: () => unknown;
  readonly visiting: () => boolean;
  readonly mutate: (change: (exposure: ExposureState) => void) => void;
  readonly filter: () => void;
  readonly loadMore: () => void;
  readonly historyPreferred: () => boolean;
  readonly timeAgo: (iso: unknown) => string;
  readonly now: () => number;
  /* A new option for a select, as the page makes one. */
  readonly option: (word: string, value: string) => unknown;
  readonly exportMenu: (run: (kind: string) => unknown, className: string, kinds: readonly string[]) => unknown;
  readonly exportFindings: (kind: string) => unknown;
  readonly frame: (run: () => void) => void;
  readonly timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export const WHERE_OPTIONS: readonly (readonly [string, string])[] = Object.freeze([['all', 'Anywhere'], ['tree', 'In the tree'], ['history', 'Only in history'], ['archive', 'In an archive'], ['encoded', 'Encoded']] as const);
export const STATUS_OPTIONS: readonly (readonly [string, string])[] = Object.freeze([['all', 'Any status'], ['open', 'Open'], ['credential-rejected', 'No longer works'], ['accepted-risk', 'Accepted'], ['removed-from-tree', 'Removed from tree']] as const);

const SVG = 'http://www.w3.org/2000/svg';
const running = (scan: unknown): boolean => field(scan, 'state') === 'queued' || field(scan, 'state') === 'running';
const own = (table: unknown, key: unknown): unknown => (typeof key === 'string' && table && typeof table === 'object' && Object.hasOwn(table, key) ? (table as Rec)[key] : undefined);
const dispositionOf = (finding: unknown): string => String(field(finding, 'disposition') || 'open');

export interface ExposureView {
  render(): void;
  /* The count by severity and the open-all control, redrawn alone when a finding is opened or closed. */
  tally(current: ExposureState): void;
  announce(message: unknown): void;
  /* The key an exposure state is kept for: the provider, owner and repository open, or nothing. */
  scopeKey(): string;
}

export function createExposureView(deps: ExposureViewDeps): ExposureView {
  const { doc, $ } = deps;
  const element = (tag: string, className?: string, text?: string): ViewNode => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const chip = (tone: string, word: string, options: { glyph?: string; count?: unknown; beam?: boolean; className?: string }): ViewNode => orbitChip(doc, tone, word, options) as unknown as ViewNode;

  function announce(message: unknown): void {
    const live = $('#exposureLive');
    if (!live) return;
    live.textContent = '';
    deps.frame(() => { live.textContent = String(message || ''); });
  }

  function scopeKey(): string {
    const work = deps.work();
    return work ? `${String(field(work, 'provider') || 'github')}:${String(field(work, 'owner'))}/${String(field(work, 'repo'))}` : '';
  }

  /*
   * The readability question, as a form rather than a button, because a probe
   * needs two things this server will not invent: which table, and which
   * columns. `*` is refused by the prober outright, so the field asks for names.
   */
  function probeForm(finding: Rec, current: ExposureState): ViewNode {
    const fingerprint = String(finding.fingerprint);
    const draft = (own(current.probeDrafts, fingerprint) || { relation: '', columns: '' }) as Rec;
    const form = element('div', 'exposure-probe-form');
    form.dataset.fingerprint = fingerprint;
    form.appendChild(element('p', 'exposure-probe-explain', 'Ask the project what the anonymous role can read. Name one table and the columns to ask for; nothing from inside a row is kept.'));
    const fields = element('div', 'exposure-probe-fields');
    for (const [name, label, placeholder] of [['relation', 'Table', 'profiles'], ['columns', 'Columns', 'id, email']] as const) {
      const wrap = element('label', 'exposure-probe-field');
      wrap.appendChild(element('span', undefined, label));
      const input = element('input', 'exposure-probe-input');
      input.type = 'text';
      input.dataset.fingerprint = fingerprint;
      input.dataset.field = name;
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = String(draft[name] || '');
      wrap.appendChild(input);
      fields.appendChild(wrap);
    }
    form.appendChild(fields);
    const ask = element('button', 'btn ghost exposure-probe');
    ask.type = 'button';
    ask.dataset.fingerprint = fingerprint;
    const armed = current.confirming === `probe:${fingerprint}`;
    ask.textContent = armed ? 'Ask this project now' : 'Ask what the public can read';
    if (armed) ask.classList.add('exposure-probe-armed');
    ask.disabled = current.probing === fingerprint;
    form.appendChild(ask);
    return form;
  }

  const warning = (message: string): ViewNode => element('p', 'exposure-item-warning', message);

  /* The count by severity, and the one control that opens or closes them all. */
  function tally(current: ExposureState): void {
    const host = $('#exposureTally');
    const toggle = $('#exposureExpandAllBtn');
    const counts: Record<string, number> = { critical: 0, serious: 0, warning: 0 };
    let open = 0;
    for (const finding of current.findings) {
      const severity = severityOf(finding);
      counts[severity] = (counts[severity] ?? 0) + 1;
      if (dispositionOf(finding) === 'open') open += 1;
    }
    const total = current.counts ? field(current.counts, 'all') as number : current.findings.length;
    if (current.counts) {
      Object.assign(counts, field(current.counts, 'bySeverity'));
      open = (field(field(current.counts, 'byDisposition'), 'open') as number) || 0;
    }
    const severities = ['critical', 'serious', 'warning'].filter(key => counts[key]);
    if (host) {
      host.hidden = !total;
      const parts = severities.map(key => `${counts[key]} ${key}`);
      host.textContent = total ? `${total} ${total === 1 ? 'finding' : 'findings'}: ${parts.join(', ')}. ${open} still open.` : '';
    }
    const count = $('#exposureCount');
    if (count) {
      count.hidden = !total;
      count.textContent = total ? String(total) : '';
    }
    const chips = $('#exposureChips');
    if (chips) {
      chips.hidden = !total;
      const drawn: ViewNode[] = [];
      if (total) {
        for (const key of severities) {
          const badge = chip(key, key, { glyph: own(GLYPHS, key) as string, count: counts[key], className: 'nv-chip-lg exposure-chip', beam: key === 'critical' });
          badge.dataset.severity = key;
          drawn.push(badge);
        }
        drawn.push(chip('pending', 'open', { glyph: GLYPHS.pending, count: open, className: 'nv-chip-lg exposure-chip exposure-chip-open' }));
      }
      (chips as unknown as { replaceChildren(...nodes: unknown[]): void }).replaceChildren(...drawn);
    }
    if (toggle) {
      toggle.hidden = !total;
      const allOpen = total > 0 && current.findings.every(finding => current.expanded.has(finding.fingerprint));
      const label = toggle.querySelector('.exposure-expand-label') || toggle;
      label.textContent = allOpen ? 'Collapse all' : 'Expand all';
      toggle.setAttribute('aria-expanded', String(allOpen));
    }
  }

  function history(current: ExposureState): void {
    const host = $('#exposureHistory');
    const empty = $('#exposureHistoryEmpty');
    const more = $('#exposureHistoryMoreBtn');
    if (!host || !empty) return;
    host.textContent = '';
    if (!current.history.length) {
      empty.hidden = false;
      empty.textContent = current.historyError
        || (current.historyLoading ? 'Loading scan history\u2026' : 'No scans yet. Each scan you run is kept here, newest first.');
      if (more) more.hidden = true;
      return;
    }
    empty.hidden = !current.historyError;
    empty.textContent = current.historyError || '';
    let day = '';
    let group: ViewNode | null = null;
    for (const scan of current.history) {
      const at = new Date(scan.createdAt as string);
      const key = Number.isNaN(at.getTime()) ? 'unknown' : at.toDateString();
      if (key !== day || !group) {
        day = key;
        const heading = element('h3', 'exposure-history-day', key === 'unknown' ? 'Undated' : dayLabel(at, new Date(deps.now())));
        group = element('ol', 'exposure-history-group');
        host.append(heading, group);
      }
      group.appendChild(historyEntry(scan, current));
    }
    if (more) {
      more.hidden = current.historyDone;
      more.disabled = current.historyLoading;
      more.textContent = current.historyLoading ? 'Loading\u2026' : 'Show older scans';
    }
  }

  /* One scan, as a disclosure: when, what state it ended in, how much it read, which commit and what it found. */
  function historyEntry(scan: Rec, current: ExposureState): ViewNode {
    const item = element('li', 'exposure-history-item');
    const details = element('details', 'exposure-scan');
    details.dataset.scanId = scan.scanId as string;
    if (current.openScans.has(scan.scanId)) details.open = true;
    const summary = element('summary', 'exposure-scan-summary');
    const time = element('time', 'exposure-scan-time');
    time.dateTime = String(scan.createdAt || '');
    const at = new Date(scan.createdAt as string);
    time.textContent = Number.isNaN(at.getTime()) ? '\u2014' : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    time.title = Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
    const ago = element('span', 'exposure-scan-ago', deps.timeAgo(scan.createdAt));
    const settled = scan.state === 'complete';
    const moving = running(scan);
    const badge = chip(settled ? 'neutral' : moving ? 'info' : 'warning', (wordFor(STATE_WORDS, scan.state) || scan.state) as string,
      { glyph: settled ? GLYPHS.check : moving ? GLYPHS.pending : GLYPHS.warning, className: 'exposure-scan-state', beam: moving });
    badge.dataset.state = scan.state as string;
    const ref = element('span', 'exposure-scan-ref', `${refLabel(scan.refName)} @ ${String(scan.commitSha || '').slice(0, 7) || '\u2014'}${scan.scanMode === 'history' ? ' \u00b7 with history' : ''}`);
    const counts = element('span', 'exposure-scan-counts', scanCounts(scan));
    counts.dataset.found = String(Number(scan.findingCount) > 0);
    summary.append(time, ago, badge, ref, counts);
    details.appendChild(summary);

    const body = element('div', 'exposure-scan-body');
    const coverage = wordFor(COVERAGE_WORDS, scan.coverage) || scan.coverage;
    body.appendChild(element('p', 'exposure-scan-facts',
      `${String(coverage)}. ${breakdownLine(scan) || (Number.isInteger(scan.filesScanned) ? `Read ${String(scan.filesScanned)} files.` : '')} Requested by ${String(scan.requestedBy || 'someone')}.`));
    const skipped = wordFor(SKIPPED_WORDS, scan.skippedReason);
    if (scan.skippedReason && skipped) body.appendChild(element('p', 'exposure-caveat', `Coverage is partial because ${skipped}.`));

    const report = own(current.reports, scan.scanId) as Rec | undefined;
    if (details.open) {
      if (report && !report.loading && !report.error && report.complete === false) {
        body.appendChild(element('p', 'exposure-caveat', 'Only part of this scan report was loaded. Close and reopen the report after refreshing to retrieve current evidence.'));
      }
      if (!report || report.loading) body.appendChild(element('p', 'exposure-empty', 'Loading this scan\u2019s report\u2026'));
      else if (report.error) body.appendChild(element('p', 'exposure-empty', String(report.error)));
      else if (!items(report.entries).length) {
        body.appendChild(element('p', 'exposure-empty', scan.coverage === 'complete' && report.complete === true
          ? 'This scan found no credentials in the tree it read.'
          : 'This scan found no credentials in the part of the tree it read. That is not an all-clear.'));
      } else {
        const list = element('ul', 'exposure-list exposure-report-list');
        for (const finding of sortFindings(items(report.entries) as Rec[])) list.appendChild(findingItem(finding, current, false));
        body.appendChild(list);
      }
    }
    details.appendChild(body);
    item.appendChild(details);
    return item;
  }

  /* While a scan runs: a radar of dots, each lit as the sweep passes it. It says "working" and nothing more. */
  function radar(): ViewNode {
    const wrap = element('div', 'exposure-radar');
    wrap.setAttribute('aria-hidden', 'true');
    const sweep = element('span', 'exposure-radar-sweep');
    const svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('class', 'exposure-radar-art');
    for (const [radius, size] of [[13, 1.9], [25, 1.75], [37, 1.6], [49, 1.45]] as const) {
      const count = Math.round((Math.PI * 2 * radius) / 8.2);
      for (let index = 0; index < count; index += 1) {
        const turn = index / count;
        const angle = turn * Math.PI * 2 - Math.PI / 2;
        const dot = doc.createElementNS(SVG, 'circle');
        dot.setAttribute('cx', (60 + Math.cos(angle) * radius).toFixed(1));
        dot.setAttribute('cy', (60 + Math.sin(angle) * radius).toFixed(1));
        dot.setAttribute('r', String(size));
        dot.style.setProperty('--turn', turn.toFixed(3));
        svg.appendChild(dot);
      }
    }
    const core = doc.createElementNS(SVG, 'circle');
    core.setAttribute('cx', '60');
    core.setAttribute('cy', '60');
    core.setAttribute('r', '3');
    core.setAttribute('class', 'exposure-radar-core');
    svg.appendChild(core);
    wrap.append(sweep, svg);
    return wrap;
  }

  /* The findings toolbar: severity segments, a status and a place filter, a search, and export; built once. */
  let searchTimer: unknown = 0;
  function ensureTools(): ViewNode | null {
    const host = $('#exposureTools');
    if (!host || host.dataset.ready) return host;
    host.dataset.ready = 'true';
    const segments = element('div', 'audit-segments exposure-segments');
    segments.setAttribute('role', 'group');
    segments.setAttribute('aria-label', 'Show by severity');
    for (const [value, word] of [[null, 'All'], ['critical', 'Critical'], ['serious', 'Serious'], ['warning', 'Warning']] as const) {
      const control = element('button', 'audit-segment');
      control.type = 'button';
      control.dataset.severity = value || '';
      control.dataset.value = value || 'all';
      control.append(element('span', undefined, word), element('span', 'audit-segment-n'));
      control.addEventListener('click', () => { deps.mutate(() => { deps.current().view.severity = value; }); deps.filter(); });
      segments.appendChild(control);
    }
    const select = (id: string, label: string, options: readonly (readonly [string, string])[], key: 'status' | 'where'): ViewNode => {
      const wrap = element('label', 'exposure-select');
      wrap.appendChild(element('span', 'sr-only', label));
      const control = element('select');
      control.id = id;
      for (const [value, word] of options) control.add(deps.option(word, value));
      control.addEventListener('change', () => { deps.mutate(() => { deps.current().view[key] = control.value; }); deps.filter(); });
      wrap.append(control);
      return wrap;
    };
    const search = element('label', 'audit-search exposure-search');
    search.innerHTML = '<svg class="audit-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.3 15.3L20 20"/></svg>';
    const input = element('input', 'audit-search-input');
    input.type = 'search';
    input.id = 'exposureSearch';
    input.placeholder = 'Search credential or file\u2026';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Search findings');
    input.addEventListener('input', () => {
      deps.timers.clear(searchTimer);
      searchTimer = deps.timers.set(() => { deps.mutate(() => { deps.current().view.query = input.value.slice(0, 120); }); deps.filter(); }, 140);
    });
    search.appendChild(input);
    const row = element('div', 'exposure-tools-row');
    row.append(select('exposureStatusFilter', 'Status', STATUS_OPTIONS, 'status'), select('exposureWhereFilter', 'Where', WHERE_OPTIONS, 'where'), search);
    const tail = element('div', 'exposure-tools-tail');
    const shown = element('span', 'exposure-shown');
    shown.id = 'exposureShown';
    shown.setAttribute('aria-live', 'polite');
    const reset = element('button', 'btn btn-ghost small exposure-reset', 'Clear filters');
    reset.type = 'button';
    reset.id = 'exposureResetFilters';
    reset.addEventListener('click', () => {
      deps.mutate(() => { Object.assign(deps.current().view, { severity: null, status: 'all', where: 'all', query: '' }); });
      input.value = '';
      deps.filter();
    });
    const more = element('button', 'btn btn-ghost small', 'Load more findings');
    more.type = 'button';
    more.id = 'exposureLoadMore';
    more.addEventListener('click', () => deps.loadMore());
    tail.append(shown, reset, more);
    tail.appendChild(deps.exportMenu(kind => deps.exportFindings(kind), 'exposure-export', ['csv', 'sarif']));
    host.append(segments, row, tail);
    return host;
  }

  function tools(current: ExposureState, shownCount: number): void {
    const host = ensureTools();
    if (!host) return;
    const total = current.counts ? field(current.counts, 'all') as number : current.findings.length;
    host.hidden = !total;
    if (!total) return;
    const view = current.view;
    const counts: Record<string, number> = { critical: 0, serious: 0, warning: 0 };
    for (const finding of current.findings) {
      const severity = severityOf(finding);
      counts[severity] = (counts[severity] ?? 0) + 1;
    }
    if (current.counts) Object.assign(counts, field(current.counts, 'bySeverity'));
    for (const control of host.querySelectorAll('.exposure-segments .audit-segment')) {
      const value = control.dataset.value === 'all' ? null : control.dataset.value;
      control.setAttribute('aria-pressed', String((view.severity || null) === value));
      const n = value ? own(counts, value) : total;
      const label = control.querySelector('.audit-segment-n');
      if (label) label.textContent = String(n);
      control.disabled = Boolean(value) && !n && view.severity !== value;
    }
    const status = $('#exposureStatusFilter');
    if (status && status.value !== view.status) status.value = view.status as string;
    const where = $('#exposureWhereFilter');
    if (where && where.value !== view.where) where.value = view.where as string;
    const search = $('#exposureSearch');
    if (search && doc.activeElement !== search && search.value !== view.query) search.value = view.query as string;
    const narrowed = Boolean(view.severity || view.status !== 'all' || view.where !== 'all' || view.query);
    const shown = $('#exposureShown');
    if (shown) {
      shown.textContent = current.paged ? `${shownCount} of ${current.total} matching findings loaded (${total} total)`
        : narrowed ? `${shownCount} of ${total} shown` : `${total} ${total === 1 ? 'finding' : 'findings'}`;
    }
    const more = $('#exposureLoadMore');
    if (more) { more.hidden = !current.nextCursor; more.disabled = current.loading; }
    const reset = $('#exposureResetFilters');
    if (reset) reset.hidden = !narrowed;
    const exportButton = host.querySelector('.audit-export-btn');
    if (exportButton) exportButton.disabled = !shownCount || current.loading || current.exporting;
  }

  /* One finding, as a disclosure: how bad, what, where and what has been decided, then the whole explanation. */
  function findingItem(finding: Rec, current: ExposureState, interactive: boolean): ViewNode {
    const severity = severityOf(finding);
    const disposition = dispositionOf(finding);
    const item = element('li', 'exposure-item');
    item.dataset.severity = severity;
    item.dataset.disposition = disposition;
    const details = element('details', 'exposure-disclosure');
    details.dataset.fingerprint = String(finding.fingerprint || '');
    if (interactive && current.expanded.has(finding.fingerprint)) details.open = true;
    const summary = element('summary', 'exposure-item-summary');
    const badge = chip(severity, SEVERITY_WORDS[severity], { glyph: GLYPHS[severity], className: 'exposure-badge' });
    badge.dataset.severity = severity;
    const title = element('span', 'exposure-item-title', ruleLabel(finding.rule));
    const line = firstLine(finding);
    /* Never the raw path: a file can be named with a credential, and the server says how to show one that is. */
    const location = element('span', 'exposure-item-location', `${String(finding.displayPath || 'a file')}${line ? `:${line}` : ''}`);
    /* Where it is, when that changes what to do: only in history, inside an archive, or base64-encoded. */
    const tags: [string, string][] = [];
    if (finding.inTree === false) {
      const commit = /^[0-9a-f]{7,}$/.test(String(finding.introducedCommit || '')) ? ` \u00b7 ${String(finding.introducedCommit).slice(0, 7)}` : '';
      tags.push(['history', `Only in history${commit}`]);
    }
    if (String(finding.path || '').includes('!/')) tags.push(['archive', 'In an archive']);
    if (finding.decodedFrom === 'base64') tags.push(['encoded', 'Base64-encoded']);
    const tagRow = element('span', 'exposure-item-tags');
    tagRow.hidden = !tags.length;
    for (const [kind, words] of tags) {
      const tag = chip(kind === 'history' ? 'info' : 'neutral', words, { glyph: own(GLYPHS, kind) as string, className: 'exposure-tag' });
      tag.dataset.kind = kind;
      tagRow.appendChild(tag);
    }
    const [statusTone, statusGlyph] = (own(DISPOSITION_TONE, disposition) as readonly [string, string] | undefined) || ['neutral', 'open'];
    const status = chip(statusTone, String(wordFor(DISPOSITION_WORDS, disposition) || disposition), { glyph: own(GLYPHS, statusGlyph) as string, className: 'exposure-item-status' });
    status.dataset.disposition = disposition;
    summary.append(badge, title, location, status, tagRow);
    details.appendChild(summary);
    const body = element('div', 'exposure-item-body');
    findingBody(body, finding, current, interactive);
    details.appendChild(body);
    item.appendChild(details);
    return item;
  }

  function findingBody(item: ViewNode, finding: Rec, current: ExposureState, interactive: boolean): void {
    const narration = finding.narration;
    item.appendChild(element('p', 'exposure-item-what', String(field(narration, 'what') || finding.placeholder || 'A credential')));
    item.appendChild(element('p', 'exposure-item-consequence', String(field(narration, 'consequence') || '')));
    item.appendChild(element('p', 'exposure-item-where', String(field(narration, 'where') || '')));
    item.appendChild(element('p', 'exposure-item-action', String(field(narration, 'action') || '')));
    const disposition = dispositionOf(finding);
    /* The decision this repository has made, in the same voice as everything above it. */
    item.appendChild(element('p', 'exposure-item-disposition', String(finding.dispositionNarration || wordFor(DISPOSITION_FALLBACK, disposition) || `Status: ${disposition}`)));
    /* Whose name is on it, or that the record does not say. */
    if (disposition === 'accepted-risk') {
      const when = deps.timeAgo(finding.dispositionAt);
      item.appendChild(element('p', 'exposure-item-provenance', finding.dispositionBy
        ? `Accepted by ${String(finding.dispositionBy)}${when ? ` ${when}` : ''}.`
        : 'Accepted, but this record does not name who accepted it.'));
    }
    /* What the provider said, if it was asked: kept apart from the decision. */
    const verification = own(current.verifications, finding.fingerprint);
    if (verification) {
      const fresh = answerFresh(verification, deps.now());
      const state = field(verification, 'state');
      const liveness = element('p', 'exposure-item-liveness', fresh
        ? String(field(verification, 'narration') || wordFor(VERIFICATION_FALLBACK, state) || 'The provider was asked and the answer was not interpreted.')
        : `Previous verification (${String(state)}) expired or has no valid check time. Check again for current evidence.`);
      liveness.dataset.state = fresh ? state as string : 'stale';
      item.appendChild(liveness);
    }
    /* What the project answered, if it was asked, with the question that was asked. */
    const probe = own(current.probes, finding.fingerprint);
    if (probe) {
      const fresh = answerFresh(probe, deps.now());
      const state = field(probe, 'state');
      const answer = fresh ? String(field(probe, 'narration') || wordFor(PROBE_FALLBACK, state) || 'The project was asked and the answer was not interpreted.')
        : `Previous readability result (${String(state)}) expired or has no valid check time. Check again for current evidence.`;
      const relation = field(probe, 'relation');
      const asked = relation ? ` Asked: ${String(relation)} (${items(field(probe, 'projection')).join(', ')}).` : '';
      const readability = element('p', 'exposure-item-readability', `${answer}${asked}`);
      readability.dataset.state = fresh ? state as string : 'stale';
      item.appendChild(readability);
    }
    /* Somebody else's repository: the finding is shown, and nothing here touches the credential or records an exception. */
    if (interactive && deps.visiting() && disposition === 'open') {
      item.appendChild(element('p', 'exposure-item-visitor', 'Checking whether it still works, and accepting it as intended, are left to the people who can push to this repository.'));
      return;
    }
    if (!interactive || disposition !== 'open') return;
    /* Both controls take two presses, and only one control is armed at a time. */
    const fingerprint = String(finding.fingerprint);
    const actions = element('div', 'exposure-item-actions');
    const armed = current.confirming;
    if (armed === `verify:${fingerprint}`) {
      actions.appendChild(warning('Continue only if you own this credential or have explicit permission to test it. This sends it to the issuing service, which may log the request. The credential is not stored; the result is retained.'));
    } else if (armed === `accept:${fingerprint}`) {
      actions.appendChild(warning('This records you as having accepted the exposure. The credential stays in the repository, it stays usable by anyone who has it, and nothing here undoes the decision.'));
    } else if (armed === `probe:${fingerprint}`) {
      actions.appendChild(warning('Continue only if you own this project or have explicit permission to test it. This sends one request using its anonymous key, asking for a single row. The project may log it. Only whether a row came back is kept.'));
    }
    const row = element('div', 'exposure-item-buttons');
    const verify = element('button', 'btn ghost exposure-verify', armed === `verify:${fingerprint}` ? 'Send this credential to the provider' : 'Check whether it still works');
    verify.type = 'button';
    verify.dataset.fingerprint = fingerprint;
    if (armed === `verify:${fingerprint}`) verify.classList.add('exposure-verify-armed');
    verify.disabled = current.verifying === fingerprint;
    /* Offered only where a verifier exists; a finding from an older server without the flag keeps the control. */
    if (finding.verifiable !== false) row.appendChild(verify);
    const accept = element('button', 'btn ghost exposure-accept', armed === `accept:${fingerprint}` ? 'Record me as accepting this exposure' : 'This one is intended');
    accept.type = 'button';
    accept.dataset.fingerprint = fingerprint;
    if (armed === `accept:${fingerprint}`) accept.classList.add('exposure-accept-armed');
    accept.disabled = current.accepting === fingerprint;
    row.appendChild(accept);
    actions.appendChild(row);
    /* For an anonymous key only, the question this feature exists to answer; a service-role key gets no form. */
    if (finding.rule === 'supabase-anon-key') actions.appendChild(probeForm(finding, current));
    item.appendChild(actions);
  }

  function render(): void {
    const pane = $('#tab-exposure');
    if (!pane) return;
    const current = deps.current();
    const scan = current.scan;
    const active = running(scan);
    const proofCard = pane.querySelector('.exposure-proof');
    if (proofCard) {
      if (!proofCard.querySelector('.exposure-radar')) proofCard.appendChild(radar());
      proofCard.dataset.scanning = String(Boolean(scan && active));
    }
    const stateEl = $('#exposureState');
    const coverageEl = $('#exposureCoverage');
    if (stateEl) {
      stateEl.textContent = scan ? (wordFor(STATE_WORDS, scan.state) || scan.state) as string : 'Not started';
      stateEl.dataset.state = scan ? scan.state as string : 'none';
    }
    if (coverageEl) {
      coverageEl.textContent = scan ? (wordFor(COVERAGE_WORDS, scan.coverage) || scan.coverage) as string : 'Unknown';
      coverageEl.dataset.coverage = scan ? scan.coverage as string : 'unknown';
    }
    const commitEl = $('#exposureCommit');
    if (commitEl) commitEl.textContent = scan && scan.commitSha ? String(scan.commitSha).slice(0, 12) : '\u2014';
    const filesEl = $('#exposureFiles');
    if (filesEl) filesEl.textContent = scan && Number.isFinite(scan.filesScanned) ? String(scan.filesScanned) : '\u2014';
    const commitsFact = $('#exposureCommitsFact');
    const commitsEl = $('#exposureCommits');
    if (commitsFact && commitsEl) {
      const historyScan = Boolean(scan && scan.scanMode === 'history');
      commitsFact.hidden = !historyScan;
      commitsEl.textContent = historyScan && Number.isInteger(field(scan, 'commitsScanned')) ? String(field(scan, 'commitsScanned')) : '\u2014';
    }
    const depth = $('#exposureHistoryToggle');
    if (depth && !depth.dataset.ready) {
      depth.checked = deps.historyPreferred();
      depth.dataset.ready = 'true';
    }
    const proof = $('#exposureProofLine');
    if (proof) {
      proof.textContent = current.error || proofLine(scan);
      proof.dataset.error = String(Boolean(current.error));
    }
    const breakdown = $('#exposureBreakdown');
    if (breakdown) {
      const words = breakdownLine(scan);
      breakdown.hidden = !words;
      breakdown.textContent = words;
    }
    const caveat = $('#exposureCaveat');
    if (caveat) {
      const reason = scan && scan.skippedReason ? wordFor(SKIPPED_WORDS, scan.skippedReason) : '';
      caveat.hidden = !reason;
      caveat.textContent = reason ? `Coverage is partial because ${reason}.` : '';
    }
    /* Clear, offered once there is something to clear, and armed like every other irreversible control here. */
    const clearButton = $('#exposureClearBtn');
    const clearWarning = $('#exposureClearWarning');
    const clearArmed = current.confirming === 'clear:history';
    const hasRecord = Boolean(scan || current.findings.length || current.history.length);
    if (clearButton) {
      clearButton.hidden = !hasRecord;
      clearButton.disabled = Boolean(current.clearing);
      clearButton.textContent = current.clearing ? 'Clearing\u2026' : clearArmed ? 'Delete all of it' : 'Clear history';
      clearButton.classList.toggle('exposure-clear-armed', clearArmed);
    }
    if (clearWarning) {
      clearWarning.hidden = !clearArmed;
      clearWarning.textContent = clearArmed
        ? 'This deletes every scan, finding and check result recorded for this repository under your account. The credentials themselves stay in the repository, and nothing here undoes the deletion.'
        : '';
    }
    const cancel = $('#exposureCancelBtn');
    if (cancel) cancel.hidden = !(scan && active);
    const scanButton = $('#exposureScanBtn');
    if (scanButton) {
      scanButton.disabled = Boolean(current.loading || (scan && active));
      scanButton.textContent = current.loading ? 'Please wait\u2026' : scan && active ? 'Scan in progress\u2026' : 'Scan this branch';
    }
    const refresh = $('#exposureRefreshBtn');
    if (refresh) {
      refresh.hidden = !current.error;
      refresh.disabled = current.loading;
      refresh.textContent = scan && active ? 'Retry status check' : 'Reload findings';
    }
    history(current);
    tally(current);
    const list = $('#exposureList');
    const empty = $('#exposureEmpty');
    if (!list || !empty) return;
    list.textContent = '';
    const shown = filtered(current as never) as Rec[];
    tools(current, shown.length);
    if ((current.findings.length || (current.counts && field(current.counts, 'all'))) && !shown.length) {
      empty.hidden = false;
      empty.textContent = current.loading ? 'Loading findings\u2026' : 'No findings match these filters.';
      return;
    }
    if (!current.findings.length) {
      /* "Nothing found" and "nothing found in the part we read" are different sentences. */
      empty.hidden = false;
      empty.textContent = !scan
        ? 'Nothing to show yet.'
        : active ? 'Waiting for scan results. This is not an all-clear.'
          : (scan.coverage === 'complete'
            ? 'No credentials were found in the tree this scan read.'
            : 'No credentials were found in the part of the tree this scan read. That is not an all-clear.');
      return;
    }
    empty.hidden = true;
    /* Worst first, then by file, so the order does not change between visits. */
    for (const finding of sortFindings(shown)) list.appendChild(findingItem(finding, current, true));
  }

  return { render, tally, announce, scopeKey };
}
