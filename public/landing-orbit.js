/*
 * The landing's singularity section, driven by the scroll.
 *
 * The section is taller than the screen and its stage is sticky, so how far
 * the reader has scrolled through it is a number from 0 to 1. That number
 * banks the black hole (handed to <nebula-singularity> as its `progress`),
 * lights the six systems one by one, and readies the gate at the end. The scene
 * itself is fetched through the visuals loader, which first asks whether this
 * device can draw it; without it the stage keeps its CSS horizon.
 *
 * Content never depends on any of this: every system is in the markup, lit,
 * so without script -- or with motion off -- the reader gets all six at once.
 * The page's own scroll is never taken over; this only listens to it.
 *
 * Also here: the thin progress line at the screen's right edge, which says
 * how far down the landing the reader is.
 */
'use strict';

(function landingOrbit(global) {
  const root = document.documentElement;
  const section = document.querySelector('.lp-orbit');
  const line = document.querySelector('.lp-progress i');
  const gate = document.getElementById('page-alpha-access');
  if (!section && !line) return;

  const reduced = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const still = () => root.dataset.motion === 'off' || !!(reduced && reduced.matches);
  const art = document.getElementById('lpOrbitArt');
  const systems = section ? [...section.querySelectorAll('.lp-system')] : [];
  let frame = 0;
  let mounted = false;

  function sectionProgress() {
    const box = section.getBoundingClientRect();
    const span = Math.max(1, box.height - global.innerHeight);
    return Math.min(1, Math.max(0, -box.top / span));
  }

  function paint() {
    frame = 0;
    if (!gate || !gate.classList.contains('active')) return;
    if (line) {
      const height = document.documentElement.scrollHeight - global.innerHeight;
      line.style.transform = `scaleY(${height > 0 ? Math.min(1, global.scrollY / height).toFixed(4) : 0})`;
    }
    if (!section) return;
    const progress = sectionProgress();
    section.style.setProperty('--orbit-p', progress.toFixed(4));
    const calm = still();
    /* The systems light in turn through the first four fifths; the gate is ready for the last. */
    systems.forEach((system, index) => {
      system.dataset.on = String(calm || progress >= (index + 0.5) / (systems.length + 1.6));
    });
    section.dataset.ready = String(calm || progress > 0.78);
    const scene = art && art.querySelector('nebula-singularity');
    if (scene) scene.progress = progress;
  }
  const schedule = () => { if (!frame) frame = global.requestAnimationFrame(paint); };
  global.addEventListener('scroll', schedule, { passive: true });
  global.addEventListener('resize', schedule);
  if (reduced && reduced.addEventListener) reduced.addEventListener('change', schedule);
  if (typeof MutationObserver === 'function') {
    new MutationObserver(schedule).observe(root, { attributes: true, attributeFilter: ['data-motion'] });
  }

  /*
   * The scene loads when the section comes on screen, not with the page: the
   * stage is sticky for two and a half screens, so the CSS horizon stands in
   * for the moment it takes, and nothing heavy competes with the hero and the
   * entry card while a reader is deciding whether to sign in. A scene the
   * loader takes down for missing its frame budget gives the stage back to
   * the CSS horizon.
   */
  if (section && art && typeof IntersectionObserver === 'function') {
    const near = new IntersectionObserver(entries => {
      if (mounted || !entries.some(entry => entry.isIntersecting) || !global.NebulaVisuals) return;
      mounted = true;
      near.disconnect();
      global.NebulaVisuals.mount('singularity', art).then(drawn => {
        if (drawn && art.dataset.nebulaMounted === 'true') section.dataset.drawn = 'true';
        schedule();
      });
    }, { rootMargin: '0px', threshold: 0 });
    near.observe(section);
    art.addEventListener('nebula-visual-retired', () => { delete section.dataset.drawn; });
  }

  /* The gate dives in before the page moves to the card: a beat of the horizon growing, then the same jump as the bar's Enter. */
  const reticle = section && section.querySelector('.lp-reticle');
  if (reticle) {
    reticle.addEventListener('pointerdown', () => {
      if (still()) return;
      section.classList.remove('is-diving');
      void section.offsetWidth;
      section.classList.add('is-diving');
      global.setTimeout(() => section.classList.remove('is-diving'), 900);
    });
  }

  schedule();
})(window);
