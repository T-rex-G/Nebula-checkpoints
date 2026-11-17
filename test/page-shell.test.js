'use strict';

/*
 * The page's chrome, asked directly: the rail -- which screens it stands
 * beside, the entry it marks, its narrowed titles, Magnetar Sec's fold, the
 * reader in its foot, the drawer and the drag that closes it
 * (features/shell/rail.ts, rail-controller.ts) -- and the floating action:
 * what it carries off a screen's bar, its menu, and stepping aside while the
 * reader reads (features/shell/floating-actions.ts, -controller.ts).
 */

const assert = require('assert');
const railModel = require('../apps/web/src/features/shell/rail.ts');
const { createRail, SECURITY_FOLD_KEY } = require('../apps/web/src/features/shell/rail-controller.ts');
const dockModel = require('../apps/web/src/features/shell/floating-actions.ts');
const { createFloatingActions } = require('../apps/web/src/features/shell/floating-actions-controller.ts');

const { currentEntry, entryTitle, foldView, railUser, dragAxis, dragOffset, dragCloses, RAIL_SCREENS, WIDE_RAIL, isRepositoryTool } = railModel;
const { dockAction, accessibleName, placedElsewhere, dockFor, retracted, DOCK_TOP, DOCK_JITTER } = dockModel;
const checks = [];
const check = (name, run) => checks.push([name, run]);

/* ---- The rail, as what it shows ---------------------------------------------------------- */

check('the screens the rail stands beside, and the entry it marks', () => {
  assert.deepStrictEqual([...RAIL_SCREENS], ['overview', 'repos', 'work', 'site', 'findings']);
  assert.strictEqual(currentEntry('work', 'tab-audit'), 'audit', 'a promoted tool in view is the current entry');
  assert.strictEqual(currentEntry('work', 'tab-editor'), 'work');
  assert.strictEqual(currentEntry('repos', 'tab-audit'), 'repos', 'only on the workbench');
  assert.strictEqual(currentEntry('work', 'constructor'), 'work', 'an inherited name is no tab');
  assert(['neural', 'governance', 'exposure', 'audit', 'safeguards'].every(isRepositoryTool) && !isRepositoryTool('work') && !isRepositoryTool('toString'));
  assert.strictEqual(WIDE_RAIL, 1140);
});

check('narrowed, an entry is named where a pointer can reach it', () => {
  assert.strictEqual(entryTitle('Audit', 'Code findings', true), 'Audit — Code findings');
  assert.strictEqual(entryTitle('Overview', '', true), 'Overview');
  assert.strictEqual(entryTitle('Audit', 'Code findings', false), null);
});

check('Magnetar Sec folded, open, and on a rail narrowed to marks', () => {
  assert.deepStrictEqual({ ...foldView(false, false, 6) }, { inert: true, tabIndex: 0, badge: '6', label: 'Magnetar Sec, 6 security tools' });
  assert.deepStrictEqual({ ...foldView(true, false, 1) }, { inert: false, tabIndex: 0, badge: '1', label: 'Magnetar Sec, 1 security tool' });
  assert.deepStrictEqual({ ...foldView(false, true, 5) }, { inert: false, tabIndex: -1, badge: '5', label: 'Magnetar Sec, 5 security tools' }, 'the marks are the only way to the tools');
});

check('the reader in the rail\'s foot', () => {
  assert.deepStrictEqual({ ...railUser({ name: ' octo cat', login: 'octo' }) }, { hidden: false, initial: 'O', name: ' octo cat', sub: '@octo' });
  assert.deepStrictEqual({ ...railUser({ login: 'mona' }) }, { hidden: false, initial: 'M', name: 'mona', sub: '@mona' });
  assert.deepStrictEqual({ ...railUser({ name: 'Tester' }) }, { hidden: false, initial: 'T', name: 'Tester', sub: '' });
  assert.strictEqual(railUser(null).hidden, true);
  assert.strictEqual(railUser({ name: '', login: '' }).hidden, true);
});

