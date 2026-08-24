'use strict';

/*
 * A mark for each repository, drawn from its own name.
 *
 * The inventory used to be a wall of identically-shaped cards, and telling two
 * apart meant reading. A mark gives each one something to recognise at a
 * glance, and this one is derived rather than chosen: the same repository
 * always draws the same sigil, on every device and every session, with nothing
 * stored and nothing fetched. It is decoration beside the name, never a
 * substitute for it -- the cards stay readable with images off and the marks
 * are hidden from assistive technology.
 *
 * The geometry is the product's own: folded facets radiating from a centre,
 * the same language as the brand mark rather than a generic identicon grid.
 */
(function repoSigilModule(global) {
  /*
   * FNV-1a. Chosen because it is short enough to read, has no dependencies,
   * and spreads single-character differences across the whole word -- names in
   * an inventory differ by very little ("api" and "api-2"), and a hash that
   * kept those bits adjacent would draw them as near-identical marks.
   */
  function hash(text) {
    let value = 2166136261;
    const input = String(text);
    for (let index = 0; index < input.length; index += 1) {
      value ^= input.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  }

  /*
   * Hues sampled from the palette rather than the whole wheel: a mark that can
   * be any colour stops reading as part of this product. Every entry is a hue
   * the interface already uses.
   */
  const HUES = Object.freeze([258, 268, 280, 292, 316, 190, 172, 38]);
  const FACET_MIN = 3;
  const FACET_RANGE = 3;

  function plan(name) {
    const seed = hash(name);
    const hue = HUES[seed % HUES.length];
    const hueLift = HUES[(seed >>> 5) % HUES.length];
    const facets = FACET_MIN + ((seed >>> 11) % FACET_RANGE);
    /*
     * Quantised. A free rotation produced pairs nine degrees apart, which is a
     * difference no one perceives at the size these are drawn: two marks then
     * read as the same mark. On a fifteen-step grid two sigils either sit at
     * the same rotation -- and are told apart by their wedges, which are drawn
     * from different bits -- or sit far enough apart to be seen.
     */
    const spin = ((seed >>> 14) % 15) * 24;
    const step = 360 / facets;

    const wedges = [];
    for (let index = 0; index < facets; index += 1) {
      /* Each facet takes its own bits, so two marks that share a facet count
         still differ in the shape of every wedge. */
      const bits = seed >>> (index * 3 % 17);
      const lean = (bits % 18) - 9;
      /*
       * Sized to the box it is drawn in: 48 units across, centre at 24, so a
       * facet can reach 20 before it leaves the frame. The first version
       * reached as far as 37 and was quietly clipped, which is part of why the
       * marks read as scattered slivers rather than as one shape.
       */
      const reach = 13 + (bits >>> 4) % 8;
      const waist = 30 + (bits >>> 8) % 22;
      wedges.push(Object.freeze({
        angle: (spin + index * step) % 360,
        lean, reach, waist,
        deep: ((bits >>> 12) & 1) === 1
      }));
    }
    return Object.freeze({ seed, hue, hueLift, facets, spin, wedges: Object.freeze(wedges) });
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CENTRE = 24;

  function point(angle, radius) {
    const radians = (angle - 90) * Math.PI / 180;
    return [
      Math.round((CENTRE + Math.cos(radians) * radius) * 10) / 10,
      Math.round((CENTRE + Math.sin(radians) * radius) * 10) / 10
    ];
  }

  function render(name, document_) {
    const doc = document_ || (typeof document === 'object' ? document : null);
    if (!doc) return null;
    const shape = plan(name);
    const root = doc.createElementNS(SVG_NS, 'svg');
    root.setAttribute('class', 'repo-sigil');
    root.setAttribute('viewBox', '0 0 48 48');
    /* Decoration beside the name it belongs to, so it is not announced. */
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('focusable', 'false');

    /*
     * The facets meet at the core rather than floating around it. Drawn with
     * their bases held out at 42% of their own reach, they read as an
     * asterisk of loose slivers; brought in to a common hinge they read as one
     * folded shape, which is the language the brand mark is drawn in.
     */
    const HINGE = 7.4;
    for (const wedge of shape.wedges) {
      const tip = point(wedge.angle + wedge.lean, wedge.reach);
      const left = point(wedge.angle - wedge.waist, HINGE);
      const right = point(wedge.angle + wedge.waist, HINGE);
      const facet = doc.createElementNS(SVG_NS, 'polygon');
      facet.setAttribute('points', `${tip[0]},${tip[1]} ${left[0]},${left[1]} ${right[0]},${right[1]}`);
      facet.setAttribute('fill', `hsl(${wedge.deep ? shape.hue : shape.hueLift} 74% ${wedge.deep ? 50 : 70}%)`);
      facet.setAttribute('fill-opacity', wedge.deep ? '0.95' : '0.78');
      root.appendChild(facet);

      /*
       * A second plane folded off the first, in the paired tone the brand mark
       * uses. One triangle per direction read as a sparkle; a pair reads as a
       * surface with an edge, which is the shape this product is drawn in.
       */
      const fold = doc.createElementNS(SVG_NS, 'polygon');
      const crease = point(wedge.angle + wedge.lean, wedge.reach * 0.52);
      fold.setAttribute('points', `${tip[0]},${tip[1]} ${crease[0]},${crease[1]} ${right[0]},${right[1]}`);
      fold.setAttribute('fill', `hsl(${wedge.deep ? shape.hueLift : shape.hue} 74% ${wedge.deep ? 72 : 48}%)`);
      fold.setAttribute('fill-opacity', '0.6');
      root.appendChild(fold);
    }

    const core = doc.createElementNS(SVG_NS, 'circle');
    core.setAttribute('cx', String(CENTRE));
    core.setAttribute('cy', String(CENTRE));
    core.setAttribute('r', '4.2');
    core.setAttribute('fill', `hsl(${shape.hue} 80% 74%)`);
    root.appendChild(core);
    return root;
  }

  global.NebulaRepoSigil = Object.freeze({ hash, plan, render, HUES });
})(typeof globalThis === 'object' ? globalThis : window);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaRepoSigil;
