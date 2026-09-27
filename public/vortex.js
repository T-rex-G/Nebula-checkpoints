/* The landing's subject: a vortex of light, drawn in WebGL from arithmetic. */
'use strict';

/*
 * What this draws, and why it is built the way it is.
 *
 * A surface of revolution -- a crown, a waist and a base, each with its own
 * radius -- traced by a few hundred straight-ish strands that spiral around
 * the axis. The strands are the drawing: where they converge at the waist the
 * light sums to its brightest, where they flare out to the rims it thins to
 * dust. Three layers move over it:
 *
 *   strands  the lattice itself, spun as one body, with light running along
 *            each strand and a darker far side so it reads as a volume;
 *   dust     thousands of motes that ride the strands up (or down) the form,
 *            twinkling, a little off the surface so it has thickness;
 *   comets   a few bright heads with fading trails that whip round faster
 *            than the strands they follow.
 *
 * And one moment that belongs to this product rather than to the shape: every
 * few seconds a band of light passes from crown to base, the way an audit
 * passes over a repository. Reaching for the invitation tightens the waist,
 * speeds the spin and keeps the pass running.
 *
 * It is written for this page, with no library and no build step: the page's
 * CSP is script-src 'self', so one plain module is what can run here. The
 * shape is data (PRESETS), the colour is data (THEMES), and the budget is
 * data (TIERS), so a variant is a line of configuration, not a new shader.
 */

