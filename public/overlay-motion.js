/* Nebulaverse-X overlay motion — how a dialog, drawer, sheet or panel leaves. */
'use strict';
(function universal(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NebulaOverlayMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildOverlayMotion() {
  /*
   * Every overlay in this app opened with an animation and closed with none:
   * `hidden = true`, a cut. The dismissal is the half a reader actually
   * watches -- the open happens while their attention is still travelling to
   * it -- so the cut was the rough edge on all six layers.
   *
   * Closing marks the layer `data-closing` so the stylesheet can run an exit
   * that retraces the entry, and hides it once that exit is over. Three things
   * make deferring the hide safe rather than merely prettier:
   *
   * - How long to wait is read back out of the computed style of the closing
   *   element. A duration restated in script would be a second source of truth
   *   that agrees with the stylesheet only by luck, and the one time they
   *   disagreed the layer would either blink out mid-fade or hang on screen
   *   after it had finished.
   * - A timer ends the wait, not `animationend` alone. No animation runs on an
   *   element inside a `display:none` ancestor, so that event can simply never
   *   arrive -- and an exit that never finishes leaves a full-screen scrim over
   *   the page with nothing left to dismiss it, which reads as a frozen app.
   *   The timer is the floor under that, and it is the reason this is safe to
   *   do at all.
   * - Reopening cancels the pending close, so a layer raised again during its
   *   own exit is not hidden a moment later by the dismissal it had begun.
   *
   * With motion off the stylesheet drops the exit, the measured duration is
   * zero, and the close is synchronous. One rule decides both, so there is no
   * setting in which the script and the stylesheet disagree about whether an
   * animation is running.
   */

  /* CSS time lists are comma-separated and may mix s and ms; the longest is
     the one the element is actually still busy for. */
  function longestTimeMs(value) {
    return String(value == null ? '' : value).split(',').reduce(function (max, part) {
      const text = part.trim();
      const amount = parseFloat(text);
      if (!isFinite(amount)) return max;
      return Math.max(max, /ms$/.test(text) ? amount : amount * 1000);
    }, 0);
  }

  /*
   * The margin absorbs the gap between the frame an animation is judged to end
   * on and the frame its event is delivered on. Whenever the event arrives at
   * all it is the event that ends the wait, so this only ever decides the
   * outcome in the cases where no event is coming.
   */
  const SETTLE_MARGIN_MS = 120;

  function createOverlayMotion(options) {
    const settings = options || {};
    const readStyle = settings.getComputedStyle ||
      (typeof getComputedStyle === 'function' ? getComputedStyle : null);
    const schedule = settings.setTimeout ||
      (typeof setTimeout === 'function' ? setTimeout : null);
    const unschedule = settings.clearTimeout ||
      (typeof clearTimeout === 'function' ? clearTimeout : null);
    const pending = new WeakMap();
    /*
     * A second view of the same set, countable. A WeakMap can answer "is this
     * layer closing?" but not "is anything closing?", and the caller that needs
     * the second question is the page transition: a document-wide View
     * Transition snapshots every pixel, so starting one while a layer is
     * sliding out captures it mid-flight and cross-fades the frozen frame over
     * the real animation. Entries are added and removed together with the
     * WeakMap's, on every path including the timer.
     */
    const closing = new Set();

    /* Measured after `data-closing` is on the element, so it reads the exit
       the stylesheet chose for this particular layer -- not a number here. */
    function exitDurationMs(el) {
      if (!readStyle || !el) return 0;
      let style;
      try { style = readStyle(el); } catch (unstyled) { return 0; }
      if (!style) return 0;
      const name = style.animationName;
      if (!name || name === 'none') return 0;
      return longestTimeMs(style.animationDuration) + longestTimeMs(style.animationDelay);
    }

    function cancelOverlayExit(el) {
      if (!el) return;
      const exit = pending.get(el);
      closing.delete(el);
      if (exit) {
        if (unschedule) unschedule(exit.timer);
        if (typeof el.removeEventListener === 'function') {
          el.removeEventListener('animationend', exit.onEnd);
        }
        pending.delete(el);
      }
      if (typeof el.removeAttribute === 'function') el.removeAttribute('data-closing');
      if ('inert' in el) el.inert = false;
    }

    /*
     * A layer part-way through its exit is already dismissed as far as the
     * reader is concerned. Every "is this still open?" test reads this, so a
     * dialog cancelled mid-fade cannot take focus back, trap Tab, or swallow
     * the Escape meant for the layer underneath it.
     */
    function overlayOpen(el) {
      return !!el && !el.hidden &&
        (typeof el.hasAttribute !== 'function' || !el.hasAttribute('data-closing'));
    }

    function openOverlay(el) {
      if (!el) return;
      cancelOverlayExit(el);
      // Reopening a still-painted layer can coalesce exit and entry into the
      // same computed style, leaving its completed entrance animation in place.
      // Flush a hidden layout once per reopen; restore it before the next paint.
      // The stylesheet still decides whether motion is allowed at all.
      if (!el.hidden && typeof el.getBoundingClientRect === 'function') {
        el.hidden = true;
        el.getBoundingClientRect();
      }
      el.hidden = false;
    }

    function closeOverlay(el, onSettled) {
      const settled = function () { if (typeof onSettled === 'function') onSettled(); };
      if (!el) { settled(); return; }
      if (el.hidden) { cancelOverlayExit(el); settled(); return; }
      cancelOverlayExit(el);
      if (typeof el.setAttribute === 'function') el.setAttribute('data-closing', '');
      const settle = function () { cancelOverlayExit(el); el.hidden = true; settled(); };
      const wait = exitDurationMs(el);
      /*
       * A layer on its way out is gone as far as the reader is concerned, so
       * it leaves the accessibility tree and the focus order when the close
       * starts, not when the animation ends. Holding a dismissed dialog in the
       * tree for the length of a fade means a screen reader can still be
       * offered controls inside it -- the command palette left an empty
       * listbox there, which is a critical fault and not a cosmetic one.
       *
       * `inert` is what does that. `aria-hidden` alone would not: it does not
       * move focus, and aria-hidden laid over the element that still has focus
       * is itself a violation, so it trades one fault for another.
       *
       * Where `inert` does not exist there is no way to take a layer out of
       * the tree while it is still painted, so the exit is given up and the
       * layer is hidden at once -- the behaviour it had before any of this.
       * A dismissal that is slightly abrupt is a fair price; a dialog a screen
       * reader can still hear after it has been dismissed is not.
       */
      if (!wait || !schedule || !('inert' in el)) { settle(); return; }
      el.inert = true;
      const onEnd = function (event) { if (!event || event.target === el) settle(); };
      if (typeof el.addEventListener === 'function') el.addEventListener('animationend', onEnd);
      const timer = schedule(settle, wait + SETTLE_MARGIN_MS);
      pending.set(el, { timer: timer, onEnd: onEnd });
      closing.add(el);
    }

    /*
     * True while any layer is still animating out. Read by the page transition,
     * which must not lay a whole-document cross-fade over a moving overlay.
     */
    function anyOverlayClosing() { return closing.size > 0; }

    return { overlayOpen, openOverlay, closeOverlay, cancelOverlayExit, exitDurationMs, anyOverlayClosing };
  }

  return { createOverlayMotion, longestTimeMs, SETTLE_MARGIN_MS };
});
