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
const vm = require('vm');

const root = path.join(__dirname, '..');
const motion = require('../public/overlay-motion');
const appSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

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

check('a still-painted reopen flushes a hidden layout before replaying its entrance', () => {
  const { api, layer, clock } = harness();
  const hiddenAtLayout = [];
  layer.getBoundingClientRect = () => { hiddenAtLayout.push(layer.hidden); return {}; };
  api.closeOverlay(layer);
  api.openOverlay(layer);
  assert.deepStrictEqual(hiddenAtLayout, [true]);
  assert.strictEqual(layer.hidden, false);
  assert.strictEqual(layer.inert, false);
  clock.runAll();
  assert.strictEqual(layer.hidden, false);
});

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

/* ---------------- not while a layer is leaving ---------------- */

/*
 * A View Transition snapshots the whole document. Every rail destination and
 * every sheet entry dismisses its overlay and changes the page in the same
 * tick, so a transition started there captures a drawer frozen mid-slide and
 * cross-fades it over the drawer's own still-running animation. That is the
 * glitch picking a destination from the open rail produced, and it is only
 * visible in a real browser -- which is why the condition is asserted here,
 * where it can be driven.
 */
check('an exit in flight is reported, so the page transition can stand down', () => {
  const { api, layer } = harness();
  assert.strictEqual(api.anyOverlayClosing(), false, 'nothing is closing yet');
  api.closeOverlay(layer);
  assert.strictEqual(api.anyOverlayClosing(), true,
    'a layer is animating out and nothing says so, so a whole-document transition will be laid over it');
  layer.fire('animationend', { target: layer });
  assert.strictEqual(api.anyOverlayClosing(), false, 'the exit finished and the flag is stuck on');
});

check('the timer path clears the in-flight flag too', () => {
  const { api, layer, clock } = harness();
  api.closeOverlay(layer);
  clock.runAll();
  assert.strictEqual(api.anyOverlayClosing(), false,
    'an exit that ended on the timer leaves the flag set, so page transitions stay disabled for the rest of the session');
});

check('reopening clears the in-flight flag', () => {
  const { api, layer } = harness();
  api.closeOverlay(layer);
  api.openOverlay(layer);
  assert.strictEqual(api.anyOverlayClosing(), false, 'a cancelled exit still counts as in flight');
});

check('two layers closing are both tracked', () => {
  const { api, layer } = harness();
  const second = makeLayer();
  api.closeOverlay(layer);
  api.closeOverlay(second);
  layer.fire('animationend', { target: layer });
  assert.strictEqual(api.anyOverlayClosing(), true,
    'one of two exits finished and the flag already cleared, so the other is still moving when a transition starts');
  second.fire('animationend', { target: second });
  assert.strictEqual(api.anyOverlayClosing(), false);
});

