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
  const card = blurOf('.card');
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
 * The scene is allowed to fail. A landing page whose first paint depends on a
 * 550KB decode is a landing page that is blank on a slow connection, on a
 * build without the codec, and for a reader who asked for less motion. The
 * poster is a real frame of the same scene, so every one of those cases is the
 * picture holding still rather than an empty black stage.
 */
check('the landing scene degrades to a still rather than to nothing', () => {
  const tag = htmlSource.match(/<video[^>]*id="lpVideo"[^>]*>/);
  assert.ok(tag, 'the landing video is gone');
  ['muted', 'loop', 'playsinline'].forEach(attribute => {
    assert.ok(new RegExp(`\\b${attribute}\\b`).test(tag[0]),
      `the landing video is missing ${attribute}; without it autoplay is refused or iOS takes the page fullscreen`);
  });
  assert.ok(/poster="[^"]+"/.test(tag[0]),
    'the video has no poster, so a refused decode leaves an empty stage');
  const poster = tag[0].match(/poster="([^"]+)"/)[1];
  assert.ok(fs.existsSync(path.join(root, 'public', poster.replace(/^\//, ''))),
    `the poster ${poster} is not in the build`);

  /* Both encodes shipped, and the smaller one offered first. */
  const block = htmlSource.match(/<video[^>]*id="lpVideo"[\s\S]*?<\/video>/)[0];
  const sources = [...block.matchAll(/<source[^>]*src="([^"]+)"[^>]*type="([^"]+)"/g)];
  assert.strictEqual(sources.length, 2,
    'the scene offers one encode; a browser that refuses it gets only the poster');
  assert.ok(/webm/.test(sources[0][2]),
    'the larger encode is offered first, so browsers that could take the smaller one do not');
  sources.forEach(([, src]) => {
    const file = path.join(root, 'public', src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${src} is referenced but not in the build`);
  });

  /*
   * Size is part of the contract. The source encode was 13MB because it
   * carried an audio track a muted background video can never play.
   */
  const bytes = sources.reduce((total, [, src]) =>
    total + fs.statSync(path.join(root, 'public', src.replace(/^\//, ''))).size, 0);
  assert.ok(bytes < 1.6 * 1024 * 1024,
    `the scene ships ${(bytes / 1024 / 1024).toFixed(1)}MB of video; that is a landing page nobody waits for`);
});

/*
 * Driven, not read.
 *
 * The first version of this asked whether the source mentioned canPlayType and
 * IntersectionObserver. Both perturbations walked through it: `true || ...`
 * leaves the call in the text while neutering it, and deleting the pause from
 * the observer still left a pause elsewhere in the file for the regex to find.
 * So the module is compiled against a stub document and actually run.
 */
function runLandingStage(options) {
  const settings = options || {};
  const source = fs.readFileSync(path.join(root, 'public/landing-stage.js'), 'utf8');
  const calls = { play: 0, pause: 0 };
  const listeners = {};
  const video = {
    paused: true,
    classList: { names: new Set(), add(n) { this.names.add(n); }, contains(n) { return this.names.has(n); } },
    canPlayType: () => (settings.decodable ? 'probably' : ''),
    play() { calls.play += 1; this.paused = false; return { catch() {} }; },
    pause() { calls.pause += 1; this.paused = true; },
    addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
  };
  let observerCallback = null;
  const documentStub = {
    getElementById: id => (id === 'lpVideo' ? video : null),
    documentElement: { dataset: { motion: settings.motion === false ? 'off' : 'on' } },
    addEventListener() {}, removeEventListener() {}
  };
  /*
   * A VM context, not an injected parameter. The module closes over
   * `globalThis`, so passing a stub named `global` to new Function() is
   * shadowed by the real one and every matchMedia read silently reaches Node's
   * globalThis instead -- which is how a reduced-motion check that works in a
   * browser looked broken from here.
   */
  const sandbox = {
    document: documentStub,
    matchMedia: query => ({ matches: !!settings.reducedMotion && /reduced-motion/.test(query) }),
    IntersectionObserver: function (cb) { observerCallback = cb; this.observe = () => {}; },
    MutationObserver: function () { this.observe = () => {}; }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'public/landing-stage.js' });
  return {
    calls, video, listeners,
    enter: () => observerCallback && observerCallback([{ isIntersecting: true }]),
    leave: () => observerCallback && observerCallback([{ isIntersecting: false }]),
    fire: name => (listeners[name] || []).forEach(fn => fn({ target: video })),
    sawObserver: () => observerCallback !== null
  };
}

check('the scene is revealed only once it is actually running', () => {
  const run = runLandingStage({ decodable: true });
  run.enter();
  assert.ok(!run.video.classList.contains('is-playing'),
    'the scene is revealed before any frame has been shown, which flashes over the poster');
  run.fire('playing');
  assert.ok(run.video.classList.contains('is-playing'),
    'the scene never reveals, so the poster is all a reader ever sees');
});

check('the scene does not ask a build that cannot decode it to play', () => {
  const refused = runLandingStage({ decodable: false });
  refused.enter();
  assert.strictEqual(refused.calls.play, 0,
    'play was attempted on a build whose decoder refuses both encodes');
  const able = runLandingStage({ decodable: true });
  able.enter();
  assert.ok(able.calls.play > 0,
    'play is never attempted even where both encodes decode, so the scene is always a still');
});

check('the scene stops when the reader is no longer looking at it', () => {
  const run = runLandingStage({ decodable: true });
  assert.ok(run.sawObserver(),
    'nothing watches whether the scene is on screen, so it decodes for the whole session');
  run.enter();
  const played = run.calls.play;
  run.leave();
  assert.strictEqual(run.calls.pause, 1,
    'leaving the screen does not pause the scene; a decoder keeps running behind the application');
  assert.strictEqual(run.calls.play, played, 'leaving the screen started playback');
});

check('the scene honours a reader who asked for less motion', () => {
  const off = runLandingStage({ decodable: true, motion: false });
  off.enter();
  assert.strictEqual(off.calls.play, 0, 'the scene plays with the motion setting off');
  const reduced = runLandingStage({ decodable: true, reducedMotion: true });
  reduced.enter();
  assert.strictEqual(reduced.calls.play, 0, 'the scene plays despite prefers-reduced-motion');
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
  assert.ok(/paintUnread\(await api\('\/api\/notifications'\)\)/.test(appSource),
    'nothing paints the marker from the notifications endpoint, so it can only be showing a guess');
  const refresh = appSource.slice(appSource.indexOf('async function refreshUnread'));
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
  /* The 3D mount fills that stage exactly -- not a corner of it. */
  const mount = rules.filter(rule => /nebula-mark-3d/.test(rule.selector))
    .map(rule => rule.body).join(';');
  assert.ok(/inset\s*:\s*0/.test(mount),
    'the dimensional mark does not fill its stage, so it draws into part of the frame');
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


console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
