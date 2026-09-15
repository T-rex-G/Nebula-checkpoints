/* The landing scene: a video that is allowed to fail without taking the page. */
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
   * All this does is carry a class. The motion itself is CSS, gated on both
   * prefers-reduced-motion and the interface's own switch, so a reader who
   * asked for less motion gets the state and none of the movement. It is
   * wired before the video is looked for, because the scene leans in whether
   * or not a decoder ever agreed to play it.
   */
  const lp = document.querySelector('.lp');
  const card = document.querySelector('.lp-card');
  if (lp && card) {
    /*
     * Not until the reader has actually touched the page.
     *
     * alpha-ui focuses the invitation as soon as the gate is raised, so a
     * lean-in bound to focus alone was applied on the first frame and never
     * came back -- the moment was the resting state, which is no moment at
     * all. A cursor the browser parked in the field is not the reader
     * reaching for it.
     *
     * If they were already focused there when the first gesture lands -- the
     * ordinary case, since they arrive and start typing -- that gesture is
     * what the scene answers.
     */
    let engaged = false;
    const engage = () => {
      if (engaged) return;
      engaged = true;
      if (card.contains(document.activeElement)) lp.classList.add('is-reaching');
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach(name =>
      document.addEventListener(name, engage, { once: true, passive: true }));

    card.addEventListener('focusin', () => { if (engaged) lp.classList.add('is-reaching'); });
    card.addEventListener('focusout', () => {
      if (!card.contains(document.activeElement)) lp.classList.remove('is-reaching');
    });
  }

  const video = document.getElementById('lpVideo');
  if (!video) return;
  const gate = document.getElementById('page-alpha-access');
  const reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = global.navigator && global.navigator.connection;
  let intersecting = typeof IntersectionObserver !== 'function';
  let pendingPlay = false;
  let playGeneration = 0;
  let retry = null;
  const gestures = ['pointerdown', 'keydown', 'touchstart'];

  const eligible = () => document.documentElement.dataset.motion !== 'off'
    && !(reducedMotion && reducedMotion.matches)
    && !(connection && connection.saveData)
    && !document.hidden && intersecting
    && (!gate || (!gate.hidden && gate.classList.contains('active')));

  function clearRetry() {
    if (!retry) return;
    gestures.forEach(name => document.removeEventListener(name, retry));
    retry = null;
  }

  function stop() {
    playGeneration++;
    clearRetry();
    if (pendingPlay || !video.paused) video.pause();
    pendingPlay = false;
  }

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
    // A decoder may deliver `playing` after an outstanding play was stopped.
    // Keep enforcing the preference, including after the first reveal.
    pendingPlay = false;
    if (!eligible()) { stop(); return; }
    if (revealed) return;
    revealed = true;
    video.classList.add('is-playing');
  };
  video.addEventListener('playing', reveal);

  /*
   * Three ways this legitimately never plays, and all of them are fine:
   *  - the reader asked for less motion,
   *  - the build has no decoder for either source (Chromium without
   *    proprietary codecs refuses the H.264 and, without VP9, the WebM too),
   *  - the tab is saving data.
   * In each case the poster stays, which is the same picture holding still.
   */
  const playable = () => !!(video.canPlayType('video/webm; codecs="vp9"')
    || video.canPlayType('video/mp4; codecs="avc1.42E01E"'));

  function attempt(allowRetry = true) {
    if (!eligible()) { stop(); return; }
    if (!playable() || pendingPlay || !video.paused || retry) return;
    const generation = ++playGeneration;
    pendingPlay = true;
    /*
     * Autoplay can be refused even when muted. Rather than argue with the
     * policy, wait for the first gesture of any kind and try once more; a
     * reader who never gestures keeps the poster and loses nothing.
     */
    const refused = () => {
      if (generation !== playGeneration) return;
      pendingPlay = false;
      if (!allowRetry || !eligible()) return;
      retry = () => {
        clearRetry();
        attempt(false);
      };
      gestures.forEach(name =>
        document.addEventListener(name, retry, { once: true, passive: true }));
    };
    try {
      const started = video.play();
      if (started && typeof started.catch === 'function') started.catch(refused);
      else pendingPlay = false;
    } catch (error) { refused(); }
  }

  const sync = () => attempt();

  /*
   * Paused off-screen. The gate is the first screen, so once a reader is past
   * it this element is still in the document and would otherwise keep a
   * decoder running behind the application for the rest of the session.
   */
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(entries => {
      entries.forEach(entry => {
        intersecting = entry.isIntersecting && (entry.intersectionRatio == null || entry.intersectionRatio >= 0.05);
        sync();
      });
    }, { threshold: 0.05 }).observe(video);
  } else {
    attempt();
  }

  /* The motion setting is applied to the root element, so follow it live
     rather than only reading it once at load. */
  if (typeof MutationObserver === 'function') {
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    if (gate) new MutationObserver(sync).observe(gate, { attributes: true, attributeFilter: ['class', 'hidden'] });
  }
  document.addEventListener('visibilitychange', sync);
  if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener('change', sync);
  else if (reducedMotion && reducedMotion.addListener) reducedMotion.addListener(sync);
  if (connection && connection.addEventListener) connection.addEventListener('change', sync);
})(typeof globalThis === 'undefined' ? this : globalThis);
