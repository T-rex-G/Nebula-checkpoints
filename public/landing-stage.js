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
  const art = document.querySelector('.lp-art');
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

  /*
   * The bar earns its ground by scrolling. At rest the page's bloom runs up
   * behind the brand; once anything can pass underneath, the bar takes a
   * full-width backdrop (CSS: .lp-nav.is-stuck). One passive listener, read
   * once per frame.
   */
  const nav = document.querySelector('.lp-nav');
  if (nav) {
    let queued = false;
    const syncNav = () => { queued = false; nav.classList.toggle('is-stuck', global.scrollY > 6); };
    global.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      global.requestAnimationFrame(syncNav);
    }, { passive: true });
    syncNav();
  }

  const root = document.documentElement;
  const reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => root.dataset.motion === 'off' || Boolean(reducedMotion && reducedMotion.matches);

  /*
   * The audit, played. The move nearest the reading line is the one the
   * frame shows: the middle of the view on a wide screen, and on a narrow
   * one -- where the frame holds the top -- the middle of what is left under
   * it. Listening only while the scene is on screen, one read per frame.
   * Without script the frame rests on the findings, which is the move worth
   * reading on its own.
   */
  const play = document.querySelector('.lp-play');
  const playFrame = play && play.querySelector('.lp-play-frame');
  if (play && playFrame && typeof IntersectionObserver === 'function') {
    const steps = [...play.querySelectorAll('.lp-play-step')];
    /* The narrow layout's snapshots: one copy of the frame per move, fixed at that move. */
    steps.forEach(step => {
      const snap = playFrame.cloneNode(true);
      snap.classList.add('lp-play-snap');
      snap.dataset.stage = step.dataset.stage;
      step.appendChild(snap);
    });
    play.classList.add('is-cloned');
    const count = playFrame.querySelector('.lp-au-count');
    const total = count ? Number(count.textContent) || 0 : 0;
    const stacked = global.matchMedia ? global.matchMedia('(max-width:939px)') : null;
    let current = '';
    let queued = false;
    const countUp = () => {
      if (!count || still()) return;
      const start = global.performance.now();
      const tick = now => {
        const t = Math.min(1, (now - start) / 1400);
        count.textContent = String(Math.round(total * (1 - Math.pow(1 - t, 3))));
        if (t < 1 && current === 'read') global.requestAnimationFrame(tick);
        else count.textContent = String(total);
      };
      global.requestAnimationFrame(tick);
    };
    const choose = () => {
      queued = false;
      const top = stacked && stacked.matches ? Math.max(0, playFrame.getBoundingClientRect().bottom) : 0;
      const line = top + (global.innerHeight - top) / 2;
      let best = null;
      let distance = Infinity;
      for (const step of steps) {
        const box = step.getBoundingClientRect();
        const gap = Math.abs((box.top + box.bottom) / 2 - line);
        if (gap < distance) { distance = gap; best = step; }
      }
      if (!best || best.dataset.stage === current) return;
      current = best.dataset.stage;
      steps.forEach(step => step.classList.toggle('is-current', step === best));
      playFrame.dataset.stage = current;
      if (current === 'read') countUp();
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      global.requestAnimationFrame(choose);
    };
    new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          play.classList.add('is-playing');
          global.addEventListener('scroll', onScroll, { passive: true });
          global.addEventListener('resize', onScroll, { passive: true });
          onScroll();
        } else {
          global.removeEventListener('scroll', onScroll);
          global.removeEventListener('resize', onScroll);
        }
      });
    }, { threshold: 0 }).observe(play);
  }

  /*
   * The rules passing under the counts: the list is doubled so the loop
   * meets itself, and it only moves while it is on screen.
   */
  const ticker = document.querySelector('.lp-ticker');
  const track = ticker && ticker.querySelector('.lp-ticker-track');
  if (ticker && track && typeof IntersectionObserver === 'function') {
    [...track.children].forEach(node => track.appendChild(node.cloneNode(true)));
    new IntersectionObserver(entries => {
      entries.forEach(entry => ticker.classList.toggle('is-looping', entry.isIntersecting));
    }, { threshold: 0 }).observe(ticker);
  }

  const canvas = document.getElementById('lpPortal');
  if (!canvas) return;

  const gate = document.getElementById('page-alpha-access');
  const connection = global.navigator && global.navigator.connection;

  // Content is visible by default, including without WebGL/JavaScript. Animate
  // each section once as it arrives; never take over the browser's scrolling.
  if (typeof IntersectionObserver === 'function' && document.querySelectorAll) {
    const sections = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        if (root.dataset.motion !== 'off' && !(reducedMotion && reducedMotion.matches)
            && !(connection && connection.saveData)) entry.target.classList.add('lp-revealed');
        sections.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.lp-steps, .lp-sec, .lp-play, .lp-show, .lp-checks, .lp-proof, .lp-story, .lp-faq, .lp-cta').forEach(section => sections.observe(section));
  }

  /*
   * The framed map animates its strands in SVG, which repaints every frame it
   * moves; it runs only while it is on screen, so the scene above it -- and a
   * phone's battery -- never pay for a picture nobody is looking at.
   */
  const show = document.querySelector('.lp-show');
  if (show && typeof IntersectionObserver === 'function' && show.classList) {
    new IntersectionObserver(entries => {
      entries.forEach(entry => show.classList.toggle('is-onscreen', entry.isIntersecting));
    }, { threshold: 0 }).observe(show);
  }

  /*
   * The numbers count up once, the first time they are seen. The figure is
   * in the markup from the start, so without script -- or with motion off --
   * the reader gets the number, not a zero.
   */
  const stats = document.querySelector('.lp-checks');
  if (stats && typeof IntersectionObserver === 'function' && typeof stats.querySelectorAll === 'function') {
    const counter = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      counter.disconnect();
      if (root.dataset.motion === 'off' || (reducedMotion && reducedMotion.matches)) return;
      stats.querySelectorAll('[data-count]').forEach(el => {
        const to = Number(el.dataset.count) || 0;
        if (!to) return;
        const start = global.performance.now();
        const step = now => {
          const t = Math.min(1, (now - start) / 1100);
          el.textContent = String(Math.round(to * (1 - Math.pow(1 - t, 3))));
          if (t < 1) global.requestAnimationFrame(step);
        };
        global.requestAnimationFrame(step);
      });
    }, { threshold: 0.35 });
    counter.observe(stats);
  }

  /*
   * The closing call returns the reader to the card at the top and puts them
   * in its first control -- the invitation, or the way through when entry is
   * open -- rather than leaving them to find it.
   */
  const jumps = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[data-lp-jump]') : [];
  jumps.forEach(button => {
    button.addEventListener('click', () => {
      const target = document.querySelector('.lp-card');
      if (!target) return;
      const still = root.dataset.motion === 'off' || (reducedMotion && reducedMotion.matches);
      target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
      const control = [...target.querySelectorAll('input, button')]
        .find(el => !el.hidden && !el.closest('[hidden]') && !el.disabled);
      if (control) global.setTimeout(() => control.focus({ preventScroll: true }), still ? 0 : 420);
    });
    /* A small pull toward a fine pointer: the button meets the hand. */
    if (global.matchMedia && global.matchMedia('(hover:hover) and (pointer:fine)').matches) {
      button.addEventListener('pointermove', event => {
        if (root.dataset.motion === 'off' || (reducedMotion && reducedMotion.matches)) return;
        const box = button.getBoundingClientRect();
        const dx = (event.clientX - (box.left + box.width / 2)) / box.width;
        const dy = (event.clientY - (box.top + box.height / 2)) / box.height;
        button.style.setProperty('--mag-x', `${(dx * 8).toFixed(1)}px`);
        button.style.setProperty('--mag-y', `${(dy * 6).toFixed(1)}px`);
      });
      button.addEventListener('pointerleave', () => {
        button.style.removeProperty('--mag-x');
        button.style.removeProperty('--mag-y');
      });
    }
  });

  /*
   * WebGL can be absent for reasons that are none of the reader's business: a
   * blocklisted driver, a headless build, a browser with it switched off. The
   * stage keeps its own ground and veil, so losing the ring costs the picture
   * a subject and nothing else -- the page is never a black box waiting for a
   * context that is not coming.
   */
  // The canvas owns an unobstructed box and handles pointer capture itself.
  const ring = global.NebulaPlasmaRing && global.NebulaPlasmaRing.create(canvas);
  if (!ring) {
    canvas.hidden = true;
    if (art) art.hidden = true;
    return;
  }
  reachListeners.push(on => ring.setReaching(on));

  const themeName = () => (root.dataset.design === 'obsidian' ? 'obsidian-' : '') +
    (root.dataset.theme === 'light' ? 'light' : 'dark');
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
  let stopGlow = () => {};
  if (glow && ring.interactive()) {
    const rest = { x: 50, y: 50 };
    const at = { x: rest.x, y: rest.y };
    const want = { x: rest.x, y: rest.y };
    let glowRaf = 0;
    let glowLast = 0;

    const step = now => {
      if (!ring.isRunning()) { glowRaf = 0; return; }
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
      if (glowRaf || !ring.isRunning()) return;
      glowLast = global.performance ? global.performance.now() : Date.now();
      glowRaf = global.requestAnimationFrame(step);
    };

    stopGlow = () => {
      if (glowRaf) global.cancelAnimationFrame(glowRaf);
      glowRaf = 0;
    };
    const hero = art || document.querySelector('.lp-hero') || document;
    hero.addEventListener('pointermove', event => {
      if (!ring.isRunning()) return;
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
    if (art) art.classList.toggle('is-static', !eligible());
    if (eligible()) {
      ring.start();
      reveal();
      return;
    }
    ring.stop();
    stopGlow();
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
    }).observe(root, { attributes: true, attributeFilter: ['data-motion', 'data-theme', 'data-design'] });
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
