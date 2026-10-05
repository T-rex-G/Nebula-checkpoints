/*
 * <nebula-singularity> -- the landing page's black hole.
 *
 * A dark horizon with a plasma disc orbiting it: the disc's inner edge turns
 * faster than its rim (Kepler's r^-3/2), the far side of the disc is lensed up
 * over the horizon, dust spirals in, and the whole frame banks as the reader
 * scrolls. It opens on the horizon itself: at the top of the section the hole
 * is so close that only its upper limb shows, drawn exactly where the page's
 * arc is (`horizon`, the arc's apex and radius in the element's pixels), so
 * the arc the hero ends on is the edge of the black hole. The camera then
 * pulls back -- a dolly from a long lens to a wide one -- and the disc, the
 * dust and the stars come up as the hole settles into frame, banking from
 * twenty degrees to seventy, nearly edge-on, at the gate. The page sets
 * `progress` (0 to 1) and `horizon`; the scene eases toward the progress it
 * is given rather than jumping to it, so a coarse scroll still moves it
 * smoothly. Everything else is the element's own.
 *
 * Shipping rules shared with <nebula-galaxy>: decoration, so hidden from
 * assistive technology; it draws only while on screen and on a visible tab;
 * the interface's own motion switch and the operating system's preference
 * both hold it to a single frame, which still follows the scroll; it is
 * imported only after the loader has established that this device can draw
 * it; a device that refuses a context leaves the host empty, never a blank
 * box or a thrown error. The dust is moved on the GPU, so a frame costs the
 * same with five thousand motes as with fifty.
 *
 * The import is an absolute path, for the reason the galaxy gives: a bare
 * specifier needs an inline import map, and that needs script-src relaxed.
 */
import * as THREE from '/vendor/three/0.185.1/three.module.min.js';

/*
 * The plasma's five temperatures, coolest to hottest, and the colours of the
 * horizon's rim, its haze and its dust. Nebula burns in the product's violets
 * and magentas; Obsidian in white, silver and graphite. The section is a
 * night sky in either theme, so there is no light palette.
 */
const PALETTE = {
  nebula: {
    plasma: [[0.07, 0.05, 0.16], [0.30, 0.14, 0.62], [1.25, 0.86, 1.6], [1.3, 0.26, 1.08], [0.72, 0.05, 0.44]],
    rim: [0xd8b4fe, 0x8b5cf6], corona: [[0.03, 0.03, 0.12], [0.26, 0.07, 0.36]], dust: 0xe9d5ff
  },
  obsidian: {
    plasma: [[0.07, 0.07, 0.08], [0.22, 0.23, 0.25], [1.3, 1.28, 1.24], [0.86, 0.87, 0.9], [0.44, 0.45, 0.5]],
    rim: [0xf5f5f4, 0xa8a29e], corona: [[0.03, 0.03, 0.035], [0.2, 0.2, 0.22]], dust: 0xe7e5e4
  }
};

const FRESNEL_VERTEX = 'varying vec3 N,W;void main(){N=normalize(normalMatrix*normal);vec4 wp=modelMatrix*vec4(position,1.);W=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}';

