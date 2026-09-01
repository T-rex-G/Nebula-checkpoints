/*
 * <nebula-mark-3d> -- the reference's folded faceted mark.
 *
 * The geometry, materials and orbital motion are the design's own. What is
 * added is what shipping needs: the element is decoration and is hidden from
 * assistive technology; a device that cannot give a WebGL context loses the
 * mark rather than the page; and a reader who has asked for reduced motion
 * gets a composed still frame instead of a spinning one.
 *
 * That last point is the reason this file exists rather than the original: the
 * design's component animates unconditionally. Honouring the preference by
 * removing the mark would answer "less motion" with "less product", so the
 * scene is built, advanced once to a settled pose, and then held.
 *
 * The absolute import path is deliberate -- see nebula-galaxy.js for why a
 * bare specifier would cost an inline-script exception in the policy.
 */
import * as THREE from '/vendor/three/0.185.1/three.module.min.js';

/* ------------------------------------------------------------------ *
 * Shared: renderer host with visibility-gated RAF + resize handling  *
 * ------------------------------------------------------------------ */
class GLHost extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.style.display = 'block';
    this.style.position = this.style.position || 'relative';
    /* Decoration: announced to nobody, reachable by nothing. */
    this.setAttribute('aria-hidden', 'true');
    if (!this.style.width) this.style.width = '100%';
    if (!this.style.height) this.style.height = '100%';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';
    this.appendChild(canvas);
    this.canvas = canvas;

    let r;
    try {
      r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    } catch {
      /* No context, no mark. The page around it is unaffected. */
      canvas.remove();
      this._failed = true;
      return;
    }
    r.setClearAlpha(0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;

    this.scene = new THREE.Scene();
    this._visible = true;
    this.build();
    this._resize();

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this);
    this._io = new IntersectionObserver(([e]) => { this._visible = e.isIntersecting; }, { threshold: 0 });
    this._io.observe(this);
    this._onVis = () => { if (!document.hidden) this._last = performance.now() / 1000; };
    document.addEventListener('visibilitychange', this._onVis);

    /*
     * Reduced motion is answered with a composed still, not an empty box: the
     * scene is advanced to a settled pose once and held there, so the mark is
     * present and lit without anything moving.
     */
    this._reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (this._reduced) {
      this.tick(6.2, 0);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      const now = performance.now() / 1000;
      if (!this._visible || document.hidden) { this._last = now; return; }
      const dt = Math.min(now - (this._last ?? now), 0.05);
      this._last = now;
      this._t = (this._t || 0) + dt;
      this.tick(this._t, dt);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    this._ro && this._ro.disconnect();
    this._io && this._io.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
    this.scene && this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    this._env && this._env.dispose();
    this.renderer && this.renderer.dispose();
    this._built = false;
  }

  _resize() {
    if (this._failed) return;
    const w = this.clientWidth || 320, h = this.clientHeight || 320;
    const cap = this._dprCap || (Math.min(w, h) > 320 ? 2 : 1.6);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.setSize(w, h, false);
    if (this.camera) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    this.onResize && this.onResize(w, h);
  }
}

/* ------------------------------------------------------------------ *
 * Procedural studio environment (no external HDR)                    *
 * ------------------------------------------------------------------ */
function bakeEnvironment(renderer, dark) {
  const scene = new THREE.Scene();
  const backdrop = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(dark ? 0x1a1140 : 0x6b5bd6) },
        bottom: { value: new THREE.Color(dark ? 0x05030c : 0x1b1440) }
      },
      vertexShader: 'varying float vY; void main(){ vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float vY; void main(){ gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.7, 0.9, vY)), 1.0); }'
    })
  );
  scene.add(backdrop);

  const panel = (hex, gain, pos, w, h, rx, ry) => {
    const c = new THREE.Color(hex).multiplyScalar(gain);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rx, ry, 0);
    scene.add(m);
    return m;
  };
  // key softbox, cool rim, warm kicker, floor bounce
  panel(0xffffff, 5.2, [-3.2, 3.4, 2.6], 5.5, 4.0, -0.35, 0.9);
  panel(0x7dd3fc, 3.4, [4.2, 1.2, 1.4], 4.2, 5.2, 0, -1.15);
  panel(0xf0abfc, 2.6, [1.4, -2.4, 3.2], 4.6, 2.4, 0.9, 0);
  panel(0xa78bfa, 1.8, [0, 0.4, -5.2], 7.0, 5.0, 0, 0);
  panel(0xffffff, dark ? 0.9 : 2.0, [0, -4.4, 0], 9, 9, -Math.PI / 2, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromScene(scene, 0.03);
  pmrem.dispose();
  backdrop.geometry.dispose(); backdrop.material.dispose();
  scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return rt;
}


