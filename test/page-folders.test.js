'use strict';

/*
 * A folder moved or deleted from its menu, and a repository deleted, asked
 * directly (features/workbench/folder-flows.ts,
 * features/repositories/repository-deletion.ts, and forgetting a repository
 * in features/repositories/recent-repositories.ts): what each dialog says and
 * sends, the head every write lands on, the tree read again whatever landed,
 * and each acting only for the repository and branch it was asked on.
 */

const assert = require('assert');
const { createFolderFlows, headOf, FILES_UNREADABLE } = require('../apps/web/src/features/workbench/folder-flows.ts');
const { UNREAD_ANSWER } = require('../apps/web/src/features/workbench/item-menu.ts');
const { createRepositoryDeletion, DELETE_PERMISSION } = require('../apps/web/src/features/repositories/repository-deletion.ts');
const { forgetRepository, rememberRepository, recentRepositories, RECENT_REPOSITORIES } = require('../apps/web/src/features/repositories/recent-repositories.ts');
const { createDocument } = require('./helpers/markup-dom');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const HEAD = 'a'.repeat(40);
const sha = n => String(n).repeat(40).slice(0, 40);

/* The dialog as the page draws it: its fields read as the browser parses them. */
function dialogDocument(html) {
  const doc = createDocument();
  const body = doc.createElement('div');
  doc.body.appendChild(body);
  body.innerHTML = html;
  return body;
}

function folders(options = {}) {
  const log = [];
  const page = { work: { owner: 'octo', repo: 'demo', branch: 'main', branches: [{ name: 'main', sha: HEAD }, { name: 'dev', sha: 'b'.repeat(40) }] } };
  const typed = { '#mvDirTo': options.to, '#delFolderName': options.confirm };
  const gates = [];
  let batches = 0;
  const flows = createFolderFlows({
    api: async (path, request) => {
      log.push(['api', path, request ? request.body : null]);
      const gate = options.hold && options.hold(path, log) ? held() : null;
      if (gate) { gates.push(gate); await gate.promise; }
      if (path.includes('/files')) { if (options.filesFail) throw new Error(options.filesFail); return options.files === undefined ? { files: ['docs/a.md', 'docs/b/c.md', 'docs2/x.md', 'README.md', 7] } : options.files; }
      if (path.endsWith('/move-dir')) { if (options.refuse) throw new Error(options.refuse); return options.moved === undefined ? { ok: true, commit: sha(1), moved: 2 } : options.moved; }
      if (path.endsWith('/batch')) {
        batches += 1;
        if (options.failBatch === batches) throw new Error('Conflict: the branch moved');
        if (options.unreadBatch === batches) return null;
        return { ok: true, commit: options.batchCommit ? options.batchCommit(batches) : sha(batches + 1), count: request.body.ops.length };
      }
      throw new Error(`unexpected ${path}`);
    },
    work: () => page.work,
    modal: async dialog => { log.push(['modal', dialog.title, dialog.bodyHTML, dialog.okText, Boolean(dialog.danger)]); if (options.during) options.during(page, dialog); return options.cancel ? false : true; },
    value: selector => (typed[selector] === undefined ? null : typed[selector]),
    toast: (message, kind) => log.push(['toast', String(message), kind]),
    remember: (work, branch, commit) => log.push(['remember', work === page.work, branch, commit]),
    reloadTree: () => log.push(['reload']),
    productName: 'Nebulaverse-X'
  });
  const sent = () => log.filter(entry => entry[0] === 'api').map(entry => [entry[1], entry[2]]);
  const said = () => log.filter(entry => entry[0] === 'toast').map(entry => entry.slice(1));
  return { flows, page, log, sent, said, gates, reloads: () => log.filter(entry => entry[0] === 'reload').length };
}

check('the head a write lands on is the branch\u2019s, as last seen, and only a real one', () => {
  const work = { branches: [{ name: 'main', sha: HEAD }, { name: 'dev', sha: 'xyz' }, { name: 'up', sha: HEAD.toUpperCase() }, 'junk'] };
  assert.deepStrictEqual(['main', 'dev', 'up', 'none'].map(branch => headOf(work, branch)), [HEAD, '', HEAD.toUpperCase(), '']);
  for (const odd of [null, {}, { branches: 'main' }]) assert.strictEqual(headOf(odd, 'main'), '');
});

