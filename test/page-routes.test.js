'use strict';

/*
 * The screens and the address, asked directly: which screen is in view and
 * how the next one arrives -- cross-faded or not, from its top, the rail at
 * once and the dock two frames later, the artwork mounted whichever way the
 * reader came (features/shell/pages.ts, pages-controller.ts) -- and the
 * address kept in step with the workbench: written as it moves, applied on
 * Back, Forward and links, and read at start-up (features/shell/route-sync.ts).
 */

const assert = require('assert');
const { NEBULA_VISUALS, visualFor, keepsAddress, crossFades, lean } = require('../apps/web/src/features/shell/pages.ts');
const { createPages, watchLean } = require('../apps/web/src/features/shell/pages-controller.ts');
const { createRouteSync, workbenchRoute, sameRepository, branchToTake } = require('../apps/web/src/features/shell/route-sync.ts');
const { parseRoute, formatRoute } = require('../apps/web/src/platform/router.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

/* ---- The screens, as what they are ---------------------------------------------------- */

check('which screens keep an address, own artwork, and cross-fade', () => {
  assert.deepStrictEqual(['work', 'findings', 'repos', 'overview', 'site', 'login'].map(keepsAddress), [true, true, false, false, false, false]);
  assert.deepStrictEqual([...visualFor('repos')], ['galaxy', '#gxHeroArt']);
  assert.strictEqual(visualFor('work'), null);
  assert.strictEqual(visualFor('constructor'), null, 'an inherited name owns no artwork');
  assert.deepStrictEqual(Object.keys(NEBULA_VISUALS), ['repos']);
  const all = { available: true, motion: true, layerLeaving: false, reducedMotion: false };
  assert.strictEqual(crossFades(all), true);
  for (const off of [{ available: false }, { motion: false }, { layerLeaving: true }, { reducedMotion: true }]) {
    assert.strictEqual(crossFades({ ...all, ...off }), false, JSON.stringify(off));
  }
});

check('the galaxy leans twelve degrees across and nine down, from its centre', () => {
  const box = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepStrictEqual({ ...lean(box, 200, 100) }, { ry: '0.00deg', rx: '0.00deg' });
  assert.deepStrictEqual({ ...lean(box, 300, 150) }, { ry: '6.00deg', rx: '-4.50deg' });
  assert.deepStrictEqual({ ...lean(box, 100, 50) }, { ry: '-6.00deg', rx: '4.50deg' });
  assert.deepStrictEqual({ ...lean({ left: 0, top: 0, width: 0, height: 0 }, 1, 1) }, { ry: '6.00deg', rx: '-4.50deg' }, 'a box with no size is a pixel wide');
});

/* ---- The screens at work ----------------------------------------------------------------- */

function pagesWorld(over = {}) {
  const log = [];
  const frames = [];
  const timers = [];
  const screen = name => ({ name, classes: new Set(name === 'alpha-access' ? ['active'] : []), region: name === 'work' ? { scrollTop: 90 } : null,
    get classList() { const c = this.classes; return { add: x => c.add(x), remove: x => c.delete(x) }; },
    querySelector(selector) { return selector === '.container' ? this.region : null; } });
  const screens = Object.fromEntries(['alpha-access', 'overview', 'repos', 'work', 'findings', 'login'].map(name => [name, screen(name)]));
  let transition = null;
  const deps = {
    screens: () => Object.values(screens),
    screen: name => screens[name] || null,
    activeTopbar: () => ('bar' in over ? over.bar : { offsetHeight: 57 }),
    setRootProperty: (name, value) => log.push(['root', name, value]),
    startViewTransition: over.api === false ? null : change => {
      log.push(['transition']);
      let finish;
      const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
      transition = { change, finish };
      return { ready: over.ready || Promise.resolve(), updateCallbackDone: done };
    },
    motion: () => over.motion !== false,
    layerLeaving: () => !!over.leaving,
    reducedMotion: () => !!over.reduced,
    scrollToTop: () => log.push(['scrollTop']),
    setTimeout: (run, ms) => { timers.push(run); log.push(['timeout', ms]); },
    requestAnimationFrame: run => { frames.push(run); return frames.length; },
    paintRail: name => log.push(['rail', name]),
    mountVisual: (kind, selector) => log.push(['visual', kind, selector]),
    clearAddress: () => log.push(['clearAddress']),
    paintDock: name => log.push(['dock', name])
  };
  const runFrames = () => { while (frames.length) frames.shift()(); };
  /* One frame: what was asked for before it runs; what those ask for waits for the next. */
  const runFrame = () => { for (const run of frames.splice(0)) run(); };
  return { pages: createPages(deps), log, screens, runFrames, runFrame, timers, run: () => { const t = transition; transition = null; t.change(); t.finish.resolve(); } };
}
const active = w => Object.values(w.screens).filter(s => s.classes.has('active')).map(s => s.name);

check('a screen arrives without a transition: shown alone, from its top, the rail at once and the dock two frames later', async () => {
  const w = pagesWorld({ motion: false });
  assert.strictEqual(w.pages.current(), 'alpha-access');
  await w.pages.show('work');
  assert.deepStrictEqual(active(w), ['work']);
  assert.strictEqual(w.screens.work.region.scrollTop, 0, 'its own scrolling region from the top too');
  assert.deepStrictEqual(w.log, [['timeout', 30], ['rail', 'work'], ['scrollTop']], 'the workbench keeps its address');
  assert.deepStrictEqual([w.pages.current(), w.pages.arrivals()], ['work', 1]);
  w.runFrame();
  assert(!w.log.some(e => e[0] === 'dock'), 'one frame later the new screen is not yet laid out');
  w.runFrame();
  assert.deepStrictEqual(w.log.at(-1), ['dock', 'work'], 'two frames later the dock is built for it');
  w.log.length = 0;
  await w.pages.show('repos');
  assert.deepStrictEqual(w.log, [['timeout', 30], ['rail', 'repos'], ['visual', 'galaxy', '#gxHeroArt'], ['scrollTop'], ['clearAddress']]);
  assert.deepStrictEqual(active(w), ['repos']);
});

check('the screen already in view is not brought in again, but its top bar is measured', async () => {
  const w = pagesWorld({ motion: false });
  await w.pages.show('overview');
  w.runFrames();
  w.log.length = 0;
  await w.pages.show('overview');
  assert.deepStrictEqual(w.log, [['timeout', 30]]);
  assert.strictEqual(w.pages.arrivals(), 1);
  w.timers[w.timers.length - 1]();
  assert(!w.log.some(e => e[0] === 'root'), 'measured once laid out, not at once');
  w.runFrame();
  assert.deepStrictEqual(w.log.at(-1), ['root', '--tbh', '57px']);
  const bare = pagesWorld({ motion: false, bar: null });
  bare.pages.measureTopbar();
  bare.runFrames();
  assert(!bare.log.some(e => e[0] === 'root'), 'a screen without a top bar measures nothing');
});

check('cross-faded, the change runs inside the transition and the arrival settles once it has', async () => {
  const w = pagesWorld();
  let settled = false;
  const shown = w.pages.show('overview').then(() => { settled = true; });
  assert.deepStrictEqual(active(w), ['alpha-access'], 'nothing changes before the old frame is captured');
  assert(w.log.some(e => e[0] === 'transition'));
  await null;
  assert.strictEqual(settled, false);
  w.run();
  await shown;
  assert.deepStrictEqual(active(w), ['overview']);
});

check('no transition while a layer leaves, for less motion, or without the API', async () => {
  for (const over of [{ leaving: true }, { reduced: true }, { api: false }, { motion: false }]) {
    const w = pagesWorld(over);
    await w.pages.show('repos');
    assert.deepStrictEqual([active(w), w.log.some(e => e[0] === 'transition')], [['repos'], false], JSON.stringify(over));
  }
});

check('a transition the browser skips still settles; only an abort is expected', async () => {
  const w = pagesWorld();
  const shown = w.pages.withTransition(() => {});
  w.run();
  await shown;
  const unexpected = [];
  const onUnhandled = reason => unexpected.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const aborted = Object.assign(new Error('skipped'), { name: 'AbortError' });
  const quiet = pagesWorld({ ready: Promise.reject(aborted) });
  const settledQuiet = quiet.pages.withTransition(() => {});
  quiet.run();
  await settledQuiet;
  const loud = pagesWorld({ ready: Promise.reject(new TypeError('broken')) });
  const settledLoud = loud.pages.withTransition(() => {});
  loud.run();
  await settledLoud;
  await new Promise(resolve => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  assert.deepStrictEqual(unexpected.map(e => e.name), ['TypeError'], 'an abort is expected and handled; anything else is not hidden');
});

check('the screen named by what replaced the screens', async () => {
  const w = pagesWorld({ motion: false });
  await w.pages.show('work');
  w.pages.setCurrent('alpha-access');
  assert.strictEqual(w.pages.current(), 'alpha-access');
  assert.strictEqual(w.pages.arrivals(), 1, 'naming is not arriving');
  w.log.length = 0;
  await w.pages.show('work');
  assert(w.log.some(e => e[0] === 'rail'), 'and the workbench can be brought back');
});

check('the galaxy leans on a desk, one frame per move, never with motion off, and rests when the pointer leaves', () => {
  const listeners = {};
  const props = new Map();
  const frames = [];
  let motionOff = false;
  watchLean({
    hero: { addEventListener: (type, fn) => { listeners[type] = fn; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
    art: { style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) } },
    motionOff: () => motionOff,
    requestAnimationFrame: run => { frames.push(run); return frames.length; }
  });
  listeners.pointermove({ clientX: 100, clientY: 0 });
  listeners.pointermove({ clientX: 0, clientY: 100 });
  assert.strictEqual(frames.length, 1, 'one frame per move at most');
  frames.shift()();
  assert.deepStrictEqual([...props], [['--gx-ry', '6.00deg'], ['--gx-rx', '4.50deg']]);
  motionOff = true;
  listeners.pointermove({ clientX: 50, clientY: 50 });
  assert.strictEqual(frames.length, 0);
  listeners.pointerleave();
  assert.strictEqual(props.size, 0);
});

/* ---- The address ---------------------------------------------------------------------------------- */

check('the workbench as the address names it, the same repository, and a branch to move to', () => {
  assert.deepStrictEqual({ ...workbenchRoute('work', { owner: 'acme', repo: 'demo', branch: 'main' }, 'files', 'src/a.js') }, { kind: 'workbench', owner: 'acme', repo: 'demo', branch: 'main', tab: 'files', file: 'src/a.js' });
  assert.strictEqual(workbenchRoute('work', { owner: 'acme', repo: 'demo', branch: 'main' }, 'editor', null).file, null);
  assert.strictEqual(workbenchRoute('repos', { owner: 'acme', repo: 'demo' }, 'editor', null), null);
  assert.strictEqual(workbenchRoute('work', null, 'editor', null), null);
  assert.strictEqual(workbenchRoute('work', { owner: 'acme', repo: '' }, 'editor', null), null);
  assert.strictEqual(sameRepository('work', { owner: 'Acme', repo: 'Demo' }, 'acme', 'DEMO'), true);
  assert.strictEqual(sameRepository('repos', { owner: 'acme', repo: 'demo' }, 'acme', 'demo'), false);
  assert.strictEqual(sameRepository('work', { owner: 'acme', repo: 'demo' }, 'acme', 'other'), false);
  assert.strictEqual(sameRepository('work', null, 'acme', 'demo'), false);
  assert.strictEqual(branchToTake('dev', 'main', ['main', 'dev']), true);
  assert.strictEqual(branchToTake('main', 'main', ['main', 'dev']), false);
  assert.strictEqual(branchToTake('gone', 'main', ['main', 'dev']), false);
  assert.strictEqual(branchToTake('', 'main', ['', 'main']), false);
  assert.strictEqual(branchToTake('undefined', undefined, ['undefined']), true, 'a branch named "undefined" is not the absence of one');
});

function routeWorld(over = {}) {
  const log = [];
  const world = {
    page: over.page || 'work', work: over.work === undefined ? { owner: 'acme', repo: 'demo', branch: 'main' } : over.work,
    tab: over.tab || 'editor', file: over.file || null, me: over.me === undefined ? {} : over.me, hash: over.hash || '#/acme/demo@main',
    branches: over.branches || ['main', 'dev'], offered: over.offered !== false
  };
  const deps = {
    page: () => world.page, work: () => world.work, tab: () => world.tab, file: () => world.file, signedIn: () => !!world.me,
    hash: () => world.hash,
    currentRoute: () => parseRoute(world.hash), parseRoute, formatRoute,
    writeRoute: (route, options) => { log.push(['write', formatRoute(route), !!(options && options.push)]); if (over.unchanged) return false; world.hash = formatRoute(route); return true; },
    findingsOffered: () => world.offered,
    showFindings: query => log.push(['findings', query]),
    openRepo: async (owner, repo) => { log.push(['open', owner, repo]); if (over.openThrows) throw new Error('down'); const opened = over.opened === undefined ? true : over.opened; if (opened) { world.page = 'work'; world.work = { owner, repo, branch: 'main' }; } return opened; },
    branches: () => world.branches,
    selectBranch: branch => { log.push(['select', branch]); world.work = { ...world.work, branch }; },
    startOnBranch: branch => { log.push(['start on', branch]); world.work = { ...world.work, branch }; },
    switchTab: tab => { log.push(['tab', tab]); if (over.tabThrows) throw new Error('refused'); world.tab = tab; },
    openFile: async path => { log.push(['file', path]); world.file = path; }
  };
  return { sync: createRouteSync(deps), log, world };
}

check('the address follows the workbench: a tab change pushed, anything else replaced, nothing off the workbench', () => {
  const w = routeWorld({ tab: 'files', file: 'README.md' });
  w.sync.save(true);
  w.sync.save();
  assert.deepStrictEqual(w.log, [['write', '#/acme/demo@main/files/README.md', true], ['write', '#/acme/demo@main/files/README.md', false]]);
  const off = routeWorld({ page: 'repos' });
  off.sync.save(true);
  assert.deepStrictEqual(off.log, []);
});

check('Back to an address the page wrote itself is not applied again', async () => {
  const w = routeWorld({ tab: 'files' });
  w.sync.save(true);
  w.log.length = 0;
  await w.sync.apply();
  assert.deepStrictEqual(w.log, []);
  const unchanged = routeWorld({ tab: 'files', unchanged: true, hash: '#/acme/demo@main/files' });
  unchanged.sync.save();
  unchanged.world.hash = '#/acme/demo@main/files';
  unchanged.log.length = 0;
  await unchanged.sync.apply();
  assert.deepStrictEqual(unchanged.log, [], 'the same tab: nothing to do');
  const wrote = routeWorld();
  wrote.sync.wrote({ kind: 'findings', query: '?severity=high' });
  wrote.world.hash = '#/findings?severity=high';
  await wrote.sync.apply();
  assert.deepStrictEqual(wrote.log, [], 'the inbox wrote its own filters');
});

check('Back on the same repository: the branch, the tab and the file it names, in that order', async () => {
  const w = routeWorld({ tab: 'editor' });
  w.world.hash = '#/acme/demo@dev/files/src/a.js';
  await w.sync.apply();
  assert.deepStrictEqual(w.log, [['select', 'dev'], ['tab', 'files'], ['file', 'src/a.js']]);
  const caseOnly = routeWorld();
  caseOnly.world.hash = '#/ACME/Demo@main/editor';
  await caseOnly.sync.apply();
  assert.deepStrictEqual(caseOnly.log, [], 'the same repository in other letters is the same repository');
  const open = routeWorld({ tab: 'editor', file: 'src/a.js' });
  open.world.hash = '#/acme/demo@main/files/src%2Fa.js';
  await open.sync.apply();
  assert.deepStrictEqual(open.log, [['tab', 'files']], 'the file it names is already open: not opened again');
  const missing = routeWorld();
  missing.world.hash = '#/acme/demo@gone/editor';
  await missing.sync.apply();
  assert.deepStrictEqual(missing.log, [], 'a branch the repository does not have is not taken');
});

check('Back to another repository opens it, at the branch, tab and file named, without pushing what it applies', async () => {
  const w = routeWorld();
  w.world.hash = '#/other/proj@dev/pulls/docs/x.md';
  w.world.branches = ['main', 'dev'];
  await w.sync.apply();
  assert.deepStrictEqual(w.log, [['open', 'other', 'proj'], ['start on', 'dev'], ['tab', 'pulls'], ['file', 'docs/x.md']]);
  w.log.length = 0;
  w.sync.save(true);
  assert.deepStrictEqual(w.log, [['write', '#/other/proj@dev/pulls/docs%2Fx.md', true]], 'applied and finished, a tab change is a step again');
});

check('nothing is pushed while an address is being applied', async () => {
  let release;
  const w = routeWorld();
  w.world.hash = '#/other/proj@main/editor';
  const opening = new Promise(resolve => { release = resolve; });
  const pending = createRouteSync({
    page: () => 'work', work: () => ({ owner: 'acme', repo: 'demo', branch: 'main' }), tab: () => 'files', file: () => null, signedIn: () => true,
    hash: () => '#/other/proj@main/editor', currentRoute: () => parseRoute('#/other/proj@main/editor'), parseRoute, formatRoute,
    writeRoute: (route, options) => { w.log.push(['write', !!(options && options.push)]); return true; },
    findingsOffered: () => true, showFindings: () => {}, openRepo: () => opening, branches: () => [], selectBranch: () => {}, startOnBranch: () => {},
    switchTab: () => {}, openFile: () => {}
  });
  const applying = pending.apply();
  pending.save(true);
  assert.deepStrictEqual(w.log, [['write', false]], 'a tab change made while applying replaces, never pushes');
  release(true);
  await applying;
  pending.save(true);
  assert.deepStrictEqual(w.log.at(-1), ['write', true]);
});

check('start-up\'s read and a navigation on their way at once: when both have ended, a tab change is a step again', async () => {
  const opens = [];
  const writes = [];
  let hash = '#/other/proj@main/editor';
  const sync = createRouteSync({
    page: () => 'work', work: () => ({ owner: 'acme', repo: 'demo', branch: 'main' }), tab: () => 'files', file: () => null, signedIn: () => true,
    hash: () => hash, currentRoute: () => parseRoute(hash), parseRoute, formatRoute,
    writeRoute: (route, options) => { writes.push(!!(options && options.push)); return true; },
    findingsOffered: () => true, showFindings: () => {}, openRepo: () => new Promise(resolve => opens.push(resolve)),
    branches: () => [], selectBranch: () => {}, startOnBranch: () => {}, switchTab: () => {}, openFile: () => {}
  });
  const navigating = sync.apply();
  hash = '#/third/one@main/editor';
  const starting = sync.restore();
  sync.save(true);
  assert.deepStrictEqual(writes, [false], 'while either is on its way, nothing is pushed');
  opens[0](true);
  await navigating;
  sync.save(true);
  assert.deepStrictEqual(writes, [false, false], 'start-up\'s read is still on its way');
  opens[1](true);
  await starting;
  sync.save(true);
  assert.deepStrictEqual(writes, [false, false, true], 'both ended: the flag is not left standing by the one that began second and ended last');
});

check('an address naming nothing, another screen\'s, or arriving signed out leaves everything as it was', async () => {
  for (const hash of ['#/nowhere', '', '#/acme/demo@main/%E0%A4%A']) {
    const w = routeWorld();
    w.world.hash = hash;
    await w.sync.apply();
    assert.deepStrictEqual(w.log, [], hash);
  }
  const out = routeWorld({ me: null });
  out.world.hash = '#/other/proj@main/editor';
  await out.sync.apply();
  assert.deepStrictEqual(out.log, []);
});

check('the inbox\'s address opens the inbox, when the session offers it', async () => {
  const w = routeWorld();
  w.world.hash = '#/findings?severity=high';
  await w.sync.apply();
  assert.deepStrictEqual(w.log, [['findings', '?severity=high']]);
  const refused = routeWorld({ offered: false });
  refused.world.hash = '#/findings?severity=high';
  await refused.sync.apply();
  assert.deepStrictEqual(refused.log, []);
  refused.world.hash = '#/findings?severity=low';
  assert.strictEqual(await refused.sync.restore(), false, 'start-up does not land on an inbox it cannot open');
});

check('start-up opens what the address names, and says whether it did', async () => {
  const w = routeWorld({ work: null, page: 'login', hash: '#/acme/demo@dev/governance' });
  assert.strictEqual(await w.sync.restore(), true);
  assert.deepStrictEqual(w.log, [['open', 'acme', 'demo'], ['start on', 'dev'], ['tab', 'governance']]);
  const editor = routeWorld({ work: null, page: 'login', hash: '#/acme/demo@main/editor/a.md' });
  assert.strictEqual(await editor.sync.restore(), true);
  assert.deepStrictEqual(editor.log, [['open', 'acme', 'demo'], ['file', 'a.md']], 'the editor is where it opens anyway');
  for (const [over, expected] of [[{ opened: false }, false], [{ opened: null }, true], [{ openThrows: true }, false]]) {
    const r = routeWorld({ work: null, page: 'login', hash: '#/acme/demo@main/files', ...over });
    assert.strictEqual(await r.sync.restore(), expected, JSON.stringify(over));
    assert.deepStrictEqual(r.log, [['open', 'acme', 'demo']]);
  }
  const nothing = routeWorld({ hash: '' });
  assert.strictEqual(await nothing.sync.restore(), false);
  const inbox = routeWorld({ hash: '#/findings' });
  assert.strictEqual(await inbox.sync.restore(), true);
  assert.deepStrictEqual(inbox.log, [['findings', '']]);
});

check('a tab the session refuses, applied from the address, leaves the workbench as it was', async () => {
  const w = routeWorld({ tabThrows: true });
  w.world.hash = '#/acme/demo@main/governance/x.md';
  await w.sync.apply();
  assert.deepStrictEqual(w.log, [['tab', 'governance']], 'and nothing after it');
  w.log.length = 0;
  w.sync.save(true);
  assert.deepStrictEqual(w.log[0][2], true, 'applying ended');
});

process.exitCode = 1;
(async () => {
  for (const [name, run] of checks) {
    try { await run(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  }
  console.log(`page routes tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
