/*
 * <nebula-galaxy> -- the reference artwork's light-streak vortex.
 *
 * Adopted from the design's own component, unchanged in its shader: the ribbon
 * accumulation, the differential rotation and the palettes are the artwork, and
 * altering them would make this a lookalike rather than the thing that was
 * drawn.
 *
 * What is added here is what shipping it requires. The element is decorative,
 * so it is hidden from assistive technology; it stops animating off-screen and
 * on a hidden tab; it honours a reduced-motion preference by holding a single
 * frame rather than by disappearing; and it is imported only after the caller
 * has established that this device has WebGL to draw it with, because the
 * module pulls three.js behind it.
 *
 * The import is an absolute path rather than a bare specifier on purpose. A
 * bare 'three' needs an import map, an import map is an inline script, and an
 * inline script needs the policy relaxed to allow one -- a real weakening of
 * script-src to save a path.
 */
import * as THREE from '/vendor/three/0.185.1/three.module.min.js';

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform float uT;
uniform float uAspect;
uniform float uLight;
uniform float uExposure;
uniform float uStars;
uniform int   uStrands;
uniform float uTilt;
uniform float uSquash;
uniform float uArms;
uniform float uPitch;

uniform vec3 uCore;
uniform vec3 uInner;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uMag;
uniform vec3 uCrim;