check('a drag on the drawer: decided past eight pixels, only ever left, closing past a third or on a flick', () => {
  assert.strictEqual(dragAxis(5, 3, null), null);
  assert.strictEqual(dragAxis(-9, 3, null), true);
  assert.strictEqual(dragAxis(3, 12, null), false);
  assert.strictEqual(dragAxis(-40, 1, false), false, 'once decided it stays decided');
  assert.strictEqual(dragOffset(30), 0);
  assert.strictEqual(dragOffset(-30), -30);
  assert.strictEqual(dragCloses(-101, 2000, 300), true, 'past a third');
  assert.strictEqual(dragCloses(-99, 2000, 300), false);
  assert.strictEqual(dragCloses(-30, 40, 300), true, 'a flick');
  assert.strictEqual(dragCloses(-20, 10, 300), false, 'too short to be a flick');
  assert.strictEqual(dragCloses(-30, 0, 300), true, 'an instant is a millisecond');
});

/* ---- The rail at work ------------------------------------------------------------------- */

function node(extra = {}) {
  const attributes = new Map();
  return {
    hidden: false, title: '', tabIndex: 0, inert: false, dataset: {}, textContent: '', focused: null,
    style: { transform: '' },
    classes: new Set(),
    get classList() { const self = this; return { add: c => self.classes.add(c), remove: c => self.classes.delete(c), contains: c => self.classes.has(c), toggle: (c, on) => { if (on) self.classes.add(c); else self.classes.delete(c); return on; } }; },
    setAttribute(name, value) { attributes.set(name, String(value)); if (name === 'title') this.title = String(value); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); if (name === 'title') this.title = ''; },
    hasAttribute(name) { return attributes.has(name); },
    focus(options) { this.focused = options || {}; },
    getBoundingClientRect: () => ({ width: 300 }),
    ...extra
  };
}

function railWorld(over = {}) {
  const log = [];
  const entry = (rail, name, sub = '', hiddenAncestor = false) => node({
    dataset: { rail },
    querySelector: selector => (selector === '.nv-rail-t' ? { textContent: ` ${name} ` } : selector === '.nv-rail-d' ? (sub ? { textContent: sub } : null) : null),
    closest: selector => (selector === '[hidden]' && hiddenAncestor ? {} : null)
  });
  const tools = [entry('neural', 'Neural'), entry('governance', 'Governance'), entry('exposure', 'Exposure', '', true), entry('audit', 'Audit', 'Code findings'), entry('safeguards', 'Safeguards')];
  const entries = [entry('overview', 'Overview', 'Your day'), entry('repos', 'Repositories'), entry('work', 'Workspace'), ...tools];
  const fold = node({ dataset: { open: 'true' }, querySelector: selector => (selector === '.nv-rail-item[aria-current="page"]' ? tools.find(t => t.getAttribute('aria-current') === 'page') || null : null) });
  const badge = { textContent: '' };
  const head = node({ querySelector: selector => (selector === '.nv-rail-group-n' ? badge : null) });
  const body = node();
  const toggle = node();
  const rail = node({ hidden: true });
  const scrim = { name: 'scrim' };
  const buttons = [node(), node()];
  const foot = node({ hidden: true });
  const texts = { initial: { textContent: '' }, name: { textContent: '' }, sub: { textContent: '' } };
  const store = new Map(Object.entries(over.stored || {}));
  let width = over.width || 1300;
  let clock = 0;
  const timers = [];
  const deps = {
    body, collapseToggle: () => toggle, entries: () => entries, securityEntries: () => tools, fold: () => fold, foldHead: () => head, rail: () => rail,
    scrim: () => scrim, menuButtons: () => buttons, user: () => foot, userText: part => texts[part],
    storage: () => { if (over.blocked) throw new Error('blocked'); return { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { log.push(['keep', k, v]); store.set(k, v); } }; },
    viewportWidth: () => width,
    openOverlay: element => log.push(['open', element.name]),
    closeOverlay: (element, settled) => { log.push(['close', element.name]); if (settled) settled(); },
    activeTab: () => over.tab || '',
    me: () => ('me' in over ? over.me : { name: 'Tester', login: 'tester' }),
    now: () => clock,
    attached: target => target !== over.detached,
    setTimeout: (run, ms) => { timers.push([run, ms]); return timers.length; },
    clearTimeout: id => log.push(['clear', id])
  };
  return { rail: createRail(deps), log, body, toggle, entries, tools, fold, head, badge, railEl: rail, buttons, foot, texts, store, timers, setWidth: w => { width = w; }, tick: ms => { clock += ms; } };
}

