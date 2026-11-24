'use strict';

/*
 * A file's own actions in the editor, asked directly
 * (features/workbench/file-actions.ts): a commit warned on a protected
 * branch once, questioned when the file changed on the provider, sent as the
 * editor held it when confirmed and marked committed only as far as it was
 * sent; refused, routed for approval or queued for the file it was for;
 * staging; a deletion committed or staged; a rename that carries edits not
 * yet committed to the new path; the history read; and a new file staged.
 * An answer that comes back after another file was opened changes that other
 * file in nothing.
 */

const assert = require('assert');
const fa = require('../apps/web/src/features/workbench/file-actions.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

function setup(options = {}) {
  const log = [];
  const page = {
    work: options.work === undefined ? { owner: 'octo', repo: 'demo', branch: 'feat/x' } : options.work,
    epoch: 1,
    file: options.file === undefined ? { path: 'src/a.js', sha: 's1', original: 'one', dirty: true } : options.file,
    text: options.text === undefined ? 'one two' : options.text,
    fields: { ...(options.fields || {}) },
    boxes: { ...(options.boxes || {}) },
    owner: true
  };
  const answers = options.answers || {};
  const dialogs = [...(options.dialogs || [])];
  const actions = fa.createFileActions({
    api: async (path, request) => {
      log.push(['api', path, request === undefined ? null : request]);
      const key = `${request ? request.method : 'GET'} ${path.split('?')[0]}`;
      const answer = answers[key];
      const value = typeof answer === 'function' ? await answer(request, page) : answer;
      if (value instanceof Error) throw value;
      return value === undefined ? {} : value;
    },
    work: () => page.work,
    epoch: () => page.epoch,
    file: () => page.file,
    mutateFile: change => { if (page.file) change(page.file); log.push(['mutate', page.file && { ...page.file }]); },
    text: () => page.text,
    modal: async request => {
      log.push(['modal', request]);
      const next = dialogs.length ? dialogs.shift() : true;
      return typeof next === 'function' ? next(page) : next;
    },
    modalOwner: () => { log.push(['owner']); return () => page.owner; },
    modalBody: html => log.push(['body', html]),
    value: selector => (selector in page.fields ? page.fields[selector] : null),
    checked: selector => Boolean(page.boxes[selector]),
    protectedBranch: name => (options.protected || []).includes(name),
    guardedWrite: body => ({ ...body, expectedHeadSha: 'h'.repeat(40) }),
    headSha: () => 'h'.repeat(40),
    rememberHead: commit => log.push(['head', commit]),
    refreshMetadata: async () => { log.push(['metadata']); },
    refreshRate: () => log.push(['rate']),
    drafts: {
      clear: path => log.push(['draft-clear', path]),
      keep: (path, text) => log.push(['draft-keep', path, text]),
      removeBar: () => log.push(['draft-bar-gone'])
    },
    commitable: on => log.push(['commitable', on]),
    safePassage: async (error, change) => { log.push(['safe-passage', error.message, change]); return options.routed || false; },
    queueCommit: async (op, error) => { log.push(['queue', op, error.message]); return options.queued || false; },
    presentError: error => log.push(['error', error.message]),
    stage: op => log.push(['stage', op]),
    openStage: () => log.push(['open-stage']),
    closeDrawer: () => log.push(['close-drawer']),
    closeFile: () => { log.push(['close-file']); page.file = null; },
    openFile: path => log.push(['open-file', path]),
    reloadTree: () => log.push(['tree']),
    timeAgo: at => `ago(${at})`,
    toast: (message, kind) => log.push(['toast', message, kind === undefined ? null : kind])
  });
  return { actions, log, page };
}
const kinds = (log, ...names) => log.filter(entry => names.includes(entry[0]));

check('a commit sends what the editor held when it was confirmed, with the message typed, and marks the file committed', async () => {
  const s = setup({ fields: { '#cmMsg': 'Tidy a' }, answers: { 'GET /api/repo/octo/demo/file': { sha: 's1' }, 'PUT /api/repo/octo/demo/file': { sha: 's2', commit: 'c'.repeat(40) } } });
  await s.actions.commit();
  const [dialog] = kinds(s.log, 'modal');
  assert.strictEqual(dialog[1].title, 'Commit changes');
  assert.ok(dialog[1].bodyHTML.includes('value="Update src/a.js"') && dialog[1].bodyHTML.includes('Committing directly to <b>feat/x</b>'));
  assert.deepStrictEqual(kinds(s.log, 'api'), [
    ['api', '/api/repo/octo/demo/file?ref=feat%2Fx&path=src%2Fa.js', null],
    ['api', '/api/repo/octo/demo/file', { method: 'PUT', body: { path: 'src/a.js', content: 'one two', message: 'Tidy a', branch: 'feat/x', sha: 's1', expectedHeadSha: 'h'.repeat(40) } }]
  ]);
  assert.deepStrictEqual(s.page.file, { path: 'src/a.js', sha: 's2', original: 'one two', dirty: false });
  assert.deepStrictEqual(s.log.slice(s.log.findIndex(entry => entry[0] === 'head')), [
    ['head', 'c'.repeat(40)],
    ['mutate', { path: 'src/a.js', sha: 's2', original: 'one two', dirty: false }],
    ['commitable', false],
    ['draft-clear', 'src/a.js'], ['draft-bar-gone'],
    ['toast', 'Committed \u2726', 'ok'], ['rate']
  ]);
  const blank = setup({ fields: { '#cmMsg': '' } });
  await blank.actions.commit();
  assert.strictEqual(kinds(blank.log, 'api')[1][2].body.message, undefined, 'a blank message is the provider\u2019s to choose');
  const gone = setup({});
  await gone.actions.commit();
  assert.strictEqual(kinds(gone.log, 'api')[1][2].body.message, undefined, 'no field, no message');
  const quoted = setup({ file: { path: 'a"b <c>.js', sha: 's1' } });
  await quoted.actions.commit();
  const body = kinds(quoted.log, 'modal')[0][1].bodyHTML;
  assert.ok(body.includes('value="Update a&quot;b &lt;c&gt;.js"'), 'a path is the field\u2019s value, never markup of its own');
});

check('an edit made while the commit is out stays an edit: offered to be committed, its draft kept', async () => {
  const put = held();
  const s = setup({ answers: { 'PUT /api/repo/octo/demo/file': async () => { await put.promise; return { sha: 's2', commit: 'c'.repeat(40) }; } } });
  const running = s.actions.commit();
  await settle();
  s.page.text = 'one two three';
  put.release();
  await running;
  assert.strictEqual(kinds(s.log, 'api')[1][2].body.content, 'one two', 'what was confirmed is what is sent');
  assert.deepStrictEqual(s.page.file, { path: 'src/a.js', sha: 's2', original: 'one two', dirty: true });
  assert.deepStrictEqual(kinds(s.log, 'commitable', 'draft-clear', 'draft-bar-gone', 'toast'), [['commitable', true], ['toast', 'Committed \u2726', 'ok']]);
});

check('a commit answered after another file was opened changes that file in nothing', async () => {
  const put = held();
  const s = setup({ answers: { 'PUT /api/repo/octo/demo/file': async () => { await put.promise; return { sha: 's2', commit: 'c'.repeat(40) }; } } });
  const running = s.actions.commit();
  await settle();
  const other = { path: 'src/b.js', sha: 'b1', original: 'b', dirty: false };
  s.page.file = other;
  s.page.text = 'b';
  put.release();
  await running;
  assert.deepStrictEqual(other, { path: 'src/b.js', sha: 'b1', original: 'b', dirty: false });
  assert.deepStrictEqual(kinds(s.log, 'mutate', 'commitable', 'draft-clear', 'draft-bar-gone'), []);
  assert.deepStrictEqual(kinds(s.log, 'head', 'toast', 'rate'), [['head', 'c'.repeat(40)], ['toast', 'Committed \u2726', 'ok'], ['rate']], 'the commit itself is still said');
  const moved = setup({ answers: { 'GET /api/repo/octo/demo/file': (request, page) => { page.text = 'typed since'; page.work = { owner: 'octo', repo: 'other', branch: 'main' }; return { sha: 's1' }; } } });
  await moved.actions.commit();
  assert.deepStrictEqual(kinds(moved.log, 'api')[1].slice(1), ['/api/repo/octo/demo/file', { method: 'PUT', body: { path: 'src/a.js', content: 'one two', message: undefined, branch: 'feat/x', sha: 's1', expectedHeadSha: 'h'.repeat(40) } }],
    'sent as confirmed, to the repository and branch it was confirmed for');
  const switched = setup({ dialogs: [page => { page.file = { path: 'src/b.js', sha: 'b1' }; return true; }] });
  await switched.actions.commit();
  assert.deepStrictEqual(kinds(switched.log, 'api', 'toast'), [['toast', 'src/a.js is no longer open; nothing was committed.', 'err']], 'a dialog for a file no longer open sends nothing');
});

check('a protected branch is warned of once for each repository and branch, and declining sends nothing', async () => {
  const s = setup({ protected: ['main', 'dev'], work: { owner: 'octo', repo: 'demo', branch: 'main' }, dialogs: [false] });
  await s.actions.commit();
  assert.deepStrictEqual(kinds(s.log, 'modal').map(entry => entry[1].title), ['Protected branch']);
  assert.ok(kinds(s.log, 'modal')[0][1].bodyHTML.startsWith('<p class="hint"><b>main</b> is protected.'));
  assert.deepStrictEqual([kinds(s.log, 'modal')[0][1].okText, kinds(s.log, 'modal')[0][1].danger], ['Commit anyway', true]);
  assert.deepStrictEqual(kinds(s.log, 'api'), []);
  await s.actions.commit();
  await s.actions.commit();
  assert.deepStrictEqual(kinds(s.log, 'modal').map(entry => entry[1].title), ['Protected branch', 'Protected branch', 'Commit changes', 'Commit changes'], 'warned until chosen, then once is enough');
  s.page.work = { owner: 'octo', repo: 'demo', branch: 'dev' };
  await s.actions.commit();
  assert.strictEqual(kinds(s.log, 'modal').slice(-2)[0][1].title, 'Protected branch', 'another protected branch is warned of afresh');
  s.page.work = { owner: 'octo', repo: 'other', branch: 'main' };
  await s.actions.commit();
  assert.strictEqual(kinds(s.log, 'modal').slice(-2)[0][1].title, 'Protected branch', 'another repository is warned of afresh');
  const none = setup({ file: null });
  await none.actions.commit();
  const binary = setup({ file: { path: 'a.png', sha: 's', binary: true } });
  await binary.actions.commit();
  assert.deepStrictEqual([none.log, binary.log], [[], []]);
  const declined = setup({ dialogs: [false] });
  await declined.actions.commit();
  assert.deepStrictEqual(kinds(declined.log, 'api'), []);
});

check('a file changed on the provider since it was opened is asked about; the answer decides', async () => {
  const changed = { 'GET /api/repo/octo/demo/file': { sha: 'remote' } };
  const cancel = setup({ answers: changed, dialogs: [true, false] });
  await cancel.actions.commit();
  const question = kinds(cancel.log, 'modal')[1][1];
  assert.deepStrictEqual([question.title, question.okText, question.danger], ['File changed on GitHub', 'Overwrite anyway', true]);
  assert.ok(question.bodyHTML.includes('<b class="mono">src/a.js</b>'));
  assert.deepStrictEqual(kinds(cancel.log, 'api').length, 1, 'cancelled, nothing is written');
  const overwrite = setup({ answers: { ...changed, 'PUT /api/repo/octo/demo/file': { sha: 's3' } } });
  await overwrite.actions.commit();
  assert.deepStrictEqual(kinds(overwrite.log, 'metadata').length, 1);
  assert.strictEqual(kinds(overwrite.log, 'api')[1][2].body.sha, 'remote', 'written over the version found');
  const moved = setup({ answers: { ...changed, 'PUT /api/repo/octo/demo/file': { sha: 's3' } }, dialogs: [true, page => { page.file = { path: 'src/b.js', sha: 'b1' }; return true; }] });
  await moved.actions.commit();
  assert.deepStrictEqual(moved.page.file, { path: 'src/b.js', sha: 'b1' }, 'the file opened meanwhile keeps its own version');
  assert.strictEqual(kinds(moved.log, 'api')[1][2].body.sha, 'remote');
  for (const answer of [{ sha: 's1' }, {}, new Error('offline')]) {
    const s = setup({ answers: { 'GET /api/repo/octo/demo/file': answer } });
    await s.actions.commit();
    assert.deepStrictEqual([kinds(s.log, 'modal').length, kinds(s.log, 'api').length, kinds(s.log, 'api')[1][2].body.sha], [1, 2, 's1'], 'nothing to ask, or nothing known: the write decides');
  }
  const unversioned = setup({ file: { path: 'src/a.js', sha: null }, answers: changed });
  await unversioned.actions.commit();
  assert.deepStrictEqual(kinds(unversioned.log, 'modal').length, 1, 'a file with no version of its own is not asked about');
});

check('a refused commit: routed for approval, or queued for the file it was for, or said', async () => {
  const refused = { 'PUT /api/repo/octo/demo/file': new Error('refused') };
  const routed = setup({ fields: { '#cmMsg': 'm' }, answers: refused, routed: true });
  await routed.actions.commit();
  assert.deepStrictEqual(kinds(routed.log, 'safe-passage', 'queue', 'error', 'mutate', 'commitable'), [['safe-passage', 'refused', { content: 'one two', message: 'm', sha: 's1' }]]);
  const put = held();
  const queued = setup({ fields: { '#cmMsg': 'm' }, answers: { 'PUT /api/repo/octo/demo/file': async () => { await put.promise; return new Error('offline'); } }, queued: true });
  const running = queued.actions.commit();
  await settle();
  queued.page.text = 'one two three';
  put.release();
  await running;
  assert.deepStrictEqual(kinds(queued.log, 'queue'), [['queue', { kind: 'put', owner: 'octo', repo: 'demo', branch: 'feat/x', path: 'src/a.js', content: 'one two', message: 'm', sha: 's1', expectedHeadSha: 'h'.repeat(40) }, 'offline']]);
  assert.deepStrictEqual([queued.page.file.dirty, queued.page.file.original, kinds(queued.log, 'commitable')], [true, 'one', [['commitable', true]]], 'queued as sent; an edit since stays an edit');
  const settled = setup({ answers: refused, queued: true });
  await settled.actions.commit();
  assert.deepStrictEqual([settled.page.file.dirty, kinds(settled.log, 'commitable', 'error')], [false, [['commitable', false]]]);
  const away = setup({ answers: { 'PUT /api/repo/octo/demo/file': async (request, page) => { page.file = { path: 'src/b.js', sha: 'b1' }; return new Error('offline'); } }, queued: true });
  await away.actions.commit();
  assert.deepStrictEqual([kinds(away.log, 'queue')[0][1].path, kinds(away.log, 'queue')[0][1].content, away.page.file, kinds(away.log, 'mutate', 'commitable')], ['src/a.js', 'one two', { path: 'src/b.js', sha: 'b1' }, []]);
  const said = setup({ answers: refused });
  await said.actions.commit();
  assert.deepStrictEqual(kinds(said.log, 'error', 'mutate', 'commitable', 'toast'), [['error', 'refused']]);
});

check('staging takes the editor\u2019s text and leaves nothing to commit or restore', () => {
  const s = setup({});
  s.actions.stage();
  assert.deepStrictEqual(s.log, [
    ['stage', { op: 'put', path: 'src/a.js', content: 'one two' }],
    ['mutate', { path: 'src/a.js', sha: 's1', original: 'one', dirty: false }],
    ['commitable', false],
    ['draft-clear', 'src/a.js'], ['draft-bar-gone'],
    ['toast', 'Staged src/a.js', 'ok']
  ]);
  const none = setup({ file: null });
  none.actions.stage();
  const binary = setup({ file: { path: 'a.png', sha: 's', binary: true } });
  binary.actions.stage();
  assert.deepStrictEqual([none.log, binary.log], [[], []]);
});

check('a deletion: committed for the file asked, staged instead, or said; another file opened meanwhile stays open', async () => {
  const unknown = setup({ file: { path: 'src/a.js', sha: null } });
  await unknown.actions.remove();
  assert.deepStrictEqual(unknown.log, [['toast', 'Cannot delete: metadata unavailable', 'err']]);
  const nothing = setup({ file: null });
  await nothing.actions.remove();
  assert.deepStrictEqual(nothing.log, [['toast', 'Cannot delete: metadata unavailable', 'err']]);
  const declined = setup({ dialogs: [false] });
  await declined.actions.remove();
  const dialog = kinds(declined.log, 'modal')[0][1];
  assert.deepStrictEqual([dialog.title, dialog.okText, dialog.danger], ['Delete file', 'Delete', true]);
  assert.ok(dialog.bodyHTML.includes('Delete <b class="mono">src/a.js</b> from <b>feat/x</b>?') && dialog.bodyHTML.includes('id="delStage"'));
  assert.deepStrictEqual(kinds(declined.log, 'api', 'stage'), []);
  const staged = setup({ boxes: { '#delStage': true } });
  await staged.actions.remove();
  assert.deepStrictEqual(kinds(staged.log, 'api', 'stage', 'toast'), [['stage', { op: 'delete', path: 'src/a.js' }], ['toast', 'Deletion of src/a.js staged', 'ok']]);
  const elsewhere = setup({ dialogs: [page => { page.work = { owner: 'octo', repo: 'other', branch: 'main' }; return true; }] });
  await elsewhere.actions.remove();
  assert.deepStrictEqual(kinds(elsewhere.log, 'api')[0].slice(1), ['/api/repo/octo/demo/file', { method: 'DELETE', body: { path: 'src/a.js', branch: 'feat/x', sha: 's1', expectedHeadSha: 'h'.repeat(40) } }],
    'deleted where it was asked');
  const done = setup({ answers: { 'DELETE /api/repo/octo/demo/file': { commit: 'd'.repeat(40) } } });
  await done.actions.remove();
  assert.deepStrictEqual(kinds(done.log, 'api', 'head', 'toast', 'close-file', 'tree'), [
    ['api', '/api/repo/octo/demo/file', { method: 'DELETE', body: { path: 'src/a.js', branch: 'feat/x', sha: 's1', expectedHeadSha: 'h'.repeat(40) } }],
    ['head', 'd'.repeat(40)], ['toast', 'File deleted', 'ok'], ['close-file'], ['tree']
  ]);
  const other = { path: 'src/b.js', sha: 'b1' };
  const away = setup({ answers: { 'DELETE /api/repo/octo/demo/file': async (request, page) => { page.file = other; return {}; } } });
  await away.actions.remove();
  assert.deepStrictEqual([away.page.file, kinds(away.log, 'close-file', 'tree')], [other, [['tree']]]);
  const failed = setup({ answers: { 'DELETE /api/repo/octo/demo/file': new Error('locked') } });
  await failed.actions.remove();
  assert.deepStrictEqual(kinds(failed.log, 'error', 'toast', 'close-file', 'tree'), [['error', 'locked']]);
});

check('a rename: the new path trimmed, the file opened there, and edits not yet committed carried there as a draft', async () => {
  const declined = setup({ fields: { '#rnTo': 'lib/a.js' }, dialogs: [false] });
  await declined.actions.rename();
  const dialog = kinds(declined.log, 'modal')[0][1];
  assert.deepStrictEqual([dialog.title, dialog.okText], ['Rename / move file', 'Rename \u2726']);
  assert.ok(dialog.bodyHTML.includes('id="rnTo" type="text" value="src/a.js"'));
  assert.deepStrictEqual(kinds(declined.log, 'api'), []);
  for (const typed of [null, '', '  ', 'src/a.js', '/src/a.js', ' //src/a.js ']) {
    const s = setup({ fields: { '#rnTo': typed } });
    await s.actions.rename();
    assert.deepStrictEqual(kinds(s.log, 'api'), [], `${JSON.stringify(typed)} moves nothing`);
  }
  const dirty = setup({ fields: { '#rnTo': ' //lib/a.js ' }, answers: { 'POST /api/repo/octo/demo/rename': { commit: 'r'.repeat(40) } } });
  await dirty.actions.rename();
  assert.deepStrictEqual(kinds(dirty.log, 'api', 'head', 'toast', 'tree', 'draft-keep', 'draft-clear', 'open-file'), [
    ['api', '/api/repo/octo/demo/rename', { method: 'POST', body: { from: 'src/a.js', to: 'lib/a.js', branch: 'feat/x', expectedHeadSha: 'h'.repeat(40) } }],
    ['head', 'r'.repeat(40)], ['toast', 'Renamed to lib/a.js \u2726', 'ok'], ['tree'],
    ['draft-keep', 'lib/a.js', 'one two'], ['draft-clear', 'src/a.js'],
    ['open-file', 'lib/a.js']
  ]);
  const clean = setup({ file: { path: 'src/a.js', sha: 's1', original: 'one', dirty: false }, fields: { '#rnTo': 'lib/a.js' } });
  await clean.actions.rename();
  assert.deepStrictEqual(kinds(clean.log, 'draft-keep', 'draft-clear', 'open-file'), [['open-file', 'lib/a.js']]);
  const away = setup({ fields: { '#rnTo': 'lib/a.js' }, answers: { 'POST /api/repo/octo/demo/rename': async (request, page) => { page.file = { path: 'src/b.js', sha: 'b1' }; return {}; } } });
  await away.actions.rename();
  assert.deepStrictEqual(kinds(away.log, 'tree', 'draft-keep', 'draft-clear', 'open-file'), [['tree']], 'another file opened meanwhile stays open');
  const failed = setup({ fields: { '#rnTo': 'lib/a.js' }, answers: { 'POST /api/repo/octo/demo/rename': new Error('exists') } });
  await failed.actions.rename();
  assert.deepStrictEqual(kinds(failed.log, 'error', 'toast', 'tree', 'open-file'), [['error', 'exists']]);
  const none = setup({ file: null });
  await none.actions.rename();
  assert.deepStrictEqual(none.log, []);
});

check('the history: read for the file asked, each commit said in its first line, and only into its own dialog', async () => {
  const s = setup({ answers: { 'GET /api/repo/octo/demo/commits': [
    { sha: 'abcdef1234', author: 'Ann <a>', date: 'd1', message: 'Fix <b>\nbody' },
    { sha: null, author: null, date: 'd2' }
  ] } });
  await s.actions.history();
  const [dialog] = kinds(s.log, 'modal');
  assert.deepStrictEqual(dialog[1], { title: 'History \u2014 a.js', okText: 'Close', bodyHTML: '<div class="skeleton" style="height:80px"></div>' });
  assert.deepStrictEqual(kinds(s.log, 'api'), [['api', '/api/repo/octo/demo/commits?ref=feat%2Fx&path=src%2Fa.js', null]]);
  const [[, html]] = kinds(s.log, 'body');
  assert.ok(html.includes('<span class="mono commit-sha">abcdef1</span><span>Ann &lt;a&gt;</span><span>ago(d1)</span>'));
  assert.ok(html.includes('<div class="comment-body">Fix &lt;b&gt;</div>') && !html.includes('body</div>'));
  assert.ok(html.includes('<span class="mono commit-sha"></span><span></span><span>ago(d2)</span>') && html.includes('<div class="comment-body"></div>'), 'a commit missing its fields is still listed');
  const empty = setup({ answers: { 'GET /api/repo/octo/demo/commits': [] } });
  await empty.actions.history();
  assert.deepStrictEqual(kinds(empty.log, 'body'), [['body', '<p class="hint">No history found for this path.</p>']]);
  for (const [answer, said] of [[{ commits: [] }, 'The history could not be read.'], [new Error('rate limited'), 'rate limited'], [new Error(''), 'The history could not be read.'], [new Error('<x>'), '&lt;x&gt;']]) {
    const failed = setup({ answers: { 'GET /api/repo/octo/demo/commits': answer } });
    await failed.actions.history();
    assert.deepStrictEqual(kinds(failed.log, 'body'), [['body', `<p class="hint">\u26a0 ${said}</p>`]]);
  }
  const replaced = setup({ answers: { 'GET /api/repo/octo/demo/commits': async (request, page) => { page.owner = false; return []; } } });
  await replaced.actions.history();
  assert.deepStrictEqual(kinds(replaced.log, 'body'), [], 'a dialog opened since is not written into');
  const none = setup({ file: null });
  await none.actions.history();
  assert.deepStrictEqual(none.log, []);
});

check('a new file is staged for the repository and branch it was asked for', async () => {
  const s = setup({ fields: { '#nfPath': '  /docs/notes.md ' } });
  await s.actions.create();
  const [dialog] = kinds(s.log, 'modal');
  assert.deepStrictEqual([dialog[1].title, dialog[1].okText], ['New file', 'Stage file']);
  assert.ok(dialog[1].bodyHTML.includes('id="nfPath"'));
  assert.deepStrictEqual(s.log.slice(1), [
    ['stage', { op: 'put', path: 'docs/notes.md', content: '', newFile: true }],
    ['toast', 'New file docs/notes.md staged for review', null],
    ['close-drawer'], ['open-stage']
  ]);
  const none = setup({ work: null });
  await none.actions.create();
  assert.deepStrictEqual(none.log, []);
  const declined = setup({ fields: { '#nfPath': 'a' }, dialogs: [false] });
  await declined.actions.create();
  assert.deepStrictEqual(kinds(declined.log, 'stage', 'toast'), []);
  const changed = 'The repository changed. Open New file again for the intended branch.';
  for (const move of [page => { page.epoch = 2; }, page => { page.work = { ...page.work, branch: 'main' }; }, page => { page.work = { ...page.work, repo: 'other' }; }, page => { page.work = { ...page.work, owner: 'else' }; }, page => { page.work = null; }]) {
    const moved = setup({ fields: { '#nfPath': 'a' }, dialogs: [page => { move(page); return true; }] });
    await moved.actions.create();
    assert.deepStrictEqual(kinds(moved.log, 'stage', 'toast'), [['toast', changed, 'err']]);
  }
  for (const typed of [null, '', ' / ']) {
    const blank = setup({ fields: { '#nfPath': typed } });
    await blank.actions.create();
    assert.deepStrictEqual(kinds(blank.log, 'stage', 'toast'), [], `${JSON.stringify(typed)} stages nothing`);
  }
});

(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  if (failed) { console.error(`page file actions: ${failed} of ${checks.length} checks failed`); process.exit(1); }
  console.log(`page file actions: ${checks.length} checks passed`);
})();