const float PI  = 3.141592653589793;
const float TAU = 6.283185307179586;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453123); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec3 strandColor(float rc, float h) {
  vec3 c = mix(uInner, uMid, smoothstep(0.08, 0.38, rc));
  c = mix(c, uDeep, smoothstep(0.38, 0.74, rc));
  // a small minority of strands carry magenta / crimson accents
  c = mix(c, uMag,  step(0.88, h) * 0.42);
  c = mix(c, uCrim, step(0.965, h) * 0.38);
  return c;
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= uAspect;

  // inclined disc: rotate major axis, then un-squash the minor axis so a
  // circular disc in disc-space projects as a tilted ellipse on screen.
  float ct = cos(uTilt), st = sin(uTilt);
  vec2 e = vec2(p.x * ct + p.y * st, -p.x * st + p.y * ct);
  e.y *= uSquash;

  float r = length(e);
  float a = atan(e.y, e.x);

  // ---- ribbons ------------------------------------------------------
  float dens = 0.0;
  vec3  col  = vec3(0.0);

  for (int i = 0; i < 18; i++) {
    if (i >= uStrands) break;
    float fi = float(i);
    float h1 = hash(fi * 1.37 + 0.11);
    float h2 = hash(fi * 2.71 + 0.53);
    float h3 = hash(fi * 4.13 + 0.97);

    float arm  = floor(mod(fi, uArms));              // which arm this strand joins
    float base = arm / uArms * TAU;
    float jit  = (h1 - 0.5) * 0.26;                  // filament offset inside the arm

    float rc    = 0.10 + h2 * 0.66;                  // band centre
    float bw    = 0.14 + h3 * 0.24;                  // wide band -> long clean arc
    float thick = 0.028 + h3 * 0.050;                // thin, crisp line
    float spin  = 0.070 + (1.0 - rc) * 0.240;        // inner winds faster
    float phase = base + jit - uT * spin;

    float th = phase + log(max(r, 0.02)) * uPitch;   // shared pitch -> coherent arms
    float d  = mod(a - th + PI, TAU) - PI;

    float line = exp(-(d * d) / (2.0 * thick * thick));
    line = pow(line, 1.0 + h2 * 0.9);
    float band = exp(-pow((r - rc) / bw, 2.0));

    float g = line * band * (0.55 + h3 * 0.75);
    dens += g;
    col  += strandColor(rc, h3) * g;
  }

  // ---- broad soft washes -------------------------------------------
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float h1 = hash(fi * 3.31 + 5.7);
    float h2 = hash(fi * 1.91 + 2.3);

    float rc    = 0.18 + h1 * 0.62;
    float bw    = 0.19 + h2 * 0.24;
    float pitch = 1.30 + h2 * 1.60;
    float thick = 0.42 + h1 * 0.55;
    float phase = h2 * TAU - uT * (0.06 + (1.0 - rc) * 0.16);

    float th = phase + log(max(r, 0.02)) * pitch;
    float d  = mod(a - th + PI, TAU) - PI;

    float g = exp(-(d * d) / (2.0 * thick * thick)) * exp(-pow((r - rc) / bw, 2.0)) * 0.17;
    dens += g;
    col  += strandColor(rc, h1) * g;
  }

  // ---- core + halo --------------------------------------------------
  float breathe = 1.0 + sin(uT * 0.55) * 0.05;
  float core = exp(-pow(r / (0.058 * breathe), 2.0)) * 1.85
             + exp(-pow(r / 0.150, 2.0)) * 0.62
             + exp(-pow(r / 0.330, 1.5)) * 0.20;
  float haze = exp(-pow(r / 0.560, 1.7)) * 0.15;

  dens += core + haze;
  col  += uCore * core + uInner * haze;

  // ---- stars --------------------------------------------------------
  if (uStars > 0.5) {
    // bright foreground stars
    vec2 g = p * 19.0;
    vec2 id = floor(g);
    vec2 f  = fract(g) - 0.5;
    float h = hash2(id);
    if (h > 0.862) {
      vec2 off = (vec2(hash2(id + 13.7), hash2(id + 27.1)) - 0.5) * 0.62;
      float sd = length(f - off);
      float tw = 0.45 + 0.55 * sin(uT * 1.9 + h * 61.0);
      float s = exp(-pow(sd / 0.075, 2.0)) * tw * smoothstep(0.98, 0.30, r);
      dens += s * 0.55;
      col  += vec3(0.95, 0.92, 1.0) * s * 0.85;
    }

    // fine background dust: denser grid, dimmer, slower twinkle
    vec2 g2  = p * 43.0;
    vec2 id2 = floor(g2);
    vec2 f2  = fract(g2) - 0.5;
    float hd = hash2(id2 + 91.3);
    if (hd > 0.775) {
      vec2 od = (vec2(hash2(id2 + 5.1), hash2(id2 + 41.9)) - 0.5) * 0.70;
      float dd = length(f2 - od);
      float td = 0.55 + 0.45 * sin(uT * 1.05 + hd * 37.0);
      float sdust = exp(-pow(dd / 0.17, 2.0)) * td * smoothstep(1.04, 0.16, r);
      dens += sdust * 0.19;
      col  += vec3(0.82, 0.86, 1.0) * sdust * 0.30;
    }
  }

  // ---- resolve ------------------------------------------------------
  float vig = smoothstep(1.02, 0.60, r);
  dens *= vig;
  col  *= vig;

  if (uLight > 0.5) {
    // ink density on paper: deepest at the core, magenta at the rim
    float ink = clamp(dens * 0.72, 0.0, 1.0);
    ink = pow(ink, 0.86);
    vec3 tint = normalize(col + 1e-4);
    vec3 pigment = mix(uMid, tint * 0.85, 0.55);
    pigment = mix(pigment, uCore, smoothstep(0.55, 1.0, ink));
    gl_FragColor = vec4(pigment, ink * 0.94);
    return;
  }

  vec3 lit = vec3(1.0) - exp(-col * uExposure);
  float alpha = clamp(dens * 0.90, 0.0, 1.0);
  alpha = pow(alpha, 0.82);
  gl_FragColor = vec4(lit, alpha);
}`;

const PALETTE = {
  dark: {
    core:  0xfff6ff, inner: 0xd8c4ff, mid: 0x8b5cf6,
    deep:  0x5b2fd6, mag:   0xd946ef, crim: 0xe0218a,
    exposure: 1.35
  },
  light: {
    core:  0x2e1065, inner: 0x7c3aed, mid: 0x6d28d9,
    deep:  0x4c1d95, mag:   0xa21caf, crim: 0x9d174d,
    exposure: 1.0
  }
};

class NebulaGalaxy extends HTMLElement {
  static get observedAttributes() { return ['theme', 'density']; }

  connectedCallback() {
    if (this._built) return;
    this._built = true;

    this.style.display = this.style.display || 'block';
    if (!this.style.width) this.style.width = '100%';
    if (!this.style.height) this.style.height = '100%';
    /* Decoration: announced to nobody, reachable by nothing. */
    this.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    this.appendChild(canvas);
    this.canvas = canvas;

    /*
     * A device that refuses a context is not an error to report: the interface
     * reads correctly without the artwork, so the element removes its canvas
     * and stays silent rather than leaving a blank box or throwing through the
     * caller's boot.
     */
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas, alpha: true, antialias: false, preserveDrawingBuffer: true,
        premultipliedAlpha: false, powerPreference: 'high-performance'
      });
    } catch {
      canvas.remove();
      this._failed = true;
      return;
    }
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();

    this.uniforms = {
      uT: { value: 0 }, uAspect: { value: 1 }, uLight: { value: 0 },
      uExposure: { value: 1.35 }, uStars: { value: 1 }, uStrands: { value: 18 },
      uTilt: { value: 0.38 }, uSquash: { value: 2.05 },
      uArms: { value: 2.0 }, uPitch: { value: 4.8 },
      uCore: { value: new THREE.Color() }, uInner: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() },
      uMag: { value: new THREE.Color() }, uCrim: { value: new THREE.Color() }
    };

    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
        transparent: true, depthTest: false, depthWrite: false
      })
    );
    quad.frustumCulled = false;
    this.scene.add(quad);

    this.paint();
    this.resize();

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this);

    this._visible = true;
    this._io = new IntersectionObserver((es) => {
      this._visible = es.some(e => e.isIntersecting);
      this._visible ? this.start() : this.stop();
    }, { rootMargin: '600px', threshold: 0 });
    this._io.observe(this);

    this._onVis = () => (document.hidden ? this.stop() : this._visible && this.start());
    document.addEventListener('visibilitychange', this._onVis);

    this.start();
  }

  disconnectedCallback() {
    this.stop();
    this._ro && this._ro.disconnect();
    this._io && this._io.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
  }

  attributeChangedCallback(n, o, v) {
    if (!this._built || o === v) return;
    this.paint();
    if (n === 'density') this.resize();
  }

  paint() {
    if (this._failed) return;
    const light = (this.getAttribute('theme') || 'dark') === 'light';
    const p = PALETTE[light ? 'light' : 'dark'];
    const u = this.uniforms;
    u.uLight.value = light ? 1 : 0;
    u.uExposure.value = p.exposure;
    u.uCore.value.setHex(p.core);
    u.uInner.value.setHex(p.inner);
    u.uMid.value.setHex(p.mid);
    u.uDeep.value.setHex(p.deep);
    u.uMag.value.setHex(p.mag);
    u.uCrim.value.setHex(p.crim);
    this.render();
  }

  resize() {
    if (this._failed) return;
    const w = this.clientWidth || 320;
    const h = this.clientHeight || 320;
    const low = this.getAttribute('density') === 'low';
    const cap = low ? 1.25 : 1.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.setSize(w, h, false);
    this.uniforms.uAspect.value = w / Math.max(h, 1);
    this.uniforms.uStrands.value = low ? 12 : 18;
    this.uniforms.uStars.value = low ? 0 : 1;
    this.render();
  }

  start() {
    if (this._failed) return;
    if (this._raf || document.hidden) return;
    this._reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._t0 = performance.now() - (this._elapsed || 0) * 1000;
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      if (now - (this._last || 0) < 32) return;
      this._last = now;
      this._elapsed = (now - this._t0) / 1000;
      this.uniforms.uT.value = this._reduced ? 8 : this._elapsed;
      this.render();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._failed) return;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  render() {
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }
}

if (!customElements.get('nebula-galaxy')) {
  customElements.define('nebula-galaxy', NebulaGalaxy);
}

export { NebulaGalaxy };
