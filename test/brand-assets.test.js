'use strict';

/*
 * The brand assets are generated, so what has to hold is that they were
 * generated from the mark this product actually uses.
 *
 * They were not. The home-screen icon was still the previous brand -- a ring
 * with a teal dot, in two colours the interface no longer contains and a shape
 * that is not the N at all -- and nothing in the suite noticed, because
 * nothing looked. An icon is the one piece of a product a person sees before
 * they open it; it is worth a check.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'public', 'assets');
const icon = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8'));

/*
 * The four planes the dimensional mark extrudes, as they appear in the sprite
 * the sidebar and the sign-in hero draw from. The icon has to be the same
 * geometry, not a resemblance of it.
 */
const PLANES = [
  'M79 25 L40 217 L106 116 Z',
  'M79 25 L106 116 L171 112 Z',
  'M244 23 L178 124 L205 215 Z',
  'M178 124 L113 128 L205 215 Z'
];
for (const plane of PLANES) {
  assert.ok(icon.includes(plane), `the app icon is missing a plane of the mark: ${plane}`);
  assert.ok(html.includes(plane), `the interface sprite is missing a plane of the mark: ${plane}`);
}

/* The previous brand, in every form it was written in. */
const RETIRED = ['#38e0c8', '#7c6cff', '56,224,200', '124,108,255'];
for (const colour of RETIRED) {
  assert.ok(!icon.toLowerCase().includes(colour.toLowerCase()),
    `the app icon still carries a retired brand colour: ${colour}`);
}

/* Every icon the manifest promises exists, and none is a leftover stub. */
for (const entry of manifest.icons) {
  const file = path.join(root, 'public', entry.src.replace(/^\//, ''));
  assert.ok(fs.existsSync(file), `${entry.src} is declared in the manifest and missing on disk`);
  const size = fs.statSync(file).size;
  assert.ok(size > 400, `${entry.src} is ${size} bytes, which is too small to be the drawn mark`);
}
assert.ok(fs.existsSync(path.join(assets, 'apple-touch-icon.png')), 'the touch icon is missing');

/*
 * The chrome a phone paints around the app matches the page it frames. These
 * drifted from the palette and left a strip of the previous background above
 * and below the app on a phone.
 */
const PAGE_DARK = '#06030F';
const PAGE_LIGHT = '#F5F3FB';
assert.equal(manifest.background_color.toUpperCase(), PAGE_DARK);
assert.equal(manifest.theme_color.toUpperCase(), PAGE_DARK);
assert.ok(html.includes(`content="${PAGE_DARK}"`), 'the dark theme colour is not the page colour');
assert.ok(html.includes(`content="${PAGE_LIGHT}"`), 'the light theme colour is not the page colour');

/*
 * Obsidian is the second design preset. Its page colours are painted into the
 * same meta tag at boot and on every switch, from one table in each script.
 */
const OBSIDIAN_DARK = '#07080A';
const OBSIDIAN_LIGHT = '#F4F2EE';
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'theme-boot.js'), 'utf8');
for (const [name, source] of [['app.js', appSource], ['theme-boot.js', bootSource]]) {
  for (const colour of [PAGE_DARK, PAGE_LIGHT, OBSIDIAN_DARK, OBSIDIAN_LIGHT]) {
    assert.ok(source.includes(`'${colour}'`), `${name} does not paint ${colour} for its preset`);
  }
}

process.stdout.write('brand asset tests passed\n');
