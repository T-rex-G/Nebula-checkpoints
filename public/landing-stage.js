/* The landing scene: a portal that is allowed to fail without taking the page. */
'use strict';

(function landingStage(global) {
  /*
   * The signature moment: the portal answers the gate.
   *
   * Reaching for the invitation is the one action this page exists for, so
   * the scene leans in while the reader is in the card and settles back when
   * they leave it. It is the only thing on this page that moves of its own
   * accord, which is what lets it read as deliberate rather than as one more
   * animated element.
   *
   * focusin/focusout rather than focus/blur on the field alone: the card
   * holds three controls, and moving between them should not make the scene
   * flinch once per tab stop.
   *
   * The class is carried for CSS as it always was, and now also handed to the
   * ring, which raises its wave and opens its centre. The moment reaches the
   * geometry rather than stopping at a transform over it.
   */
  const lp = document.querySelector('.lp');
  const card = document.querySelector('.lp-card');
  const reachListeners = [];
  const announceReaching = on => reachListeners.forEach(fn => fn(on));

  if (lp && card) {
    /*
     * Not until the reader has actually touched the page.
     *
     * alpha-ui focuses the invitation as soon as the gate is raised, so a
     * lean-in bound to focus alone was applied on the first frame and never
     * came back -- the moment was the resting state, which is no moment at
     * all. A cursor the browser parked in the field is not the reader
     * reaching for it.
     */
    let engaged = false;
    const engage = () => {
      if (engaged) return;
      engaged = true;
      if (card.contains(document.activeElement)) {
        lp.classList.add('is-reaching');
        announceReaching(true);
      }
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach(name =>
      document.addEventListener(name, engage, { once: true, passive: true }));

    card.addEventListener('focusin', () => {
      if (!engaged) return;
      lp.classList.add('is-reaching');
      announceReaching(true);
    });
    card.addEventListener('focusout', () => {
      if (card.contains(document.activeElement)) return;
      lp.classList.remove('is-reaching');
      announceReaching(false);
    });
  }

  const canvas = document.getElementById('lpPortal');
  if (!canvas) return;

  const gate = document.getElementById('page-alpha-access');
  const reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = global.navigator && global.navigator.connection;
  const root = document.documentElement;

  /*
   * WebGL can be absent for reasons that are none of the reader's business: a
   * blocklisted driver, a headless build, a browser with it switched off. The
   * stage keeps its own ground and veil, so losing the ring costs the picture
   * a subject and nothing else -- the page is never a black box waiting for a
   * context that is not coming.
   */
  /* Listening on the canvas, not the stage: the stage is pointer-events:none
     so the copy above it is never blocked, and only the canvas opts back in
     (and only for a pointer that can hover -- see plasma-ring.js). */
  const ring = global.NebulaPlasmaRing && global.NebulaPlasmaRing.create(canvas);
  if (!ring) {
    canvas.hidden = true;
    return;
  }
  reachListeners.push(on => ring.setReaching(on));

  const themeName = () => (root.dataset.theme === 'light' ? 'light' : 'dark');
  ring.setTheme(themeName());

  /*
   * The bloom follows the pointer, eased.
   *
   * Written straight from pointermove it snaps, because a mouse reports in
   * jumps and a gradient has no transition of its own to smooth them --
   * stop positions are not animatable properties. One exponential approach
   * per frame, on the same clock as the ring, and the light and the bulge
   * arrive together rather than one chasing the other.
   *
   * Only where a pointer can hover: a finger has no resting position to
   * follow, and a phone should not be running a loop to move a gradient it
   * cannot address.
   */
  const glow = document.querySelector('.lp-glow');
  if (glow && ring.interactive()) {
    const rest = { x: 68, y: 46 };
    const at = { x: rest.x, y: rest.y };
    const want = { x: rest.x, y: rest.y };
    let glowRaf = 0;
    let glowLast = 0;

    const step = now => {
      const dt = Math.min((now - glowLast) / 1000, 0.05);
      glowLast = now;
      const k = 1 - Math.exp(-dt * 4.5);
      at.x += (want.x - at.x) * k;
      at.y += (want.y - at.y) * k;
      glow.style.setProperty('--gx', at.x.toFixed(2) + '%');
      glow.style.setProperty('--gy', at.y.toFixed(2) + '%');
      if (Math.abs(want.x - at.x) < 0.05 && Math.abs(want.y - at.y) < 0.05) {
        glowRaf = 0;
        return;
      }
      glowRaf = global.requestAnimationFrame(step);
    };
    const nudge = () => {
      if (glowRaf) return;
      glowLast = global.performance ? global.performance.now() : Date.now();
      glowRaf = global.requestAnimationFrame(step);
    };

    const hero = document.querySelector('.lp-hero') || document;
    hero.addEventListener('pointermove', event => {
      const rect = (hero.getBoundingClientRect ? hero : document.documentElement).getBoundingClientRect();
      want.x = ((event.clientX - rect.left) / (rect.width || 1)) * 100;
      want.y = ((event.clientY - rect.top) / (rect.height || 1)) * 100;
      nudge();
    }, { passive: true });
    hero.addEventListener('pointerleave', () => {
      want.x = rest.x;
      want.y = rest.y;
      nudge();
    }, { passive: true });
  }

  let intersecting = typeof IntersectionObserver !== 'function';
  let revealed = false;

  /*
   * The same eligibility the video honoured, for the same reasons: the
   * interface's own motion switch, the system preference, a metered
   * connection, a hidden tab, and whether this screen is even on.
   */
  const eligible = () => root.dataset.motion !== 'off'
    && !(reducedMotion && reducedMotion.matches)
    && !(connection && connection.saveData)
    && !document.hidden && intersecting
    && (!gate || (!gate.hidden && gate.classList.contains('active')));

  /*
   * Revealed once something has actually been drawn, never before. The
   * canvas is transparent until the first frame lands, and fading in an empty
   * one is the flash the video's poster existed to prevent.
   */
  function reveal() {
    if (revealed) return;
    revealed = true;
    canvas.classList.add('is-live');
  }

  function sync() {
    if (eligible()) {
      ring.start();
      reveal();
      return;
    }
    ring.stop();
    /*
     * Still, not gone. A reader who asked for less motion gets the portal as
     * a held frame -- the picture without the movement -- which is what the
     * poster used to be, drawn rather than downloaded.
     */
    ring.renderStill();
    reveal();
  }

  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(entries => {
      entries.forEach(entry => {
        intersecting = entry.isIntersecting
          && (entry.intersectionRatio == null || entry.intersectionRatio >= 0.05);
        sync();
      });
    }, { threshold: 0.05 }).observe(canvas);
  } else {
    sync();
  }

  /* The motion setting and the theme both live on the root element, so follow
     them live rather than reading them once at load. */
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      ring.setTheme(themeName());
      sync();
    }).observe(root, { attributes: true, attributeFilter: ['data-motion', 'data-theme'] });
    if (gate) {
      new MutationObserver(sync).observe(gate, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
  }
  document.addEventListener('visibilitychange', sync);
  if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener('change', sync);
  else if (reducedMotion && reducedMotion.addListener) reducedMotion.addListener(sync);
  if (connection && connection.addEventListener) connection.addEventListener('change', sync);

  sync();
})(typeof globalThis === 'undefined' ? this : globalThis);