check('a folder is moved in one commit on the head last seen, and the tree and file list read again', async () => {
  const s = folders({ to: ' /guides/ ' });
  await s.flows.move('docs');
  assert.deepStrictEqual(s.sent(), [['/api/repo/octo/demo/move-dir', { from: 'docs', to: 'guides', branch: 'main', message: 'Move docs -> guides', expectedHeadSha: HEAD }]]);
  assert.deepStrictEqual(s.log.filter(entry => entry[0] === 'remember'), [['remember', true, 'main', sha(1)]]);
  assert.deepStrictEqual(s.said(), [['2 files moved to guides/ \u2726', 'ok']]);
  assert.strictEqual(s.reloads(), 1, 'the file list too, so no path that has gone is offered');
  for (const [moved, said] of [[{ ok: true, moved: 1 }, '1 file moved to guides/ \u2726'], [{ ok: true }, 'Moved to guides/ \u2726'], [{ ok: true, moved: '3' }, 'Moved to guides/ \u2726']]) {
    const one = folders({ to: 'guides', moved });
    await one.flows.move('docs');
    assert.deepStrictEqual(one.said(), [[said, 'ok']]);
  }
  const unheaded = folders({ to: 'guides' });
  unheaded.page.work.branches = [];
  await unheaded.flows.move('docs');
  assert.ok(!('expectedHeadSha' in unheaded.sent()[0][1]), 'no head known, none claimed');
});

check('the folder\u2019s name is the field\u2019s value as written, a quote and all', async () => {
  const s = folders({ cancel: true });
  await s.flows.move('a"b <c>');
  const [, title, html, okText] = s.log.find(entry => entry[0] === 'modal');
  assert.deepStrictEqual([title, okText], ['Rename / move folder', 'Move \u2726']);
  const body = dialogDocument(html);
  const input = body.querySelector('#mvDirTo');
  assert.strictEqual(input.value, 'a"b <c>');
  assert.deepStrictEqual([...input.attributes.keys()], ['id', 'type', 'value', 'autocomplete', 'autocapitalize', 'autocorrect', 'spellcheck', 'style'], 'the field carries its own attributes only');
  assert.strictEqual(body.querySelector('b').textContent, 'a"b <c>/');
  assert.deepStrictEqual(s.sent(), [], 'turned down, nothing sent');
  const typed = folders({ to: 'guides', cancel: true });
  await typed.flows.move('docs');
  assert.deepStrictEqual([typed.sent(), typed.said()], [[], []], 'turned down with a place typed, nothing sent');
});

check('a move with nowhere to go, refused, or unreadable is said so; nothing is said for another repository', async () => {
  for (const to of [null, '', '  ', '/', 'docs', '/docs/']) {
    const s = folders({ to });
    await s.flows.move('docs');
    assert.deepStrictEqual([s.sent(), s.said()], [[], []], JSON.stringify(to));
  }
  const refused = folders({ to: 'guides', refuse: 'Cannot move a folder inside itself' });
  await refused.flows.move('docs');
  assert.deepStrictEqual([refused.said(), refused.reloads()], [[['Cannot move a folder inside itself', 'err']], 0]);
  const unread = folders({ to: 'guides', moved: 'ok' });
  await unread.flows.move('docs');
  assert.deepStrictEqual([unread.said(), unread.reloads()], [[[UNREAD_ANSWER, 'err']], 1], 'it may have landed: the tree is read again');
  for (const during of [page => { page.work = { ...page.work }; }, page => { page.work.branch = 'dev'; }]) {
    const moved = folders({ to: 'guides', during });
    await moved.flows.move('docs');
    assert.deepStrictEqual(moved.sent(), [], 'confirmed after another was opened, nothing is sent');
  }
  const late = folders({ to: 'guides', hold: path => path.endsWith('/move-dir') });
  const moving = late.flows.move('docs');
  await settle();
  late.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  late.gates[0].release();
  await moving;
  assert.deepStrictEqual([late.said(), late.reloads(), late.log.filter(entry => entry[0] === 'remember')], [[], 0, []], 'answered after, nothing said or kept on the one open now');
  const lateRefusal = folders({ to: 'guides', refuse: 'No', hold: path => path.endsWith('/move-dir') });
  const refusing = lateRefusal.flows.move('docs');
  await settle();
  lateRefusal.page.work.branch = 'dev';
  lateRefusal.gates[0].release();
  await refusing;
  assert.deepStrictEqual(lateRefusal.said(), []);
  const none = folders({ to: 'x' });
  none.page.work = null;
  await none.flows.move('docs');
  assert.deepStrictEqual(none.log, []);
});

