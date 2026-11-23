'use strict';

/*
 * A recovery snapshot and the recovery workflow, asked directly
 * (features/safeguards/snapshot-recovery.ts): a snapshot signed or kept
 * locally, kept under the repository it was taken of and downloaded, one
 * without its branches said as unreadable and not kept; recovery comparing a
 * pasted or kept snapshot, previewing what would move, restoring only once
 * RESTORE is typed, and every step belonging to the repository it started on.
 */

const assert = require('assert');
const rec = require('../apps/web/src/features/safeguards/snapshot-recovery.ts');
const { createDocument } = require('./helpers/markup-dom');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const SHA = 'a'.repeat(40);
const SNAP = Object.freeze({ kind: 'nebulaverse-snapshot', repo: 'demo', capturedAt: '2026-11-20T10:00:00Z', refs: [{ name: 'main', sha: SHA, protected: true }, { name: 'dev', sha: 'b'.repeat(40) }], tags: [{ name: 'v1' }] });
const read = html => { const doc = createDocument(); const body = doc.createElement('div'); doc.body.appendChild(body); body.innerHTML = html; return body; };

function setup(options = {}) {
  const log = [];
  const page = { work: { owner: 'octo', repo: 'demo', branch: 'main' } };
  const kept = new Map(Object.entries(options.kept || {}));
  const typed = { ...(options.typed || {}) };
  const gates = {};
  const answers = options.answers || {};
  let dialogs = 0;
  const tools = rec.createSnapshotRecovery({
    api: async (path, request) => {
      log.push(['api', path, request ? request.body : null]);
      const name = path.split('/').pop().split('?')[0];
      if (gates[name]) await gates[name].promise;
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(request);
      if (answer !== undefined) return answer;
      if (name === 'signed-snapshot') return { snapshot: SNAP, snapshotId: 'snap-1' };
      if (name === 'refs-snapshot') return SNAP;
      if (name === 'snapshot-compare') return { comparison: { counts: { refsToMove: 1, refsToRecreate: 1, newerRefsPreserved: 0, filesModified: 2, filesToRestore: 0, newerFilesPreserved: 1 } } };
      if (name === 'restore-preview') return { canRestore: true, authorization: 'auth-1', counts: {}, warnings: ['<b>main</b> is protected'], actions: [{ name: 'main', action: 'move', to: 'c'.repeat(40), protected: true }, { name: 'gone', action: 'recreate', to: SHA }] };
      if (name === 'restore-refs') return { report: [{ name: 'main', ok: true, action: 'moved' }, { name: 'gone', ok: false, error: '<i>refused</i>' }] };
      throw new Error(`unexpected ${path}`);
    },
    work: () => page.work,
    stored: name => (kept.has(name) ? kept.get(name) : null),
    store: (name, value) => { kept.set(name, value); log.push(['store', name]); },
    modal: async dialog => {
      dialogs += 1;
      log.push(['modal', dialog.title, dialog.bodyHTML, dialog.okText, Boolean(dialog.danger)]);
      if (options.during && options.during[dialogs]) options.during[dialogs](page);
      const answer = options.dialogs ? options.dialogs[dialogs - 1] : true;
      return answer === undefined ? true : answer;
    },
    value: selector => (typed[selector] === undefined ? null : typed[selector]),
    toast: (message, kind) => log.push(['toast', String(message), kind]),
    download: (name, text, type) => log.push(['download', name, JSON.parse(text), type]),
    snapshotTaken: () => log.push(['taken']),
    restored: () => log.push(['restored'])
  });
  const kinds = () => log.map(entry => entry[0]);
  const said = () => log.filter(entry => entry[0] === 'toast').map(entry => entry.slice(1));
  const dialogsShown = () => log.filter(entry => entry[0] === 'modal');
  const sent = () => log.filter(entry => entry[0] === 'api').map(entry => entry[1]);
  return { tools, page, kept, log, kinds, said, dialogsShown, sent, gate: name => (gates[name] = held()) };
}

