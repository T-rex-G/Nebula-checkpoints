/*!
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
import { field } from '../platform/values.ts';

/* The parts of a browser the waves use: the page they draw on, the clock, the observers and the motion settings. */
export interface WavesEnv {
  readonly document: Document;
  readonly navigator?: unknown;
  readonly devicePixelRatio?: number;
  matchMedia(query: string): MediaQueryList;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  readonly MutationObserver: typeof MutationObserver;
  readonly ResizeObserver?: typeof ResizeObserver;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/* What a test may ask of the waves. */
export interface WavesState {
  readonly available: boolean;
  readonly phase?: number;
  readonly running?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly portrait?: boolean;
}

export interface LightWaves {
  destroy(): void;
  state(): WavesState;
}

/* A connection that says whether the reader saves data, and says when that changes; not every browser has one. */
interface Connection {
  readonly saveData: boolean;
  readonly listen: (listener: () => void) => void;
  readonly unlisten: (listener: () => void) => void;
}
function connectionOf(navigator: unknown): Connection | null {
  const connection = field(navigator, 'connection');
  if (!connection || typeof connection !== 'object') return null;
  const add = field(connection, 'addEventListener');
  const remove = field(connection, 'removeEventListener');
  return {
    get saveData() { return field(connection, 'saveData') === true; },
    listen: listener => { if (typeof add === 'function') add.call(connection, 'change', listener); },
    unlisten: listener => { if (typeof remove === 'function') remove.call(connection, 'change', listener); }
  };
}

type Stops = readonly (readonly [number, string])[];
const NEBULA: Stops = [[0, 'rgba(144,114,225,0)'], [0.20, 'rgba(130,96,213,0.26)'], [0.48, 'rgba(109,64,207,0.46)'],
  [0.72, 'rgba(112,132,213,0.32)'], [1, 'rgba(144,114,225,0)']];
const QUARTZ: Stops = [[0, 'rgba(176,166,158,0)'], [0.20, 'rgba(168,158,150,0.22)'], [0.48, 'rgba(148,134,150,0.30)'],
  [0.72, 'rgba(190,176,172,0.24)'], [1, 'rgba(176,166,158,0)']];

export function createLightWaves(canvas: HTMLCanvasElement | null, env: WavesEnv): LightWaves {
  const doc = env.document;
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = canvas ? canvas.getContext('2d') : null; } catch { /* decoration is optional */ }
  if (!canvas || !ctx) return { destroy() {}, state: () => ({ available: false }) };
  const pen: CanvasRenderingContext2D = ctx;
  const surface: HTMLCanvasElement = canvas;

  const reduced = env.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = connectionOf(env.navigator);
  let width = 0;
  let height = 0;
  let ratio = 1;
  let phase = 24.79;
  let frame: number | null = null;
  let previous: number | null = null;
  let destroyed = false;
  let portrait = false;
  let needsPaint = true;

  const light = (): boolean => doc.documentElement.dataset.theme === 'light';
  const suppressed = (): boolean => doc.documentElement.dataset.motion === 'off' || reduced.matches || Boolean(connection?.saveData);
  const active = (): boolean => !destroyed && light() && !doc.hidden && width > 0 && height > 0;

  function draw(): void {
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
    pen.clearRect(0, 0, width, height);
    const alongSize = portrait ? height : width;
    const acrossSize = portrait ? width : height;
    const count = portrait ? 30 : 42;
    const segments = portrait ? 110 : 150;
    // Keep the ribbon off the main reading axis; the middle remains airy.
    const centre = acrossSize * (portrait ? 0.77 : 0.72);
    const scale = Math.min(acrossSize, 850) * 0.72;
    const gradient = portrait
      ? pen.createLinearGradient(0, 0, 0, height)
      : pen.createLinearGradient(0, 0, width, 0);
    /* Nebula: violet silk. Quartz (Obsidian's light): ribbons of the
     * stone's own grey-rose, with a trace of violet where they are deepest. */
    const stops = doc.documentElement.dataset.design === 'obsidian' ? QUARTZ : NEBULA;
    stops.forEach(([at, colour]) => gradient.addColorStop(at, colour));
    pen.strokeStyle = gradient;
    pen.lineCap = 'round';
    pen.lineJoin = 'round';
    for (let index = 0; index < count; index++) {
      const distribution = index / (count - 1) - 0.5;
      pen.lineWidth = (portrait ? 1.5 : 2) + 0.4 * Math.cos(index * 0.17 + phase * 0.12);
      pen.beginPath();
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
        if (step === 0) pen.moveTo(xPos, yPos);
        else pen.lineTo(xPos, yPos);
      }
      pen.stroke();
    }
    needsPaint = false;
  }

  function stop(): void {
    if (frame !== null) env.cancelAnimationFrame(frame);
    frame = null;
    previous = null;
  }
  function tick(now: number): void {
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
  function sync(): void {
    if (destroyed) return;
    if (!active()) {
      stop();
      surface.dataset.waveState = 'hidden';
      return;
    }
    if (needsPaint) draw();
    if (suppressed()) {
      stop();
      surface.dataset.waveState = 'still';
    } else {
      surface.dataset.waveState = 'running';
      if (frame === null) frame = env.requestAnimationFrame(tick);
    }
  }
  function resize(): void {
    if (destroyed) return;
    const rect = surface.getBoundingClientRect();
    const nextWidth = Math.round(rect.width);
    const nextHeight = Math.round(rect.height);
    const nextRatio = Math.min(Number(env.devicePixelRatio) || 1, 1.5);
    if (nextWidth !== width || nextHeight !== height || nextRatio !== ratio) {
      width = nextWidth;
      height = nextHeight;
      ratio = nextRatio;
      portrait = width < 900 && height > width;
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      surface.dataset.orientation = portrait ? 'vertical' : 'horizontal';
      needsPaint = true;
    }
    sync();
  }
  /* A theme or preset change repaints even a still ribbon: its colours are the preset's. */
  const observer = new env.MutationObserver(() => { needsPaint = true; resize(); });
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion', 'data-design'] });
  const sizeObserver = env.ResizeObserver ? new env.ResizeObserver(resize) : null;
  if (sizeObserver) sizeObserver.observe(surface);
  env.addEventListener('resize', resize);
  doc.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  connection?.listen(sync);
  env.addEventListener('pagehide', stop);
  env.addEventListener('pageshow', resize);
  resize();

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    stop();
    observer.disconnect();
    if (sizeObserver) sizeObserver.disconnect();
    env.removeEventListener('resize', resize);
    doc.removeEventListener('visibilitychange', sync);
    reduced.removeEventListener('change', sync);
    connection?.unlisten(sync);
    env.removeEventListener('pagehide', stop);
    env.removeEventListener('pageshow', resize);
  }
  return { destroy, state: () => ({ available: true, phase, running: frame !== null, width, height, portrait }) };
}

/* The page's own waves, behind the light theme. */
if (typeof window !== 'undefined') {
  const canvas = document.getElementById('lightWaves');
  if (canvas instanceof HTMLCanvasElement) createLightWaves(canvas, window);
}