check('narrowed and widened: the body says which, the toggle says what it will do, entries are titled, and it is kept', () => {
  const w = railWorld();
  w.rail.setCollapsed(true);
  assert.strictEqual(w.body.dataset.rail, 'collapsed');
  assert.deepStrictEqual([w.toggle.getAttribute('aria-expanded'), w.toggle.getAttribute('aria-label')], ['false', 'Expand the sidebar']);
  assert.deepStrictEqual(w.entries.map(e => e.title), ['Overview — Your day', 'Repositories', 'Workspace', 'Neural', 'Governance', 'Exposure', 'Audit — Code findings', 'Safeguards']);
  assert.strictEqual(w.store.get('nv_rail_collapsed'), '1');
  assert.strictEqual(w.fold.inert, false, 'narrowed at the wide width, the fold\'s marks are the way to the tools');
  w.rail.toggleCollapsed();
  assert.strictEqual(w.body.dataset.rail, 'expanded');
  assert.deepStrictEqual([w.toggle.getAttribute('aria-expanded'), w.toggle.getAttribute('aria-label')], ['true', 'Collapse the sidebar']);
  assert(w.entries.every(e => e.title === '' && !e.hasAttribute('title')));
  assert.strictEqual(w.store.get('nv_rail_collapsed'), '0');
});

check('Magnetar Sec: clipped while it moves, its count of shown tools, its name, and kept only when the reader chose', () => {
  const w = railWorld();
  w.rail.setSecurityFold(false);
  assert.deepStrictEqual([w.fold.dataset.open, w.fold.dataset.moving, w.fold.inert, w.head.getAttribute('aria-expanded'), w.head.tabIndex], ['false', '', true, 'false', 0]);
  assert.strictEqual(w.badge.textContent, '4', 'a tool inside a hidden part is not counted');
  assert.strictEqual(w.head.getAttribute('aria-label'), 'Magnetar Sec, 4 security tools');
  assert.strictEqual(w.store.get(SECURITY_FOLD_KEY), '0');
  assert.strictEqual(w.timers.length, 1);
  assert.strictEqual(w.timers[0][1], 480);
  w.timers[0][0]();
  assert(!('moving' in w.fold.dataset), 'at rest it is not clipped');
  w.rail.setSecurityFold(false, { remember: false });
  assert.strictEqual(w.timers.length, 1, 'no move, no clip');
  w.tools[1].hidden = true;
  w.rail.toggleSecurityFold();
  assert.deepStrictEqual([w.fold.dataset.open, w.badge.textContent, w.head.getAttribute('aria-label')], ['true', '3', 'Magnetar Sec, 3 security tools']);
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'clear').length, 2, 'a move clears the timer of the one before');
  w.fold.dataset.moving = '';
  w.rail.foldSettled({ target: 1, currentTarget: 2, propertyName: 'grid-template-rows' });
  w.rail.foldSettled({ target: 1, currentTarget: 1, propertyName: 'opacity' });
  assert('moving' in w.fold.dataset, 'another element\'s or another property\'s end is not the fold at rest');
  w.rail.foldSettled({ target: 1, currentTarget: 1, propertyName: 'grid-template-rows' });
  assert(!('moving' in w.fold.dataset));
});