check('a snapshot this page can keep lists its branches and when it was taken; one recovery can compare names its kind', () => {
  assert.strictEqual(rec.readableSnapshot(SNAP), true);
  for (const odd of [null, 'x', {}, { refs: [] }, { capturedAt: 'x' }, { refs: 'main', capturedAt: 'x' }, { refs: [], capturedAt: 7 }]) assert.strictEqual(rec.readableSnapshot(odd), false, JSON.stringify(odd));
  assert.strictEqual(rec.recoverable(SNAP), true);
  assert.strictEqual(rec.recoverable({ kind: 'nebulaverse-emergency-manifest', refs: [] }), true);
  for (const odd of [null, { kind: 'other', refs: [] }, { kind: 'nebulaverse-snapshot' }, { kind: 'nebulaverse-snapshot', refs: {} }]) assert.strictEqual(rec.recoverable(odd), false, JSON.stringify(odd));
});

check('a snapshot is described by its branches, tags and files, its names as text, and signed only when the server signed it', () => {
  const body = read(rec.snapshotSummary({ ...SNAP, manifest: { files: ['a', 'b', 'c'] } }, '<id>'));
  assert.strictEqual(body.querySelector('p').textContent, '2 branches, 1 tag(s), 3 files indexed. Signed and retained in Neon as <id>. A portable copy was downloaded.');
  assert.deepStrictEqual(body.children[1].querySelectorAll('p').map(row => row.textContent), ['main \u2014 aaaaaaaa (protected)', 'dev \u2014 bbbbbbbb']);
  const local = read(rec.snapshotSummary({ refs: [{ name: '<b>x</b>' }], tags: 'none' }, null));
  assert.strictEqual(local.querySelector('p').textContent, '1 branch, 0 tag(s). Saved locally because durable Neon evidence was unavailable. A portable copy was downloaded.');
  assert.deepStrictEqual([local.querySelectorAll('b').length, local.children[1].querySelectorAll('p').map(row => row.textContent)], [0, ['<b>x</b> \u2014 ']]);
  assert.ok(read(rec.snapshotSummary({ refs: [] }, null)).querySelector('p').textContent.startsWith('0 branches, 0 tag(s).'));
});

check('a snapshot is signed when it can be, kept under its repository, downloaded, and the screens read it again once said', async () => {
  const s = setup();
  await s.tools.snapshot();
  assert.deepStrictEqual(s.sent(), ['/api/repo/octo/demo/signed-snapshot']);
  assert.deepStrictEqual(s.log[1], ['api', '/api/repo/octo/demo/signed-snapshot', { manifest: true }]);
  assert.deepStrictEqual(JSON.parse(s.kept.get('nv_snap_octo/demo')), SNAP);
  const download = s.log.find(entry => entry[0] === 'download');
  assert.deepStrictEqual([download[1], download[2], download[3]], ['demo-2026-11-20.nvsnap.json', SNAP, undefined]);
  const [, title, html, okText] = s.dialogsShown()[0];
  assert.deepStrictEqual([title, okText], ['Recovery snapshot captured', 'Done']);
  assert.ok(read(html).querySelector('p').textContent.includes('Signed and retained in Neon as snap-1.'));
  assert.deepStrictEqual(s.kinds().slice(-2), ['modal', 'taken'], 'the screens read again once the dialog has handed focus back');
  assert.deepStrictEqual(s.said(), [['Capturing recovery snapshot\u2026', 'ok']]);
});

check('without a signed snapshot one is read and kept locally, and never called signed', async () => {
  for (const signed of [new Error('Neon is unavailable'), { available: false }, null, { snapshot: 'x', snapshotId: 'nope' }]) {
    const s = setup({ answers: { 'signed-snapshot': signed } });
    await s.tools.snapshot();
    assert.deepStrictEqual(s.sent(), ['/api/repo/octo/demo/signed-snapshot', '/api/repo/octo/demo/refs-snapshot?manifest=1'], JSON.stringify(signed));
    assert.ok(read(s.dialogsShown()[0][2]).querySelector('p').textContent.includes('Saved locally'), JSON.stringify(signed));
    assert.ok(s.kept.has('nv_snap_octo/demo'));
  }
  const unnamed = setup({ answers: { 'signed-snapshot': null, 'refs-snapshot': { ...SNAP, repo: undefined } } });
  await unnamed.tools.snapshot();
  assert.strictEqual(unnamed.log.find(entry => entry[0] === 'download')[1], 'demo-2026-11-20.nvsnap.json', 'named for its repository when the snapshot does not say');
});