(function vortexModule(global) {
  const TAU = Math.PI * 2;
  const DPR_CAP = 1.5;

  /*
   * Index buffers are UNSIGNED_SHORT, so the strand mesh may hold 65536
   * vertices and not one more. Past that the indices wrap to the start of the
   * buffer and the lattice silently stitches itself to itself -- no error, no
   * warning. Every tier is held under it by construction, and the unit guard
   * drives strandVertices() over the real tiers to prove it.
   */
  const VERTEX_LIMIT = 65536;
  const TRAIL = 72;

  /*
   * The budget follows the smaller edge of the canvas. The lattice that reads
   * as fine thread on a desktop stage is a solid block on a 390px phone, and
   * a hot battery for a picture nobody can resolve.
   */
  const TIERS = Object.freeze([
    Object.freeze({ upTo: 520, strands: 168, segments: 60, dust: 2600, comets: 6 }),
    Object.freeze({ upTo: 900, strands: 240, segments: 68, dust: 4400, comets: 8 }),
    Object.freeze({ upTo: Infinity, strands: 320, segments: 76, dust: 6800, comets: 10 })
  ]);
  const strandVertices = tier => tier.strands * (tier.segments + 1);

  /*
   * Shapes, in world units: the form is two units tall, radii are measured
   * from the axis, waistAt runs from the crown (0) to the base (1). flare is
   * the exponent of the profile -- higher holds the column narrow longer and
   * then opens it faster. spin is radians a second; flow is how far along the
   * form the dust travels in a second.
   */
  const PRESETS = Object.freeze({
    /* Two bells meeting at a bright neck: the default. */
    hourglass: Object.freeze({
      top: 1.04, waist: 0.16, waistAt: 0.54, bottom: 1.3, flare: 2.2,
      twist: 0.8, weave: 0.34, spin: 0.2, flow: 0.045, direction: 'up',
      sway: 0.03, tilt: 0.2
    }),
    /* A funnel cloud: a wide crown narrowing to a point that touches down. */
    funnel: Object.freeze({
      top: 1.16, waist: 0.035, waistAt: 0.95, bottom: 0.24, flare: 1.55,
      twist: 1.5, weave: 0.16, spin: 0.34, flow: 0.06, direction: 'up',
      sway: 0.085, tilt: 0.15
    }),
    /* A spire rising out of a wide skirt of light. */
    spire: Object.freeze({
      top: 0.5, waist: 0.02, waistAt: 0.2, bottom: 1.36, flare: 1.7,
      twist: 1, weave: 0, spin: 0.24, flow: 0.05, direction: 'up',
      sway: 0.02, tilt: 0.13
    }),
    /* A deep cup on a short stem. */
    chalice: Object.freeze({
      top: 1.22, waist: 0.2, waistAt: 0.74, bottom: 0.72, flare: 2.6,
      twist: 0.62, weave: 0.5, spin: 0.16, flow: 0.04, direction: 'down',
      sway: 0.025, tilt: 0.24
    })
  });

  /*
   * One palette per theme, and one blend per palette.
   *
   * On a dark ground the layers are added to what is behind them, which is
   * what makes a strand read as light rather than as wire, and why the waist
   * -- where every strand converges -- is the brightest thing on the page.
   * Adding light to a light ground only ever approaches white, so the light
   * themes composite normally with inked colours instead: the same geometry
   * drawn as a drawing, densest (darkest) at the waist for the same reason.
   *
   * No stop is pure white. Additive sums reach white on their own at the
   * neck; a white stop would leave the most looked-at part of the subject
   * with no colour left in it.
   */
  const THEMES = Object.freeze({
    dark: Object.freeze({
      additive: true,
      top: '#5EEAD4', waist: '#E9D5FF', bottom: '#A855F7',
      hot: '#F5F3FF', accent: '#F0ABFC', dust: '#DDD6FE',
      line: 0.34, mote: 1
    }),
    light: Object.freeze({
      additive: false,
      top: '#0E7490', waist: '#3B0764', bottom: '#6D28D9',
      hot: '#1E1B4B', accent: '#BE185D', dust: '#4C1D95',
      line: 0.4, mote: 0.85
    }),
    /* Platinum over the stone, the product violet kept for the comets. */
    'obsidian-dark': Object.freeze({
      additive: true,
      top: '#D4D4D8', waist: '#F4F4F5', bottom: '#A1A1AA',
      hot: '#FAFAFA', accent: '#A78BFA', dust: '#F4F4F5',
      line: 0.38, mote: 0.9
    }),
    /* Quartz: the same geometry inked in graphite. */
    'obsidian-light': Object.freeze({
      additive: false,
      top: '#57534E', waist: '#1C1917', bottom: '#44403C',
      hot: '#0C0A09', accent: '#5B3FD0', dust: '#292524',
      line: 0.36, mote: 0.8
    })
  });

  /*
   * The shape, shared by both programs so the dust sits on the strands it
   * rides and the pointer pushes both the same way.
   */
  const COMMON = `
precision highp float;
uniform vec2  uRes;
uniform float uFocal;
uniform float uDist;
uniform float uCamYaw;
uniform float uCamPitch;
uniform float uTilt;
uniform float uTime;
uniform float uSpin;
uniform float uTop;
uniform float uWaist;
uniform float uWaistAt;
uniform float uBottom;
uniform float uFlare;
uniform float uTwist;
uniform float uSway;
uniform vec2  uPointer;
uniform float uRepel;
uniform float uHoverActive;
uniform float uLift;
uniform float uFlowClock;

const float TAU = 6.2831853;

float radiusAt(float v) {
  float w = uWaistAt;
  float above = step(v, w);
  float u = above > 0.5 ? (w - v) / max(w, 0.001) : (v - w) / max(1.0 - w, 0.001);
  float rim = above > 0.5 ? uTop : uBottom;
  return uWaist + (rim - uWaist) * pow(clamp(u, 0.0, 1.0), uFlare);
}

/*
 * Soft at both rims: the form dissolves into the ground, never ends at a line.
 * Written as 1 - smoothstep rather than with its edges reversed: GLSL leaves
 * smoothstep undefined when edge0 >= edge1, and one driver reads that as a
 * dim scene while another paints the motes as dark holes.
 */
float rimFade(float v) {
  return smoothstep(0.0, 0.13, v) * (1.0 - smoothstep(0.87, 1.0, v));
}

vec3 surface(float angle, float v, float lift) {
  float r = radiusAt(v) + lift;
  /* The axis is not a ruler: it bends slowly, more the further from the neck. */
  float bend = uSway * sin(uTime * 0.37 + v * 2.4) * (0.35 + abs(v - uWaistAt));
  return vec3(cos(angle) * r + bend, 1.0 - 2.0 * v, sin(angle) * r);
}

/* Projects a world point; facing is 1 on the near side and 0 on the far one. */
vec4 project(vec3 p, out float facing, out float push) {
  float cy = cos(uCamYaw);
  float sy = sin(uCamYaw);
  float x1 = p.x * cy + p.z * sy;
  float z1 = -p.x * sy + p.z * cy;
  float r = max(length(p.xz), 0.001);
  facing = clamp(0.5 + 0.5 * z1 / r, 0.0, 1.0);

  float tp = uCamPitch + uTilt;
  float cp = cos(tp);
  float sp = sin(tp);
  float y2 = p.y * cp - z1 * sp;
  float z2 = p.y * sp + z1 * cp;
  float rz = uDist - z2;
  push = 0.0;
  if (rz < 0.2) return vec4(2.0, 2.0, 0.0, 1.0);

  vec2 ndc = vec2(x1, y2) * uFocal / rz / (uRes * 0.5) + vec2(0.0, uLift);

  /* The pointer is a field, not a cursor: the form parts around it. */
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 d = (ndc - uPointer) * aspect;
  float dist = length(d);
  push = uHoverActive * exp(-(dist * dist) / 0.05);
  ndc += (d / max(dist, 0.0001)) * (uRepel * push) / aspect;
  return vec4(ndc, 0.0, 1.0);
}
`;

  const STRAND_VERT = `${COMMON}
attribute vec3 aStrand;   /* base angle, position along the form, handedness */
attribute vec2 aRnd;

uniform vec3  uColTop;
uniform vec3  uColWaist;
uniform vec3  uColBottom;
uniform vec3  uHot;
uniform float uAlpha;
uniform float uFlowDir;
uniform vec2  uScan;      /* where the pass is, and how strong */

varying vec3  vCol;
varying float vAlpha;

void main() {
  float v = aStrand.y;
  float angle = aStrand.x + uSpin + aStrand.z * uTwist * TAU * (v - uWaistAt);
  float facing;
  float push;
  gl_Position = project(surface(angle, v, 0.0), facing, push);

  float w = uWaistAt;
  vec3 col = v < w
    ? mix(uColTop, uColWaist, smoothstep(0.0, 1.0, v / max(w, 0.001)))
    : mix(uColWaist, uColBottom, smoothstep(0.0, 1.0, (v - w) / max(1.0 - w, 0.001)));
  float dn = (v - w) / 0.07;
  float neck = exp(-dn * dn);

  /* Light running along each strand, out of step with its neighbours. */
  float run = pow(0.5 + 0.5 * sin(v * 11.0 + uFlowDir * uTime * 1.6 + aRnd.y * TAU), 8.0);
  float ds = (v - uScan.x) / 0.035;
  float scan = uScan.y * exp(-ds * ds);

  vCol = mix(col, uHot, clamp(neck * 0.55 + scan * 0.8, 0.0, 1.0));
  vAlpha = uAlpha * (0.45 + 0.55 * aRnd.x)
    * rimFade(v)
    * mix(0.3, 1.0, facing)
    * (0.72 + 0.7 * run + 2.2 * scan + 0.6 * push);
}
`;

  const DUST_VERT = `${COMMON}
attribute vec4 aSeed;     /* angle, phase, random, 0 for dust or 1 + place in a trail */

uniform vec3  uColDust;
uniform vec3  uAccent;
uniform vec3  uHot;
uniform float uMote;
uniform float uFlowDir;
uniform float uPx;
uniform vec2  uScan;

varying vec3  vCol;
varying float vAlpha;

void main() {
  float rnd = aSeed.z;
  float facing;
  float push;
  float v;
  float alpha;
  float size;
  vec3 col;

  if (aSeed.w < 0.5) {
    /* Dust rides the strands: same spiral, moving along it. */
    v = fract(aSeed.y + uFlowDir * uFlowClock * (0.4 + 0.6 * rnd));
    float angle = aSeed.x + uSpin + uTwist * TAU * (v - uWaistAt);
    float lift = (fract(rnd * 37.13) - 0.5) * 0.12 * (0.35 + radiusAt(v));
    gl_Position = project(surface(angle, v, lift), facing, push);
    float twinkle = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * (1.5 + 3.5 * rnd) + rnd * 91.0), 3.0);
    float ds = (v - uScan.x) / 0.05;
    float scan = uScan.y * exp(-ds * ds);
    size = mix(1.1, 3.4, pow(fract(rnd * 71.7), 5.0));
    alpha = uMote * twinkle * rimFade(v) * mix(0.35, 1.0, facing) * (1.0 + 1.6 * scan + push);
    col = mix(uColDust, uHot, clamp(scan, 0.0, 1.0));
  } else {
    /* A comet: a head and its trail, whipping round faster than the strands. */
    float k = aSeed.w - 1.0;
    float head = fract(aSeed.y + uFlowDir * uFlowClock * 2.4 * (0.75 + 0.5 * rnd));
    v = head - uFlowDir * k * 0.075;
    float angle = aSeed.x + uSpin * 2.2 + uTwist * TAU * (v - uWaistAt) + v * 2.0;
    gl_Position = project(surface(angle, v, 0.015), facing, push);
    float inside = step(0.0, v) * step(v, 1.0);
    size = mix(4.2, 1.1, sqrt(k));
    alpha = inside * pow(1.0 - k, 1.5) * rimFade(v) * mix(0.4, 1.0, facing) * 0.9;
    col = mix(uHot, uAccent, smoothstep(0.0, 0.25, k));
  }

  gl_PointSize = size * uPx;
  vCol = col;
  vAlpha = alpha;
}
`;

  /* Premultiplied, so one shader serves both the additive and normal blends. */
  const LINE_FRAG = `
precision mediump float;
varying vec3  vCol;
varying float vAlpha;
void main() { gl_FragColor = vec4(vCol * vAlpha, vAlpha); }
`;

  const POINT_FRAG = `
precision mediump float;
varying vec3  vCol;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = 1.0 - smoothstep(0.0, 0.5, d);
  a *= a * vAlpha;
  gl_FragColor = vec4(vCol * a, a);
}
`;

  function parseColor(input) {
    let h = String(input || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    h = h.padEnd(6, '0');
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255
    ];
  }

  function mulberry32(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function compile(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    return shader;
  }

  function link(gl, vs, fs) {
    const vert = compile(gl, gl.VERTEX_SHADER, vs);
    const frag = compile(gl, gl.FRAGMENT_SHADER, fs);
    if (!vert || !frag) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    return program;
  }

  /* A preset name, a shape object, or both: options win over the preset. */
  function resolveShape(preset, overrides) {
    const base = typeof preset === 'string' && PRESETS[preset] ? PRESETS[preset] : PRESETS.hourglass;
    const shape = Object.assign({}, base);
    const extra = preset && typeof preset === 'object' ? preset : overrides;
    if (extra) {
      Object.keys(PRESETS.hourglass).forEach(key => {
        if (key === 'direction') {
          if (extra.direction === 'up' || extra.direction === 'down') shape.direction = extra.direction;
          return;
        }
        const n = Number(extra[key]);
        if (extra[key] != null && Number.isFinite(n)) shape[key] = n;
      });
    }
    shape.top = Math.max(0, Math.min(1.6, shape.top));
    shape.bottom = Math.max(0, Math.min(1.6, shape.bottom));
    shape.waist = Math.max(0, Math.min(1.2, shape.waist));
    shape.waistAt = Math.max(0.02, Math.min(0.98, shape.waistAt));
    shape.flare = Math.max(0.6, Math.min(4, shape.flare));
    shape.twist = Math.max(-3, Math.min(3, shape.twist));
    shape.weave = Math.max(0, Math.min(1, shape.weave));
    shape.spin = Math.max(-2, Math.min(2, shape.spin));
    shape.flow = Math.max(0, Math.min(0.4, shape.flow));
    shape.sway = Math.max(0, Math.min(0.2, shape.sway));
    shape.tilt = Math.max(-0.6, Math.min(0.6, shape.tilt));
    return Object.freeze(shape);
  }

  function create(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;

    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: true, antialias: true, premultipliedAlpha: true, depth: false
      });
    } catch { gl = null; }
    if (!gl) return null;

    const host = options.host || canvas;
    let shape = resolveShape(options.preset, options);
    let theme = THEMES.dark;

    /* Everything the GPU holds, rebuilt as a unit when the context comes back. */
    let res = null;

    function uniforms(program, names) {
      const out = {};
      names.forEach(name => { out[name] = gl.getUniformLocation(program, name); });
      return out;
    }

    const SHARED = ['uRes', 'uFocal', 'uDist', 'uCamYaw', 'uCamPitch', 'uTilt', 'uTime', 'uSpin',
      'uTop', 'uWaist', 'uWaistAt', 'uBottom', 'uFlare', 'uTwist', 'uSway', 'uPointer', 'uRepel',
      'uHoverActive', 'uHot', 'uFlowDir', 'uScan', 'uLift', 'uFlowClock'];

    function init() {
      const strands = link(gl, STRAND_VERT, LINE_FRAG);
      const dust = link(gl, DUST_VERT, POINT_FRAG);
      if (!strands || !dust) return null;
      /*
       * State, not a default: without blending every fragment overwrites the
       * last, so the strands never sum to light and each mote punches a dark
       * hole in the lattice. Set here so a restored context gets it again.
       */
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      return {
        strands: {
          program: strands,
          aStrand: gl.getAttribLocation(strands, 'aStrand'),
          aRnd: gl.getAttribLocation(strands, 'aRnd'),
          u: uniforms(strands, SHARED.concat(['uColTop', 'uColWaist', 'uColBottom', 'uAlpha']))
        },
        dust: {
          program: dust,
          aSeed: gl.getAttribLocation(dust, 'aSeed'),
          u: uniforms(dust, SHARED.concat(['uColDust', 'uAccent', 'uMote', 'uPx']))
        },
        strandBuf: gl.createBuffer(),
        rndBuf: gl.createBuffer(),
        idxBuf: gl.createBuffer(),
        seedBuf: gl.createBuffer(),
        builtTier: null,
        builtWeave: -1,
        indexCount: 0,
        pointCount: 0
      };
    }

    res = init();
    if (!res) return null;

    /*
     * The mesh is built once per tier and per weave. The shape itself --
     * radii, twist, spin -- lives in uniforms, so changing a preset or a
     * theme never touches a buffer.
     */
    function build(tier) {
      const random = mulberry32(0x5eed7ad0);
      const rows = tier.segments + 1;
      const vertices = strandVertices(tier);
      /* Refused once and remembered, so a tier past the cliff draws nothing
         rather than asking again every frame. */
      res.builtTier = tier;
      res.builtWeave = shape.weave;
      if (vertices > VERTEX_LIMIT) { res.indexCount = 0; return; }

      const strand = new Float32Array(vertices * 3);
      const rnd = new Float32Array(vertices * 2);
      const indices = new Uint16Array(tier.strands * tier.segments * 2);
      let at = 0;
      let k = 0;
      for (let i = 0; i < tier.strands; i += 1) {
        const angle = (i + random() * 0.35) / tier.strands * TAU;
        const hand = random() < shape.weave ? -1 : 1;
        const bright = Math.pow(random(), 1.6);
        const phase = random();
        for (let j = 0; j < rows; j += 1) {
          /* Rows packed toward the rims, where the profile turns fastest. */
          const s = j / tier.segments;
          const v = 0.5 - 0.5 * Math.cos(s * Math.PI) * 0.35 + (s - 0.5) * 0.65;
          strand[at * 3] = angle;
          strand[at * 3 + 1] = Math.max(0, Math.min(1, v));
          strand[at * 3 + 2] = hand;
          rnd[at * 2] = bright;
          rnd[at * 2 + 1] = phase;
          if (j > 0) {
            indices[k++] = at - 1;
            indices[k++] = at;
          }
          at += 1;
        }
      }

      const points = tier.dust + tier.comets * TRAIL;
      const seed = new Float32Array(points * 4);
      for (let i = 0; i < tier.dust; i += 1) {
        seed[i * 4] = random() * TAU;
        seed[i * 4 + 1] = random();
        seed[i * 4 + 2] = random();
        seed[i * 4 + 3] = 0;
      }
      for (let c = 0; c < tier.comets; c += 1) {
        const angle = random() * TAU;
        const phase = random();
        const r = random();
        for (let t = 0; t < TRAIL; t += 1) {
          const i = tier.dust + c * TRAIL + t;
          seed[i * 4] = angle;
          seed[i * 4 + 1] = phase;
          seed[i * 4 + 2] = r;
          seed[i * 4 + 3] = 1 + t / (TRAIL - 1);
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, res.strandBuf);
      gl.bufferData(gl.ARRAY_BUFFER, strand, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.rndBuf);
      gl.bufferData(gl.ARRAY_BUFFER, rnd, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.seedBuf);
      gl.bufferData(gl.ARRAY_BUFFER, seed, gl.STATIC_DRAW);
      res.indexCount = indices.length;
      res.pointCount = points;
    }

    /* Colours are parsed when the theme changes, never once a frame. */
    const colors = {};
    let colorsOf = null;
    function packColors() {
      ['top', 'waist', 'bottom', 'hot', 'accent', 'dust'].forEach(key => { colors[key] = parseColor(theme[key]); });
      colorsOf = theme;
    }

    let reaching = 0;
    let reachingTarget = 0;
    const cam = { yaw: 0, pitch: 0, yawV: 0, pitchV: 0 };
    const hover = { active: 0, target: 0, x: 0, y: 0 };
    const drag = { active: false, id: null, touch: false, lastX: 0, lastY: 0 };

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let raf = 0;
    let running = false;
    let wanted = false;
    let lost = false;
    let elapsed = 0;
    let spin = 0;
    let flowClock = 0;
    let last = 0;

    function resize() {
      dpr = Math.min(global.devicePixelRatio || 1, DPR_CAP);
      cssW = canvas.clientWidth || host.clientWidth || 1;
      cssH = canvas.clientHeight || host.clientHeight || 1;
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
    }

    function tierFor() {
      const edge = Math.min(cssW, cssH) || 1;
      return TIERS.find(tier => edge < tier.upTo) || TIERS[TIERS.length - 1];
    }

    const DIST = 6;
    /*
     * Framed from what is actually drawn, not from the numbers in the preset.
     * The visible part of the form is projected once at the resting tilt, and
     * the focal length and a vertical offset are chosen so its bounds fill
     * the box and sit in the middle of it -- a funnel whose weight is all at
     * the top is centred as honestly as an hourglass. Cached per box and per
     * shape; a drag tilts the view without zooming it.
     */
    const fit = { key: '', focal: 1, lift: 0 };
    let shapeId = 0;
    function fitFor() {
      const key = `${canvas.width}x${canvas.height}:${shapeId}`;
      if (fit.key === key) return fit;
      const cp = Math.cos(shape.tilt);
      const sp = Math.sin(shape.tilt);
      let halfX = 0.001;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let v = 0.04; v <= 0.961; v += 0.02) {
        const r = radiusAt(v);
        const y = 1 - 2 * v;
        for (let a = 0; a < 24; a += 1) {
          const angle = a / 24 * TAU;
          const x = Math.cos(angle) * r;
          const z = Math.sin(angle) * r;
          const y2 = y * cp - z * sp;
          const rz = DIST - (y * sp + z * cp);
          halfX = Math.max(halfX, Math.abs(x / rz));
          minY = Math.min(minY, y2 / rz);
          maxY = Math.max(maxY, y2 / rz);
        }
      }
      const halfY = Math.max((maxY - minY) / 2, 0.001);
      fit.focal = Math.min(canvas.width * 0.5 * 0.94 / halfX, canvas.height * 0.5 * 0.9 / halfY);
      fit.lift = -((maxY + minY) / 2) * fit.focal / (canvas.height * 0.5);
      fit.key = key;
      return fit;
    }

    /* The same projection as the shader, for picking. */
    function toCss(x, y, z, focal, pitch) {
      const cy = Math.cos(cam.yaw);
      const sy = Math.sin(cam.yaw);
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      const rz = Math.max(0.2, DIST - z2);
      return [
        (x1 * focal / rz + canvas.width / 2) / dpr,
        (canvas.height / 2 - y2 * focal / rz - fit.lift * canvas.height / 2) / dpr
      ];
    }

    function radiusAt(v) {
      const w = shape.waistAt;
      const above = v <= w;
      const u = above ? (w - v) / w : (v - w) / (1 - w);
      const rim = above ? shape.top : shape.bottom;
      return shape.waist + (rim - shape.waist) * Math.pow(Math.max(0, Math.min(1, u)), shape.flare);
    }

    /*
     * Whether the pointer is over the form rather than merely over the box.
     * The form is sampled as a stack of rings, each projected to an ellipse
     * (the band between two rings counts too), and the rims are held in a
     * little since they have faded to nothing by their edge.
     */
    function overForm(focal, pitch) {
      const BANDS = 26;
      const SIDES = 12;
      const bandHalf = (cssH / BANDS) * 0.6;
      for (let b = 1; b < BANDS; b += 1) {
        const v = b / BANDS;
        const r = radiusAt(v) * 0.86 + 0.05;
        const y = 1 - 2 * v;
        let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
        for (let s = 0; s < SIDES; s += 1) {
          const a = s / SIDES * TAU;
          const [px, py] = toCss(Math.cos(a) * r, y, Math.sin(a) * r, focal, pitch);
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const rx = Math.max((maxX - minX) / 2, 1);
        const ry = Math.max((maxY - minY) / 2, bandHalf);
        const dx = (hover.x - cx) / rx;
        const dy = (hover.y - cy) / ry;
        if (dx * dx + dy * dy <= 1) return true;
      }
      return false;
    }

    function setShared(u, focal) {
      gl.uniform1f(u.uLift, fit.lift);
      gl.uniform1f(u.uFlowClock, flowClock);
      const reachSqueeze = 1 - reaching * 0.22;
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform1f(u.uFocal, focal);
      gl.uniform1f(u.uDist, DIST);
      gl.uniform1f(u.uCamYaw, cam.yaw);
      gl.uniform1f(u.uCamPitch, cam.pitch);
      gl.uniform1f(u.uTilt, shape.tilt);
      gl.uniform1f(u.uTime, elapsed);
      gl.uniform1f(u.uSpin, spin);
      gl.uniform1f(u.uTop, shape.top);
      /* The waist breathes, and draws in when the reader reaches for the card. */
      gl.uniform1f(u.uWaist, shape.waist * reachSqueeze * (1 + 0.07 * Math.sin(elapsed * 0.8)));
      gl.uniform1f(u.uWaistAt, shape.waistAt);
      gl.uniform1f(u.uBottom, shape.bottom);
      gl.uniform1f(u.uFlare, shape.flare);
      gl.uniform1f(u.uTwist, shape.twist);
      gl.uniform1f(u.uSway, shape.sway);
      gl.uniform2f(u.uPointer, (hover.x / (cssW || 1)) * 2 - 1, 1 - (hover.y / (cssH || 1)) * 2);
      gl.uniform1f(u.uRepel, 0.075);
      gl.uniform1f(u.uHoverActive, hover.active);
      gl.uniform3fv(u.uHot, colors.hot);
      gl.uniform1f(u.uFlowDir, shape.direction === 'up' ? -1 : 1);
      gl.uniform2f(u.uScan, scan.at, scan.gain);
    }

    /*
     * The pass: a band of light from crown to base, every few seconds at rest
     * and continuously while the reader is reaching for the invitation.
     */
    const scan = { at: -1, gain: 0, clock: 0.6 };
    function stepScan(dt) {
      const period = 7.5 - reaching * 4.5;
      const sweep = 2.6;
      scan.clock = (scan.clock + dt) % period;
      const t = scan.clock / sweep;
      if (t >= 1) { scan.gain = 0; scan.at = -1; return; }
      scan.at = shape.direction === 'up' ? 1.08 - t * 1.16 : -0.08 + t * 1.16;
      scan.gain = Math.sin(Math.PI * t) * (0.75 + reaching * 0.35);
    }

    function draw(dt) {
      if (lost || !res) return;
      if (cssW <= 0 || cssH <= 0) { resize(); return; }

      const tier = tierFor();
      if (tier !== res.builtTier || shape.weave !== res.builtWeave) build(tier);
      if (!res.indexCount) return;

      elapsed += dt;
      /* Eased by hand: one exponential approach per frame costs nothing. */
      reaching += (reachingTarget - reaching) * (1 - Math.exp(-dt * 3.2));
      spin += dt * shape.spin * (1 + reaching * 0.9);
      /* Integrated, never multiplied by the clock: easing a rate that is
         multiplied by elapsed time would fling every mote at once. */
      flowClock += dt * shape.flow * (1 + reaching * 0.6);
      stepScan(dt);

      const damp = 1 - Math.pow(0.5, dt * 10);
      cam.yaw += cam.yawV * damp;
      cam.pitch += cam.pitchV * damp;
      cam.yaw = ((cam.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
      /* A surface of revolution has no underside worth showing. */
      cam.pitch = Math.max(-0.5, Math.min(0.55, cam.pitch));
      cam.yawV *= (1 - damp * 1.4);
      cam.pitchV *= (1 - damp * 1.4);

      const focal = fitFor().focal;
      const hit = hover.target ? overForm(focal, cam.pitch + shape.tilt) : false;
      hover.active += ((hit ? 1 : 0) - hover.active) * (1 - Math.exp(-dt * 6));

      if (colorsOf !== theme) packColors();
      const thin = Math.sqrt(TIERS[TIERS.length - 1].strands / tier.strands);

      gl.blendFunc(gl.ONE, theme.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const S = res.strands;
      gl.useProgram(S.program);
      setShared(S.u, focal);
      gl.uniform3fv(S.u.uColTop, colors.top);
      gl.uniform3fv(S.u.uColWaist, colors.waist);
      gl.uniform3fv(S.u.uColBottom, colors.bottom);
      gl.uniform1f(S.u.uAlpha, theme.line * thin * (1 + reaching * 0.18));
      gl.bindBuffer(gl.ARRAY_BUFFER, res.strandBuf);
      gl.enableVertexAttribArray(S.aStrand);
      gl.vertexAttribPointer(S.aStrand, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.rndBuf);
      gl.enableVertexAttribArray(S.aRnd);
      gl.vertexAttribPointer(S.aRnd, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.idxBuf);
      gl.drawElements(gl.LINES, res.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.disableVertexAttribArray(S.aStrand);
      gl.disableVertexAttribArray(S.aRnd);

      const D = res.dust;
      gl.useProgram(D.program);
      setShared(D.u, focal);
      gl.uniform3fv(D.u.uColDust, colors.dust);
      gl.uniform3fv(D.u.uAccent, colors.accent);
      gl.uniform1f(D.u.uMote, theme.mote);
      gl.uniform1f(D.u.uPx, dpr * Math.max(0.75, Math.min(1.3, Math.min(cssW, cssH) / 560)));
      gl.bindBuffer(gl.ARRAY_BUFFER, res.seedBuf);
      gl.enableVertexAttribArray(D.aSeed);
      gl.vertexAttribPointer(D.aSeed, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, res.pointCount);
      gl.disableVertexAttribArray(D.aSeed);
    }

    function frame(now) {
      if (!running) return;
      raf = global.requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      draw(dt);
    }

    function begin() {
      running = true;
      last = global.performance ? global.performance.now() : Date.now();
      raf = global.requestAnimationFrame(frame);
    }

    const onLost = event => {
      event.preventDefault();
      lost = true;
      running = false;
      if (raf) global.cancelAnimationFrame(raf);
      raf = 0;
    };
    /*
     * A lost context is usually given back -- a driver reset, a tab that was
     * starved of GPU memory. Everything the GPU held is gone, so it is all
     * built again, and the scene resumes in whatever state it was asked for.
     */
    const onRestored = () => {
      res = init();
      if (!res) return;
      lost = false;
      resize();
      if (wanted) begin();
      else draw(0);
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    const onResize = () => {
      resize();
      /* Resizing clears the drawing buffer even when animation is stopped. */
      if (!running) draw(0);
    };
    let observer = null;
    if (typeof global.ResizeObserver === 'function') {
      observer = new global.ResizeObserver(onResize);
      observer.observe(canvas);
    } else if (global.addEventListener) {
      global.addEventListener('resize', onResize);
    }
    resize();

    /*
     * One pointer stream, on the canvas only. Pointer capture carries a drag
     * outside it; pan-y/pinch-zoom in CSS leave native touch scrolling intact,
     * so a vertical swipe over the scene still scrolls the page.
     */
    const ORBIT = Math.PI / 180;
    const pointerMove = event => {
      if (!running || (drag.active && event.pointerId !== drag.id)) return;
      const rect = canvas.getBoundingClientRect();
      hover.x = (event.clientX - rect.left) * cssW / (rect.width || 1);
      hover.y = (event.clientY - rect.top) * cssH / (rect.height || 1);
      hover.target = hover.x >= 0 && hover.x <= cssW && hover.y >= 0 && hover.y <= cssH ? 1 : 0;
      if (!drag.active) return;
      cam.yawV += (event.clientX - drag.lastX) * ORBIT;
      cam.pitchV += (event.clientY - drag.lastY) * ORBIT * 0.6;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
    };
    const pointerDown = event => {
      if (!running || drag.active || event.isPrimary === false || event.button !== 0) return;
      drag.active = true;
      drag.id = event.pointerId;
      drag.touch = event.pointerType === 'touch';
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      pointerMove(event);
      if (host.setPointerCapture) {
        try { host.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
      }
    };
    const pointerUp = event => {
      if (event && event.pointerId !== drag.id) return;
      const id = drag.id;
      if (drag.touch || !event || event.type !== 'pointerup') hover.target = 0;
      drag.active = false;
      drag.id = null;
      if (id !== null && host.releasePointerCapture) {
        try { host.releasePointerCapture(id); } catch { /* already released */ }
      }
    };
    const pointerLeave = () => { hover.target = 0; };
    host.addEventListener('pointerdown', pointerDown);
    host.addEventListener('pointermove', pointerMove);
    host.addEventListener('pointerleave', pointerLeave);
    host.addEventListener('pointerup', pointerUp);
    host.addEventListener('pointercancel', pointerUp);
    host.addEventListener('lostpointercapture', pointerUp);

    return Object.freeze({
      /*
       * One frame, drawn once. A reader who asked for less motion still gets
       * the scene -- held still, which is what a poster was for.
       */
      renderStill() {
        if (lost) return;
        resize();
        draw(0);
      },
      start() {
        wanted = true;
        if (running || lost) return;
        begin();
      },
      stop() {
        wanted = false;
        running = false;
        pointerUp();
        hover.target = 0;
        hover.active = 0;
        cam.yawV = 0;
        cam.pitchV = 0;
        if (raf) global.cancelAnimationFrame(raf);
        raf = 0;
      },
      isRunning() { return running; },
      setTheme(name) {
        theme = THEMES[name] || THEMES.dark;
        if (!running) this.renderStill();
      },
      /* A preset name, or a shape: { top, waist, waistAt, bottom, twist, ... }. */
      setShape(preset, overrides) {
        shape = resolveShape(preset, overrides);
        shapeId += 1;
        if (!running) this.renderStill();
      },
      shape() { return shape; },
      setReaching(on) { reachingTarget = on ? 1 : 0; },
      interactive() { return true; },
      destroy() {
        this.stop();
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
        if (observer) observer.disconnect();
        else if (global.removeEventListener) global.removeEventListener('resize', onResize);
        host.removeEventListener('pointerdown', pointerDown);
        host.removeEventListener('pointermove', pointerMove);
        host.removeEventListener('pointerleave', pointerLeave);
        host.removeEventListener('pointerup', pointerUp);
        host.removeEventListener('pointercancel', pointerUp);
        host.removeEventListener('lostpointercapture', pointerUp);
        if (res) {
          [res.strandBuf, res.rndBuf, res.idxBuf, res.seedBuf].forEach(buffer => gl.deleteBuffer(buffer));
          gl.deleteProgram(res.strands.program);
          gl.deleteProgram(res.dust.program);
          res = null;
        }
      }
    });
  }

  global.NebulaVortex = Object.freeze({
    create, THEMES, PRESETS, TIERS, VERTEX_LIMIT, strandVertices, resolveShape
  });
})(typeof globalThis === 'undefined' ? this : globalThis);
