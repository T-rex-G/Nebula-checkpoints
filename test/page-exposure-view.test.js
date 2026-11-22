'use strict';

/*
 * The Exposure screen drawn, asked directly (features/exposure/exposure-view.ts):
 * the proof card and its facts, clear and cancel, the history grouped by day
 * and each scan's report, the tally, the toolbar built once and its events,
 * every finding's summary and body with its checks and two-press controls,
 * and what is said aloud. Every table is looked up by its own names, and
 * nothing a repository chose is ever drawn as markup.
 */

const assert = require('assert');
const { createExposureView, WHERE_OPTIONS, STATUS_OPTIONS } = require('../apps/web/src/features/exposure/exposure-view.ts');
const { freshExposureState } = require('../apps/web/src/features/exposure/exposure-controller.ts');
const { GLYPHS } = require('../apps/web/src/features/exposure/orbit-chip.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const NOW = Date.parse('2026-11-22T12:00:00Z');

class Node {
  constructor(tag, ns) {
    Object.assign(this, { tag, ns: ns || null, children: [], attrs: {}, dataset: {}, listeners: {}, styles: {}, _text: '', html: null, className: '', id: '', hidden: false, disabled: false,
      open: false, checked: false, value: '', title: '', dateTime: '', placeholder: '', autocomplete: '', spellcheck: true, type: '', options: [] });
    this.classList = {
      add: name => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '); },
      toggle: (name, on) => { const set = new Set(this.className.split(' ').filter(Boolean)); if (on) set.add(name); else set.delete(name); this.className = [...set].join(' '); },
      contains: name => this.className.split(' ').includes(name)
    };
    this.style = { setProperty: (name, value) => { this.styles[name] = value; } };
  }
  set textContent(value) { this._text = value == null ? '' : String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => (child instanceof Node ? child.textContent : child.text)).join(''); }
  set innerHTML(value) { this.html = String(value); this.children = []; }
  get innerHTML() { return this.html || ''; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  add(option) { this.options.push(option); }
  addEventListener(type, run) { (this.listeners[type] = this.listeners[type] || []).push(run); }
  fire(type) { for (const run of this.listeners[type] || []) run({ target: this }); }
  *walk() { for (const child of this.children) if (child instanceof Node) { yield child; yield* child.walk(); } }
  matches(part) {
    if (part.startsWith('.')) return part.slice(1).split('.').every(name => this.className.split(' ').includes(name));
    if (part.startsWith('#')) return this.id === part.slice(1);
    return this.tag === part;
  }
  querySelectorAll(selector) {
    let pool = [this];
    for (const part of selector.split(' ')) pool = [...new Set(pool.flatMap(node => [...node.walk()].filter(found => found.matches(part))))];
    return pool;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const IDS = ['exposureState', 'exposureCoverage', 'exposureCommit', 'exposureFiles', 'exposureCommitsFact', 'exposureCommits', 'exposureProofLine', 'exposureBreakdown', 'exposureCaveat',
  'exposureClearBtn', 'exposureClearWarning', 'exposureCancelBtn', 'exposureScanBtn', 'exposureRefreshBtn', 'exposureHistory', 'exposureHistoryEmpty', 'exposureHistoryMoreBtn',
  'exposureTally', 'exposureCount', 'exposureChips', 'exposureExpandAllBtn', 'exposureList', 'exposureEmpty', 'exposureTools', 'exposureLive', 'exposureHistoryToggle'];

function setup(change = () => {}, options = {}) {
  const doc = { createElement: tag => new Node(tag), createElementNS: (ns, tag) => new Node(tag, ns), createTextNode: text => ({ text }), activeElement: null };
  const pane = new Node('section');
  pane.id = 'tab-exposure';
  const proof = new Node('div');
  proof.className = 'exposure-proof';
  pane.appendChild(proof);
  const ids = { '#tab-exposure': pane };
  for (const id of IDS) { const node = new Node('div'); node.id = id; ids[`#${id}`] = node; if (!(options.missing || []).includes(id)) pane.appendChild(node); }
  const label = new Node('span');
  label.className = 'exposure-expand-label';
  ids['#exposureExpandAllBtn'].appendChild(label);
  const $ = selector => ((options.missing || []).some(id => selector === `#${id}`) ? null : ids[selector] || pane.querySelector(selector));
  const state = { work: 'work' in options ? options.work : { owner: 'octo', repo: 'repo' }, exposure: freshExposureState('github:octo/repo') };
  change(state.exposure);
  const log = [];
  const frames = [];
  const timers = [];
  const view = createExposureView({
    doc, $,
    current: () => state.exposure,
    work: () => state.work,
    visiting: () => Boolean(options.visiting),
    mutate: run => { run(state.exposure); log.push('mutate'); },
    filter: () => log.push(`filter ${JSON.stringify(state.exposure.view)}`),
    loadMore: () => log.push('more'),
    historyPreferred: () => options.preferred !== false,
    timeAgo: iso => (iso ? `ago ${iso}` : ''),
    now: () => NOW,
    option: (text, value) => ({ text, value }),
    exportMenu: (run, className, kinds) => { const menu = new Node('div'); menu.className = `audit-export ${className}`; const button = new Node('button'); button.className = 'audit-export-btn'; menu.appendChild(button); menu.run = run; menu.kinds = kinds; return menu; },
    exportFindings: kind => log.push(`export ${kind}`),
    frame: run => frames.push(run),
    timers: { set: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clear: handle => log.push(`clear ${handle}`) }
  });
  return { doc, pane, ids, state, log, frames, timers, view, $: selector => ids[selector] || pane.querySelector(selector) };
}
const scan = extra => ({ scanId: 's1', state: 'complete', coverage: 'complete', scanMode: 'tree', createdAt: '2026-11-22T10:00:00Z', refName: 'refs/heads/main', commitSha: 'c'.repeat(40),
  filesTotal: 3, filesScanned: 3, findingCount: 0, requestedBy: 'alice', ...extra });
const finding = extra => ({ fingerprint: 'f1', rule: 'github-token', path: 'src/a.js', displayPath: 'src/a.js', occurrences: [{ line: 4 }],
  narration: { severity: 'critical', what: 'A token.', consequence: 'It works.', where: 'In src.', action: 'Revoke it.' }, ...extra });
const text = node => (node ? node.textContent : null);
const all = (root, selector) => root.querySelectorAll(selector);

check('the key is the open repository, and what is said aloud is cleared first and spoken on the next frame', () => {
  const page = setup();
  assert.strictEqual(page.view.scopeKey(), 'github:octo/repo');
  page.state.work = { provider: 'gitlab', owner: 'a', repo: 'b' };
  assert.strictEqual(page.view.scopeKey(), 'gitlab:a/b');
  page.state.work = null;
  assert.strictEqual(page.view.scopeKey(), '');
  const live = page.ids['#exposureLive'];
  live.textContent = 'old';
  page.view.announce('Scan started.');
  assert.strictEqual(live.textContent, '');
  page.frames.shift()();
  assert.strictEqual(live.textContent, 'Scan started.');
  page.view.announce(null);
  page.frames.shift()();
  assert.strictEqual(live.textContent, '');
  const silent = setup(undefined, { missing: ['exposureLive'] });
  silent.view.announce('x');
  assert.strictEqual(silent.frames.length, 0, 'nothing to say it into, nothing scheduled');
});

check('before any scan the card asks for one, offers nothing to clear, and says there is nothing to show', () => {
  const page = setup();
  page.view.render();
  page.view.render();
  assert.strictEqual(all(page.pane, '.exposure-radar').length, 1, 'the radar is drawn once');
  const radar = page.pane.querySelector('.exposure-radar');
  assert.strictEqual(radar.attrs['aria-hidden'], 'true');
  assert.strictEqual(all(radar, 'circle').length, 1 + [13, 25, 37, 49].reduce((sum, r) => sum + Math.round((Math.PI * 2 * r) / 8.2), 0));
  assert.strictEqual(page.pane.querySelector('.exposure-proof').dataset.scanning, 'false');
  assert.deepStrictEqual([text(page.ids['#exposureState']), page.ids['#exposureState'].dataset.state], ['Not started', 'none']);
  assert.deepStrictEqual([text(page.ids['#exposureCoverage']), page.ids['#exposureCoverage'].dataset.coverage], ['Unknown', 'unknown']);
  assert.deepStrictEqual([text(page.ids['#exposureCommit']), text(page.ids['#exposureFiles'])], ['\u2014', '\u2014']);
  assert.strictEqual(page.ids['#exposureCommitsFact'].hidden, true);
  assert.strictEqual(text(page.ids['#exposureProofLine']), 'Start a scan to check this branch for exposed credentials.');
  assert.strictEqual(page.ids['#exposureProofLine'].dataset.error, 'false');
  assert.strictEqual(page.ids['#exposureBreakdown'].hidden, true);
  assert.strictEqual(page.ids['#exposureCaveat'].hidden, true);
  assert.strictEqual(page.ids['#exposureClearBtn'].hidden, true);
  assert.strictEqual(page.ids['#exposureCancelBtn'].hidden, true);
  assert.deepStrictEqual([page.ids['#exposureScanBtn'].disabled, text(page.ids['#exposureScanBtn'])], [false, 'Scan this branch']);
  assert.deepStrictEqual([page.ids['#exposureRefreshBtn'].hidden, text(page.ids['#exposureRefreshBtn'])], [true, 'Reload findings']);
  assert.deepStrictEqual([page.ids['#exposureEmpty'].hidden, text(page.ids['#exposureEmpty'])], [false, 'Nothing to show yet.']);
  assert.strictEqual(page.ids['#exposureTools'].hidden, true);
  assert.strictEqual(page.ids['#exposureHistoryToggle'].checked, true);
  assert.strictEqual(page.ids['#exposureHistoryToggle'].dataset.ready, 'true');
  const shallow = setup(undefined, { preferred: false });
  shallow.ids['#exposureHistoryToggle'].dataset.ready = 'true';
  shallow.ids['#exposureHistoryToggle'].checked = true;
  shallow.view.render();
  assert.strictEqual(shallow.ids['#exposureHistoryToggle'].checked, true, 'the depth a reader chose is not overwritten');
  const none = setup(undefined, { missing: ['exposureList'] });
  none.view.render();
  assert.strictEqual(none.ids['#exposureTools'].dataset.ready, undefined, 'without a list there are no tools');
});

check('a running scan is working and nothing more: no all-clear, a cancel, and a retry when its status failed', () => {
  const page = setup(now => { now.scan = scan({ state: 'running', coverage: 'unknown', scanMode: 'history', commitsScanned: 4, filesScanned: 2 }); now.error = 'Lost the scan.'; });
  page.view.render();
  assert.strictEqual(page.pane.querySelector('.exposure-proof').dataset.scanning, 'true');
  assert.deepStrictEqual([text(page.ids['#exposureState']), text(page.ids['#exposureCoverage'])], ['Running', 'Unknown']);
  assert.deepStrictEqual([page.ids['#exposureCommitsFact'].hidden, text(page.ids['#exposureCommits'])], [false, '4']);
  assert.strictEqual(text(page.ids['#exposureCommit']), 'c'.repeat(12));
  assert.strictEqual(text(page.ids['#exposureFiles']), '2');
  assert.deepStrictEqual([text(page.ids['#exposureProofLine']), page.ids['#exposureProofLine'].dataset.error], ['Lost the scan.', 'true']);
  assert.strictEqual(page.ids['#exposureCancelBtn'].hidden, false);
  assert.deepStrictEqual([page.ids['#exposureScanBtn'].disabled, text(page.ids['#exposureScanBtn'])], [true, 'Scan in progress\u2026']);
  assert.deepStrictEqual([page.ids['#exposureRefreshBtn'].hidden, text(page.ids['#exposureRefreshBtn'])], [false, 'Retry status check']);
  assert.strictEqual(text(page.ids['#exposureEmpty']), 'Waiting for scan results. This is not an all-clear.');
  const waiting = setup(now => { now.loading = true; now.scan = scan({ commitsScanned: '4', scanMode: 'history', filesScanned: '3' }); });
  waiting.view.render();
  assert.deepStrictEqual([waiting.ids['#exposureScanBtn'].disabled, text(waiting.ids['#exposureScanBtn'])], [true, 'Please wait\u2026']);
  assert.strictEqual(text(waiting.ids['#exposureCommits']), '\u2014', 'a count that is not a number is not shown');
  assert.strictEqual(text(waiting.ids['#exposureFiles']), '\u2014');
});

check('a finished scan says what it read, and an empty list under partial coverage is never an all-clear', () => {
  const whole = setup(now => { now.scan = scan(); });
  whole.view.render();
  assert.strictEqual(whole.ids['#exposureCancelBtn'].hidden, true, 'nothing running, nothing to cancel');
  assert.strictEqual(text(whole.ids['#exposureEmpty']), 'No credentials were found in the tree this scan read.');
  assert.deepStrictEqual([whole.ids['#exposureBreakdown'].hidden, text(whole.ids['#exposureBreakdown'])], [false, 'Read 3 of 3 files.']);
  const part = setup(now => { now.scan = scan({ state: 'partial', coverage: 'partial', skippedReason: 'time-limit' }); });
  part.view.render();
  assert.strictEqual(text(part.ids['#exposureEmpty']), 'No credentials were found in the part of the tree this scan read. That is not an all-clear.');
  assert.strictEqual(part.ids['#exposureCaveat'].hidden, false);
  assert.match(text(part.ids['#exposureCaveat']), /^Coverage is partial because .+\.$/);
  const odd = setup(now => { now.scan = scan({ state: 'constructor', coverage: 'toString', skippedReason: 'constructor' }); });
  odd.view.render();
  assert.deepStrictEqual([text(odd.ids['#exposureState']), text(odd.ids['#exposureCoverage'])], ['constructor', 'toString'], 'a name the server never sent is shown as itself');
  assert.strictEqual(odd.ids['#exposureCaveat'].hidden, true, 'a reason with no word gives no caveat');
});

check('clear is offered once there is a record, and armed says what goes', () => {
  const page = setup(now => { now.history = [scan()]; now.confirming = 'clear:history'; });
  page.view.render();
  const button = page.ids['#exposureClearBtn'];
  assert.deepStrictEqual([button.hidden, button.disabled, text(button), button.classList.contains('exposure-clear-armed')], [false, false, 'Delete all of it', true]);
  assert.strictEqual(page.ids['#exposureClearWarning'].hidden, false);
  assert.match(text(page.ids['#exposureClearWarning']), /^This deletes every scan, finding and check result/);
  page.state.exposure.confirming = '';
  page.state.exposure.clearing = true;
  page.view.render();
  assert.deepStrictEqual([button.disabled, text(button), button.classList.contains('exposure-clear-armed')], [true, 'Clearing\u2026', false]);
  assert.deepStrictEqual([page.ids['#exposureClearWarning'].hidden, text(page.ids['#exposureClearWarning'])], [true, '']);
  page.state.exposure.clearing = false;
  page.view.render();
  assert.strictEqual(text(button), 'Clear history');
});

check('the history is newest first, grouped by day, and each scan opens into its own report', () => {
  const reports = {
    a: { loading: true },
    b: { loading: false, error: 'That report could not be read.' },
    c: { loading: false, error: '', complete: true, entries: [] },
    d: { loading: false, error: '', complete: false, entries: [] },
    e: { loading: false, error: '', complete: true, entries: [finding({ fingerprint: 'w', narration: { severity: 'warning' } }), finding({ fingerprint: 'c' })] },
    f: { loading: false, error: '', complete: false, entries: [] },
    shut: { loading: false, error: 'Never read.' }
  };
  const page = setup(now => {
    now.history = [
      scan({ scanId: 'a', createdAt: '2026-11-22T11:00:00Z', severityCounts: { critical: 1 }, findingCount: 1 }), scan({ scanId: 'b', createdAt: '2026-11-22T09:00:00Z', scanMode: 'history', refName: 'refs/tags/v1' }),
      scan({ scanId: 'c', createdAt: '2026-11-21T09:00:00Z', commitSha: null }), scan({ scanId: 'd', createdAt: 'nonsense', coverage: 'partial', skippedReason: 'time-limit' }),
      scan({ scanId: 'e', createdAt: '2026-11-01T09:00:00Z' }), scan({ scanId: 'constructor', createdAt: '2026-11-01T08:00:00Z' }),
      scan({ scanId: 'f', createdAt: '2026-11-01T07:00:00Z' }), scan({ scanId: 'shut', createdAt: '2026-11-01T06:00:00Z' })
    ];
    now.reports = reports;
    now.openScans = new Set(['a', 'b', 'c', 'd', 'e', 'constructor', 'f']);
    now.expanded = new Set(['w', 'c']);
  });
  page.view.render();
  const host = page.ids['#exposureHistory'];
  assert.deepStrictEqual(host.children.map(node => [node.tag, node.tag === 'h3' ? text(node) : node.children.length]),
    [['h3', 'Today'], ['ol', 2], ['h3', 'Yesterday'], ['ol', 1], ['h3', 'Undated'], ['ol', 1], ['h3', new Date('2026-11-01T09:00:00Z').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })], ['ol', 4]]);
  const scans = all(host, '.exposure-scan');
  const body = id => scans.find(node => node.dataset.scanId === id).querySelector('.exposure-scan-body');
  assert.deepStrictEqual(scans.filter(node => !node.open).map(node => node.dataset.scanId), ['shut']);
  assert.deepStrictEqual(all(body('shut'), 'p').map(text), ['Whole tree read. Read 3 of 3 files. Requested by alice.'], 'a closed scan\u2019s report is not read');
  assert.deepStrictEqual(all(body('f'), 'p').map(text).slice(-1), ['This scan found no credentials in the part of the tree it read. That is not an all-clear.'], 'a report only partly loaded is not an all-clear even over a whole tree');
  assert.strictEqual(text(body('a').querySelector('.exposure-empty')), 'Loading this scan\u2019s report\u2026');
  assert.strictEqual(text(body('b').querySelector('.exposure-empty')), 'That report could not be read.');
  assert.strictEqual(text(body('c').querySelector('.exposure-empty')), 'This scan found no credentials in the tree it read.');
  assert.deepStrictEqual(all(body('d'), 'p').map(text).slice(-2),
    ['Only part of this scan report was loaded. Close and reopen the report after refreshing to retrieve current evidence.', 'This scan found no credentials in the part of the tree it read. That is not an all-clear.']);
  assert.match(text(body('d')), /Coverage is partial because /);
  assert.deepStrictEqual(all(body('e'), '.exposure-item').map(node => node.dataset.severity), ['critical', 'warning'], 'worst first');
  assert.strictEqual(all(body('e'), '.exposure-item-actions').length, 0, 'a past report offers no controls');
  assert.ok(all(body('e'), '.exposure-disclosure').every(node => !node.open), 'a past report is not opened by the current list');
  assert.strictEqual(text(body('constructor').querySelector('.exposure-empty')), 'Loading this scan\u2019s report\u2026', 'a report is found by its own scan only');
  const first = scans[0].querySelector('.exposure-scan-summary');
  assert.strictEqual(first.querySelector('.exposure-scan-time').dateTime, '2026-11-22T11:00:00Z');
  assert.strictEqual(text(first.querySelector('.exposure-scan-ago')), 'ago 2026-11-22T11:00:00Z');
  assert.deepStrictEqual([first.querySelector('.exposure-scan-counts').dataset.found, text(first.querySelector('.exposure-scan-counts'))], ['true', '1 critical']);
  assert.strictEqual(text(first.querySelector('.exposure-scan-ref')), `main @ ccccccc`);
  assert.strictEqual(text(scans[1].querySelector('.exposure-scan-ref')), 'v1 @ ccccccc \u00b7 with history');
  assert.strictEqual(text(scans[2].querySelector('.exposure-scan-ref')), 'main @ \u2014');
  const undated = scans[3].querySelector('.exposure-scan-time');
  assert.deepStrictEqual([text(undated), undated.title], ['\u2014', '']);
  const state = first.querySelector('.exposure-scan-state');
  assert.deepStrictEqual([state.dataset.tone, state.dataset.state, text(state)], ['neutral', 'complete', 'Complete']);
  assert.match(text(body('a').querySelector('.exposure-scan-facts')), /^Whole tree read\. Read 3 of 3 files\. Requested by alice\.$/);
  assert.deepStrictEqual([page.ids['#exposureHistoryMoreBtn'].hidden, page.ids['#exposureHistoryMoreBtn'].disabled, text(page.ids['#exposureHistoryMoreBtn'])], [false, false, 'Show older scans']);
  assert.strictEqual(page.ids['#exposureHistoryEmpty'].hidden, true);
});

check('an empty history says why, and the older-scans control follows the loading and the end', () => {
  const page = setup(now => { now.historyLoading = true; });
  page.view.render();
  assert.deepStrictEqual([page.ids['#exposureHistoryEmpty'].hidden, text(page.ids['#exposureHistoryEmpty'])], [false, 'Loading scan history\u2026']);
  assert.strictEqual(page.ids['#exposureHistoryMoreBtn'].hidden, true);
  page.state.exposure.historyLoading = false;
  page.view.render();
  assert.strictEqual(text(page.ids['#exposureHistoryEmpty']), 'No scans yet. Each scan you run is kept here, newest first.');
  page.state.exposure.historyError = 'History failed.';
  page.view.render();
  assert.strictEqual(text(page.ids['#exposureHistoryEmpty']), 'History failed.');
  page.state.exposure.history = [scan({ state: 'queued' })];
  page.state.exposure.historyLoading = true;
  page.view.render();
  assert.deepStrictEqual([page.ids['#exposureHistoryEmpty'].hidden, text(page.ids['#exposureHistoryEmpty'])], [false, 'History failed.'], 'an error over a kept history still shows');
  assert.deepStrictEqual([page.ids['#exposureHistoryMoreBtn'].disabled, text(page.ids['#exposureHistoryMoreBtn'])], [true, 'Loading\u2026']);
  const queued = page.ids['#exposureHistory'].querySelector('.exposure-scan-state');
  assert.deepStrictEqual([queued.dataset.tone, queued.dataset.beam], ['info', 'on']);
  page.state.exposure.historyDone = true;
  page.state.exposure.historyError = '';
  page.view.render();
  assert.deepStrictEqual([page.ids['#exposureHistoryEmpty'].hidden, page.ids['#exposureHistoryMoreBtn'].hidden], [true, true]);
  const failed = setup(now => { now.history = [scan({ state: 'failed' })]; });
  failed.view.render();
  assert.strictEqual(failed.ids['#exposureHistory'].querySelector('.exposure-scan-state').dataset.tone, 'warning');
});

check('the tally counts the list, or what the server counted, and the open-all control says which it will do', () => {
  const page = setup(now => { now.findings = [finding(), finding({ fingerprint: 'f2', narration: { severity: 'warning' }, disposition: 'accepted-risk' })]; now.expanded = new Set(['f1']); });
  page.view.tally(page.state.exposure);
  assert.strictEqual(text(page.ids['#exposureTally']), '2 findings: 1 critical, 1 warning. 1 still open.');
  assert.deepStrictEqual([page.ids['#exposureCount'].hidden, text(page.ids['#exposureCount'])], [false, '2']);
  const chips = page.ids['#exposureChips'].children;
  assert.deepStrictEqual(chips.map(node => [node.dataset.tone, node.dataset.beam, node.dataset.severity, text(node)]),
    [['critical', 'on', 'critical', '1 critical'], ['warning', undefined, 'warning', '1 warning'], ['pending', undefined, undefined, '1 open']]);
  const toggle = page.ids['#exposureExpandAllBtn'];
  assert.deepStrictEqual([toggle.hidden, text(toggle.querySelector('.exposure-expand-label')), toggle.attrs['aria-expanded']], [false, 'Expand all', 'false']);
  page.state.exposure.expanded.add('f2');
  page.view.tally(page.state.exposure);
  assert.deepStrictEqual([text(toggle.querySelector('.exposure-expand-label')), toggle.attrs['aria-expanded']], ['Collapse all', 'true']);
  page.state.exposure.counts = { all: 9, bySeverity: { serious: 4 } };
  page.view.tally(page.state.exposure);
  assert.strictEqual(text(page.ids['#exposureTally']), '9 findings: 1 critical, 4 serious, 1 warning. 0 still open.', 'no counted dispositions, none open');
  page.state.exposure.counts = { all: 1, bySeverity: { critical: 1, warning: 0 }, byDisposition: { open: 1 } };
  page.view.tally(page.state.exposure);
  assert.strictEqual(text(page.ids['#exposureTally']), '1 finding: 1 critical. 1 still open.');
  const empty = setup();
  empty.view.tally(empty.state.exposure);
  assert.deepStrictEqual([empty.ids['#exposureTally'].hidden, text(empty.ids['#exposureTally']), empty.ids['#exposureChips'].children.length, empty.ids['#exposureExpandAllBtn'].hidden], [true, '', 0, true]);
  assert.deepStrictEqual([empty.ids['#exposureCount'].hidden, text(empty.ids['#exposureCount']), empty.ids['#exposureChips'].hidden], [true, '', true]);
  assert.strictEqual(empty.ids['#exposureExpandAllBtn'].attrs['aria-expanded'], 'false', 'nothing to open is not all open');
});

check('the toolbar is built once, and each of its controls changes the view and asks for the list again', () => {
  assert.deepStrictEqual(WHERE_OPTIONS.map(([value]) => value), ['all', 'tree', 'history', 'archive', 'encoded']);
  assert.deepStrictEqual(STATUS_OPTIONS.map(([value]) => value), ['all', 'open', 'credential-rejected', 'accepted-risk', 'removed-from-tree']);
  assert.ok(Object.isFrozen(WHERE_OPTIONS) && Object.isFrozen(STATUS_OPTIONS));
  const page = setup(now => { now.findings = [finding(), finding({ fingerprint: 'f2', narration: { severity: 'warning' } })]; now.nextCursor = 'n'; });
  page.view.render();
  page.view.render();
  const tools = page.ids['#exposureTools'];
  assert.deepStrictEqual([tools.hidden, tools.dataset.ready, tools.children.length], [false, 'true', 3]);
  const segments = all(tools, '.audit-segment');
  assert.deepStrictEqual(segments.map(node => [node.dataset.value, node.attrs['aria-pressed'], text(node.querySelector('.audit-segment-n')), node.disabled]),
    [['all', 'true', '2', false], ['critical', 'false', '1', false], ['serious', 'false', '0', true], ['warning', 'false', '1', false]]);
  assert.deepStrictEqual(tools.querySelector('#exposureStatusFilter').options.map(o => o.value), STATUS_OPTIONS.map(([value]) => value));
  assert.strictEqual(text(tools.querySelector('#exposureShown')), '2 findings');
  assert.deepStrictEqual([tools.querySelector('#exposureResetFilters').hidden, tools.querySelector('#exposureLoadMore').hidden], [true, false]);
  assert.strictEqual(tools.querySelector('.audit-search').innerHTML.startsWith('<svg class="audit-ico"'), true);
  segments[1].fire('click');
  assert.strictEqual(page.state.exposure.view.severity, 'critical');
  assert.deepStrictEqual(page.log.slice(-2), ['mutate', `filter ${JSON.stringify(page.state.exposure.view)}`]);
  const status = tools.querySelector('#exposureStatusFilter');
  status.value = 'open';
  status.fire('change');
  const where = tools.querySelector('#exposureWhereFilter');
  where.value = 'history';
  where.fire('change');
  assert.deepStrictEqual([page.state.exposure.view.status, page.state.exposure.view.where], ['open', 'history']);
  const input = tools.querySelector('#exposureSearch');
  input.value = 'x'.repeat(130);
  input.fire('input');
  input.fire('input');
  assert.deepStrictEqual(page.log.slice(-2), ['clear 0', 'clear 1'], 'each keystroke waits again');
  assert.deepStrictEqual(page.timers.map(t => t.ms), [140, 140]);
  page.timers[1].run();
  assert.strictEqual(page.state.exposure.view.query, 'x'.repeat(120));
  page.doc.activeElement = input;
  input.value = 'typing';
  page.view.render();
  assert.strictEqual(input.value, 'typing', 'a poll never overwrites the box being typed in');
  page.doc.activeElement = null;
  page.view.render();
  assert.strictEqual(input.value, 'x'.repeat(120));
  assert.deepStrictEqual(segments.map(node => node.disabled), [false, false, true, false]);
  assert.strictEqual(text(tools.querySelector('#exposureShown')), '0 of 2 shown');
  tools.querySelector('#exposureResetFilters').fire('click');
  assert.deepStrictEqual(page.state.exposure.view, { severity: null, status: 'all', where: 'all', query: '' });
  assert.strictEqual(input.value, '');
  tools.querySelector('#exposureLoadMore').fire('click');
  tools.querySelector('.audit-export').run('sarif');
  assert.deepStrictEqual(page.log.slice(-2), ['more', 'export sarif']);
  assert.deepStrictEqual(tools.querySelector('.audit-export').kinds, ['csv', 'sarif']);
  page.state.exposure.view.status = 'accepted-risk';
  page.state.exposure.view.where = 'archive';
  page.view.render();
  assert.deepStrictEqual([status.value, where.value], ['accepted-risk', 'archive'], 'the selects follow the view');
  Object.assign(page.state.exposure.view, { status: 'all', where: 'all' });
  page.state.exposure.view.severity = 'serious';
  page.view.render();
  assert.strictEqual(segments[2].disabled, false, 'the segment chosen stays pressable even when empty');
  assert.strictEqual(text(page.ids['#exposureEmpty']), 'No findings match these filters.');
  assert.strictEqual(tools.querySelector('.audit-export-btn').disabled, true, 'nothing shown, nothing to export');
  page.state.exposure.view.severity = null;
  page.state.exposure.exporting = true;
  page.view.render();
  assert.strictEqual(tools.querySelector('.audit-export-btn').disabled, true);
  page.state.exposure.exporting = false;
  page.state.exposure.paged = true;
  page.state.exposure.total = 7;
  page.state.exposure.counts = { all: 12, bySeverity: { critical: 3 } };
  page.view.render();
  assert.strictEqual(text(tools.querySelector('#exposureShown')), '2 of 7 matching findings loaded (12 total)');
  assert.strictEqual(text(segments[1].querySelector('.audit-segment-n')), '3');
  assert.strictEqual(tools.querySelector('.audit-export-btn').disabled, false);
  page.state.exposure.loading = true;
  page.state.exposure.nextCursor = null;
  page.view.render();
  assert.deepStrictEqual([tools.querySelector('#exposureLoadMore').hidden, tools.querySelector('#exposureLoadMore').disabled, tools.querySelector('.audit-export-btn').disabled], [true, true, true]);
});

check('a finding is summed up by how bad, what, where and what was decided, and never shows the raw path', () => {
  const page = setup(now => {
    now.findings = [
      finding({ path: 'token=abc.env', displayPath: 'a redacted file', inTree: false, introducedCommit: 'abcdef1234', decodedFrom: 'base64' }),
      finding({ fingerprint: 'f2', rule: 'supabase-anon-key', path: 'x.zip!/y.env', displayPath: undefined, occurrences: [], narration: null, placeholder: '<p>', disposition: 'toString', inTree: false, introducedCommit: 'XYZ1234567' }),
      finding({ fingerprint: 'f3', narration: { severity: 'constructor' }, disposition: 'accepted-risk', dispositionBy: 'alice', dispositionAt: '2026-11-22T11:00:00Z' }),
      finding({ fingerprint: 'f4', displayPath: 'z.js', narration: { severity: 'warning' }, disposition: 'accepted-risk', dispositionNarration: 'Kept on purpose.' })
    ];
    now.expanded = new Set(['f1']);
  });
  page.view.render();
  const items = all(page.ids['#exposureList'], '.exposure-item').slice(0, 3);
  const four = all(page.ids['#exposureList'], '.exposure-item')[3];
  assert.strictEqual(text(four.querySelector('.exposure-item-disposition')), 'Kept on purpose.', 'the decision in its own words');
  assert.strictEqual(text(four.querySelector('.exposure-item-provenance')), 'Accepted, but this record does not name who accepted it.');
  assert.strictEqual(page.ids['#exposureEmpty'].hidden, true, 'a drawn list has no empty line');
  assert.deepStrictEqual(items.map(node => [node.dataset.severity, node.dataset.disposition]), [['critical', 'open'], ['serious', 'accepted-risk'], ['serious', 'toString']]);
  const [one, three, two] = items;
  assert.deepStrictEqual(items.map(node => node.querySelector('.exposure-disclosure').open), [true, false, false]);
  assert.strictEqual(text(one.querySelector('.exposure-item-location')), 'a redacted file:4');
  assert.strictEqual(text(two.querySelector('.exposure-item-location')), 'a file');
  assert.ok(!JSON.stringify(text(page.ids['#exposureList'])).includes('token=abc'), 'the raw path is never drawn');
  assert.deepStrictEqual(all(one, '.exposure-tag').map(node => [node.dataset.kind, node.dataset.tone, text(node)]),
    [['history', 'info', 'Only in history \u00b7 abcdef1'], ['encoded', 'neutral', 'Base64-encoded']]);
  assert.deepStrictEqual(all(two, '.exposure-tag').map(node => [node.dataset.kind, text(node)]), [['history', 'Only in history'], ['archive', 'In an archive']], 'a commit that is not hex is not shown');
  assert.strictEqual(three.querySelector('.exposure-item-tags').hidden, true);
  assert.deepStrictEqual([text(one.querySelector('.exposure-item-title')), text(two.querySelector('.exposure-item-title'))], ['GitHub token', 'Supabase anon key']);
  const status = node => node.querySelector('.exposure-item-status');
  assert.deepStrictEqual([status(one).dataset.tone, text(status(one))], ['serious', 'Open']);
  assert.deepStrictEqual([status(two).dataset.tone, text(status(two)), status(two).querySelector('path').attrs.d], ['neutral', 'toString', GLYPHS.open], 'a disposition the server never sent is shown as itself, neutral and open');
  assert.deepStrictEqual([status(three).dataset.tone, text(status(three))], ['info', 'Accepted']);
  assert.strictEqual(text(two.querySelector('.exposure-item-what')), '<p>', 'a placeholder is text');
  assert.strictEqual(text(two.querySelector('.exposure-item-disposition')), 'Status: toString');
  assert.strictEqual(text(three.querySelector('.exposure-item-provenance')), 'Accepted by alice ago 2026-11-22T11:00:00Z.');
  assert.deepStrictEqual(all(one, 'p').slice(0, 4).map(text), ['A token.', 'It works.', 'In src.', 'Revoke it.']);
  assert.strictEqual(all(two, '.exposure-item-actions').length, 0, 'only an open finding offers controls');
  for (const node of page.pane.walk()) if (!node.classList.contains('audit-search')) assert.strictEqual(node.html, null, `${node.tag}.${node.className} drawn as markup`);
});

check('what the provider and the project answered is shown apart from the decision, and only while it is fresh', () => {
  const answers = {
    f1: { state: 'verified', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z', narration: '' },
    f2: { state: 'rejected', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-22T11:30:00Z', narration: 'Said.' },
    f3: { state: 'constructor', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z', narration: '' },
    f4: { state: 'verified', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z', narration: 'Live, said the provider.' }
  };
  const page = setup(now => {
    now.findings = ['f1', 'f2', 'f3', 'f4', 'toString'].map(fingerprint => finding({ fingerprint, disposition: fingerprint === 'f3' ? 'accepted-risk' : 'open' }));
    now.verifications = answers;
    now.probes = {
      f1: { state: 'readable', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z', narration: '', relation: 'profiles', projection: ['id', 'email'] },
      f2: { state: 'denied', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z', narration: 'No.', relation: 'profiles', projection: 'id' },
      f3: { state: 'readable', observedAt: '2026-11-21T11:00:00Z', freshnessDeadline: '2026-11-22T11:00:00Z', narration: 'Read.' }
    };
  });
  page.view.render();
  const body = id => page.ids['#exposureList'].querySelector('.exposure-disclosure') && all(page.ids['#exposureList'], '.exposure-disclosure').find(node => node.dataset.fingerprint === id);
  const liveness = id => body(id).querySelector('.exposure-item-liveness');
  assert.deepStrictEqual([liveness('f1').dataset.state, text(liveness('f1'))], ['verified', 'The provider confirmed this credential is live.']);
  assert.deepStrictEqual([liveness('f2').dataset.state, text(liveness('f2'))], ['stale', 'Previous verification (rejected) expired or has no valid check time. Check again for current evidence.']);
  assert.strictEqual(text(liveness('f3')), 'The provider was asked and the answer was not interpreted.', 'a state the server never sent finds no word');
  assert.strictEqual(liveness('toString'), null, 'an answer is found by its own finding only');
  assert.strictEqual(body('toString').querySelector('.exposure-item-readability'), null);
  const readability = id => body(id).querySelector('.exposure-item-readability');
  assert.match(text(readability('f1')), / Asked: profiles \(id, email\)\.$/);
  assert.strictEqual(readability('f1').dataset.state, 'readable');
  assert.strictEqual(text(readability('f2')), 'No. Asked: profiles ().', 'columns that are not a list are none');
  assert.deepStrictEqual([readability('f3').dataset.state, text(readability('f3'))], ['stale', 'Previous readability result (readable) expired or has no valid check time. Check again for current evidence.']);
  assert.strictEqual(text(liveness('f4')), 'Live, said the provider.', 'the provider\u2019s own words first');
});

check('an open finding offers two-press controls, one armed at a time, and a visitor is offered none', () => {
  const page = setup(now => {
    now.findings = [finding(), finding({ fingerprint: 'f2', verifiable: false }), finding({ fingerprint: 'f3', rule: 'supabase-anon-key' })];
    now.confirming = 'verify:f1';
    now.verifying = 'f1';
    now.accepting = 'f2';
    now.probeDrafts = { f3: { relation: 'profiles', columns: 'id' } };
  });
  page.view.render();
  const body = id => all(page.ids['#exposureList'], '.exposure-disclosure').find(node => node.dataset.fingerprint === id);
  const one = body('f1');
  assert.match(text(one.querySelector('.exposure-item-warning')), /^Continue only if you own this credential/);
  const verify = one.querySelector('.exposure-verify');
  assert.deepStrictEqual([text(verify), verify.disabled, verify.classList.contains('exposure-verify-armed'), verify.dataset.fingerprint, verify.type], ['Send this credential to the provider', true, true, 'f1', 'button']);
  assert.deepStrictEqual([text(one.querySelector('.exposure-accept')), one.querySelector('.exposure-accept').disabled], ['This one is intended', false]);
  assert.strictEqual(body('f2').querySelector('.exposure-verify'), null, 'no verifier, no control');
  assert.strictEqual(body('f2').querySelector('.exposure-accept').disabled, true);
  assert.strictEqual(body('f2').querySelector('.exposure-item-warning'), null);
  assert.strictEqual(one.querySelector('.exposure-probe-form'), null, 'only an anonymous key is asked what the public can read');
  const form = body('f3').querySelector('.exposure-probe-form');
  assert.strictEqual(form.dataset.fingerprint, 'f3');
  assert.deepStrictEqual(all(form, '.exposure-probe-input').map(input => [input.dataset.field, input.value, input.placeholder, input.type, input.autocomplete, input.spellcheck]),
    [['relation', 'profiles', 'profiles', 'text', 'off', false], ['columns', 'id', 'id, email', 'text', 'off', false]]);
  assert.deepStrictEqual([text(form.querySelector('.exposure-probe')), form.querySelector('.exposure-probe').disabled], ['Ask what the public can read', false]);
  page.state.exposure.confirming = 'probe:f3';
  page.state.exposure.probing = 'f3';
  page.view.render();
  const armed = body('f3').querySelector('.exposure-probe');
  assert.deepStrictEqual([text(armed), armed.disabled, armed.classList.contains('exposure-probe-armed')], ['Ask this project now', true, true]);
  assert.match(text(body('f3').querySelector('.exposure-item-warning')), /^Continue only if you own this project/);
  assert.strictEqual(body('f1').querySelector('.exposure-item-warning'), null, 'only one control is armed');
  page.state.exposure.confirming = 'accept:f2';
  page.view.render();
  assert.deepStrictEqual([text(body('f2').querySelector('.exposure-accept')), body('f2').querySelector('.exposure-accept').classList.contains('exposure-accept-armed')], ['Record me as accepting this exposure', true]);
  assert.match(text(body('f2').querySelector('.exposure-item-warning')), /^This records you as having accepted the exposure\./);
  const empty = setup(now => { now.findings = [finding({ rule: 'supabase-anon-key' })]; });
  empty.view.render();
  assert.deepStrictEqual(all(empty.ids['#exposureList'], '.exposure-probe-input').map(input => input.value), ['', '']);
  const visitor = setup(now => { now.findings = [finding(), finding({ fingerprint: 'f2', disposition: 'accepted-risk' })]; }, { visiting: true });
  visitor.view.render();
  assert.strictEqual(all(visitor.ids['#exposureList'], '.exposure-item-visitor').length, 1);
  assert.strictEqual(all(visitor.ids['#exposureList'], '.exposure-item-actions').length, 0);
});

check('a page without the screen draws nothing, and a missing part is skipped without stopping the rest', () => {
  const none = setup(undefined, { missing: [] });
  delete none.ids['#tab-exposure'];
  const bare = createExposureView({ doc: none.doc, $: () => null, current: () => { throw new Error('read'); }, work: () => null, visiting: () => false, mutate() {}, filter() {}, loadMore() {},
    historyPreferred: () => true, timeAgo: () => '', now: () => NOW, option: () => ({}), exportMenu: () => ({}), exportFindings() {}, frame() {}, timers: { set: () => 0, clear() {} } });
  bare.render();
  const partial = setup(now => { now.scan = scan(); now.findings = [finding()]; }, { missing: ['exposureHistoryEmpty', 'exposureEmpty', 'exposureChips', 'exposureHistoryMoreBtn'] });
  partial.view.render();
  assert.strictEqual(text(partial.ids['#exposureState']), 'Complete');
  assert.strictEqual(partial.ids['#exposureHistory'].children.length, 0, 'without its empty line the history is left alone');
  assert.strictEqual(partial.ids['#exposureList'].children.length, 0, 'without its empty line the list is left alone');
  assert.strictEqual(text(partial.ids['#exposureTally']), '1 finding: 1 critical. 1 still open.');
});

(async () => {
  let failed = 0;
  let finished = false;
  process.on('exit', () => { if (!finished) { console.error('not ok - a check never settled'); process.exitCode = 1; } });
  for (const [name, run] of checks) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  finished = true;
  if (failed) process.exit(1);
  console.log(`page exposure view: ${checks.length} checks passed`);
})();
