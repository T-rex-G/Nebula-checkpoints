/*
 * Loader for the design's WebGL pieces.
 *
 * The galaxy pulls three.js behind it -- around 750KB across two files.
 * That is a deliberate cost for the product's personality, but it is not a
 * cost every visit should pay, so nothing here downloads until three
 * questions are answered:
 *
 *   1. Is the artwork actually on screen? The modules load when the screen
 *      that hosts them is shown, not at boot. A reader who signs in and goes
 *      straight to a repository never fetches them.
 *   2. Can this device draw it? A probe context is created and immediately
 *      released. Without WebGL the download would buy a blank box.
 *   3. Should this device draw it? A reader on a metered connection has said
 *      so through Save-Data, and decoration is the first thing to drop.
 *
 * Failure is silent by design. Every path here ends in "the interface renders
 * exactly as it does without the artwork", which is a complete interface --
 * so an error surfaced to the reader would be reporting a problem they do not
 * have.
 *
 * The loader is made over the page it serves (nebula-visuals.ts makes the
 * page's own), so each of those answers can be asked of it directly.
 */

import { field } from '../platform/values.ts';

export type VisualKind = 'galaxy' | 'singularity';

/* The custom element each piece defines once its module has run. */
export const TAGS: Readonly<Record<VisualKind, string>> = Object.freeze({ galaxy: 'nebula-galaxy', singularity: 'nebula-singularity' });

/*
 * Software rasterisers report themselves here. A machine with no usable GPU
 * still hands back a WebGL context -- Chrome falls back to SwiftShader, Mesa
 * to llvmpipe -- so "has WebGL" is not the same question as "can draw this".
 * Both of these pieces are shader-heavy and full-viewport; on a CPU
 * rasteriser they do not render slowly, they starve the interface around
 * them. Measured on this project's own browser suite, mounting under
 * SwiftShader took the run from under three minutes to over eight and timed
 * two journeys out.
 *
 * So a software renderer is treated as no renderer. The reader keeps a fast
 * interface, which is worth more than decoration they would experience as
 * jank.
 */
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render/i;

/*
 * The name is not always there to read. WebKit reports a generic renderer
 * for privacy, so a WebKit build drawing on the CPU passed the name check,
 * mounted the singularity, and painted one frame in thirty seconds: the
 * landing froze, and its sign-in button never held still long enough to be
 * pressed. Two more answers close that gap. The probe asks the browser to
 * refuse a context it would draw in software (failIfMajorPerformanceCaveat,
 * as the hero's vortex already does), and a mounted piece is held to a
 * frame budget: the first second or so of frames is timed, and a piece that
 * drags the page under it is taken down for the session.
 */
export const BUDGET = Object.freeze({ frames: 24, firstFrameMs: 4000, frameMs: 1000, medianMs: 45, minimum: 12 });

/*
 * The landing's ambient motion -- the beam round the entry bar, the readings
 * floating at the galaxy's edge, the sheen on the title, the pulsing dot --
 * never stops while the page is open. On a GPU that is a handful of
 * composited layers; drawn on the CPU it is every frame repainted by hand,
 * and a WebKit build doing exactly that fell from about thirteen frames a
 * second to four, froze, and was killed before its sign-in button could be
 * pressed. So it answers to the same question as the artwork, and then has
 * to earn it: the root carries data-ambient="on" only on a device that would
 * draw the galaxy AND is already keeping a steady frame rate with the motion
 * off, and loses it for the session if the frame rate falls once it is on,
 * or the moment a mounted piece misses its frame budget. WebKit hides its
 * renderer's name, so the measured frames are the answer that cannot be
 * masked. The CSS runs none of it without the attribute, so a device that
 * never earns it stays still -- the light is still there, it just does not
 * drift.
 */
export const AMBIENT = Object.freeze({ earn: 20, earnMs: 40, hold: 60, holdMs: 50 });

