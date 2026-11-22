'use strict';

/*
 * The Exposure screen's words and reckoning, asked directly
 * (features/exposure/exposure-words.ts), and the Orbit chip the security
 * screens share (features/exposure/orbit-chip.ts).
 */

const assert = require('assert');
const words = require('../apps/web/src/features/exposure/exposure-words.ts');
const { GLYPHS, orbitChip } = require('../apps/web/src/features/exposure/orbit-chip.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

check('the fallbacks and the tables are frozen, and a name the server never sent finds no word', () => {
  for (const table of [words.VERIFICATION_FALLBACK, words.PROBE_FALLBACK, words.DISPOSITION_FALLBACK, words.STATE_WORDS, words.COVERAGE_WORDS, words.SKIPPED_WORDS,
    words.SEVERITY_RANK, words.SEVERITY_WORDS, words.DISPOSITION_WORDS, words.DISPOSITION_TONE, GLYPHS]) assert.ok(Object.isFrozen(table));
  assert.deepStrictEqual(Object.keys(words.STATE_WORDS), ['queued', 'running', 'complete', 'partial', 'failed', 'canceled']);
  assert.strictEqual(words.STATE_WORDS.partial, 'Finished, partial');
  assert.strictEqual(words.COVERAGE_WORDS.partial, 'Part of the tree read');
  assert.strictEqual(Object.keys(words.SKIPPED_WORDS).length, 12);
  assert.strictEqual(words.SKIPPED_WORDS['rate-limited'], 'GitHub asked for fewer requests, so the history was not read to the end');
  assert.strictEqual(words.wordFor(words.STATE_WORDS, 'running'), 'Running');
  for (const name of ['constructor', 'toString', '__proto__', 'Running', 7, null]) assert.strictEqual(words.wordFor(words.STATE_WORDS, name), undefined, String(name));
  assert.deepStrictEqual(Object.keys(words.VERIFICATION_FALLBACK), ['verified', 'rejected', 'unverifiable']);
  assert.deepStrictEqual(Object.keys(words.PROBE_FALLBACK), ['readable', 'denied', 'unverifiable']);
  assert.deepStrictEqual(Object.keys(words.DISPOSITION_FALLBACK), ['open', 'credential-rejected', 'accepted-risk', 'removed-from-tree']);
  assert.deepStrictEqual(words.DISPOSITION_TONE['accepted-risk'], ['info', 'shield']);
  assert.ok(Object.values(words.DISPOSITION_TONE).every(Object.isFrozen));
});

check('the proof line never reads a scan in progress, partial or absent as a clean repository', () => {
  assert.strictEqual(words.proofLine(null), 'Start a scan to check this branch for exposed credentials.');
  for (const state of ['queued', 'running']) assert.strictEqual(words.proofLine({ state, coverage: 'complete' }), 'A scan is in progress. Nothing is proven until it finishes.');
  assert.match(words.proofLine({ state: 'complete', coverage: 'complete', scanMode: 'history' }), /^This scan read the whole tree at the commit below and every commit before it,/);
  assert.match(words.proofLine({ state: 'complete', coverage: 'complete' }), /It did not read the history, where a deleted credential can still be\./);
  for (const scan of [{ state: 'complete', coverage: 'partial' }, { state: 'partial', coverage: 'complete' }, { state: 'failed' }, { state: 'canceled', coverage: 'complete' }]) {
    assert.strictEqual(words.proofLine(scan), 'This scan did not read the whole tree, so it cannot tell you the repository is clean.', JSON.stringify(scan));
  }
});

check('what a scan read adds up, says what a ceiling stopped, and counts history and archives', () => {
  assert.strictEqual(words.breakdownLine(null), '');
  assert.strictEqual(words.breakdownLine({ filesTotal: '9' }), '');
  assert.strictEqual(words.breakdownLine({ filesTotal: 1, filesScanned: 1 }), 'Read 1 of 1 file.');
  assert.strictEqual(words.breakdownLine({ state: 'partial', filesTotal: 10, filesScanned: 5, filesSkippedBinary: 1, filesSkippedOther: 2 }),
    'Read 5 of 10 files. 1 binary file (images, fonts, archives) not scanned. 2 others not read (links, submodules, oversized or unreadable). 2 files not reached before a limit.');
  assert.strictEqual(words.breakdownLine({ state: 'running', filesTotal: 10, filesScanned: 4, filesSkippedBinary: 2, filesSkippedOther: 1 }),
    'Read 4 of 10 files. 2 binary files (images, fonts, archives) not scanned. 1 other not read (links, submodules, oversized or unreadable).', 'not yet reached is not a limit');
  assert.strictEqual(words.breakdownLine({ filesTotal: 3, filesScanned: 'x', filesSkippedBinary: 1.5 }), 'Read 0 of 3 files. 3 files not reached before a limit.');
  assert.strictEqual(words.breakdownLine({ filesTotal: 2, filesScanned: 9 }), 'Read 9 of 2 files.', 'never a negative remainder');
  assert.strictEqual(words.breakdownLine({ filesTotal: 1, filesScanned: 1, archivesScanned: 2, archiveMembersScanned: 1 }), 'Read 1 of 1 file. Opened 2 archives and read 1 file inside.');
  assert.strictEqual(words.breakdownLine({ filesTotal: 1, filesScanned: 1, archivesScanned: 1 }), 'Read 1 of 1 file. Opened 1 archive and read 0 files inside.');
  assert.strictEqual(words.breakdownLine({ filesTotal: 1, filesScanned: 1, archivesScanned: 0 }), 'Read 1 of 1 file.');
  assert.strictEqual(words.breakdownLine({ filesTotal: 1, filesScanned: 1, scanMode: 'history', commitsTotal: 5, commitsScanned: 3, historyBaseCommit: 'abcdef123456', commitsSkipped: 2 }),
    'Read 1 of 1 file. Read 3 of 5 commits since the last full history scan (abcdef1). 2 commits could not be read.');
  assert.strictEqual(words.breakdownLine({ filesTotal: 1, filesScanned: 1, scanMode: 'history', commitsTotal: 1, commitsSkipped: 1 }), 'Read 1 of 1 file. Read 0 of 1 commit. 1 commit could not be read.');
  assert.strictEqual(words.breakdownLine({ filesTotal: 1, filesScanned: 1, scanMode: 'tree', commitsTotal: 5 }), 'Read 1 of 1 file.');
});

check('history is read by default, and a refusal or a blocked storage keeps the default', () => {
  const store = value => () => ({ getItem: key => { assert.strictEqual(key, 'nv_exposure_history'); return value; } });
  assert.strictEqual(words.HISTORY_PREFERENCE, 'nv_exposure_history');
  assert.strictEqual(words.historyPreferred(store(null)), true);
  assert.strictEqual(words.historyPreferred(store('1')), true);
  assert.strictEqual(words.historyPreferred(store('0')), false);
  assert.strictEqual(words.historyPreferred(() => { throw new Error('blocked'); }), true);
  assert.strictEqual(words.historyPreferred(() => ({ getItem: () => { throw new Error('denied'); } })), true);
});

check('the history names refs, days and what each scan found', () => {
  assert.strictEqual(words.refLabel('refs/heads/main'), 'main');
  assert.strictEqual(words.refLabel('refs/tags/v1'), 'v1');
  assert.strictEqual(words.refLabel('refs/pull/1/head'), 'refs/pull/1/head');
  for (const empty of ['', null, undefined, 'refs/heads/']) assert.strictEqual(words.refLabel(empty), 'HEAD', String(empty));
  const now = new Date(2026, 10, 22, 9, 30);
  assert.strictEqual(words.dayLabel(new Date(2026, 10, 22, 0, 1), now), 'Today');
  assert.strictEqual(words.dayLabel(new Date(2026, 10, 21, 23, 59), now), 'Yesterday');
  const older = new Date(2026, 8, 22);
  assert.strictEqual(words.dayLabel(older, now), older.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }));
  assert.strictEqual(words.dayLabel(new Date(), undefined), 'Today');
  assert.strictEqual(words.scanCounts({ severityCounts: { critical: 2, serious: 0, warning: '1' } }), '2 critical \u00b7 1 warning');
  assert.strictEqual(words.scanCounts({ state: 'running', severityCounts: { critical: 1 } }), '1 critical');
  for (const state of ['queued', 'running']) assert.strictEqual(words.scanCounts({ state }), 'In progress');
  for (const state of ['failed', 'canceled']) assert.strictEqual(words.scanCounts({ state, coverage: 'complete' }), 'No results');
  assert.strictEqual(words.scanCounts({ state: 'complete', coverage: 'complete', severityCounts: null }), 'Nothing found');
  assert.strictEqual(words.scanCounts({ state: 'partial', coverage: 'partial' }), 'Nothing found in what was read');
});

