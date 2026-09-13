/* The landing scene: a video that is allowed to fail without taking the page. */
'use strict';

(function landingStage(global) {
  const video = document.getElementById('lpVideo');
  if (!video) return;

  /*
   * Revealed on `playing`, never on `canplay` or `loadedmetadata`.
   *
   * Those two fire while the first frame may still not be composited, so
   * revealing there can flash a black rectangle over the poster that is
   * already showing the same scene. `playing` is the only event that promises
   * frames are on screen. Until it arrives the poster carries the page, which
   * is why the poster is a real frame of the video rather than a placeholder.
   */
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    video.classList.add('is-playing');
  };
  video.addEventListener('playing', reveal, { once: true });

  /*
   * Three ways this legitimately never plays, and all of them are fine:
   *  - the reader asked for less motion,
   *  - the build has no decoder for either source (Chromium without
   *    proprietary codecs refuses the H.264 and, without VP9, the WebM too),
   *  - the tab is saving data.
   * In each case the poster stays, which is the same picture holding still.
   */
  const motionOff = () => document.documentElement.dataset.motion === 'off'
    || (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const playable = () => !!(video.canPlayType('video/webm; codecs="vp9"')
    || video.canPlayType('video/mp4; codecs="avc1.42E01E"'));

  function attempt() {
    if (motionOff() || !playable()) return;
    const started = video.play();
    if (!started || typeof started.catch !== 'function') return;
    /*
     * Autoplay can be refused even when muted. Rather than argue with the
     * policy, wait for the first gesture of any kind and try once more; a
     * reader who never gestures keeps the poster and loses nothing.
     */
    started.catch(() => {
      const retry = () => {
        video.play().catch(() => {});
        ['pointerdown', 'keydown', 'touchstart'].forEach(name =>
          document.removeEventListener(name, retry));
      };
      ['pointerdown', 'keydown', 'touchstart'].forEach(name =>
        document.addEventListener(name, retry, { once: true, passive: true }));
    });
  }

  /*
   * Paused off-screen. The gate is the first screen, so once a reader is past
   * it this element is still in the document and would otherwise keep a
   * decoder running behind the application for the rest of the session.
   */
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) attempt();
        else if (!video.paused) video.pause();
      });
    }, { threshold: 0.05 }).observe(video);
  } else {
    attempt();
  }

  /* The motion setting is applied to the root element, so follow it live
     rather than only reading it once at load. */
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (motionOff()) video.pause();
      else attempt();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  }
})(typeof globalThis === 'undefined' ? this : globalThis);
