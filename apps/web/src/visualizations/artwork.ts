/*
 * What the design's WebGL pieces share: when they may move, and what a test
 * may read of them.
 *
 * Motion has two owners: the interface's own switch, which applySettings
 * publishes as data-motion on the root element, and the operating system's
 * reduced-motion preference. Either holds a piece to one still frame, with
 * its loop stopped -- a held frame drawn again thirty times a second is the
 * same picture for the GPU's cost -- and either can change while the piece is
 * on screen, so both are followed. A piece that read only the system's
 * preference once carried on animating the largest moving thing on the
 * screen after the reader had turned motion off.
 */

export type ArtworkTag = 'nebula-galaxy' | 'nebula-singularity';
export const ARTWORK_TAGS: readonly ArtworkTag[] = Object.freeze(['nebula-galaxy', 'nebula-singularity']);

const REDUCED = '(prefers-reduced-motion: reduce)';

/* Whether a piece must hold a still frame: the interface's switch is off, or the system asks for less motion. */
export function motionHeld(doc: Document, win: Window): boolean {
  return doc.documentElement.dataset.motion === 'off' || Boolean(win.matchMedia?.(REDUCED).matches);
}

/*
 * Calls `changed` whenever the answer may have changed: the switch thrown on
 * the root, or the system's preference. Answers the way to stop listening.
 */
export function watchMotion(doc: Document, win: Window, changed: () => void): () => void {
  const observer = new MutationObserver(changed);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  const query = win.matchMedia?.(REDUCED);
  query?.addEventListener('change', changed);
  return () => {
    observer.disconnect();
    query?.removeEventListener('change', changed);
  };
}

/* What the browser suite may read of a mounted piece, through the page's probe: never the piece itself. */
export interface ArtworkReading {
  readonly tag: ArtworkTag;
  /* Whether it holds a still frame for the reader's motion setting. */
  readonly held: boolean;
  /* Whether its frame loop is running. */
  readonly running: boolean;
  /* How many frames it has drawn since it was connected. */
  readonly frames: number;
  /* Whether the device refused it a context, so it draws nothing. */
  readonly failed: boolean;
}

export interface ArtworkPiece extends HTMLElement {
  readonly reading: ArtworkReading;
}

const isPiece = (element: Element): element is ArtworkPiece => 'reading' in element;

/* Every piece on the page, as the probe may show it. */
export function readPieces(doc: Document): ArtworkReading[] {
  return [...doc.querySelectorAll(ARTWORK_TAGS.join(', '))].filter(isPiece).map(piece => ({ ...piece.reading }));
}
