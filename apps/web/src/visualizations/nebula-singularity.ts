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
 * three.js is imported by its package name; the build makes it a chunk of
 * its own, reached only through this piece and the galaxy (nebula-galaxy.ts).
 */
import * as THREE from 'three';

import { motionHeld, watchMotion } from './artwork.ts';
import type { ArtworkPiece, ArtworkReading } from './artwork.ts';

/*
 * The plasma's five temperatures, coolest to hottest, and the colours of the
 * horizon's rim, its haze and its dust. Nebula burns in the product's violets
 * and magentas; Obsidian in white, silver and graphite. The section is a
 * night sky in either theme, so there is no light palette.
 */
type Rgb = readonly [number, number, number];
interface Palette {
  /* The plasma's five temperatures, coolest to hottest. */
  readonly plasma: readonly [Rgb, Rgb, Rgb, Rgb, Rgb];
  readonly rim: readonly [number, number];
  readonly corona: readonly [Rgb, Rgb];
  readonly dust: number;
}
const PALETTE: Readonly<Record<'nebula' | 'obsidian', Palette>> = Object.freeze({
  nebula: {
    plasma: [[0.07, 0.05, 0.16], [0.30, 0.14, 0.62], [1.25, 0.86, 1.6], [1.3, 0.26, 1.08], [0.72, 0.05, 0.44]],
    rim: [0xd8b4fe, 0x8b5cf6], corona: [[0.03, 0.03, 0.12], [0.26, 0.07, 0.36]], dust: 0xe9d5ff
  },
  obsidian: {
    plasma: [[0.07, 0.07, 0.08], [0.22, 0.23, 0.25], [1.3, 1.28, 1.24], [0.86, 0.87, 0.9], [0.44, 0.45, 0.5]],
    rim: [0xf5f5f4, 0xa8a29e], corona: [[0.03, 0.03, 0.035], [0.2, 0.2, 0.22]], dust: 0xe7e5e4
  }
});

/* The horizon's radius in scene units; the shot that frames the page's arc solves against it. */
const CORE_RADIUS = 1.22;
/*
 * The rim's normal in world space, the space its view ray is in: a normal in
 * view space (normalMatrix) only agrees with cameraPosition - W while the
 * camera looks straight ahead, and once the shot tilts down onto the disc the
 * rim lit unevenly, bright under the hole and faint over it.
 */
const FRESNEL_VERTEX = 'varying vec3 N,W;void main(){N=normalize(mat3(modelMatrix)*normal);vec4 wp=modelMatrix*vec4(position,1.);W=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}';

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

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const smooth = (value: number): number => { const v = clamp01(value); return v * v * (3 - 2 * v); };
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const RAD = Math.PI / 180;
/* A held frame shows the plasma at this moment of its orbit. */
const STILL_TIME = 8;

/* Where the page draws its arc, in the element's pixels. */
export interface Horizon { readonly top: number; readonly radius: number }

/* A camera position and the hole's place, scale and tilt in it. */
interface Shot {
  readonly fov: number; readonly cy: number; readonly cz: number;
  readonly x: number; readonly y: number; readonly s: number;
  readonly rx: number; readonly rz: number;
}

/* One band of plasma: its mesh, the opacity it is drawn at, and the uniforms it is painted and turned through. */
interface Plasma {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  readonly opacity: number;
  readonly time: THREE.IUniform<number>;
  readonly shown: THREE.IUniform<number>;
  readonly colours: readonly THREE.Vector3[];
}

/* A glow just outside the horizon. */
interface Shell {
  readonly time: THREE.IUniform<number>;
  readonly colour: THREE.Color;
}