const PLASMA_VERTEX = `
varying vec3 lp;varying vec2 uv0;
void main(){
  uv0=uv;lp=position;
  vec3 q=position;
  float r=length(q.xy),a=atan(q.y,q.x);
  q.z+=sin(a*3.0+r*1.35)*.010*(r-1.25);
  gl_Position=projectionMatrix*modelViewMatrix*vec4(q,1.);
}`;
const PLASMA_FRAGMENT = `
uniform float t,opacity,phase,layer,uInner,uOuter;
uniform vec3 c0,c1,c2,c3,c4;
varying vec3 lp;varying vec2 uv0;
float H(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float N(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(H(i),H(i+vec2(1,0)),f.x),mix(H(i+vec2(0,1)),H(i+vec2(1)),f.x),f.y);}
float F(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*N(p);p=p*2.03+vec2(7.1,3.7);a*=.5;}return v;}
void main(){
  float r=length(lp.xy),a=atan(lp.y,lp.x),x=uv0.x;
  float omega=1.35/pow(max(r,1.25),1.5);
  float drift=t*(.006+.010/max(r,1.4));
  float aa=a-t*omega+phase-drift;
  float f1=F(vec2(aa*3.0,r*4.3+layer*2.1));
  float f2=F(vec2(aa*7.7+layer*3.4,r*10.6-t*.055));
  float shear=pow(.5+.5*sin(r*28.-aa*8.+f1*7.),2.0);
  float radial=(r-uInner)/max(.001,uOuter-uInner);
  float edge=smoothstep(.008,.055,radial)*(1.-smoothstep(.82,.995,radial));
  float heat=pow(1.-x,.72);
  vec3 c=mix(c0,c1,smoothstep(.02,.25,heat));
  c=mix(c,c2,smoothstep(.20,.52,heat));
  c=mix(c,c3,smoothstep(.48,.73,heat));
  c=mix(c,c4,smoothstep(.72,.98,heat));
  float dop=mix(.55,1.65,.5+.5*cos(a+2.35));
  float alpha=edge*(.10+.90*f1)*(.28+.72*f2)*(.30+.70*shear)*opacity;
  gl_FragColor=vec4(c*(.62+2.35*heat)*dop,alpha);
}`;

/* Dust on the GPU: each mote's orbit and infall are a function of time, so nothing is rewritten per frame. */
const DUST_VERTEX = `
uniform float uT,uSize,uScale;
attribute float aR,aA,aH,aV;
varying float vAlpha;
void main(){
  float span=7.0;
  float inf=.0045+.009/max(aR,1.5);
  float r=1.43+mod(aR-1.43-uT*inf,span);
  float omega=1.65*aV/pow(max(r,1.45),1.5);
  float a=aA+uT*omega;
  float outer=clamp((r-1.43)/7.1,0.,1.);
  float h=.010+.065*pow(outer,1.35);
  vec4 mv=modelViewMatrix*vec4(cos(a)*r,sin(a)*r,aH*h,1.);
  gl_Position=projectionMatrix*mv;
  gl_PointSize=uSize*uScale/max(.5,-mv.z);
  vAlpha=smoothstep(0.,.06,outer)*(1.-smoothstep(.82,1.,outer));
}`;
const DUST_FRAGMENT = `
uniform vec3 uColor;uniform float uOpacity;
varying float vAlpha;
void main(){vec2 c=gl_PointCoord-.5;float d=length(c);if(d>.5)discard;gl_FragColor=vec4(uColor,uOpacity*vAlpha*(1.-d*2.));}`;

const clamp01 = value => Math.min(1, Math.max(0, value));
const smooth = value => { const v = clamp01(value); return v * v * (3 - 2 * v); };
const lerp = (a, b, k) => a + (b - a) * k;
const RAD = Math.PI / 180;

class NebulaSingularity extends HTMLElement {
  static get observedAttributes() { return ['design', 'density', 'theme']; }

  constructor() {
    super();
    this._progress = 0;
  }

  get progress() { return this._progress; }
  set progress(value) {
    const next = clamp01(Number(value) || 0);
    if (next === this._progress) return;
    this._progress = next;
    if (this._built && !this._raf) this.render(0);
  }

