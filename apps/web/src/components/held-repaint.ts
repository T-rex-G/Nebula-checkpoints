/*
 * A card's repaint, held while the reader is pressing on its screen.
 *
 * The Overview cards are rebuilt whenever a reading they show arrives. A
 * press that lands while its target is rebuilt is no click at all: the
 * browser delivers a click only where the press began and ended on one
 * element, and the pointer went down on the old element and came up on its
 * replacement. So a tap on "Show the numbers", a repository's name or a
 * button, made just as a reading arrived, did nothing.
 *
 * Holding only the card being pressed was not enough. A card above it,
 * rebuilt at another height, carries everything below it up or down the
 * page, and the pointer comes up over whatever has moved under it -- on a
 * phone, where the cards stack, the press on a repository's name came up on
 * the severity beside the one below it.
 *
 * So while a pointer (or Space or Enter) is down anywhere on a screen, the
 * repaints of every card on that screen wait, and run with the latest
 * reading once the press has been delivered: after its click, or a short
 * while after the release when no click comes. A repaint asked for by the
 * click itself is not held -- the press is over by then -- and supersedes
 * the held one, which is dropped rather than drawn over it later.
 */

/* How long a release may wait for its click: a touch can deliver it a moment after the finger lifts. */
const CLICK_GRACE_MS = 400;
/* No press holds a card longer than this, whether or not its release is ever seen. */
const HOLD_LIMIT_MS = 5000;

const held = new Map<Element, () => void>();
let pressed: Node | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let limitTimer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  clearTimeout(releaseTimer);
  clearTimeout(limitTimer);
  pressed = null;
  const draws = [...held.values()];
  held.clear();
  for (const draw of draws) draw();
}

function press(target: EventTarget | null): void {
  if (!(target instanceof Node)) return;
  clearTimeout(releaseTimer);
  clearTimeout(limitTimer);
  pressed = target;
  limitTimer = setTimeout(flush, HOLD_LIMIT_MS);
}

function release(wait: number): void {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(flush, wait);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pointerdown', event => press(event.target), true);
  window.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') press(event.target); }, true);
  window.addEventListener('pointerup', () => release(CLICK_GRACE_MS), true);
  window.addEventListener('pointercancel', () => release(0), true);
  window.addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') release(CLICK_GRACE_MS); }, true);
  /* The press has been delivered: what its handlers repaint is drawn at once, and the held repaints follow it. */
  window.addEventListener('click', () => { pressed = null; release(0); }, true);
}

/*
 * Forgets every repaint waiting for a press, without drawing it: at an
 * identity boundary, what the last reader was shown is purged, and nothing
 * read for them may be drawn afterwards. The press itself is left to end as
 * it would, so the next repaint is held or drawn as usual.
 */
export function discardHeldRepaints(): void {
  held.clear();
}

/* The screen a card is on: the main landmark it sits in, or the card alone outside one. */
function screenOf(host: Element): Element {
  return host.closest('main') || host;
}

/* Draw `host` now, or once the press on its screen is over. */
export function repaintCard(host: Element, draw: () => void): void {
  if (pressed && screenOf(host).contains(pressed)) {
    held.set(host, draw);
    return;
  }
  held.delete(host);
  draw();
}
