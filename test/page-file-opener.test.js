'use strict';

/*
 * A file opened in the editor, asked directly
 * (features/workbench/file-opener.ts): text shown with its mode and a draft
 * offered back; images, videos and PDFs previewed; Git LFS pointers and
 * files too large offered as downloads; each open in its own turn; the file
 * asked for marked as loading so the placeholder is never an edit of the file
 * before; and a file that cannot be read leaving nothing open to commit.
 */

const assert = require('assert');
const fo = require('../apps/web/src/features/workbench/file-opener.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const ANSWER = (text, extra = {}) => ({ sha: 's1', size: text.length, content: Buffer.from(text).toString('base64'), ...extra });

function setup(options = {}) {
  const log = [];
  const page = { file: options.file === undefined ? null : options.file, find: options.find || null, work: { owner: 'octo', repo: 'demo', branch: 'feat/x' } };
  const answers = options.answers || {};
  const gates = options.gates || {};
  const editor = {
    value: '', mode: undefined,
    setValue: text => { editor.value = text; log.push(['value', text, page.file && page.file.path, page.file && Boolean(page.file._loading)]); },
    setOption: (name, value) => { editor.mode = value; log.push(['option', name, value]); },
    refresh: () => log.push(['refresh'])
  };
  const opener = fo.createFileOpener({
    api: async path => {
      log.push(['api', path]);
      const name = new URL(path, 'https://x').searchParams.get('path');
      if (gates[name]) await gates[name].promise;
      const answer = name in answers ? answers[name] : ANSWER(`text of ${name}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    work: () => page.work,
    editor: () => { log.push(['editor']); return editor; },
    mode: path => (path.endsWith('.js') ? { mime: 'text/javascript', mode: 'javascript' } : path.endsWith('.py') ? { mode: 'python' } : null),
    decode: base64 => Buffer.from(base64, 'base64').toString('utf8'),
    size: bytes => `${bytes} B`,
    file: { set: file => { page.file = file; log.push(['file', file && { ...file }]); }, mutate: change => { if (page.file) change(page.file); log.push(['mutate', page.file && { ...page.file }]); } },
    ui: {
      shell: (path, markdown) => log.push(['shell', path, markdown]),
      closed: () => log.push(['closed']),
      size: text => log.push(['size', text]),
      preview: html => log.push(['preview', html]),
      commitable: on => log.push(['commitable', on])
    },
    closeFind: () => log.push(['close-find']),
    removeDraftBar: () => log.push(['no-draft-bar']),
    showEditor: () => log.push(['show-editor']),
    remember: path => log.push(['remember', path]),
    saveRoute: () => log.push(['route']),
    offerDraft: (path, text) => log.push(['draft', path, text]),
    takeFind: () => { const words = page.find; page.find = null; return words; },
    openFind: words => log.push(['find', words]),
    toast: (message, kind) => log.push(['toast', message, kind]),
    later: (run, ms) => { log.push(['later', ms]); run(); }
  });
  const of = kind => log.filter(entry => entry[0] === kind);
  return { opener, page, log, of, editor };
}

check('the extensions previewed, and what a path\u2019s extension is', () => {
  assert.deepStrictEqual([...fo.IMAGE_EXTENSIONS], ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);
  assert.deepStrictEqual([...fo.VIDEO_EXTENSIONS], ['mp4', 'webm']);
  assert.deepStrictEqual(['a/b.JS', 'README.md', 'Makefile', 'a.tar.gz', '.env', ''].map(fo.extensionOf), ['js', 'md', 'makefile', 'gz', 'env', '']);
});

check('a text file shown with its mode, its draft offered back, its route kept and remembered', async () => {
  const s = setup();
  await s.opener.open('src/app.js');
  assert.deepStrictEqual(s.log.slice(0, 6), [['shell', 'src/app.js', false], ['close-find'], ['no-draft-bar'], ['show-editor'],
    ['file', { path: 'src/app.js', sha: null, _loading: true }], ['commitable', false]]);
  assert.deepStrictEqual(s.of('api'), [['api', '/api/repo/octo/demo/file?ref=feat%2Fx&path=src%2Fapp.js']]);
  assert.deepStrictEqual(s.of('value'), [['value', 'Loading\u2026', 'src/app.js', true], ['value', 'text of src/app.js', 'src/app.js', true]]);
  assert.deepStrictEqual(s.editor.mode, 'text/javascript');
  assert.deepStrictEqual(s.page.file, { path: 'src/app.js', sha: 's1', dirty: false, original: 'text of src/app.js', _loading: false });
  assert.deepStrictEqual(s.log.slice(-10), [['size', '18 B'], ['option', 'mode', 'text/javascript'], ['value', 'text of src/app.js', 'src/app.js', true],
    ['mutate', { path: 'src/app.js', sha: 's1', dirty: false, original: 'text of src/app.js', _loading: false }], ['remember', 'src/app.js'], ['route'],
    ['draft', 'src/app.js', 'text of src/app.js'], ['commitable', false], ['later', 30], ['refresh']]);
  assert.deepStrictEqual(s.of('later').map(entry => entry[1]), [30], 'the editor refreshed once laid out');
  const python = setup();
  await python.opener.open('tool.py');
  assert.strictEqual(python.editor.mode, 'python');
  const plain = setup();
  await plain.opener.open('NOTES');
  assert.strictEqual(plain.editor.mode, null);
  const markdown = setup();
  await markdown.opener.open('docs/README.md');
  assert.deepStrictEqual(markdown.log[0], ['shell', 'docs/README.md', true]);
  const found = setup({ find: 'needle' });
  await found.opener.open('a.js');
  assert.deepStrictEqual([found.of('find'), found.page.find, found.of('later').map(entry => entry[1])], [[['find', 'needle']], null, [120, 30]]);
});

check('images, videos and PDFs previewed with their size, never edited', async () => {
  const s = setup({ answers: { 'logo.PNG': { sha: 'p1', size: 2048 } } });
  await s.opener.open('logo.PNG');
  assert.deepStrictEqual(s.log.slice(4, 7), [['file', { path: 'logo.PNG', sha: null, binary: true }], ['commitable', false],
    ['preview', '<img src="/api/repo/octo/demo/raw?ref=feat%2Fx&path=logo.PNG" alt="">']]);
  assert.deepStrictEqual([s.page.file.sha, s.of('size'), s.of('editor')], ['p1', [['size', '2048 B']], []]);
  const video = setup();
  await video.opener.open('clip.webm');
  assert.deepStrictEqual(video.of('preview')[0][1], '<video src="/api/repo/octo/demo/raw?ref=feat%2Fx&path=clip.webm" controls playsinline></video>');
  const pdf = setup({ answers: { 'a b.pdf': new Error('gone') } });
  await pdf.opener.open('a b.pdf');
  assert.deepStrictEqual([pdf.of('preview')[0][1], pdf.of('size'), pdf.of('toast'), pdf.page.file.sha],
    ['<p>Binary file.</p><a class="btn btn-ghost" href="/api/repo/octo/demo/raw?ref=feat%2Fx&path=a%20b.pdf" download>Download</a>', [], [], null], 'the preview stands without its size');
});

check('a Git LFS pointer and a file too large are offered as downloads', async () => {
  const s = setup({ answers: { 'big.bin': { lfs: true, sha: 'l1', size: 9000 } } });
  await s.opener.open('big.bin');
  assert.deepStrictEqual(s.page.file, { path: 'big.bin', sha: 'l1', binary: true });
  assert.ok(s.of('preview')[0][1].includes('real size <b>9000 B</b>') && s.of('preview')[0][1].includes('href="/api/repo/octo/demo/raw?ref=feat%2Fx&path=big.bin" download>Download 9000 B</a>'));
  assert.deepStrictEqual(s.of('size'), [['size', '9000 B \u00b7 LFS']]);
  const large = setup({ answers: { 'huge.json': { tooLarge: true, sha: 't1', size: 7 } } });
  await large.opener.open('huge.json');
  assert.deepStrictEqual(large.page.file, { path: 'huge.json', sha: 't1', binary: true });
  assert.ok(large.of('preview')[0][1].startsWith('<p>This file is 7 B \u2014 too large for the in-browser editor.'));
  assert.deepStrictEqual([large.of('size'), large.of('remember'), large.of('draft')], [[['size', '7 B']], [], []]);
});

check('a file answered after another was opened, or after closing, changes nothing', async () => {
  const gate = held();
  const s = setup({ gates: { 'a.js': gate } });
  const first = s.opener.open('a.js');
  await settle();
  await s.opener.open('b.js');
  gate.release();
  await first;
  assert.deepStrictEqual([s.page.file.path, s.editor.value], ['b.js', 'text of b.js'], 'b.js shown under its own name');
  assert.deepStrictEqual(s.of('remember'), [['remember', 'b.js']]);
  const failing = held();
  const late = setup({ gates: { 'a.js': failing }, answers: { 'a.js': new Error('slow failure') } });
  const opening = late.opener.open('a.js');
  await settle();
  await late.opener.open('b.js');
  failing.release();
  await opening;
  assert.deepStrictEqual([late.page.file.path, late.of('toast')], ['b.js', []], 'a late failure for another file unsaid');
  const meta = held();
  const image = setup({ gates: { 'a.png': meta } });
  const previewing = image.opener.open('a.png');
  await settle();
  await image.opener.open('b.js');
  meta.release();
  await previewing;
  assert.deepStrictEqual([image.page.file.sha, image.of('size')], ['s1', [['size', '12 B']]], 'a late preview\u2019s sha and size not given to the next file');
  const shut = held();
  const closed = setup({ gates: { 'a.js': shut } });
  const reading = closed.opener.open('a.js');
  await settle();
  closed.opener.close();
  shut.release();
  await reading;
  assert.deepStrictEqual([closed.page.file, closed.editor.value], [null, 'Loading\u2026'], 'closed: nothing opened after');
});

check('the file asked for is the file open at once, so its placeholder is no edit of the last file', async () => {
  const gate = held();
  const s = setup({ file: { path: 'a.js', sha: 'old', dirty: true, original: 'a' }, gates: { 'b.js': gate } });
  const opening = s.opener.open('b.js');
  await settle();
  assert.deepStrictEqual([s.page.file, s.of('value')[0]], [{ path: 'b.js', sha: null, _loading: true }, ['value', 'Loading\u2026', 'b.js', true]]);
  assert.deepStrictEqual(s.of('commitable'), [['commitable', false]], 'nothing to commit while it is read');
  gate.release();
  await opening;
});

check('a file that cannot be read leaves no file open and nothing to commit', async () => {
  const s = setup({ file: { path: 'a.js', sha: 'old', dirty: true }, answers: { 'b.js': new Error('The file could not be read.') } });
  await s.opener.open('b.js');
  assert.deepStrictEqual([s.page.file, s.editor.value], [null, '']);
  assert.deepStrictEqual(s.log.slice(-2), [['value', '', null, null], ['toast', 'The file could not be read.', 'err']]);
  assert.deepStrictEqual(s.of('commitable'), [['commitable', false]], 'not committable from the moment it was asked for');
  const said = setup({ answers: { 'b.js': new Error('Not found') } });
  await said.opener.open('b.js');
  assert.deepStrictEqual(said.of('toast'), [['toast', 'Not found', 'err']], 'the server\u2019s own words');
  const quiet = setup({ answers: { 'b.js': new Error('') } });
  await quiet.opener.open('b.js');
  assert.deepStrictEqual(quiet.of('toast'), [['toast', 'The file could not be read.', 'err']]);
  const empty = setup({ answers: { 'e.txt': { sha: 'e', size: 0 } } });
  await empty.opener.open('e.txt');
  assert.deepStrictEqual([empty.editor.value, empty.page.file.original], ['', ''], 'an empty file is empty, not unread');
});

check('closing: no file open, the editor\u2019s frame put away, the route written once things settle', () => {
  const s = setup({ file: { path: 'a.js', sha: 's' } });
  s.opener.close();
  assert.deepStrictEqual(s.log, [['later', 0], ['route'], ['file', null], ['closed']]);
});

(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  if (failed) { console.error(`page file opener: ${failed} of ${checks.length} checks failed`); process.exit(1); }
  console.log(`page file opener: ${checks.length} checks passed`);
})();