/* What the loader asks of the page: its document, its window, and each piece's module. */
export interface VisualsPage {
  readonly document: Document;
  readonly window: {
    readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    readonly matchMedia?: (query: string) => { readonly matches: boolean };
    readonly customElements?: { get(name: string): CustomElementConstructor | undefined };
    /* Its connection, where the browser says whether the reader is saving data, is not one every browser has. */
    readonly navigator?: unknown;
  };
  /*
   * Each piece is its own chunk of the build, named by its content. The
   * server caches built files for a year on the promise that their names
   * change when their contents do -- a module imported by a bare, unchanging
   * path once kept a phone on last week's galaxy, violet in the Obsidian
   * preset, until its cache happened to expire.
   */
  readonly modules: Readonly<Record<VisualKind, () => Promise<unknown>>>;
}

export interface Visuals {
  /* Mounts one piece into its host; true once it is drawn there, false when the interface goes on without it. */
  mount(kind: string, host: HTMLElement | null | undefined): Promise<boolean>;
  /* Follows the theme toggle, for whichever pieces are already mounted. */
  repaint(): void;
  /* Whether this device can draw the pieces: a hardware WebGL context, asked once. */
  supportsWebGL(): boolean;
  /* Measures whether the landing may run its ambient motion, and keeps measuring once it does. */
  watchAmbient(): void;
}

const isKind = (kind: string): kind is VisualKind => kind === 'galaxy' || kind === 'singularity';
const medianOf = (gaps: readonly number[]): number => gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;

/* A WebGL context's renderer name, from the debug extension where the browser offers it. */
function rendererOf(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const named: unknown = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
  return String(named || gl.getParameter(gl.RENDERER) || '');
}

