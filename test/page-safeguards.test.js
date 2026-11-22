'use strict';

/*
 * The Safeguards screen, asked directly (features/safeguards/safeguards-view.ts,
 * features/safeguards/safeguards-screen.ts) and the file list it counts with
 * (features/workbench/file-index.ts): what is drawn for the repository open,
 * its controls bound in the same turn as its markup, the provider's rules
 * read and the posture they decide, the files each lock covers, a lock or
 * unlock sent for the repository it was pressed on and redrawn in place, and
 * focus kept with the reader through a redraw. The screen runs against the
 * real safety controller, over a server held in this file.
 */

const assert = require('assert');
const view = require('../apps/web/src/features/safeguards/safeguards-view.ts');
const { createSafeguards } = require('../apps/web/src/features/safeguards/safeguards-screen.ts');
const { createSafety } = require('../apps/web/src/features/safeguards/safety-controller.ts');
const { createFileIndex } = require('../apps/web/src/features/workbench/file-index.ts');
const { createDocument } = require('./helpers/markup-dom');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve)); };
/* An element named briefly: assert is never handed one, since an assertion's message would walk the whole document. */
const named = node => (node && node.localName ? `<${node.localName}${node.id ? '#' + node.id : ''}${node.dataset.preset !== undefined ? ` preset ${node.dataset.preset}` : ''}${node.getAttribute('aria-label') ? ` "${node.getAttribute('aria-label')}"` : ''}>` : String(node));
const same = (actual, expected, message) => assert.ok(actual === expected, `${message || 'not the same element'}: ${named(actual)}, not ${named(expected)}`);
const absent = (node, message) => assert.ok(node === null, `${message || 'present'}: ${named(node)}`);
const held = () => { let release; let fail; const promise = new Promise((resolve, reject) => { release = resolve; fail = reject; }); return { promise, release, fail }; };

const CONTROLS = [
  ['review', 'Pull request review before merging', 'on', '1 approval'], ['checks', 'Status checks must pass', 'off'], ['force-push', 'Force pushes blocked', 'on'],
  ['deletion', 'Deletion blocked', 'on'], ['signed', 'Signed commits required', 'unknown', 'needs administration access'], ['linear', 'Linear history', 'on'],
  ['conversation', 'Review conversations resolved', 'off'], ['admins', 'Rules apply to administrators', 'unknown']
].map(([id, label, state, detail]) => ({ id, label, state, ...(detail ? { detail } : {}) }));
const RULES = Object.freeze({ provider: 'github', branch: 'main', protected: true, access: 'partial', sources: ['branch protection', '1 ruleset'], controls: CONTROLS, enforced: 4, known: 6, settingsUrl: 'https://github.com/octo/demo/settings/branches' });
const FILES = ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.env', 'src/app.js', 'keys/id.pem', 'deep/x/.env.local'];

/* ---- the screen's words and drawing ---- */

check('the presets are fixed, and each counts the files it covers as the server reads a lock', () => {
  assert.ok(Object.isFrozen(view.SAFEGUARD_PRESETS) && view.SAFEGUARD_PRESETS.every(preset => Object.isFrozen(preset) && Object.isFrozen(preset.patterns)));
  assert.deepStrictEqual(view.SAFEGUARD_PRESETS.map(preset => preset.label), ['CI workflows', 'Environment files', 'Keys and certificates', 'Lockfiles', 'Migrations', 'Infrastructure', 'Code owners']);
  assert.deepStrictEqual(view.SAFEGUARD_PRESETS.map(preset => view.matchCount(preset.patterns, FILES)), [2, 2, 1, 0, 0, 0, 0]);
  assert.strictEqual(view.matchCount(['src'], FILES), 1, 'a plain path covers what is beneath it');
  for (const files of [null, undefined, 'keys/id.pem', { length: 2 }]) assert.strictEqual(view.matchCount(['**/*.pem'], files), null, 'no list, no count');
  assert.strictEqual(view.icon('lock', 'x'), `<svg class="x" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${view.SG_ICON.lock}</svg>`);
});

check('the last snapshot is the time this browser kept, and a time that is not one is none', () => {
  assert.strictEqual(view.snapshotTakenAt(JSON.stringify({ capturedAt: '2026-11-22T10:00:00Z', repo: 'demo' })), '2026-11-22T10:00:00Z');
  for (const stored of [null, '', 'not json', 'null', '7', '{}', JSON.stringify({ capturedAt: 7 }), JSON.stringify({ capturedAt: 'soon' }), JSON.stringify({ capturedAt: {} })]) {
    assert.strictEqual(view.snapshotTakenAt(stored), null, String(stored));
  }
});

check('the provider\u2019s answer is read control by control; one without a list of controls is said as unreadable', () => {
  const rules = view.readRules(RULES);
  assert.deepStrictEqual(rules.controls.map(control => control.state), ['on', 'off', 'on', 'on', 'unknown', 'on', 'off', 'unknown']);
  assert.deepStrictEqual([rules.protected, rules.partial, rules.sources, rules.settingsUrl], [true, true, ['branch protection', '1 ruleset'], 'https://github.com/octo/demo/settings/branches']);
  for (const answer of [null, 7, 'x', {}, { controls: 'all' }, { controls: { review: 'on' } }, { protected: true, sources: [] }]) {
    assert.deepStrictEqual(view.readRules(answer), { error: view.RULES_UNREADABLE }, JSON.stringify(answer));
  }
  const odd = view.readRules({ protected: 1, access: 'full', sources: ['a', 7, null], settingsUrl: 'javascript:alert(1)', controls: [null, 'x', { id: 'review', label: 9, state: 'ON', detail: {} }, { id: 'deletion', label: 'Deletion blocked', state: 'off' }] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(odd)), {
    protected: true, partial: false, sources: ['a'], settingsUrl: '',
    controls: [{ id: 'review', label: '', state: 'unknown', detail: '' }, { id: 'deletion', label: 'Deletion blocked', state: 'off', detail: '' }]
  }, 'only what was written as the server writes it; a state it does not name is unknown, never on');
  assert.strictEqual(view.readRules({ controls: [], settingsUrl: 'http://github.com/x' }).settingsUrl, '', 'a link only to a secure page');
});

