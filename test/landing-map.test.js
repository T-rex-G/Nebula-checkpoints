'use strict';
/*
 * The landing map's moving layer: where it draws, when it runs, and that it
 * gives the picture back when it cannot or should not move.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { meet, along, ease, rgb, createLandingMap, BUDGET } = require('../public/landing-map');

/* ---- The geometry ------------------------------------------------------------------- */
{
  /* A 16:9 picture in a box of the same shape fills it. */
  const fit = meet({ x: 0, y: 0, width: 960, height: 540 }, 1120, 630);
  assert.ok(Math.abs(fit.scale - 1120 / 960) < 1e-9);
  assert.equal(fit.x, 0);
  assert.ok(Math.abs(fit.y) < 1e-9);
  /* A wider box letterboxes left and right, as xMidYMid meet does. */
  const wide = meet({ x: 0, y: 0, width: 480, height: 640 }, 600, 640);
  assert.equal(wide.scale, 1);
  assert.equal(wide.x, 60);
  assert.equal(wide.y, 0);
  /* A viewBox that does not start at the origin is shifted back. */
  const shifted = meet({ x: 10, y: 20, width: 100, height: 100 }, 100, 100);
  assert.equal(shifted.x, -10);
  assert.equal(shifted.y, -20);
}
{
  const line = [[0, 0], [10, 0], [10, 10]];
  assert.deepEqual(along(line, 0), [0, 0]);
  assert.deepEqual(along(line, 1), [10, 10]);
  assert.deepEqual(along(line, 0.25), [5, 0]);
  assert.deepEqual(along(line, 0.75), [10, 5]);
  /* Out of range is held to the ends, never extrapolated past the strand. */
  assert.deepEqual(along(line, -0.4), [0, 0]);
  assert.deepEqual(along(line, 1.7), [10, 10]);
}
{
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(Math.abs(ease(0.5) - 0.5) < 1e-12);
  assert.ok(ease(0.1) < 0.1 && ease(0.9) > 0.9, 'a signal gathers and settles rather than moving at one speed');
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
}
{
  assert.deepEqual(rgb('rgb(243, 245, 255)'), [243, 245, 255]);
  assert.deepEqual(rgb('rgba(167, 139, 250, 0.6)'), [167, 139, 250]);
  assert.deepEqual(rgb('#F43F6E'), [244, 63, 110]);
  assert.deepEqual(rgb('#abc'), [170, 187, 204]);
  assert.deepEqual(rgb('none', [1, 2, 3]), [1, 2, 3]);
}

/* ---- The lifecycle ------------------------------------------------------------------ */
function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    fire(name) { if (listeners.has(name)) listeners.get(name)(); },
    listeners
  });
}

function element(attributes = {}, extra = {}) {
  return Object.assign({ getAttribute: name => (name in attributes ? String(attributes[name]) : null) }, extra);
}

function strand(from, to) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return element({}, {
    getTotalLength: () => length,
    getPointAtLength: at => ({ x: from[0] + ((to[0] - from[0]) * at) / length, y: from[1] + ((to[1] - from[1]) * at) / length }),
    stroke: 'rgb(244, 63, 110)'
  });
}

