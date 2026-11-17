'use strict';

/*
 * The page's look, asked directly: what a kept choice may be and how it is
 * read back (features/shell/appearance.ts), and the document dressed in it,
 * a change revealed from its control, the choices kept and the design
 * radio's arrows (features/shell/appearance-controller.ts); and the cursor's
 * light on a card (components/spotlight.ts).
 */

const assert = require('assert');
const appearance = require('../apps/web/src/features/shell/appearance.ts');
const { createAppearance } = require('../apps/web/src/features/shell/appearance-controller.ts');
const { spotlightAt, SPOTLIGHT_REST } = require('../apps/web/src/components/spotlight.ts');

const { DESIGNS, THEME_COLOR, EDITOR_THEMES, EDITOR_FONTS, FONT_SIZES, themeColor, nextTheme, settingsFrom, revealCircle, radioStep, isDesign } = appearance;
const checks = [];
const check = (name, run) => checks.push([name, run]);

/* ---- What a choice may be ------------------------------------------------------------ */

check('two designs, each with a chrome colour for dark and light', () => {
  assert.deepStrictEqual([...DESIGNS], ['nebula', 'obsidian']);
  assert.strictEqual(themeColor('nebula', 'dark'), '#06030F');
  assert.strictEqual(themeColor('nebula', 'light'), '#F5F3FB');
  assert.strictEqual(themeColor('obsidian', 'dark'), '#07080A');
  assert.strictEqual(themeColor('obsidian', 'light'), '#F4F2EE');
  assert.strictEqual(themeColor('anything', undefined), THEME_COLOR.nebula.dark, 'what is not obsidian is nebula, what is not light is dark');
  assert(isDesign('obsidian') && !isDesign('Obsidian') && !isDesign('constructor'));
  assert.deepStrictEqual([nextTheme('dark'), nextTheme('light'), nextTheme(undefined)], ['light', 'dark', 'dark']);
});

check('what is kept is read back only as what it may be', () => {
  assert.deepStrictEqual(settingsFrom({ fontSize: 16, wrap: false, motion: false, editorTheme: 'nord', editorFont: 'Fira Code', design: 'obsidian' }, false),
    { fontSize: 16, wrap: false, motion: false, editorTheme: 'nord', editorFont: 'Fira Code', design: 'obsidian' });
  assert.deepStrictEqual(settingsFrom({ fontSize: '16', wrap: 'yes', motion: 1, editorTheme: 'neon', editorFont: "x'; color: red", design: 'Obsidian' }, false), {},
    'a string size, a word for a flag, a theme or font the editor does not offer, a design that is not one');
  assert.deepStrictEqual(settingsFrom({ fontSize: FONT_SIZES.min - 1 }, false), {});
  assert.deepStrictEqual(settingsFrom({ fontSize: FONT_SIZES.max + 1 }, false), {});
  assert.deepStrictEqual(settingsFrom({ fontSize: NaN }, false), {});
  assert.deepStrictEqual(settingsFrom({ fontSize: FONT_SIZES.min }, false), { fontSize: FONT_SIZES.min });
  assert.deepStrictEqual(settingsFrom({ fontSize: FONT_SIZES.max }, false), { fontSize: FONT_SIZES.max });
  assert.deepStrictEqual(settingsFrom(JSON.parse('{"__proto__":{"motion":false},"constructor":1}'), false), {}, 'inherited names are not settings');
  for (const garbage of [42, 'nebula', true, [], [1]]) assert.deepStrictEqual(settingsFrom(garbage, true), {}, `${JSON.stringify(garbage)} is not kept settings`);
  assert.deepStrictEqual(settingsFrom(null, true), { motion: false }, 'nothing kept, and the system asks for less motion: it starts off');
  assert.deepStrictEqual(settingsFrom(null, false), {});
  assert.deepStrictEqual(settingsFrom({}, true), {}, 'kept settings are the reader\'s choice over the system\'s');
  assert(EDITOR_THEMES.every(([id, name]) => typeof id === 'string' && typeof name === 'string') && EDITOR_FONTS.length === 5);
});

check('a reveal grows from the control\'s centre far enough to cover the screen', () => {
  assert.deepStrictEqual(revealCircle({ left: 0, top: 0, width: 20, height: 20 }, 1000, 600), { x: 10, y: 10, radius: Math.hypot(990, 590) });
  assert.deepStrictEqual(revealCircle(null, 1000, 600), { x: 500, y: 300, radius: Math.hypot(500, 300) }, 'from the middle when nothing asked');
  assert.deepStrictEqual(revealCircle({ left: 980, top: 580, width: 20, height: 20 }, 1000, 600), { x: 990, y: 590, radius: Math.hypot(990, 590) });
});

