/* The landing's subject: a vortex of light, drawn in WebGL from arithmetic. */
'use strict';

/*
 * What this draws, and why it is built the way it is.
 *
 * A surface of revolution -- a crown, a waist and a base, each with its own
 * radius -- made visible mostly by points, the way a particle tornado reads:
 *
 *   motes    thousands of them, riding the spiral of the form up (or down)
 *            it, packed tight at the waist and scattering into a cloud as
 *            the form flares, each flickering on its own clock;
 *   strands  a few hundred faint spiral lines under the motes, both hands
 *            woven, so the form has a lattice to hang on and a waist that
 *            sums to the brightest light on the page;
 *   comets   a few bright heads with halos and fading tails that race the
 *            strands and part the motes as they pass -- the motes behind a
 *            comet flare and ripple outward, then settle;
 *   field    a sparse drift of dust around the whole form, so it stands in
 *            a volume rather than on a flat ground.
 *
 * And one moment that belongs to this product rather than to the shape: every
 * few seconds a band of light passes along the form, the way an audit passes
 * over a repository. Reaching for the invitation tightens the waist, speeds
 * the spin and keeps the pass running.
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
   * drives strandVertices() over the real tiers to prove it. Points are drawn
   * without indices, so they have no such ceiling.
   */
  const VERTEX_LIMIT = 65536;
  const TRAIL = 64;
  const MAX_COMETS = 10;

  /*
   * The budget follows the smaller edge of the canvas. What reads as fine
   * grain on a desktop stage is a grey smear on a 390px phone, and a hot
   * battery for a picture nobody can resolve.
   */
  const TIERS = Object.freeze([
    Object.freeze({ upTo: 520, strands: 150, segments: 56, motes: 6000, field: 500, comets: 6 }),
    Object.freeze({ upTo: 900, strands: 210, segments: 64, motes: 10000, field: 800, comets: 8 }),
    Object.freeze({ upTo: Infinity, strands: 260, segments: 72, motes: 16000, field: 1200, comets: 10 })
  ]);
  const strandVertices = tier => tier.strands * (tier.segments + 1);

  /*
   * Shapes, in world units: the form is two units tall, radii are measured
   * from the axis, waistAt runs from the crown (0) to the base (1). flare is
   * the exponent of the profile -- higher holds the column narrow longer and
   * then opens it faster, which is what turns a base into a ground plane.
   * spin is radians a second; flow is how far along the form a mote travels
   * in a second. zoom scales the framed form -- above 1 it runs past its box
   * and the page's own edges feather it -- and rise moves it up the box.
   */
  const PRESETS = Object.freeze({
    /* A tall column pinched above a base that flares into a ground of light. */
    column: Object.freeze({
      top: 1.3, waist: 0.2, waistAt: 0.58, bottom: 2.2, flare: 2.5,
      twist: 0.85, weave: 0.45, spin: 0.2, flow: 0.04, direction: 'up',
      sway: 0.03, tilt: 0.22, zoom: 1.28, rise: -0.1
    }),
    /* Two cones meeting at a point of light. */
    hourglass: Object.freeze({
      top: 1.45, waist: 0.012, waistAt: 0.5, bottom: 1.45, flare: 1.2,
      twist: 0.3, weave: 0.5, spin: 0.16, flow: 0.035, direction: 'up',
      sway: 0.02, tilt: 0.2, zoom: 1.1, rise: 0
    }),
    /* A spire rising out of a wide skirt of light. */
    spire: Object.freeze({
      top: 0.55, waist: 0, waistAt: 0.22, bottom: 1.6, flare: 1.45,
      twist: 0.9, weave: 0.2, spin: 0.22, flow: 0.045, direction: 'up',
      sway: 0.02, tilt: 0.16, zoom: 1.12, rise: 0
    }),
    /* A funnel cloud: a wide crown narrowing to a point that touches down. */
    funnel: Object.freeze({
      top: 1.35, waist: 0.03, waistAt: 0.94, bottom: 0.3, flare: 1.6,
      twist: 1.4, weave: 0.18, spin: 0.32, flow: 0.055, direction: 'up',
      sway: 0.08, tilt: 0.15, zoom: 1.06, rise: 0
    }),
    /* A deep cup on a short stem. */
    chalice: Object.freeze({
      top: 1.3, waist: 0.2, waistAt: 0.74, bottom: 0.72, flare: 2.6,
      twist: 0.62, weave: 0.5, spin: 0.16, flow: 0.04, direction: 'down',
      sway: 0.025, tilt: 0.24, zoom: 1, rise: 0
    })
  });

  /* Every numeric field a shape carries, and the range the shader was written for. */
  const RANGES = Object.freeze({
    top: Object.freeze([0, 2.4]), waist: Object.freeze([0, 1.2]), waistAt: Object.freeze([0.02, 0.98]),
    bottom: Object.freeze([0, 2.4]), flare: Object.freeze([0.6, 4]), twist: Object.freeze([-3, 3]),
    weave: Object.freeze([0, 1]), spin: Object.freeze([-2, 2]), flow: Object.freeze([0, 0.4]),
    sway: Object.freeze([0, 0.2]), tilt: Object.freeze([-0.6, 0.6]), zoom: Object.freeze([0.5, 2]),
    rise: Object.freeze([-0.6, 0.6])
  });

  /*
   * One palette per theme, and one blend per palette.
   *
   * On a dark ground the layers are added to what is behind them, which is
   * what makes a mote read as light rather than as a dot, and why the waist
   * -- where everything converges -- is the brightest thing on the page.
   * Adding light to a light ground only ever approaches white, so the light
   * themes composite normally with inked colours instead: the same form
   * drawn as a stipple, densest (darkest) at the waist for the same reason.
   *
   * The comets are the one warm colour in a cool palette, on purpose: they
   * are the thing moving through the form, and the eye should find them.
   */
  const THEMES = Object.freeze({
    dark: Object.freeze({
      additive: true,
      top: '#5EEAD4', waist: '#EDE9FE', bottom: '#A78BFA',
      hot: '#F8F7FF', accent: '#FDBA74', dust: '#E4DEFF',
      line: 0.1, mote: 0.85, field: 0.45
    }),
    light: Object.freeze({
      additive: false,
      top: '#0E7490', waist: '#2E1065', bottom: '#6D28D9',
      hot: '#1E1B4B', accent: '#C2410C', dust: '#312E81',
      line: 0.12, mote: 0.5, field: 0.3
    }),
    /* Platinum over the stone, the product violet kept for the comets. */
    'obsidian-dark': Object.freeze({
      additive: true,
      top: '#D4D4D8', waist: '#FAFAFA', bottom: '#A1A1AA',
      hot: '#FAFAFA', accent: '#A78BFA', dust: '#F4F4F5',
      line: 0.09, mote: 0.8, field: 0.4
    }),
    /* Quartz: the same form inked in graphite. */
    'obsidian-light': Object.freeze({
      additive: false,
      top: '#57534E', waist: '#1C1917', bottom: '#44403C',
      hot: '#0C0A09', accent: '#5B3FD0', dust: '#292524',
      line: 0.11, mote: 0.46, field: 0.28
    })
  });

  /*
   * The shape, shared by both programs so the motes sit on the strands they
   * ride and the pointer pushes both the same way.
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

/* Set by project(): how much nearer than the axis a point is, for sizing. */
float gNear;

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
  return smoothstep(0.0, 0.1, v) * (1.0 - smoothstep(0.9, 1.0, v));
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
  gNear = 1.0;
  if (rz < 0.2) return vec4(2.0, 2.0, 0.0, 1.0);
  gNear = uDist / rz;

  vec2 ndc = vec2(x1, y2) * uFocal / rz / (uRes * 0.5) + vec2(0.0, uLift);

  /* The pointer is a field, not a cursor: the form parts around it. */
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 d = (ndc - uPointer) * aspect;
  float dist = length(d);
  push = uHoverActive * exp(-(dist * dist) / 0.04);
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

  vCol = mix(col, uHot, clamp(neck * 0.5 + scan * 0.8, 0.0, 1.0));
  vAlpha = uAlpha * (0.45 + 0.55 * aRnd.x)
    * rimFade(v)
    * mix(0.3, 1.0, facing)
    * (0.75 + 1.1 * run + 2.4 * scan + 0.8 * push + 0.8 * neck);
}
`;

  const DUST_VERT = `${COMMON}
