/*
 * The landing's Neural map, alive.
 *
 * The map itself stays the SVG it was -- panels, strands, hub, words -- and
 * this draws the motion over it on one canvas: a signal leaves a node, runs
 * its strand into the hub and lands as a ring; the hub's arcs turn and a
 * light rides each orbit. Drawing it here rather than animating SVG strokes
 * is what lets it move on a phone too: a canvas repaints itself and nothing
 * under it, where a moving stroke repainted the whole picture under a
 * scrolling finger.
 *
 * It runs only while the map is on screen, the page is visible and motion
 * is allowed (the data-motion setting and the OS preference). Without a 2D
 * context, or if it cannot keep pace, the canvas goes and the SVG's own
 * still strands are the picture. It is decoration, never content: the frame
 * says in words what the map shows.
 */

/* A box in the SVG's own units, as its viewBox gives it. */
export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/* How a viewBox point maps into the drawn box: scaled, then moved. */
export interface Fit { readonly scale: number; readonly x: number; readonly y: number }
export type Point = readonly [number, number];
export type Colour = readonly [number, number, number];

/* What the motion asks of the page it runs on: the window in the browser, a stand-in in a test. */
export interface MapEnv {
  readonly document: Document;
  matchMedia?(query: string): MotionQuery;
  readonly random?: () => number;
  getComputedStyle(element: Element): { readonly stroke: string; readonly display: string };
  readonly devicePixelRatio?: number;
  requestAnimationFrame(callback: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  readonly MutationObserver: typeof MutationObserver;
  readonly ResizeObserver?: typeof ResizeObserver;
  readonly IntersectionObserver?: typeof IntersectionObserver;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
}

/* The reader's motion preference, and whether it can be heard changing. */
export interface MotionQuery {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
}

export type MapState =
  | { readonly available: false }
  | {
    readonly available: true; readonly running: boolean; readonly retired: boolean; readonly onscreen: boolean;
    readonly width: number; readonly height: number; readonly ratio: number; readonly strands: number; readonly clock: number;
  };

export interface LandingMap {
  destroy(): void;
  state(): MapState;
}

interface Strand {
  readonly points: readonly Point[];
  readonly length: number;
  readonly colour: Colour;
  readonly duration: number;
  t: number;
}

interface Ring { readonly x: number; readonly y: number; readonly r: number; age: number; readonly colour: Colour }

interface Scene {
  readonly svg: SVGSVGElement;
  readonly box: Box;
  readonly hub: readonly [number, number, number];
  readonly arcRadius: number;
  readonly accent: Colour;
  readonly strands: readonly Strand[];
  readonly label: readonly [number, number, number, number] | null;
  readonly pulses: Ring[];
  readonly pings: Ring[];
}

type Mark = 'running' | 'paused' | 'still' | 'retired';

/* Where a viewBox point lands in a box the SVG draws with xMidYMid meet. */
export function meet(view: Box, width: number, height: number): Fit {
  const scale = Math.min(width / view.width, height / view.height);
  return {
    scale,
    x: (width - view.width * scale) / 2 - view.x * scale,
    y: (height - view.height * scale) / 2 - view.y * scale
  };
}

/* A point a fraction of the way along evenly spaced samples of a path. */
export function along(points: readonly Point[], t: number): [number, number] {
  const last = points.length - 1;
  const at = Math.max(0, Math.min(1, t)) * last;
  const index = Math.min(last - 1, Math.floor(at));
  const rest = at - index;
  const a = points[index];
  const b = points[index + 1];
  if (!a || !b) return points[0] ? [points[0][0], points[0][1]] : [0, 0];
  return [a[0] + (b[0] - a[0]) * rest, a[1] + (b[1] - a[1]) * rest];
}

/* Gentle at both ends: a signal gathers, runs, and settles into the hub. */
export function ease(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : 0.5 - Math.cos(Math.PI * t) / 2;
}

/* "rgb(1, 2, 3)" / "rgba(1, 2, 3, .5)" / "#abc" / "#aabbcc" -> [r, g, b]. */
export function rgb(value: unknown, fallback: Colour): Colour {
  const text = String(value || '').trim();
  const fn = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const h = hex.length === 3 ? hex.replace(/./g, c => c + c) : hex;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return fallback;
}

/*
 * The pace a decoration has to hold: past this, a slow device is spending
 * its frames on ornament, and the map goes back to standing still.
 */
export const BUDGET = Object.freeze({ frames: 40, medianMs: 60 });
const SAMPLES = 48;
const TAIL = 92;

const attribute = (element: Element, name: string): number => Number(element.getAttribute(name));

export function createLandingMap(view: HTMLElement, env: MapEnv): LandingMap {
  const doc = env.document;
  const html = doc.documentElement;
  const reduced: MotionQuery = env.matchMedia ? env.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const random = typeof env.random === 'function' ? env.random : Math.random;
  const canvas = doc.createElement('canvas');
  canvas.className = 'lp-map-fx';
  canvas.setAttribute('aria-hidden', 'true');
  let context: CanvasRenderingContext2D | null = null;
  try { context = canvas.getContext('2d'); } catch { /* decoration is optional */ }
  if (!context) return { destroy() {}, state: () => ({ available: false }) };
  const ctx: CanvasRenderingContext2D = context;
  view.appendChild(canvas);

  let width = 0;
  let height = 0;
  let ratio = 1;
  let map: Fit | null = null;
  let scene: Scene | null = null;
  let frame: number | null = null;
  let previous: number | null = null;
  let onscreen = false;
  let retired = false;
  let destroyed = false;
  let clock = 0;
  const gaps: number[] = [];
  const sprites = new Map<string, HTMLCanvasElement>();

  const light = (): boolean => html.dataset.theme === 'light';
  const still = (): boolean => html.dataset.motion === 'off' || Boolean(reduced.matches);
  const visibleMap = (): SVGSVGElement | null => [...view.querySelectorAll<SVGSVGElement>('svg.lp-map')]
    .find(svg => env.getComputedStyle(svg).display !== 'none') || null;

  function mark(state: Mark): void {
    if (view.dataset.fx !== state) view.dataset.fx = state;
    view.classList.toggle('has-fx', state === 'running' || state === 'paused');
  }

  /* Everything the motion needs from the picture, read once per layout or theme. */
  function read(svg: SVGSVGElement): Scene | null {
    const box = svg.viewBox?.baseVal;
    if (!box || !box.width) return null;
    const orb = svg.querySelector('.lp-map-orb');
    if (!orb) return null;
    const hub = [attribute(orb, 'cx'), attribute(orb, 'cy'), attribute(orb, 'r')] as const;
    const arc = svg.querySelector('.lp-map-arcs path');
    const arcRadius = arc ? Number((arc.getAttribute('d') ?? '').match(/A\s*([\d.]+)/)?.[1]) || hub[2] + 8 : hub[2] + 8;
    const accent = rgb(arc ? env.getComputedStyle(arc).stroke : '', [167, 139, 250]);
    /* The repository's name stays on top of everything that moves past it. */
    const pill = svg.querySelector('.lp-map-pill');
    const label = pill ? [attribute(pill, 'x') || 0, attribute(pill, 'y') || 0, attribute(pill, 'width') || 0, attribute(pill, 'height') || 0] as const : null;
    const strands: Strand[] = [];
    [...svg.querySelectorAll<SVGGeometryElement>('.lp-map-strand')].forEach((path, index) => {
      let length = 0;
      try { length = path.getTotalLength(); } catch { length = 0; }
      if (!length) return;
      const points: Point[] = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const p = path.getPointAtLength((length * i) / SAMPLES);
        points.push([p.x, p.y]);
      }
      strands.push({
        points, length,
        colour: rgb(env.getComputedStyle(path).stroke, accent),
        duration: 2.1 + (index % 5) * 0.32,
        t: -(0.15 + random() * 2.6)
      });
    });
    return { svg, box: { x: box.x, y: box.y, width: box.width, height: box.height }, hub, arcRadius, accent, strands, label,
      pulses: [], pings: [] };
  }

