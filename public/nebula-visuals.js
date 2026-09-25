/*
 * Loader for the design's WebGL pieces.
 *
 * The galaxy and the dimensional mark pull three.js behind them -- around
 * 750KB across two files. That is a deliberate cost for the product's
 * personality, but it is not a cost every visit should pay, so nothing here
 * downloads until three questions are answered:
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
  const MODULES = Object.freeze({
    galaxy: '/nebula-galaxy.js',
    mark: '/nebula-mark-3d.js'
  });

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

  function supportsWebGL() {
    if (capable !== null) return capable;
    capable = false;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
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
      const tag = kind === 'galaxy' ? 'nebula-galaxy' : 'nebula-mark-3d';
      if (!global.customElements || !global.customElements.get(tag)) throw new Error(`${tag} did not define`);
      const element = document.createElement(tag);
      element.setAttribute('theme', theme());
      element.setAttribute('design', design());
      if (kind === 'galaxy') element.setAttribute('density', density());
      host.appendChild(element);
      return true;
    } catch {
      /* The interface is complete without it; leaving the host empty is correct. */
      host.dataset.nebulaMounted = 'failed';
      return false;
    }
  }

  /* Follows the theme toggle, for whichever pieces are already mounted. */
  function repaint() {
    const next = theme();
    const preset = design();
    document.querySelectorAll('nebula-galaxy, nebula-mark-3d')
      .forEach(element => { element.setAttribute('theme', next); element.setAttribute('design', preset); });
  }

  global.NebulaVisuals = Object.freeze({ mount, repaint, supportsWebGL });
})(window);