export function createVisuals(page: VisualsPage): Visuals {
  const { document: doc, window: win, modules } = page;
  const requested = new Map<VisualKind, Promise<unknown>>();
  let capable: boolean | null = null;
  let ambientLost = false;

  /*
   * One probe, cached. Creating a context is not free, and the answer cannot
   * change within a session; the context is released immediately so the probe
   * never holds one of the browser's limited WebGL slots.
   */
  function supportsWebGL(): boolean {
    if (capable !== null) return capable;
    capable = false;
    try {
      const canvas = doc.createElement('canvas');
      const ask: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
      const gl = canvas.getContext('webgl2', ask) ?? canvas.getContext('webgl', ask);
      if (gl && typeof gl.getExtension === 'function') {
        capable = !SOFTWARE_RENDERER.test(rendererOf(gl));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      capable = false;
    }
    return capable;
  }

  const metered = (): boolean => field(field(win.navigator, 'connection'), 'saveData') === true;

  /*
   * Small screens get the cheaper draw: fewer strands, no star field, a lower
   * pixel-ratio cap. The component reads this from its own attribute, so the
   * decision belongs here where the viewport is known.
   */
  const density = (): 'low' | 'high' => (win.matchMedia?.('(max-width: 700px)').matches ? 'low' : 'high');
  /* Which design preset the artwork is drawn for: Nebula's violets, or Obsidian's silver and graphite. */
  const design = (): 'obsidian' | 'nebula' => (doc.documentElement.dataset.design === 'obsidian' ? 'obsidian' : 'nebula');
  const theme = (): 'light' | 'dark' => (doc.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  /*
   * Lost once, lost for the session: a watch stops at the first frame after a
   * loss, whoever lost it, so nothing earns it back.
   */
  function settleAmbient(on: boolean): void {
    if (!on) ambientLost = true;
    doc.documentElement.dataset.ambient = on ? 'on' : 'off';
  }

  /*
   * The frames are measured with the motion still off; a steady rate earns it,
   * and once on it is held to a rate of its own. Asked of the page once, after
   * it has loaded, so the frames measured are the page at rest rather than the
   * page being built.
   */
  function watchAmbient(): void {
    const frame = win.requestAnimationFrame;
    if (typeof frame !== 'function' || !supportsWebGL() || metered()) {
      settleAmbient(false);
      return;
    }
    let gaps: number[] = [];
    let last = 0;
    let earned = false;
    const tick = (now: number): void => {
      if (ambientLost) return;
      if (last) gaps.push(now - last);
      last = now;
      if (gaps.length < (earned ? AMBIENT.hold : AMBIENT.earn)) {
        frame(tick);
        return;
      }
      const median = medianOf(gaps);
      if (!earned) {
        if (median > AMBIENT.earnMs) { settleAmbient(false); return; }
        earned = true;
        gaps = [];
        settleAmbient(true);
        frame(tick);
        return;
      }
      if (median > AMBIENT.holdMs) settleAmbient(false);
    };
    frame(tick);
  }

  /*
   * Times the page's frames while a newly mounted piece settles in. The first
   * interval is the piece compiling its shaders and is allowed to be long, if
   * not endless; after it, a single frame of a second or a median under about
   * twenty frames a second means the device is drawing this on its CPU. The
   * piece is then removed, its context released, the host marked as failed --
   * which every caller already treats as "no artwork" -- and no other piece is
   * mounted this session. A hidden page draws no frames, so it is never judged.
   */
  function holdToBudget(host: HTMLElement, element: HTMLElement): void {
    const frame = win.requestAnimationFrame;
    if (typeof frame !== 'function') return;
    const gaps: number[] = [];
    let last = 0;
    const retire = (): void => {
      capable = false;
      const canvas = element.querySelector('canvas');
      const gl = canvas ? (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) : null;
      const lose = gl ? gl.getExtension('WEBGL_lose_context') : null;
      element.remove();
      lose?.loseContext();
      host.dataset.nebulaMounted = 'failed';
      settleAmbient(false);
      host.dispatchEvent(new CustomEvent('nebula-visual-retired', { bubbles: true }));
    };
    const tick = (now: number): void => {
      if (!element.isConnected) return;
      if (last) gaps.push(now - last);
      last = now;
      const first = gaps[0] ?? 0;
      const rest = gaps.slice(1);
      if (first > BUDGET.firstFrameMs || rest.some(gap => gap > BUDGET.frameMs)) { retire(); return; }
      if (rest.length >= BUDGET.minimum && medianOf(rest) > BUDGET.medianMs) { retire(); return; }
      if (gaps.length < BUDGET.frames) frame(tick);
    };
    frame(tick);
  }

  /*
   * Mounts one piece into a host element. The custom element is only created
   * after its module has defined it, so a failed import leaves the host empty
   * rather than leaving an undefined element in the tree. The device is asked
   * before the module is: a refused device never downloads it.
   */
  async function mount(kind: string, host: HTMLElement | null | undefined): Promise<boolean> {
    if (!host || host.dataset.nebulaMounted === 'true') return false;
    if (!isKind(kind) || !supportsWebGL() || metered()) return false;
    host.dataset.nebulaMounted = 'true';
    try {
      let loading = requested.get(kind);
      if (!loading) {
        loading = modules[kind]();
        requested.set(kind, loading);
      }
      await loading;
      const tag = TAGS[kind];
      if (!win.customElements?.get(tag)) throw new Error(`${tag} did not define`);
      const element = doc.createElement(tag);
      element.setAttribute('theme', theme());
      element.setAttribute('design', design());
      element.setAttribute('density', density());
      host.appendChild(element);
      holdToBudget(host, element);
      return true;
    } catch {
      /* The interface is complete without it; leaving the host empty is correct. */
      host.dataset.nebulaMounted = 'failed';
      return false;
    }
  }

  function repaint(): void {
    const next = theme();
    const preset = design();
    doc.querySelectorAll(Object.values(TAGS).join(', '))
      .forEach(element => { element.setAttribute('theme', next); element.setAttribute('design', preset); });
  }

  return Object.freeze({ mount, repaint, supportsWebGL, watchAmbient });
}