check('the posture follows the branch\u2019s rules, then the locks and a snapshot', () => {
  const rules = view.readRules(RULES);
  assert.deepStrictEqual(view.posture(null, 3, 'x'), { tone: 'part', word: 'Branch rules unread' });
  assert.deepStrictEqual(view.posture({ error: 'down' }, 3, 'x'), { tone: 'part', word: 'Branch rules unread' });
  assert.deepStrictEqual(view.posture(view.readRules({ ...RULES, protected: false }), 3, 'x'), { tone: 'open', word: 'Unprotected branch' });
  assert.deepStrictEqual(view.posture(rules, 3, '2026-11-22T10:00:00Z'), { tone: 'good', word: 'Guarded' });
  assert.deepStrictEqual(view.posture(rules, 0, '2026-11-22T10:00:00Z'), { tone: 'part', word: 'Mostly guarded' });
  assert.deepStrictEqual(view.posture(rules, 3, null), { tone: 'part', word: 'Mostly guarded' });
  const noDeletion = view.readRules({ ...RULES, controls: CONTROLS.map(control => (control.id === 'deletion' ? { ...control, state: 'unknown' } : control)) });
  assert.deepStrictEqual(view.posture(noDeletion, 3, 'x'), { tone: 'part', word: 'Partly guarded' }, 'an unknown rule is not counted on');
  const twice = view.readRules({ ...RULES, controls: [{ id: 'review', state: 'off' }, ...CONTROLS] });
  assert.deepStrictEqual(view.posture(twice, 3, 'x'), { tone: 'part', word: 'Partly guarded' }, 'a control read by its first reading');
  assert.deepStrictEqual([view.rulesFigure(rules), view.rulesFigure(null), view.rulesFigure({ error: 'x' }), view.rulesFigure(view.readRules({ controls: [] }))], ['4 of 8', '\u2014', '\u2014', '0 of 0']);
});

check('the rules are drawn as text, a link escaped as an attribute, and a note where some could not be read', () => {
  assert.strictEqual(view.rulesHTML(null), '<p class="sg-muted sg-loading">Reading the provider\u2019s rules\u2026</p>');
  assert.strictEqual(view.rulesHTML({ error: '<b>down</b>' }), '<p class="sg-muted">&lt;b&gt;down&lt;/b&gt;</p>');
  const doc = createDocument();
  const host = doc.createElement('div');
  host.innerHTML = view.rulesHTML(view.readRules(RULES));
  const rows = host.querySelectorAll('.sg-rule');
  assert.deepStrictEqual(rows.map(row => row.dataset.state), ['on', 'off', 'on', 'on', 'unknown', 'on', 'off', 'unknown']);
  assert.deepStrictEqual(rows.map(row => row.querySelector('.sg-rule-detail')?.textContent ?? null), ['1 approval', null, null, null, null, null, null, null], 'a detail about access is not shown as the rule\u2019s');
  assert.ok(host.querySelector('.sg-note'));
  assert.strictEqual(host.querySelector('.sg-card-foot').querySelector('.sg-muted').textContent, 'branch protection \u00b7 1 ruleset');
  host.innerHTML = view.rulesHTML(view.readRules({ ...RULES, controls: [{ id: 'review', label: '<img src=x onerror=steal()>', state: 'on', detail: '<b>2</b>' }] }));
  assert.deepStrictEqual([host.querySelector('.sg-rule-name').textContent, host.querySelector('.sg-rule-detail').textContent, host.querySelectorAll('img').length, host.querySelectorAll('b').length],
    ['<img src=x onerror=steal()>', '<b>2</b>', 0, 0], 'a rule\u2019s label and detail are text');
  host.innerHTML = view.rulesHTML(view.readRules({ ...RULES, access: 'full', sources: [], settingsUrl: 'https://github.com/o/"x" onclick="steal()' }));
  const link = host.querySelector('a');
  assert.strictEqual(link.getAttribute('href'), 'https://github.com/o/"x" onclick="steal()');
  assert.deepStrictEqual([...link.attributes.keys()], ['class', 'href', 'target', 'rel'], 'the link carries its own attributes only');
  absent(host.querySelector('.sg-note'));
  assert.strictEqual(host.querySelector('.sg-card-foot').querySelector('.sg-muted').textContent, 'Protected');
  host.innerHTML = view.rulesHTML(view.readRules({ ...RULES, protected: false, sources: [], settingsUrl: null }));
  assert.strictEqual(host.querySelector('.sg-card-foot').textContent, 'No rule covers this branch');
  absent(host.querySelector('a'));
});