function harness({ context = true, display = 'block', layout = null } = {}) {
  const frames = new Map();
  let id = 0;
  const calls = { clear: 0, image: 0, stroke: 0, clip: 0 };
  const observers = [];
  const intersections = [];
  const resizes = [];
  const html = { dataset: { theme: 'dark', motion: 'on', design: 'nebula' } };
  const doc = events({ documentElement: html, hidden: false });
  const ctx = {
    setTransform() {}, clearRect() { calls.clear++; }, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    stroke() { calls.stroke++; }, drawImage() { calls.image++; }, save() {}, restore() {}, clip() { calls.clip++; },
    fillRect() {}, createRadialGradient: () => ({ addColorStop() {} })
  };
  const canvases = [];
  doc.createElement = tag => {
    assert.equal(tag, 'canvas');
    const canvas = {
      width: 0, height: 0, className: '', attributes: {}, removed: false,
      setAttribute(name, value) { this.attributes[name] = value; },
      getContext: () => (context ? ctx : null),
      remove() { this.removed = true; }
    };
    canvases.push(canvas);
    return canvas;
  };
  const svg = {
    viewBox: { baseVal: { x: 0, y: 0, width: 960, height: 540 } },
    style: { display },
    querySelector(selector) {
      if (selector === '.lp-map-orb') return element({ cx: 480, cy: 270, r: 44 });
      if (selector === '.lp-map-arcs path') return element({ d: 'M532 270 A52 52 0 0 1 460 318' }, { stroke: 'rgba(167, 139, 250, 0.6)' });
      if (selector === '.lp-map-pill') return element({ x: 428, y: 330, width: 104, height: 24 });
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.lp-map-ring') return [element({ r: 78 }), element({ r: 118 })];
      if (selector === '.lp-map-strand') return [strand([248, 135], [440, 251]), strand([712, 429], [520, 292])];
      return [];
    }
  };
  const classes = new Set(['lp-frame-view']);
  const children = [];
  const view = {
    dataset: {},
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      remove(name) { classes.delete(name); },
      contains: name => classes.has(name)
    },
    appendChild(child) { children.push(child); },
    querySelectorAll: selector => (selector === 'svg.lp-map' ? [svg] : []),
    getBoundingClientRect: () => ({ width: 1120, height: 630 }),
    ...(layout || {})
  };
  const media = events({ matches: false });
  const env = events({
    document: doc, devicePixelRatio: 3, random: () => 0,
    matchMedia: () => media,
    getComputedStyle: el => ({ display: el.style ? el.style.display : 'block', stroke: el.stroke || '' }),
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = true; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.connected = false; }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.connected = true; resizes.push(this); }
      observe() {}
      disconnect() { this.connected = false; }
    },
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; this.connected = true; intersections.push(this); }
      observe() {}
      disconnect() { this.connected = false; }
    }
  });
  let now = 0;
  const pump = (count = 1, gap = 16) => {
    for (let i = 0; i < count; i++) {
      const pending = [...frames.entries()];
      frames.clear();
      now += gap;
      pending.forEach(([, callback]) => callback(now));
    }
  };
  const api = createLandingMap(view, env);
  const seen = on => intersections.forEach(watch => watch.callback([{ isIntersecting: on }]));
  const mutate = () => observers.forEach(observer => observer.callback());
  return { api, env, doc, html, media, view, classes, children, canvases, frames, calls, pump, seen, mutate, observers, intersections, resizes };
}

{
  const h = harness();
  const canvas = h.canvases[0];
  assert.equal(h.children[0], canvas, 'the moving layer is drawn into the frame');
  assert.equal(canvas.className, 'lp-map-fx');
  assert.equal(canvas.attributes['aria-hidden'], 'true');
  /* The pixel ratio is capped: a 3x phone draws at 2x. */
  assert.equal(canvas.width, 2240);
  assert.equal(canvas.height, 1260);
  assert.equal(h.api.state().strands, 2);
  /* Until the map is on screen, nothing is scheduled. */
  assert.equal(h.frames.size, 0);
  assert.equal(h.view.dataset.fx, 'paused');
  assert.ok(h.classes.has('has-fx'), 'the SVG dashes stand down for the layer that replaces them');

  h.seen(true);
  assert.equal(h.view.dataset.fx, 'running');
  assert.equal(h.frames.size, 1);
  h.pump(30);
  assert.ok(h.calls.stroke > 0 && h.calls.image > 0, 'signals and lights are drawn');
  assert.ok(h.calls.clip > 0, 'the repository name is kept clear of what moves past it');
  assert.ok(h.api.state().clock > 0.4);

  /* Off screen it stops asking for frames. */
  h.seen(false);
  h.pump(1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.view.dataset.fx, 'paused');

  /* A hidden tab stops it too, and a visible one brings it back. */
  h.seen(true);
  h.doc.hidden = true;
  h.doc.fire('visibilitychange');
  h.pump(1);
  assert.equal(h.frames.size, 0);
  h.doc.hidden = false;
  h.doc.fire('visibilitychange');
  assert.equal(h.frames.size, 1);

  /* Motion off: the layer clears and the still SVG is the picture again. */
  h.html.dataset.motion = 'off';
  h.mutate();
  assert.equal(h.frames.size, 0);
  assert.equal(h.view.dataset.fx, 'still');
  assert.ok(!h.classes.has('has-fx'));
  h.html.dataset.motion = 'on';
  h.mutate();
  assert.equal(h.view.dataset.fx, 'running');

  /* The OS preference counts the same as the setting. */
  h.media.matches = true;
  h.media.fire('change');
  assert.equal(h.view.dataset.fx, 'still');
  h.media.matches = false;
  h.media.fire('change');
  assert.equal(h.view.dataset.fx, 'running');

  /* It listens only for the attributes that change what it draws. */
  assert.deepEqual(h.observers[0].options.attributeFilter, ['data-theme', 'data-motion', 'data-design']);

  h.api.destroy();
  h.api.destroy();
  assert.equal(h.frames.size, 0);
  assert.ok(canvas.removed);
  assert.ok(!h.classes.has('has-fx'));
  assert.equal(h.view.dataset.fx, undefined);
  assert.ok(h.observers.every(o => !o.connected));
  assert.ok(h.intersections.every(o => !o.connected));
  assert.ok(h.resizes.every(o => !o.connected));
  assert.equal(h.env.listeners.size, 0);
  assert.equal(h.doc.listeners.size, 0);
  assert.equal(h.media.listeners.size, 0);
}