  /* One soft head per colour, drawn once: a white core on dark, the colour itself on light. */
  function sprite(colour: Colour): HTMLCanvasElement | null {
    const key = `${colour.join(',')}|${light() ? 'l' : 'd'}`;
    const known = sprites.get(key);
    if (known) return known;
    const size = 64;
    const art = doc.createElement('canvas');
    art.width = size;
    art.height = size;
    const pen = art.getContext('2d');
    if (!pen) return null;
    const [r, g, b] = colour;
    const glow = pen.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    if (light()) {
      glow.addColorStop(0, `rgba(${r},${g},${b},1)`);
      glow.addColorStop(0.22, `rgba(${r},${g},${b},.85)`);
      glow.addColorStop(0.5, `rgba(${r},${g},${b},.18)`);
    } else {
      glow.addColorStop(0, 'rgba(255,255,255,1)');
      glow.addColorStop(0.16, `rgba(${r},${g},${b},.95)`);
      glow.addColorStop(0.42, `rgba(${r},${g},${b},.28)`);
    }
    glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
    pen.fillStyle = glow;
    pen.fillRect(0, 0, size, size);
    sprites.set(key, art);
    return art;
  }

  function layout(): void {
    if (destroyed) return;
    /*
     * The layout size, not the drawn one: the frame tilts flat as it
     * scrolls in, and a bounding box read mid-tilt is the box scaled by
     * the tilt -- a canvas sized from it drew every light off its strand
     * once the frame settled. The bounding box stands in only where there
     * is no layout to read.
     */
    const rect = view.clientWidth && view.clientHeight
      ? { width: view.clientWidth, height: view.clientHeight }
      : view.getBoundingClientRect();
    const nextWidth = Math.round(rect.width);
    const nextHeight = Math.round(rect.height);
    const nextRatio = Math.min(Number(env.devicePixelRatio) || 1, 2);
    if (nextWidth !== width || nextHeight !== height || nextRatio !== ratio) {
      width = nextWidth;
      height = nextHeight;
      ratio = nextRatio;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
    }
    const svg = visibleMap();
    if (!svg) { scene = null; sync(); return; }
    if (!scene || scene.svg !== svg) scene = read(svg);
    map = scene ? meet(scene.box, width, height) : null;
    sync();
  }