check('the screen names its repository and branch as text, and a lock as an attribute', () => {
  const doc = createDocument();
  const host = doc.createElement('div');
  const locks = ['a"b', '<x>', '**/*.pem'];
  host.innerHTML = view.screenHTML({ key: 'octo/<demo>', branch: 'feat/"q"', readOnly: true, freeze: false, global: true, locks, snapshotAt: '2026-11-22T10:00:00Z', ago: iso => `ago ${iso}` });
  assert.strictEqual(host.querySelector('.sg-posture-sub').textContent, 'octo/<demo> \u00b7 feat/"q"');
  const unlocks = host.querySelectorAll('[data-unlock]');
  assert.deepStrictEqual(unlocks.map(button => button.getAttribute('aria-label')), ['Unlock a"b', 'Unlock <x>', 'Unlock **/*.pem']);
  assert.ok(unlocks.every(button => [...button.attributes.keys()].join() === 'type,class,data-unlock,aria-label'), 'an Unlock carries its own attributes only');
  assert.deepStrictEqual(host.querySelectorAll('.sg-lock-pattern').map(node => node.textContent), locks);
  assert.strictEqual(host.querySelector('.sg-count').textContent, '3');
  assert.deepStrictEqual([host.querySelector('#sgReadOnly').checked, host.querySelector('#sgFreeze').checked, host.querySelector('#sgReadOnly').disabled], [true, false, false]);
  assert.strictEqual(host.querySelector('#sgSnap').querySelector('.sg-tile-sub').textContent, 'Last ago 2026-11-22T10:00:00Z');
  assert.strictEqual(host.querySelector('.sg-stats').textContent.includes('ago 2026-11-22T10:00:00Z'), true);
  const pem = host.querySelector('[data-preset="2"]');
  assert.deepStrictEqual([pem.disabled, pem.getAttribute('aria-pressed'), pem.getAttribute('title')], [false, 'false', '**/*.pem  **/*.key'], 'a preset half locked is offered');
  host.innerHTML = view.screenHTML({ key: 'k', branch: 'b', readOnly: false, freeze: true, global: false, locks: ['**/*.pem', '**/*.key'], snapshotAt: null, ago: () => 'never' });
  assert.deepStrictEqual([host.querySelector('[data-preset="2"]').disabled, host.querySelector('[data-preset="2"]').getAttribute('aria-pressed')], [true, 'true']);
  assert.deepStrictEqual([host.querySelector('#sgReadOnly').disabled, host.querySelector('#sgFreeze').disabled, host.querySelector('#sgFreeze').checked], [true, true, true], 'the deployment\u2019s switches are shown, not offered');
  assert.ok(host.querySelector('.sg-note').textContent.startsWith('Set by the deployment'));
  assert.strictEqual(host.querySelector('#sgSnap').querySelector('.sg-tile-sub').textContent, 'None taken yet');
  host.innerHTML = view.screenHTML({ key: 'k', branch: 'b', readOnly: false, freeze: false, global: true, locks: [], snapshotAt: null, ago: () => '' });
  assert.ok(host.querySelector('.sg-empty'));
  assert.deepStrictEqual(host.querySelectorAll('.sg-tile').map(tile => [tile.id, tile.dataset.feature]),
    [['sgSnap', 'recovery'], ['sgRecover', 'recovery'], ['sgScan', 'dependency-audit'], ['sgActivity', 'governance'], ['sgEvidence', 'governance']]);
});

/* ---- the file list ---- */

function index({ answer = { files: FILES }, fail = null } = {}) {
  const page = { work: { owner: 'octo', repo: 'demo', branch: 'main' }, fileIndex: null };
  const log = [];
  let gate = null;
  const files = createFileIndex({
    api: async path => { log.push(path); if (gate) await gate.promise; if (fail) throw fail; return typeof answer === 'function' ? answer() : answer; },
    work: () => page.work,
    held: () => page.fileIndex,
    hold: list => { page.fileIndex = list; }
  });
  return { files, page, log, hold: () => { gate = held(); return gate; } };
}

check('the file list is read once for its branch, shared by two readers, and holds only the paths written', async () => {
  const one = index({ answer: { files: ['a.txt', 7, null, 'b/c.md'] } });
  const gate = one.hold();
  const first = one.files.load();
  const second = one.files.load();
  gate.release();
  assert.deepStrictEqual([await first, await second], [['a.txt', 'b/c.md'], ['a.txt', 'b/c.md']]);
  assert.deepStrictEqual(one.log, ['/api/repo/octo/demo/files?ref=main'], 'one request for two readers');
  assert.ok(Object.isFrozen(one.page.fileIndex));
  assert.strictEqual(await one.files.load(), one.page.fileIndex, 'held, not read again');
  assert.strictEqual(one.log.length, 1);
  const none = index();
  none.page.work = null;
  assert.strictEqual(await none.files.load(), null);
  assert.deepStrictEqual(none.log, []);
  const branch = index();
  branch.page.work.branch = 'feat/a b';
  await branch.files.load();
  assert.deepStrictEqual(branch.log, ['/api/repo/octo/demo/files?ref=feat%2Fa%20b']);
});

check('a failure holds nothing, so the next reader asks again; an answer that is not a list is a failure', async () => {
  const down = index({ fail: new Error('down') });
  assert.strictEqual(await down.files.load(), null);
  assert.strictEqual(down.page.fileIndex, null, 'never held as an empty repository');
  assert.strictEqual(await down.files.load(), null);
  assert.strictEqual(down.log.length, 2, 'asked again');
  for (const answer of [null, {}, { files: 'a.txt' }, { files: { a: 1 } }]) {
    const odd = index({ answer });
    assert.strictEqual(await odd.files.load(), null, JSON.stringify(answer));
    assert.strictEqual(odd.page.fileIndex, null);
  }
});

