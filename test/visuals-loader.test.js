'use strict';

/*
 * The loader for the design's WebGL pieces, asked directly over a page made
 * here: what it refuses, in what order it asks, and what it takes down.
 *
 * Every failure it guards has the same shape -- a piece that downloads for a
 * device that cannot draw it, or draws it on the CPU and starves the page --
 * and shows up as a slow or frozen interface rather than as an error anyone
 * traces. So each question is put to the loader as a page would put it: a
 * WebGL context that names its renderer, a connection that saves data, the
 * frames the page keeps, and a module that defines its element or does not.
 */
const assert = require('node:assert/strict');
const { createVisuals, BUDGET, AMBIENT, TAGS, SOFTWARE_RENDERER } = require('../apps/web/src/visualizations/visuals-loader.ts');

const DEBUG_INFO = { UNMASKED_RENDERER_WEBGL: 0x9246 };
const RENDERER = 0x1f01;

function element(tag, page) {
  const attributes = new Map();
  const node = {
    tagName: tag.toUpperCase(),
    dataset: {},
    children: [],
    parent: null,
    events: [],
    get isConnected() { return Boolean(this.parent); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    appendChild(child) { child.parent = this; this.children.push(child); page.connected.add(child); return child; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
      page.connected.delete(this);
    },
    querySelector(selector) { return selector === 'canvas' ? (this.canvas || null) : null; },
    dispatchEvent(event) { this.events.push(event.type); return true; }
  };
  return node;
}

/* A page with a renderer of the given name, a connection, a frame clock and the two modules. */
function makePage({ renderer = 'ANGLE (NVIDIA GeForce RTX 3060)', debugInfo = true, context = true, throwsOnContext = false,
  saveData = false, narrow = false, defines = true, design = 'nebula', theme = 'dark', frames = true } = {}) {
  const log = [];
  const page = { log, connected: new Set(), contexts: [], lost: 0, frameQueue: [], imports: { galaxy: 0, singularity: 0 } };
  const defined = new Set();
  const documentElement = { dataset: { design, theme } };
  const makeContext = attributes => {
    log.push(`context ${JSON.stringify(attributes || {})}`);
    const gl = {
      RENDERER,
      getExtension(name) {
        if (name === 'WEBGL_debug_renderer_info') return debugInfo ? DEBUG_INFO : null;
        if (name === 'WEBGL_lose_context') return { loseContext: () => { page.lost += 1; log.push('lose'); } };
        return null;
      },
      getParameter(name) {
        if (name === DEBUG_INFO.UNMASKED_RENDERER_WEBGL) return renderer;
        if (name === RENDERER) return debugInfo ? 'WebKit WebGL' : renderer;
        return null;
      }
    };
    page.contexts.push(gl);
    return gl;
  };
  const doc = {
    documentElement,
    createElement(tag) {
      const node = element(tag, page);
      if (tag === 'canvas') {
        node.getContext = (kind, attributes) => {
          if (throwsOnContext) throw new Error('no context');
          if (!context) return null;
          if (!node.gl) node.gl = makeContext(attributes);
          return kind === 'webgl2' ? node.gl : node.gl;
        };
      }
      return node;
    },
    querySelectorAll(selector) {
      const tags = selector.split(',').map(part => part.trim().toUpperCase());
      return [...page.connected].filter(node => tags.includes(node.tagName));
    }
  };
  const win = {
    navigator: { connection: { saveData } },
    matchMedia: query => ({ matches: query === '(max-width: 700px)' && narrow }),
    customElements: { get: tag => (defined.has(tag) ? class {} : undefined) },
    requestAnimationFrame: frames ? callback => { page.frameQueue.push(callback); return page.frameQueue.length; } : undefined
  };
  const modules = Object.fromEntries(Object.entries(TAGS).map(([kind, tag]) => [kind, async () => {
    page.imports[kind] += 1;
    log.push(`import ${kind}`);
    if (defines) defined.add(tag);
  }]));
  page.visuals = createVisuals({ document: doc, window: win, modules });
  page.document = doc;
  page.host = () => element('div', page);
  /* Runs the queued frames, one per gap, as the page would: the first frame starts the clock, each later one is timed. */
  page.run = (gaps, start = 1000) => {
    let now = start;
    for (const gap of gaps) {
      const queued = page.frameQueue.splice(0);
      if (!queued.length) break;
      now += gap;
      for (const callback of queued) callback(now);
    }
  };
  return page;
}

/* A mounted piece and its host, connected as on the page. */
async function mounted(options = {}, kind = 'galaxy') {
  const page = makePage(options);
  const host = page.host();
  page.connected.add(host);
  const drawn = await page.visuals.mount(kind, host);
  return { page, host, drawn, piece: host.children[0] };
}

(async () => {
  /* ---- Can this device draw it? ---------------------------------------------- */
  {
    const page = makePage();
    assert.equal(page.visuals.supportsWebGL(), true, 'a hardware renderer can draw the pieces');
    assert.deepEqual(page.log.slice(0, 1), ['context {"failIfMajorPerformanceCaveat":true}'],
      'the probe asks the browser to refuse a context it would draw in software');
    assert.equal(page.lost, 1, 'the probe releases its context at once, so it never holds one of the browser\'s WebGL slots');
    page.visuals.supportsWebGL();
    assert.equal(page.contexts.length, 1, 'the answer is asked once a session');
  }
  for (const name of ['Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))', 'llvmpipe (LLVM 15.0.7, 256 bits)',
    'Microsoft Basic Render Driver', 'Software Rasterizer']) {
    assert.equal(makePage({ renderer: name }).visuals.supportsWebGL(), false, `a software rasteriser (${name}) is no renderer`);
    assert.ok(SOFTWARE_RENDERER.test(name));
  }
  assert.equal(makePage({ renderer: 'Google SwiftShader', debugInfo: false }).visuals.supportsWebGL(), false,
    'a renderer read without the debug extension is still judged by its name');
  assert.equal(makePage({ context: false }).visuals.supportsWebGL(), false, 'no context is no renderer');
  assert.equal(makePage({ throwsOnContext: true }).visuals.supportsWebGL(), false, 'a context that throws is no renderer');

  /* ---- Nothing downloads until the device and the reader allow it --------------- */
  {
    const { page, drawn, piece, host } = await mounted();
    assert.equal(drawn, true);
    assert.deepEqual(page.log.filter(line => !line.startsWith('lose')), ['context {"failIfMajorPerformanceCaveat":true}', 'import galaxy'],
      'the device is probed before the module is imported');
    assert.equal(piece.tagName, 'NEBULA-GALAXY');
    assert.deepEqual([piece.getAttribute('theme'), piece.getAttribute('design'), piece.getAttribute('density')], ['dark', 'nebula', 'high']);
    assert.equal(host.dataset.nebulaMounted, 'true');
    assert.equal(await page.visuals.mount('galaxy', host), false, 'a host is drawn into once');
    assert.equal(page.imports.galaxy, 1);
  }
  {
    const page = makePage({ renderer: 'Google SwiftShader' });
    const host = page.host();
    assert.equal(await page.visuals.mount('galaxy', host), false);
    assert.equal(page.imports.galaxy, 0, 'a device drawing on its CPU never downloads the artwork');
    assert.equal(host.dataset.nebulaMounted, undefined, 'and its host is left as it was');
  }
  {
    const page = makePage({ saveData: true });
    assert.equal(await page.visuals.mount('singularity', page.host()), false);
    assert.equal(page.imports.singularity, 0, 'a reader saving data is never sent the artwork');
  }
  {
    const page = makePage();
    assert.equal(await page.visuals.mount('mark-3d', page.host()), false, 'a piece the loader does not know is never fetched');
    assert.equal(await page.visuals.mount('galaxy', null), false, 'nor drawn without a host');
    assert.deepEqual(page.imports, { galaxy: 0, singularity: 0 });
  }
  {
    const { drawn, host, piece } = await mounted({ defines: false });
    assert.equal(drawn, false, 'a module that does not define its element draws nothing');
    assert.equal(host.dataset.nebulaMounted, 'failed', 'and its host is marked failed, which every caller treats as no artwork');
    assert.equal(piece, undefined, 'and no undefined element is left in the tree');
  }
  {
    const { piece } = await mounted({ narrow: true, design: 'obsidian', theme: 'light' }, 'singularity');
    assert.equal(piece.tagName, 'NEBULA-SINGULARITY');
    assert.deepEqual([piece.getAttribute('theme'), piece.getAttribute('design'), piece.getAttribute('density')], ['light', 'obsidian', 'low'],
      'a small screen gets the cheaper draw, in the preset and theme the page shows');
  }
  {
    const page = makePage();
    const first = page.host();
    const second = page.host();
    page.connected.add(first);
    page.connected.add(second);
    await Promise.all([page.visuals.mount('galaxy', first), page.visuals.mount('galaxy', second)]);
    assert.equal(page.imports.galaxy, 1, 'two hosts share one download');
    page.document.documentElement.dataset.theme = 'light';
    page.document.documentElement.dataset.design = 'obsidian';
    page.visuals.repaint();
    for (const host of [first, second]) {
      assert.deepEqual([host.children[0].getAttribute('theme'), host.children[0].getAttribute('design')], ['light', 'obsidian'],
        'every mounted piece follows the theme and the preset');
    }
  }

  /* ---- A mounted piece is held to a frame budget ---------------------------------- */
  {
    const { page, host, piece } = await mounted();
    page.run([16, 500, ...Array(BUDGET.frames - 1).fill(16)]);
    assert.equal(piece.isConnected, true, 'a piece that keeps sixty frames a second stays');
    assert.equal(page.frameQueue.length, 0, 'and is timed only while it settles in');
    assert.equal(host.dataset.nebulaMounted, 'true');
  }
  {
    const { page, host, piece } = await mounted();
    piece.canvas = page.document.createElement('canvas');
    piece.canvas.getContext('webgl2');
    const lostBefore = page.lost;
    page.run([16, BUDGET.firstFrameMs + 1]);
    assert.equal(piece.isConnected, false, 'a first frame past its allowance takes the piece down');
    assert.equal(host.dataset.nebulaMounted, 'failed');
    assert.equal(page.lost, lostBefore + 1, 'and its context is released');
    assert.deepEqual(host.events, ['nebula-visual-retired'], 'and the host says so');
    assert.equal(page.document.documentElement.dataset.ambient, 'off', 'and the landing\'s ambient motion stands down');
    assert.equal(page.visuals.supportsWebGL(), false, 'and nothing else is mounted this session');
    assert.equal(await page.visuals.mount('singularity', page.host()), false);
    assert.equal(page.imports.singularity, 0);
  }
  {
    const { page, piece } = await mounted();
    page.run([16, 300, 16, 16, BUDGET.frameMs + 1]);
    assert.equal(piece.isConnected, false, 'one frame of a second after the first takes the piece down');
  }
  {
    const { page, piece } = await mounted();
    page.run([16, 300, ...Array(BUDGET.minimum).fill(BUDGET.medianMs + 5)]);
    assert.equal(piece.isConnected, false, 'a median under about twenty frames a second takes the piece down');
  }
  {
    const { page, piece } = await mounted();
    page.run([16, 300, ...Array(BUDGET.minimum - 1).fill(BUDGET.medianMs + 5)]);
    assert.equal(piece.isConnected, true, 'too few frames are not yet a median');
  }
  {
    const { page, piece } = await mounted();
    piece.remove();
    page.run([16, BUDGET.firstFrameMs + 1]);
    assert.equal(page.visuals.supportsWebGL(), true, 'a piece the page has already taken off is never judged');
  }
  {
    const { drawn } = await mounted({ frames: false });
    assert.equal(drawn, true, 'a page without a frame clock still draws the piece');
  }

  /* ---- The landing's ambient motion is earned, held, and once lost stays lost ------ */
  {
    const page = makePage();
    page.visuals.watchAmbient();
    page.run(Array(AMBIENT.earn + 1).fill(16));
    assert.equal(page.document.documentElement.dataset.ambient, 'on', 'a steady frame rate with the motion off earns it');
    page.run(Array(AMBIENT.hold + 1).fill(AMBIENT.holdMs + 10));
    assert.equal(page.document.documentElement.dataset.ambient, 'off', 'a frame rate that falls once it is on loses it');
    page.visuals.watchAmbient();
    page.run(Array(AMBIENT.earn + 1).fill(16));
    assert.equal(page.document.documentElement.dataset.ambient, 'off', 'and it stays lost for the session');
  }
  {
    const page = makePage();
    page.visuals.watchAmbient();
    page.run(Array(AMBIENT.earn + 1).fill(AMBIENT.earnMs + 5));
    assert.equal(page.document.documentElement.dataset.ambient, 'off', 'a slow page never earns it');
  }
  {
    const page = makePage();
    page.visuals.watchAmbient();
    page.run(Array(AMBIENT.earn + 1).fill(16));
    page.run(Array(AMBIENT.hold + 1).fill(AMBIENT.holdMs - 10));
    assert.equal(page.document.documentElement.dataset.ambient, 'on', 'a page that keeps its rate keeps it');
  }
  for (const [label, options] of [['a software renderer', { renderer: 'Google SwiftShader' }], ['a reader saving data', { saveData: true }], ['no frame clock', { frames: false }]]) {
    const page = makePage(options);
    page.visuals.watchAmbient();
    assert.equal(page.document.documentElement.dataset.ambient, 'off', `${label} never runs the ambient motion`);
    assert.equal(page.frameQueue.length, 0);
  }
  {
    const { page } = await mounted();
    page.visuals.watchAmbient();
    page.run([16, BUDGET.firstFrameMs + 1]);
    page.run(Array(AMBIENT.earn + 1).fill(16));
    assert.equal(page.document.documentElement.dataset.ambient, 'off', 'a piece taken down takes the ambient motion with it, for the session');
  }

  console.log('visuals loader tests passed');
})().catch(error => { console.error(error); process.exit(1); });
