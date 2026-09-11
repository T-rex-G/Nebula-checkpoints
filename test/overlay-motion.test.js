'use strict';
/*
 * Overlays used to close with a cut: `hidden = true`, no exit. They now defer
 * the hide until an exit animation has run, and everything dangerous about
 * this change lives in that deferral.
 *
 * A deferred hide that never completes leaves a full-screen scrim over the
 * page with nothing left to dismiss it -- the app reads as frozen, and no
 * amount of pressing helps. The animation is exactly the thing that can fail
 * to finish: it does not run at all inside a `display:none` ancestor, so the
 * `animationend` this would otherwise wait on is not merely late, it is never
 * coming. That case cannot be reached from the page, which is why the logic
 * lives in a module a test can drive directly and hold a clock over.
 *
 * The second half of the guard is the cascade. The script decides how long to
 * wait by measuring the stylesheet, so a motion-off rule that fails to outweigh
 * an exit rule is not a cosmetic miss -- it leaves an animation running that
 * the settings say is off. Specificity is checked here as arithmetic rather
 * than trusted by eye, because the one time it was trusted by eye it was
 * wrong: `[data-motion="off"] .modal` loses to `[data-closing] .modal`, and
 * loses silently.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const motion = require('../public/overlay-motion');
const appSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (error) { failures++; console.log(`  FAIL ${label}\n       ${error.message}`); }
}

/* ---------------- a layer, and a clock ---------------- */

/*
 * The element reports a different animation depending on whether it is marked
 * closing, so a measurement taken before the mark reads the *entry* animation
 * and lands on a visibly different number. That is how the tests below can
 * tell the two orderings apart at all.
 */
const ENTRY_MS = 5000;
const EXIT_MS = 280;

function makeLayer(options) {
  const listeners = [];
  const layer = {
    hidden: false,
    attrs: new Map(),
    setAttribute(name, value) { this.attrs.set(name, value); },
    removeAttribute(name) { this.attrs.delete(name); },
    hasAttribute(name) { return this.attrs.has(name); },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const at = listeners.findIndex(l => l.type === type && l.fn === fn);
      if (at >= 0) listeners.splice(at, 1);
    },
    listeners,
    fire(type, event) { listeners.slice().forEach(l => { if (l.type === type) l.fn(event); }); }
  };
  /* Browsers that support `inert` expose it as a property; one that does not
     has no way to take a dismissed layer out of the accessibility tree while
     it is still painted, and the close has to be immediate there. */
  if (!options || options.inert !== false) layer.inert = false;
  return layer;
}

function makeClock() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, ms) { scheduled.push({ fn, ms, live: true }); return scheduled.length - 1; },
    clearTimeout(id) { if (scheduled[id]) scheduled[id].live = false; },
    runAll() { scheduled.forEach(entry => { if (entry.live) { entry.live = false; entry.fn(); } }); }
  };
}

function styleFor(el) {
  const closing = el.hasAttribute('data-closing');
  return {
    animationName: closing ? 'scrimOut' : 'fadeIn',
    animationDuration: closing ? `${EXIT_MS / 1000}s` : `${ENTRY_MS / 1000}s`,
    animationDelay: '0s'
  };
}