check('the arrows move a radio choice, and no other key does', () => {
  assert.deepStrictEqual(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Enter', ' ', 'Tab', 'Home'].map(radioStep), [1, 1, -1, -1, 0, 0, 0, 0]);
});

/* ---- The document dressed ------------------------------------------------------------ */

function page({ stored = {}, reduced = false, transitions = true, closing = false } = {}) {
  const log = [];
  const storage = new Map(Object.entries(stored));
  const settings = { fontSize: 14, wrap: true, motion: true, editorTheme: 'material-ocean', editorFont: 'DM Mono', design: 'nebula' };
  const root = { dataset: { theme: 'dark' }, props: {}, classes: new Set(),
    style: { setProperty: (name, value) => { root.props[name] = value; } },
    classList: { add: name => root.classes.add(name), remove: name => root.classes.delete(name) },
    animate: (frames, options) => log.push(['animate', frames.clipPath[1], options.duration]) };
  const meta = { content: '' };
  const choices = DESIGNS.map(name => ({ dataset: { designChoice: name }, attrs: {}, tabIndex: 5, setAttribute(k, v) { this.attrs[k] = v; }, focus() { log.push(['focus', name]); }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) }));
  const switches = [{ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }];
  const logo = { paused: false, pauseAnimations() { this.paused = true; }, unpauseAnimations() { this.paused = false; } };
  const editor = { options: {}, refreshed: 0, setOption(k, v) { this.options[k] = v; }, refresh() { this.refreshed += 1; } };
  let pending = [];
  const look = createAppearance({
    root, themeMeta: () => meta, designChoices: () => choices, themeSwitches: () => switches, logos: () => [logo],
    storage: () => ({ getItem: key => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, value) }),
    settings: () => settings, mutateSettings: change => change(settings),
    prefersReducedMotion: () => reduced, anyOverlayClosing: () => closing, viewport: () => ({ width: 1000, height: 600 }),
    startViewTransition: transitions ? change => { log.push(['transition']); change(); const ready = Promise.resolve(); pending.push(ready); return { ready, finished: Promise.resolve() }; } : null,
    repaintVisuals: () => log.push(['repaint']), editor: () => editor
  });
  return { look, root, meta, choices, switches, logo, editor, settings, storage, log, flush: async () => { await Promise.all(pending); await null; pending = []; } };
}

check('stored choices are read back and the document dressed in them', () => {
  const p = page({ stored: { nv_theme: 'light', nv_settings: JSON.stringify({ design: 'obsidian', fontSize: 18, editorFont: 'Fira Code', motion: false, wrap: false, editorTheme: 'nord' }) } });
  p.look.load();
  assert.deepStrictEqual([p.root.dataset.theme, p.root.dataset.design, p.root.dataset.motion], ['light', 'obsidian', 'off']);
  assert.strictEqual(p.meta.content, '#F4F2EE');
  assert.deepStrictEqual(p.root.props, { '--ed-font': '1.125rem', '--ed-family': "'Fira Code', ui-monospace, monospace" });
  assert.deepStrictEqual(p.choices.map(choice => [choice.attrs['aria-checked'], choice.tabIndex]), [['false', -1], ['true', 0]], 'one tab stop, on the chosen design');
  assert.strictEqual(p.logo.paused, true, 'motion off pauses the logo');
  assert.deepStrictEqual(p.editor.options, { lineWrapping: false, theme: 'nord' });
  assert.deepStrictEqual(p.log, [['repaint']], 'a new design repaints the artwork');
  assert.deepStrictEqual(JSON.parse(p.storage.get('nv_settings')), p.settings, 'what is applied is kept');
});

check('kept settings that are not settings leave the defaults, and blocked storage changes nothing', () => {
  const p = page({ stored: { nv_settings: '{"fontSize":"huge","design":"neon"' } });
  p.look.load();
  assert.deepStrictEqual([p.settings.fontSize, p.settings.design, p.root.props['--ed-font']], [14, 'nebula', '0.875rem']);
  const odd = page({ stored: { nv_theme: 'blue' } });
  odd.look.load();
  assert.strictEqual(odd.root.dataset.theme, 'dark', 'a kept theme is dark or light, as theme-boot.js reads it');
  const unreadable = page({ stored: { nv_settings: '{' }, reduced: true });
  unreadable.look.load();
  assert.strictEqual(unreadable.root.dataset.motion, 'on', 'kept settings that cannot be read are still the reader\'s, not the system\'s');
  const reduced = page({ reduced: true });
  reduced.look.load();
  assert.strictEqual(reduced.root.dataset.motion, 'off', 'nothing kept and less motion asked for: motion off');
  const blocked = page();
  const look = createAppearance({ ...blocked, root: blocked.root, themeMeta: () => null, designChoices: () => [], themeSwitches: () => [], logos: () => [],
    storage: () => { throw new Error('blocked'); }, settings: () => blocked.settings, mutateSettings: change => change(blocked.settings),
    prefersReducedMotion: () => false, anyOverlayClosing: () => false, viewport: () => ({ width: 1, height: 1 }), startViewTransition: null, repaintVisuals: () => {}, editor: () => null });
  look.load();
  look.toggleTheme();
  assert.strictEqual(blocked.root.dataset.theme, 'light', 'the look still changes when it cannot be kept');
  const quiet = page();
  const still = createAppearance({ root: quiet.root, themeMeta: () => null, designChoices: () => [], themeSwitches: () => [], logos: () => [],
    storage: () => { throw new Error('blocked'); }, settings: () => quiet.settings, mutateSettings: change => change(quiet.settings),
    prefersReducedMotion: () => true, anyOverlayClosing: () => false, viewport: () => ({ width: 1, height: 1 }), startViewTransition: null, repaintVisuals: () => {}, editor: () => null });
  still.load();
  assert.strictEqual(quiet.root.dataset.motion, 'off', 'with storage blocked, a system that asks for less motion is heard');
});

