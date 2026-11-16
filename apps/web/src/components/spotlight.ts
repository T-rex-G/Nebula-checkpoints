/*
 * The light that follows a fine pointer across a card.
 *
 * A card lit from where the pointer is: `--mx` and `--my`, the pointer's
 * place in the card's own box, which the stylesheet turns into a soft glow.
 * When the pointer leaves, the light rests at the top centre. Only where the
 * pointer can hover and is precise -- a mouse, a trackpad -- since on a touch
 * screen there is no pointer between presses to follow. Cards added later,
 * as screens draw, are lit as they arrive.
 */

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/* Where the light rests: the top centre. */
export const SPOTLIGHT_REST = Object.freeze(['50%', '0%'] as const);

/* The light's place for a pointer at (x, y), in the card's own box; at rest when the card has no size. */
export function spotlightAt(box: Box, x: number, y: number): readonly [string, string] {
  if (!box.width || !box.height) return [SPOTLIGHT_REST[0], SPOTLIGHT_REST[1]];
  return [`${(((x - box.left) / box.width) * 100).toFixed(1)}%`, `${(((y - box.top) / box.height) * 100).toFixed(1)}%`];
}

interface Card {
  readonly dataset: { spot?: string };
  readonly style: { setProperty(name: string, value: string): void };
  getBoundingClientRect(): Box;
  addEventListener(type: 'mousemove', listener: (event: { readonly clientX: number; readonly clientY: number }) => void): void;
  addEventListener(type: 'mouseleave', listener: () => void): void;
}

/* Light one card; a card already lit is left as it is. */
export function attachSpotlight(card: Card): void {
  if (card.dataset.spot) return;
  card.dataset.spot = '1';
  card.addEventListener('mousemove', event => {
    const [x, y] = spotlightAt(card.getBoundingClientRect(), event.clientX, event.clientY);
    card.style.setProperty('--mx', x);
    card.style.setProperty('--my', y);
  });
  card.addEventListener('mouseleave', () => {
    card.style.setProperty('--mx', SPOTLIGHT_REST[0]);
    card.style.setProperty('--my', SPOTLIGHT_REST[1]);
  });
}

/* Every card on the page lit, now and as cards are added, where the pointer is fine. */
export function watchSpotlights(document: Document, view: { matchMedia(query: string): { readonly matches: boolean }; readonly MutationObserver: typeof MutationObserver }): void {
  if (!view.matchMedia('(hover:hover) and (pointer:fine)').matches) return;
  const light = (node: Node): void => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches('.card')) attachSpotlight(node);
    node.querySelectorAll<HTMLElement>('.card').forEach(attachSpotlight);
  };
  document.querySelectorAll<HTMLElement>('.card').forEach(attachSpotlight);
  new view.MutationObserver(records => {
    for (const record of records) record.addedNodes.forEach(light);
  }).observe(document.body, { childList: true, subtree: true });
}