const finding = (over = {}) => ({ fingerprint: 'f1', rule: 'github-token', path: 'a.js', displayPath: 'a.js', narration: { severity: 'critical' }, ...over });

check('a finding\'s severity is the narration\'s when the screen knows it, and serious otherwise', () => {
  assert.strictEqual(words.severityOf(finding()), 'critical');
  assert.strictEqual(words.severityOf(finding({ narration: { severity: 'warning' } })), 'warning');
  for (const narration of [null, {}, { severity: 'info' }, { severity: 'constructor' }, { severity: 'Critical' }]) {
    assert.strictEqual(words.severityOf(finding({ narration })), 'serious', JSON.stringify(narration));
  }
  assert.strictEqual(words.severityOf(null), 'serious');
  assert.strictEqual(words.dispositionOf({}), 'open');
  assert.strictEqual(words.dispositionOf({ disposition: 'accepted-risk' }), 'accepted-risk');
  assert.deepStrictEqual(words.SEVERITY_RANK, { critical: 0, serious: 1, warning: 2 });
});

check('findings sort by severity, then path, then rule, into a new list', () => {
  const list = [
    finding({ fingerprint: 'w', narration: { severity: 'warning' }, path: 'a' }),
    finding({ fingerprint: 'c2', path: 'b', rule: 'z' }),
    finding({ fingerprint: 's', narration: null, path: 'a' }),
    finding({ fingerprint: 'c1', path: 'b', rule: 'a' }),
    finding({ fingerprint: 'c0', path: 'a', rule: 'z' })
  ];
  const sorted = words.sortFindings(list);
  assert.deepStrictEqual(sorted.map(item => item.fingerprint), ['c0', 'c1', 'c2', 's', 'w']);
  assert.notStrictEqual(sorted, list);
  assert.strictEqual(list[0].fingerprint, 'w', 'the list handed in is not reordered');
  assert.deepStrictEqual(words.sortFindings(null), []);
  assert.deepStrictEqual(words.sortFindings([finding({ path: undefined, rule: undefined, fingerprint: 'x' }), finding({ path: 'a', fingerprint: 'y' })]).map(item => item.fingerprint), ['x', 'y']);
});