check('a snapshot that cannot be read is said so and neither kept nor downloaded; a failure is said', async () => {
  for (const snap of [null, {}, { refs: [] }, { capturedAt: '2026-11-20T10:00:00Z' }, { refs: 'main', capturedAt: '2026-11-20' }]) {
    const s = setup({ answers: { 'signed-snapshot': null, 'refs-snapshot': snap } });
    await s.tools.snapshot();
    assert.deepStrictEqual([s.said().at(-1), s.kept.size, s.kinds().includes('download'), s.kinds().includes('taken')], [[rec.SNAPSHOT_UNREADABLE, 'err'], 0, false, false], JSON.stringify(snap));
  }
  const down = setup({ answers: { 'signed-snapshot': null, 'refs-snapshot': new Error('The provider is unavailable') } });
  await down.tools.snapshot();
  assert.deepStrictEqual(down.said().at(-1), ['The provider is unavailable', 'err']);
  const none = setup();
  none.page.work = null;
  await none.tools.snapshot();
  assert.deepStrictEqual(none.log, []);
});

check('a snapshot that arrives after another repository was opened is kept and downloaded for its own, and not described there', async () => {
  const s = setup();
  const gate = s.gate('signed-snapshot');
  const taking = s.tools.snapshot();
  await settle();
  s.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  gate.release();
  await taking;
  assert.deepStrictEqual([...s.kept.keys()], ['nv_snap_octo/demo'], 'under the repository it was taken of');
  assert.ok(s.kinds().includes('download'));
  assert.strictEqual(s.dialogsShown().length, 0);
  assert.deepStrictEqual(s.kinds().at(-1), 'taken');
  const lost = setup({ answers: { 'signed-snapshot': null, 'refs-snapshot': null } });
  const gate2 = lost.gate('refs-snapshot');
  const failing = lost.tools.snapshot();
  await settle();
  lost.page.work = { owner: 'octo', repo: 'other' };
  gate2.release();
  await failing;
  assert.deepStrictEqual(lost.said(), [['Capturing recovery snapshot\u2026', 'ok']], 'nothing said on the one open now');
  const failed = setup({ answers: { 'signed-snapshot': null, 'refs-snapshot': new Error('The provider is unavailable') } });
  const gate3 = failed.gate('refs-snapshot');
  const failing2 = failed.tools.snapshot();
  await settle();
  failed.page.work = { owner: 'octo', repo: 'other' };
  gate3.release();
  await failing2;
  assert.deepStrictEqual(failed.said(), [['Capturing recovery snapshot\u2026', 'ok']], 'a failure answered after is not said there');
});

check('recovery compares the snapshot, shows what would move, and restores once RESTORE is typed', async () => {
  const s = setup({ kept: { 'nv_snap_octo/demo': JSON.stringify(SNAP) }, typed: { '#recConfirm': ' restore ' } });
  await s.tools.recover();
  const [first, preview, confirm, report] = s.dialogsShown();
  assert.deepStrictEqual([first[1], first[3], first[4]], ['Verified recovery workflow', 'Analyze snapshot', true]);
  assert.ok(read(first[2]).textContent.includes('Leave empty to use the last snapshot captured on this device.'));
  assert.deepStrictEqual(s.log.filter(entry => entry[0] === 'api').map(entry => [entry[1], entry[2]]), [
    ['/api/repo/octo/demo/snapshot-compare', { snapshot: SNAP }], ['/api/repo/octo/demo/restore-preview', { snapshot: SNAP }],
    ['/api/repo/octo/demo/restore-refs', { confirm: 'RESTORE', authorization: 'auth-1' }]
  ]);
  const shown = read(preview[2]);
  assert.deepStrictEqual([preview[1], preview[3]], ['Recovery impact preview', 'Continue to confirmation']);
  assert.strictEqual(shown.querySelector('.neural-report-banner p').textContent, '1 branch(es) would move, 1 would be recreated, and 0 newer branch(es) would be preserved.');
  assert.ok(shown.textContent.includes('File comparison: 2 modified, 0 absent from the current tree, 1 newer file(s) preserved.'));
  assert.ok(shown.textContent.includes('\u26a0 <b>main</b> is protected') && shown.querySelectorAll('b').length === 1, 'a warning is text');
  assert.deepStrictEqual(shown.querySelectorAll('div p').filter(row => row.querySelector('.mono')).map(row => row.textContent),
    [`main \u2014 move to ${'c'.repeat(12)} \u00b7 provider protected`, `gone \u2014 recreate to ${'a'.repeat(12)}`]);
  assert.deepStrictEqual([confirm[1], confirm[3], read(confirm[2]).querySelector('b').textContent], ['Confirm branch reference recovery', 'Restore refs', '2']);
  assert.deepStrictEqual([report[1], read(report[2]).querySelectorAll('p').map(row => row.textContent)], ['Recovery complete \u2014 1/2', ['main \u2014 moved', 'gone \u2014 failed: <i>refused</i>']]);
  assert.ok(s.kinds().indexOf('restored') < s.log.indexOf(report), 'the repository is read again as soon as branches have moved');
});