  /* Where the page draws its arc, in this element's pixels: { top, radius }. */
  get horizon() { return this._horizon || null; }
  set horizon(value) {
    const top = Number(value && value.top);
    const radius = Number(value && value.radius);
    this._horizon = Number.isFinite(top) && Number.isFinite(radius) && radius > 0 ? { top, radius } : null;
    if (this._built && !this._raf) this.render(0);
  }

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
    this.low = this.getAttribute('density') === 'low';
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.low, alpha: true, powerPreference: 'high-performance' });
    } catch {
      canvas.remove();
      this._failed = true;
      return;
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x000000, 0);
    this.build();
    this.paint();
    this.resize();

    this._pointer = { x: 0, y: 0 };
    this._orbit = { x: 0, y: 0 };
    this._onPointer = event => {
      this._pointer.x = (event.clientX / window.innerWidth - 0.5) * 2;
      this._pointer.y = (event.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('pointermove', this._onPointer, { passive: true });

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this);
    this._visible = true;
    this._io = new IntersectionObserver(entries => {
      this._visible = entries.some(entry => entry.isIntersecting);
      if (this._visible) this.start(); else this.stop();
    }, { rootMargin: '200px', threshold: 0 });
    this._io.observe(this);
    this._onVisibility = () => (document.hidden ? this.stop() : this._visible && this.start());
    document.addEventListener('visibilitychange', this._onVisibility);
    this.start();
  }

  disconnectedCallback() {
    this.stop();
    if (this._ro) this._ro.disconnect();
    if (this._io) this._io.disconnect();
    if (this._motionObserver) this._motionObserver.disconnect();
    window.removeEventListener('pointermove', this._onPointer);
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  attributeChangedCallback(name, before, after) {
    if (!this._built || this._failed || before === after) return;
    if (name === 'design') this.paint();
    else if (name === 'theme' && !this._raf) this.render(0);
  }

  build() {
    const low = this.low;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(low ? 58 : 50, 1, 0.1, 100);
    this.camera.position.set(0, low ? 1.1 : 1.7, low ? 9.4 : 10.7);
    this.scene.fog = new THREE.FogExp2(0x000006, 0.017);

    /* A thin star volume behind everything. */
    const starCount = low ? 900 : 2400;
    const positions = new Float32Array(starCount * 3);
    const colours = new Float32Array(starCount * 3);
    const tint = new THREE.Color();
    for (let i = 0; i < starCount; i++) {
      const r = 16 + Math.random() * 46;
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const q = Math.sqrt(1 - u * u);
      positions.set([r * q * Math.cos(a), r * u, r * q * Math.sin(a)], i * 3);
      tint.setHSL(0.6 + Math.random() * 0.14, 0.15 + Math.random() * 0.5, 0.55 + Math.random() * 0.45);
      colours.set([tint.r, tint.g, tint.b], i * 3);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    this.stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: low ? 0.04 : 0.048, vertexColors: true, transparent: true, opacity: 0.8 }));
    this.scene.add(this.stars);

    this.singularity = new THREE.Group();
    this.scene.add(this.singularity);
    this.rollFrame = new THREE.Group();
    this.singularity.add(this.rollFrame);
    this.diskFrame = new THREE.Group();
    this.rollFrame.add(this.diskFrame);

    /* The horizon: opaque, drawn first, so the near disc crosses in front of it and the lensed far side stays behind. */
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.22, low ? 64 : 112, low ? 40 : 72), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    core.renderOrder = 5;
    this.singularity.add(core);

    this.coronaMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 }, uK: { value: 1 }, uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() } },
      vertexShader: FRESNEL_VERTEX,
      fragmentShader: 'uniform float uT,uK;uniform vec3 uA,uB;varying vec3 N,W;void main(){vec3 V=normalize(cameraPosition-W);float rim=pow(1.-abs(dot(V,N)),3.7);float pulse=.95+.05*sin(uT*.7);gl_FragColor=vec4(mix(uA,uB,smoothstep(.2,.95,rim)),rim*.13*pulse*uK);}'
    });
    const corona = new THREE.Mesh(new THREE.SphereGeometry(1.31, low ? 64 : 96, low ? 40 : 64), this.coronaMaterial);
    corona.renderOrder = 6;
    this.singularity.add(corona);

    this.shells = [[1.245, 0.18], [1.285, 0.075]].map(([radius, opacity]) => {
      const material = new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
        uniforms: { uT: { value: 0 }, uColor: { value: new THREE.Color() }, uOp: { value: opacity } },
        vertexShader: FRESNEL_VERTEX,
        fragmentShader: 'uniform float uT,uOp;uniform vec3 uColor;varying vec3 N,W;void main(){vec3 V=normalize(cameraPosition-W);float f=pow(1.-abs(dot(V,N)),6.2);float p=.94+.06*sin(uT*1.2);gl_FragColor=vec4(uColor*(.7+f*1.4),f*uOp*p);}'
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 48), material);
      mesh.renderOrder = 6;
      this.singularity.add(mesh);
      return mesh;
    });

    const disk = (inner, outer, opacity, phase, layer, side = THREE.DoubleSide) => {
      const material = new THREE.ShaderMaterial({
        transparent: true, side, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
        uniforms: {
          t: { value: 0 }, opacity: { value: opacity }, phase: { value: phase }, layer: { value: layer }, uInner: { value: inner }, uOuter: { value: outer },
          c0: { value: new THREE.Vector3() }, c1: { value: new THREE.Vector3() }, c2: { value: new THREE.Vector3() }, c3: { value: new THREE.Vector3() }, c4: { value: new THREE.Vector3() }
        },
        vertexShader: PLASMA_VERTEX, fragmentShader: PLASMA_FRAGMENT
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, low ? 260 : 480, 16), material);
      mesh.renderOrder = side === THREE.BackSide ? 2 : 7;
      mesh.userData.opacity = opacity;
      return mesh;
    };
    /* The far side, lensed over the horizon: the same plasma, compressed and lifted. */
    this.lensFrame = new THREE.Group();
    this.diskFrame.add(this.lensFrame);
    this.farDisks = [disk(1.34, 6.25, 0.34, 0, 0, THREE.BackSide), disk(1.4, 5.65, 0.2, 2.1, 1, THREE.BackSide), disk(1.5, 6.75, 0.1, 4.2, 2, THREE.BackSide)];
    for (const mesh of this.farDisks) { mesh.scale.y = 0.28; mesh.position.y = 0.39; this.lensFrame.add(mesh); }
    this.directFrame = new THREE.Group();
    this.diskFrame.add(this.directFrame);
    this.disks = [disk(1.34, 6.25, 0.92, 0, 0), disk(1.39, 5.55, 0.56, 2.1, 1), disk(1.46, 6.8, 0.26, 4.2, 2), disk(1.55, 4.7, 0.18, 5.4, 3)];
    for (const mesh of this.disks) this.directFrame.add(mesh);

    const motes = low ? 3200 : 9000;
    const attribute = () => new Float32Array(motes);
    const aR = attribute(); const aA = attribute(); const aH = attribute(); const aV = attribute();
    for (let i = 0; i < motes; i++) {
      aR[i] = 1.48 + Math.random() * 6.92;
      aA[i] = Math.random() * Math.PI * 2;
      aH[i] = Math.random() * 2 - 1;
      aV[i] = 0.9 + Math.random() * 0.2;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(motes * 3), 3));
    dustGeometry.setAttribute('aR', new THREE.BufferAttribute(aR, 1));
    dustGeometry.setAttribute('aA', new THREE.BufferAttribute(aA, 1));
    dustGeometry.setAttribute('aH', new THREE.BufferAttribute(aH, 1));
    dustGeometry.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
    this.dustMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 }, uSize: { value: low ? 2.2 : 2.6 }, uScale: { value: 1 }, uColor: { value: new THREE.Color() }, uOpacity: { value: 0.42 } },
      vertexShader: DUST_VERTEX, fragmentShader: DUST_FRAGMENT
    });
    const dust = new THREE.Points(dustGeometry, this.dustMaterial);
    dust.frustumCulled = false;
    dust.renderOrder = 9;
    this.diskFrame.add(dust);

    this.diskFrame.rotation.x = low ? 1.49 : 1.46;
    this.rollFrame.rotation.z = -20 * RAD;
  }

  paint() {
    if (this._failed) return;
    const palette = PALETTE[this.getAttribute('design') === 'obsidian' ? 'obsidian' : 'nebula'];
    for (const mesh of [...this.disks, ...this.farDisks]) {
      palette.plasma.forEach((rgb, index) => mesh.material.uniforms[`c${index}`].value.set(...rgb));
    }
    this.shells.forEach((mesh, index) => mesh.material.uniforms.uColor.value.setHex(palette.rim[index]));
    this.coronaMaterial.uniforms.uA.value.set(...palette.corona[0]);
    this.coronaMaterial.uniforms.uB.value.set(...palette.corona[1]);
    this.dustMaterial.uniforms.uColor.value.setHex(palette.dust);
    if (!this._raf) this.render(0);
  }

  resize() {
    if (this._failed) return;
    const width = this.clientWidth || 320;
    const height = this.clientHeight || 320;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.low ? 1.5 : 1.8));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.dustMaterial.uniforms.uScale.value = height * this.renderer.getPixelRatio() / 220;
    if (!this._raf) this.render(0);
  }

  /*
   * The shot, from the section's progress, as four keyframes.
   *
   * H, the horizon: a long lens (20 degrees) from far back, looking straight
   * ahead, with the hole scaled and lowered until its upper limb is the
   * page's arc -- the apex where the page puts it and, near the apex, the
   * same curvature. The angles are solved, not tuned: the limb's highest
   * point is the centre's elevation plus the hole's angular radius, so
   * placing the centre at (apex angle - radius angle) puts the apex exactly.
   * Only the rim and the corona show here; the disc, dust and stars come up
   * with the pull-back.
   *
   * A, M and B are the composed shots: the disc broad across the screen,
   * approaching, then near edge-on and centred at the gate. Each segment eases
   * in and out, so the camera reads as moving rather than a card rotating.
   */
  horizonShot(A) {
    const width = this.clientWidth || 320;
    const height = this.clientHeight || 320;
    const arc = this._horizon || { top: height * 0.2, radius: Math.max(width * 0.78, height * 0.9) };
    const fov = 20;
    const tanHalf = Math.tan((fov / 2) * RAD);
    const distance = 30;
    const apex = Math.atan((1 - (2 * arc.top) / height) * tanHalf);
    const radius = Math.atan(((2 * arc.radius) / height) * tanHalf);
    const centre = distance * Math.tan(apex - radius);
    const span = Math.hypot(distance, centre) * Math.sin(radius);
    return { fov, cy: 0, cz: distance, x: 0, y: centre, s: span / 1.22, rx: A.rx, rz: A.rz };
  }

  shot(progress) {
    const portrait = this.camera.aspect < 0.78;
    const fov = this.low ? 58 : 50;
    const cy = this.low ? 1.1 : 1.7;
    /*
     * The hole settles below the middle of the frame and the disc banks
     * toward the reader -- opening from near edge-on to a broad ellipse --
     * rather than rolling across the screen, so its band stays under the
     * title that sits over the horizon and passes behind the systems' plates.
     */
    const A = portrait ? { fov, cy, x: 0, y: -0.7, s: 0.74, rx: 1.47, rz: -14 * RAD, cz: 10.65 } : { fov, cy, x: 0, y: -1.1, s: 0.8, rx: 1.46, rz: -14 * RAD, cz: 11.25 };
    const M = portrait ? { fov, cy, x: 0, y: -0.74, s: 0.86, rx: 1.36, rz: -10 * RAD, cz: 10.05 } : { fov, cy, x: 0, y: -1.16, s: 0.92, rx: 1.35, rz: -10 * RAD, cz: 10.55 };
    const B = portrait ? { fov, cy, x: 0, y: -0.72, s: 0.95, rx: 1.22, rz: -7 * RAD, cz: 9.62 } : { fov, cy, x: 0, y: -1.3, s: 1, rx: 1.26, rz: -7 * RAD, cz: 10.02 };
    const H = this.horizonShot(A);
    const p = clamp01(progress);
    const stops = [[0, H], [0.12, H], [0.42, A], [0.7, M], [1, B]];
    let index = 1;
    while (index < stops.length - 1 && p > stops[index][0]) index += 1;
    const [p0, from] = stops[index - 1];
    const [p1, to] = stops[index];
    const k = smooth(p1 > p0 ? (p - p0) / (p1 - p0) : 1);
    /*
     * Leaving the horizon, size and distance move on a log scale: the hole
     * shrinks from filling the screen to a fraction of it, and a linear blend
     * would spend most of the move on the first few percent.
     */
    const log = (a, b) => Math.exp(lerp(Math.log(a), Math.log(b), k));
    const out = {};
    for (const key of Object.keys(A)) out[key] = from === H && (key === 's' || key === 'cz') ? log(from[key], to[key]) : lerp(from[key], to[key], k);
    /* How much of the scene beyond the rim is lit: none at the horizon, all once the hole has settled. */
    out.reveal = smooth((p - 0.14) / 0.26);
    return out;
  }

  motionSuppressed() {
    return document.documentElement.dataset.motion === 'off' ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  start() {
    if (this._failed || this._raf || document.hidden) return;
    this._still = this.motionSuppressed();
    if (!this._motionObserver) {
      /* The switch can be thrown with the scene on screen: stand down, or start again, without tearing anything down. */
      this._motionObserver = new MutationObserver(() => {
        this._still = document.documentElement.dataset.motion === 'off' ||
          !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (this._still) { this.stop(); this.render(0); } else if (this._visible) this.start();
      });
      this._motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    }
    if (this._still) { this.render(0); return; }
    this._clock = this._clock || new THREE.Clock();
    let last = 0;
    const loop = now => {
      this._raf = requestAnimationFrame(loop);
      if (now - last < 15) return;
      const dt = Math.min(this._clock.getDelta(), 0.033);
      last = now;
      this.render(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  render(dt) {
    if (this._failed || !this.renderer) return;
    const still = this._still || dt === 0 && !this._raf;
    const t = still ? 8 : (this._clock ? this._clock.elapsedTime : 0);
    /*
     * The shown progress eases toward the page's. A phone reports its scroll
     * in steps, and the shot is steep near the horizon, so following the raw
     * value made the pull-back judder; a held frame (motion off, or no loop
     * running) takes the value as it is.
     */
    if (still || this._shown == null) this._shown = this._progress;
    else this._shown += (this._progress - this._shown) * (1 - Math.exp(-6.5 * dt));
    const shot = this.shot(this._shown);
    if (Math.abs(this.camera.fov - shot.fov) > 1e-4) {
      this.camera.fov = shot.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(0, shot.cy, shot.cz);
    this.camera.lookAt(0, 0, 0);
    this.singularity.position.set(shot.x, shot.y, 0);
    this.singularity.scale.setScalar(shot.s);
    this.diskFrame.rotation.x = shot.rx;
    this.rollFrame.rotation.z = shot.rz;
    if (!still && this._orbit) {
      this._orbit.x += (this._pointer.x * 0.5 - this._orbit.x) * 0.02;
      this._orbit.y += (-this._pointer.y * 0.3 - this._orbit.y) * 0.02;
    }
    /* The pointer leans the frame only once there is a frame to lean: at the horizon the arc holds still. */
    const lean = this._orbit ? shot.reveal : 0;
    this.scene.rotation.y = this._orbit ? this._orbit.x * 0.035 * lean : 0;
    this.scene.rotation.x = this._orbit ? this._orbit.y * 0.02 * lean : 0;
    for (const mesh of this.disks) mesh.material.uniforms.opacity.value = mesh.userData.opacity * shot.reveal;
    for (const mesh of this.farDisks) mesh.material.uniforms.opacity.value = mesh.userData.opacity * shot.reveal;
    this.dustMaterial.uniforms.uOpacity.value = 0.42 * shot.reveal;
    this.stars.material.opacity = 0.8 * shot.reveal;
    /* On paper the corona's dusk reads as a grey band over the page, so there the rim alone draws the arc until the night is in. */
    this.coronaMaterial.uniforms.uK.value = this.getAttribute('theme') === 'light' ? shot.reveal : 1;
    for (const mesh of this.disks) mesh.material.uniforms.t.value = t;
    for (const mesh of this.farDisks) mesh.material.uniforms.t.value = t;
    for (const mesh of this.shells) mesh.material.uniforms.uT.value = t;
    this.coronaMaterial.uniforms.uT.value = t;
    this.dustMaterial.uniforms.uT.value = t;
    this.stars.rotation.y = t * 0.0025;
    this.renderer.render(this.scene, this.camera);
  }
}

if (!customElements.get('nebula-singularity')) customElements.define('nebula-singularity', NebulaSingularity);

export { NebulaSingularity };
