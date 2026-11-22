'use strict';

/*
 * The safety record and the locked paths, asked directly
 * (features/safeguards/protected-paths.ts, features/safeguards/safety-controller.ts):
 * the key a repository's locks are kept under, its list read under that key
 * alone, a path locked by its own entry or by a folder or pattern, the record
 * read, shown and changed through the server, and read-only taking New file
 * and Commit away and giving them back.
 */

const assert = require('assert');
const paths = require('../apps/web/src/features/safeguards/protected-paths.ts');
const { createSafety } = require('../apps/web/src/features/safeguards/safety-controller.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

check('a repository\u2019s locks are kept under its owner and name, and read under that key alone', () => {
  assert.strictEqual(paths.safetyKey({ owner: 'octo', repo: 'demo' }), 'octo/demo');
  for (const work of [null, undefined, {}, { owner: '', repo: 'x' }]) assert.strictEqual(paths.safetyKey(work), '', JSON.stringify(work));
  const record = { protected: { 'octo/demo': ['a.txt', 7, null, 'docs/'], 'octo/other': ['b.txt'], 'octo/text': 'a.txt' } };
  assert.deepStrictEqual(paths.protectedList(record, 'octo/demo'), ['a.txt', 'docs/'], 'only the paths written');
  assert.deepStrictEqual(paths.protectedList(record, 'octo/other'), ['b.txt']);
  assert.deepStrictEqual(paths.protectedList(record, 'octo/text'), [], 'a list that is not a list counts as none');
  assert.deepStrictEqual(paths.protectedList(record, 'octo/none'), []);
  assert.deepStrictEqual(paths.protectedList(record, ''), []);
  assert.deepStrictEqual(paths.protectedList({ protected: { '': ['x'] } }, ''), [], 'no repository, no locks');
  for (const safety of [null, {}, { protected: null }, { protected: 'x' }]) assert.deepStrictEqual(paths.protectedList(safety, 'octo/demo'), [], JSON.stringify(safety));
  assert.deepStrictEqual(paths.protectedList({ protected: { 'octo/demo': ['a'] } }, 'constructor'), [], 'a key is looked up as itself');
});

check('a path is locked by its own entry, or covered by a folder or a pattern', () => {
  const list = ['a.txt', 'docs', 'config/', '**/.env*', 'src/*.key', 'x?.md'];
  for (const [path, covered, exact] of [
    ['a.txt', true, true], ['/a.txt', true, true], ['docs/guide.md', true, false], ['docsite/x', false, false], ['config/app.yml', true, false],
    ['.env', true, false], ['deep/.env.local', true, false], ['src/id.key', true, false], ['src/deep/id.key', false, false], ['x1.md', true, false], ['x12.md', false, false],
    ['b.txt', false, false]
  ]) {
    assert.strictEqual(paths.isProtected(list, path), covered, `${path} covered`);
    assert.strictEqual(paths.isExactProtected(list, path), exact, `${path} exact`);
  }
  assert.strictEqual(paths.protectedPatternMatch('a(b)+c.txt', 'a(b)+c.txt'), true, 'a pattern\u2019s own characters are not a regular expression');
  assert.strictEqual(paths.protectedPatternMatch('a(b)*.txt', 'a(b)xyz.txt'), true);
  assert.strictEqual(paths.protectedPatternMatch('', 'a'), false);
  assert.strictEqual(paths.protectedPatternMatch('a', ''), false);
  assert.strictEqual(paths.protectedPatternMatch('\\\\dir\\\\*.txt', 'dir/x.txt'), true, 'backslashes read as slashes');
  assert.strictEqual(paths.protectedPatternMatch('dir//sub', '/dir/sub/x'), true, 'doubled and leading slashes read as one');
  assert.strictEqual(paths.protectedPatternMatch('src/**', 'src/a/b/c'), true);
  assert.strictEqual(paths.protectedPatternMatch('src/**/x', 'src/x'), true);
  assert.strictEqual(paths.protectedPatternMatch('src/*/', 'src/a/b'), true, 'a folder pattern covers what is beneath');
  assert.strictEqual(paths.protectedPatternMatch('a?b', 'a/b'), false, 'a question mark is one character within a folder');
  assert.strictEqual(paths.protectedPatternMatch('src/*.key', 'src/id.key.bak'), false, 'a pattern reads to the end of the path');
});

function setup({ safety = null, changed = false, missing = [], answer, failure } = {}) {
  const log = [];
  const page = { safety, work: { owner: 'octo', repo: 'demo' } };
  const nodes = {};
  for (const id of ['#roChip', '#freezeChip', '#newFileBtn', '#commitFileBtn']) if (!missing.includes(id)) nodes[id] = { hidden: false, disabled: false };
  const body = { classes: new Set(), classList: { toggle: (name, on) => { if (on) body.classes.add(name); else body.classes.delete(name); } } };
  const x = createSafety({
    api: async (path, options) => { log.push(['api', path, options === undefined ? null : options]); if (failure) throw failure; return typeof answer === 'function' ? answer(options) : answer; },
    safety: () => page.safety,
    setSafety: value => { page.safety = value; log.push(['set']); },
    work: () => page.work,
    toast: (message, kind) => log.push(['toast', message, kind]),
    body: () => body,
    $: selector => nodes[selector] || null,
    fileChanged: () => changed,
    openSafeguards: () => log.push(['safeguards'])
  });
  return { x, log, page, nodes, body };
}

check('read-only takes New file and Commit away and gives them back, and the chips say what is on', () => {
  const on = setup({ safety: { readOnly: true, freezeSync: true }, changed: true });
  on.x.apply();
  assert.ok(on.body.classes.has('read-only'));
  assert.deepStrictEqual([on.nodes['#roChip'].hidden, on.nodes['#freezeChip'].hidden, on.nodes['#newFileBtn'].disabled, on.nodes['#commitFileBtn'].disabled], [false, false, true, true]);
  on.page.safety = { readOnly: false, freezeSync: false };
  on.x.apply();
  assert.ok(!on.body.classes.has('read-only'));
  assert.deepStrictEqual([on.nodes['#roChip'].hidden, on.nodes['#freezeChip'].hidden, on.nodes['#newFileBtn'].disabled, on.nodes['#commitFileBtn'].disabled], [true, true, false, false],
    'New file back, and Commit back for a file with changes');
  const clean = setup({ safety: { readOnly: false }, changed: false });
  clean.nodes['#commitFileBtn'].disabled = false;
  clean.x.apply();
  assert.strictEqual(clean.nodes['#commitFileBtn'].disabled, true, 'nothing to commit, nothing to press');
  const loose = setup({ safety: { readOnly: 1 } });
  loose.x.apply();
  assert.ok(loose.body.classes.has('read-only'), 'any read-only the record states');
  const bare = setup({ safety: null, missing: ['#roChip', '#freezeChip', '#newFileBtn', '#commitFileBtn'] });
  assert.doesNotThrow(() => bare.x.apply());
  assert.ok(!bare.body.classes.has('read-only'));
});

check('the record is read and shown; a failure keeps the one held, or one with nothing on', async () => {
  const fresh = setup({ answer: { readOnly: true, protected: {} } });
  await fresh.x.refresh();
  assert.deepStrictEqual(fresh.log, [['api', '/api/safety', null], ['set']]);
  assert.ok(fresh.body.classes.has('read-only'), 'shown once read');
  const held = { readOnly: true };
  const kept = setup({ safety: held, failure: new Error('down') });
  await kept.x.refresh();
  assert.strictEqual(kept.page.safety, held);
  assert.ok(kept.body.classes.has('read-only'));
  const none = setup({ failure: new Error('down') });
  await none.x.refresh();
  assert.deepStrictEqual(none.page.safety, { readOnly: false, freezeSync: false, protected: {} });
});

check('a change is sent, kept and shown once the server has it; a refusal is said and changes nothing', async () => {
  const ok = setup({ answer: options => ({ readOnly: options.body.readOnly, protected: {} }) });
  assert.strictEqual(await ok.x.set({ readOnly: true }), true);
  assert.deepStrictEqual(ok.log[0], ['api', '/api/safety', { method: 'POST', body: { readOnly: true } }]);
  assert.ok(ok.body.classes.has('read-only'));
  const held = { readOnly: false };
  const refused = setup({ safety: held, failure: Object.assign(new Error('Global safety changes require an unscoped deployment'), { code: 'X' }) });
  assert.strictEqual(await refused.x.set({ readOnly: true }), false);
  assert.strictEqual(refused.page.safety, held);
  assert.deepStrictEqual(refused.log.at(-1), ['toast', 'Global safety changes require an unscoped deployment', 'err']);
  assert.ok(!refused.body.classes.has('read-only'));
});

check('a file is locked and unlocked by its own entry; one covered by a folder or pattern is sent to Safeguards', async () => {
  const record = { protected: { 'octo/demo': ['a.txt', 'docs/'] } };
  const lock = setup({ safety: record, answer: record });
  await lock.x.toggleProtect('b.txt');
  assert.deepStrictEqual(lock.log.filter(e => e[0] !== 'set'), [['api', '/api/safety', { method: 'POST', body: { protect: { repo: 'octo/demo', path: 'b.txt', on: true } } }], ['toast', 'b.txt is now protected', 'ok']]);
  const unlock = setup({ safety: record, answer: record });
  await unlock.x.toggleProtect('a.txt');
  assert.deepStrictEqual(unlock.log.filter(e => e[0] !== 'set'), [['api', '/api/safety', { method: 'POST', body: { protect: { repo: 'octo/demo', path: 'a.txt', on: false } } }], ['toast', 'a.txt unlocked', 'ok']]);
  const covered = setup({ safety: record });
  await covered.x.toggleProtect('docs/guide.md');
  assert.deepStrictEqual(covered.log, [['toast', 'docs/guide.md is protected by a wildcard or folder policy. Remove that policy in Safeguards.', 'err'], ['safeguards']]);
  const refused = setup({ safety: record, failure: new Error('No') });
  await refused.x.toggleProtect('b.txt');
  assert.deepStrictEqual(refused.log.filter(e => e[0] === 'toast'), [['toast', 'No', 'err']], 'no success said for a refusal');
  assert.deepStrictEqual([covered.x.key(), covered.x.list(), covered.x.isProtected('docs/x'), covered.x.isExactProtected('docs/x'), covered.x.isExactProtected('a.txt')],
    ['octo/demo', ['a.txt', 'docs/'], true, false, true]);
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
  console.log(`page safety: ${checks.length} checks passed`);
})();