check('a rule reads as its owners spell it, initialisms in capitals', () => {
  assert.strictEqual(words.ruleLabel('stripe-live-key'), 'Stripe live key');
  assert.strictEqual(words.ruleLabel('github-token'), 'GitHub token');
  assert.strictEqual(words.ruleLabel('aws-access-key-id'), 'AWS access key ID');
  assert.strictEqual(words.ruleLabel('jwt'), 'JWT');
  assert.strictEqual(words.ruleLabel('openai-api-key'), 'OpenAI API key');
  assert.strictEqual(words.ruleLabel('onepassword--service-token'), '1Password service token');
  assert.strictEqual(words.ruleLabel(''), 'Credential');
  assert.strictEqual(words.ruleLabel(null), 'Credential');
  assert.strictEqual(words.ruleLabel('constructor-key'), 'Constructor key');
  assert.strictEqual(words.ruleLabel('my-tostring-hasownproperty'), 'My tostring hasownproperty');
});

check('a finding\'s first line, and where it sits', () => {
  assert.strictEqual(words.firstLine({ occurrences: [{ line: 4 }, { line: 9 }] }), 4);
  for (const occurrences of [undefined, [], [{}], [{ line: '4' }], [null], 'x']) assert.strictEqual(words.firstLine({ occurrences }), null, JSON.stringify(occurrences));
  assert.deepStrictEqual(words.whereOf({}), { tree: true, history: false, archive: false, encoded: false });
  assert.deepStrictEqual(words.whereOf({ inTree: false, path: 'a.zip!/b.env', decodedFrom: 'base64' }), { tree: false, history: true, archive: true, encoded: true });
  assert.deepStrictEqual(words.whereOf({ inTree: null, decodedFrom: 'hex' }), { tree: true, history: false, archive: false, encoded: false });
});