  function recolour(): void {
    sprites.clear();
    if (scene) scene = read(scene.svg);
    sync();
  }

  function draw(dt: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!scene || !map) return;
    const shown = scene;
    const s = map.scale * ratio;
    ctx.setTransform(s, 0, 0, s, map.x * ratio, map.y * ratio);
    ctx.save();
    if (shown.label) {
      const { box } = shown;
      const [lx, ly, lw, lh] = shown.label;
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.width, box.height);
      ctx.rect(lx - 1, ly - 1, lw + 2, lh + 2);
      ctx.clip('evenodd');
    }
    const onLight = light();
    ctx.globalCompositeOperation = onLight ? 'source-over' : 'lighter';
    ctx.lineCap = 'round';
    const px = 1 / map.scale;
    const [hx, hy, hr] = shown.hub;
    const [ar, ag, ab] = shown.accent;

    /*
     * No lights ride the orbits. A comet circling each ring read as stray
     * scratches crossing the strands -- motion that carried no signal --
     * so the only things that move are what a signal does: run a strand,
     * land at the hub, and the hub's own arcs turning.
     */

    /* The hub's two arcs, turning once every eleven seconds. */
    const spin = (clock * Math.PI * 2) / 11;
    ctx.strokeStyle = `rgba(${ar},${ag},${ab},${onLight ? 0.75 : 0.7})`;
    ctx.lineWidth = Math.max(2, 2 * px);
    for (const [from, to] of [[0, 1.96], [Math.PI, Math.PI + 2.1]] as const) {
      ctx.beginPath();
      ctx.arc(hx, hy, shown.arcRadius, from + spin, to + spin);
      ctx.stroke();
    }

    /* Rings where a signal landed, and where one set out. */
    const rings = (list: Ring[], life: number, grow: number): void => {
      for (let i = list.length - 1; i >= 0; i--) {
        const ring = list[i];
        if (!ring) continue;
        ring.age += dt;
        const k = ring.age / life;
        if (k >= 1) { list.splice(i, 1); continue; }
        const [r, g, b] = ring.colour;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r + grow * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - k) * (onLight ? 0.55 : 0.5)})`;
        ctx.lineWidth = Math.max(1.2, 1.6 * px);
        ctx.stroke();
      }
    };
    rings(shown.pulses, 1.6, hr * 1.5);
    rings(shown.pings, 0.9, 12);

    /* The signals: a soft tail along the strand and a bright head. */
    shown.strands.forEach(strand => {
      const before = strand.t;
      strand.t += dt / strand.duration;
      const start = strand.points[0];
      if (before < 0 && strand.t >= 0 && start) {
        shown.pings.push({ x: start[0], y: start[1], r: 9, age: 0, colour: strand.colour });
      }
      if (strand.t >= 1) {
        shown.pulses.push({ x: hx, y: hy, r: hr, age: 0, colour: strand.colour });
        if (shown.pulses.length > 8) shown.pulses.shift();
        strand.t = -(0.5 + random() * 2.4);
        return;
      }
      if (strand.t < 0) return;
      const head = ease(strand.t);
      const fade = Math.min(1, strand.t / 0.1, (1 - strand.t) / 0.12);
      const tail = TAIL / strand.length;
      const [r, g, b] = strand.colour;
      const steps = 12;
      for (let k = 0; k < steps; k++) {
        const from = along(strand.points, head - (tail * k) / steps);
        const to = along(strand.points, head - (tail * (k + 1)) / steps);
        const fall = 1 - k / steps;
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
        ctx.strokeStyle = `rgba(${r},${g},${b},${fade * fall * fall * (onLight ? 0.95 : 0.85)})`;
        ctx.lineWidth = Math.max(1.2, (0.8 + 2.8 * fall) * Math.max(1, px * 0.8));
        ctx.stroke();
      }
      const glow = sprite(strand.colour);
      if (glow) {
        const [x, y] = along(strand.points, head);
        const size = 30 * Math.max(1, px * 0.7);
        ctx.globalAlpha = fade;
        ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
        ctx.globalAlpha = 1;
      }
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  /* A slow device keeps the still map rather than a stuttering one. */
  function hold(gap: number): void {
    if (gaps.length >= BUDGET.frames) return;
    gaps.push(gap);
    if (gaps.length < BUDGET.frames) return;
    const sorted = gaps.slice().sort((a, b) => a - b);
    if ((sorted[Math.floor(sorted.length / 2)] ?? 0) > BUDGET.medianMs) retire();
  }

  function tick(now: number): void {
    frame = null;
    if (!running()) { sync(); return; }
    const gap = previous === null ? 16 : now - previous;
    previous = now;
    if (gap > 0 && gap < 1000) hold(gap);
    if (retired) return;
    const dt = Math.min(0.05, Math.max(0, gap) / 1000);
    clock += dt;
    draw(dt);
    frame = env.requestAnimationFrame(tick);
  }

  const running = (): boolean => !destroyed && !retired && onscreen && !doc.hidden && !still() && Boolean(scene) && width > 0 && height > 0;

  function stop(): void {
    if (frame !== null) env.cancelAnimationFrame(frame);
    frame = null;
    previous = null;
  }

  function sync(): void {
    if (destroyed || retired) return;
    if (still() || !scene) {
      stop();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      mark('still');
      return;
    }
    if (!running()) { stop(); mark('paused'); return; }
    mark('running');
    if (frame === null) frame = env.requestAnimationFrame(tick);
  }

  function retire(): void {
    retired = true;
    stop();
    canvas.remove();
    mark('retired');
  }

  const observer = new env.MutationObserver(() => recolour());
  observer.observe(html, { attributes: true, attributeFilter: ['data-theme', 'data-motion', 'data-design'] });
  const sizeObserver = env.ResizeObserver ? new env.ResizeObserver(layout) : null;
  sizeObserver?.observe(view);
  const watch = env.IntersectionObserver ? new env.IntersectionObserver(entries => {
    entries.forEach(entry => { onscreen = entry.isIntersecting; });
    sync();
  }, { rootMargin: '80px 0px' }) : null;
  if (watch) watch.observe(view);
  else onscreen = true;
  const onMotion = (): void => sync();
  reduced.addEventListener?.('change', onMotion);
  doc.addEventListener('visibilitychange', onMotion);
  env.addEventListener('resize', layout);
  layout();

  function destroy(): void {
    if (destroyed) return;
    stop();
    destroyed = true;
    observer.disconnect();
    sizeObserver?.disconnect();
    watch?.disconnect();
    reduced.removeEventListener?.('change', onMotion);
    doc.removeEventListener('visibilitychange', onMotion);
    env.removeEventListener('resize', layout);
    canvas.remove();
    view.classList.remove('has-fx');
    delete view.dataset.fx;
  }
  return {
    destroy,
    state: () => ({
      available: true, running: frame !== null, retired, onscreen, width, height, ratio,
      strands: scene ? scene.strands.length : 0, clock
    })
  };
}

/* On the page, the map in the landing's frame starts as soon as it is there; a test imports only what is above. */
if (typeof window !== 'undefined') {
  const view = window.document.querySelector<HTMLElement>('.lp-show .lp-frame-view');
  if (view) createLandingMap(view, window);
}