function harness(style, layerOptions) {
  const clock = makeClock();
  const api = motion.createOverlayMotion({
    getComputedStyle: style || styleFor,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  return { clock, api, layer: makeLayer(layerOptions) };
}

console.log('overlay motion');

/* ---------------- the deferral, and its floor ---------------- */

check('a close with an exit animation does not hide the layer on the spot', () => {
  const { api, layer } = harness();
  api.closeOverlay(layer);
  assert.strictEqual(layer.hidden, false, 'the layer was cut away instead of animated out');
  assert.ok(layer.hasAttribute('data-closing'), 'nothing told the stylesheet to run an exit');
});

check('the exit ends the moment the layer says its own animation finished', () => {
  const { api, layer } = harness();
  api.closeOverlay(layer);
  layer.fire('animationend', { target: layer });
  assert.strictEqual(layer.hidden, true, 'the layer stayed on screen after its exit ended');
  assert.ok(!layer.hasAttribute('data-closing'), 'the closing mark outlived the close');
});

check('a child finishing its own animation does not cut the exit short', () => {
  const { api, layer } = harness();
  api.closeOverlay(layer);
  /* The panel inside the scrim animates too, and it is the scrim whose
     duration was measured. Ending on the panel hides the layer early. */
  layer.fire('animationend', { target: { notTheLayer: true } });
  assert.strictEqual(layer.hidden, false, 'a descendant animation ended the layer exit');
  layer.fire('animationend', { target: layer });
  assert.strictEqual(layer.hidden, true);
});

check('the layer still hides when the animation never ends at all', () => {
  const { api, layer, clock } = harness();
  api.closeOverlay(layer);
  /* No animationend: the case a display:none ancestor produces, which cannot
     be reached from the page and is the one that strands a scrim. */
  clock.runAll();
  assert.strictEqual(layer.hidden, true, 'an animation that never ended left the layer over the page');
  assert.ok(!layer.hasAttribute('data-closing'), 'the closing mark was left behind');
});

check('the fallback waits out the exit it measured, not the entry', () => {
  const { api, layer, clock } = harness();
  api.closeOverlay(layer);
  const wait = clock.scheduled.filter(entry => entry.live).map(entry => entry.ms);
  assert.strictEqual(wait.length, 1, `expected one pending fallback, saw ${wait.length}`);
  assert.ok(wait[0] >= EXIT_MS,
    `the fallback fires after ${wait[0]}ms, inside the ${EXIT_MS}ms exit -- it would hide the layer mid-animation`);
  assert.ok(wait[0] < ENTRY_MS,
    `the fallback waits ${wait[0]}ms, which is the entry animation: the duration was read before the layer was marked closing`);
});

check('the duration comes from the stylesheet, not from a number in the script', () => {
  const doubled = el => {
    const base = styleFor(el);
    return el.hasAttribute('data-closing')
      ? { animationName: base.animationName, animationDuration: '1.2s', animationDelay: '0.3s' }
      : base;
  };
  const { api, layer, clock } = harness(doubled);
  api.closeOverlay(layer);
  const wait = clock.scheduled.filter(entry => entry.live).map(entry => entry.ms)[0];
  assert.ok(wait >= 1500,
    `a 1.2s exit delayed 0.3s needs at least 1500ms; the fallback waits ${wait}ms, so the wait is fixed in the script`);
});

check('the longest of several animations is what gets waited out', () => {
  assert.strictEqual(motion.longestTimeMs('0.2s, 400ms, 0.1s'), 400);
  assert.strictEqual(motion.longestTimeMs('0.28s'), 280);
  assert.strictEqual(motion.longestTimeMs(''), 0);
  assert.strictEqual(motion.longestTimeMs(null), 0);
});

check('with no exit animation the close is immediate', () => {
  const none = () => ({ animationName: 'none', animationDuration: '0s', animationDelay: '0s' });
  const { api, layer, clock } = harness(none);
  api.closeOverlay(layer);
  assert.strictEqual(layer.hidden, true, 'motion is off and the layer still lingered');
  assert.strictEqual(clock.scheduled.filter(entry => entry.live).length, 0,
    'nothing was animating and a timer was armed anyway');
});

/* ---------------- reopening mid-exit ---------------- */

check('reopening during an exit leaves the layer up, and keeps it up', () => {
  const { api, layer, clock } = harness();
  api.closeOverlay(layer);
  api.openOverlay(layer);
  assert.strictEqual(layer.hidden, false);
  assert.ok(!layer.hasAttribute('data-closing'), 'the reopened layer is still marked as closing');
  clock.runAll();
  assert.strictEqual(layer.hidden, false,
    'the abandoned close came back and hid a layer the reader had just reopened');
});

check('an exit leaves no listener and no live timer behind it', () => {
  const { api, layer, clock } = harness();
  api.closeOverlay(layer);
  layer.fire('animationend', { target: layer });
  assert.strictEqual(layer.listeners.length, 0, 'the animationend listener was left attached');
  assert.strictEqual(clock.scheduled.filter(entry => entry.live).length, 0, 'the fallback timer was left armed');
});

check('closing twice settles once, not twice', () => {
  const { api, layer, clock } = harness();
  let settled = 0;
  api.closeOverlay(layer, () => { settled++; });
  api.closeOverlay(layer, () => { settled++; });
  clock.runAll();
  layer.fire('animationend', { target: layer });
  assert.strictEqual(settled, 1, `the settled callback ran ${settled} times`);
});

check('closing an already hidden layer settles at once', () => {
  const { api, layer } = harness();
  layer.hidden = true;
  let settled = 0;
  api.closeOverlay(layer, () => { settled++; });
  assert.strictEqual(settled, 1, 'a layer that was already gone never reported itself settled');
});

/* ---------------- out of reach the moment it is dismissed ---------------- */

check('a dismissed layer leaves the accessibility tree at once, not when the fade ends', () => {
  const { api, layer } = harness();
  api.closeOverlay(layer);
  assert.strictEqual(layer.inert, true,
    'the layer animates out while still reachable: a screen reader is offered controls inside a dialog the reader has already dismissed');
  layer.fire('animationend', { target: layer });
  assert.strictEqual(layer.inert, false, 'the layer was left inert after it was hidden');
});

check('a reopened layer is reachable again', () => {
  const { api, layer } = harness();
  api.closeOverlay(layer);
  api.openOverlay(layer);
  assert.strictEqual(layer.inert, false,
    'the layer is back on screen but unreachable -- nothing in it can be focused or announced');
});

check('without inert the close is immediate rather than quietly unreachable', () => {
  const { api, layer, clock } = harness(null, { inert: false });
  api.closeOverlay(layer);
  assert.strictEqual(layer.hidden, true,
    'this browser cannot take the layer out of the accessibility tree, so animating it out leaves a dismissed dialog audible');
  assert.strictEqual(clock.scheduled.filter(entry => entry.live).length, 0);
});

/* ---------------- what counts as open ---------------- */

check('a layer part-way through its exit does not count as open', () => {
  const { api, layer } = harness();
  assert.strictEqual(api.overlayOpen(layer), true);
  api.closeOverlay(layer);
  assert.strictEqual(api.overlayOpen(layer), false,
    'a dismissed dialog still reports itself open, so it will steal focus and swallow Escape on its way out');
  layer.fire('animationend', { target: layer });
  assert.strictEqual(api.overlayOpen(layer), false);
});

/* ---------------- every layer routed through the helpers ---------------- */

/*
 * Derived from the page rather than listed here: a seventh overlay added later
 * is covered the day its markup lands, and a scrim renamed does not quietly
 * fall out of the set.
 */
const scrimIds = [...htmlSource.matchAll(/<div[^>]*class="[^"]*\b(?:scrim|side-scrim|sheet-scrim|stage-scrim|palette-scrim)\b[^"]*"[^>]*id="([^"]+)"/g)]
  .map(match => match[1]);

check('the page still has the overlays this guard is about', () => {
  assert.ok(scrimIds.length >= 6,
    `found ${scrimIds.length} scrims in index.html (${scrimIds.join(', ')}); the selector no longer finds them, so everything below is vacuous`);
});

scrimIds.forEach(id => {
  check(`#${id} is never shown or hidden by hand`, () => {
    /*
     * The mechanism, not the name: any direct assignment to `.hidden` on this
     * scrim bypasses the exit entirely, whatever the surrounding code is
     * called. Reading `.hidden` is left alone -- it is the writes that cut.
     */
    const written = new RegExp(`\\$\\('#${id}'\\)\\.hidden\\s*=|\\b${id}\\b[^\\n]*\\.hidden\\s*=`, 'g');
    const hits = appSource.split('\n')
      .map((line, at) => ({ line: line.trim(), at: at + 1 }))
      .filter(entry => written.test(entry.line) && !entry.line.startsWith('*'));
    assert.strictEqual(hits.length, 0,
      `app.js sets #${id}.hidden directly at ${hits.map(h => `line ${h.at}`).join(', ')}, which skips the exit animation`);
  });
});

check('app.js reaches the overlay rules through the shared module', () => {
  assert.ok(/NebulaOverlayMotion\.createOverlayMotion\(/.test(appSource),
    'app.js no longer builds its overlay helpers from the tested module, so these tests prove nothing about the page');
  assert.ok(/\/overlay-motion\.js\?v=__NV_ASSET_VERSION__/.test(htmlSource),
    'the page does not load overlay-motion.js, so app.js will throw on the first line that uses it');
  const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  assert.ok(/\/overlay-motion\.js\?v=__NV_ASSET_VERSION__/.test(sw),
    'overlay-motion.js is not precached; offline, app.js would fail to parse and the whole app would be dead');
});

/* ---------------- the cascade ---------------- */

const stripped = cssSource.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...stripped.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map(match => ({ selector: match[1].trim(), body: match[2].trim(), at: match.index }))
  .filter(rule => rule.selector && !rule.selector.includes('@'));

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+/g) || []).length +
    (selector.match(/\[[^\]]*\]/g) || []).length +
    (selector.match(/(?<!:):(?!:)[\w-]+/g) || []).length;
  const bare = selector.replace(/\[[^\]]*\]/g, '').replace(/::?[\w-]+/g, '').replace(/[.#][\w-]+/g, '');
  const elements = (bare.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, elements];
}

function heavier(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return null; /* a tie: source order decides */
}

function subject(selector) {
  const compound = selector.trim().split(/[\s>+~]+/).pop();
  return compound.replace(/\[[^\]]*\]/g, '') || compound;
}

