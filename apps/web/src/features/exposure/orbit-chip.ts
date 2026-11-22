/*
 * Orbit, the status language the security screens share: an outlined chip,
 * the tone on its edge and its glyph, the words in ink, a beam round the
 * edge for the few the eye should go to first. The styles are in style.css.
 * Built from elements and text, never markup.
 */

export const GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  critical: 'M8.6 3.5h6.8l5.1 5.1v6.8l-5.1 5.1H8.6l-5.1-5.1V8.6zM9.4 9.4l5.2 5.2M14.6 9.4l-5.2 5.2',
  serious: 'M12 4l9 15.5H3zM12 10v4.2M12 16.9v.1',
  warning: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 11v5M12 7.9v.1',
  open: 'M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z',
  check: 'M5 12.5l4.2 4.2L19 7',
  shield: 'M12 3.3l7.2 3v5.3c0 4.3-3 7.9-7.2 9.4-4.2-1.5-7.2-5.1-7.2-9.4V6.3zM9.3 12l2 2 3.5-3.8',
  history: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.2h3.2M12 8v4.3l2.8 1.7',
  archive: 'M4 7.5h16v3H4zM5.5 10.5V19h13v-8.5M10 14h4',
  encoded: 'M8.5 7l-5 5 5 5M15.5 7l5 5-5 5',
  off: 'M7 7l10 10M17 7L7 17',
  pending: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2'
});

const SVG = 'http://www.w3.org/2000/svg';

interface ChipNode {
  className: string;
  textContent: string | null;
  readonly dataset: Record<string, string | undefined>;
  setAttribute(name: string, value: string): void;
  appendChild(node: unknown): unknown;
}
export interface ChipDocument {
  createElement(tag: string): ChipNode;
  createElementNS(namespace: string, tag: string): ChipNode;
  createTextNode(text: string): unknown;
}
export interface ChipOptions { readonly glyph?: string; readonly count?: unknown; readonly beam?: boolean; readonly className?: string }

export function orbitChip(doc: ChipDocument, tone: string, word: string, { glyph, count, beam, className }: ChipOptions = {}): ChipNode {
  const chip = doc.createElement('span');
  chip.className = `nv-chip${className ? ` ${className}` : ''}`;
  chip.dataset.tone = tone;
  if (beam) chip.dataset.beam = 'on';
  if (glyph) {
    const svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = doc.createElementNS(SVG, 'path');
    path.setAttribute('d', glyph);
    svg.appendChild(path);
    chip.appendChild(svg);
  }
  if (count !== undefined) {
    const number = doc.createElement('b');
    number.textContent = String(count);
    chip.appendChild(number);
    if (word) chip.appendChild(doc.createTextNode(' '));
  }
  if (word) {
    const text = doc.createElement('span');
    text.textContent = word;
    chip.appendChild(text);
  }
  return chip;
}