check('a snapshot pasted is used before the one kept; one unreadable or of another kind is refused', async () => {
  const pasted = { ...SNAP, refs: [{ name: 'feature', sha: SHA }] };
  const s = setup({ kept: { 'nv_snap_octo/demo': JSON.stringify(SNAP) }, typed: { '#recJson': JSON.stringify(pasted) }, dialogs: [true, false] });
  await s.tools.recover();
  assert.deepStrictEqual(s.log.find(entry => entry[0] === 'api')[2], { snapshot: pasted });
  const nothingKept = setup({ dialogs: [true] });
  await nothingKept.tools.recover();
  assert.ok(!read(nothingKept.dialogsShown()[0][2]).textContent.includes('Leave empty'));
  assert.deepStrictEqual(nothingKept.said(), [['Not a Nebulaverse-X snapshot or emergency manifest', 'err']]);
  for (const [json, said] of [['{not json', 'That snapshot could not be read'], ['{"kind":"other","refs":[]}', 'Not a Nebulaverse-X snapshot or emergency manifest'], ['{"kind":"nebulaverse-snapshot"}', 'Not a Nebulaverse-X snapshot or emergency manifest']]) {
    const odd = setup({ typed: { '#recJson': json } });
    await odd.tools.recover();
    assert.deepStrictEqual([odd.said(), odd.sent()], [[[said, 'err']], []], json);
  }
  const spaces = setup({ kept: { 'nv_snap_octo/demo': JSON.stringify(SNAP) }, typed: { '#recJson': '   ' }, dialogs: [true, false] });
  await spaces.tools.recover();
  assert.deepStrictEqual(spaces.log.find(entry => entry[0] === 'api')[2], { snapshot: SNAP }, 'a paste of spaces is none: the kept one is used');
  const unreadableKept = setup({ kept: { 'nv_snap_octo/demo': '{broken' } });
  await unreadableKept.tools.recover();
  assert.deepStrictEqual(unreadableKept.said(), [['That snapshot could not be read', 'err']]);
});

check('recovery stops when turned down, when nothing would move, or when it cannot restore; a mismatch restores nothing', async () => {
  const kept = { 'nv_snap_octo/demo': JSON.stringify(SNAP) };
  const cancelled = setup({ kept, dialogs: [false] });
  await cancelled.tools.recover();
  assert.deepStrictEqual(cancelled.sent(), []);
  const previewOnly = setup({ kept, dialogs: [true, false] });
  await previewOnly.tools.recover();
  assert.deepStrictEqual(previewOnly.dialogsShown().length, 2);
  const matched = setup({ kept, answers: { 'restore-preview': { canRestore: true, actions: [] } } });
  await matched.tools.recover();
  assert.ok(read(matched.dialogsShown()[1][2]).textContent.includes('All recorded branch references already match.'));
  assert.strictEqual(matched.dialogsShown().length, 2);
  const blocked = setup({ kept, answers: { 'restore-preview': { canRestore: false, actions: [{ name: 'main', to: SHA }], counts: { refsToMove: 4, filesModified: '<b>9</b>' } }, 'snapshot-compare': {} } });
  await blocked.tools.recover();
  const [, , html, okText] = blocked.dialogsShown()[1];
  assert.deepStrictEqual([okText, blocked.dialogsShown().length], ['Close', 2]);
  assert.ok(read(html).textContent.includes('4 branch(es) would move') && read(html).textContent.includes('File comparison: 0 modified'), 'the preview\u2019s own counts, numbers only');
  const mismatch = setup({ kept, typed: { '#recConfirm': 'RESTOR' } });
  await mismatch.tools.recover();
  assert.deepStrictEqual([mismatch.said().at(-1), mismatch.sent().length, mismatch.kinds().includes('restored')], [['Recovery confirmation did not match', 'err'], 2, false]);
  const declined = setup({ kept, typed: { '#recConfirm': 'RESTORE' }, dialogs: [true, true, false] });
  await declined.tools.recover();
  assert.deepStrictEqual([declined.sent().length, declined.kinds().includes('restored')], [2, false], 'a confirmation turned down restores nothing');
  const empty = setup({ kept });
  await empty.tools.recover();
  assert.deepStrictEqual(empty.said().at(-1), ['Recovery confirmation did not match', 'err']);
});