check('kept preferences come back: the fold, then the width', () => {
  const w = railWorld({ stored: { [SECURITY_FOLD_KEY]: '0', nv_rail_collapsed: '1' } });
  w.rail.restore();
  assert.deepStrictEqual([w.fold.dataset.open, w.body.dataset.rail, w.fold.inert], ['false', 'collapsed', false]);
  assert(!w.log.some(e => e[0] === 'keep' && e[1] === SECURITY_FOLD_KEY), 'reading the fold back does not write it');
  const fresh = railWorld();
  fresh.rail.restore();
  assert.deepStrictEqual([fresh.fold.dataset.open, fresh.body.dataset.rail], ['true', 'expanded'], 'nothing kept: open and wide');
  const blocked = railWorld({ blocked: true });
  blocked.rail.restore();
  blocked.rail.setCollapsed(true);
  blocked.rail.setSecurityFold(false);
  assert.deepStrictEqual([blocked.fold.dataset.open, blocked.body.dataset.rail], ['false', 'collapsed'], 'storage refused: the rail still changes');
});

check('the rail for the screen in view: shown or hidden, the current entry marked, its fold opened, the reader in its foot', () => {
  const w = railWorld({ tab: 'tab-audit' });
  w.rail.setSecurityFold(false, { remember: false });
  w.rail.paint('work');
  assert.strictEqual(w.railEl.hidden, false);
  assert.deepStrictEqual(w.entries.map(e => e.getAttribute('aria-current')), [null, null, null, null, null, null, 'page', null]);
  assert.strictEqual(w.fold.dataset.open, 'true', 'the current entry is never folded away');
  assert.deepStrictEqual([w.foot.hidden, w.texts.initial.textContent, w.texts.name.textContent, w.texts.sub.textContent], [false, 'T', 'Tester', '@tester']);
  w.rail.paint('repos');
  assert.deepStrictEqual(w.entries.map(e => e.getAttribute('aria-current')), [null, 'page', null, null, null, null, null, null]);
  w.rail.paint('alpha-access');
  assert.strictEqual(w.railEl.hidden, true);
  const nobody = railWorld({ me: null });
  nobody.rail.paint('overview');
  assert.deepStrictEqual([nobody.foot.hidden, nobody.texts.name.textContent], [true, '']);
});

check('the drawer: opened from a bar, focus to its first entry, closed back to that bar', () => {
  const opener = node();
  const w = railWorld({ width: 800 });
  w.rail.setMenu(true, opener);
  assert(w.body.classes.has('nav-open') && !w.body.classes.has('nav-closing'));
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'open'), [['open', 'scrim']]);
  assert(w.buttons.every(b => b.getAttribute('aria-expanded') === 'true'));
  assert.deepStrictEqual(w.entries[0].focused, { preventScroll: true });
  assert.strictEqual(w.rail.menuOpen(), true);
  w.rail.closeMenu();
  assert(!w.body.classes.has('nav-open'));
  assert(!w.body.classes.has('nav-closing'), 'lifted once the scrim has gone');
  assert(w.buttons.every(b => b.getAttribute('aria-expanded') === 'false'));
  assert.deepStrictEqual(opener.focused, {});
  w.rail.closeMenu();
  assert.strictEqual(w.log.filter(e => e[0] === 'close').length, 1, 'closing a closed drawer does nothing');
  const gone = node();
  const v = railWorld({ width: 800, detached: gone });
  v.rail.setMenu(true, gone);
  v.rail.setMenu(false);
  assert.strictEqual(gone.focused, null, 'an opener no longer in the page is not focused');
});

check('the drawer stays laid out as one while it leaves, and only when it was open', () => {
  const body = node();
  let settle = null;
  const rail = createRail({
    body, collapseToggle: () => null, entries: () => [], securityEntries: () => [], fold: () => null, foldHead: () => null, rail: () => null,
    scrim: () => ({}), menuButtons: () => [], user: () => null, userText: () => null, storage: () => null, viewportWidth: () => 800,
    openOverlay: () => {}, closeOverlay: (element, done) => { settle = done; }, activeTab: () => '', me: () => null, now: () => 0,
    attached: () => true, setTimeout: () => 0, clearTimeout: () => {}
  });
  rail.setMenu(true, null);
  rail.setMenu(false);
  assert(body.classes.has('nav-closing') && !body.classes.has('nav-open'), 'carried while the exit runs');
  settle();
  assert(!body.classes.has('nav-closing'), 'and lifted when it has settled');
  rail.setMenu(false);
  assert(!body.classes.has('nav-closing'), 'never put on when nothing was open');
});