check('a list that answers after another repository or branch was opened is dropped, not held for it', async () => {
  const moved = index();
  const gate = moved.hold();
  const asked = moved.files.load();
  moved.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  gate.release();
  assert.strictEqual(await asked, null);
  assert.strictEqual(moved.page.fileIndex, null);
  const branched = index();
  const gate2 = branched.hold();
  const asked2 = branched.files.load();
  branched.page.work.branch = 'dev';
  const again = branched.files.load();
  gate2.release();
  assert.strictEqual(await asked2, null, 'the branch changed in place');
  assert.deepStrictEqual(await again, FILES, 'the reading for the branch open now is its own');
  assert.deepStrictEqual(branched.log, ['/api/repo/octo/demo/files?ref=main', '/api/repo/octo/demo/files?ref=dev']);
  assert.deepStrictEqual(branched.page.fileIndex, FILES);
});

/* ---- the screen at work ---- */

function setup(options = {}) {
  const doc = createDocument();
  const root = doc.createElement('section');
  doc.body.appendChild(root);
  const page = {
    work: { owner: 'octo', repo: 'demo', branch: 'main' },
    safety: null,
    fileIndex: null,
    stored: options.stored || {}
  };
  const server = { readOnly: false, freezeSync: false, ...(options.global === undefined ? {} : { globalControls: options.global }), protected: { 'octo/demo': ['**/*.pem'], 'octo/other': ['**/*.key'], ...(options.locks || {}) } };
  const log = [];
  const gates = {};
  let clock = 1000000;
  const copy = () => JSON.parse(JSON.stringify(server));
  const api = async (path, request) => {
    log.push(['api', path, request ? request.body : null]);
    const name = path.startsWith('/api/safety') ? (request ? 'set' : 'safety') : path.includes('/branch-protection') ? 'rules' : path.includes('/files') ? 'files' : 'other';
    const gate = gates[name] && gates[name].shift();
    /* The provider's readings are what it said when asked, whenever they arrive. */
    let early = null;
    if (name === 'rules' || name === 'files') {
      try { early = { value: name === 'rules' ? rulesAnswer() : filesAnswer() }; } catch (error) { early = { error }; }
    }
    if (gate) await gate.promise;
    if (early) { if (early.error) throw early.error; return early.value; }
    if (name === 'safety') return copy();
    if (name === 'set') {
      const patch = request.body;
      if (options.refuse && options.refuse(patch)) throw new Error('Refused');
      if (patch.protect) {
        const list = server.protected[patch.protect.repo] || (server.protected[patch.protect.repo] = []);
        if (patch.protect.on && !list.includes(patch.protect.path)) list.push(patch.protect.path);
        if (!patch.protect.on) server.protected[patch.protect.repo] = list.filter(path => path !== patch.protect.path);
      } else Object.assign(server, patch);
      return copy();
    }
    throw new Error(`unexpected ${path}`);
  };
  const rulesAnswer = () => { const rules = typeof options.rules === 'function' ? options.rules() : options.rules === undefined ? RULES : options.rules; if (rules instanceof Error) throw rules; return rules; };
  const filesAnswer = () => { if (options.files === null) throw new Error('down'); return { files: options.files || FILES }; };
  const safety = createSafety({
    api, safety: () => page.safety, setSafety: value => { page.safety = value; }, work: () => page.work,
    toast: (message, kind) => log.push(['toast', String(message), kind]),
    body: () => ({ classList: { toggle() {} } }), $: () => null, fileChanged: () => false, openSafeguards: () => log.push(['safeguards'])
  });
  const files = createFileIndex({ api, work: () => page.work, held: () => page.fileIndex, hold: list => { page.fileIndex = list; } });
  const screen = createSafeguards({
    root: () => (options.noRoot ? null : root),
    work: () => page.work,
    record: () => page.safety,
    safety,
    files: options.filesFn || (() => files.load()),
    api,
    toast: (message, kind) => log.push(['toast', message, kind]),
    ago: iso => `ago ${iso}`,
    stored: name => (Object.hasOwn(page.stored, name) ? page.stored[name] : null),
    capabilities: node => log.push(['capabilities', node === root]),
    flows: Object.fromEntries(['snapshot', 'recover', 'scan', 'activity', 'evidence'].map(flow => [flow, () => log.push(['flow', flow])])),
    activeElement: () => doc.activeElement,
    focusFree: () => !doc.activeElement || doc.activeElement === doc.body,
    escapeSelector: value => value.replace(/[^\w-]/g, ch => `\\${ch}`),
    now: () => clock
  });
  const requests = kind => log.filter(entry => entry[0] === 'api' && entry[1].includes(kind));
  const toasts = () => log.filter(entry => entry[0] === 'toast').map(entry => entry.slice(1));
  return { doc, root, page, server, log, gates, screen, requests, toasts, tick: ms => { clock += ms; }, gate: name => { const gate = held(); (gates[name] = gates[name] || []).push(gate); return gate; }, $: selector => root.querySelector(selector) };
}

check('every control is bound in the same turn as the markup that draws it', async () => {
  const s = setup();
  const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(s.root), 'innerHTML');
  const seen = [];
  Object.defineProperty(s.root, 'innerHTML', {
    get() { return proto.get.call(this); },
    set(html) {
      proto.set.call(this, html);
      if (!String(html).includes('sg-page')) return;
      const capabilities = s.log.filter(entry => entry[0] === 'capabilities').length;
      queueMicrotask(() => {
        const root = s.root;
        const unbound = [
          ...['#sgReadOnly', '#sgFreeze'].map(id => [id, 'change']),
          ...['#sgSnap', '#sgRecover', '#sgScan', '#sgActivity', '#sgEvidence', '#sgAddProtect', '#sgRulesRefresh'].map(id => [id, 'click']),
          ['#sgProtectPattern', 'keydown']
        ].filter(([id, type]) => !root.querySelector(id).listening(type)).map(([id]) => id);
        for (const node of [...root.querySelectorAll('[data-preset]'), ...root.querySelectorAll('[data-unlock]')]) if (!node.listening('click')) unbound.push(node.getAttribute('aria-label') || node.dataset.preset);
        seen.push({ unbound, capabilities: s.log.filter(entry => entry[0] === 'capabilities').length - capabilities });
      });
    }
  });
  await s.screen.render();
  await settle();
  assert.deepStrictEqual(seen, [{ unbound: [], capabilities: 1 }], 'bound and gated before anything else could run');
  assert.deepStrictEqual(s.log.filter(entry => entry[0] === 'capabilities'), [['capabilities', true]]);
});

