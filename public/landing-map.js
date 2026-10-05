/*
 * The landing's Neural map, alive.
 *
 * The map itself stays the SVG it was -- panels, strands, hub, words -- and
 * this draws the motion over it on one canvas: a signal leaves a node, runs
 * its strand into the hub and lands as a ring; the hub's arcs turn and a
 * light rides each orbit. Drawing it here rather than animating SVG strokes
 * is what lets it move on a phone too: a canvas repaints itself and nothing
 * under it, where a moving stroke repainted the whole picture under a
 * scrolling finger.
 *
 * It runs only while the map is on screen, the page is visible and motion
 * is allowed (the data-motion setting and the OS preference). Without a 2D
 * context, or if it cannot keep pace, the canvas goes and the SVG's own
 * still strands are the picture. It is decoration, never content: the frame
 * says in words what the map shows.
 */
'use strict';
(function landingMapModule(root) {
  /* Where a viewBox point lands in a box the SVG draws with xMidYMid meet. */
  function meet(view, width, height) {
    const scale = Math.min(width / view.width, height / view.height);
    return {
      scale,
      x: (width - view.width * scale) / 2 - view.x * scale,
      y: (height - view.height * scale) / 2 - view.y * scale
    };
  }

  /* A point a fraction of the way along evenly spaced samples of a path. */
  function along(points, t) {
    const last = points.length - 1;
    const at = Math.max(0, Math.min(1, t)) * last;
    const index = Math.min(last - 1, Math.floor(at));
    const rest = at - index;
    const a = points[index];
    const b = points[index + 1];
    return [a[0] + (b[0] - a[0]) * rest, a[1] + (b[1] - a[1]) * rest];
  }

  /* Gentle at both ends: a signal gathers, runs, and settles into the hub. */
  function ease(t) {
    return t <= 0 ? 0 : t >= 1 ? 1 : 0.5 - Math.cos(Math.PI * t) / 2;
  }

  /* "rgb(1, 2, 3)" / "rgba(1, 2, 3, .5)" / "#abc" / "#aabbcc" -> [r, g, b]. */
  function rgb(value, fallback) {
    const text = String(value || '').trim();
    const fn = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
    const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return fallback;
  }

  /*
   * The pace a decoration has to hold: past this, a slow device is spending
   * its frames on ornament, and the map goes back to standing still.
   */
  const BUDGET = Object.freeze({ frames: 40, medianMs: 60 });
  const SAMPLES = 48;
  const TAIL = 92;

  function createLandingMap(view, env) {
    const doc = env.document;
    const html = doc.documentElement;
    const reduced = env.matchMedia ? env.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    const random = typeof env.random === 'function' ? env.random : Math.random;
    const canvas = doc.createElement('canvas');
    canvas.className = 'lp-map-fx';
    canvas.setAttribute('aria-hidden', 'true');
    let ctx = null;
    try { ctx = canvas.getContext('2d'); } catch { /* decoration is optional */ }
    if (!ctx) return { destroy() {}, state: () => ({ available: false }) };
    view.appendChild(canvas);

    let width = 0;
    let height = 0;
    let ratio = 1;
    let map = null;
    let scene = null;
    let frame = null;
    let previous = null;
    let onscreen = false;
    let retired = false;
    let destroyed = false;
    let clock = 0;
    const gaps = [];
    const sprites = new Map();

    const light = () => html.dataset.theme === 'light';
    const still = () => html.dataset.motion === 'off' || Boolean(reduced.matches);
    const visibleMap = () => [...view.querySelectorAll('svg.lp-map')]
      .find(svg => env.getComputedStyle(svg).display !== 'none') || null;

    function mark(state) {
      if (view.dataset.fx !== state) view.dataset.fx = state;
      view.classList.toggle('has-fx', state === 'running' || state === 'paused');
    }

    /* Everything the motion needs from the picture, read once per layout or theme. */
    function read(svg) {
      const box = svg.viewBox && svg.viewBox.baseVal;
      if (!box || !box.width) return null;
      const orb = svg.querySelector('.lp-map-orb');
      const hub = orb ? [Number(orb.getAttribute('cx')), Number(orb.getAttribute('cy')), Number(orb.getAttribute('r'))] : null;
      if (!hub) return null;
      const arc = svg.querySelector('.lp-map-arcs path');
      const arcRadius = arc ? Number((arc.getAttribute('d').match(/A\s*([\d.]+)/) || [])[1]) || hub[2] + 8 : hub[2] + 8;
      const accent = rgb(arc ? env.getComputedStyle(arc).stroke : '', [167, 139, 250]);
      const rings = [...svg.querySelectorAll('.lp-map-ring')].map(ring => Number(ring.getAttribute('r'))).filter(Boolean);
      /* The repository's name stays on top of everything that moves past it. */
      const pill = svg.querySelector('.lp-map-pill');
      const label = pill ? ['x', 'y', 'width', 'height'].map(name => Number(pill.getAttribute(name)) || 0) : null;
      const strands = [...svg.querySelectorAll('.lp-map-strand')].map((path, index) => {
        let length = 0;
        try { length = path.getTotalLength(); } catch { length = 0; }
        if (!length) return null;
        const points = [];
        for (let i = 0; i <= SAMPLES; i++) {
          const p = path.getPointAtLength((length * i) / SAMPLES);
          points.push([p.x, p.y]);
        }
        return {
          points, length,
          colour: rgb(env.getComputedStyle(path).stroke, accent),
          duration: 2.1 + (index % 5) * 0.32,
          t: -(0.15 + random() * 2.6)
        };
      }).filter(Boolean);
      return { svg, box: { x: box.x, y: box.y, width: box.width, height: box.height }, hub, arcRadius, accent, rings, strands, label,
        pulses: [], pings: [] };
    }

    /* One soft head per colour, drawn once: a white core on dark, the colour itself on light. */
    function sprite(colour) {
      const key = `${colour.join(',')}|${light() ? 'l' : 'd'}`;
      if (sprites.has(key)) return sprites.get(key);
      const size = 64;
      const art = doc.createElement('canvas');
      art.width = size;
      art.height = size;
      const pen = art.getContext('2d');
      if (!pen) return null;
      const [r, g, b] = colour;
      const glow = pen.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      if (light()) {
        glow.addColorStop(0, `rgba(${r},${g},${b},1)`);
        glow.addColorStop(0.22, `rgba(${r},${g},${b},.85)`);
        glow.addColorStop(0.5, `rgba(${r},${g},${b},.18)`);
      } else {
        glow.addColorStop(0, 'rgba(255,255,255,1)');
        glow.addColorStop(0.16, `rgba(${r},${g},${b},.95)`);
        glow.addColorStop(0.42, `rgba(${r},${g},${b},.28)`);
      }
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      pen.fillStyle = glow;
      pen.fillRect(0, 0, size, size);
      sprites.set(key, art);
      return art;
    }

    function layout() {
      if (destroyed) return;
      /*
       * The layout size, not the drawn one: the frame tilts flat as it
       * scrolls in, and a bounding box read mid-tilt is the box scaled by
       * the tilt -- a canvas sized from it drew every light off its strand
       * once the frame settled. The bounding box stands in only where there
       * is no layout to read.
       */
      const rect = view.clientWidth && view.clientHeight
        ? { width: view.clientWidth, height: view.clientHeight }
        : view.getBoundingClientRect();
      const nextWidth = Math.round(rect.width);
      const nextHeight = Math.round(rect.height);
      const nextRatio = Math.min(Number(env.devicePixelRatio) || 1, 2);
      if (nextWidth !== width || nextHeight !== height || nextRatio !== ratio) {
        width = nextWidth;
        height = nextHeight;
        ratio = nextRatio;
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
      }
      const svg = visibleMap();
      if (!svg) { scene = null; sync(); return; }
      if (!scene || scene.svg !== svg) scene = read(svg);
      map = scene ? meet(scene.box, width, height) : null;
      sync();
    }

    function recolour() {
      sprites.clear();
      if (scene) scene = read(scene.svg);
      sync();
    }

    function draw(dt) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!scene || !map) return;
      const s = map.scale * ratio;
      ctx.setTransform(s, 0, 0, s, map.x * ratio, map.y * ratio);
      ctx.save();
      if (scene.label) {
        const { box } = scene;
        const [lx, ly, lw, lh] = scene.label;
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.width, box.height);
        ctx.rect(lx - 1, ly - 1, lw + 2, lh + 2);
        ctx.clip('evenodd');
      }
      const onLight = light();
      ctx.globalCompositeOperation = onLight ? 'source-over' : 'lighter';
      ctx.lineCap = 'round';
      const px = 1 / map.scale;
      const [hx, hy, hr] = scene.hub;
      const [ar, ag, ab] = scene.accent;

      /* A light riding each orbit, the outer ones slower. */
      scene.rings.forEach((radius, index) => {
        const turn = clock * (index % 2 ? -0.11 : 0.16) / (1 + index * 0.35) + index * 2.1;
        ctx.beginPath();
        ctx.arc(hx, hy, radius, turn - 0.5, turn);
        ctx.strokeStyle = `rgba(${ar},${ag},${ab},${onLight ? 0.4 : 0.32})`;
        ctx.lineWidth = Math.max(1.1, 1.4 * px);
        ctx.stroke();
        const head = sprite(scene.accent);
        const size = 14;
        if (head) ctx.drawImage(head, hx + Math.cos(turn) * radius - size / 2, hy + Math.sin(turn) * radius - size / 2, size, size);
      });

      /* The hub's two arcs, turning once every eleven seconds. */
      const spin = (clock * Math.PI * 2) / 11;
      ctx.strokeStyle = `rgba(${ar},${ag},${ab},${onLight ? 0.75 : 0.7})`;
      ctx.lineWidth = Math.max(2, 2 * px);
      [[0, 1.96], [Math.PI, Math.PI + 2.1]].forEach(([from, to]) => {
        ctx.beginPath();
        ctx.arc(hx, hy, scene.arcRadius, from + spin, to + spin);
        ctx.stroke();
      });

      /* Rings where a signal landed, and where one set out. */
      const rings = (list, life, grow) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const ring = list[i];
          ring.age += dt;
          const k = ring.age / life;
          if (k >= 1) { list.splice(i, 1); continue; }
          const [r, g, b] = ring.colour;
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, ring.r + grow * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - k) * (onLight ? 0.55 : 0.5)})`;
          ctx.lineWidth = Math.max(1.2, 1.6 * px);
          ctx.stroke();
        }
      };
      rings(scene.pulses, 1.6, hr * 1.5);
      rings(scene.pings, 0.9, 12);

      /* The signals: a soft tail along the strand and a bright head. */
      scene.strands.forEach(strand => {
        const before = strand.t;
        strand.t += dt / strand.duration;
        if (before < 0 && strand.t >= 0) {
          const [x, y] = strand.points[0];
          scene.pings.push({ x, y, r: 9, age: 0, colour: strand.colour });
        }
        if (strand.t >= 1) {
          scene.pulses.push({ x: hx, y: hy, r: hr, age: 0, colour: strand.colour });
          if (scene.pulses.length > 8) scene.pulses.shift();
          strand.t = -(0.5 + random() * 2.4);
          return;
        }
        if (strand.t < 0) return;
        const head = ease(strand.t);
        const fade = Math.min(1, strand.t / 0.1, (1 - strand.t) / 0.12);
        const tail = TAIL / strand.length;
        const [r, g, b] = strand.colour;
        const steps = 12;
        for (let k = 0; k < steps; k++) {
          const from = along(strand.points, head - (tail * k) / steps);
          const to = along(strand.points, head - (tail * (k + 1)) / steps);
          const fall = 1 - k / steps;
          ctx.beginPath();
          ctx.moveTo(from[0], from[1]);
          ctx.lineTo(to[0], to[1]);
          ctx.strokeStyle = `rgba(${r},${g},${b},${fade * fall * fall * (onLight ? 0.95 : 0.85)})`;
          ctx.lineWidth = Math.max(1.2, (0.8 + 2.8 * fall) * Math.max(1, px * 0.8));
          ctx.stroke();
        }
        const glow = sprite(strand.colour);
        if (glow) {
          const [x, y] = along(strand.points, head);
          const size = 30 * Math.max(1, px * 0.7);
          ctx.globalAlpha = fade;
          ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
          ctx.globalAlpha = 1;
        }
      });
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }

    /* A slow device keeps the still map rather than a stuttering one. */
    function hold(gap) {
      if (gaps.length >= BUDGET.frames) return;
      gaps.push(gap);
      if (gaps.length < BUDGET.frames) return;
      const sorted = gaps.slice().sort((a, b) => a - b);
      if (sorted[Math.floor(sorted.length / 2)] > BUDGET.medianMs) retire();
    }

    function tick(now) {
      frame = null;
      if (!running()) { sync(); return; }
      const gap = previous === null ? 16 : now - previous;
      previous = now;
      if (gap > 0 && gap < 1000) hold(gap);
      if (retired) return;
      const dt = Math.min(0.05, Math.max(0, gap) / 1000);
      clock += dt;
      draw(dt);
      frame = env.requestAnimationFrame(tick);
    }

    const running = () => !destroyed && !retired && onscreen && !doc.hidden && !still() && Boolean(scene) && width > 0 && height > 0;

    function stop() {
      if (frame !== null) env.cancelAnimationFrame(frame);
      frame = null;
      previous = null;
    }

    function sync() {
      if (destroyed || retired) return;
      if (still() || !scene) {
        stop();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        mark('still');
        return;
      }
      if (!running()) { stop(); mark('paused'); return; }
      mark('running');
      if (frame === null) frame = env.requestAnimationFrame(tick);
    }

    function retire() {
      retired = true;
      stop();
      canvas.remove();
      mark('retired');
    }

    const observer = new env.MutationObserver(() => recolour());
    observer.observe(html, { attributes: true, attributeFilter: ['data-theme', 'data-motion', 'data-design'] });
    const sizeObserver = env.ResizeObserver ? new env.ResizeObserver(layout) : null;
    if (sizeObserver) sizeObserver.observe(view);
    const watch = env.IntersectionObserver ? new env.IntersectionObserver(entries => {
      entries.forEach(entry => { onscreen = entry.isIntersecting; });
      sync();
    }, { rootMargin: '80px 0px' }) : null;
    if (watch) watch.observe(view);
    else onscreen = true;
    const onMotion = () => sync();
    if (reduced.addEventListener) reduced.addEventListener('change', onMotion);
    doc.addEventListener('visibilitychange', onMotion);
    env.addEventListener('resize', layout);
    layout();

    function destroy() {
      if (destroyed) return;
      stop();
      destroyed = true;
      observer.disconnect();
      if (sizeObserver) sizeObserver.disconnect();
      if (watch) watch.disconnect();
      if (reduced.removeEventListener) reduced.removeEventListener('change', onMotion);
      doc.removeEventListener('visibilitychange', onMotion);
      env.removeEventListener('resize', layout);
      canvas.remove();
      view.classList.remove('has-fx');
      delete view.dataset.fx;
    }
    return {
      destroy,
      state: () => ({
        available: true, running: frame !== null, retired, onscreen, width, height, ratio,
        strands: scene ? scene.strands.length : 0, clock
      })
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { meet, along, ease, rgb, createLandingMap, BUDGET };
  else if (root && root.document) {
    const view = root.document.querySelector('.lp-show .lp-frame-view');
    if (view) createLandingMap(view, root);
  }
})(typeof window === 'undefined' ? null : window);