check('a folder is deleted by the files under it alone, in commits of a hundred, each on the head the last made', async () => {
  const many = Array.from({ length: 230 }, (_, i) => `docs/f${i}.md`);
  const s = folders({ confirm: ' docs ', files: { files: [...many, 'docs2/x.md', 'docsy', 'README.md'] } });
  await s.flows.remove('docs');
  const [, title, html, okText, danger] = s.log.find(entry => entry[0] === 'modal');
  assert.deepStrictEqual([title, okText, danger], ['Delete folder', 'Delete folder', true]);
  assert.strictEqual(dialogDocument(html).querySelector('p').textContent, 'This deletes 230 files under docs/ from main in 3 commits.');
  const sent = s.sent();
  assert.strictEqual(sent[0][0], '/api/repo/octo/demo/files?ref=main');
  const batches = sent.slice(1);
  assert.deepStrictEqual(batches.map(([path, body]) => [path, body.ops.length, body.expectedHeadSha, body.branch, body.message]), [
    ['/api/repo/octo/demo/batch', 100, HEAD, 'main', 'Delete docs/ via Nebulaverse-X'],
    ['/api/repo/octo/demo/batch', 100, sha(2), 'main', 'Delete docs/ via Nebulaverse-X'],
    ['/api/repo/octo/demo/batch', 30, sha(3), 'main', 'Delete docs/ via Nebulaverse-X']
  ]);
  assert.deepStrictEqual(batches.flatMap(([, body]) => body.ops.map(op => op.path)), many);
  assert.ok(batches.every(([, body]) => body.ops.every(op => op.op === 'delete')));
  assert.deepStrictEqual(s.log.filter(entry => entry[0] === 'remember').map(entry => entry[3]), [sha(2), sha(3), sha(4)]);
  assert.deepStrictEqual([s.said(), s.reloads()], [[['Folder docs/ deleted \u2726', 'ok']], 1]);
  const odd = folders({ confirm: 'docs', files: { files: many }, batchCommit: n => (n === 1 ? 'not-a-sha' : sha(n + 1)) });
  await odd.flows.remove('docs');
  assert.deepStrictEqual(odd.sent().slice(1).map(([, body]) => body.expectedHeadSha), [HEAD, HEAD, sha(3)], 'a commit that is not a head leaves the last one');
  const one = folders({ confirm: 'b', files: { files: ['a/b/only.md'] } });
  await one.flows.remove('a/b');
  assert.strictEqual(dialogDocument(one.log.find(entry => entry[0] === 'modal')[2]).querySelector('p').textContent, 'This deletes 1 file under a/b/ from main in 1 commit.');
  const none = folders();
  none.page.work = null;
  await none.flows.remove('docs');
  assert.deepStrictEqual(none.log, [], 'no repository, nothing asked');
  const branched = folders({ cancel: true, files: { files: ['docs/a'] } });
  branched.page.work.branch = 'feat/<a b>';
  await branched.flows.remove('docs');
  assert.strictEqual(branched.sent()[0][0], '/api/repo/octo/demo/files?ref=feat%2F%3Ca%20b%3E');
  assert.deepStrictEqual(dialogDocument(branched.log.find(entry => entry[0] === 'modal')[2]).querySelectorAll('b').map(node => node.textContent)[2], 'feat/<a b>');
  const named = folders({ confirm: '<x>', cancel: true, files: { files: ['q/<x>/f'] } });
  await named.flows.remove('q/<x>');
  const confirm = dialogDocument(named.log.find(entry => entry[0] === 'modal')[2]);
  assert.deepStrictEqual([confirm.querySelectorAll('b').map(node => node.textContent)], [['1 file', 'q/<x>/', 'main', '<x>']]);
});