check('the screen is drawn for the repository open: its rules, posture, figures and file counts', async () => {
  const s = setup({ stored: { 'nv_snap_octo/demo': JSON.stringify({ capturedAt: '2026-11-22T10:00:00Z' }) } });
  await s.screen.render();
  await settle();
  assert.deepStrictEqual(s.requests('/api/').map(entry => entry[1]), ['/api/safety', '/api/repo/octo/demo/files?ref=main', '/api/repo/octo/demo/branch-protection?branch=main']);
  assert.strictEqual(s.$('.sg-posture-sub').textContent, 'octo/demo \u00b7 main');
  assert.strictEqual(s.$('#sgStatRules').textContent, '4 of 8');
  assert.deepStrictEqual([s.$('#sgPostureWord').textContent, s.$('.sg-posture').dataset.tone], ['Guarded', 'good']);
  assert.strictEqual(s.root.querySelectorAll('.sg-rule').length, 8);
  assert.strictEqual(s.$('#sgFilesNote').textContent, '6 files on main');
  assert.deepStrictEqual(s.root.querySelectorAll('.sg-preset-n').map(node => node.textContent), ['2', '2', '1', '0', '0', '0', '0']);
  assert.deepStrictEqual(s.root.querySelectorAll('.sg-lock-n').map(node => [node.textContent, node.dataset.zero]), [['1 file', 'false']]);
  assert.strictEqual(s.$('#sgSnap').querySelector('.sg-tile-sub').textContent, 'Last ago 2026-11-22T10:00:00Z');
  const none = setup({ locks: { 'octo/demo': ['**/*.pem', 'nowhere/**', 'src'] }, stored: { 'nv_snap_octo/demo': '{"capturedAt":"later"}' } });
  await none.screen.render();
  await settle();
  assert.deepStrictEqual(none.root.querySelectorAll('.sg-lock-n').map(node => [node.textContent, node.dataset.zero]), [['1 file', 'false'], ['0 files', 'true'], ['1 file', 'false']]);
  assert.deepStrictEqual([none.$('#sgPostureWord').textContent, none.$('#sgSnap').querySelector('.sg-tile-sub').textContent], ['Mostly guarded', 'None taken yet']);
  const bare = setup({ noRoot: true });
  await bare.screen.render();
  const away = setup();
  away.page.work = null;
  await away.screen.render();
  assert.deepStrictEqual([bare.log, away.log], [[], []], 'nothing drawn without a section or a repository');
});

check('rules without a list of controls are said as unreadable, and the posture is not left reading', async () => {
  const s = setup({ rules: { protected: true, sources: [] } });
  await s.screen.render();
  await settle();
  assert.strictEqual(s.$('#sgRules').textContent, view.RULES_UNREADABLE);
  assert.deepStrictEqual([s.$('#sgStatRules').textContent, s.$('#sgPostureWord').textContent], ['\u2014', 'Branch rules unread']);
  const down = setup({ rules: new Error('Branch rules are not available for this provider') });
  await down.screen.render();
  await settle();
  assert.strictEqual(down.$('#sgRules').textContent, 'Branch rules are not available for this provider');
  const silent = setup({ rules: Object.assign(new Error(''), { status: 502 }) });
  await silent.screen.render();
  await settle();
  assert.strictEqual(silent.$('#sgRules').textContent, view.RULES_SILENT);
});

check('the rules are read once a minute for a branch; Read again and a refresh read them now; only the latest reading is drawn', async () => {
  const s = setup();
  await s.screen.render();
  await settle();
  await s.screen.render();
  await settle();
  assert.strictEqual(s.requests('branch-protection').length, 1, 'read from the last minute');
  s.tick(60000);
  await s.screen.render();
  await settle();
  assert.strictEqual(s.requests('branch-protection').length, 2, 'a minute on, read again');
  await s.screen.render({ fresh: true });
  await settle();
  assert.strictEqual(s.requests('branch-protection').length, 3, 'a refresh reads them now');
  s.page.work.branch = 'dev';
  s.page.fileIndex = null;
  await s.screen.render();
  await settle();
  assert.deepStrictEqual(s.requests('branch-protection').at(-1)[1], '/api/repo/octo/demo/branch-protection?branch=dev', 'each branch its own');
  const first = s.gate('rules');
  const second = s.gate('rules');
  await s.$('#sgRulesRefresh').click();
  assert.strictEqual(s.$('#sgRules').textContent, 'Reading the provider\u2019s rules\u2026');
  await s.$('#sgRulesRefresh').click();
  second.release();
  await settle();
  assert.strictEqual(s.$('#sgStatRules').textContent, '4 of 8');
  s.server.protected = {};
  first.release();
  await settle();
  assert.strictEqual(s.$('#sgStatRules').textContent, '4 of 8');
  assert.strictEqual(s.root.querySelectorAll('.sg-rule').length, 8, 'the earlier reading, answering last, is not drawn');
});

