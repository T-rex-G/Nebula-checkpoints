'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLightWaves } = require('../public/light-waves');

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    fire(name) { if (listeners.has(name)) listeners.get(name)(); },
    listeners
  });
}
function harness() {
  const frames = new Map();
  let id = 0;
  let paints = 0;
  let now = 0;
  const observers = [];
  const doc = events({ documentElement: { dataset: { theme: 'light', motion: 'on' } }, hidden: false });
  const media = events({ matches: false });
  const connection = events({ saveData: false });
  const rect = { width: 1280, height: 800 };
  const ctx = {
    setTransform() {}, clearRect() { paints++; }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    createLinearGradient() { return { addColorStop() {} }; }
  };
  const canvas = { dataset: {}, getContext: () => ctx, getBoundingClientRect: () => rect };
  const env = events({ document: doc, navigator: { connection }, devicePixelRatio: 3,
    matchMedia: () => media,
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = true; observers.push(this); }
      observe() {}
      disconnect() { this.connected = false; }
    }
  });
  const api = createLightWaves(canvas, env);
  return { api, env, doc, media, connection, canvas, rect, frames, observers,
    paints: () => paints,
    tick() { now += 50; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); },
    change() { observers.filter(o => o.connected).forEach(o => o.callback()); }
  };
}

const h = harness();
assert.equal(h.canvas.dataset.orientation, 'horizontal');
assert.equal(h.canvas.width, 1920, 'pixel density must be capped even on a 3x screen');
const initial = h.api.state().phase;
h.tick(); h.tick();
assert(h.api.state().phase > initial, 'enabled motion advances the drawing');
assert.equal(h.frames.size, 1, 'there is exactly one animation loop');
h.doc.documentElement.dataset.motion = 'off'; h.change();
const paused = h.api.state().phase;
const pausedPaints = h.paints();
h.tick(); h.tick();
assert.equal(h.api.state().phase, paused);
assert.equal(h.paints(), pausedPaints, 'stop means no repaint work, not just a frozen clock');
assert.equal(h.frames.size, 0);
assert.equal(h.canvas.dataset.waveState, 'still');
h.rect.width = 393; h.rect.height = 851; h.env.fire('resize');
assert.equal(h.canvas.dataset.orientation, 'vertical');
assert.equal(h.api.state().phase, paused, 'a stopped portrait resize keeps the same phase');
h.doc.documentElement.dataset.motion = 'on'; h.change(); h.change();
assert.equal(h.frames.size, 1, 'repeated settings changes cannot multiply the loop');
h.tick(); h.tick();
assert(h.api.state().phase > paused);
h.media.matches = true; h.media.fire('change');
assert.equal(h.frames.size, 0, 'OS reduced motion wins even with the in-app checkbox checked');
h.media.matches = false; h.media.fire('change');
assert.equal(h.frames.size, 1);
h.doc.hidden = true; h.doc.fire('visibilitychange');
assert.equal(h.frames.size, 0, 'hidden tabs spend no frames');
h.doc.hidden = false; h.doc.fire('visibilitychange');
assert.equal(h.frames.size, 1);
h.doc.documentElement.dataset.theme = 'dark'; h.change();
assert.equal(h.frames.size, 0, 'dark mode never animates the light-mode canvas');
h.doc.documentElement.dataset.theme = 'light'; h.change();
h.connection.saveData = true; h.connection.fire('change');
assert.equal(h.frames.size, 0, 'Save-Data receives a composed still');
h.connection.saveData = false; h.connection.fire('change');
h.env.fire('pagehide');
assert.equal(h.frames.size, 0);
h.env.fire('pageshow');
assert.equal(h.frames.size, 1, 'a back/forward cache restore resumes correctly');
h.api.destroy(); h.api.destroy();
assert.equal(h.frames.size, 0);
assert.equal(h.env.listeners.size, 0);
assert.equal(h.doc.listeners.size, 0);
assert.equal(h.media.listeners.size, 0);
assert(h.observers.every(o => !o.connected));
assert.equal(createLightWaves({ getContext: () => null }, h.env).state().available, false);

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert.match(html, /<canvas[^>]+id="lightWaves"[^>]+aria-hidden="true"/,
  'the actual page must mount the decorative canvas');
assert.match(html, /\/light-waves\.js\?v=__NV_ASSET_VERSION__/);
assert.match(fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8'), /\/light-waves\.js\?v=__NV_ASSET_VERSION__/);
console.log('light waves lifecycle, motion, orientation and delivery tests passed');