check('a folder\u2019s deletion asks for its name, and stops at a refusal with the tree read again for what landed', async () => {
  const mismatch = folders({ confirm: 'Docs' });
  await mismatch.flows.remove('docs');
  assert.deepStrictEqual([mismatch.sent().length, mismatch.said()], [1, [['Name mismatch \u2014 aborted', 'err']]]);
  const empty = folders({ files: { files: ['README.md'] } });
  await empty.flows.remove('docs');
  assert.deepStrictEqual([empty.said(), empty.log.some(entry => entry[0] === 'modal')], [[['That folder has no files', 'err']], false]);
  for (const files of [null, {}, { files: 'docs/a.md' }]) {
    const odd = folders({ files });
    await odd.flows.remove('docs');
    assert.deepStrictEqual(odd.said(), [[FILES_UNREADABLE, 'err']], JSON.stringify(files));
  }
  const down = folders({ filesFail: 'The provider is unavailable' });
  await down.flows.remove('docs');
  assert.deepStrictEqual(down.said(), [['The provider is unavailable', 'err']]);
  const many = { files: Array.from({ length: 150 }, (_, i) => `docs/f${i}`) };
  const second = folders({ confirm: 'docs', files: many, failBatch: 2 });
  await second.flows.remove('docs');
  assert.deepStrictEqual([second.said(), second.reloads()], [[['Conflict: the branch moved', 'err']], 1], 'the first commit landed: the tree is read again');
  const first = folders({ confirm: 'docs', files: many, failBatch: 1 });
  await first.flows.remove('docs');
  assert.deepStrictEqual([first.said(), first.reloads(), first.sent().length], [[['Conflict: the branch moved', 'err']], 0, 2]);
  const unread = folders({ confirm: 'docs', files: many, unreadBatch: 1 });
  await unread.flows.remove('docs');
  assert.deepStrictEqual([unread.said(), unread.reloads(), unread.sent().length], [[[UNREAD_ANSWER, 'err']], 1, 2]);
});

check('a folder\u2019s deletion belongs to the repository it was asked on, and is carried through there', async () => {
  const listed = folders({ confirm: 'docs', hold: path => path.includes('/files') });
  const reading = listed.flows.remove('docs');
  await settle();
  listed.page.work = { owner: 'octo', repo: 'other', branch: 'main', branches: [] };
  listed.gates[0].release();
  await reading;
  assert.deepStrictEqual([listed.said(), listed.log.some(entry => entry[0] === 'modal')], [[], false], 'a list read after another was opened asks nothing');
  const failing = folders({ filesFail: 'The provider is unavailable', hold: path => path.includes('/files') });
  const failed = failing.flows.remove('docs');
  await settle();
  failing.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  failing.gates[0].release();
  await failed;
  assert.deepStrictEqual(failing.said(), [], 'a failed list answered after is not said on the one open now');
  const refusedLater = folders({ confirm: 'docs', files: { files: Array.from({ length: 150 }, (_, i) => `docs/f${i}`) }, failBatch: 2, hold: (path, log) => path.endsWith('/batch') && log.filter(entry => entry[1] === path).length === 2 });
  const refusing = refusedLater.flows.remove('docs');
  await settle();
  refusedLater.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  refusedLater.gates[0].release();
  await refusing;
  assert.deepStrictEqual([refusedLater.said(), refusedLater.reloads()], [[], 0], 'a refusal answered after is not said, nor the other tree read');
  const confirmed = folders({ confirm: 'docs', during: page => { page.work.branch = 'dev'; } });
  await confirmed.flows.remove('docs');
  assert.deepStrictEqual(confirmed.sent().length, 1, 'confirmed after the branch changed, nothing is deleted');
  const many = { files: Array.from({ length: 250 }, (_, i) => `docs/f${i}`) };
  const midway = folders({ confirm: 'docs', files: many, hold: (path, log) => path.endsWith('/batch') && log.filter(entry => entry[1] === path).length === 2 });
  const deleting = midway.flows.remove('docs');
  await settle();
  midway.page.work = { owner: 'octo', repo: 'other', branch: 'main', branches: [{ name: 'main', sha: 'c'.repeat(40) }] };
  midway.gates[0].release();
  await deleting;
  assert.deepStrictEqual(midway.sent().slice(1).map(([path, body]) => [path, body.expectedHeadSha]), [
    ['/api/repo/octo/demo/batch', HEAD], ['/api/repo/octo/demo/batch', sha(2)], ['/api/repo/octo/demo/batch', sha(3)]
  ], 'every commit for the repository confirmed, on its own heads');
  assert.deepStrictEqual(midway.log.filter(entry => entry[0] === 'remember').map(entry => entry[1]), [true, false, false], 'heads kept for the page only while it is open');
  assert.deepStrictEqual([midway.said(), midway.reloads()], [[], 0], 'nothing said or read again on the one open now');
});