check('a design that is not one is put back to nebula when applied', () => {
  const p = page();
  p.settings.design = 'neon';
  p.look.apply();
  assert.strictEqual(p.settings.design, 'nebula');
  assert.strictEqual(p.root.dataset.design, 'nebula');
});

check('the theme toggles with a reveal from its control, kept and said by every switch', async () => {
  const p = page();
  p.look.toggleTheme({ getBoundingClientRect: () => ({ left: 980, top: 580, width: 20, height: 20 }) });
  assert.deepStrictEqual([p.root.dataset.theme, p.meta.content, p.storage.get('nv_theme'), p.switches[0].attrs['aria-checked']], ['light', '#F5F3FB', 'light', 'false']);
  assert(p.root.classes.has('vt-reveal'));
  await p.flush();
  assert.deepStrictEqual(p.log.find(entry => entry[0] === 'animate'), ['animate', `circle(${Math.hypot(990, 590)}px at 990px 590px)`, 560]);
  await null; await null;
  assert(!p.root.classes.has('vt-reveal'), 'the reveal class leaves when it is done');
  p.look.toggleTheme();
  assert.strictEqual(p.root.dataset.theme, 'dark');
});

check('with motion off, no transition API, less motion asked for or a layer still leaving, the change is simply made', () => {
  for (const options of [{ transitions: false }, { reduced: true }, { closing: true }]) {
    const p = page(options);
    p.look.toggleTheme();
    assert.strictEqual(p.root.dataset.theme, 'light');
    assert(!p.log.some(entry => entry[0] === 'transition'), JSON.stringify(options));
  }
  const p = page();
  p.settings.motion = false;
  p.look.toggleTheme();
  assert(!p.log.some(entry => entry[0] === 'transition'));
  const q = page();
  q.root.dataset.motion = 'off';
  q.look.toggleTheme();
  assert(!q.log.some(entry => entry[0] === 'transition'));
});

check('a design is chosen by press or arrow, once, and only a design', () => {
  const p = page();
  p.look.load();
  p.look.setDesign('obsidian');
  assert.strictEqual(p.settings.design, 'obsidian');
  assert.strictEqual(JSON.parse(p.storage.get('nv_settings')).design, 'obsidian', 'the choice is kept');
  const transitions = p.log.filter(entry => entry[0] === 'transition').length;
  p.look.setDesign('obsidian');
  p.look.setDesign('neon');
  assert.strictEqual(p.log.filter(entry => entry[0] === 'transition').length, transitions, 'the design already chosen, or none, changes nothing');
  const onChoice = { closest: selector => (selector === '[data-design-choice]' ? p.choices[1] : null) };
  assert.strictEqual(p.look.onKey(onChoice, 'ArrowRight'), true);
  assert.strictEqual(p.settings.design, 'nebula', 'right from the last wraps to the first');
  assert.deepStrictEqual(p.log.filter(entry => entry[0] === 'focus'), [['focus', 'nebula']]);
  assert.strictEqual(p.look.onKey(onChoice, 'Enter'), false);
  assert.strictEqual(p.look.onKey({ closest: () => null }, 'ArrowRight'), false);
  assert.strictEqual(p.look.onKey(null, 'ArrowRight'), false);
  p.look.onClick({ closest: selector => (selector === '[data-design-choice]' ? p.choices[1] : null) });
  assert.strictEqual(p.settings.design, 'obsidian');
  const theme = p.root.dataset.theme;
  p.look.onClick({ closest: selector => (selector === '.theme-toggle' ? {} : null) });
  assert.notStrictEqual(p.root.dataset.theme, theme);
  p.look.onClick(null);
});

/* ---- The cursor's light --------------------------------------------------------------- */

check('the light on a card follows the pointer in the card\'s own box', () => {
  assert.deepStrictEqual(spotlightAt({ left: 100, top: 50, width: 200, height: 100 }, 150, 75), ['25.0%', '25.0%']);
  assert.deepStrictEqual(spotlightAt({ left: 0, top: 0, width: 3, height: 7 }, 1, 2), ['33.3%', '28.6%']);
  assert.deepStrictEqual(spotlightAt({ left: 0, top: 0, width: 0, height: 0 }, 1, 2), [...SPOTLIGHT_REST], 'a card with no size rests');
  assert.deepStrictEqual([...SPOTLIGHT_REST], ['50%', '0%']);
});

process.exitCode = 1;
(async () => {
  for (const [name, run] of checks) {
    try { await run(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  }
  console.log(`page appearance tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
