'use strict';

/*
 * The workspace, asked directly (features/workbench/workspace.ts): every view
 * of the last repository cleared together; the tree read from the top with
 * its index let go of; the commits from their first page, read when shown;
 * Refresh reading the tool open again -- the file open only when it holds no
 * edit and is text -- and another branch drawing again the tools that belong
 * to a branch.
 */

const assert = require('assert');
const { createWorkspace } = require('../apps/web/src/features/workbench/workspace.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const TOOLS = ['pulls', 'issues', 'releases', 'actions', 'governance', 'safeguards', 'exposure', 'audit', 'neural'];
const BRANCHED = ['safeguards', 'audit', 'neural'];
const QUIET = ['compare', 'find', 'fix', 'read', 'again', 'upload', 'overview', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty'];

function setup(options = {}) {
  const log = [];
  const page = { tab: 'tab' in options ? options.tab : 'editor', file: options.file === undefined ? { path: 'src/a.js', binary: false, dirty: false } : options.file };
  const ws = createWorkspace({
    tab: () => page.tab,
    views: ['governance', 'exposure', 'audit', 'safeguards', 'neural'].map(name => () => log.push(['clear', name])),
    tree: { forgetIndex: () => log.push(['forget']), load: () => log.push(['tree']) },
    commits: { reset: () => log.push(['commits:reset']), load: () => log.push(['commits:load']) },
    reread: Object.fromEntries(TOOLS.map(name => [name, () => log.push(['reread', name])])),
    redraw: Object.fromEntries(BRANCHED.map(name => [name, () => log.push(['redraw', name])])),
    file: () => page.file,
    openFile: path => log.push(['open', path])
  });
  return { ws, log, page };
}

check('another repository clears every view of the last, each once and in order, asking nothing', () => {
  const s = setup();
  s.ws.resetViews();
  assert.deepStrictEqual(s.log, [['clear', 'governance'], ['clear', 'exposure'], ['clear', 'audit'], ['clear', 'safeguards'], ['clear', 'neural']]);
  const none = createWorkspace({ tab: () => 'editor', views: [] });
  assert.doesNotThrow(() => none.resetViews());
});

check('the tree is read from the top once its index of paths is let go of', () => {
  const s = setup();
  s.ws.reloadTree();
  assert.deepStrictEqual(s.log, [['forget'], ['tree']]);
});

check('the commits go back to their first page, and are read only while shown', () => {
  for (const tab of ['commits', 'editor', 'pulls', 'audit']) {
    const s = setup({ tab });
    s.ws.resetCommits();
    assert.deepStrictEqual(s.log, tab === 'commits' ? [['commits:reset'], ['commits:load']] : [['commits:reset']], tab);
  }
});

check('Refresh reads the tool open again, and only that one', () => {
  for (const tab of TOOLS) {
    const s = setup({ tab });
    s.ws.reloadView();
    assert.deepStrictEqual(s.log, [['reread', tab]], tab);
  }
  const commits = setup({ tab: 'commits' });
  commits.ws.reloadView();
  assert.deepStrictEqual(commits.log, [['commits:reset'], ['commits:load']]);
  for (const tab of QUIET) {
    const s = setup({ tab });
    s.ws.reloadView();
    assert.deepStrictEqual(s.log, [], `${tab} has nothing of its own to read`);
  }
});

check('Refresh opens the file again only when it holds no edit and is text', () => {
  const clean = setup();
  clean.ws.reloadView();
  assert.deepStrictEqual(clean.log, [['open', 'src/a.js']]);
  for (const file of [null, undefined, { path: 'a', dirty: true }, { path: 'a', binary: true }, { path: '' }, { path: 7 }, {}, 'src/a.js']) {
    const s = setup({ file: file === undefined ? null : file });
    s.ws.reloadView();
    assert.deepStrictEqual(s.log, [], JSON.stringify(file));
  }
  const elsewhere = setup({ tab: 'pulls' });
  elsewhere.ws.reloadView();
  assert.ok(!elsewhere.log.some(entry => entry[0] === 'open'), 'the file is read again only from the editor');
});

check('another branch draws again the tools that belong to a branch, and nothing else', () => {
  for (const tab of BRANCHED) {
    const s = setup({ tab });
    s.ws.branchChanged();
    assert.deepStrictEqual(s.log, [['redraw', tab]], tab);
  }
  for (const tab of ['editor', 'commits', 'pulls', 'issues', 'releases', 'actions', 'governance', 'exposure', ...QUIET]) {
    const s = setup({ tab });
    s.ws.branchChanged();
    assert.deepStrictEqual(s.log, [], tab);
  }
});

(async () => {
  let failed = 0;
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
  if (failed) process.exit(1);
  console.log(`page workspace: ${checks.length} checks passed`);
})();