check('a drag closes the drawer past a third or on a flick, follows the finger only left, and leaves a scroll alone', () => {
  const w = railWorld({ width: 800 });
  w.rail.dragStart([{ clientX: 200, clientY: 100 }]);
  w.rail.dragMove({ clientX: 210, clientY: 100 });
  assert.strictEqual(w.railEl.style.transform, '', 'nothing to follow before the drawer is open');
  w.rail.setMenu(true, null);
  w.rail.dragStart([{ clientX: 200, clientY: 100 }, { clientX: 0, clientY: 0 }]);
  w.rail.dragMove({ clientX: 100, clientY: 100 });
  assert.strictEqual(w.railEl.style.transform, '', 'two fingers are not a drag');
  w.rail.dragStart([{ clientX: 200, clientY: 100 }]);
  w.rail.dragMove({ clientX: 230, clientY: 102 });
  assert.deepStrictEqual([w.railEl.style.transform, w.railEl.classes.has('is-dragging')], ['translateX(0px)', true], 'a drag right holds it in place');
  w.rail.dragMove({ clientX: 150, clientY: 102 });
  assert.strictEqual(w.railEl.style.transform, 'translateX(-50px)');
  w.tick(1000);
  w.rail.dragEnd();
  assert.deepStrictEqual([w.railEl.style.transform, w.railEl.classes.has('is-dragging'), w.rail.menuOpen()], ['', false, true], 'a slow sixth of the way springs back');
  w.rail.dragStart([{ clientX: 200, clientY: 100 }]);
  w.rail.dragMove({ clientX: 80, clientY: 100 });
  w.tick(1000);
  w.rail.dragEnd();
  assert.strictEqual(w.rail.menuOpen(), false, 'past a third it closes');
  w.rail.setMenu(true, null);
  w.rail.dragStart([{ clientX: 200, clientY: 100 }]);
  w.rail.dragMove({ clientX: 170, clientY: 100 });
  w.tick(40);
  w.rail.dragEnd();
  assert.strictEqual(w.rail.menuOpen(), false, 'a flick closes it');
  w.rail.setMenu(true, null);
  w.rail.dragStart([{ clientX: 200, clientY: 100 }]);
  w.rail.dragMove({ clientX: 195, clientY: 40 });
  w.rail.dragMove({ clientX: 20, clientY: 40 });
  assert.deepStrictEqual([w.railEl.style.transform, w.railEl.classes.has('is-dragging')], ['', false], 'decided vertical, it never follows the finger sideways');
  w.rail.dragEnd();
  assert.deepStrictEqual([w.railEl.style.transform, w.rail.menuOpen()], ['', true], 'a scroll of the list is left alone');
});

check('Escape and a wider window close the drawer; Escape with it closed is not used', () => {
  const w = railWorld({ width: 800 });
  assert.strictEqual(w.rail.onKey('Escape'), false);
  w.rail.setMenu(true, null);
  assert.strictEqual(w.rail.onKey('Enter'), false);
  assert.strictEqual(w.rail.onKey('Escape'), true);
  assert.strictEqual(w.rail.menuOpen(), false);
  w.rail.setMenu(true, null);
  w.rail.onResize();
  assert.strictEqual(w.rail.menuOpen(), true, 'still narrow');
  w.setWidth(1140);
  w.rail.onResize();
  assert.strictEqual(w.rail.menuOpen(), false);
});

