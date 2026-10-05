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
 */
'use strict';

(function nebulaVisuals(global) {
  /*
   * Stamped with the build like every other script. The server caches
   * static files for a week on the promise that their URLs change when their
   * contents do; the module was imported by bare path, so a phone kept
   * running last week's galaxy -- violet in the Obsidian preset -- until its
   * cache happened to expire.
   */
  const STAMP = (document.documentElement && document.documentElement.dataset.nvAssetVersion) || '';
  const versioned = file => (STAMP ? `${file}?v=${encodeURIComponent(STAMP)}` : file);
  const MODULES = Object.freeze({
    galaxy: versioned('/nebula-galaxy.js'),
    singularity: versioned('/nebula-singularity.js')
  });
  const TAGS = Object.freeze({ galaxy: 'nebula-galaxy', singularity: 'nebula-singularity' });

  const requested = new Map();
  let capable = null;

  /*
   * One probe, cached. Creating a context is not free, and the answer cannot
   * change within a session; the context is released immediately so the probe
   * never holds one of the browser's limited WebGL slots.
   */
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
  const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render/i;

  /*
   * The name is not always there to read. WebKit reports a generic renderer
   * for privacy, so a WebKit build drawing on the CPU passed the name check,
   * mounted the singularity, and painted one frame in thirty seconds: the
   * landing froze, and its sign-in button never held still long enough to be
   * pressed. Two more answers close that gap. The probe asks the browser to
   * refuse a context it would draw in software (failIfMajorPerformanceCaveat,
   * as the hero's vortex already does), and a mounted piece is held to a
   * frame budget below: the first second or so of frames is timed, and a
   * piece that drags the page under it is taken down for the session.
   */
  const BUDGET = Object.freeze({ frames: 24, firstFrameMs: 4000, frameMs: 1000, medianMs: 45, minimum: 12 });

  function supportsWebGL() {
    if (capable !== null) return capable;
    capable = false;
    try {
      const canvas = document.createElement('canvas');
      const ask = { failIfMajorPerformanceCaveat: true };
      const gl = canvas.getContext('webgl2', ask) || canvas.getContext('webgl', ask);
      if (gl && typeof gl.getExtension === 'function') {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = String(
          (info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || ''
        );
        capable = !SOFTWARE_RENDERER.test(renderer);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch {
      capable = false;
    }
    return capable;
  }

  /*
   * The landing's ambient motion -- the drifting light behind the hero, the
   * beam round the entry bar, the readings floating at the galaxy's edge, the
   * sheen on the title, the pulsing dot -- never stops while the page is
   * open. On a GPU that is a handful of composited layers; drawn on the CPU it
   * is every frame repainted by hand, and a WebKit build doing exactly that
   * fell from about thirteen frames a second to four, froze, and was killed
   * before its sign-in button could be pressed. So it answers to the same
   * question as the artwork, and then has to earn it: the root carries
   * data-ambient="on" only on a device that would draw the galaxy AND is
   * already keeping a steady frame rate with the motion off, and loses it for
   * the session if the frame rate falls once it is on, or the moment a
   * mounted piece misses its frame budget. WebKit hides its renderer's name,
   * so the measured frames are the answer that cannot be masked. The CSS runs
   * none of it without the attribute, so a device that never earns it stays
   * still -- the light is still there, it just does not drift.
   */
  const AMBIENT = Object.freeze({ earn: 20, earnMs: 40, hold: 60, holdMs: 50 });
  let ambientLost = false;
  function settleAmbient(on) {
    const root = document.documentElement;
    if (!on) ambientLost = true;
    if (root && root.dataset) root.dataset.ambient = on && !ambientLost ? 'on' : 'off';
  }
  const medianOf = gaps => gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  function watchAmbient() {
    if (typeof global.requestAnimationFrame !== 'function' || !supportsWebGL() || metered()) {
      settleAmbient(false);
      return;
    }
    let gaps = [];
    let last = 0;
    let earned = false;
    const tick = now => {
      if (ambientLost) return;
      if (last) gaps.push(now - last);
      last = now;
      if (gaps.length < (earned ? AMBIENT.hold : AMBIENT.earn)) {
        global.requestAnimationFrame(tick);
        return;
      }
      const median = medianOf(gaps);
      if (!earned) {
        if (median > AMBIENT.earnMs) { settleAmbient(false); return; }
        earned = true;
        gaps = [];
        settleAmbient(true);
        global.requestAnimationFrame(tick);
        return;
      }
      if (median > AMBIENT.holdMs) settleAmbient(false);
    };
    global.requestAnimationFrame(tick);
  }

  function metered() {
    const connection = global.navigator && global.navigator.connection;
    return !!(connection && connection.saveData);
  }

  /*
   * Small screens get the cheaper draw: fewer strands, no star field, a lower
   * pixel-ratio cap. The component reads this from its own attribute, so the
   * decision belongs here where the viewport is known.
   */
  function density() {
    return global.matchMedia && global.matchMedia('(max-width: 700px)').matches ? 'low' : 'high';
  }

  /* Which design preset the artwork is drawn for: Nebula's violets, or
   * Obsidian's silver and graphite. */
  function design() {
    return document.documentElement.dataset.design === 'obsidian' ? 'obsidian' : 'nebula';
  }
  function theme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  /*
   * Mount one piece into a host element. The custom element is only created
   * after its module has defined it, so a failed import leaves the host empty
   * rather than leaving an undefined element in the tree.
   */
  async function mount(kind, host) {
    if (!host || host.dataset.nebulaMounted === 'true') return false;
    if (!MODULES[kind] || !supportsWebGL() || metered()) return false;
    host.dataset.nebulaMounted = 'true';
    try {
      if (!requested.has(kind)) requested.set(kind, import(MODULES[kind]));
      await requested.get(kind);
      const tag = TAGS[kind];
      if (!global.customElements || !global.customElements.get(tag)) throw new Error(`${tag} did not define`);
      const element = document.createElement(tag);
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

  /*
   * Times the page's frames while a newly mounted piece settles in. The first
   * interval is the piece compiling its shaders and is allowed to be long, if
   * not endless; after it, a single frame of a second or a median under about
   * twenty frames a second means the device is drawing this on its CPU. The
   * piece is then removed, its context released, the host marked as failed --
   * which every caller already treats as "no artwork" -- and no other piece is
   * mounted this session. A hidden page draws no frames, so it is never judged.
   */
  function holdToBudget(host, element) {
    if (typeof global.requestAnimationFrame !== 'function') return;
    const gaps = [];
    let last = 0;
    const retire = () => {
      capable = false;
      const canvas = element.querySelector('canvas');
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      const lose = gl && gl.getExtension('WEBGL_lose_context');
      element.remove();
      if (lose) lose.loseContext();
      host.dataset.nebulaMounted = 'failed';
      settleAmbient(false);
      host.dispatchEvent(new CustomEvent('nebula-visual-retired', { bubbles: true }));
    };
    const tick = now => {
      if (!element.isConnected) return;
      if (last) gaps.push(now - last);
      last = now;
      const first = gaps[0];
      const rest = gaps.slice(1);
      if (first > BUDGET.firstFrameMs || rest.some(gap => gap > BUDGET.frameMs)) return retire();
      if (rest.length >= BUDGET.minimum) {
        const median = rest.slice().sort((a, b) => a - b)[Math.floor(rest.length / 2)];
        if (median > BUDGET.medianMs) return retire();
      }
      if (gaps.length < BUDGET.frames) global.requestAnimationFrame(tick);
    };
    global.requestAnimationFrame(tick);
  }

  /* Follows the theme toggle, for whichever pieces are already mounted. */
  function repaint() {
    const next = theme();
    const preset = design();
    document.querySelectorAll(Object.values(TAGS).join(', '))
      .forEach(element => { element.setAttribute('theme', next); element.setAttribute('design', preset); });
  }

  /*
   * Asked once, on the landing only -- the shell behind sign-in has no ambient
   * motion to gate -- and after the page has loaded, so the frames measured
   * are the page at rest rather than the page being built.
   */
  if (document.querySelector('.lp')) {
    if (document.readyState === 'complete') watchAmbient();
    else global.addEventListener('load', watchAmbient, { once: true });
  }

  global.NebulaVisuals = Object.freeze({ mount, repaint, supportsWebGL });
})(window);