check('a drawing that answers after the screen was drawn again, another repository opened or the branch changed is dropped', async () => {
  for (const change of ['again', 'repository', 'branch', 'reset']) {
    const s = setup();
    await s.screen.render();
    await settle();
    const before = s.root.innerHTML;
    const gate = s.gate('safety');
    const late = s.screen.render();
    if (change === 'again') { s.gate('safety'); void s.screen.render(); }
    if (change === 'repository') s.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
    if (change === 'branch') s.page.work.branch = 'dev';
    if (change === 'reset') s.screen.reset();
    gate.release();
    await late;
    await settle();
    assert.strictEqual(s.root.innerHTML, change === 'reset' ? '' : before, change);
  }
});

check('the file counts belong to the drawing that asked; a list that could not be read is not counted as none', async () => {
  const s = setup({ files: null });
  await s.screen.render();
  await settle();
  assert.deepStrictEqual([s.$('#sgFilesNote').textContent, s.root.querySelectorAll('.sg-preset-n').map(node => node.textContent).join('')], ['', '']);
  assert.strictEqual(s.page.fileIndex, null);
  const moved = setup();
  const gate = moved.gate('files');
  await moved.screen.render();
  moved.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  gate.release();
  await settle();
  assert.deepStrictEqual([moved.$('#sgFilesNote').textContent, moved.page.fileIndex], ['', null], 'never another repository\u2019s list');
  const single = setup({ files: ['README.md'] });
  await single.screen.render();
  await settle();
  assert.strictEqual(single.$('#sgFilesNote').textContent, '1 file on main', 'one file, said as one');
});

check('a preset locks each of its patterns not yet locked, for this repository, and focus moves to the next preset', async () => {
  const s = setup();
  await s.screen.render();
  await settle();
  const keys = s.$('[data-preset="2"]');
  keys.focus();
  await keys.click();
  await settle();
  assert.deepStrictEqual(s.requests('/api/safety').filter(entry => entry[2]).map(entry => entry[2]), [{ protect: { repo: 'octo/demo', path: '**/*.key', on: true } }], 'the pattern already locked is not sent again');
  assert.deepStrictEqual(s.toasts().at(-1), ['Keys and certificates locked', 'ok']);
  assert.deepStrictEqual(s.root.querySelectorAll('.sg-lock-pattern').map(node => node.textContent), ['**/*.pem', '**/*.key']);
  assert.strictEqual(s.$('[data-preset="2"]').disabled, true);
  same(s.doc.activeElement, s.$('[data-preset="3"]'), 'the next preset, not the page');
  const last = s.$('[data-preset="6"]');
  last.focus();
  await last.click();
  await settle();
  same(s.doc.activeElement, s.$('[data-preset="5"]'), 'after the last, the one before');
  for (const index of [0, 1, 3, 4, 5]) { await s.$(`[data-preset="${index}"]`).click(); await settle(); }
  assert.ok(s.root.querySelectorAll('[data-preset]').every(node => node.disabled));
  s.doc.activeElement = s.doc.body;
  const free = setup({ locks: { 'octo/demo': view.SAFEGUARD_PRESETS.slice(1).flatMap(preset => preset.patterns) } });
  await free.screen.render();
  await settle();
  free.$('[data-preset="0"]').focus();
  await free.$('[data-preset="0"]').click();
  await settle();
  same(free.doc.activeElement, free.$('#sgProtectPattern'), 'with every preset locked, the field to lock another');
});

check('a refusal stops at the first pattern refused, gives the preset back and its focus with it', async () => {
  const s = setup({ refuse: patch => patch.protect && patch.protect.path === '**/pnpm-lock.yaml' });
  await s.screen.render();
  await settle();
  const before = s.root.innerHTML;
  const locks = s.$('[data-preset="3"]');
  locks.focus();
  await locks.click();
  await settle();
  assert.deepStrictEqual(s.requests('/api/safety').filter(entry => entry[2]).map(entry => entry[2].protect.path), ['**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml']);
  assert.deepStrictEqual(s.toasts(), [['Refused', 'err']], 'the refusal said, no success');
  assert.strictEqual(s.$('[data-preset="3"]').disabled, false);
  same(s.doc.activeElement, s.$('[data-preset="3"]'), 'focus given back');
  assert.strictEqual(s.root.innerHTML.replace(/ disabled=""/g, ''), before.replace(/ disabled=""/g, ''), 'not drawn again');
  const elsewhere = setup({ refuse: () => true });
  await elsewhere.screen.render();
  await settle();
  const other = elsewhere.$('#sgProtectPattern');
  const pressed = elsewhere.$('[data-preset="0"]');
  const gate = elsewhere.gate('set');
  pressed.focus();
  const click = pressed.click();
  other.focus();
  gate.release();
  await click;
  await settle();
  same(elsewhere.doc.activeElement, other, 'focus the reader moved elsewhere stays there');
});

check('Unlock lifts that lock alone, and focus moves to the Unlock that takes its place', async () => {
  const s = setup({ locks: { 'octo/demo': ['a', 'b', 'c'] } });
  await s.screen.render();
  await settle();
  const b = s.root.querySelectorAll('[data-unlock]')[1];
  b.focus();
  await b.click();
  await settle();
  assert.deepStrictEqual(s.requests('/api/safety').filter(entry => entry[2]).map(entry => entry[2]), [{ protect: { repo: 'octo/demo', path: 'b', on: false } }]);
  assert.deepStrictEqual(s.toasts().at(-1), ['b unlocked', 'ok']);
  assert.deepStrictEqual(s.root.querySelectorAll('.sg-lock-pattern').map(node => node.textContent), ['a', 'c']);
  assert.strictEqual(s.doc.activeElement.getAttribute('aria-label'), 'Unlock c');
  await s.doc.activeElement.click();
  await settle();
  assert.strictEqual(s.doc.activeElement.getAttribute('aria-label'), 'Unlock a', 'the last row gone, the one before it');
  await s.doc.activeElement.click();
  await settle();
  same(s.doc.activeElement, s.$('#sgProtectPattern'), 'none left, the field to lock one');
  const refused = setup({ locks: { 'octo/demo': ['a'] }, refuse: () => true });
  await refused.screen.render();
  await settle();
  const a = refused.$('[data-unlock="0"]');
  a.focus();
  await a.click();
  await settle();
  assert.deepStrictEqual([a.disabled, refused.doc.activeElement === a, refused.toasts()], [false, true, [['Refused', 'err']]]);
});

