/* The portal: a plasma ring drawn in WebGL, in place of a video of one. */
'use strict';

/*
 * Why this replaced a video.
 *
 * The scene used to be an mp4/webm pair -- 850KB of someone else's footage,
 * shipped in a public repository with no licence anyone could name. This
 * draws the same idea from arithmetic: a wireframe sphere, latitude-coloured,
 * with a travelling wave over it and a rim that lights where the surface
 * turns away from the camera. No video is downloaded; the geometry answers
 * the pointer. The supplied component's attribution is retained below.
 *
 * Adapted from the Plasma Ring component. The original is a React component
 * built on motion/react; neither exists here (no build step, and the page's
 * CSP is script-src 'self'), so the shaders are kept as they were and the
 * host, the easing and the lifecycle are rewritten as a plain module.
 */

(function plasmaRingModule(global) {
  const MAX_COLORS = 5;
  const TAU = Math.PI * 2;
  const FOV_DEG = 42;
  const DPR_CAP = 1.5;

  /*
   * Index buffers are UNSIGNED_SHORT, so the vertex count has a hard ceiling
   * of 65536. The grid is N_theta x N_phi = round(d*2.5) x round(d*1.8), which
   * crosses that ceiling at a density of about 121 -- where it would not fail
   * loudly but silently wrap and stitch the sphere to itself. Clamped here
   * rather than trusted to the caller.
   */
  const DENSITY_MAX = 120;
  const VERTEX_LIMIT = 65536;

  const VERT = `
precision highp float;
attribute vec2 aPolar;
attribute vec2 aRnd;

uniform vec2  uRes;
uniform float uFocal;
uniform float uTime;
uniform float uRadius;
uniform float uWaveHeight;
uniform float uWaveLength;
uniform float uWaveSpeed;
uniform vec2  uWaveDir;
uniform float uCamDist;
uniform float uCamYaw;
uniform float uCamPitch;
uniform float uTilt;
uniform float uRimPower;
uniform float uCenter;
uniform vec2  uShift;

uniform float uColorCount;
uniform vec3  uColors[${MAX_COLORS}];
uniform vec3  uHotspot;
uniform vec3  uCamDir;

uniform vec3  uHoverDir;
uniform float uHoverRadius;
uniform float uHoverPush;
uniform float uHoverActive;

varying vec3  vCol;
varying float vAlpha;

vec3 rampColor(float x) {
    float p  = clamp(x, 0.0, 1.0) * max(uColorCount - 1.0, 0.0);
    float i0 = floor(p);
    float f  = p - i0;
    vec3 a = uColors[0];
    vec3 b = uColors[0];
    for (int i = 0; i < ${MAX_COLORS}; i++) {
        if (float(i) == i0)       a = uColors[i];
        if (float(i) == i0 + 1.0) b = uColors[i];
    }
    return mix(a, b, f);
}

void main() {
    float phi   = aPolar.x;
    float theta = aPolar.y;

    float sp = sin(phi);  float cp2 = cos(phi);
    float st = sin(theta); float ct = cos(theta);

    vec3 norm = vec3(cp2 * ct, sp, cp2 * st);
    vec3 pos  = norm * uRadius;

    float wFreq = 6.2831853 / max(100.0, uWaveLength);
    float proj1 = norm.x * uWaveDir.x + norm.z * uWaveDir.y;
    float proj2 = norm.x * uWaveDir.y - norm.z * uWaveDir.x;

    float ts = uTime * (uWaveSpeed / 120.0);
    float wave1 = sin(proj1 * wFreq * 800.0 + ts * 1.2) * cos(norm.y * wFreq * 600.0 + ts * 0.3);
    float wave2 = sin(proj2 * wFreq * 600.0 + norm.y * 1.5 - ts * 0.5);
    pos += norm * ((wave1 + wave2 * 0.5) * uWaveHeight);

    float hFalloff = mix(22.0, 1.5, clamp(uHoverRadius / 100.0, 0.0, 1.0));
    float hDot     = max(0.0, dot(norm, uHoverDir));
    float hEffect  = exp(-(1.0 - hDot) * hFalloff) * uHoverActive;
    pos += norm * (hEffect * uHoverPush);

    float cy  = cos(uCamYaw); float sy = sin(uCamYaw);
    float tp  = uCamPitch + uTilt;
    float ctp = cos(tp);      float stp = sin(tp);

    float x1 =  pos.x * cy + pos.z * sy;
    float z1 = -pos.x * sy + pos.z * cy;
    float y2 =  pos.y * ctp - z1 * stp;
    float z2 =  pos.y * stp + z1 * ctp;
    float rz =  uCamDist - z2;

    if (rz < 1.0) {
        gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
        vAlpha = 0.0; vCol = vec3(0.0); return;
    }

    float sx  = x1 * uFocal / rz;
    float sy2 = y2 * uFocal / rz;
    gl_Position = vec4(sx / (uRes.x * 0.5) + uShift.x, sy2 / (uRes.y * 0.5) + uShift.y, 0.0, 1.0);

    float rimDot  = abs(dot(norm, uCamDir));
    float fresnel = pow(max(1.0 - rimDot, 0.0), uRimPower);
    fresnel = max(fresnel, uCenter * rimDot);

    float finalAlpha = max(fresnel, hEffect * 0.95);
    float bri = 0.50 + aRnd.x * 0.50;

    float t = sp * 0.5 + 0.5;
    vec3 baseCol = rampColor(1.0 - t);
    float polar  = min(pow(abs(sp), 4.0), 1.0);

    vCol   = mix(baseCol, uHotspot, polar * 0.88);
    vAlpha = finalAlpha * bri;
}
`;

  /* Premultiplied: the colour is already scaled by alpha here, which is what
     lets one shader serve both an additive and a normal blend. */
  const FRAG = `
precision highp float;
varying vec3  vCol;
varying float vAlpha;
void main() { gl_FragColor = vec4(vCol * vAlpha, vAlpha); }
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
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    return program;
  }

  /*
   * Two palettes and two blend modes, because one scene cannot serve both
   * themes here.
   *
   * On the dark theme the lines are added to what is behind them, which is
   * what makes plasma read as light rather than as wire. Adding light to a
   * light ground only ever approaches white, so the same treatment on the
   * light theme washed the ring out completely. There it composites normally
   * instead, with inked-down colours -- the same geometry drawn as a drawing.
   * This is the same split the page already makes everywhere else: light mode
   * gets its own art direction rather than the dark one turned up.
   */
  const THEMES = Object.freeze({
    dark: Object.freeze({
      /*
       * Cyan across four of five stops, violet only at the far pole. An even
       * split read as a violet ball with a cyan edge: the ramp runs over
       * latitude, so a colour given half the range takes half the sphere, and
       * the half facing the reader is the one that counts.
       *
       * The lightest stop is held at #A5F3FC rather than the near-white
       * #CFFAFE it started as. Additive blending sums overlapping lines, and
       * the pole is where the grid is densest, so any stop near white leaves
       * the brightest -- and most looked-at -- part of the subject reading as
       * plain white. Keeping a little saturation in reserve there lets the
       * sum climb to cyan before it climbs to white.
       */
      colors: ['#A5F3FC', '#4FE0F5', '#22D3EE', '#0891B2', '#7C3AED'],
      additive: true,
      centerOpacity: 0.08,
      rimPower: 2.1
    }),
    light: Object.freeze({
      colors: ['#22D3EE', '#0E9AB8', '#0E7490', '#155E75', '#6D28D9'],
      additive: false,
      centerOpacity: 0.16,
      rimPower: 1.9
    })
  });

  const BASE = Object.freeze({
    radius: 280,
    tilt: 20 * Math.PI / 180,
    waveHeight: 20,
    waveLength: 200,
    waveDirection: 45 * Math.PI / 180,
    waveSpeed: 120,
    hoverRadius: 35,
    hoverPush: 90,
    camFar: 2100,
    camPerScale: 15,
    scale: 52,
    orbitSpeed: 100,
    orbitDamping: 50
  });

  function create(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;

    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: true, antialias: false, premultipliedAlpha: true, depth: false
      });
    } catch { gl = null; }
    if (!gl) return null;

    const program = link(gl, VERT, FRAG);
    if (!program) return null;

    const host = options.host || canvas;
    const uniform = name => gl.getUniformLocation(program, name);
    const A = {
      polar: gl.getAttribLocation(program, 'aPolar'),
      rnd: gl.getAttribLocation(program, 'aRnd')
    };
    const U = {
      res: uniform('uRes'), focal: uniform('uFocal'), time: uniform('uTime'),
      radius: uniform('uRadius'), waveHeight: uniform('uWaveHeight'),
      waveLength: uniform('uWaveLength'), waveSpeed: uniform('uWaveSpeed'),
      waveDir: uniform('uWaveDir'), camDist: uniform('uCamDist'),
      camYaw: uniform('uCamYaw'), camPitch: uniform('uCamPitch'),
      tilt: uniform('uTilt'), rimPow: uniform('uRimPower'), center: uniform('uCenter'),
      shift: uniform('uShift'),
      colorCount: uniform('uColorCount'), colors: uniform('uColors[0]'),
      hotspot: uniform('uHotspot'), camDir: uniform('uCamDir'),
      hoverDir: uniform('uHoverDir'), hoverRadius: uniform('uHoverRadius'),
      hoverPush: uniform('uHoverPush'), hoverActive: uniform('uHoverActive')
    };

    const polarBuf = gl.createBuffer();
    const rndBuf = gl.createBuffer();
    const idxBuf = gl.createBuffer();
    const palette = new Float32Array(MAX_COLORS * 3);
    const hotspot = new Float32Array(3);
    /*
     * The palette is packed when the theme changes, not once a frame. It is
     * five hex strings, and parsing them per frame is three hundred string
     * allocations a second to produce the same nine floats every time.
     */
    let paletteOf = null;
    function packPalette() {
      const pal = theme.colors;
      for (let i = 0; i < MAX_COLORS; i += 1) {
        const [r, g, b] = parseColor(pal[Math.min(i, pal.length - 1)]);
        palette[i * 3] = r;
        palette[i * 3 + 1] = g;
        palette[i * 3 + 2] = b;
      }
      const [r0, g0, b0] = parseColor(pal[0]);
      hotspot[0] = Math.min(1, r0 * 0.6 + 0.8);
      hotspot[1] = Math.min(1, g0 * 0.4 + 0.7);
      hotspot[2] = Math.min(1, b0 * 0.5 + 0.8);
      paletteOf = theme;
    }

    let builtDensity = -1;
    let indexCount = 0;
    let vertexCount = 0;

    function build(density) {
      let d = Math.max(24, Math.min(DENSITY_MAX, Math.round(density)));
      let nTheta = Math.max(60, Math.round(d * 2.5));
      let nPhi = Math.max(40, Math.round(d * 1.8));
      while (nTheta * nPhi > VERTEX_LIMIT && d > 24) {
        d -= 2;
        nTheta = Math.max(60, Math.round(d * 2.5));
        nPhi = Math.max(40, Math.round(d * 1.8));
      }
      vertexCount = nTheta * nPhi;

      const polar = new Float32Array(vertexCount * 2);
      const rnd = new Float32Array(vertexCount * 2);
      const random = mulberry32(0xc0ffee7);
      let i = 0;
      for (let ti = 0; ti < nTheta; ti += 1) {
        const theta = ((ti + 0.5) / nTheta) * TAU;
        for (let pi = 0; pi < nPhi; pi += 1) {
          polar[i * 2] = (((pi + 0.5) / nPhi) - 0.5) * Math.PI;
          polar[i * 2 + 1] = theta;
          rnd[i * 2] = random();
          rnd[i * 2 + 1] = random();
          i += 1;
        }
      }

      indexCount = (nTheta * (nPhi - 1) + nPhi * nTheta) * 2;
      const indices = new Uint16Array(indexCount);
      let k = 0;
      for (let ti = 0; ti < nTheta; ti += 1) {
        for (let pi = 0; pi < nPhi - 1; pi += 1) {
          indices[k++] = ti * nPhi + pi;
          indices[k++] = ti * nPhi + pi + 1;
        }
      }
      for (let pi = 0; pi < nPhi; pi += 1) {
        for (let ti = 0; ti < nTheta; ti += 1) {
          indices[k++] = ti * nPhi + pi;
          indices[k++] = ((ti + 1) % nTheta) * nPhi + pi;
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, polarBuf);
      gl.bufferData(gl.ARRAY_BUFFER, polar, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, rndBuf);
      gl.bufferData(gl.ARRAY_BUFFER, rnd, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      builtDensity = density;
    }

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    let theme = THEMES.dark;
    let reaching = 0;
    let reachingTarget = 0;
    const cam = { yaw: 0, pitch: 0, yawV: 0, pitchV: 0 };
    const hover = { active: 0, target: 0, x: 0, y: 0, dirX: 0, dirY: 1, dirZ: 0 };
    const drag = { active: false, id: null, touch: false, lastX: 0, lastY: 0 };

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let raf = 0;
    let running = false;
    let lost = false;
    let elapsed = 0;
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

    /*
     * Density follows the smaller edge rather than a fixed number. The
     * original ships one grid for a 1200px stage; the same grid on a 390px
     * phone is a solid block of overlapping lines and a hot battery for a
     * picture nobody can resolve.
     */
    function densityFor() {
      const edge = Math.min(cssW, cssH) || 1;
      if (edge < 520) return 58;
      if (edge < 900) return 86;
      return DENSITY_MAX;
    }

    /* The artwork now has its own layout box, separate from the entry form. */
    function shiftFor() {
      return [0, 0];
    }

    function raySphereHit(mx, my, focal, yaw, pitch, camDist, radius) {
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const ctp = Math.cos(pitch);
      const stp = Math.sin(pitch);

      const ox = -sy * ctp * camDist;
      const oy = stp * camDist;
      const oz = cy * ctp * camDist;

      /* Undoing the placement offset: without this the sphere is drawn in one
         place and picked in another, and the bulge answers a pointer that is
         nowhere near it. */
      const [shx, shy] = shiftFor();
      const px = mx * dpr - canvas.width / 2 - (shx * canvas.width / 2);
      const py = canvas.height / 2 - my * dpr - (shy * canvas.height / 2);
      const dcx = px / focal;
      const dcy = py / focal;
      const dcz = -1;

      let dx = dcx * cy + dcy * sy * stp + dcz * (-sy * ctp);
      let dy = dcy * ctp + dcz * stp;
      let dz = dcx * sy + dcy * (-cy * stp) + dcz * (cy * ctp);
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= len; dy /= len; dz /= len;

      const odd = ox * dx + oy * dy + oz * dz;
      const oo = ox * ox + oy * oy + oz * oz;
      const disc = odd * odd - (oo - radius * radius);
      if (disc < 0) return null;
      const t = -odd - Math.sqrt(disc);
      if (t < 0) return null;

      const hx = ox + t * dx;
      const hy = oy + t * dy;
      const hz = oz + t * dz;
      const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
      return [hx / hl, hy / hl, hz / hl];
    }

    function draw(dt) {
      if (lost) return;
      if (cssW <= 0 || cssH <= 0) { resize(); return; }

      const density = densityFor();
      if (density !== builtDensity) build(density);
      if (vertexCount === 0) return;

      elapsed += dt;

      /* Eased rather than animated by a library: one exponential approach per
         frame reads the same and costs nothing. */
      reaching += (reachingTarget - reaching) * (1 - Math.exp(-dt * 3.2));

      const damp = 1 - Math.pow(BASE.orbitDamping / 100, dt * 10);
      cam.yaw += cam.yawV * damp;
      cam.pitch += cam.pitchV * damp;
      cam.yaw = ((cam.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
      cam.pitch = ((cam.pitch + Math.PI) % TAU + TAU) % TAU - Math.PI;
      cam.yawV *= (1 - damp * 1.4);
      cam.pitchV *= (1 - damp * 1.4);

      const camDist = BASE.camFar - BASE.camPerScale * BASE.scale;
      const focal = Math.min(canvas.width, canvas.height) / (2 * Math.tan((FOV_DEG / 2) * Math.PI / 180)) * 1.25;
      const totalPitch = cam.pitch + BASE.tilt;

      let hit = null;
      if (hover.target) {
        hit = raySphereHit(hover.x, hover.y, focal, cam.yaw, totalPitch, camDist, BASE.radius);
        if (hit) {
          hover.dirX = hit[0]; hover.dirY = hit[1]; hover.dirZ = hit[2];
        }
      }
      // A miss must not disable picking: the next pointer position can hit.
      hover.active += ((hit ? 1 : 0) - hover.active) * (1 - Math.exp(-dt * 6));

      const cy = Math.cos(cam.yaw);
      const sy = Math.sin(cam.yaw);
      const ctp = Math.cos(totalPitch);
      const stp = Math.sin(totalPitch);
      const cdx = -sy * ctp;
      const cdy = stp;
      const cdz = cy * ctp;
      const cdl = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz) || 1;

      const pal = theme.colors;
      if (paletteOf !== theme) packPalette();

      gl.blendFunc(gl.ONE, theme.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(program);
      gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.uniform1f(U.focal, focal);
      gl.uniform1f(U.time, elapsed * (BASE.waveSpeed / 50));
      gl.uniform1f(U.radius, BASE.radius);
      /* The signature moment, carried into the geometry: reaching for the
         invitation raises the wave and opens the centre, so the portal
         answers the gate in the scene itself and not only in CSS. */
      gl.uniform1f(U.waveHeight, BASE.waveHeight * (1 + reaching * 0.45));
      gl.uniform1f(U.waveLength, BASE.waveLength);
      gl.uniform1f(U.waveSpeed, BASE.waveSpeed);
      gl.uniform2f(U.waveDir, Math.sin(BASE.waveDirection), Math.cos(BASE.waveDirection));
      gl.uniform1f(U.camDist, camDist);
      gl.uniform1f(U.camYaw, cam.yaw);
      gl.uniform1f(U.camPitch, cam.pitch);
      gl.uniform1f(U.tilt, BASE.tilt);
      gl.uniform1f(U.rimPow, theme.rimPower);
      gl.uniform1f(U.center, theme.centerOpacity + reaching * 0.14);
      const [shx, shy] = shiftFor();
      gl.uniform2f(U.shift, shx, shy);
      gl.uniform1f(U.colorCount, pal.length);
      gl.uniform3fv(U.colors, palette);
      gl.uniform3f(U.hotspot, hotspot[0], hotspot[1], hotspot[2]);
      gl.uniform3f(U.camDir, cdx / cdl, cdy / cdl, cdz / cdl);
      gl.uniform3f(U.hoverDir, hover.dirX, hover.dirY, hover.dirZ);
      gl.uniform1f(U.hoverRadius, BASE.hoverRadius);
      gl.uniform1f(U.hoverPush, BASE.hoverPush);
      gl.uniform1f(U.hoverActive, hover.active);

      gl.bindBuffer(gl.ARRAY_BUFFER, polarBuf);
      gl.enableVertexAttribArray(A.polar);
      gl.vertexAttribPointer(A.polar, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, rndBuf);
      gl.enableVertexAttribArray(A.rnd);
      gl.vertexAttribPointer(A.rnd, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.drawElements(gl.LINES, indexCount, gl.UNSIGNED_SHORT, 0);
    }

    function frame(now) {
      if (!running) return;
      raf = global.requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      draw(dt);
    }

    const onLost = event => {
      event.preventDefault();
      lost = true;
      running = false;
      if (raf) global.cancelAnimationFrame(raf);
      raf = 0;
    };
    canvas.addEventListener('webglcontextlost', onLost);

    const onResize = () => {
      resize();
      // Resizing clears the drawing buffer even when animation is stopped.
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

    // One pointer stream, on the canvas only. Pointer capture carries a drag
    // outside it; pan-y/pinch-zoom in CSS leave native touch scrolling intact.
    const pointerMove = event => {
      if (!running || (drag.active && event.pointerId !== drag.id)) return;
      const rect = canvas.getBoundingClientRect();
      hover.x = (event.clientX - rect.left) * cssW / (rect.width || 1);
      hover.y = (event.clientY - rect.top) * cssH / (rect.height || 1);
      hover.target = hover.x >= 0 && hover.x <= cssW && hover.y >= 0 && hover.y <= cssH ? 1 : 0;
      if (!drag.active) return;
      const speed = (BASE.orbitSpeed / 100) * (Math.PI / 180);
      cam.yawV += (event.clientX - drag.lastX) * speed;
      cam.pitchV += (event.clientY - drag.lastY) * speed;
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
       * the portal -- held still, which is what a poster was for.
       */
      renderStill() {
        if (lost) return;
        resize();
        draw(0);
      },
      start() {
        if (running || lost) return;
        running = true;
        last = global.performance ? global.performance.now() : Date.now();
        raf = global.requestAnimationFrame(frame);
      },
      stop() {
        running = false;
        pointerUp();
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
      setReaching(on) { reachingTarget = on ? 1 : 0; },
      interactive() { return true; },
      destroy() {
        this.stop();
        canvas.removeEventListener('webglcontextlost', onLost);
        if (observer) observer.disconnect();
        else if (global.removeEventListener) global.removeEventListener('resize', onResize);
        host.removeEventListener('pointerdown', pointerDown);
        host.removeEventListener('pointermove', pointerMove);
        host.removeEventListener('pointerleave', pointerLeave);
        host.removeEventListener('pointerup', pointerUp);
        host.removeEventListener('pointercancel', pointerUp);
        host.removeEventListener('lostpointercapture', pointerUp);
        gl.deleteBuffer(polarBuf);
        gl.deleteBuffer(rndBuf);
        gl.deleteBuffer(idxBuf);
        gl.deleteProgram(program);
      }
    });
  }

  global.NebulaPlasmaRing = Object.freeze({ create, THEMES });
})(typeof globalThis === 'undefined' ? this : globalThis);
