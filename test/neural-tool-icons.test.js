'use strict';

/*
 * Two of the graph's tool buttons drew nothing at all in dark mode.
 *
 * There was no rule styling the icons inside `.neural-tool`, so a bare
 * `<svg><path>` fell back to the SVG default of a black fill and no stroke.
 * Against the dark button that is invisible; against the light one it is a
 * filled smudge where an outline was intended, which is why it read as "works
 * in light, broken in dark" rather than as broken everywhere.
 *
 * The buttons also never centred their contents, so every icon sat on the text
 * baseline, 1.5px above the middle of its own button, and the one text glyph
 * among them centred differently again.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const neural = fs.readFileSync(path.join(root, 'public', 'neural.js'), 'utf8');

/* The buttons centre what they hold. */
const toolRule = css.match(/\.neural-tool\{[^}]*\}/);
assert(toolRule, 'the tool button must have a style rule');
for (const property of ['display:inline-flex', 'align-items:center', 'justify-content:center']) {
  assert(toolRule[0].includes(property), `tool buttons must centre their contents (${property})`);
}

/* Their icons are stroked outlines rather than the browser's default black
 * fill, which is what made them vanish against the dark button. */
const iconRule = css.match(/\.neural-tool > svg\{[^}]*\}/);
assert(iconRule, 'tool icons must be styled, or a bare path falls back to a black fill');
assert(iconRule[0].includes('fill:none'), 'tool icons must not use the default fill');
assert(iconRule[0].includes('stroke:currentColor'), 'tool icons must stroke in the button colour');
assert(/\.neural-tool > svg\.nt-filled\{[^}]*fill:currentColor/.test(css),
  'the solid icons must keep their fill');

/* Every icon in the tool stack is covered: it either carries the solid class or
 * is a plain outline the rule above reaches. An icon that opts out with its own
 * black fill would be invisible again. */
const tools = markup.match(/<div class="neural-stage-tools">[\s\S]*?<\/div>/);
assert(tools, 'the tool stack must exist in the shell');
const svgs = [...tools[0].matchAll(/<svg([^>]*)>/g)].map(match => match[1]);
assert(svgs.length >= 4, `expected the tool icons, found ${svgs.length}`);
for (const attributes of svgs) {
  const filled = /class="[^"]*\bnt-filled\b/.test(attributes);
  const declaresOwnFill = /\sfill="(?!none)/.test(attributes);
  assert(
    filled || !declaresOwnFill,
    `a tool icon declares its own fill without the solid class: <svg${attributes}>`
  );
}

/* The pause control rebuilds its own markup, so the class has to be in that
 * string too or the icon changes shape after the first toggle. */
const toggleStart = neural.indexOf('function togglePause(');
assert(toggleStart > 0, 'the play control must rebuild its icon');
const toggleBody = neural.slice(toggleStart, neural.indexOf('\n  }', toggleStart));
const rebuilt = [...toggleBody.matchAll(/'<svg([^>]*)>/g)].map(match => match[1]);
assert.strictEqual(rebuilt.length, 2, `the play control must rebuild exactly two icon states, found ${rebuilt.length}`);
for (const attributes of rebuilt) {
  assert(
    /class="[^"]*\bnt-filled\b/.test(attributes),
    `a rebuilt tool icon is missing the solid class: <svg${attributes}>`
  );
}

/* Enlarge and fit sit next to each other. This compares the path data, so it
 * catches a literal duplicate and not two icons that merely look alike -- which
 * is what they were before, both drawn as outward corner brackets. That one
 * needed an eye, and got one. */
const grow = markup.match(/class="nt-grow"[^>]*>\s*<path d="([^"]+)"/);
const fit = markup.match(/id="neuralFitBtn"[\s\S]*?<path d="([^"]+)"/);
assert(grow && fit, 'both the enlarge and fit icons must be present');
assert.notStrictEqual(grow[1], fit[1], 'enlarge and fit must not draw the same icon');

console.log('neural tool icon tests passed');