/* What a connected singularity draws with. */
interface Scene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  readonly singularity: THREE.Group;
  readonly rollFrame: THREE.Group;
  readonly diskFrame: THREE.Group;
  readonly disks: readonly Plasma[];
  readonly farDisks: readonly Plasma[];
  readonly shells: readonly Shell[];
  readonly corona: {
    readonly time: THREE.IUniform<number>; readonly k: THREE.IUniform<number>;
    readonly inner: THREE.Vector3; readonly outer: THREE.Vector3;
  };
  readonly dust: {
    readonly time: THREE.IUniform<number>; readonly scale: THREE.IUniform<number>;
    readonly opacity: THREE.IUniform<number>; readonly colour: THREE.Color;
  };
}

/* The scene itself: the stars, the horizon and its glows, the plasma near and lensed, and the dust. */
function build(renderer: THREE.WebGLRenderer, low: boolean): Scene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(low ? 58 : 50, 1, 0.1, 100);
  camera.position.set(0, low ? 1.1 : 1.7, low ? 9.4 : 10.7);
  scene.fog = new THREE.FogExp2(0x000006, 0.017);

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
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: low ? 0.04 : 0.048, vertexColors: true, transparent: true, opacity: 0.8 }));
  scene.add(stars);

  const singularity = new THREE.Group();
  scene.add(singularity);
  const rollFrame = new THREE.Group();
  singularity.add(rollFrame);
  const diskFrame = new THREE.Group();
  rollFrame.add(diskFrame);

  /* The horizon: opaque, drawn first, so the near disc crosses in front of it and the lensed far side stays behind. */
  const core = new THREE.Mesh(new THREE.SphereGeometry(CORE_RADIUS, low ? 64 : 112, low ? 40 : 72), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  core.renderOrder = 5;
  singularity.add(core);

  /*
   * The light around the horizon is brightest at the horizon and fades
   * outward, the way a glow does. Each glow is the back of a sphere a little
   * larger than the hole; seen from outside, the back faces that clear the
   * hole run from the hole's limb (where |V.N| is the limb value below) out
   * to the sphere's own silhouette (where it is 0). Weighting by that ratio
   * puts the light on the limb and none at the silhouette. A rim weighted
   * the other way -- brightest at its own silhouette -- drew every sphere as
   * its own hard ring, and with the hole filling the screen at the horizon
   * that read as three arcs stacked over one another instead of one edge.
   */
  const limb = (radius: number): number => Math.sqrt(1 - (CORE_RADIUS / radius) ** 2);
  const corona = {
    time: { value: 0 }, k: { value: 1 }, inner: new THREE.Vector3(), outer: new THREE.Vector3()
  };
  const coronaMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    uniforms: { uT: corona.time, uK: corona.k, uC: { value: limb(1.31) }, uA: { value: corona.inner }, uB: { value: corona.outer } },
    vertexShader: FRESNEL_VERTEX,
    fragmentShader: 'uniform float uT,uK,uC;uniform vec3 uA,uB;varying vec3 N,W;void main(){vec3 V=normalize(cameraPosition-W);float x=clamp(abs(dot(V,N))/uC,0.,1.);float rim=x*x;float pulse=.95+.05*sin(uT*.7);gl_FragColor=vec4(mix(uA,uB,smoothstep(.2,.95,rim)),rim*.13*pulse*uK);}'
  });
  const coronaMesh = new THREE.Mesh(new THREE.SphereGeometry(1.31, low ? 64 : 96, low ? 40 : 64), coronaMaterial);
  coronaMesh.renderOrder = 6;
  singularity.add(coronaMesh);

  const shells = ([[1.245, 0.18], [1.285, 0.075]] as const).map(([radius, opacity]): Shell => {
    const shell = { time: { value: 0 }, colour: new THREE.Color() };
    const material = new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { uT: shell.time, uColor: { value: shell.colour }, uOp: { value: opacity }, uC: { value: limb(radius) } },
      vertexShader: FRESNEL_VERTEX,
      fragmentShader: 'uniform float uT,uOp,uC;uniform vec3 uColor;varying vec3 N,W;void main(){vec3 V=normalize(cameraPosition-W);float x=clamp(abs(dot(V,N))/uC,0.,1.);float f=x*x*x*x;float p=.94+.06*sin(uT*1.2);gl_FragColor=vec4(uColor*(.7+f*1.4),f*uOp*p);}'
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 48), material);
    mesh.renderOrder = 6;
    singularity.add(mesh);
    return shell;
  });

  const disk = (inner: number, outer: number, opacity: number, phase: number, layer: number, side: THREE.Side = THREE.DoubleSide): Plasma => {
    const plasma = {
      time: { value: 0 }, shown: { value: opacity },
      colours: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    };
    const material = new THREE.ShaderMaterial({
      transparent: true, side, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
      uniforms: {
        t: plasma.time, opacity: plasma.shown, phase: { value: phase }, layer: { value: layer }, uInner: { value: inner }, uOuter: { value: outer },
        ...Object.fromEntries(plasma.colours.map((colour, index) => [`c${index}`, { value: colour }]))
      },
      vertexShader: PLASMA_VERTEX, fragmentShader: PLASMA_FRAGMENT
    });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, low ? 260 : 480, 16), material);
    mesh.renderOrder = side === THREE.BackSide ? 2 : 7;
    return { mesh, opacity, ...plasma };
  };
  /* The far side, lensed over the horizon: the same plasma, compressed and lifted. */
  const lensFrame = new THREE.Group();
  diskFrame.add(lensFrame);
  const farDisks = [disk(1.34, 6.25, 0.34, 0, 0, THREE.BackSide), disk(1.4, 5.65, 0.2, 2.1, 1, THREE.BackSide), disk(1.5, 6.75, 0.1, 4.2, 2, THREE.BackSide)];
  for (const { mesh } of farDisks) { mesh.scale.y = 0.28; mesh.position.y = 0.39; lensFrame.add(mesh); }
  const directFrame = new THREE.Group();
  diskFrame.add(directFrame);
  const disks = [disk(1.34, 6.25, 0.92, 0, 0), disk(1.39, 5.55, 0.56, 2.1, 1), disk(1.46, 6.8, 0.26, 4.2, 2), disk(1.55, 4.7, 0.18, 5.4, 3)];
  for (const { mesh } of disks) directFrame.add(mesh);

  const motes = low ? 3200 : 9000;
  const attribute = (): Float32Array => new Float32Array(motes);
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
  const dust = { time: { value: 0 }, scale: { value: 1 }, opacity: { value: 0.42 }, colour: new THREE.Color() };
  const dustMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uT: dust.time, uSize: { value: low ? 2.2 : 2.6 }, uScale: dust.scale, uColor: { value: dust.colour }, uOpacity: dust.opacity },
    vertexShader: DUST_VERTEX, fragmentShader: DUST_FRAGMENT
  });
  const dustPoints = new THREE.Points(dustGeometry, dustMaterial);
  dustPoints.frustumCulled = false;
  dustPoints.renderOrder = 9;
  diskFrame.add(dustPoints);

  diskFrame.rotation.x = low ? 1.49 : 1.46;
  rollFrame.rotation.z = -20 * RAD;
  return { renderer, scene, camera, stars, singularity, rollFrame, diskFrame, disks, farDisks, shells, corona, dust };
}