check('every step of recovery belongs to the repository it was started on', async () => {
  const kept = { 'nv_snap_octo/demo': JSON.stringify(SNAP) };
  const away = () => page => { page.work = { owner: 'octo', repo: 'other' }; };
  for (const at of [1, 2, 3]) {
    const s = setup({ kept, typed: { '#recConfirm': 'RESTORE' }, during: { [at]: away() } });
    await s.tools.recover();
    assert.deepStrictEqual([s.sent().includes('/api/repo/octo/demo/restore-refs'), s.kinds().includes('restored')], [false, false], `another opened at dialog ${at}`);
    assert.deepStrictEqual([s.sent().length, s.dialogsShown().length], [[0, 2, 2][at - 1], at], `nothing asked or shown after dialog ${at}`);
  }
  const compared = setup({ kept });
  const gate = compared.gate('restore-preview');
  const comparing = compared.tools.recover();
  await settle();
  compared.page.work = { owner: 'octo', repo: 'other' };
  gate.release();
  await comparing;
  assert.deepStrictEqual([compared.dialogsShown().length, compared.said().length], [1, 1], 'a preview answered after is not shown');
  const restoring = setup({ kept, typed: { '#recConfirm': 'RESTORE' } });
  const gate2 = restoring.gate('restore-refs');
  const run = restoring.tools.recover();
  await settle();
  restoring.page.work = { owner: 'octo', repo: 'other' };
  gate2.release();
  await run;
  assert.deepStrictEqual([restoring.kinds().includes('restored'), restoring.dialogsShown().length], [false, 3], 'the other repository is not read again for it');
  const none = setup();
  none.page.work = null;
  await none.tools.recover();
  assert.deepStrictEqual(none.log, []);
});

check('a restore answered without its report is said so, the repository read again; a refusal is said', async () => {
  const kept = { 'nv_snap_octo/demo': JSON.stringify(SNAP) };
  const unread = setup({ kept, typed: { '#recConfirm': 'RESTORE' }, answers: { 'restore-refs': { ok: true } } });
  await unread.tools.recover();
  assert.deepStrictEqual([unread.kinds().includes('restored'), unread.said().at(-1), unread.dialogsShown().length], [true, [rec.RESTORE_UNREADABLE, 'err'], 3]);
  const refused = setup({ kept, typed: { '#recConfirm': 'RESTORE' }, answers: { 'restore-refs': new Error('The restore authorization expired') } });
  await refused.tools.recover();
  assert.deepStrictEqual([refused.said().at(-1), refused.kinds().includes('restored')], [['The restore authorization expired', 'err'], false]);
  const lateRefusal = setup({ kept, typed: { '#recConfirm': 'RESTORE' }, answers: { 'restore-refs': new Error('The restore authorization expired') } });
  const gate = lateRefusal.gate('restore-refs');
  const running = lateRefusal.tools.recover();
  await settle();
  lateRefusal.page.work = { owner: 'octo', repo: 'other' };
  gate.release();
  await running;
  assert.deepStrictEqual(lateRefusal.said(), [['Comparing recovery snapshot with the live repository\u2026', 'ok']], 'a refusal answered after is not said there');
  const failedCompare = setup({ kept, answers: { 'snapshot-compare': new Error('Snapshot is for another repository') } });
  await failedCompare.tools.recover();
  assert.deepStrictEqual(failedCompare.said().at(-1), ['Snapshot is for another repository', 'err']);
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
  console.log(`page recovery: ${checks.length} checks passed`);
})();