attribute vec4 aSeed;     /* angle, phase, random, kind: 0 mote, -1 field, 1 + place in a trail */

uniform vec3  uColTop;
uniform vec3  uColWaist;
uniform vec3  uColBottom;
uniform vec3  uColDust;
uniform vec3  uAccent;
uniform vec3  uHot;
uniform float uMote;
uniform float uField;
uniform float uFlowDir;
uniform float uPx;
uniform vec2  uScan;
uniform vec4  uComets[${MAX_COMETS}];   /* head: position along, angle, radius, alive */

varying vec3  vCol;
varying float vAlpha;
varying float vGlow;

float hash(float n) { return fract(sin(n) * 43758.5453); }

vec3 ramp(float v) {
  float w = uWaistAt;
  return v < w
    ? mix(uColTop, uColWaist, smoothstep(0.0, 1.0, v / max(w, 0.001)))
    : mix(uColWaist, uColBottom, smoothstep(0.0, 1.0, (v - w) / max(1.0 - w, 0.001)));
}

void main() {
  float rnd = aSeed.z;
  float kind = aSeed.w;
  float facing;
  float push;
  float alpha;
  float size;
  vec3 col;
  vGlow = 0.0;

  if (kind < -0.5) {
    /* The field: dust around the form, drifting with it, faint and far. */
    float angle = aSeed.x + uSpin * 0.25;
    float r = 0.35 + 2.3 * sqrt(hash(rnd * 91.7));
    float y = fract(aSeed.y - uFlowDir * uFlowClock * 0.35) * 3.0 - 1.5;
    gl_Position = project(vec3(cos(angle) * r, y, sin(angle) * r), facing, push);
    float twinkle = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uTime * (0.6 + 1.8 * rnd) + rnd * 57.0), 3.0);
    float ends = smoothstep(-1.5, -1.1, y) * (1.0 - smoothstep(1.1, 1.5, y));
    size = mix(0.7, 1.6, hash(rnd * 13.1)) * gNear;
    alpha = uField * twinkle * ends * mix(0.45, 1.0, facing);
    col = mix(uColDust, ramp(clamp(0.5 - y * 0.5, 0.0, 1.0)), 0.35);
  } else if (kind < 0.5) {
    /*
     * A mote rides the strands: same spiral, moving along it. Tight to the
     * surface at the waist, scattering as the form opens -- the flare is a
     * cloud, not a skin.
     */
    float v = fract(aSeed.y + uFlowDir * uFlowClock * (0.45 + 0.55 * rnd));
    float away = abs(v - uWaistAt) / max(max(uWaistAt, 1.0 - uWaistAt), 0.001);
    float spread = 0.012 + 0.3 * pow(away, 1.6);
    float scatter = (hash(rnd * 37.1) + hash(rnd * 71.3) - 1.0) * spread * (0.5 + radiusAt(v));
    scatter *= hash(rnd * 17.7) < 0.18 ? 3.2 : 1.0;
    float angle = aSeed.x + uSpin + uTwist * TAU * (v - uWaistAt) + (hash(rnd * 5.3) - 0.5) * 0.12;

    /*
     * The wake: a mote a comet has just passed flares, and is thrown out in
     * a ripple that decays behind the head. Looked up against every comet
     * rather than stored, so the scene keeps no state between frames and a
     * held frame is still exact.
     */
    float wake = 0.0;
    for (int i = 0; i < ${MAX_COMETS}; i++) {
      vec4 c = uComets[i];
      if (c.w < 0.5) continue;
      float along = (v - c.x) * -uFlowDir;
      /* Most motes are nowhere near a given comet: leave before any exp(). */
      if (along < -0.02 || along > 0.3) continue;
      float da = angle - c.y;
      da -= TAU * floor(da / TAU + 0.5);
      float across = da * c.z;
      if (abs(across) > 0.2) continue;
      float g = exp(-(across * across) / 0.0036) * exp(-max(along, 0.0) * 14.0);
      wake += g * (0.6 + 0.4 * cos(along * 110.0 - uTime * 5.0));
    }
    wake = min(wake, 1.5);

    gl_Position = project(surface(angle, v, scatter + wake * 0.07), facing, push);
    float flicker = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * (1.2 + 4.0 * rnd) + rnd * 91.0), 2.0);
    flicker *= step(0.06, hash(rnd * 3.7 + floor(uTime * (0.5 + rnd))));
    float ds = (v - uScan.x) / 0.05;
    float scan = uScan.y * exp(-ds * ds);
    float dn = (v - uWaistAt) / 0.08;
    float neck = exp(-dn * dn);
    size = mix(0.9, 2.3, pow(hash(rnd * 29.3), 3.0)) * gNear * (1.0 + wake * 0.6);
    alpha = uMote * flicker * rimFade(v) * mix(0.3, 1.0, facing)
      * (1.0 + 1.6 * scan + push + 2.2 * wake + 0.6 * neck);
    col = mix(mix(uColDust, ramp(v), 0.5), uHot, clamp(scan + neck * 0.4, 0.0, 1.0));
    col = mix(col, uAccent, clamp(wake * 0.55, 0.0, 0.8));
  } else {
    /* A comet: a head with a halo, and a tail, whipping round faster than the strands. */
    float k = kind - 1.0;
    float head = fract(aSeed.y + uFlowDir * uFlowClock * 2.4 * (0.75 + 0.5 * rnd));
    float v = head - uFlowDir * k * 0.1;
    float angle = aSeed.x + uSpin * 2.2 + uTwist * TAU * (v - uWaistAt) + v * 2.0;
    gl_Position = project(surface(angle, v, 0.015), facing, push);
    float inside = step(0.0, v) * step(v, 1.0);
    vGlow = k < 0.001 ? 1.0 : 0.0;
    size = (k < 0.001 ? 22.0 : mix(3.2, 0.9, sqrt(k))) * gNear;
    alpha = inside * pow(1.0 - k, 1.5) * rimFade(v) * mix(0.45, 1.0, facing);
    col = mix(uHot, uAccent, smoothstep(0.0, 0.2, k) * 0.7 + vGlow * 0.3);
  }

  gl_PointSize = max(size * uPx, 1.0);
  vCol = col;
  vAlpha = alpha;
}
`;

  /*
   * The canvas's own edges fade here, in the scene, rather than through a CSS
   * mask on the element. A mask makes the compositor draw the canvas into an
   * offscreen layer and blend it again on every frame; on a software
   * renderer that second pass cost as much as the scene. The edges are in
   * uEdge, as fractions of the buffer: left, right, top, bottom.
   */
  const FRAG_HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uView;
uniform vec4 uEdge;
varying vec3  vCol;
varying float vAlpha;
float edgeFade() {
  vec2 p = gl_FragCoord.xy / uView;
  return smoothstep(0.0, uEdge.x, p.x) * smoothstep(0.0, uEdge.y, 1.0 - p.x)
    * smoothstep(0.0, uEdge.w, p.y) * smoothstep(0.0, uEdge.z, 1.0 - p.y);
}
`;

  /* Premultiplied, so one shader serves both the additive and normal blends. */
  const LINE_FRAG = `${FRAG_HEAD}
void main() {
  float a = vAlpha * edgeFade();
  gl_FragColor = vec4(vCol * a, a);
}
`;

  /* A crisp mote, or -- for a comet's head -- a hot core inside a wide halo. */
  const POINT_FRAG = `${FRAG_HEAD}
varying float vGlow;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float disc = 1.0 - smoothstep(0.55, 1.0, d);
  float halo = exp(-d * d * 28.0) + 0.32 * exp(-d * d * 4.0);
  float a = mix(disc, halo * (1.0 - smoothstep(0.85, 1.0, d)), vGlow) * vAlpha * edgeFade();
  gl_FragColor = vec4(vCol * a, a);
}
`;

  /* How far in from each edge the canvas fades, as a fraction of its size. */
  const FEATHER = Object.freeze({ left: 0.08, right: 0.14, top: 0.07, bottom: 0.14 });

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

  /*
   * Whether WebGL would be drawn in software. Asked of a throwaway canvas,
   * because the answer decides how the real context is created (with or
   * without multisampling) and a canvas keeps the first context it is given.
   * Not every browser refuses failIfMajorPerformanceCaveat for a software
   * rasteriser -- headless Chromium hands one over -- so the renderer's own
   * name is read as well.
   */
  function softwareRenderer(doc) {
    if (!doc || typeof doc.createElement !== 'function') return false;
    try {
      const probe = doc.createElement('canvas');
      const g = probe.getContext('webgl', { failIfMajorPerformanceCaveat: true });
      if (!g) return true;
      const info = g.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(g.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : g.RENDERER) || '');
      const lose = g.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
    } catch {
      return false;
    }
  }

  /* A preset name, a shape object, or both: options win over the preset. */
  function resolveShape(preset, overrides) {
    const base = typeof preset === 'string' && PRESETS[preset] ? PRESETS[preset] : PRESETS.column;
    const shape = Object.assign({}, base);
    const extra = preset && typeof preset === 'object' ? preset : overrides;
    if (extra) {
      if (extra.direction === 'up' || extra.direction === 'down') shape.direction = extra.direction;
      Object.keys(RANGES).forEach(key => {
        const n = Number(extra[key]);
        if (extra[key] != null && Number.isFinite(n)) shape[key] = n;
      });
    }
    Object.keys(RANGES).forEach(key => {
      const [lo, hi] = RANGES[key];
      shape[key] = Math.max(lo, Math.min(hi, shape[key]));
    });
    return Object.freeze(shape);
  }

  function create(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;

    /*
     * Asked for first with failIfMajorPerformanceCaveat, which the browser
     * refuses when it would draw in software -- a blocklisted driver, no GPU,
     * a headless runner. There the scene runs lite: no multisampling (which a
     * software rasteriser pays for four times over), one device pixel per CSS
     * pixel, the lightest mesh and thirty frames a second. The picture is the
     * same form; the machine keeps its time for the page.
     */
    const base = { alpha: true, premultipliedAlpha: true, depth: false };
    let gl = null;
    let lite = options.lite === true || (options.lite !== false && softwareRenderer(canvas.ownerDocument));
    if (!lite) {
      try {
        gl = canvas.getContext('webgl', Object.assign({ antialias: true, failIfMajorPerformanceCaveat: true }, base));
      } catch { gl = null; }
      if (!gl) lite = true;
    }
    if (!gl) {
      try { gl = canvas.getContext('webgl', Object.assign({ antialias: false }, base)); } catch { gl = null; }
    }
    if (!gl) return null;
    const feather = Object.assign({}, FEATHER, options.feather || {});
    const edges = new Float32Array(['left', 'right', 'top', 'bottom']
      .map(side => Math.max(0.001, Math.min(0.45, Number(feather[side]) || 0.001))));

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
      'uHoverActive', 'uHot', 'uFlowDir', 'uScan', 'uLift', 'uFlowClock',
      'uColTop', 'uColWaist', 'uColBottom', 'uView', 'uEdge'];

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
          u: uniforms(strands, SHARED.concat(['uAlpha']))
        },
        dust: {
          program: dust,
          aSeed: gl.getAttribLocation(dust, 'aSeed'),
          u: uniforms(dust, SHARED.concat(['uColDust', 'uAccent', 'uMote', 'uField', 'uPx', 'uComets[0]']))
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

    /* The comets' seeds, kept so their heads can be placed for the wake. */
    let comets = [];
    const cometHeads = new Float32Array(MAX_COMETS * 4);

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

      const points = tier.motes + tier.field + tier.comets * TRAIL;
      const seed = new Float32Array(points * 4);
      let p = 0;
      const put = (a, b, c, d) => {
        seed[p * 4] = a;
        seed[p * 4 + 1] = b;
        seed[p * 4 + 2] = c;
        seed[p * 4 + 3] = d;
        p += 1;
      };
      for (let i = 0; i < tier.motes; i += 1) put(random() * TAU, random(), random(), 0);
      for (let i = 0; i < tier.field; i += 1) put(random() * TAU, random(), random(), -1);
      comets = [];
      for (let c = 0; c < tier.comets; c += 1) {
        const comet = { angle: random() * TAU, phase: random(), r: random() };
        comets.push(comet);
        for (let t = 0; t < TRAIL; t += 1) put(comet.angle, comet.phase, comet.r, 1 + t / (TRAIL - 1));
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
    let waistNow = shape.waist;
    let last = 0;

    function resize() {
      dpr = lite ? 1 : Math.min(global.devicePixelRatio || 1, DPR_CAP);
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

    /*
     * The budget: the box's size picks a tier, and the device may lower it.
     * A software renderer starts at the lightest; a GPU that cannot hold the
     * frame rate is stepped down one tier at a time, and never back up in the
     * same visit -- a scene that alternates between two budgets flickers.
     */
    let tierCap = lite ? 0 : TIERS.length - 1;
    const pace = { ema: 16, frames: 0, slow: 0 };
    function tierFor() {
      const edge = Math.min(cssW, cssH) || 1;
      const index = TIERS.findIndex(tier => edge < tier.upTo);
      return TIERS[Math.min(index === -1 ? TIERS.length - 1 : index, tierCap)];
    }
    function pacing(interval) {
      if (tierCap === 0) return;
      pace.ema += (interval - pace.ema) * 0.1;
      pace.frames += 1;
      if (pace.frames < 45) return;
      pace.slow = pace.ema > 42 ? pace.slow + 1 : 0;
      if (pace.slow < 30) return;
      tierCap -= 1;
      pace.ema = 16;
      pace.frames = 0;
      pace.slow = 0;
    }

    function radiusAt(v, waist) {
      const w = shape.waistAt;
      const above = v <= w;
      const u = above ? (w - v) / w : (v - w) / (1 - w);
      const rim = above ? shape.top : shape.bottom;
      const neck = waist == null ? shape.waist : waist;
      return neck + (rim - neck) * Math.pow(Math.max(0, Math.min(1, u)), shape.flare);
    }

    const DIST = 6;
    /*
     * Framed from what is actually drawn, not from the numbers in the preset.
     * The visible part of the form is projected once at the resting tilt, and
     * the focal length and a vertical offset are chosen so its bounds fill
     * the box and sit in the middle of it -- a funnel whose weight is all at
     * the top is centred as honestly as an hourglass. Then the shape's own
     * zoom and rise are applied, which is how a preset asks to run past its
     * box. Cached per box and per shape; a drag tilts the view without
     * zooming it.
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
      for (let v = 0.06; v <= 0.941; v += 0.02) {
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
      const focal = Math.min(canvas.width * 0.5 * 0.94 / halfX, canvas.height * 0.5 * 0.9 / halfY);
      fit.focal = focal * shape.zoom;
      fit.lift = -((maxY + minY) / 2) * fit.focal / (canvas.height * 0.5) + shape.rise;
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

    /*
     * Whether the pointer is over the form rather than merely over the box.
     * The form is sampled as a stack of rings, each projected to an ellipse
     * (the band between two rings counts too). The rims are left out and the
     * rings held in, since the form has thinned to scattered dust by then --
     * a pointer out there is over the ground, not over the vortex.
     */
    function overForm(focal, pitch) {
      const BANDS = 24;
      const SIDES = 12;
      const bandHalf = (cssH / BANDS) * 0.6;
      for (let b = 3; b <= BANDS - 3; b += 1) {
        const v = b / BANDS;
        const r = radiusAt(v, waistNow) * 0.8 + 0.05;
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

    /*
     * Where each comet's head is this frame -- the same arithmetic as the
     * shader's comet path -- so the motes it passes can answer it.
     */
    function placeComets() {
      const dir = shape.direction === 'up' ? -1 : 1;
      cometHeads.fill(0);
      comets.slice(0, MAX_COMETS).forEach((c, i) => {
        const raw = c.phase + dir * flowClock * 2.4 * (0.75 + 0.5 * c.r);
        const v = raw - Math.floor(raw);
        const angle = c.angle + spin * 2.2 + shape.twist * TAU * (v - shape.waistAt) + v * 2;
        const edge = Math.min(v / 0.1, (1 - v) / 0.1, 1);
        cometHeads[i * 4] = v;
        cometHeads[i * 4 + 1] = angle;
        cometHeads[i * 4 + 2] = Math.max(radiusAt(v, waistNow), 0.02);
        cometHeads[i * 4 + 3] = edge > 0.05 ? 1 : 0;
      });
    }

    function setShared(u, focal) {
      gl.uniform2f(u.uView, canvas.width, canvas.height);
      gl.uniform4fv(u.uEdge, edges);
      gl.uniform1f(u.uLift, fit.lift);
      gl.uniform1f(u.uFlowClock, flowClock);
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform1f(u.uFocal, focal);
      gl.uniform1f(u.uDist, DIST);
      gl.uniform1f(u.uCamYaw, cam.yaw);
      gl.uniform1f(u.uCamPitch, cam.pitch);
      gl.uniform1f(u.uTilt, shape.tilt);
      gl.uniform1f(u.uTime, elapsed);
      gl.uniform1f(u.uSpin, spin);
      gl.uniform1f(u.uTop, shape.top);
      gl.uniform1f(u.uWaist, waistNow);
      gl.uniform1f(u.uWaistAt, shape.waistAt);
      gl.uniform1f(u.uBottom, shape.bottom);
      gl.uniform1f(u.uFlare, shape.flare);
      gl.uniform1f(u.uTwist, shape.twist);
      gl.uniform1f(u.uSway, shape.sway);
      gl.uniform2f(u.uPointer, (hover.x / (cssW || 1)) * 2 - 1, 1 - (hover.y / (cssH || 1)) * 2);
      gl.uniform1f(u.uRepel, 0.07);
      gl.uniform1f(u.uHoverActive, hover.active);
      gl.uniform3fv(u.uHot, colors.hot);
      gl.uniform3fv(u.uColTop, colors.top);
      gl.uniform3fv(u.uColWaist, colors.waist);
      gl.uniform3fv(u.uColBottom, colors.bottom);
      gl.uniform1f(u.uFlowDir, shape.direction === 'up' ? -1 : 1);
      gl.uniform2f(u.uScan, scan.at, scan.gain);
    }

    /*
     * The pass: a band of light along the form, every few seconds at rest
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
      scan.gain = Math.sin(Math.PI * t) * (0.65 + reaching * 0.35);
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
      /* The waist breathes, and draws in when the reader reaches for the card. */
      waistNow = shape.waist * (1 - reaching * 0.22) * (1 + 0.07 * Math.sin(elapsed * 0.8));
      stepScan(dt);
      placeComets();

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
      const heavy = TIERS[TIERS.length - 1];
      const thinLines = Math.sqrt(heavy.strands / tier.strands);
      const thinMotes = Math.sqrt(heavy.motes / tier.motes);

      gl.blendFunc(gl.ONE, theme.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const S = res.strands;
      gl.useProgram(S.program);
      setShared(S.u, focal);
      gl.uniform1f(S.u.uAlpha, theme.line * thinLines * (1 + reaching * 0.2));
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
      gl.uniform1f(D.u.uMote, Math.min(1, theme.mote * thinMotes));
      gl.uniform1f(D.u.uField, theme.field);
      gl.uniform1f(D.u.uPx, dpr * Math.max(0.8, Math.min(1.25, Math.min(cssW, cssH) / 600)));
      gl.uniform4fv(D.u['uComets[0]'], cometHeads);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.seedBuf);
      gl.enableVertexAttribArray(D.aSeed);
      gl.vertexAttribPointer(D.aSeed, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, res.pointCount);
      gl.disableVertexAttribArray(D.aSeed);
    }

    function frame(now) {
      if (!running) return;
      raf = global.requestAnimationFrame(frame);
      const interval = now - last;
      /* Lite holds thirty frames a second; the display may offer more. */
      if (lite && interval < 31) return;
      pacing(interval);
      const dt = Math.min(interval / 1000, 0.05);
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
      /* Whether this device is drawing the lite scene, and the budget it is on. */
      budget() { return { lite, tier: TIERS.indexOf(tierFor()) }; },
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
    create, THEMES, PRESETS, RANGES, TIERS, FEATHER, VERTEX_LIMIT, strandVertices, resolveShape
  });
})(typeof globalThis === 'undefined' ? this : globalThis);