function glyphTexture(kind, hex) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.translate(64, 64); x.scale(4.6, 4.6); x.translate(-12, -12);
  x.strokeStyle = hex; x.fillStyle = hex;
  x.lineWidth = 1.9; x.lineJoin = 'round'; x.lineCap = 'round';
  x.shadowColor = hex; x.shadowBlur = 3;
  if (kind === 'bolt') {
    x.beginPath();
    x.moveTo(13.6, 2); x.lineTo(6, 13.4); x.lineTo(11, 13.4); x.lineTo(9.6, 22);
    x.lineTo(17.4, 10.4); x.lineTo(12.4, 10.4); x.closePath(); x.fill();
  } else if (kind === 'shield') {
    x.beginPath();
    x.moveTo(12, 3); x.lineTo(19, 5.6); x.lineTo(19, 11.2);
    x.bezierCurveTo(19, 15.4, 16, 18.9, 12, 20);
    x.bezierCurveTo(8, 18.9, 5, 15.4, 5, 11.2);
    x.lineTo(5, 5.6); x.closePath(); x.stroke();
    x.beginPath(); x.moveTo(9, 12); x.lineTo(11.3, 14.3); x.lineTo(15, 10); x.stroke();
  } else {
    x.beginPath(); x.arc(12, 12, 8.4, 0, 6.2832); x.stroke();
    x.beginPath(); x.moveTo(8.4, 12); x.lineTo(11, 14.6); x.lineTo(15.6, 9.4); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ *
 * <nebula-mark-3d> — folded faceted N, glass face over polished metal *
 * ------------------------------------------------------------------ */
const S = 1 / 97;                       // svg units -> world
const P = (x, y) => new THREE.Vector2((x - 142) * S, -(y - 120) * S);

// left half: hinge A-C, plates (A,B,C) and (A,C,D); right half is the 180° twin
const HALVES = [
  { t1: [P(79, 25), P(40, 217), P(106, 116)], t2: [P(79, 25), P(106, 116), P(171, 112)], hinge: [P(79, 25), P(106, 116)] },
  { t1: [P(244, 23), P(178, 124), P(205, 215)], t2: [P(178, 124), P(113, 128), P(205, 215)], hinge: [P(178, 124), P(205, 215)] }
];

function plate(tri, depth) {
  const s = new THREE.Shape([tri[0].clone(), tri[1].clone(), tri[2].clone()]);
  const g = new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: true, bevelThickness: 0.013, bevelSize: 0.013, bevelSegments: 3, curveSegments: 1
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}


class NebulaMark3D extends GLHost {
  static get observedAttributes() { return ['theme']; }

  attributeChangedCallback(n, o, v) {
    if (n === 'theme' && this._built && o !== v) this.paintTheme();
  }

  paintTheme() {
    if (this._failed || !this.bubbles) return;
    const dark = (this.getAttribute('theme') || 'dark') !== 'light';
    this.bubbles.forEach((b) => {
      const m = b.glyphMesh.material;
      if (m.map) m.map.dispose();
      m.map = glyphTexture(b.glyph, dark ? b.ink : (b.inkLight || b.ink));
      m.needsUpdate = true;
    });
    if (this.ambient) this.ambient.intensity = dark ? 0.25 : 0.6;
  }

  build() {
    const dark = (this.getAttribute('theme') || 'dark') !== 'light';
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 60);
    this.camera.position.set(0, 0, 4.9);

    this._env = bakeEnvironment(this.renderer, dark);
    this.scene.environment = this._env.texture;

    this.root = new THREE.Group();
    this.root.scale.setScalar(0.82);
    this.scene.add(this.root);

    const glass = new THREE.MeshPhysicalMaterial({
      name: 'nebula-glass',
      color: 0xd8ccff, metalness: 0, roughness: 0.045,
      transmission: 1, thickness: 0.85, ior: 1.58,
      attenuationColor: new THREE.Color(0x7c3aed), attenuationDistance: 1.1,
      clearcoat: 1, clearcoatRoughness: 0.03,
      iridescence: 0.85, iridescenceIOR: 1.42, iridescenceThicknessRange: [120, 520],
      envMapIntensity: 1.5, transparent: true, opacity: 1, side: THREE.DoubleSide
    });
    const metal = new THREE.MeshPhysicalMaterial({
      name: 'nebula-metal',
      color: 0x8f7ce8, metalness: 1, roughness: 0.17,
      clearcoat: 0.6, clearcoatRoughness: 0.12,
      anisotropy: 0.5, anisotropyRotation: 0.6,
      envMapIntensity: 1.7
    });
    const chrome = new THREE.MeshPhysicalMaterial({
      name: 'nebula-orbit', color: 0xc9b8ff, metalness: 1, roughness: 0.12, envMapIntensity: 2.0
    });
    this._mats = { glass, metal, chrome };

    this.hinges = [];
    HALVES.forEach((half, i) => {
      const a = new THREE.Vector3(half.hinge[0].x, half.hinge[0].y, 0);
      const b = new THREE.Vector3(half.hinge[1].x, half.hinge[1].y, 0);
      const axis = b.clone().sub(a).normalize();
      const mid = a.clone().add(b).multiplyScalar(0.5);

      const fixed = new THREE.Mesh(plate(half.t1, 0.075), i === 0 ? metal : glass);
      fixed.name = i === 0 ? 'fold-left-back' : 'fold-right-front';
      this.root.add(fixed);

      const pivot = new THREE.Group();
      pivot.position.copy(mid);
      const moving = new THREE.Mesh(plate(half.t2, 0.075), i === 0 ? glass : metal);
      moving.name = i === 0 ? 'fold-left-front' : 'fold-right-back';
      moving.position.copy(mid.clone().negate());
      pivot.add(moving);
      this.root.add(pivot);
      this.hinges.push({ pivot, axis, phase: i * Math.PI });
    });

    // three free-floating glass bubbles (no rings, no orbit lines)
    this.bubbles = [];
    [
      { tint: 0xa78bfa, glyph: 'bolt',   ink: '#F5F3FF', inkLight: '#5B21B6', size: 0.152, R: 1.16, sp: 0.190, ph: 0.0, inc: 0.34, node: 0.30, bob: 0.05, ecc: 0.12 },
      { tint: 0x67e8f9, glyph: 'check',  ink: '#22D3EE', inkLight: '#0E7490', size: 0.132, R: 1.06, sp: -0.150, ph: 2.3, inc: 1.24, node: -0.95, bob: 0.06, ecc: 0.09 },
      { tint: 0xfbbf24, glyph: 'shield', ink: '#F59E0B', inkLight: '#B45309', size: 0.124, R: 1.25, sp: 0.124, ph: 4.4, inc: -0.86, node: 1.35, bob: 0.04, ecc: 0.06 }
    ].forEach((b, i) => {
      // NB: no transmission — the N's plates are transmissive, and three.js
      // resolves transmission in a separate pass that can't see other
      // transparent meshes, which made bubbles pop as they crossed the mark.
      const shell = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(b.tint).lerp(new THREE.Color(0xffffff), 0.42),
        transparent: true, opacity: 0.46, depthWrite: false,
        roughness: 0.03, metalness: 0,
        clearcoat: 1, clearcoatRoughness: 0.01,
        iridescence: 1, iridescenceIOR: 1.42, iridescenceThicknessRange: [140, 680],
        specularIntensity: 1.4, envMapIntensity: 3.4, side: THREE.FrontSide
      });
      const m = new THREE.Mesh(new THREE.SphereGeometry(b.size, 40, 28), shell);
      m.name = 'bubble-' + i;
      m.renderOrder = 10 + i;

      // inner rim highlight so the sphere reads as glass, not a flat disc
      const rim = new THREE.Mesh(
        new THREE.SphereGeometry(b.size * 1.045, 32, 22),
        new THREE.ShaderMaterial({
          uniforms: { uCol: { value: new THREE.Color(b.tint) } },
          vertexShader: 'varying float vF;void main(){vec3 n=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);vF=pow(1.0-abs(dot(n,normalize(-mv.xyz))),2.6);gl_Position=projectionMatrix*mv;}',
          fragmentShader: 'uniform vec3 uCol;varying float vF;void main(){gl_FragColor=vec4(uCol,vF*0.85);}',
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide
        })
      );
      rim.name = 'bubble-rim-' + i;
      m.add(rim);

      // the glyph that lives inside the bubble
      const g = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glyphTexture(b.glyph, dark ? b.ink : (b.inkLight || b.ink)),
        transparent: true, opacity: 0.95, depthWrite: false, depthTest: true
      }));
      g.scale.setScalar(b.size * 1.05);
      g.renderOrder = 20 + i;
      g.name = 'bubble-glyph-' + i;
      m.add(g);

      this.root.add(m);
      this.bubbles.push({ ...b, mesh: m, glyphMesh: g });
    });

    const key = new THREE.PointLight(0xffffff, 14, 12, 2); key.position.set(-2.2, 2.4, 3.0); this.scene.add(key);
    const rim = new THREE.PointLight(0x67e8f9, 9, 12, 2); rim.position.set(2.8, -1.4, 1.8); this.scene.add(rim);
    this.sweep = new THREE.PointLight(0xf5d0fe, 11, 10, 2); this.scene.add(this.sweep);
    this.ambient = new THREE.AmbientLight(0xffffff, dark ? 0.25 : 0.6);
    this.scene.add(this.ambient);
  }

  tick(t) {
    const ease = Math.sin(t * 0.24), ease2 = Math.sin(t * 0.17 + 1.1);
    this.root.rotation.y = ease * 0.30;
    this.root.rotation.x = ease2 * 0.13;
    this.root.rotation.z = Math.sin(t * 0.11) * 0.035;
    this.root.position.y = Math.sin(t * 0.33) * 0.035;

    const fold = 0.30 + Math.sin(t * 0.42) * 0.11;
    this.hinges.forEach(h => h.pivot.quaternion.setFromAxisAngle(h.axis, fold * Math.cos(h.phase * 0.5 + 0.0) * (h.phase ? -1 : 1)));

    this.bubbles.forEach((b) => {
      const a = t * b.sp * Math.PI * 2 * 0.16 + b.ph;
      // ellipse in the orbit plane -> incline about X -> swing the ascending node about Y
      const rx = b.R * (1 + b.ecc), rz = b.R * (1 - b.ecc);
      const x0 = Math.cos(a) * rx, z0 = Math.sin(a) * rz;
      const ci = Math.cos(b.inc), si = Math.sin(b.inc);
      const y1 = -z0 * si, z1 = z0 * ci;
      const node = b.node + t * 0.035;
      const cn = Math.cos(node), sn = Math.sin(node);
      const x2 = x0 * cn + z1 * sn, z2 = -x0 * sn + z1 * cn;
      b.mesh.position.set(x2, y1 + Math.sin(t * 0.5 + b.ph) * b.bob, z2);
      const depth = 1 + z2 * 0.10;
      b.mesh.scale.setScalar(depth + Math.sin(t * 0.8 + b.ph) * 0.02);
      b.mesh.rotation.y = a * 0.55;
      b.mesh.rotation.x = Math.sin(a * 0.4) * 0.3;
      // farther bubbles draw first; keeps crossings from flickering
      b.mesh.renderOrder = 10 + Math.round((2 - z2) * 8);
      b.glyphMesh.renderOrder = b.mesh.renderOrder + 10;
      b.glyphMesh.material.opacity = 0.80 + depth * 0.18;
    });

    const sa = t * 0.5;
    this.sweep.position.set(Math.cos(sa) * 3.4, 1.2 + Math.sin(sa * 0.7) * 1.6, Math.sin(sa) * 2.2 + 2.4);
  }
}

if (!customElements.get('nebula-mark-3d')) customElements.define('nebula-mark-3d', NebulaMark3D);