check('a window crossing the breakpoint lays the fold out again: marks shown wide are reachable, tools folded narrow are not', () => {
  const w = railWorld({ width: 1000, stored: { nv_rail_collapsed: '1', [SECURITY_FOLD_KEY]: '0' } });
  w.rail.restore();
  assert.deepStrictEqual([w.fold.inert, w.head.tabIndex], [true, 0], 'narrow: a drawer with its names, the fold closed');
  w.setWidth(1300);
  w.rail.onResize();
  assert.deepStrictEqual([w.fold.inert, w.head.tabIndex, w.fold.dataset.open], [false, -1, 'false'], 'wide and narrowed: the marks are the way to the tools');
  w.setWidth(900);
  w.rail.onResize();
  assert.deepStrictEqual([w.fold.inert, w.head.tabIndex], [true, 0], 'narrow again: folded tools out of the tab order, the heading back in it');
  const clips = w.timers.length;
  w.setWidth(950);
  w.rail.onResize();
  assert.strictEqual(w.timers.length, clips, 'a resize that crosses nothing changes nothing');
  assert(!w.log.some(e => e[0] === 'keep' && e[1] === SECURITY_FOLD_KEY), 'and a resize is not the reader\'s choice');
});

/* ---- The floating action ----------------------------------------------------------------- */

check('what the dock knows of a bar control: its action, its name', () => {
  assert.deepStrictEqual(['settingsBtnRepos', 'settingsBtnWork', 'paletteBtn', 'paletteBtnX', 'logoutBtn', 'repoSettingsBtn', 'xsettingsBtn'].map(dockAction), ['settings', 'settings', 'palette', '', '', '', '']);
  const named = (label, text) => ({ getAttribute: name => (name === 'aria-label' ? label : null), textContent: text });
  assert.strictEqual(accessibleName(named(null, '  Command\n palette ')), 'Command palette');
  assert.strictEqual(accessibleName(named('Settings', 'ignored')), 'Settings');
  assert.strictEqual(accessibleName(named('', null)), '');
});

function control(id, label, { shown = true, feature, svg = true } = {}) {
  const clicks = [];
  return {
    id, offsetParent: shown ? {} : null, dataset: feature ? { feature } : {}, clicks,
    getAttribute: name => (name === 'aria-label' ? label : null), textContent: label,
    contains: other => other === this,
    querySelector: selector => (selector === 'svg' && svg ? svgNode() : null),
    click() { clicks.push(id); }
  };
}
function svgNode() {
  const attributes = new Map([['width', '16'], ['height', '16'], ['class', 'x']]);
  const self = { attributes, setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k), getAttribute: k => attributes.get(k) ?? null, appendChild() {} };
  self.cloneNode = () => { const copy = svgNode(); copy.attributes.clear(); for (const [k, v] of attributes) copy.attributes.set(k, v); return copy; };
  return self;
}
function screen(dropped, elsewhere = []) {
  return {
    querySelector: selector => (selector === '.topbar' ? { querySelectorAll: s => (s === 'button.hide-sm' ? dropped : []) } : null),
    querySelectorAll: selector => (selector === 'button, a[href]' ? [...dropped, ...elsewhere] : [])
  };
}

check('the dock carries Settings and the palette the bar dropped, in that order, unless the screen offers them elsewhere', () => {
  const palette = control('paletteBtn', 'Command palette');
  const settings = control('settingsBtnWork', 'Settings');
  const logout = control('logoutBtn', 'Sign out');
  const found = dockFor('work', screen([palette, logout, settings]));
  assert.deepStrictEqual({ label: found.label, items: found.items.map(item => [item.control.id, item.label]) }, { label: 'Workspace actions', items: [['settingsBtnWork', 'Settings'], ['paletteBtn', 'Command palette']] });
  assert.strictEqual(dockFor('repos', screen([settings], [control('other', 'Settings')])), null, 'the same action shown elsewhere is placed');
  assert.strictEqual(dockFor('repos', screen([settings], [control('other', 'Settings', { shown: false })])).items.length, 1, 'a hidden copy is not a place');
  assert.strictEqual(dockFor('site', screen([settings])).label, 'Actions');
  assert.strictEqual(dockFor('repos', screen([control('paletteBtn', '  ')])), null, 'a control with no name is not offered');
  assert.strictEqual(dockFor('repos', null), null);
  assert.strictEqual(dockFor('repos', { querySelector: () => null, querySelectorAll: () => [] }), null);
  const outer = control('settingsBtnRepos', 'Settings');
  const inner = control('inner', 'Settings');
  outer.contains = other => other === inner;
  assert.strictEqual(placedElsewhere(screen([outer], [inner]), outer, 'Settings'), false, 'a part of the control is not elsewhere');
});