{
  /* A device that cannot keep pace keeps the still map instead of a stuttering one. */
  const h = harness();
  h.seen(true);
  h.pump(BUDGET.frames + 2, BUDGET.medianMs + 20);
  assert.equal(h.view.dataset.fx, 'retired');
  assert.ok(!h.classes.has('has-fx'));
  assert.ok(h.canvases[0].removed);
  assert.equal(h.frames.size, 0);
  /* Coming back on screen does not revive it. */
  h.seen(false);
  h.seen(true);
  assert.equal(h.frames.size, 0);
}

{
  /* One that can keeps running past the measurement. */
  const h = harness();
  h.seen(true);
  h.pump(BUDGET.frames + 10, 16);
  assert.equal(h.view.dataset.fx, 'running');
  assert.equal(h.frames.size, 1);
}

{
  /* Without a 2D context there is no layer, and the SVG keeps its own motion. */
  const h = harness({ context: false });
  assert.equal(h.api.state().available, false);
  assert.equal(h.children.length, 0);
  assert.ok(!h.classes.has('has-fx'));
}

{
  /* With no drawn map (both compositions hidden), there is nothing to move. */
  const h = harness({ display: 'none' });
  h.seen(true);
  assert.equal(h.frames.size, 0);
  assert.equal(h.view.dataset.fx, 'still');
}

/* ---- Delivery ---------------------------------------------------------------------- */
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert.match(html, /<script src="\/landing-map\.js\?v=__NV_ASSET_VERSION__"><\/script>/);
assert.match(fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8'), /\/landing-map\.js\?v=__NV_ASSET_VERSION__/);
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
assert.match(css, /\.lp-frame-view\.has-fx \.lp-map-flows,\.lp-frame-view\.has-fx \.lp-map-arcs\{display:none\}/,
  'while the layer runs, the SVG must not draw the same motion underneath it');
assert.match(css, /\.lp-map-fx\{[^}]*pointer-events:none/);
console.log('landing map geometry, lifecycle, budget and delivery tests passed');

/*
 * The frame tilts flat as it scrolls in, and its bounding box mid-tilt is
 * the layout box scaled down. The canvas takes the layout box, so the lights
 * stay on their strands once the frame settles.
 */
{
  const h = harness({ layout: { clientWidth: 1120, clientHeight: 630, getBoundingClientRect: () => ({ width: 1030.4, height: 579.6 }) } });
  assert.equal(h.canvases[0].width, 2240, 'sized from the layout box, not the tilted one');
  assert.equal(h.canvases[0].height, 1260);
  h.api.destroy();
}