function deletion(options = {}) {
  const log = [];
  const page = { work: { owner: 'octo', repo: 'demo', branch: 'main' }, me: { login: 'ada', offlineCacheScope: 'scope-1' } };
  const deleter = createRepositoryDeletion({
    work: () => page.work,
    me: () => page.me,
    modal: async dialog => { log.push(['modal', dialog.title, dialog.bodyHTML, dialog.okText, Boolean(dialog.danger)]); if (options.during) options.during(page); return !options.cancel; },
    value: selector => (selector === '#drName' ? (options.typed === undefined ? 'octo/demo' : options.typed) : null),
    toast: (message, kind) => log.push(['toast', String(message), kind]),
    stepUp: async (...args) => { log.push(['stepUp', ...args]); if (options.afterStepUp) options.afterStepUp(page); if (options.fail) throw options.fail; return options.declined ? null : { ok: true }; },
    present: error => log.push(['present', error]),
    forget: (owner, repo) => log.push(['forget', owner, repo]),
    showRepositories: () => log.push(['repositories']),
    loadRepositories: () => log.push(['load'])
  });
  return { deleter, page, log, kinds: () => log.map(entry => entry[0]) };
}

check('a repository is deleted once its full name is typed and the action verified, then forgotten', async () => {
  const s = deletion();
  await s.deleter.remove();
  const [, title, html, okText, danger] = s.log[0];
  assert.deepStrictEqual([title, okText, danger], ['Delete repository', 'Delete forever', true]);
  assert.deepStrictEqual(dialogDocument(html).querySelectorAll('b').map(node => node.textContent), ['octo/demo', 'This cannot be undone.', 'octo/demo']);
  assert.deepStrictEqual(s.log[1], ['stepUp', 'repository.delete', { owner: 'octo', repo: 'demo' }, '/api/repo/octo/demo', { method: 'DELETE', body: { confirmation: 'octo/demo' } }, 'Delete repository octo/demo']);
  assert.deepStrictEqual(s.log.slice(2), [['forget', 'octo', 'demo'], ['toast', 'Repository deleted', 'ok'], ['repositories'], ['load']]);
  const moved = deletion({ afterStepUp: page => { page.work = { owner: 'octo', repo: 'other' }; } });
  await moved.deleter.remove();
  assert.deepStrictEqual(moved.kinds().slice(2), ['forget', 'toast', 'load'], 'another repository opened meanwhile is not taken from the reader');
  const declined = deletion({ declined: true });
  await declined.deleter.remove();
  assert.deepStrictEqual(declined.kinds(), ['modal', 'stepUp'], 'verification turned down, nothing done');
  const shown = deletion({ typed: '<b>"x"</b>' });
  shown.page.work = { owner: 'o<b>', repo: 'r"x' };
  await shown.deleter.remove();
  assert.deepStrictEqual(dialogDocument(shown.log[0][2]).querySelectorAll('b').map(node => node.textContent), ['o<b>/r"x', 'This cannot be undone.', 'o<b>/r"x']);
});