check('the dock steps aside reading down, returns reading up, near the top and with its menu open', () => {
  assert.strictEqual(retracted(500, 400, false), true);
  assert.strictEqual(retracted(300, 400, false), false);
  assert.strictEqual(retracted(400 + DOCK_JITTER, 400, false), null, 'six pixels is jitter');
  assert.strictEqual(retracted(400 - DOCK_JITTER, 400, false), null);
  assert.strictEqual(retracted(DOCK_TOP - 1, 0, false), false);
  assert.strictEqual(retracted(DOCK_TOP, 0, false), true);
  assert.strictEqual(retracted(900, 100, true), false);
});

function dockWorld(over = {}) {
  const log = [];
  const dock = node({ offsetParent: over.dockHidden ? null : {}, contains: target => target === 'dock' });
  const items = [];
  let open = false;
  const menu = {
    get hidden() { return !open; }, innerHTML: 'old', attributes: new Map(),
    setAttribute(k, v) { this.attributes.set(k, v); }, contains: target => target === 'menu' || target === 'entry',
    appendChild: child => items.push(child),
    querySelector: selector => (selector === '.nv-fab-item:not([hidden])' && items[0] ? { focus: options => log.push(['focus-first', JSON.stringify(options)]) } : null)
  };
  const stand = { dataset: {} };
  let y = 0;
  const created = [];
  const deps = {
    dock: () => dock, menu: () => menu, stand: () => stand,
    screen: () => over.screen,
    create: tag => {
      const element = { tag, className: '', textContent: null, dataset: {}, children: [], listeners: {}, appendChild(child) { this.children.push(child); }, addEventListener(type, listener) { this.listeners[type] = listener; } };
      created.push(element);
      return element;
    },
    openOverlay: () => { open = true; log.push(['open']); },
    closeOverlay: () => { open = false; log.push(['close']); },
    overlayOpen: () => open,
    anchor: (overlay, origin) => log.push(['anchor', overlay === menu, origin === dock]),
    applyCapabilities: root => log.push(['capabilities', root === menu]),
    activeElement: () => over.active,
    scrollY: () => y
  };
  return { floating: createFloatingActions(deps), log, dock, menu, items, stand, created, setY: v => { y = v; }, focusLog: dock };
}

check('the dock built for a screen: its entries carry the gate, the mark and the name; none leaves it hidden', () => {
  const settings = control('settingsBtnWork', 'Settings', { feature: 'settings.open' });
  const palette = control('paletteBtn', 'Command palette', { svg: false });
  const w = dockWorld({ screen: screen([palette, settings]) });
  w.floating.paint('work');
  assert.strictEqual(w.dock.hidden, false);
  assert.deepStrictEqual([w.dock.getAttribute('aria-label'), w.dock.title, w.dock.getAttribute('aria-expanded'), w.menu.attributes.get('aria-label'), w.dock.dataset.action], ['Workspace actions', 'Workspace actions', 'false', 'Workspace actions', 'work']);
  assert.strictEqual(w.menu.innerHTML, '');
  assert.strictEqual(w.items.length, 2);
  const [first, second] = w.items.map(slot => slot.children[0]);
  assert.deepStrictEqual([w.items[0].className, first.type, first.className, first.dataset.feature], ['nv-fab-slot', 'button', 'nv-fab-item', 'settings.open']);
  const mark = first.children[0];
  assert.deepStrictEqual([...mark.attributes.entries()].sort(), [['aria-hidden', 'true'], ['class', 'ico']], 'the mark is a copy, sized by the dock, hidden from the reader');
  assert.strictEqual(first.children[1].textContent, 'Settings');
  assert.deepStrictEqual([second.dataset.feature, second.children.length, second.children[0].textContent], [undefined, 1, 'Command palette']);
  assert.deepStrictEqual(w.log.at(-1), ['capabilities', true]);
  const none = dockWorld({ screen: screen([]) });
  none.floating.paint('overview');
  assert.deepStrictEqual([none.dock.hidden, none.items.length], [true, 0]);
});