check('a typed pattern is locked without its leading slashes; an empty one is asked for; Enter locks it', async () => {
  const s = setup();
  await s.screen.render();
  await settle();
  s.$('#sgProtectPattern').value = '  ';
  await s.$('#sgAddProtect').click();
  assert.deepStrictEqual(s.toasts(), [['Enter a file, folder or wildcard pattern', 'err']]);
  s.$('#sgProtectPattern').value = ' //config/** ';
  s.$('#sgProtectPattern').focus();
  const [handled] = await s.$('#sgProtectPattern').dispatch('keydown', { key: 'Enter' });
  await settle();
  assert.strictEqual(handled, undefined);
  assert.deepStrictEqual(s.requests('/api/safety').filter(entry => entry[2]).map(entry => entry[2]), [{ protect: { repo: 'octo/demo', path: 'config/**', on: true } }]);
  assert.deepStrictEqual(s.toasts().at(-1), ['config/** locked', 'ok']);
  same(s.doc.activeElement, s.$('#sgProtectPattern'), 'the field keeps focus through the redraw');
  const keyed = [];
  s.$('#sgAddProtect').addEventListener('click', () => keyed.push('click'));
  const event = { key: 'a', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  await s.$('#sgProtectPattern').dispatch('keydown', event);
  assert.deepStrictEqual(keyed, [], 'another key types');
  const enter = [];
  await s.$('#sgProtectPattern').dispatch('keydown', { key: 'Enter', preventDefault() { enter.push('prevented'); } });
  assert.deepStrictEqual([enter, keyed], [['prevented'], ['click']]);
  await settle();
  assert.strictEqual(s.requests('/api/safety').filter(entry => entry[2]).length, 1, 'a pattern already locked is not sent again');
});

check('a lock pressed before another repository was opened is sent for its own, and neither said nor drawn on the new one', async () => {
  const s = setup({ locks: { 'octo/demo': ['**/*.pem'], 'octo/other': ['.github/workflows/**', '**/*.key'] } });
  await s.screen.render();
  await settle();
  const gate = s.gate('set');
  const click = s.$('[data-preset="2"]').click();
  s.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  s.screen.reset();
  gate.release();
  await click;
  await settle();
  assert.deepStrictEqual(s.requests('/api/safety').filter(entry => entry[2]).map(entry => entry[2]), [{ protect: { repo: 'octo/demo', path: '**/*.key', on: true } }],
    'checked against its own repository\u2019s locks, not the one open now');
  assert.deepStrictEqual(s.toasts(), []);
  assert.strictEqual(s.root.innerHTML, '', 'nothing drawn for the repository left');
  const ci = setup({ locks: { 'octo/demo': [], 'octo/other': ['.github/workflows/**'] } });
  await ci.screen.render();
  await settle();
  const gate2 = ci.gate('safety');
  const click2 = ci.$('[data-preset="0"]').click();
  await settle(2);
  ci.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  gate2.release();
  await click2;
  await settle();
  assert.deepStrictEqual(ci.requests('/api/safety').filter(entry => entry[2]).map(entry => entry[2].protect.repo), ['octo/demo']);
});

check('the switches are sent and kept, and a refused one is put back', async () => {
  const s = setup({ refuse: patch => patch.freezeSync === true });
  await s.screen.render();
  await settle();
  const readOnly = s.$('#sgReadOnly');
  readOnly.checked = true;
  await readOnly.dispatch('change');
  assert.deepStrictEqual([readOnly.checked, s.server.readOnly], [true, true]);
  const freeze = s.$('#sgFreeze');
  freeze.checked = true;
  await freeze.dispatch('change');
  assert.deepStrictEqual([freeze.checked, s.server.freezeSync, s.toasts()], [false, false, [['Refused', 'err']]]);
  const hosted = setup({ global: false });
  await hosted.screen.render();
  await settle();
  assert.deepStrictEqual([hosted.$('#sgReadOnly').disabled, hosted.$('#sgFreeze').disabled], [true, true]);
  const unsaid = setup({ global: true });
  delete unsaid.server.globalControls;
  await unsaid.screen.render();
  await settle();
  assert.deepStrictEqual([unsaid.$('#sgReadOnly').disabled, unsaid.$('#sgFreeze').disabled, unsaid.root.querySelectorAll('.sg-note').some(note => note.textContent.startsWith('Set by the deployment'))], [false, false, false], 'a record that does not say is the reader\u2019s to change');
});

check('each recovery tile opens its flow', async () => {
  const s = setup();
  await s.screen.render();
  await settle();
  for (const id of ['sgSnap', 'sgRecover', 'sgScan', 'sgActivity', 'sgEvidence']) await s.$('#' + id).click();
  assert.deepStrictEqual(s.log.filter(entry => entry[0] === 'flow').map(entry => entry[1]), ['snapshot', 'recover', 'scan', 'activity', 'evidence']);
});

check('focus on a control as the screen is drawn again is kept there', async () => {
  const s = setup();
  await s.screen.render();
  await settle();
  s.$('#sgRulesRefresh').focus();
  await s.screen.render();
  await settle();
  same(s.doc.activeElement, s.$('#sgRulesRefresh'));
  s.doc.activeElement = s.doc.body;
  await s.screen.render();
  await settle();
  same(s.doc.activeElement, s.doc.body, 'focus elsewhere is not taken');
  const hosted = setup({ global: false });
  await hosted.screen.render();
  await settle();
  hosted.doc.activeElement = hosted.$('#sgReadOnly');
  await hosted.screen.render();
  await settle();
  same(hosted.doc.activeElement, hosted.$('#sgProtectPattern'), 'a control no longer usable hands focus to the field');
});

check('reset empties the screen and forgets the rules read for the repository left', async () => {
  const s = setup();
  await s.screen.render();
  await settle();
  s.screen.reset();
  assert.strictEqual(s.root.innerHTML, '');
  await s.screen.render();
  await settle();
  assert.strictEqual(s.requests('branch-protection').length, 2);
  assert.ok(s.root.innerHTML.includes('sg-page'));
});

check('focus is placed only by a press on this repository\u2019s screen, or kept where it is', async () => {
  /* A press refused is done with: a later drawing leaves focus where the reader put it. */
  const refused = setup({ refuse: () => true });
  await refused.screen.render();
  await settle();
  const gate = refused.gate('set');
  const preset = refused.$('[data-preset="1"]');
  preset.focus();
  const click = preset.click();
  assert.strictEqual(preset.disabled, true, 'disabled while the server answers');
  gate.release();
  await click;
  await settle();
  same(refused.doc.activeElement, preset);
  refused.doc.activeElement = refused.doc.body;
  await refused.screen.render();
  await settle();
  same(refused.doc.activeElement, refused.doc.body, 'the refused press does not place focus again');
  /* A press on one repository does not place focus on another's screen. */
  const moved = setup();
  await moved.screen.render();
  await settle();
  const gate2 = moved.gate('set');
  moved.$('[data-preset="0"]').focus();
  const click2 = moved.$('[data-preset="0"]').click();
  moved.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  await moved.screen.render();
  await settle();
  same(moved.doc.activeElement, moved.doc.body, 'not on the other repository\u2019s presets');
  gate2.release();
  await click2;
  await settle();
  /* Focus outside the screen stays there through a drawing. */
  const outside = setup();
  const elsewhere = outside.doc.createElement('button');
  elsewhere.setAttribute('id', 'sgReadOnly');
  outside.doc.body.appendChild(elsewhere);
  await outside.screen.render();
  await settle();
  elsewhere.focus();
  await outside.screen.render();
  await settle();
  same(outside.doc.activeElement, elsewhere, 'a control outside the screen keeps focus, whatever its name');
  /* An Unlock that has focus as the screen is drawn again keeps it. */
  const unlocks = setup({ locks: { 'octo/demo': ['a', 'b', 'c'] } });
  await unlocks.screen.render();
  await settle();
  unlocks.root.querySelectorAll('[data-unlock]')[1].focus();
  await unlocks.screen.render();
  await settle();
  assert.strictEqual(unlocks.doc.activeElement.getAttribute('aria-label'), 'Unlock b');
});

check('a reading for a drawing replaced, or a repository left, is not drawn over the one shown', async () => {
  /* The provider's rules. */
  const answers = [RULES, { ...RULES, controls: CONTROLS.map(control => ({ ...control, state: 'on' })) }, { ...RULES, protected: false }];
  const s = setup({ rules: () => answers.shift() || RULES });
  const first = s.gate('rules');
  await s.screen.render();
  await settle();
  await s.screen.render();
  await settle();
  assert.strictEqual(s.$('#sgStatRules').textContent, '8 of 8', 'the second drawing\u2019s reading');
  first.release();
  await settle();
  assert.strictEqual(s.$('#sgStatRules').textContent, '8 of 8', 'the first drawing\u2019s reading is not drawn over it');
  /* The file counts, from a list that knows nothing of repositories. */
  const lists = [];
  const counts = setup({ filesFn: () => new Promise(resolve => lists.push(resolve)) });
  await counts.screen.render();
  await settle();
  counts.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  await counts.screen.render();
  await settle();
  lists[1](['README.md']);
  await settle();
  lists[0](FILES);
  await settle();
  assert.strictEqual(counts.$('#sgFilesNote').textContent, '1 file on main', 'the counts of the repository open');
});

check('the latest reading is the one kept for the next minute; a branch is asked for as written', async () => {
  const answers = [RULES, { ...RULES, controls: CONTROLS.map(control => ({ ...control, state: 'on' })) }, { ...RULES, controls: CONTROLS.map(control => ({ ...control, state: 'off' })) }];
  const s = setup({ rules: () => answers.shift() || RULES });
  await s.screen.render();
  await settle();
  const older = s.gate('rules');
  const newer = s.gate('rules');
  await s.$('#sgRulesRefresh').click();
  await s.$('#sgRulesRefresh').click();
  newer.release();
  await settle();
  assert.strictEqual(s.$('#sgStatRules').textContent, '0 of 8');
  older.release();
  await settle();
  await s.screen.render();
  await settle();
  assert.strictEqual(s.$('#sgStatRules').textContent, '0 of 8', 'the reading asked last, not the one answered last');
  assert.strictEqual(s.requests('branch-protection').length, 3);
  s.page.work.branch = 'feat/a b';
  await s.screen.render();
  await settle();
  assert.strictEqual(s.requests('branch-protection').at(-1)[1], '/api/repo/octo/demo/branch-protection?branch=feat%2Fa%20b');
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
  console.log(`page safeguards: ${checks.length} checks passed`);
})();