check('a name typed wrong, or an account or repository changed while asked, deletes nothing', async () => {
  for (const typed of ['octo/Demo', 'demo', '', 'octo/demo/']) {
    const s = deletion({ typed });
    await s.deleter.remove();
    assert.deepStrictEqual(s.log.slice(1), [['toast', 'Name mismatch \u2014 aborted', 'err']], typed);
  }
  const padded = deletion({ typed: '  octo/demo ' });
  await padded.deleter.remove();
  assert.ok(padded.kinds().includes('stepUp'));
  for (const during of [page => { page.work = { owner: 'octo', repo: 'other' }; }, page => { page.me = { login: 'eve', offlineCacheScope: 'scope-2' }; }, page => { page.me = null; }, page => { page.work = null; }]) {
    const s = deletion({ during });
    await s.deleter.remove();
    assert.deepStrictEqual(s.log.slice(1), [['toast', 'Account or repository changed \u2014 reopen deletion confirmation.', 'err']]);
  }
  const unscoped = deletion({ during: page => { page.me = null; } });
  unscoped.page.me = { login: 'ada' };
  await unscoped.deleter.remove();
  assert.deepStrictEqual(unscoped.log.slice(1), [['toast', 'Account or repository changed \u2014 reopen deletion confirmation.', 'err']], 'signed out, even with no scope known');
  const same = deletion({ during: page => { page.work = { owner: 'octo', repo: 'demo' }; } });
  await same.deleter.remove();
  assert.ok(same.kinds().includes('stepUp'), 'the same repository opened again is still the one named');
  const cancelled = deletion({ cancel: true });
  await cancelled.deleter.remove();
  assert.deepStrictEqual(cancelled.kinds(), ['modal']);
  const none = deletion();
  none.page.work = null;
  await none.deleter.remove();
  assert.deepStrictEqual(none.log, []);
});

check('a refusal for want of the provider\u2019s permission says how to grant it', async () => {
  for (const message of ['403 Forbidden', 'Must have admin rights to Repository.', 'delete_repo scope required', 'forbidden']) {
    const s = deletion({ fail: new Error(message) });
    await s.deleter.remove();
    const [, error] = s.log.at(-1);
    assert.strictEqual(error.nextAction, DELETE_PERMISSION, message);
  }
  const own = Object.assign(new Error('403'), { nextAction: 'Ask an owner.' });
  const kept = deletion({ fail: own });
  await kept.deleter.remove();
  assert.strictEqual(kept.log.at(-1)[1].nextAction, 'Ask an owner.');
  const frozen = Object.freeze(new Error('403'));
  const still = deletion({ fail: frozen });
  await still.deleter.remove();
  assert.strictEqual(still.log.at(-1)[1], frozen, 'an error that cannot take a note is presented as it is');
  const other = deletion({ fail: new Error('The provider is unavailable') });
  await other.deleter.remove();
  assert.strictEqual(other.log.at(-1)[1].nextAction, undefined);
  assert.ok(!other.kinds().includes('forget'), 'not deleted, not forgotten');
  const odd = deletion({ fail: 'down' });
  await odd.deleter.remove();
  assert.deepStrictEqual(odd.log.at(-1), ['present', 'down']);
});

check('a deleted repository is forgotten from the recently opened, whatever its case, the rest kept in order', () => {
  const store = new Map();
  const storage = () => ({ getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => { store.set(key, value); } });
  rememberRepository(storage, 'octo', 'one');
  rememberRepository(storage, 'Octo', 'Demo', true);
  rememberRepository(storage, 'octo', 'three');
  forgetRepository(storage, 'octo', 'demo');
  assert.deepStrictEqual(recentRepositories(storage), [{ owner: 'octo', name: 'three' }, { owner: 'octo', name: 'one' }]);
  const before = store.get(RECENT_REPOSITORIES);
  forgetRepository(storage, 'octo', 'missing');
  assert.strictEqual(store.get(RECENT_REPOSITORIES), before, 'nothing to forget, nothing written');
  let writes = 0;
  const empty = () => ({ getItem: () => null, setItem: () => { writes += 1; } });
  forgetRepository(empty, 'octo', 'demo');
  assert.strictEqual(writes, 0);
  assert.doesNotThrow(() => forgetRepository(() => { throw new Error('private mode'); }, 'octo', 'demo'));
  assert.doesNotThrow(() => forgetRepository(() => ({ getItem: () => JSON.stringify([{ owner: 'octo', name: 'demo' }]), setItem: () => { throw new Error('full'); } }), 'octo', 'demo'));
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
  console.log(`page folders: ${checks.length} checks passed`);
})();
