/* The landing scene: a vortex that is allowed to fail without taking the page. */
'use strict';

(function landingStage(global) {
  /*
   * The signature moment: the vortex answers the gate.
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
   * vortex, which draws its waist in, spins faster and keeps its scan passing.
   * The moment reaches the geometry rather than stopping at a transform over
   * it.
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
   * The bar's section links. A tap scrolls to the section's heading (the
   * page reserves the bar's height as scroll padding, so it lands below it);
   * the section being read is marked, and a pill of ink slides under its
   * link. The section being read is the last one whose heading has passed
   * the upper third of the view.
   */
  const links = nav && typeof nav.querySelectorAll === 'function' ? [...nav.querySelectorAll('[data-lp-goto]')] : [];
  const ink = nav && nav.querySelector ? nav.querySelector('.lp-links-ink') : null;
  if (links.length) {
    const targets = links.map(link => document.getElementById(link.dataset.lpGoto));
    links.forEach((link, index) => link.addEventListener('click', () => {
      const target = targets[index];
      if (!target) return;
      target.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'start' });
    }));
    let active = -1;
    let queued = false;
    const place = () => {
      queued = false;
      const line = global.innerHeight / 3;
      let current = -1;
      targets.forEach((target, index) => { if (target && target.getBoundingClientRect().top <= line) current = index; });
      /* Past the last section's end, nothing on the bar is being read. */
      const last = targets[targets.length - 1];
      const section = last && last.closest ? last.closest('section') : null;
      if (section && section.getBoundingClientRect().bottom < line) current = -1;
      if (current === active) return;
      active = current;
      links.forEach((link, index) => {
        if (index === current) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
      if (!ink) return;
      if (current < 0) { ink.classList.remove('is-on'); return; }
      ink.style.setProperty('--ink-x', `${links[current].offsetLeft}px`);
      ink.style.setProperty('--ink-w', `${links[current].offsetWidth}px`);
      ink.classList.add('is-on');
    };
    const request = () => {
      if (queued) return;
      queued = true;
      global.requestAnimationFrame(place);
    };
    global.addEventListener('scroll', request, { passive: true });
    global.addEventListener('resize', () => { active = -2; request(); }, { passive: true });
    place();
  }

  /*
   * A sentence lit a word at a time as it is read: each word brightens as
   * the paragraph climbs from the lower edge of the view to its upper third.
   * The words stay in the paragraph as its own text, so a screen reader and
   * a copy both get the sentence; with motion off it is simply lit.
   */
  const lit = document.querySelector ? document.querySelector('[data-lp-lit]') : null;
  if (lit && typeof lit.querySelectorAll === 'function' && !still()) {
    const words = [];
    const walker = document.createTreeWalker(lit, NodeFilter.SHOW_TEXT);
    const texts = [];
    let node;
    while ((node = walker.nextNode())) texts.push(node);
    texts.forEach(text => {
      const parts = text.nodeValue.split(/(\s+)/);
      const fragment = document.createDocumentFragment();
      parts.forEach(part => {
        if (!part) return;
        if (/^\s+$/.test(part)) { fragment.appendChild(document.createTextNode(part)); return; }
        const word = document.createElement('span');
        word.className = 'lp-word-lit';
        word.textContent = part;
        words.push(word);
        fragment.appendChild(word);
      });
      text.parentNode.replaceChild(fragment, text);
    });
    lit.classList.add('is-lighting');
    let shown = -1;
    let queued = false;
    const light = () => {
      queued = false;
      const box = lit.getBoundingClientRect();
      const start = global.innerHeight * 0.9;
      const end = global.innerHeight * 0.35;
      const progress = Math.max(0, Math.min(1, (start - box.top) / Math.max(1, (start - end) + box.height * 0.5)));
      const count = still() ? words.length : Math.round(progress * words.length);
      if (count === shown) return;
      shown = count;
      words.forEach((word, index) => word.classList.toggle('is-lit', index < count));
    };
    const request = () => {
      if (queued) return;
      queued = true;
      global.requestAnimationFrame(light);
    };
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) { global.addEventListener('scroll', request, { passive: true }); request(); }
          else global.removeEventListener('scroll', request);
        });
      }, { threshold: 0 }).observe(lit);
    } else {
      words.forEach(word => word.classList.add('is-lit'));
    }
  }

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
    /*
     * The rail the moves hang from: a line from the first move's number to
     * the last one's, lit down to the reading line. Decoration, so it is
     * drawn by the script that plays the scene; without script the moves
     * stand on their own.
     */
    const body = play.querySelector('.lp-play-body');
    const badges = steps.map(step => step.querySelector('.lp-play-n')).filter(Boolean);
    let rail = null;
    if (body && badges.length === steps.length) {
      rail = document.createElement('div');
      rail.className = 'lp-play-rail';
      rail.setAttribute('aria-hidden', 'true');
      rail.appendChild(document.createElement('i'));
      rail.appendChild(document.createElement('b'));
      body.appendChild(rail);
    }
    const placeRail = () => {
      if (!rail) return;
      const frame = body.getBoundingClientRect();
      const first = badges[0].getBoundingClientRect();
      const last = badges[badges.length - 1].getBoundingClientRect();
      const top = first.top + first.height / 2 - frame.top;
      const height = Math.max(0, last.top + last.height / 2 - frame.top - top);
      rail.style.top = `${top.toFixed(1)}px`;
      rail.style.height = `${height.toFixed(1)}px`;
      rail.style.setProperty('--rail-h', `${height.toFixed(1)}px`);
    };
    /* Fonts, the snapshots and a turned phone all move the numbers; the rail follows them. */
    if (rail && typeof global.ResizeObserver === 'function') new global.ResizeObserver(placeRail).observe(body);
    /* The held frame centres itself on the screen by its own height, which each stage changes. */
    if (typeof global.ResizeObserver === 'function') {
      new global.ResizeObserver(() => {
        playFrame.style.setProperty('--frame-h', `${Math.round(playFrame.offsetHeight)}px`);
      }).observe(playFrame);
    }
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
    const nav = document.querySelector('.lp-nav');
    const choose = () => {
      queued = false;
      /* The reading line is the middle of what the bar leaves (and, stacked, of what the frame leaves). */
      const under = nav ? Math.max(0, nav.getBoundingClientRect().bottom) : 0;
      const top = stacked && stacked.matches ? Math.max(under, playFrame.getBoundingClientRect().bottom) : under;
      const line = top + (global.innerHeight - top) / 2;
      let best = null;
      let distance = Infinity;
      for (const step of steps) {
        const box = step.getBoundingClientRect();
        const gap = Math.abs((box.top + box.bottom) / 2 - line);
        if (gap < distance) { distance = gap; best = step; }
      }
      if (rail) {
        const box = rail.getBoundingClientRect();
        const lit = box.height > 0 ? Math.max(0, Math.min(1, (line - box.top) / box.height)) : 0;
        rail.style.setProperty('--play-p', lit.toFixed(4));
      }
      if (!best || best.dataset.stage === current) return;
      current = best.dataset.stage;
      const reached = steps.indexOf(best);
      steps.forEach((step, index) => {
        step.classList.toggle('is-current', step === best);
        step.classList.toggle('is-passed', index < reached);
      });
      playFrame.dataset.stage = current;
      if (current === 'read') countUp();
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      global.requestAnimationFrame(choose);
    };
    const onResize = () => { placeRail(); onScroll(); };
    new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          play.classList.add('is-playing');
          global.addEventListener('scroll', onScroll, { passive: true });
          global.addEventListener('resize', onResize, { passive: true });
          placeRail();
          onScroll();
        } else {
          global.removeEventListener('scroll', onScroll);
          global.removeEventListener('resize', onResize);
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
   * "See how it works": the quiet way forward, for a reader who wants to see
   * before going in. It goes to the section it names and nowhere else.
   */
  const tours = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[data-lp-tour]') : [];
  tours.forEach(button => button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.lpTour);
    if (target) target.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'start' });
  }));

  /*
   * The closing call. With the gate on it returns the reader to the card at
   * the top and puts them in its first control, the invitation, rather than
   * leaving them to find it. With entry open it is named for the way through
   * ("Get started", "Open your workspace") and is that way through: two
   * buttons with one name doing two different things is a promise broken.
   */
  const jumps = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[data-lp-jump]') : [];
  jumps.forEach(button => {
    button.addEventListener('click', () => {
      const open = document.getElementById('alphaOpenAccess');
      const through = document.getElementById('alphaPassThrough');
      if (open && !open.hidden && through && !through.disabled) { through.click(); return; }
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
   * stage keeps its own ground and veil, so losing the vortex costs the picture
   * a subject and nothing else -- the page is never a black box waiting for a
   * context that is not coming.
   */
  // The canvas owns an unobstructed box and handles pointer capture itself.
  const scene = global.NebulaVortex && global.NebulaVortex.create(canvas, {
    preset: (canvas.dataset && canvas.dataset.vortex) || 'column'
  });
  if (!scene) {
    canvas.hidden = true;
    if (art) art.hidden = true;
    return;
  }
  reachListeners.push(on => scene.setReaching(on));

  const themeName = () => (root.dataset.design === 'obsidian' ? 'obsidian-' : '') +
    (root.dataset.theme === 'light' ? 'light' : 'dark');
  scene.setTheme(themeName());

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
      scene.start();
      reveal();
      return;
    }
    scene.stop();
    /*
     * Still, not gone. A reader who asked for less motion gets the vortex as
     * a held frame -- the picture without the movement -- which is what the
     * poster used to be, drawn rather than downloaded.
     */
    scene.renderStill();
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
      scene.setTheme(themeName());
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