export class NebulaSingularity extends HTMLElement implements ArtworkPiece {
  static get observedAttributes(): string[] { return ['design', 'density', 'theme']; }

  #progress = 0;
  #horizon: Horizon | null = null;
  #built = false;
  #failed = false;
  #low = false;
  #drawing: Scene | null = null;
  #frame = 0;
  #frames = 0;
  #held = false;
  #visible = true;
  #clock: THREE.Clock | null = null;
  #shown: number | null = null;
  readonly #pointer = { x: 0, y: 0 };
  readonly #orbit = { x: 0, y: 0 };
  #resizes: ResizeObserver | null = null;
  #sightings: IntersectionObserver | null = null;
  #unwatchMotion: (() => void) | null = null;
  readonly #onPointer = (event: PointerEvent): void => {
    this.#pointer.x = (event.clientX / window.innerWidth - 0.5) * 2;
    this.#pointer.y = (event.clientY / window.innerHeight - 0.5) * 2;
  };
  readonly #onVisibility = (): void => {
    if (document.hidden) this.stop();
    else if (this.#visible) this.start();
  };

  get reading(): ArtworkReading {
    return { tag: 'nebula-singularity', held: this.#held, running: this.#frame !== 0, frames: this.#frames, failed: this.#failed };
  }

  /* How far the reader has scrolled through the section, from 0 to 1. */
  get progress(): number { return this.#progress; }
  set progress(value: number) {
    const next = clamp01(Number(value) || 0);
    if (next === this.#progress) return;
    this.#progress = next;
    if (this.#built && !this.#frame) this.render(0);
  }

  /* Where the page draws its arc, in this element's pixels: { top, radius }. */
  get horizon(): Horizon | null { return this.#horizon; }
  set horizon(value: Horizon | null) {
    const top = Number(value?.top);
    const radius = Number(value?.radius);
    this.#horizon = Number.isFinite(top) && Number.isFinite(radius) && radius > 0 ? { top, radius } : null;
    if (this.#built && !this.#frame) this.render(0);
  }

  connectedCallback(): void {
    if (this.#built) return;
    this.#built = true;
    this.style.display = this.style.display || 'block';
    if (!this.style.width) this.style.width = '100%';
    if (!this.style.height) this.style.height = '100%';
    /* Decoration: announced to nobody, reachable by nothing. */
    this.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    this.appendChild(canvas);
    this.#low = this.getAttribute('density') === 'low';
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.#low, alpha: true, powerPreference: 'high-performance' });
    } catch {
      canvas.remove();
      this.#failed = true;
      return;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000000, 0);
    this.#drawing = build(renderer, this.#low);
    this.#held = motionHeld(document, window);
    this.paint();
    this.resize();

    window.addEventListener('pointermove', this.#onPointer, { passive: true });
    this.#resizes = new ResizeObserver(() => this.resize());
    this.#resizes.observe(this);
    this.#visible = true;
    this.#sightings = new IntersectionObserver(entries => {
      this.#visible = entries.some(entry => entry.isIntersecting);
      if (this.#visible) this.start(); else this.stop();
    }, { rootMargin: '200px', threshold: 0 });
    this.#sightings.observe(this);
    document.addEventListener('visibilitychange', this.#onVisibility);
    /* The setting can change with the scene on screen: stand down, or start again, without tearing anything down. */
    this.#unwatchMotion = watchMotion(document, window, () => {
      const held = motionHeld(document, window);
      if (held === this.#held) return;
      this.#held = held;
      if (held) { this.stop(); this.render(0); } else if (this.#visible && !document.hidden) this.start();
    });
    this.start();
  }

  disconnectedCallback(): void {
    this.stop();
    this.#resizes?.disconnect();
    this.#sightings?.disconnect();
    this.#unwatchMotion?.();
    window.removeEventListener('pointermove', this.#onPointer);
    document.removeEventListener('visibilitychange', this.#onVisibility);
  }

  attributeChangedCallback(name: string, before: string | null, after: string | null): void {
    if (!this.#built || this.#failed || before === after) return;
    if (name === 'design') this.paint();
    else if (name === 'theme' && !this.#frame) this.render(0);
  }

  paint(): void {
    const drawing = this.#drawing;
    if (!drawing) return;
    const palette = PALETTE[this.getAttribute('design') === 'obsidian' ? 'obsidian' : 'nebula'];
    for (const plasma of [...drawing.disks, ...drawing.farDisks]) {
      palette.plasma.forEach((rgb, index) => plasma.colours[index]?.set(...rgb));
    }
    drawing.shells.forEach((shell, index) => shell.colour.setHex(palette.rim[index] ?? palette.rim[0]));
    drawing.corona.inner.set(...palette.corona[0]);
    drawing.corona.outer.set(...palette.corona[1]);
    drawing.dust.colour.setHex(palette.dust);
    if (!this.#frame) this.render(0);
  }

  resize(): void {
    const drawing = this.#drawing;
    if (!drawing) return;
    const width = this.clientWidth || 320;
    const height = this.clientHeight || 320;
    drawing.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.#low ? 1.5 : 1.8));
    drawing.renderer.setSize(width, height, false);
    drawing.camera.aspect = width / Math.max(height, 1);
    drawing.camera.updateProjectionMatrix();
    drawing.dust.scale.value = height * drawing.renderer.getPixelRatio() / 220;
    if (!this.#frame) this.render(0);
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
  horizonShot(A: Shot): Shot {
    const width = this.clientWidth || 320;
    const height = this.clientHeight || 320;
    const arc = this.#horizon ?? { top: Math.min(130, Math.max(84, height * 0.1)), radius: Math.max(width * 0.78, height * 0.92) };
    const fov = 20;
    const tanHalf = Math.tan((fov / 2) * RAD);
    const distance = 30;
    const apex = Math.atan((1 - (2 * arc.top) / height) * tanHalf);
    const radius = Math.atan(((2 * arc.radius) / height) * tanHalf);
    const centre = distance * Math.tan(apex - radius);
    const span = Math.hypot(distance, centre) * Math.sin(radius);
    return { fov, cy: 0, cz: distance, x: 0, y: centre, s: span / CORE_RADIUS, rx: A.rx, rz: A.rz };
  }

  shot(progress: number, camera: THREE.PerspectiveCamera): Shot & { readonly reveal: number } {
    const portrait = camera.aspect < 0.78;
    const fov = this.#low ? 58 : 50;
    const cy = this.#low ? 1.1 : 1.7;
    /*
     * The hole settles below the middle of the frame and the disc banks
     * toward the reader -- opening from near edge-on to a broad ellipse --
     * rather than rolling across the screen, so its band stays under the
     * title that sits over the horizon and passes behind the systems' plates.
     */
    const A: Shot = portrait ? { fov, cy, x: 0, y: -0.7, s: 0.74, rx: 1.47, rz: -14 * RAD, cz: 10.65 } : { fov, cy, x: 0, y: -1.1, s: 0.8, rx: 1.46, rz: -14 * RAD, cz: 11.25 };
    const M: Shot = portrait ? { fov, cy, x: 0, y: -0.74, s: 0.86, rx: 1.36, rz: -10 * RAD, cz: 10.05 } : { fov, cy, x: 0, y: -1.16, s: 0.92, rx: 1.35, rz: -10 * RAD, cz: 10.55 };
    const B: Shot = portrait ? { fov, cy, x: 0, y: -0.72, s: 0.95, rx: 1.22, rz: -7 * RAD, cz: 9.62 } : { fov, cy, x: 0, y: -1.3, s: 1, rx: 1.26, rz: -7 * RAD, cz: 10.02 };
    const H = this.horizonShot(A);
    const p = clamp01(progress);
    const stops: ReadonlyArray<readonly [number, Shot]> = [[0, H], [0.12, H], [0.42, A], [0.7, M], [1, B]];
    let index = 1;
    while (index < stops.length - 1 && p > (stops[index]?.[0] ?? 1)) index += 1;
    const [p0, from] = stops[index - 1] ?? stops[0] ?? [0, H];
    const [p1, to] = stops[index] ?? [1, B];
    const k = smooth(p1 > p0 ? (p - p0) / (p1 - p0) : 1);
    /*
     * Leaving the horizon, size and distance move on a log scale: the hole
     * shrinks from filling the screen to a fraction of it, and a linear blend
     * would spend most of the move on the first few percent.
     */
    const log = (a: number, b: number): number => Math.exp(lerp(Math.log(a), Math.log(b), k));
    const blend = (key: keyof Shot): number => (from === H && (key === 's' || key === 'cz') ? log(from[key], to[key]) : lerp(from[key], to[key], k));
    return {
      fov: blend('fov'), cy: blend('cy'), cz: blend('cz'), x: blend('x'), y: blend('y'), s: blend('s'), rx: blend('rx'), rz: blend('rz'),
      /* How much of the scene beyond the rim is lit: none at the horizon, all once the hole has settled. */
      reveal: smooth((p - 0.14) / 0.26)
    };
  }

  /* Moves the scene while it is on screen, on a visible tab, and the reader's setting lets it move. */
  start(): void {
    if (!this.#drawing || this.#frame || document.hidden) return;
    if (this.#held) { this.render(0); return; }
    const clock = this.#clock ?? new THREE.Clock();
    this.#clock = clock;
    let last = 0;
    const loop = (now: number): void => {
      this.#frame = requestAnimationFrame(loop);
      if (now - last < 15) return;
      const dt = Math.min(clock.getDelta(), 0.033);
      last = now;
      this.render(dt);
    };
    this.#frame = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  render(dt: number): void {
    const drawing = this.#drawing;
    if (!drawing) return;
    const still = this.#held || (dt === 0 && !this.#frame);
    const t = still ? STILL_TIME : (this.#clock ? this.#clock.elapsedTime : 0);
    /*
     * The shown progress eases toward the page's. A phone reports its scroll
     * in steps, and the shot is steep near the horizon, so following the raw
     * value made the pull-back judder; a held frame (motion off, or no loop
     * running) takes the value as it is.
     */
    if (still || this.#shown === null) this.#shown = this.#progress;
    else this.#shown += (this.#progress - this.#shown) * (1 - Math.exp(-6.5 * dt));
    const { camera } = drawing;
    const shot = this.shot(this.#shown, camera);
    if (Math.abs(camera.fov - shot.fov) > 1e-4) {
      camera.fov = shot.fov;
      camera.updateProjectionMatrix();
    }
    camera.position.set(0, shot.cy, shot.cz);
    camera.lookAt(0, 0, 0);
    drawing.singularity.position.set(shot.x, shot.y, 0);
    drawing.singularity.scale.setScalar(shot.s);
    drawing.diskFrame.rotation.x = shot.rx;
    drawing.rollFrame.rotation.z = shot.rz;
    if (!still) {
      this.#orbit.x += (this.#pointer.x * 0.5 - this.#orbit.x) * 0.02;
      this.#orbit.y += (-this.#pointer.y * 0.3 - this.#orbit.y) * 0.02;
    }
    /* The pointer leans the frame only once there is a frame to lean: at the horizon the arc holds still. */
    const lean = shot.reveal;
    drawing.scene.rotation.y = this.#orbit.x * 0.035 * lean;
    drawing.scene.rotation.x = this.#orbit.y * 0.02 * lean;
    for (const plasma of [...drawing.disks, ...drawing.farDisks]) {
      plasma.shown.value = plasma.opacity * shot.reveal;
      plasma.time.value = t;
    }
    drawing.dust.opacity.value = 0.42 * shot.reveal;
    drawing.stars.material.opacity = 0.8 * shot.reveal;
    /* On paper the corona's dusk reads as a grey band over the page, so there the rim alone draws the arc until the night is in. */
    drawing.corona.k.value = this.getAttribute('theme') === 'light' ? shot.reveal : 1;
    for (const shell of drawing.shells) shell.time.value = t;
    drawing.corona.time.value = t;
    drawing.dust.time.value = t;
    drawing.stars.rotation.y = t * 0.0025;
    drawing.renderer.render(drawing.scene, drawing.camera);
    this.#frames += 1;
  }
}

if (!customElements.get('nebula-singularity')) customElements.define('nebula-singularity', NebulaSingularity);
