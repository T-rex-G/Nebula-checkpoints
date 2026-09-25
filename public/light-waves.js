/*
 * Light-mode striped waves. Wave geometry adapted from Striped Waves by
 * Sabo Sugi, https://codepen.io/editor/sabosugi/pen/01a08b9f-ebd8-701d-bfaf-7b84426036b1
 *
 * The MIT License (MIT)
 * Copyright (c) 2026 Sabo Sugi
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * This adaptation draws paths, not a full-screen fragment shader. Its bounded
 * draw cost needs neither a new dependency nor a GPU context. Motion has one
 * owner: the existing data-motion setting, plus the OS accessibility preference.
 */
'use strict';
(function lightWavesModule(root) {
  function createLightWaves(canvas, env) {
    const doc = env.document;
    let ctx;
    try { ctx = canvas && canvas.getContext('2d'); } catch { /* decoration is optional */ }
    if (!ctx) return { destroy() {}, state: () => ({ available: false }) };

    const reduced = env.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = env.navigator && env.navigator.connection;
    let width = 0;
    let height = 0;
    let ratio = 1;
    let phase = 24.79;
    let frame = null;
    let previous = null;
    let destroyed = false;
    let portrait = false;
    let needsPaint = true;

    function light() { return doc.documentElement.dataset.theme === 'light'; }
    function suppressed() {
      return doc.documentElement.dataset.motion === 'off' || reduced.matches ||
        !!(connection && connection.saveData);
    }
    function active() { return !destroyed && light() && !doc.hidden && width > 0 && height > 0; }

    function draw() {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const alongSize = portrait ? height : width;
      const acrossSize = portrait ? width : height;
      const count = portrait ? 30 : 42;
      const segments = portrait ? 110 : 150;
      // Keep the ribbon off the main reading axis; the middle remains airy.
      const centre = acrossSize * (portrait ? 0.77 : 0.72);
      const scale = Math.min(acrossSize, 850) * 0.72;
      const gradient = portrait
        ? ctx.createLinearGradient(0, 0, 0, height)
        : ctx.createLinearGradient(0, 0, width, 0);
      /* Quartz: ribbons of the stone's own grey-rose, with a trace of the
       * product violet where they are deepest. */
      gradient.addColorStop(0, 'rgba(176,166,158,0)');
      gradient.addColorStop(0.20, 'rgba(168,158,150,0.22)');
      gradient.addColorStop(0.48, 'rgba(148,134,150,0.30)');
      gradient.addColorStop(0.72, 'rgba(190,176,172,0.24)');
      gradient.addColorStop(1, 'rgba(176,166,158,0)');
      ctx.strokeStyle = gradient;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let index = 0; index < count; index++) {
        const distribution = index / (count - 1) - 0.5;
        ctx.lineWidth = (portrait ? 1.5 : 2) + 0.4 * Math.cos(index * 0.17 + phase * 0.12);
        ctx.beginPath();
        for (let step = 0; step <= segments; step++) {
          const progress = step / segments;
          const y = (progress - 0.5) * 3.4;
          const shift = distribution * 1.35;
          const twist = y * 7.5 + phase * 0.12 + index * 0.17;
          const wave = Math.sin(y * 1.18 * 2.48 + phase * 0.46 + shift) * 0.153 +
            Math.sin(y * 2.31 * 2.48 - phase * 0.18 + shift * 0.63) * 0.153 * 0.19 +
            Math.cos(y * 0.54 * 2.48 + phase * 0.11 + shift * 0.31) * 0.153 * 0.08;
          const across = centre + scale * (distribution * 0.38 - 0.55 * 0.035 * y * y +
            wave + Math.sin(twist) * 0.0275 + Math.sin(twist * 2 + 0.8) * 0.0033);
          const along = progress * alongSize;
          const xPos = portrait ? across : along;
          const yPos = portrait ? along : across;
          if (step === 0) ctx.moveTo(xPos, yPos);
          else ctx.lineTo(xPos, yPos);
        }
        ctx.stroke();
      }
      needsPaint = false;
    }

    function stop() {
      if (frame !== null) env.cancelAnimationFrame(frame);
      frame = null;
      previous = null;
    }
    function tick(now) {
      frame = null;
      if (!active() || suppressed()) { sync(); return; }
      // A background needs gentle movement, not 120 full redraws per second.
      if (previous === null) previous = now;
      const elapsed = now - previous;
      if (elapsed >= 1000 / 30) {
        phase += Math.min(elapsed, 100) * 0.00024;
        previous = now;
        draw();
      }
      frame = env.requestAnimationFrame(tick);
    }
    function sync() {
      if (destroyed) return;
      if (!active()) {
        stop();
        canvas.dataset.waveState = 'hidden';
        return;
      }
      if (needsPaint) draw();
      if (suppressed()) {
        stop();
        canvas.dataset.waveState = 'still';
      } else {
        canvas.dataset.waveState = 'running';
        if (frame === null) frame = env.requestAnimationFrame(tick);
      }
    }
    function resize() {
      if (destroyed) return;
      const rect = canvas.getBoundingClientRect();
      const nextWidth = Math.round(rect.width);
      const nextHeight = Math.round(rect.height);
      const nextRatio = Math.min(Number(env.devicePixelRatio) || 1, 1.5);
      if (nextWidth !== width || nextHeight !== height || nextRatio !== ratio) {
        width = nextWidth;
        height = nextHeight;
        ratio = nextRatio;
        portrait = width < 900 && height > width;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.dataset.orientation = portrait ? 'vertical' : 'horizontal';
        needsPaint = true;
      }
      sync();
    }
    const observer = new env.MutationObserver(resize);
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
    const sizeObserver = env.ResizeObserver ? new env.ResizeObserver(resize) : null;
    if (sizeObserver) sizeObserver.observe(canvas);
    env.addEventListener('resize', resize);
    doc.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    if (connection && connection.addEventListener) connection.addEventListener('change', sync);
    env.addEventListener('pagehide', stop);
    env.addEventListener('pageshow', resize);
    resize();

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      observer.disconnect();
      if (sizeObserver) sizeObserver.disconnect();
      env.removeEventListener('resize', resize);
      doc.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
      if (connection && connection.removeEventListener) connection.removeEventListener('change', sync);
      env.removeEventListener('pagehide', stop);
      env.removeEventListener('pageshow', resize);
    }
    return { destroy, state: () => ({ available: true, phase, running: frame !== null, width, height, portrait }) };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createLightWaves };
  else if (root && root.document) {
    const canvas = root.document.getElementById('lightWaves');
    if (canvas) createLightWaves(canvas, root);
  }
})(typeof window === 'undefined' ? null : window);