check('a view keeps the findings of its severity, status and place, and those every typed word finds', () => {
  const view = (over = {}) => ({ severity: null, status: 'all', where: 'all', query: '', ...over });
  const a = finding({ rule: 'stripe-live-key', displayPath: 'billing/keys.js', disposition: 'accepted-risk' });
  const b = finding({ narration: { severity: 'warning' }, inTree: false, path: 'x.zip!/y' });
  assert.ok(words.matches(a, view()));
  assert.ok(words.matches(a, view({ severity: 'critical' })) && !words.matches(b, view({ severity: 'critical' })));
  assert.ok(words.matches(a, view({ status: 'accepted-risk' })) && !words.matches(b, view({ status: 'accepted-risk' })));
  assert.ok(words.matches(b, view({ status: 'open' })));
  assert.ok(words.matches(b, view({ where: 'history' })) && words.matches(b, view({ where: 'archive' })) && !words.matches(a, view({ where: 'history' })));
  assert.ok(words.matches(a, view({ where: 'tree' })) && !words.matches(b, view({ where: 'tree' })));
  for (const where of ['constructor', 'nowhere']) assert.ok(!words.matches(a, view({ where })), where);
  assert.ok(words.matches(a, view({ query: '  STRIPE  billing ' })));
  assert.ok(words.matches(a, view({ query: 'accepted critical' })));
  assert.ok(words.matches(a, view({ query: 'stripe-live-key' })));
  assert.ok(words.matches(finding({ rule: 'onepassword-service-token' }), view({ query: '1password' })), 'the readable name is searched as well as the rule');
  assert.ok(!words.matches(a, view({ query: 'stripe github' })));
  assert.ok(words.matches(b, view({ query: 'warning open' })));
  const current = { paged: false, findings: [a, b], view: view({ severity: 'warning' }) };
  assert.deepStrictEqual(words.filtered(current), [b]);
  const paged = { ...current, paged: true };
  assert.strictEqual(words.filtered(paged), paged.findings, 'a paged list is the server\'s, as it came');
});

check('an answer is fresh only once observed and before its deadline', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const answer = (observedAt, freshnessDeadline) => ({ observedAt, freshnessDeadline });
  assert.strictEqual(words.answerFresh(answer('2026-11-22T11:00:00Z', '2026-11-23T00:00:00Z'), now), true);
  assert.strictEqual(words.answerFresh(answer('2026-11-22T12:00:00Z', '2026-11-22T12:00:01Z'), now), true, 'observed this very moment');
  assert.strictEqual(words.answerFresh(answer('2026-11-22T12:00:01Z', '2026-11-23T00:00:00Z'), now), false, 'observed in the future');
  assert.strictEqual(words.answerFresh(answer('2026-11-22T11:00:00Z', '2026-11-22T12:00:00Z'), now), false, 'at its deadline');
  for (const bad of [null, {}, answer('x', '2026-11-23T00:00:00Z'), answer('2026-11-22T11:00:00Z', null)]) assert.strictEqual(words.answerFresh(bad, now), false);
});