check('an entry closes the menu and hands focus back before its control runs', () => {
  const settings = control('settingsBtnWork', 'Settings');
  const w = dockWorld({ screen: screen([settings]) });
  w.floating.paint('work');
  w.floating.toggle();
  assert.deepStrictEqual(w.log.slice(-3), [['open'], ['anchor', true, true], ['focus-first', '{"preventScroll":true}']]);
  assert.strictEqual(w.stand.dataset.retracted, 'false');
  const order = [];
  w.dock.focus = () => order.push('dock focused');
  settings.click = () => order.push('control ran');
  w.items[0].children[0].listeners.click();
  assert.deepStrictEqual(order, ['dock focused', 'control ran']);
  assert.strictEqual(w.dock.getAttribute('aria-expanded'), 'false');
});

check('Escape only from inside, a press outside closes without taking focus, and the dock\'s own press toggles', () => {
  const w = dockWorld({ screen: screen([control('settingsBtnWork', 'Settings')]), active: 'elsewhere' });
  w.floating.paint('work');
  assert.strictEqual(w.floating.onKey('Escape'), false, 'closed: nothing to close');
  w.floating.open();
  assert.strictEqual(w.floating.onKey('Escape'), false, 'focus is in a dialog over it: Escape is the dialog\'s');
  const inside = dockWorld({ screen: screen([control('settingsBtnWork', 'Settings')]), active: 'entry' });
  inside.floating.paint('work');
  inside.floating.open();
  assert.strictEqual(inside.floating.onKey('Enter'), false);
  assert.strictEqual(inside.floating.onKey('Escape'), true);
  assert.strictEqual(inside.menu.hidden, true);
  w.floating.onPointerDown('menu');
  w.floating.onPointerDown('dock');
  assert.strictEqual(w.menu.hidden, false, 'a press in the menu or on the dock is not outside');
  w.dock.focused = null;
  w.floating.onPointerDown('page');
  assert.deepStrictEqual([w.menu.hidden, w.dock.focused], [true, null]);
  w.floating.toggle();
  assert.strictEqual(w.menu.hidden, false);
  w.floating.toggle();
  assert.deepStrictEqual([w.menu.hidden, w.dock.focused], [true, {}]);
  const hiddenDock = dockWorld({ screen: screen([control('settingsBtnWork', 'Settings')]), dockHidden: true });
  hiddenDock.floating.paint('work');
  hiddenDock.floating.open();
  hiddenDock.floating.close();
  assert.strictEqual(hiddenDock.dock.focused, null, 'a dock not on screen is not focused');
});

check('the dock steps aside as the page is read and comes back after a dialog', () => {
  const w = dockWorld({ screen: screen([control('settingsBtnWork', 'Settings')]) });
  w.floating.paint('work');
  w.setY(300);
  w.floating.onScroll();
  assert.strictEqual(w.stand.dataset.retracted, 'true');
  w.setY(303);
  w.floating.onScroll();
  assert.strictEqual(w.stand.dataset.retracted, 'true', 'jitter leaves it');
  w.setY(200);
  w.floating.onScroll();
  assert.strictEqual(w.stand.dataset.retracted, 'false');
  w.setY(700);
  w.floating.onScroll();
  /* The dialog left the page further up than the last scroll the dock saw. */
  w.setY(400);
  w.floating.settle();
  assert.strictEqual(w.stand.dataset.retracted, 'false');
  w.setY(410);
  w.floating.onScroll();
  assert.strictEqual(w.stand.dataset.retracted, 'true', 'measured from where the dialog left the page: ten pixels down is reading');
  w.setY(-40);
  w.floating.onScroll();
  assert.strictEqual(w.stand.dataset.retracted, 'false', 'a rubber band above the top is the top');
});

process.exitCode = 1;
(async () => {
  for (const [name, run] of checks) {
    try { await run(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  }
  console.log(`page shell tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