check('the page transition actually consults it', () => {
  const source = appSource.slice(appSource.indexOf('function withTransition'));
  const body = source.slice(0, source.indexOf('\n}'));
  assert.ok(/anyOverlayClosing\(\)/.test(body),
    'withTransition does not ask whether a layer is leaving, so it will cross-fade a snapshot over one that is');
  assert.ok(/startViewTransition/.test(body), 'withTransition no longer starts a transition at all');
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

/* ---------------- the stylesheet has to resolve ---------------- */

/*
 * An undefined custom property with no fallback does not fail loudly: the whole
 * declaration becomes invalid at computed-value time, so a border quietly falls
 * back to currentColor and paints in the text colour, and a colour falls back
 * to whatever it inherits. Six declarations were shipping that way -- a warning
 * with no warning colour, governance borders drawn in the text colour, a panel
 * with no background -- and nothing anywhere reported it.
 *
 * A property that is written from JavaScript is legitimately absent from the
 * stylesheet, which is exactly what the fallback in var(--x, y) is for. So the
 * rule is not "every property must be defined": it is "every reference must
 * either resolve or carry a fallback".
 */
check('every custom property either resolves or carries a fallback', () => {
  const defined = new Set([...cssSource.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  const orphans = new Map();
  for (const match of cssSource.matchAll(/var\(\s*(--[\w-]+)\s*(?!,)\)/g)) {
    const name = match[1];
    if (defined.has(name)) continue;
    if (!orphans.has(name)) orphans.set(name, cssSource.slice(0, match.index).split('\n').length);
  }
  assert.strictEqual(orphans.size, 0,
    `these are referenced with no definition and no fallback, so their declarations are dropped: ${
      [...orphans].map(([name, line]) => `${name} (line ${line})`).join(', ')}`);
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

/*
 * The body of one @keyframes block, matched by counting braces rather than by
 * a lazy regex: the blocks are written one per line and a regex that stops at
 * the first line-leading brace swallows the three that follow it, which is how
 * a backdrop that only fades was read as a panel that moves.
 */
function keyframeBody(name) {
  const head = stripped.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  if (head < 0) return '';
  const open = stripped.indexOf('{', head);
  let depth = 0;
  for (let i = open; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}' && --depth === 0) return stripped.slice(open + 1, i);
  }
  return '';
}

/* Split selector lists so each selector is judged on its own weight. */
function eachSelector(rule) {
  return rule.selector.split(',').map(one => one.trim()).filter(Boolean)
    .map(one => ({ selector: one, body: rule.body, at: rule.at }));
}

/* A rule that switches an animation off is not an exit; without this the
   motion-off and reduced-motion rules are read as exits and then checked
   for being outweighed by themselves. */
const exits = rules.filter(rule => rule.selector.includes('[data-closing]') && /animation\s*:/.test(rule.body) && !/animation\s*:\s*none/.test(rule.body))
  .flatMap(eachSelector);
const stills = rules.filter(rule => /animation\s*:\s*none/.test(rule.body)).flatMap(eachSelector);

/* ---------------- the create mark, the way out, and depth ---------------- */

/*
 * The ring has to be closed.
 *
 * It was an open arc, which left a stroke running off the planet with nothing
 * terminating it -- at 17px that reads as a letter Q or a magnifier, and the
 * plus floated unattached in the corner. A closed ellipse is the shape a
 * reader already knows. This checks the element type rather than the path
 * data, because "closed" is a property of the geometry, not of a `d` string.
 */
check('the create mark draws a closed ring, not an open arc', () => {
  const button = htmlSource.match(/<button[^>]*data-feature="repository\.create"[\s\S]*?<\/button>/);
  assert.ok(button, 'the create control is gone');
  const ring = button[0].match(/<(\w+)[^>]*class="nv-planet-ring"[^>]*\/?>/);
  assert.ok(ring, 'the ring is gone from the mark');
  assert.ok(['ellipse', 'circle'].includes(ring[1]),
    `the ring is a <${ring[1]}>, which can be an open stroke; a closed ellipse or circle cannot be`);
  assert.ok(!/<path[^>]*class="nv-planet-ring"/.test(button[0]),
    'the ring is drawn as a path again, which is how the trailing arc got in');
  /*
   * The tilt has to live in the cascade. As a transform attribute it loses to
   * the hover rule's own transform, and the ring snaps flat the moment a
   * pointer touches the button.
   */
  assert.ok(!/class="nv-planet-ring"[^>]*transform=/.test(button[0]),
    'the ring carries a transform attribute, which the hover rule overrides rather than composes with');
  const rest = rules.filter(rule => eachSelector(rule).some(one => one.selector.trim() === '.nv-planet-ring'));
  assert.ok(rest.some(rule => /transform\s*:\s*rotate/.test(rule.body)),
    'nothing in the cascade tilts the ring, so the planet reads flat');
});

/*
 * A dialog needs a visible way out. Escape and a backdrop press both work and
 * neither is discoverable; on a phone the backdrop is a guess and Escape needs
 * a keyboard. Settings is the case that made this obvious -- a panel of
 * switches whose only labelled exit said "Done" at the bottom of a scroll.
 */
check('every dialog offers a close control where a reader looks for one', () => {
  const close = htmlSource.match(/<button[^>]*id="modalClose"[^>]*>/);
  assert.ok(close, 'the dialog has no close control');
  /*
   * "Close dialog", not "Close". An informational dialog's footer button is
   * already named Close, and two controls sharing one accessible name in one
   * dialog is ambiguous to a screen reader, not merely to a test locator.
   */
  assert.ok(/aria-label="Close dialog"/.test(close[0]),
    'the close control has no accessible name, or one that collides with a footer button named Close');
  assert.ok(/title="Close dialog"/.test(close[0]), 'the close control has no tooltip, so a pointer gets no name');
  /* Wired to the same answer Cancel gives: a dialog dismissed from the corner
     has not been confirmed. */
  assert.ok(/#modalClose'\)[\s\S]{0,120}closeModal\(false\)/.test(appSource),
    'the close control is not wired, or does not resolve the dialog as dismissed');
  /* And it has to sit beside the title rather than below it. */
  assert.ok(/<div class="modal-head">[\s\S]{0,400}id="modalClose"/.test(htmlSource),
    'the close control is outside the dialog header, so it stacks under the title');
  const head = rules.find(rule => eachSelector(rule).some(one => one.selector.trim() === '.modal-head'));
  assert.ok(head && /display\s*:\s*flex/.test(head.body),
    'the dialog header does not lay out as a row, so the control falls below the name');
  /* 44px of reachable target, however the visible mark is sized. */
  const mark = rules.filter(rule => /\.modal-close/.test(rule.selector)).map(rule => rule.body).join(';');
  const reach = [...mark.matchAll(/(?:width|height)\s*:\s*(\d+)px/g)].map(match => Number(match[1]));
  assert.ok(reach.some(value => value >= 44),
    `the close control's largest box is ${Math.max(0, ...reach)}px; a touch target needs 44`);
});

/*
 * Depth, as material rather than as z-index.
 *
 * Every glass surface in the product used one blur, so a dialog floating над a
 * card was cut from identical stock and nothing about it read as nearer. Real
 * frosted glass blurs more the further it floats from what is behind it, so
 * the three levels have to be strictly increasing -- read out of the cascade,
 * not asserted as numbers here.
 */
check('a raised surface is made of different glass than the one it covers', () => {
  const blurOf = selector => {
    const own = rules.filter(rule => eachSelector(rule).some(one => one.selector.trim() === selector
      || one.selector.trim().endsWith(' ' + selector)));
    for (const rule of own) {
      const direct = rule.body.match(/backdrop-filter\s*:\s*blur\(\s*([\d.]+)px/);
      if (direct) return Number(direct[1]);
      const token = rule.body.match(/backdrop-filter\s*:\s*blur\(\s*var\(\s*(--[\w-]+)/);
      if (token) {
        const value = cssSource.match(new RegExp(`${token[1]}\\s*:\\s*([\\d.]+)px`));
        if (value) return Number(value[1]);
      }
    }
    return null;
  };
  /*
   * A resting card is a solid slab now, not frosted glass -- the translucent
   * cards were reported as looking cheap -- so it blurs nothing: zero, and the
   * surfaces above it still blur more the nearer they float.
   */
  const card = blurOf('.card') ?? 0;
  const cardRule = rules.filter(rule => eachSelector(rule).some(one => one.selector.trim() === '.card')).map(rule => rule.body).join(';');
  assert.ok(card > 0 || /background\s*:\s*var\(--surface-card\)/.test(cardRule),
    'a resting card neither blurs nor is solid, so it is a translucent sheet with nothing behind it');
  const raised = blurOf('.sheet');
  const top = blurOf('.modal');
  [['.card', card], ['.sheet', raised], ['.modal', top]].forEach(([name, value]) => {
    assert.ok(typeof value === 'number', `${name} has no resolvable backdrop blur`);
  });
  assert.ok(raised > card,
    `a raised surface blurs ${raised}px and a resting card ${card}px; the same or less makes them one sheet`);
  assert.ok(top > raised,
    `a dialog blurs ${top}px and a raised surface ${raised}px; a dialog has to read as the nearest thing on screen`);
});

/* ---------------- travelling down the page on a phone ---------------- */

/*
 * The reveals are driven by the scroll position itself. Three things have to
 * hold or the feature is worse than not having it: it must be gated on support
 * so an unsupporting browser is not left running the animation on the clock
 * (which would land every section at its `from` keyframe and hide the page);
 * it must be gated on reduced motion; and the progress bar must name the
 * scroller that actually scrolls.
 */
check('the phone reveals are driven by scroll, and degrade to nothing', () => {
  const stripped2 = cssSource.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/animation-timeline\s*:\s*view\(\)/.test(stripped2),
    'nothing is driven by a view timeline, so the reveals are not tied to the scroll');
  /* Every scroll-driven declaration sits inside an @supports for the feature. */
  const supportsBlocks = [...stripped2.matchAll(/@supports\s*\(animation-timeline:\s*(view|scroll)\(\)\)/g)];
  assert.ok(supportsBlocks.length >= 2,
    'the scroll-driven rules are not gated on @supports, so an unsupporting browser runs them on the clock');
  /*
   * A declaration ends in `;` or `}`. The text inside `@supports
   * (animation-timeline: view())` ends in `)`, and counting it as a
   * declaration is how the first version of this check reported two
   * ungated uses that did not exist -- it was reading its own gates.
   */
  const DECLARED = /animation-timeline\s*:\s*(?:view|scroll)\([^()]*\)\s*[;}]/g;
  const guarded = stripped2.split(/@supports\s*\(animation-timeline/).slice(1).join('');
  const timelineUses = (stripped2.match(DECLARED) || []).length;
  const guardedUses = (guarded.match(DECLARED) || []).length;
  assert.ok(timelineUses >= 3,
    `only ${timelineUses} scroll-driven declaration(s) found; this check has nothing to prove`);
  assert.strictEqual(guardedUses, timelineUses,
    `${timelineUses - guardedUses} animation-timeline declaration(s) sit outside an @supports gate`);
  /*
   * Checked per block, not across the file. The first version asked whether a
   * reduced-motion gate existed anywhere after the first @supports -- so
   * stripping the gate off one of the two blocks left the other one to satisfy
   * it, and the perturbation walked through. Every block that declares a
   * timeline has to carry its own gate.
   */
  const blockAt = index => {
    const open = stripped2.indexOf('{', index);
    let depth = 0;
    for (let i = open; i < stripped2.length; i += 1) {
      if (stripped2[i] === '{') depth += 1;
      else if (stripped2[i] === '}' && (depth -= 1) === 0) return stripped2.slice(open + 1, i);
    }
    return '';
  };
  const gates = [...stripped2.matchAll(/@supports\s*\(animation-timeline:\s*(?:view|scroll)\(\)\)/g)];
  assert.ok(gates.length >= 2, `only ${gates.length} support gate(s) found`);
  gates.forEach(gate => {
    const body = blockAt(gate.index);
    const declared = (body.match(DECLARED) || []).length;
    if (!declared) return;
    assert.ok(/prefers-reduced-motion:\s*no-preference/.test(body),
      `a @supports block declaring ${declared} scroll-driven animation(s) carries no reduced-motion gate`);
  });
  /*
   * scroll(root), measured rather than assumed: at phone width the document is
   * the scroller and the overview container is not, so scroll(nearest) bound
   * to no timeline at all and the bar sat at zero from top to bottom.
   */
  assert.ok(/animation-timeline\s*:\s*scroll\(root/.test(stripped2),
    'the page progress reads a scroller other than the root, which is not what scrolls on a phone');
  assert.ok(!/animation-timeline\s*:\s*scroll\(nearest/.test(stripped2),
    'a scroll timeline still says nearest, which resolves to no scroller here');
  /* Hidden until the feature is confirmed, so it never shows as a dead line. */
  const bar = rules.find(rule => eachSelector(rule).some(one => one.selector.trim() === '.ov-scroll-progress'));
  assert.ok(bar && /display\s*:\s*none/.test(bar.body),
    'the progress bar is visible by default, so a browser without scroll timelines shows an empty rule');
});

/* ---------------- the landing stage ---------------- */

/*
 * The scene is allowed to fail, and it fails to a picture rather than to a
 * hole. The 1.5MB of video this replaced was a landing page nobody waited for
 * on a slow connection, and a flat rectangle on any build without the codec.
 * The portal draws itself, so the still and the motion are the same picture:
 * a reader who asked for less motion gets one frame of it rather than a
 * substitute image that has to be shipped, kept in step, and proven to paint.
 *
 * What that costs instead is WebGL, which can be absent for reasons that are
 * none of the reader's business. So the markup guard is not that the canvas
 * works -- it is that nothing on this page depends on it working.
 */
check('the landing scene draws itself rather than shipping a picture', () => {
  const tag = htmlSource.match(/<canvas[^>]*id="lpPortal"[^>]*>/);
  assert.ok(tag, 'the landing canvas is gone');
  assert.ok(/class="[^"]*\blp-portal\b/.test(tag[0]),
    'the canvas does not carry .lp-portal, so none of the stage styling reaches it');

  /*
   * The scene ships no media at all now. Asserting the files are absent is
   * the guard that catches the video being restored beside the canvas and
   * quietly downloaded again by a browser that still has the old markup
   * cached -- and it is what keeps the weight claim honest.
   */
  ['assets/orbit-hero.mp4', 'assets/orbit-hero.webm', 'assets/orbit-hero.jpg'].forEach(file => {
    assert.ok(!fs.existsSync(path.join(root, 'public', file)),
      `${file} is still in the build; the scene is meant to cost no download`);
  });
  assert.ok(!/<video[^>]*id="lpVideo"/.test(htmlSource),
    'the landing video is back, so the scene has two subjects and one of them is 1.5MB');

  /*
   * The canvas is transparent until the first frame lands, so it is held at
   * zero opacity and revealed by a class the script only adds once something
   * has been drawn. That gate is allowed to reach the canvas and nothing
   * else: a rule that holds the stage or the ground at zero takes the whole
   * picture away on any build where the reveal never runs.
   */
  const portalRules = rules.filter(rule => eachSelector(rule).some(one => /\.lp-portal\b/.test(one.selector)));
  assert.ok(portalRules.length, 'the canvas has no styling of its own, so it has no size');
  const gated = rules.filter(rule => /opacity\s*:\s*0(\D|$)/.test(rule.body))
    .flatMap(eachSelector).map(one => one.selector)
    .filter(selector => /\.lp-(portal|stage|ground|glow)\b/.test(selector));
  assert.ok(gated.length, 'nothing holds the canvas back until it has drawn a frame');
  assert.ok(gated.every(selector => /\.lp-portal\b/.test(selector)),
    `the reveal gate reaches past the canvas itself: ${gated.join(' | ')}`);
  assert.ok(rules.some(rule => eachSelector(rule).some(one => /\.lp-portal\.is-live\b/.test(one.selector))
      && /opacity\s*:\s*1/.test(rule.body)),
    'nothing brings the canvas back, so the scene is held at zero opacity forever');

  /*
   * The ring script has to be in the document before the script that drives
   * it, or the driver finds no factory and hides the canvas on every load.
   */
  /*
   * Matched as a <script> tag, not as a filename. Reading the first mention
   * of "plasma-ring.js" anywhere in the source finds the comment above the
   * canvas, which sits a thousand lines earlier than either tag and so
   * reports the right order whatever the tags actually do -- this guard was
   * written that way, and swapping the two tags walked straight through it.
   */
  const tagAt = name => htmlSource.indexOf(`<script src="/${name}?v=`);
  const ringAt = tagAt('plasma-ring.js');
  const stageAt = tagAt('landing-stage.js');
  assert.ok(ringAt !== -1, 'the ring script is not in the document');
  assert.ok(stageAt !== -1, 'the landing-stage script is not in the document');
  assert.ok(ringAt < stageAt,
    'landing-stage.js is parsed before plasma-ring.js, so the factory is never there when it looks');
});

/*
 * The vertex count is a cliff, not a slope.
 *
 * Indices are UNSIGNED_SHORT, so the grid may hold 65536 vertices and not one
 * more. Past that the indices wrap to the start of the buffer and the ring
 * draws a garbled subset of itself -- it does not throw, warn, or fail to
 * compile. The density ladder in the module must stay below the cliff on its
 * own, and the clamp in build() is the belt behind it.
 */
check('the ring cannot ask for more vertices than its index type can address', () => {
  const ringSource = fs.readFileSync(path.join(root, 'public/plasma-ring.js'), 'utf8');
  assert.ok(/UNSIGNED_SHORT/.test(ringSource),
    'the index type changed; this guard is measuring a limit that no longer applies');
  const max = Number((ringSource.match(/DENSITY_MAX\s*=\s*(\d+)/) || [])[1]);
  assert.ok(max > 0, 'DENSITY_MAX is gone, so nothing caps the grid');
  /* The same expressions build() uses to turn a density into a grid. */
  const vertices = d => Math.round(d * 2.5) * Math.round(d * 1.8);
  assert.ok(vertices(max) <= 65536,
    `density ${max} asks for ${vertices(max)} vertices; UNSIGNED_SHORT indices wrap at 65536`);
  const ladder = [...ringSource.matchAll(/return\s+(\d+);/g)].map(m => Number(m[1]));
  ladder.filter(value => value > 24 && value <= 400).forEach(value => {
    assert.ok(vertices(value) <= 65536,
      `a density rung of ${value} asks for ${vertices(value)} vertices, past the index limit`);
  });
});

/*
 * Driven, not read.
 *
 * The first version of the video guard this replaces asked whether the source
 * mentioned canPlayType and IntersectionObserver. Both perturbations walked
 * through it: `true || ...` leaves the call in the text while neutering it,
 * and deleting a pause from the observer still left a pause elsewhere in the
 * file for the regex to find. So the module is compiled against a stub
 * document and actually run.
 *
 * The actor changed from a <video> to the ring, and nothing else did: the
 * eligibility rules are the same rules, so these are the same checks with
 * start() and stop() where play() and pause() used to be.
 */
function runLandingStage(options) {
  const settings = options || {};
  const calls = { start: 0, stop: 0, still: 0, theme: [], reaching: [] };
  let running = false;
  const ring = {
    renderStill() { calls.still += 1; },
    start() { if (running) return; running = true; calls.start += 1; },
    stop() { running = false; calls.stop += 1; },
    isRunning: () => running,
    setTheme(name) { calls.theme.push(name); },
    setReaching(on) { calls.reaching.push(!!on); },
    interactive: () => settings.interactive !== false,
    destroy() {}
  };
  /*
   * The canvas records what had been drawn at the moment it was revealed.
   * "Revealed after a frame" is an ordering claim, and a stub that only
   * remembers the final state cannot tell a reveal that waited from one that
   * happened to be followed by a draw.
   */
  const canvas = {
    hidden: false,
    drawnAtReveal: null,
    classList: {
      names: new Set(),
      add(n) {
        if (n === 'is-live' && canvas.drawnAtReveal === null) {
          canvas.drawnAtReveal = calls.start + calls.still;
        }
        this.names.add(n);
      },
      contains(n) { return this.names.has(n); }
    }
  };
  let observerCallback = null;
  /* The scene leans in while focus is inside the access card. Stubs enough of
     the card to run that, rather than to read the source for a class name. */
  const cardListeners = {};
  const docListeners = {};
  const hostListeners = {};
  const mutations = new Map();
  const media = { matches: !!settings.reducedMotion, addEventListener(name, fn) { this.changed = fn; } };
  const connection = { saveData: !!settings.saveData, addEventListener(name, fn) { this.changed = fn; } };
  const gate = { active: true, hidden: false, classList: { contains: () => gate.active } };
  const inside = { name: 'a field in the card' };
  const outside = { name: 'something else on the page' };
  const card = {
    addEventListener(name, fn) { (cardListeners[name] = cardListeners[name] || []).push(fn); },
    contains: node => node === inside
  };
  const lp = {
    classList: {
      names: new Set(),
      add(n) { this.names.add(n); },
      remove(n) { this.names.delete(n); },
      contains(n) { return this.names.has(n); }
    }
  };
  const glow = { style: { props: {}, setProperty(k, v) { this.props[k] = v; } } };
  const hero = {
    addEventListener(name, fn) { (hostListeners[name] = hostListeners[name] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 })
  };
  const documentStub = {
    getElementById: id => {
      if (id === 'page-alpha-access') return gate;
      if (id === 'lpPortal') return settings.noCanvas ? null : canvas;
      return null;
    },
    querySelector: selector => {
      if (selector === '.lp') return settings.noStage ? null : lp;
      if (selector === '.lp-card') return settings.noStage ? null : card;
      if (selector === '.lp-glow') return settings.noGlow ? null : glow;
      if (selector === '.lp-hero') return hero;
      return null;
    },
    activeElement: outside,
    hidden: false,
    documentElement: {
      dataset: {
        motion: settings.motion === false ? 'off' : 'on',
        theme: settings.theme || 'dark'
      }
    },
    addEventListener(name, fn) { (docListeners[name] = docListeners[name] || []).push(fn); },
    removeEventListener(name, fn) { docListeners[name] = (docListeners[name] || []).filter(item => item !== fn); }
  };
  /*
   * A VM context, not an injected parameter. The module closes over
   * `globalThis`, so passing a stub named `global` to new Function() is
   * shadowed by the real one and every matchMedia read silently reaches Node's
   * globalThis instead -- which is how a reduced-motion check that works in a
   * browser looked broken from here.
   */
  const frames = [];
  /*
   * A clock the pump advances, not a constant. Held at zero, every eased step
   * computes dt = 0 and the bloom never moves -- which reads as the easing
   * being broken rather than as the stub standing still.
   */
  const clock = { now: 0 };
  const sandbox = {
    document: documentStub,
    matchMedia: () => media,
    navigator: { connection },
    performance: { now: () => clock.now },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    IntersectionObserver: function (cb) { observerCallback = cb; this.observe = () => {}; },
    /*
     * The filter is modelled, not ignored.
     *
     * A stub that fires every observer callback whatever changed reports a
     * module as watching an attribute it never asked for -- narrowing the
     * real attributeFilter to ['data-motion'] walked straight through the
     * theme guard, because the stub called the callback anyway.
     */
    MutationObserver: function (cb) {
      this.observe = (target, options) =>
        mutations.set(target, { cb, filter: (options && options.attributeFilter) || null });
    },
    NebulaPlasmaRing: settings.noWebgl ? { create: () => null } : { create: () => ring }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/landing-stage.js'), 'utf8'), sandbox, { filename: 'public/landing-stage.js' });
  /* An attribute changes; only the observers that asked for it hear about it. */
  const mutate = (target, attribute) => {
    const watch = mutations.get(target);
    if (!watch) return;
    if (watch.filter && watch.filter.indexOf(attribute) === -1) return;
    watch.cb();
  };
  return {
    calls, ring, canvas, glow,
    motion: value => {
      documentStub.documentElement.dataset.motion = value ? 'on' : 'off';
      mutate(documentStub.documentElement, 'data-motion');
    },
    theme: value => {
      documentStub.documentElement.dataset.theme = value;
      mutate(documentStub.documentElement, 'data-theme');
    },
    gate: value => { gate.active = value; mutate(gate, 'class'); },
    visibility: value => { documentStub.hidden = !value; (docListeners.visibilitychange || []).slice().forEach(fn => fn()); },
    reduced: value => { media.matches = value; if (media.changed) media.changed(); },
    saveData: value => { connection.saveData = value; if (connection.changed) connection.changed(); },
    enter: () => observerCallback && observerCallback([{ isIntersecting: true }]),
    leave: () => observerCallback && observerCallback([{ isIntersecting: false }]),
    sawObserver: () => observerCallback !== null,
    reaching: () => lp.classList.contains('is-reaching'),
    /* A real gesture: the scene does not answer a cursor the browser parked. */
    gesture: () => (docListeners.pointerdown || []).forEach(fn => fn({})),
    focusIn: () => (cardListeners.focusin || []).forEach(fn => fn({})),
    focusOut: stillInside => {
      documentStub.activeElement = stillInside ? inside : outside;
      (cardListeners.focusout || []).forEach(fn => fn({}));
    },
    point: (x, y) => (hostListeners.pointermove || []).forEach(fn => fn({ clientX: x, clientY: y })),
    depart: () => (hostListeners.pointerleave || []).forEach(fn => fn({})),
    pump: n => {
      for (let i = 0; i < (n || 1); i += 1) {
        clock.now += 16;
        const queued = frames.splice(0, frames.length);
        queued.forEach(fn => fn(clock.now));
      }
    },
    pending: () => frames.length
  };
}

check('the scene is revealed only once something has actually been drawn', () => {
  /*
   * The canvas is transparent until a frame lands in it, so fading in an
   * empty one is the flash the poster used to exist to prevent. The module
   * settles the scene once on load rather than waiting for the observer, and
   * that is deliberate -- it is what makes the still immediate -- so the
   * claim being tested is the ordering, not the timing.
   */
  const run = runLandingStage({});
  assert.ok(run.canvas.classList.contains('is-live'),
    'the canvas is never revealed on load, so the stage is empty until the observer reports');
  assert.ok(run.canvas.drawnAtReveal > 0,
    'the canvas was revealed before anything had been drawn into it, which fades in an empty rectangle');

  /* And the running case reveals too, rather than only the held one. */
  const live = runLandingStage({});
  live.enter();
  assert.ok(live.calls.start > 0, 'an eligible scene never started');
  assert.ok(live.canvas.classList.contains('is-live'), 'a running scene is left invisible');
});

check('a build without WebGL loses the subject and keeps the page', () => {
  const run = runLandingStage({ noWebgl: true });
  assert.strictEqual(run.canvas.hidden, true,
    'a canvas that can never draw is left in the layout as a transparent hole');
  assert.strictEqual(run.calls.start, 0, 'something drove a ring that was never created');
});

check('the scene stops when the reader is no longer looking at it', () => {
  const run = runLandingStage({});
  assert.ok(run.sawObserver(),
    'nothing watches whether the scene is on screen, so it renders for the whole session');
  run.enter();
  assert.strictEqual(run.ring.isRunning(), true, 'the visible scene never started');
  run.leave();
  assert.strictEqual(run.ring.isRunning(), false,
    'leaving the screen does not stop the scene; a GPU loop keeps running behind the application');
  assert.ok(run.calls.still > 0, 'the scene went away entirely rather than being held as a frame');
});

check('the scene honours a reader who asked for less motion', () => {
  const off = runLandingStage({ motion: false });
  off.enter();
  assert.strictEqual(off.calls.start, 0, 'the scene animates with the motion setting off');
  assert.ok(off.calls.still > 0, 'the motion setting took the picture away instead of holding it still');
  const reduced = runLandingStage({ reducedMotion: true });
  reduced.enter();
  assert.strictEqual(reduced.calls.start, 0, 'the scene animates despite prefers-reduced-motion');
  assert.ok(reduced.calls.still > 0, 'prefers-reduced-motion took the picture away');
});

check('a gesture cannot bypass a later stop-animation preference', () => {
  const run = runLandingStage({});
  run.enter();
  run.motion(false);
  run.gesture();
  assert.strictEqual(run.ring.isRunning(), false, 'a gesture restarted the scene after motion was disabled');
  assert.strictEqual(run.calls.start, 1, 'the scene was started again after motion was disabled');
});

check('enabling motion while the scene is offscreen does not restart it', () => {
  const run = runLandingStage({});
  run.enter(); run.leave(); run.motion(false); run.motion(true);
  assert.strictEqual(run.ring.isRunning(), false, 'an offscreen scene restarted');
  assert.strictEqual(run.calls.start, 1, 'an offscreen scene restarted');
  run.enter();
  assert.strictEqual(run.calls.start, 2, 'the visible scene did not resume');
});

check('a hidden gate stands the scene down', () => {
  const run = runLandingStage({});
  run.enter(); run.gate(false); run.motion(false); run.motion(true);
  assert.strictEqual(run.ring.isRunning(), false, 'the inactive landing screen kept rendering');
  assert.strictEqual(run.calls.start, 1);
});

check('Save-Data, OS motion and tab visibility all control the scene live', () => {
  const saved = runLandingStage({ saveData: true });
  saved.enter();
  assert.strictEqual(saved.calls.start, 0, 'Save-Data was ignored');
  saved.saveData(false);
  assert.strictEqual(saved.calls.start, 1);
  for (const boundary of ['saveData', 'reduced', 'visibility']) {
    const run = runLandingStage({});
    run.enter(); run[boundary](boundary !== 'visibility');
    assert.strictEqual(run.ring.isRunning(), false, boundary + ' did not stop the scene');
    run[boundary](boundary === 'visibility');
    assert.strictEqual(run.calls.start, 2, boundary + ' did not resume an eligible scene');
  }
});

/*
 * The signature moment has to reach the geometry.
 *
 * It began as a transform on the stage, which meant the scene did not answer
 * the reader so much as get scaled while it carried on doing what it was
 * doing. The class is still carried for CSS; this is the half that makes the
 * ring itself lean in, and it is the half a refactor drops silently because
 * the visible transform keeps working without it.
 */
check('the moment reaches the ring and not only the stylesheet', () => {
  const run = runLandingStage({});
  run.gesture();
  assert.deepStrictEqual(run.calls.reaching, [], 'the scene leaned in before anyone had focused the card');
  run.focusIn();
  assert.ok(run.reaching(), 'the stage never takes the class the stylesheet keys on');
  assert.deepStrictEqual(run.calls.reaching, [true], 'the ring was never told the reader had reached for the card');
  run.focusOut(true);
  assert.deepStrictEqual(run.calls.reaching, [true], 'moving between controls in the card made the ring flinch');
  run.focusOut(false);
  assert.ok(!run.reaching(), 'the stage keeps the class after focus has left the card');
  assert.deepStrictEqual(run.calls.reaching, [true, false], 'the ring was never told the reader had left');
});

check('the scene follows the theme rather than reading it once at load', () => {
  const run = runLandingStage({ theme: 'light' });
  assert.deepStrictEqual(run.calls.theme, ['light'],
    'the ring is built in the dark palette whatever theme the page loaded in');
  run.theme('dark');
  assert.deepStrictEqual(run.calls.theme, ['light', 'dark'],
    'switching the theme leaves the scene in the palette it started in');
});

/*
 * Gradient stop positions cannot be transitioned, so the easing has to happen
 * in JS -- and a loop that never stops is a phone that never sleeps. It runs
 * while the light is still travelling and gives the frame back once it has
 * arrived.
 */
check('the bloom eases toward the pointer and stops once it is there', () => {
  const run = runLandingStage({});
  run.enter();
  /*
   * Run to a standstill rather than for a fixed count. The loop ends itself
   * when it is close enough, so "how many frames" is a property of the easing
   * constant and asserting it would break on any tuning of the feel; that the
   * loop ends at all, under the pointer, is the contract.
   */
  const settle = limit => {
    let frames = 0;
    while (run.pending() && frames < (limit || 600)) { run.pump(1); frames += 1; }
    return frames;
  };

  run.point(900, 400);
  assert.ok(run.pending() > 0, 'nothing was scheduled, so the bloom never moves');
  const frames = settle();
  const x = parseFloat(run.glow.style.props['--gx']);
  const y = parseFloat(run.glow.style.props['--gy']);
  assert.ok(Math.abs(x - 90) < 0.5, `the bloom settled at ${x}% rather than under the pointer at 90%`);
  assert.ok(Math.abs(y - 80) < 0.5, `the bloom settled at ${y}% rather than under the pointer at 80%`);
  assert.strictEqual(run.pending(), 0,
    'the bloom keeps asking for frames after it has arrived, which is a loop that never ends');

  /*
   * Eased, not written straight through. A handler that assigns the pointer
   * position directly would satisfy every assertion above on its first frame,
   * and snap in the browser -- gradient stop positions carry no transition of
   * their own to smooth it.
   */
  assert.ok(frames > 5, `the bloom arrived in ${frames} frames, which is a jump rather than a glide`);

  run.depart();
  settle();
  assert.ok(Math.abs(parseFloat(run.glow.style.props['--gx']) - 50) < 0.5,
    'the bloom does not return to rest when the pointer leaves the scene');
});

check('stopping motion stops the bloom too, including a frame already queued', () => {
  for (const boundary of ['motion', 'reduced', 'saveData', 'visibility', 'gate']) {
    const run = runLandingStage({});
    run.enter();
    run.point(900, 400);
    run.pump(2);
    run[boundary](['reduced', 'saveData'].includes(boundary));
    const held = { ...run.glow.style.props };
    run.point(100, 100);
    run.pump(10);
    assert.deepStrictEqual(run.glow.style.props, held, boundary + ' left the bloom moving');
  }
});

check('a pointer that cannot hover gets no bloom loop at all', () => {
  const run = runLandingStage({ interactive: false });
  run.point(900, 400);
  assert.strictEqual(run.pending(), 0,
    'a phone is running an animation loop to move a gradient no finger can address');
  assert.strictEqual(run.glow.style.props['--gx'], undefined,
    'the bloom was moved on a device with no pointer to follow');
});

/*
 * The gate kept every control it had. This page is a landing page wrapped
 * around the access flow, not a replacement for it, and the flow's contract is
 * the ids and labels the browser suite reaches for.
 */
check('the access flow survived being given a stage', () => {
  const gate = htmlSource.slice(htmlSource.indexOf('id="page-alpha-access"'));
  ['alphaWakeState', 'alphaInviteInput', 'alphaTermsAccept', 'alphaTermsVersion',
   'alphaRedeemBtn', 'alphaAccessError', 'alphaAccessTitle'].forEach(id => {
    assert.ok(new RegExp(`id="${id}"`).test(gate), `the access flow lost #${id}`);
  });
  assert.ok(/class="page active" id="page-alpha-access"/.test(htmlSource),
    'the gate is no longer the initially painted screen');
  /*
   * The heading is this landmark's accessible name, and the browser suite
   * finds the screen by it. Line breaks inside it are fine -- the name
   * computation folds them to spaces -- but the words cannot change.
   */
  const heading = gate.match(/id="alphaAccessTitle"[^>]*>([\s\S]*?)<\/h1>/);
  assert.ok(heading, 'the gate heading is gone');
  const flattened = heading[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  assert.strictEqual(flattened, 'Enter the Nebulaverse-X test orbit',
    `the screen's accessible name changed to "${flattened}"; the browser suite finds this landmark by it`);
});

/*
 * Focusing an input scrolls it into view. On a bare gate that was helpful; on
 * a landing page it threw the reader past the headline before they had read a
 * word of it -- measured at 323px on a phone.
 */
check('raising the gate does not scroll the page past its own headline', () => {
  const alphaSource = fs.readFileSync(path.join(root, 'public/alpha-ui.js'), 'utf8');
  const focuses = [...alphaSource.matchAll(/invite\.focus\(([^)]*)\)/g)];
  assert.ok(focuses.length >= 1, 'nothing focuses the invitation any more');
  focuses.forEach(match => {
    assert.ok(/preventScroll:\s*true/.test(match[1]),
      'the invitation is focused without preventScroll, which scrolls the landing page away');
  });
});

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

/* ---------------- every layer, none forgotten ---------------- */

/*
 * Six scrims plus the floating action menu. The menu is the one that was
 * missed: it is not a scrim, so a check that enumerates scrims does not see
 * it, and it opened on an animation and closed with `hidden = true` -- exactly
 * the cut the other six were fixed for. Named here so the set is seven.
 */
check('the floating action menu leaves the way it arrived', () => {
  const close = appSource.slice(appSource.indexOf('function closeFloatingActions'));
  const body = close.slice(0, close.indexOf('\n}'));
  assert.ok(/closeOverlay\(menu\)/.test(body),
    'the floating action menu is still cut away instead of animated out');
  assert.ok(!/menu\.hidden\s*=\s*true/.test(body),
    'the floating action menu still hides itself directly, which skips the exit');
  const open = appSource.slice(appSource.indexOf('function openFloatingActions'));
  const openBody = open.slice(0, open.indexOf('\n}'));
  assert.ok(/openOverlay\(menu\)/.test(openBody),
    'the floating action menu is shown without cancelling a pending close');
  assert.ok(/preventScroll/.test(openBody),
    'the first entry is focused without preventScroll, so the browser scrolls it into view mid-animation');
  /*
   * An unanchored search finds the motion-off rule, whose body is
   * `animation:none` -- which would report an exit while there is none. The
   * rule that matters is one that actually names an animation to run.
   */
  const fabExit = [...cssSource.matchAll(/([^{}]*\.nv-fab-menu\[data-closing\][^{}]*)\{([^}]*)\}/g)]
    .some(rule => /animation\s*:/.test(rule[2]) && !/animation\s*:\s*none/.test(rule[2]));
  assert.ok(fabExit,
    'there is no exit animation for the floating action menu, so its close is instant');
});

check('every focus taken on an opening layer declines the scroll', () => {
  /*
   * Focusing an element inside a layer that is still moving makes the browser
   * scroll it into view, and the jump lands on top of the animation. Four
   * layers take focus as they open.
   */
  const focuses = appSource.match(/\.focus\(\{ preventScroll: true \}\)/g) || [];
  assert.ok(focuses.length >= 4,
    `only ${focuses.length} focus calls decline the scroll; the rail, the modal, the palette and the floating menu all take focus while still animating`);
});

/* ---------------- a sign-in that did not finish ---------------- */

check('a failed OAuth exchange returns to the application', () => {
  const route = serverSource.slice(serverSource.indexOf("app.get('/api/oauth/callback'"));
  const body = route.slice(0, route.indexOf('\napp.get('));
  /*
   * Every failure used to end on a bare page with no navigation: the only way
   * back was to retype the address. A reader on a phone should never be asked
   * to do that.
   */
  assert.ok(!/res\.status\(\d+\)\.send\(/.test(body),
    'a failed sign-in still ends on a bare page the reader has to escape by editing the address bar');
  assert.ok(/res\.redirect\(`\/\?oauth=/.test(body),
    'a failed sign-in does not return to the application with a reason');
  assert.ok(/Max-Age=0/.test(body),
    'the state cookie is not cleared on failure, so a retry replays a code the provider has already spent');
});

check('the token response is parsed defensively', () => {
  const route = serverSource.slice(serverSource.indexOf("app.get('/api/oauth/callback'"));
  const body = route.slice(0, route.indexOf('\napp.get('));
  /*
   * The provider answers with an HTML page when it refuses the request itself
   * rather than the exchange. Handing that straight to a JSON parser throws
   * "Unexpected token '<'", and that message reached the reader verbatim.
   */
  assert.ok(!/await tr\.json\(\)/.test(body),
    'the token response is parsed as JSON unguarded, so an HTML error page throws a parser message at the reader');
  assert.ok(/tr\.text\(\)/.test(body) && /JSON\.parse/.test(body),
    'the response is not read as text and parsed under a guard');
  assert.ok(/td\.error/.test(body),
    "the provider's own refusal is discarded, so an expired code reports nothing useful");
});

check('the reader is told which failure it was', () => {
  assert.ok(/function oauthCallbackNotice/.test(appSource), 'nothing reads the failure back out of the address bar');
  assert.ok(/bad_verification_code/.test(appSource),
    'a spent or expired sign-in link has no plain-language explanation');
  assert.ok(/history\.replaceState/.test(appSource.slice(appSource.indexOf('function oauthCallbackNotice'))),
    'the parameter is left in the address bar, so refreshing repeats the message about an attempt that is over');
});

/* ---------------- two grounds on one screen ---------------- */

check('the moving ground yields where the galaxy is drawn', () => {
  assert.ok(/#page-repos\.active\)?[^{]*#lightWaves\{[^}]*display:none/.test(cssSource),
    'the waves still run underneath the galaxy on the repositories screen, where two full-bleed animations compete');
  /*
   * display:none, not opacity: light-waves.js holds when it has no box to
   * measure, so removing it from the layout also ends its render loop.
   */
  const rule = cssSource.match(/body:has\(#page-repos\.active\) #lightWaves\{([^}]*)\}/);
  assert.ok(rule && /display:none/.test(rule[1]),
    'the waves are hidden by painting rather than by layout, so the loop keeps running behind the galaxy');
});

/*
 * The landing owes the same yield, for the same reason and with the same
 * mechanism: it mounts the plasma portal, so the waves there were a second
 * full-bleed animation -- running as a column of violet verticals straight
 * through the copy on the one screen whose whole job is to be read once.
 *
 * Asserted as its own rule rather than folded into the selector above, because
 * each screen states its own reason for standing the ground down and a shared
 * selector would make one of them disappear into the other's.
 */
/*
 * The overview's cards arrive on a scroll-driven timeline, and the range has
 * to be one the last card can reach.
 *
 * `cover` runs from the card meeting the viewport to it leaving on the far
 * side. The bottom card has nowhere to leave to -- the document ends under it
 * -- so the scroll runs out and the reveal stops wherever it had got to.
 * Measured at 0.86 opacity with its 22px offset still applied while the card
 * was fully on screen: faded, and pushed down under a gap where it should
 * have been. `entry` ends when the card has finished arriving, which every
 * card reaches.
 *
 * Asserted against the stylesheet rather than in a browser. The difference
 * between the two ranges is only visible at a scroll position where the last
 * card has finished entering and the page has not yet bottomed out; at the
 * bottom both have completed. Several browser assertions written for that
 * window passed against the broken range as well, and a guard that cannot
 * fail is worse than no guard, so this pins the rule instead of the symptom.
 */
check('the overview reveal uses a range its last card can finish', () => {
  const block = cssSource.match(/#page-overview \.wp-card\{([^}]*)\}/);
  assert.ok(block, 'the overview card arrival rule is gone');
  const range = block[1].match(/animation-range:([^;]+);/);
  assert.ok(range, 'the arrival has no range, so it runs on the default cover');
  assert.ok(!/\bcover\b/.test(range[1]),
    `the reveal is measured in cover (${range[1].trim()}), which the last card on the page cannot finish`);
  assert.ok(/\bentry\b/.test(range[1]),
    'the reveal is not measured in entry, so nothing guarantees the last card completes');
});

check('the moving ground yields where the landing draws its portal', () => {
  const rule = cssSource.match(/body:has\(#page-alpha-access\.active\) #lightWaves\{([^}]*)\}/);
  assert.ok(rule,
    'the waves still run underneath the invitation hero, where the portal is already drawing');
  assert.ok(/display:none/.test(rule[1]),
    'the waves are hidden by painting rather than by layout, so the loop keeps running behind the portal');
});

/* ---------------- typed on a phone ---------------- */

check('every exact-match confirmation declines the phone keyboard', () => {
  /*
   * The server compares these character for character. iOS turns autocorrect
   * and smart punctuation on by default and neither is disabled by
   * spellcheck="false" -- a login with hyphens comes back with en-dashes in
   * their place, indistinguishable at a glance and guaranteed to fail. Any
   * input the user must retype exactly has to decline those features.
   */
  const ids = ['stepUpLogin', 'alphaDeleteConfirm', 'recConfirm'];
  ids.forEach(id => {
    const tag = appSource.match(new RegExp(`<input id="${id}"[^>]*>`));
    assert.ok(tag, `${id} is gone`);
    for (const attribute of ['autocorrect="off"', 'autocapitalize="off"', 'spellcheck="false"']) {
      assert.ok(tag[0].includes(attribute),
        `${id} does not set ${attribute}, so a phone keyboard can silently rewrite what is typed into it`);
    }
  });
});

check('a mismatch is named before a request is spent on it', () => {
  const fn = appSource.slice(appSource.indexOf('async function requestStepUp'));
  const body = fn.slice(0, fn.indexOf('\nasync function stepUpApi'));
  assert.ok(/confirm !== login/.test(body),
    'the typed value is never compared here, so a mismatch costs a round trip and comes back as a dialog that cannot say what was wrong');
  assert.ok(/return ''/.test(body.slice(body.indexOf('confirm !== login'))),
    'a mismatch does not stop the flow, so it is sent anyway');
});

/* ---------------- a way out of the sheet ---------------- */

check('the bottom sheet offers a control that closes it', () => {
  /*
   * Dismissal was a swipe, the scrim, or Escape, and the sheet showed none of
   * them. A tall menu on a phone leaves the scrim a thin strip, so a reader
   * who does not know the gesture has nothing to press.
   */
  assert.ok(/id="sheetClose"/.test(htmlSource), 'the sheet has no close control');
  const tag = htmlSource.match(/<button[^>]*id="sheetClose"[^>]*>/)[0];
  assert.ok(/aria-label="[^"]+"/.test(tag), 'the sheet close control has no accessible name');
  assert.ok(/\$\('#sheetClose'\)[^\n]*addEventListener\('click', closeSheet\)/.test(appSource),
    'the sheet close control is not wired to closeSheet');
  const head = cssSource.match(/\.sheet-head\{([^}]*)\}/);
  assert.ok(head && /position:sticky/.test(head[1]),
    'the sheet header is not sticky, so the way out scrolls off the top of a long menu');
});

/* ---------------- state chips on a narrow bar ---------------- */

check('the state chips keep their names after losing their words', () => {
  ['roChip', 'freezeChip'].forEach(id => {
    const tag = htmlSource.match(new RegExp(`<span[^>]*id="${id}"[^>]*>`));
    assert.ok(tag, `${id} is gone`);
    assert.ok(/title="[^"]+"/.test(tag[0]), `${id} has no tooltip, so a pointer gets no name`);
  });
  /*
   * Visually hidden, not display:none. The word is what a screen reader reads;
   * removing it from the box would take the meaning with the width.
   */
  const rule = cssSource.match(/\.ro-chip \.ro-word\{([^}]*)\}/);
  assert.ok(rule, 'nothing hides the chip words on a narrow bar');
  assert.ok(!/display\s*:\s*none/.test(rule[1]),
    'the chip word is display:none, which takes it out of the accessibility tree along with the layout');
  assert.ok(/clip/.test(rule[1]), 'the chip word is not visually hidden in a way that keeps it readable');
});

/* ---------------- chrome that had to be seen to be wrong ---------------- */

check('a destructive confirm is filled, not red lettering on a violet fill', () => {
  const ok = htmlSource.match(/<button[^>]*id="modalOk"[^>]*>/);
  assert.ok(ok, '#modalOk is gone');
  assert.ok(/btn-primary/.test(ok[0]),
    'the confirm is no longer the primary button; this check is about that pairing');
  /*
   * `.danger` sets only a colour, which is right on a ghost button and wrong
   * on a filled one. Without a rule for the pair, every dangerous dialog drew
   * red text on the violet fill.
   */
  assert.ok(/\.btn-primary\.danger\s*\{[^}]*background\s*:/.test(cssSource),
    'nothing gives the primary button a danger fill, so a destructive confirm is red text on violet');
  const rule = cssSource.match(/\.btn-primary\.danger\s*\{([^}]*)\}/)[1];
  assert.ok(/color\s*:\s*#fff|color\s*:\s*white/i.test(rule),
    'the danger fill does not set its own text colour, so it inherits the red and disappears into the fill');
});

check('sign out keeps its name after losing its label', () => {
  /*
   * Two of the three lost their visible text to give a phone's top bar its
   * width back. A control identified only by a mark still has to be reachable
   * by name, and the browser suite finds this one by its accessible name.
   */
  const marks = [...htmlSource.matchAll(/<button[^>]*class="[^"]*btn-signout[^"]*"[^>]*>/g)];
  assert.ok(marks.length >= 2, `expected at least two icon sign-out controls, found ${marks.length}`);
  marks.forEach(match => {
    assert.ok(/aria-label="Sign out"/.test(match[0]),
      `a sign-out mark has no accessible name: ${match[0].slice(0, 90)}`);
    assert.ok(/title="Sign out"/.test(match[0]),
      'a sign-out mark has no tooltip, so a pointer gets no name at all');
  });
  const worded = htmlSource.match(/<button[^>]*id="logoutBtnM"[^>]*>([^<]*)</);
  assert.ok(worded && /Sign out/.test(worded[1]),
    'the menu entry lost its visible text too; a list of worded entries should not make a reader decode an arrow');
});

check('a layer on its way out stops taking presses', () => {
  const inert = rules.some(rule => rule.selector.includes('[data-closing]') && /pointer-events\s*:\s*none/.test(rule.body));
  assert.ok(inert,
    'a dismissing overlay is still clickable, so a second press restarts a dismissal already under way');
});

/* ---------------- lifting a function out of the shell ---------------- */

/*
 * public/app.js is a classic script, not a module: there is nothing to
 * require. These checks want behaviour rather than the shape of the text, so
 * the named function is cut out of the source and compiled on its own with
 * whatever it closes over passed in. A rewrite that keeps the words and loses
 * the behaviour fails here; one that changes the words and keeps the behaviour
 * passes. That is the whole point of doing it this way instead of matching a
 * regex against the body.
 */
function liftFunction(name, params) {
  const opener = `function ${name}(`;
  const at = appSource.indexOf(opener);
  assert.ok(at >= 0, `${name} is gone from app.js`);
  let depth = 0;
  let started = false;
  let end = at;
  for (let i = at; i < appSource.length; i++) {
    const ch = appSource[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > at, `could not find the end of ${name}`);
  const body = appSource.slice(at, end);
  return new Function(...params, `${body}\nreturn ${name};`);
}

function fakeElement(rect) {
  const style = {};
  return {
    isConnected: true,
    hidden: false,
    textContent: '',
    style: {
      setProperty: (k, v) => { style[k] = v; },
      removeProperty: k => { delete style[k]; },
      read: k => style[k]
    },
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getBoundingClientRect: () => rect
  };
}

/* ---------------- the control that was removed, not renamed ---------------- */

/*
 * Derived from the feature markers rather than from the words on the buttons.
 * A control renamed to "Create repository" while still wired to the search
 * capability would read correctly and behave as the old one; this fails it.
 */
check('the repositories screen offers no cross-repository search, under any name', () => {
  const screen = htmlSource.match(/<main[^>]*id="page-repos"[\s\S]*?<\/main>/);
  assert.ok(screen, 'the repositories screen is gone');
  const markers = [...screen[0].matchAll(/data-feature="([^"]+)"/g)].map(m => m[1]);
  assert.ok(!markers.includes('global-search'),
    'a control on the repositories screen still declares the global-search capability');
  assert.ok(!/search code/i.test(screen[0]),
    'the words "search code" are still on the repositories screen');
  /*
   * The handler is the other half. A hidden binding that still reaches the
   * endpoint is the control surviving without its label, which is exactly what
   * "removed, not renamed" is supposed to rule out.
   */
  assert.ok(!/globalCodeSearch/.test(appSource),
    'app.js still carries a cross-repository search path, so the control was hidden rather than removed');
});

check('creating a repository is offered on the screen that lists them, once', () => {
  const creators = [...htmlSource.matchAll(/<button[^>]*data-feature="repository\.create"[^>]*>/g)];
  assert.strictEqual(creators.length, 1,
    `repository.create is declared on ${creators.length} controls; two copies of one action is what the top bar had`);
  const screen = htmlSource.match(/<main[^>]*id="page-repos"[\s\S]*?<\/main>/)[0];
  assert.ok(screen.includes(creators[0][0]),
    'the create control is not on the repositories screen');
  const id = creators[0][0].match(/id="([^"]+)"/);
  assert.ok(id, 'the create control has no id, so nothing can bind to it');
  /*
   * Mechanism, not markup: the button has to run the create flow. Without this
   * the check passes on a button that looks right and does nothing.
   */
  const bound = new RegExp(`#${id[1]}'\\)[\\s\\S]{0,120}addEventListener\\('click',\\s*createRepositoryFlow`);
  assert.ok(bound.test(appSource),
    `#${id[1]} is not bound to the create flow`);
  assert.ok(/aria-label="[^"]+"/.test(creators[0][0]) || />\s*<svg/.test(creators[0][0]),
    'the create control carries a mark with no accessible name');
});

check('the create mark is drawn, not a letter standing in for one', () => {
  const button = htmlSource.match(/<button[^>]*data-feature="repository\.create"[\s\S]*?<\/button>/);
  assert.ok(button, 'the create control is gone');
  assert.ok(/<svg[\s\S]*?<\/svg>/.test(button[0]),
    'the create control has no inline mark');
  /* A plus alone is any create button anywhere. The planet is what makes it
     this product's create button, so both strokes have to be present. */
  assert.ok(/nv-planet-body/.test(button[0]) && /nv-planet-plus/.test(button[0]),
    'the mark is missing either its body or its plus, so it is not the planet+ mark');
  assert.ok(/aria-hidden="true"/.test(button[0].match(/<svg[^>]*>/)[0]),
    'the decorative mark is exposed to a screen reader beside the name it duplicates');
});

/* ---------------- an unread count with a source ---------------- */

check('the unread marker counts what the session was actually told', () => {
  const make = liftFunction('paintUnread', ['$']);
  const marker = fakeElement({ width: 10, height: 10, left: 0, top: 0 });
  const bell = fakeElement({ width: 30, height: 30, left: 0, top: 0 });
  const paint = make(selector => (selector === '#notifUnread' ? marker : selector === '#notifBtn' ? bell : null));

  const entries = n => Array.from({ length: n }, () => ({ unread: true }));

  paint([]);
  assert.strictEqual(marker.hidden, true, 'the marker shows with nothing unread');

  paint(entries(1).concat([{ unread: false }, { unread: false }]));
  assert.strictEqual(marker.hidden, false, 'one unread entry lights nothing');
  assert.strictEqual(marker.textContent, '', 'a single unread draws a number where a dot is enough');
  assert.ok(/1 unread/.test(bell.attributes['aria-label']),
    `the bell does not say the count out loud: ${bell.attributes['aria-label']}`);

  paint(entries(4));
  assert.strictEqual(marker.textContent, '4', 'four unread entries do not read as 4');

  paint(entries(40));
  assert.strictEqual(marker.textContent, '9+',
    'a large count is printed in full, which is the oversized badge this was meant to avoid');

  /*
   * The falsifying case. A marker that is painted from a constant passes every
   * check above that only looks at a fixed list; feeding it two different real
   * lists is what separates a reading from a decoration.
   */
  paint(entries(2));
  const two = marker.textContent;
  paint(entries(7));
  assert.notStrictEqual(two, marker.textContent,
    'the marker prints the same thing for two different lists, so it is not reading the list');

  paint(null);
  assert.strictEqual(marker.hidden, true, 'an absent list is treated as unread mail');
});

check('the unread marker is asked for from the notifications the server holds', () => {
  const load = appSource.slice(appSource.indexOf('async function loadNotifications'), appSource.indexOf('async function refreshUnread'));
  assert.ok(/await api\('\/api\/notifications'\)/.test(load) && /paintUnread\(list\)/.test(load),
    'the identity-checked loader must paint the provider notification list');
  const refresh = appSource.slice(appSource.indexOf('async function refreshUnread'));
  assert.ok(/await loadNotifications\(\)/.test(refresh), 'refresh must use the guarded loader');
  assert.ok(/decision\('notifications'\)/.test(refresh.slice(0, 600)),
    'the refresh asks without checking the capability first, so a refused deployment is polled to be told no');
});

/*
 * The first version of this only painted at boot, so a reader who signed in
 * during the session never saw the marker light and a reader who signed out
 * kept the previous session's count over a bell they could no longer open.
 * Both directions are read off the function bodies that own them.
 */
check('the marker follows the session in both directions', () => {
  const bodyOf = name => {
    const at = appSource.indexOf(`function ${name}`);
    assert.ok(at >= 0, `${name} is gone`);
    return appSource.slice(at, appSource.indexOf('\n}\n', at));
  };
  assert.ok(/refreshUnread\(\)/.test(bodyOf('doLogin')),
    'signing in does not ask for the unread count, so the marker stays dark until the next page load');
  assert.ok(/paintUnread\(\[\]\)/.test(bodyOf('purgeLocalData')),
    'the identity teardown does not clear the marker, so one session\'s count survives into the next');
  /*
   * The teardown sweeps a list of elements by clearing values and children.
   * The marker is neither, so a rewrite that adds it to that list instead of
   * calling the painter would leave it visible and empty.
   */
  const refresh = bodyOf('refreshUnread');
  assert.ok(/if \(!state\.me\)[^\n]*paintUnread/.test(refresh),
    'refreshUnread returns early on a session with no identity without clearing what the last one lit');
});

check('a marker with no number is a dot, not an empty box', () => {
  const empty = cssSource.match(/\.nv-unread:empty\{([^}]*)\}/);
  assert.ok(empty, 'nothing shrinks the marker when it carries no count');
  assert.ok(/width\s*:/.test(empty[1]) && /height\s*:/.test(empty[1]),
    'the countless marker keeps the width of a counted one, so an empty badge sits on the bell');
});

/* ---------------- menus that grow from where they were opened ---------------- */

check('a panel grows from the control that opened it', () => {
  const anchor = liftFunction('anchorOverlayOrigin', [])();
  const panel = fakeElement({ width: 400, height: 300, left: 100, top: 100 });

  /* Opened from the top-left corner of the panel. */
  anchor(panel, fakeElement({ width: 20, height: 20, left: 100, top: 100 }));
  const near = panel.style.read('--nv-origin');
  assert.ok(near, 'no origin was written at all');

  /* Opened from the far corner. Same panel, different opener: if the origin is
     a constant dressed up as a computation, these two agree. */
  anchor(panel, fakeElement({ width: 20, height: 20, left: 480, top: 380 }));
  const far = panel.style.read('--nv-origin');
  assert.notStrictEqual(near, far,
    'two openers at opposite corners produce the same origin, so the panel is not anchored to anything');

  /* Off-screen openers must not swing the panel in from outside itself. */
  anchor(panel, fakeElement({ width: 20, height: 20, left: -4000, top: -4000 }));
  const [ox, oy] = panel.style.read('--nv-origin').split(/\s+/).map(parseFloat);
  assert.ok(ox >= -35 && ox <= 135 && oy >= -35 && oy <= 135,
    `a distant opener put the origin at ${ox}% ${oy}%, which throws the panel in from off-screen`);

  /* No opener, no claim: the panel falls back to its own default rather than
     keeping the origin of whatever opened it last. */
  anchor(panel, null);
  assert.strictEqual(panel.style.read('--nv-origin'), undefined,
    'an unanchored panel keeps the previous origin, so it grows from the last control instead of itself');
});

check('the cascade actually reads the origin the shell writes', () => {
  const consumers = rules.filter(rule => /transform-origin\s*:\s*var\(--nv-origin/.test(rule.body));
  assert.ok(consumers.length >= 3,
    `only ${consumers.length} rules read --nv-origin; the modal, the palette and the action menu all animate`);
  /*
   * A fallback is not optional. The property is only set when there is an
   * opener to anchor to, so a rule without one animates from the box corner
   * the first time a layer opens by keyboard.
   */
  consumers.forEach(rule => {
    assert.ok(/var\(--nv-origin\s*,/.test(rule.body),
      `${rule.selector} reads --nv-origin with no fallback, so an unanchored open grows from the corner`);
  });
  /*
   * transform-origin is what scale and rotation turn about; a translation
   * renders identically whatever the origin is. So the exits this applies to
   * are the ones that scale, read out of the keyframes each exit actually
   * runs rather than from a list of selectors kept in step by hand. A backdrop
   * that only fades and a sheet that only slides up from the bottom edge both
   * fall out on their own, which is right: neither has a point to grow from.
   */
  const transforming = exits.filter(rule => {
    const named = rule.body.match(/animation\s*:\s*([\w-]+)/);
    return !!named && /\bscale\(|\brotate\(/.test(keyframeBody(named[1]));
  });
  assert.ok(transforming.length >= 3,
    `only ${transforming.length} overlay exits scale their panel; this check has nothing left to prove`);
  const anchored = new Set(consumers.flatMap(eachSelector).map(one => subject(one.selector)));
  new Set(transforming.map(rule => subject(rule.selector))).forEach(name => {
    assert.ok(anchored.has(name),
      `${name} scales on the way out from a different origin than it grew from`);
  });
});

/* ---------------- the overview surface ---------------- */

/*
 * Derived from app.js, not restated here. The visuals registry names the
 * element each artwork mounts into; if the hero is rebuilt and a mount point
 * is dropped, the registry silently points at nothing and the panel is an
 * empty frame on every device that can draw.
 */
check('every artwork the shell mounts still has somewhere to mount', () => {
  const registry = appSource.match(/const NEBULA_VISUALS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(registry, 'the visuals registry is gone');
  const mounts = [...registry[1].matchAll(/'#([\w-]+)'/g)].map(m => m[1]);
  assert.ok(mounts.length >= 2, `the registry names ${mounts.length} mount points`);
  /* Nebula's Trust core is the dimensional mark; Obsidian keeps the SVG emblem. */
  assert.ok(mounts.includes('ovCoreArt'), 'the overview no longer mounts the dimensional mark');
  assert.ok(/kind === 'mark' && state\.settings\.design === 'obsidian'/.test(appSource),
    'the mark is mounted in Obsidian, where the stage belongs to the emblem');
  mounts.forEach(id => {
    assert.ok(new RegExp(`id="${id}"`).test(htmlSource),
      `#${id} is named as an artwork mount but is not in the document`);
  });
});

check('the overview keeps a ground under the artwork it may not be able to draw', () => {
  const art = htmlSource.match(/<div[^>]*id="ovCoreArt"[\s\S]*?<\/div>/);
  assert.ok(art, 'the overview artwork mount is gone');
  assert.ok(/ov-core-glow/.test(art[0]),
    'the mount has no still ground inside it, so a device that refuses WebGL gets an empty frame');
  assert.ok(/aria-hidden="true"/.test(art[0]),
    'decorative artwork is exposed to a screen reader');
  /* The primary action and the identity are what the surface is for. Both
     survived the rebuild or the rebuild took the page's purpose with it. */
  ['ovOpenBrowser', 'ovWho'].forEach(id => {
    assert.ok(new RegExp(`id="${id}"`).test(htmlSource), `#${id} was lost in the rebuild`);
  });
  const panel = htmlSource.match(/<aside[^>]*class="ov-core"[^>]*>/);
  assert.ok(panel, 'the trust core panel is gone');
  assert.ok(/aria-labelledby="([^"]+)"/.test(panel[0]),
    'the core panel is a landmark with no name');
  const labelled = panel[0].match(/aria-labelledby="([^"]+)"/)[1];
  assert.ok(new RegExp(`id="${labelled}"`).test(htmlSource),
    `the core panel points at #${labelled} for its name, and nothing carries that id`);
  /*
   * The headline is the screen's own voice and the reason the copy needs room
   * beside the stage. Folding it down to a label is how the last revision lost
   * the page: a display title that no longer scales is a card, not a hero.
   */
  const title = cssSource.match(/\.gx-title\{([^}]*)\}/);
  assert.ok(title && /font-size\s*:\s*clamp\(/.test(title[1]),
    'the hero headline no longer scales with the viewport, so it reads as a label');
});

/*
 * The mark had two crops in two revisions: a hard one from the panel's own
 * overflow, then a soft one from a mask drawn to hide it. Both showed the
 * reader part of a logo. This reads the geometry rather than the technique, so
 * a third way of cutting it fails here too.
 */
check('the overview artwork is shown whole, not cropped by its panel', () => {
  const art = rules.filter(rule => rule.selector.split(',')
    .some(one => one.trim().endsWith('.ov-core-art')));
  assert.ok(art.length, '.ov-core-art has no rule at all');
  const combined = art.map(rule => rule.body).join(';');
  assert.ok(!/mask-image/.test(combined),
    'the mark is masked, which fades a crop rather than removing one');
  /*
   * A negative inset is the mark hanging off its ground, and the ground clips.
   * Two revisions cut the mark this way -- once with the panel's own overflow
   * and once with a mask drawn to hide that -- so the check is on the geometry
   * rather than on either technique.
   */
  const negatives = combined.match(/(?:inset|top|right|bottom|left)\s*:\s*[^;}]*-\d/g) || [];
  const bleeding = negatives.filter(one => !/translate|transform/.test(one));
  assert.ok(!bleeding.length,
    `the mark is positioned outside its stage and will be clipped: ${bleeding.join(' | ')}`);
  /*
   * The stage has to be a stage: a box with height of its own, so the mark has
   * somewhere to be drawn at full size rather than being squeezed behind copy.
   */
  assert.ok(/height\s*:/.test(combined),
    'the artwork ground has no height, so the mark has no room to be drawn in');
  assert.ok(/overflow\s*:\s*hidden/.test(combined),
    'the stage no longer clips, so this check has nothing to protect against');
  /* The 3D mount, the aura and the SVG emblem each fill that stage exactly --
     not a corner of it. */
  const fills = selector => rules.filter(rule => eachSelector(rule).some(one => subject(one.selector) === selector))
    .map(rule => rule.body).join(';');
  const mount = rules.filter(rule => /nebula-mark-3d/.test(rule.selector)).map(rule => rule.body).join(';');
  assert.ok(/inset\s*:\s*0/.test(mount),
    'the dimensional mark does not fill its stage, so it draws into part of the frame');
  assert.ok(/inset\s*:\s*0/.test(fills('.ov-core-glow')), 'the aura does not fill its stage');
  assert.ok(/inset\s*:\s*0/.test(fills('.ov-core-emblem')), 'the emblem does not fill its stage');
  assert.ok(/class="ov-core-emblem"/.test(htmlSource), 'the overview emblem is gone');
  /* It is alive -- the Trust core was reported as dead while it held still --
     and it stops for a reader who has asked for stillness. */
  assert.ok(/\.ov-core-emblem \.oc-orbit\{animation:/.test(cssSource), 'the emblem\'s scanning orbit does not move');
  /* The instrument moves; the ground under it is still and one hue. A turning
     wheel of cyan, magenta and violet was reported twice as unprofessional. */
  const aura = cssSource.match(/\.ov-core-glow::before\{([^}]*)\}/);
  assert.ok(aura, 'the Trust core has no ground under its mark');
  assert.ok(!/animation\s*:/.test(aura[1]), 'the Trust core\'s ground animates');
  assert.ok(!/conic-gradient|34,\s*211,\s*238|217,\s*70,\s*239/.test(aura[1]), 'the Trust core\'s ground mixes colours');
  assert.ok(/\[data-motion="off"\] \.ov-core-emblem \*\{animation:none\}/.test(cssSource),
    'the emblem keeps moving with the product\'s motion switched off');
  assert.ok(/prefers-reduced-motion:reduce\)\{\s*\.ov-core-emblem \*\{animation:none\}/.test(cssSource),
    'the emblem keeps moving for a reader who asked the system for reduced motion');
});

/*
 * Every reading on the overview is an arc. An arc is stroked; a filled circle
 * is a disc. The state classes the legend swatches share also set `fill`, and a
 * class rule outranks a presentation attribute -- which is exactly how the
 * capability ring shipped as a solid yellow blob with fill="none" in its
 * markup. So the rule that matters is: nothing that draws an arc may take its
 * colour from a selector that sets fill.
 */
check('a reading is drawn as an arc, not filled in by a legend colour', () => {
  const filling = new Set();
  rules.forEach(rule => {
    if (!/(?:^|[;{\s])fill\s*:\s*(?!none)[^;}]+/.test(rule.body)) return;
    eachSelector(rule).forEach(one => filling.add(subject(one.selector)));
  });
  ['.wp-gauge-arc', '.wp-gauge-track', '.wp-donut-arc', '.wp-donut-track'].forEach(name => {
    const own = rules.filter(rule => eachSelector(rule).some(one => subject(one.selector) === name));
    assert.ok(own.length, `${name} has no rule, so nothing draws it`);
    const body = own.map(rule => rule.body).join(';');
    assert.ok(/fill\s*:\s*none/.test(body),
      `${name} never sets fill:none, so a class that sets fill will paint it as a disc`);
    assert.ok(/stroke(-width)?\s*:/.test(body), `${name} is not stroked, so there is no arc to see`);
  });
  /*
   * The collision itself: an element may not carry both an arc class and a
   * fill-setting class. Read off the source that builds the ring rather than
   * off a list kept in step by hand.
   */
  const pulseSource = fs.readFileSync(path.join(root, 'public/workspace-pulse.js'), 'utf8');
  const classed = [...pulseSource.matchAll(/class:\s*[`'"]([^`'"]*(?:gauge-arc|donut-arc)[^`'"]*)[`'"]/g)]
    .map(match => match[1]);
  assert.ok(classed.length, 'nothing builds an arc any more');
  /*
   * Matched by prefix, not by name. The first version of this compared whole
   * class names and a template interpolation walked straight through it:
   * `wp-fill-${status}` is not the string `wp-fill-good`, so the check passed
   * on the very rewrite it was written to catch. What survives interpolation is
   * the literal text before the `${`, and that is enough to recognise the
   * family a class belongs to.
   */
  const fillFamilies = [...filling].map(name => name.replace(/^\./, ''));
  classed.forEach(list => {
    list.split(/\s+/).filter(Boolean).forEach(token => {
      const literal = token.split('${')[0];
      if (!literal) return;
      const clash = fillFamilies.find(name => name === literal || name.startsWith(literal));
      assert.ok(!clash,
        `an arc carries "${token}", and .${clash} sets fill -- the arc will paint as a disc`);
    });
  });
});

/*
 * A gauge with nothing to report draws its track and no arc. Drawing a
 * zero-length arc would be a reading of zero, and this model exists to tell
 * "not measured" apart from "measured and failing".
 */
check('an unmeasured reading draws no arc at all', () => {
  const pulseSource = fs.readFileSync(path.join(root, 'public/workspace-pulse.js'), 'utf8');
  const at = pulseSource.indexOf('function gauge(');
  assert.ok(at >= 0, 'the gauge primitive is gone');
  const body = pulseSource.slice(at, pulseSource.indexOf('\n  }\n', at));
  assert.ok(/if \(measured\)[\s\S]{0,220}wp-gauge-arc/.test(body),
    'the arc is drawn whether or not there is a reading behind it');
  assert.ok(/\\u2014|\u2014/.test(body),
    'an unmeasured gauge prints something other than a dash where its figure goes');
});

check('the live rail reports a session rather than asserting one', () => {
  const make = liftFunction('paintCoreState', ['$', 'state']);
  const scope = fakeElement({ width: 10, height: 10, left: 0, top: 0 });
  const live = fakeElement({ width: 10, height: 10, left: 0, top: 0 });
  live.classList = { toggle(name, on) { live.idle = on; } };
  const lookup = selector => (selector === '#ovCoreScope' ? scope : selector === '#ovCoreLive' ? live : null);

  make(lookup, { me: { provider: 'github', host: 'github.com' } })();
  const connected = scope.textContent;
  assert.ok(/github\.com/.test(connected), `a connected session does not name its host: ${connected}`);
  assert.strictEqual(live.idle, false, 'a connected session is not shown as live');

  make(lookup, { me: null })();
  assert.notStrictEqual(scope.textContent, connected,
    'the rail says the same thing signed in and signed out, so it is a label rather than a reading');
  assert.ok(!/github\.com/.test(scope.textContent),
    `a session with no identity still names a provider: ${scope.textContent}`);
  assert.strictEqual(live.idle, true,
    'a session with no identity is still shown as live, which is the one claim this rail must not fake');

  /* A self-hosted authority is what the capability set was loaded against, so
     the rail has to follow it rather than printing the provider's public host. */
  make(lookup, { me: { provider: 'gitea', authority: 'git.example.org' } })();
  assert.strictEqual(scope.textContent, 'git.example.org',
    'the rail ignores the authority the session is actually talking to');
});

check('the pointer light costs nothing on a device that has no pointer', () => {
  const wiring = appSource.slice(appSource.indexOf('function wireCorePointer'));
  const body = wiring.slice(0, wiring.indexOf('\n}\n'));
  assert.ok(/\(hover:hover\)/.test(body) && /\(pointer:fine\)/.test(body),
    'the pointer light is wired up without asking whether the device has a pointer');
  assert.ok(/passive:\s*true/.test(body),
    'the pointer listener is not passive, so it can hold up a scroll');
  assert.ok(/state\.settings\.motion/.test(body),
    'the pointer light ignores the motion setting');
  /*
   * Two custom properties and a gradient. If it ever moves a layer instead,
   * every frame of a pointer move becomes a composite on a full-width panel.
   */
  assert.ok(!/\.style\.transform|classList\.(add|remove)/.test(body),
    'the pointer light moves an element rather than a background position');
  const lit = rules.find(rule => rule.selector.includes('.ov-core::after'));
  assert.ok(lit && /--nv-px/.test(lit.body),
    'nothing in the cascade reads the pointer position the shell writes');
});


/* ---------------- the portal answers the gate ---------------- */

check('the scene leans in while the reader is in the card, and settles when they leave', () => {
  const run = runLandingStage({ decodable: true });
  assert.ok(!run.reaching(), 'the scene starts leaned in, so the moment has nothing to answer');
  run.gesture();
  run.focusIn();
  assert.ok(run.reaching(), 'reaching for the invitation does not move the scene at all');
  run.focusOut(false);
  assert.ok(!run.reaching(), 'the scene stays leaned in after focus has left the card');
});

check('the scene does not answer a cursor the browser parked in the field', () => {
  /*
   * alpha-ui focuses the invitation the moment the gate is raised. Bound to
   * focus alone the lean-in was applied on the first frame and never came
   * back, so the moment was the resting state. Found by a browser check
   * asserting the scene rests at scale 1 before anyone has touched anything.
   */
  const run = runLandingStage({ decodable: true });
  run.focusIn();
  assert.ok(!run.reaching(),
    'the gate autofocus leans the scene in before the reader has touched the page');

  /* And the first real gesture, with focus already there, is what it answers. */
  const arriving = runLandingStage({ decodable: true });
  arriving.focusIn();
  arriving.focusOut(true);
  arriving.gesture();
  assert.ok(arriving.reaching(),
    'a reader who arrives and starts typing in the autofocused field never gets the moment');
});

check('moving between the card own controls does not make the scene flinch', () => {
  const run = runLandingStage({ decodable: true });
  run.gesture();
  run.focusIn();
  /* focusout fires on every tab stop inside the card; only leaving it counts. */
  run.focusOut(true);
  assert.ok(run.reaching(),
    'tabbing from the invitation to the terms drops the scene back, once per control');
});

check('the moment is wired before the scene is looked for', () => {
  /*
   * The scene leans in whether or not the subject is ever drawn. A build
   * without WebGL still gets the ground, the veil and the card, and they
   * still answer the reader.
   */
  const refused = runLandingStage({ noWebgl: true });
  refused.gesture();
  refused.focusIn();
  assert.ok(refused.reaching(),
    'a build without WebGL loses the moment as well as the subject');
  assert.strictEqual(refused.calls.start, 0, 'a ring that was never created was started anyway');

  /*
   * And with no canvas at all. The module returns early when it cannot find
   * one, so anything wired after that line is wired only for pages that
   * happen to carry a scene.
   */
  const bare = runLandingStage({ noCanvas: true });
  bare.gesture();
  bare.focusIn();
  assert.ok(bare.reaching(),
    'the moment sits behind the early return, so a page without a scene loses it');
});

check('the motion itself is in the cascade, gated both ways', () => {
  /*
   * The module carries a class and nothing else. If it ever moves the element
   * directly the reduced-motion and data-motion gates below stop applying to
   * it, because they are cascade rules.
   */
  const source = fs.readFileSync(path.join(root, 'public/landing-stage.js'), 'utf8');
  const reaching = source.slice(source.indexOf('is-reaching'));
  assert.ok(!/\.style\./.test(reaching.slice(0, 400)),
    'the moment writes a style directly, which no motion setting can then turn off');

  const moved = rules.filter(rule => /\.is-reaching\b/.test(rule.selector)
    && /transform\s*:|opacity\s*:/.test(rule.body));
  assert.ok(moved.length, 'nothing in the cascade answers the class the module sets');

  /* Every movement sits under a no-preference query. */
  const guarded = stripped.match(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(guarded && /\.is-reaching[\s\S]*?transform\s*:\s*scale/.test(guarded[1]),
    'the push-in is not inside a prefers-reduced-motion: no-preference block');
  const off = rules.filter(rule => /\[data-motion="off"\][\s\S]*\.is-reaching/.test(rule.selector)
    && /transform\s*:\s*none/.test(rule.body));
  assert.ok(off.length, 'the interface own motion switch does not stand the scene back down');
});

check('the landing page wears the product mark rather than one drawn in place', () => {
  /*
   * Twice now a screen has ended up with artwork invented for it instead of
   * the product's own: a cropped hero, and then a ringed planet ellipse drawn
   * straight into the landing nav and footer. The first screen a visitor sees
   * is the last place to introduce a second brand.
   *
   * So this reads the mechanism: the mark is referenced from the shared
   * symbol, and the elements that carry it draw no shapes of their own. A
   * replacement glyph under any class name fails here.
   */
  const symbol = htmlSource.match(/<symbol id="nvMark"[\s\S]*?<\/symbol>/);
  assert.ok(symbol, 'the shared mark symbol is gone');

  /*
   * The brand elements themselves, not the chrome around them: the theme
   * control in the same header draws a sun and a moon, and those are icons
   * doing a job rather than a second logo.
   */
  const nav = htmlSource.match(/<span class="lp-brand">[\s\S]*?<\/span>\s*<\/span>/);
  const foot = htmlSource.match(/<span class="lp-foot-brand">[\s\S]*?<\/span>/);
  assert.ok(nav && foot, 'the landing brand is gone');

  [['nav', nav[0]], ['footer', foot[0]]].forEach(([where, block]) => {
    assert.ok(/<use href="#nvMark"\s*\/?>/.test(block),
      `the landing ${where} does not use the product mark`);
    /* And nothing in it paints a mark of its own. */
    const drawn = block.match(/<(path|circle|ellipse|rect|polygon|polyline)\b/g) || [];
    assert.deepStrictEqual(drawn, [],
      `the landing ${where} draws its own artwork (${drawn.join(', ')}) beside the product mark`);
  });
});

/* ---------------- the theme, before the gate ---------------- */

/*
 * Restoring the theme used to live in app.js loadSettings(), which runs from
 * boot(), which runs only once the access gate has granted. Every visitor met
 * the landing page in dark whatever they had chosen, and toggling it there was
 * written and never read back. Run the module rather than read it: the whole
 * point of the file is a side effect on a document that does not exist yet.
 */
function runThemeBoot(options) {
  const settings = options || {};
  const source = fs.readFileSync(path.join(root, 'public/theme-boot.js'), 'utf8');
  const documentElement = { dataset: { theme: 'dark' } };
  const meta = { content: '' };
  const toggles = Array.from({ length: settings.toggles || 0 }, () => ({
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  }));
  const listeners = {};
  const documentStub = {
    documentElement,
    querySelector: selector => (selector === 'meta[name=theme-color]' ? meta : null),
    querySelectorAll: selector => (selector === '.theme-toggle' ? toggles : []),
    addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
  };
  const sandbox = {
    document: documentStub,
    localStorage: settings.blocked
      ? { getItem() { throw new Error('storage is blocked in this context'); } }
      : { getItem: key => key === 'nv_settings' ? (settings.motionSettings || null) : (key === 'nv_theme' ? (settings.stored || null) : null) }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'public/theme-boot.js' });
  return {
    theme: () => documentElement.dataset.theme,
    motion: () => documentElement.dataset.motion,
    meta, toggles,
    parsed: () => (listeners.DOMContentLoaded || []).forEach(fn => fn())
  };
}

check('a stored theme is restored without waiting for the gate to grant', () => {
  assert.strictEqual(runThemeBoot({ stored: 'light' }).theme(), 'light',
    'the visitor stored light and the document is still dark');
  assert.strictEqual(runThemeBoot({ stored: 'dark' }).theme(), 'dark');
});

check('stored motion is restored before the gate, independently of theme', () => {
  assert.strictEqual(runThemeBoot({ stored: 'light', motionSettings: '{"motion":false}' }).motion(), 'off');
  assert.strictEqual(runThemeBoot({ motionSettings: '{"motion":true}' }).motion(), 'on');
  for (const value of [null, '{broken', 'null', '{"motion":"false"}']) {
    assert.notStrictEqual(runThemeBoot({ stored: 'light', motionSettings: value }).motion(), 'off');
    assert.strictEqual(runThemeBoot({ stored: 'light', motionSettings: value }).theme(), 'light');
  }
});

check('a first visit and a blocked store both leave the document alone', () => {
  assert.strictEqual(runThemeBoot({ stored: null }).theme(), 'dark',
    'an empty store moved the theme to something nobody chose');
  assert.strictEqual(runThemeBoot({ stored: 'chartreuse' }).theme(), 'dark',
    'a value that is not a theme was written onto the document');
  /* Private mode throws on the first read rather than returning null. */
  assert.strictEqual(runThemeBoot({ blocked: true }).theme(), 'dark',
    'a browser that refuses storage takes the page down with it');
});

check('the switches report the theme they are actually in', () => {
  const run = runThemeBoot({ stored: 'light', toggles: 3 });
  run.parsed();
  run.toggles.forEach(toggle => assert.strictEqual(toggle.attributes['aria-checked'], 'false',
    'a reader who chose light met a switch telling a screen reader it was dark'));
  const dark = runThemeBoot({ stored: 'dark', toggles: 2 });
  dark.parsed();
  dark.toggles.forEach(toggle => assert.strictEqual(toggle.attributes['aria-checked'], 'true'));
});

check('the restore runs from the head, before anything is painted', () => {
  const head = htmlSource.slice(0, htmlSource.indexOf('</head>'));
  assert.ok(/<script[^>]+src="\/theme-boot\.js/.test(head),
    'theme-boot is not in the head, so the shell paints in one theme and corrects to the other');
  /* An inline block here would be refused: script-src is 'self' with no 'unsafe-inline'. */
  assert.ok(/script-src 'self'/.test(serverSource),
    'the policy this file is a file rather than an inline block for has changed');
  /*
   * In the landing nav specifically. Counting toggles across the document
   * passed with the landing one deleted, because the shell carries two of its
   * own -- behind the gate, where a visitor cannot reach them.
   */
  const nav = htmlSource.match(/<header class="lp-nav">[\s\S]*?<\/header>/);
  assert.ok(nav, 'the landing nav is gone');
  assert.ok(/class="theme-toggle"/.test(nav[0]),
    'the landing page has no theme control, so a visitor cannot reach the one inside the shell');
});

/*
 * The sticky bar has to clear the status bar, not stop at it.
 *
 * env(safe-area-inset-top) is the height of the region the status bar covers.
 * max(28px, inset) spends the entire padding arriving at the bottom of that
 * region, so the brand and the theme control end up flush against it -- and
 * with viewport-fit=cover and a black-translucent status bar, flush against it
 * is underneath it, which is how a bar that is sticking can still look gone.
 * The two have to add.
 */
check('the landing bar reserves the safe area on top of its own padding', () => {
  const rule = cssSource.match(/\.lp-nav\{([^}]*)\}/);
  assert.ok(rule, 'the landing nav rule is gone');
  assert.ok(/position:sticky/.test(rule[1]),
    'the landing bar no longer sticks, so the theme control leaves with the hero');
  assert.ok(/padding-top:calc\(env\(safe-area-inset-top/.test(rule[1]),
    'the safe area is not added to the padding, so the bar sits under the status bar');
  assert.ok(/env\(safe-area-inset-top,\s*0px\)/.test(rule[1]),
    'env() carries no fallback, so the declaration is dropped wherever the variable is unsupported');
});

/*
 * And the half the guard above could not see, which is the half that broke.
 *
 * That check reads the .lp-nav rule and stops there, so it went on passing
 * while a `padding-block:20px` in the max-width:480px block -- later in the
 * file, same weight, therefore the winner -- wrote both edges and put the top
 * one back to a flat 20px. Every phone is narrower than 480px, so the
 * clearance was intact on every viewport except the ones it exists for, and a
 * reader photographed the theme control peeking out from under the clock
 * twice before the shorthand was found.
 *
 * A declaration is only as good as the last rule that touches it. This reads
 * every .lp-nav rule after the clearance and fails on any that writes the top
 * edge, whether by naming padding-top or by reaching it through a shorthand.
 */
check('no later rule writes the landing bar top padding back down', () => {
  const clearance = cssSource.indexOf('padding-top:calc(env(safe-area-inset-top');
  assert.ok(clearance > 0, 'the clearance declaration is gone');
  const offenders = [];
  for (const match of cssSource.matchAll(/(^|[\s,{}])(\.lp-nav)\s*\{([^}]*)\}/g)) {
    if (match.index < clearance) continue;
    const body = match[3];
    /* padding and padding-block both write the top edge; padding-top says so. */
    if (/(^|;)\s*padding(-top|-block)?\s*:/.test(body)) offenders.push(body.trim());
  }
  assert.deepStrictEqual(offenders, [],
    `these rules reset the landing bar top edge after the clearance set it: ${offenders.join(' | ')}`);
});

/*
 * The same fallback the landing bar's rule is held to, held across the file.
 *
 * env() with no fallback is not a zero -- where the variable is unsupported
 * the whole declaration is invalid, which for `.topbar{top:calc(6px + env(...))}`
 * means a fixed bar with no top at all, dropped to its static position. One
 * rule carried the fallback and thirty-seven did not.
 */
check('every safe-area inset carries a fallback', () => {
  const bare = [...cssSource.matchAll(/env\(safe-area-inset-[a-z]+\s*\)/g)].map(m => m[0]);
  assert.deepStrictEqual([...new Set(bare)], [],
    `these env() uses are dropped wherever the variable is unsupported: ${[...new Set(bare)].join(', ')}`);
});

/*
 * backdrop-filter inside a position:sticky box is a WebKit soft spot, and this
 * bar is the one element on the landing that has to survive being scrolled. A
 * scrim is not worth the bar's stickiness, so the scrim behind it paints and
 * does nothing else.
 */
check('the sticky bar carries no filter that could cost it its stickiness', () => {
  const rule = cssSource.match(/\.lp-nav::after\{([^}]*)\}/);
  assert.ok(rule, 'the landing bar has no scrim, so content passes under it unreadably');
  assert.ok(!/backdrop-filter/.test(rule[1]),
    'the scrim promotes a layer inside the sticky bar, which is what takes the sticking with it');
  assert.ok(/linear-gradient/.test(rule[1]),
    'the scrim no longer paints anything, so the bar has nothing behind its text');
});

/*
 * Two of these shipped twice. Nothing breaks, and that is the point: a head
 * nobody reads is a head where the next duplicate is invisible too.
 */
check('no meta name is declared twice in the head', () => {
  const head = htmlSource.slice(0, htmlSource.indexOf('</head>'));
  const seen = new Map();
  for (const tag of head.match(/<meta\s+name="[^"]+"[^>]*>/g) || []) {
    const name = tag.match(/name="([^"]+)"/)[1];
    /* theme-color is legitimately repeated: one per media query. */
    if (name === 'theme-color') continue;
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  const repeated = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepStrictEqual(repeated, [],
    `these meta names are declared more than once: ${repeated.join(', ')}`);
});

/*
 * The release version was published on the root element, where no code read
 * it. The footer still prints it, deliberately -- an alpha tester reporting a
 * fault needs to be able to say which build they are on -- but that is a
 * sentence the product chose to say, not a build number leaking through an
 * attribute nobody asked for.
 */
check('the root element publishes no release version', () => {
  const root = htmlSource.match(/<html[^>]*>/);
  assert.ok(root, 'the root element is gone');
  assert.ok(!/data-nv-version/.test(root[0]),
    'the release version is back on the root element, where nothing reads it');
  assert.ok(/data-nv-asset-version/.test(root[0]),
    'the asset version is gone, and app.js reads it to stamp every asset URL');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
