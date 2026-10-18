/*
 * The landing's singularity section, driven by the scroll.
 *
 * The section is taller than the screen and its stage is sticky, so how far
 * the reader has scrolled through it is a number from 0 to 1. The section
 * opens on the arc the hero ends with, and the arc is the black hole's edge:
 * this file measures it once (its apex and radius, from the stage's size) and
 * hands the same two numbers to the CSS that draws it before the scene loads
 * and to <nebula-singularity> that draws it after, so the two meet exactly.
 * As the reader scrolls, the space around the hole darkens (--orbit-sky:
 * on paper the page goes dark as it crosses the horizon), the camera pulls
 * back, the six systems light one by one, and the gate readies at the end.
 * The scene is fetched through the visuals loader, which first asks whether
 * this device can draw it; without it the stage keeps its CSS horizon.
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
  const stage = section && section.querySelector('.lp-orbit-stick');
  const systems = section ? [...section.querySelectorAll('.lp-system')] : [];
  let frame = 0;
  let mounted = false;
  let arc = null;

  const smooth = value => { const v = Math.min(1, Math.max(0, value)); return v * v * (3 - 2 * v); };

  /*
   * The arc, from the stage's own size: its apex a tenth of the way down
   * (between 84px and 130px on a desk, a little lower on a phone, where the
   * curve is shallower) and a radius wide enough that it reads as a horizon
   * rather than a ball -- three quarters of a desk's width, more than a
   * phone's whole width so the curve stays shallow there. The apex is close
   * to the section's top because everything above it is the hero's own
   * ground: at a fifth of the way down it left a band of empty dark between
   * the path and the horizon. A desk-width screen that is far taller than it
   * is wide (a tablet upright, a phone showing the desktop site) keeps the
   * apex at the low end too: a tenth of that height is a band of its own.
   */
  function measureArc() {
    if (!stage) return null;
    const width = stage.clientWidth || global.innerWidth;
    const height = stage.clientHeight || global.innerHeight;
    const narrow = width < 700;
    const tall = !narrow && height > width * 1.45;
    const top = Math.round(narrow ? Math.min(120, Math.max(72, height * 0.12)) : tall ? 88 : Math.min(130, Math.max(84, height * 0.1)));
    const radius = Math.round(narrow ? Math.max(width * 1.35, height * 0.72) : Math.max(width * 0.78, height * 0.92));
    stage.style.setProperty('--arc-top', `${top}px`);
    stage.style.setProperty('--arc-r', `${radius}px`);
    return { top, radius, width, height };
  }

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
    if (!arc) arc = measureArc();
    const progress = sectionProgress();
    section.style.setProperty('--orbit-p', progress.toFixed(4));
    /* The sky closes in over the first steps past the horizon, and opens to the page again as the section leaves. */
    section.style.setProperty('--orbit-sky', smooth(progress / 0.16).toFixed(4));
    section.style.setProperty('--orbit-tail', smooth((progress - 0.955) / 0.045).toFixed(4));
    /* The fallback pulls back with the scene: from the arc to a disc in the middle of the stage. */
    section.style.setProperty('--orbit-pull', smooth((progress - 0.12) / 0.3).toFixed(4));
    const calm = still();
    /* The systems light in turn once the hole has settled, through to the last fifth; the gate is ready for the last. */
    systems.forEach((system, index) => {
      system.dataset.on = String(calm || progress >= 0.3 + index * (0.46 / Math.max(1, systems.length - 1)));
    });
    section.dataset.ready = String(calm || progress > 0.8);
    const scene = art && art.querySelector('nebula-singularity');
    if (scene) {
      if (arc && scene.horizon === null) scene.horizon = arc;
      scene.progress = progress;
    }
  }
  const schedule = () => { if (!frame) frame = global.requestAnimationFrame(paint); };
  const remeasure = () => {
    arc = measureArc();
    const scene = art && art.querySelector('nebula-singularity');
    if (scene && arc) scene.horizon = arc;
    schedule();
  };
  global.addEventListener('scroll', schedule, { passive: true });
  global.addEventListener('resize', remeasure);
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
        const scene = art.querySelector('nebula-singularity');
        if (scene && arc) scene.horizon = arc;
        if (drawn && art.dataset.nebulaMounted === 'true') section.dataset.drawn = 'true';
        schedule();
      });
    }, { rootMargin: '0px 0px -25% 0px', threshold: 0 });
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