check('export rows carry the displayable path, the decision, and a verification said for what it is', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const fresh = { state: 'verified', observedAt: '2026-11-22T11:00:00Z', freshnessDeadline: '2026-11-23T00:00:00Z' };
  const stale = { state: 'rejected', observedAt: '2026-11-01T00:00:00Z', freshnessDeadline: '2026-11-02T00:00:00Z' };
  const rows = words.exportRows([
    finding({ fingerprint: 'w', narration: { severity: 'warning' }, path: 'raw/secret.env', displayPath: 'shown.env', occurrences: [{ line: 3 }], introducedCommit: 'ABCDEF1' }),
    finding({ fingerprint: 'c', disposition: 'accepted-risk', dispositionBy: 'alice', inTree: false, path: 'x.zip!/y', decodedFrom: 'base64', introducedCommit: 'abcdef1234567890' }),
    finding({ fingerprint: 'toString', rule: undefined, displayPath: undefined })
  ], { w: stale, c: fresh }, now);
  assert.deepStrictEqual(rows, [
    { severity: 'critical', label: 'Credential', rule: 'credential', where: 'a file', line: null, status: 'open', inTree: true, archive: false, encoded: false,
      commit: '', verified: '', fingerprint: 'toString', acceptedBy: '' },
    { severity: 'critical', label: 'GitHub token', rule: 'github-token', where: 'a.js', line: null, status: 'accepted-risk', inTree: false, archive: true, encoded: true,
      commit: 'abcdef123456', verified: 'verified', fingerprint: 'c', acceptedBy: 'alice' },
    { severity: 'warning', label: 'GitHub token', rule: 'github-token', where: 'shown.env', line: 3, status: 'open', inTree: true, archive: false, encoded: false,
      commit: '', verified: 'previously rejected (expired or undated)', fingerprint: 'w', acceptedBy: '' }
  ]);
  assert.ok(!JSON.stringify(rows).includes('raw/secret.env'), 'never the raw path');
  assert.strictEqual(words.exportRows([finding({ disposition: 'open', dispositionBy: 'bob' })], {}, now)[0].acceptedBy, '');
  assert.strictEqual(words.exportRows([finding({ disposition: 'accepted-risk' })], {}, now)[0].acceptedBy, '');
  assert.strictEqual(words.exportRows([finding({ fingerprint: undefined })], {}, now)[0].fingerprint, '');
});

check('the findings\' address carries the view and a cursor, and nothing the view leaves open', () => {
  const view = (over = {}) => ({ severity: null, status: 'all', where: 'all', query: '', ...over });
  assert.strictEqual(words.findingsUrl('octo/repo', view()), '/api/repo/octo/repo/exposure/findings?limit=50');
  assert.strictEqual(words.findingsUrl('octo/repo', view({ severity: 'critical', status: 'open', where: 'history', query: 'a b&c' }), 'next+1', 20),
    '/api/repo/octo/repo/exposure/findings?limit=20&severity=critical&status=open&where=history&q=a+b%26c&cursor=next%2B1');
  assert.strictEqual(words.findingsUrl('o/r', view(), null), '/api/repo/o/r/exposure/findings?limit=50');
});

check('an Orbit chip is built from elements and text: tone, glyph, count and word', () => {
  const made = [];
  const node = (tag, ns) => {
    const el = { tag, ns: ns || null, className: '', textContent: null, dataset: {}, attrs: {}, children: [],
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(child) { this.children.push(child); return child; } };
    made.push(el);
    return el;
  };
  const doc = { createElement: tag => node(tag), createElementNS: (ns, tag) => node(tag, ns), createTextNode: text => ({ text }) };
  const chip = orbitChip(doc, 'critical', 'critical', { glyph: GLYPHS.critical, count: 3, beam: true, className: 'nv-chip-lg' });
  assert.strictEqual(chip.className, 'nv-chip nv-chip-lg');
  assert.deepStrictEqual(chip.dataset, { tone: 'critical', beam: 'on' });
  const [svg, number, space, word] = chip.children;
  assert.strictEqual(svg.ns, 'http://www.w3.org/2000/svg');
  assert.deepStrictEqual(svg.attrs, { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  assert.deepStrictEqual(svg.children[0].attrs, { d: GLYPHS.critical });
  assert.strictEqual(svg.children[0].ns, 'http://www.w3.org/2000/svg');
  assert.deepStrictEqual([number.tag, number.textContent], ['b', '3']);
  assert.deepStrictEqual(space, { text: ' ' });
  assert.deepStrictEqual([word.tag, word.textContent], ['span', 'critical']);
  const plain = orbitChip(doc, 'info', '<b>x</b>');
  assert.strictEqual(plain.className, 'nv-chip');
  assert.deepStrictEqual(plain.dataset, { tone: 'info' });
  assert.deepStrictEqual(plain.children.map(child => [child.tag, child.textContent]), [['span', '<b>x</b>']]);
  const counted = orbitChip(doc, 'pending', '', { count: 0 });
  assert.deepStrictEqual(counted.children.map(child => child.textContent), ['0'], 'a count with no word has no space after it');
  assert.strictEqual(Object.keys(GLYPHS).length, 11);
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
  console.log(`page exposure words: ${checks.length} checks passed`);
})();
