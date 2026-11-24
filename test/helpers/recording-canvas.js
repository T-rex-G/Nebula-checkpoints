'use strict';
/*
 * A 2D canvas context that draws nothing and keeps every call and every
 * property written, in order, for tests of what the Neural map draws.
 *
 * Text is measured as wide as a monospace face of the context's font size
 * would set it, so fitting and pills behave as they would. A context can be
 * made with or without roundRect and letter spacing, as browsers differ.
 */

function recordingCanvas(options = {}) {
  const calls = [];
  const state = {
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1, fillStyle: '#000000',
    strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)',
    globalCompositeOperation: 'source-over', lineDashOffset: 0, letterSpacing: '0px'
  };
  const stack = [];
  const gradient = (kind, args) => {
    const stops = [];
    const made = { kind, args, stops, addColorStop: (offset, color) => stops.push([offset, color]) };
    calls.push({ call: `create${kind}Gradient`, args, gradient: made });
    return made;
  };
  const methods = {
    measureText: text => {
      const size = Number((/(\d+(?:\.\d+)?)px/.exec(state.font) || [])[1] || 10);
      const spacing = state.letterSpacing === '0px' ? 0 : Number.parseFloat(state.letterSpacing) || 0;
      return { width: String(text).length * (size * .6 + spacing) };
    },
    createLinearGradient: (...args) => gradient('Linear', args),
    createRadialGradient: (...args) => gradient('Radial', args),
    save: () => { stack.push({ ...state }); calls.push({ call: 'save', args: [] }); },
    restore: () => { const top = stack.pop(); if (top) Object.assign(state, top); calls.push({ call: 'restore', args: [] }); }
  };
  if (options.roundRect !== false) methods.roundRect = (...args) => calls.push({ call: 'roundRect', args });
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(methods, prop)) return methods[prop];
      if (Object.prototype.hasOwnProperty.call(state, prop)) return state[prop];
      if (typeof prop === 'symbol' || prop === 'roundRect' || prop === 'then') return undefined;
      return (...args) => { calls.push({ call: prop, args, state: { ...state } }); };
    },
    set(target, prop, value) { state[prop] = value; calls.push({ set: prop, value }); return true; },
    has(target, prop) { return prop === 'letterSpacing' ? options.letterSpacing !== false : prop in methods || prop in state; }
  });
  return {
    ctx, calls,
    /* Every call of one name, with its arguments and the state it was made in. */
    named: name => calls.filter(entry => entry.call === name),
    /* Every value a property was given, in order. */
    written: name => calls.filter(entry => entry.set === name).map(entry => entry.value),
    /* Every colour put on the canvas: styles written, shadow colours, gradient stops. */
    colours: () => calls.flatMap(entry => {
      if (entry.set === 'fillStyle' || entry.set === 'strokeStyle' || entry.set === 'shadowColor') {
        return typeof entry.value === 'string' ? [entry.value] : entry.value && entry.value.stops ? entry.value.stops.map(stop => stop[1]) : [];
      }
      return [];
    })
  };
}

/* A Path2D that keeps the path it was given, for a test that has no canvas of its own. */
class RecordedPath {
  constructor(d) { this.d = String(d); }
}

module.exports = { recordingCanvas, RecordedPath };
