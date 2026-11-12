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
 *
 * And a card the reader has scrolled past keeps their place when it is
 * drawn. The Overview does not let the browser anchor scrolling (style.css:
 * a card rebuilt whole is laid out half drawn part way through, and the
 * browser scrolled to make up for a move that never happened), so a card
 * above the reader that lands at a new height carried everything below it
 * up or down the page: the security posture, read late, grows from its one
 * reading line to the whole card, and on a phone the activity feed under it
 * went 878 pixels down the page while the reader was reading it. The place
 * is kept here, where the card is drawn whole: when a card that begins above
 * the top of the reader's view -- scrolled past, or running off the top of
 * the screen -- is drawn, the view moves by however far the first thing
 * below the card moved, so what follows it stays where the reader has it. It
 * is what follows that is measured, not the card: cards share rows of a
 * grid, so a card's body can grow by more than its row does. A card that
 * begins in view fills in where it stands, pushing down what follows, as the
 * browser's own anchoring would have it.
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

/* The element whose scrolling moves `host`, and where the reader's view of it begins. */
function viewOf(host: Element): { readonly scroller: Element; readonly top: number } {
  for (let node = host.parentElement; node; node = node.parentElement) {
    if (/^(?:auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {
      return { scroller: node, top: node.getBoundingClientRect().top };
    }
  }
  /* The page scrolls; a bar fixed over the top of the screen hides what is under it. */
  const bar = host.closest('.page')?.querySelector('.topbar');
  const covered = bar && getComputedStyle(bar).position === 'fixed' ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
  return { scroller: document.scrollingElement ?? document.documentElement, top: covered };
}

/* The first thing laid out below `host` in its scrolling region: a later sibling of the card or of what holds it. */
function followerOf(host: Element, scroller: Element): Element | null {
  const floor = host.getBoundingClientRect().bottom - 0.5;
  for (let node: Element | null = host; node && node !== scroller; node = node.parentElement) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      const box = next.getBoundingClientRect();
      if (box.height > 0 && box.top >= floor) return next;
    }
  }
  return null;
}

/* Draws `host`, and keeps the reader's place when it is a card that begins above their view. */
function drawKeepingPlace(host: Element, draw: () => void): void {
  const view = viewOf(host);
  const above = host.getBoundingClientRect().top < view.top - 0.5;
  const follower = above ? followerOf(host, view.scroller) : null;
  const before = follower?.getBoundingClientRect().top;
  draw();
  if (!follower || before === undefined || !follower.isConnected) return;
  const moved = follower.getBoundingClientRect().top - before;
  if (Math.abs(moved) >= 0.5) view.scroller.scrollTop += moved;
}

/* Draw `host` now, or once the press on its screen is over; either way, keeping the reader's place. */
export function repaintCard(host: Element, draw: () => void): void {
  if (pressed && screenOf(host).contains(pressed)) {
    held.set(host, () => drawKeepingPlace(host, draw));
    return;
  }
  held.delete(host);
  drawKeepingPlace(host, draw);
}