/* Split selector lists so each selector is judged on its own weight. */
function eachSelector(rule) {
  return rule.selector.split(',').map(one => one.trim()).filter(Boolean)
    .map(one => ({ selector: one, body: rule.body, at: rule.at }));
}

const exits = rules.filter(rule => rule.selector.includes('[data-closing]') && /animation\s*:/.test(rule.body))
  .flatMap(eachSelector);
const stills = rules.filter(rule => /animation\s*:\s*none/.test(rule.body)).flatMap(eachSelector);

check('the stylesheet actually carries overlay exits', () => {
  assert.ok(exits.length >= 8,
    `only ${exits.length} exit rules found; the overlays are not being animated out and every cascade check below is vacuous`);
});

['[data-motion="off"]', ':root'].forEach(prefix => {
  const label = prefix === ':root' ? 'the reduced-motion block' : 'motion turned off';
  exits.forEach(exit => {
    check(`${label} outweighs the exit on ${exit.selector}`, () => {
      const target = subject(exit.selector);
      const exitWeight = specificity(exit.selector);
      const covering = stills.filter(still =>
        still.selector.startsWith(prefix) && subject(still.selector) === target);
      assert.ok(covering.length > 0,
        `nothing under ${prefix} stops the exit on ${target}, so the animation keeps running with motion off`);
      const wins = covering.some(still => {
        const verdict = heavier(specificity(still.selector), exitWeight);
        return verdict === true || (verdict === null && still.at > exit.at);
      });
      assert.ok(wins,
        `${covering.map(c => c.selector).join(' / ')} does not beat "${exit.selector}" ` +
        `(${specificity(covering[0].selector)} vs ${exitWeight}); the exit still runs, ` +
        'and the script measures it and waits for it');
    });
  });
});

check('a layer on its way out stops taking presses', () => {
  const inert = rules.some(rule => rule.selector.includes('[data-closing]') && /pointer-events\s*:\s*none/.test(rule.body));
  assert.ok(inert,
    'a dismissing overlay is still clickable, so a second press restarts a dismissal already under way');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
