'use strict';

/*
 * The artwork's supply chain, read off the build.
 *
 * Every failure this guards has the same shape: a piece that ships in the
 * wrong place -- in the first paint, warmed by the worker, under a name that
 * outlives its contents -- which shows up as a slow or stale page rather than
 * as an error anyone traces. So each check reads the built page the server
 * serves, not the text of its source.
 *
 * What the loader asks before anything downloads -- the device, the reader's
 * data saver, the frames the page keeps -- is asked of it directly
 * (test/visuals-loader.test.js); that the pieces are reached only through it,
 * and three.js only through them, is a rule over the page's import graph
 * (test/module-boundaries.test.js); that each piece is decoration and holds
 * still for the reader's motion setting is read in the browser
 * (test/e2e/nebula-visuals.spec.js).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const visualsRoot = path.join(root, 'apps', 'web', 'src', 'visualizations');
const built = path.join(root, 'dist', 'web');
const { builtShell } = require('./helpers/web-shell');

const PIECES = ['nebula-galaxy', 'nebula-singularity'];

/* The Trust core is SVG in both presets; the WebGL mark is retired and does not ship. */
for (const retired of ['nebula-mark-3d.js', 'nebula-mark-3d.ts']) {
  assert(!fs.existsSync(path.join(visualsRoot, retired)), `the retired WebGL mark is still shipped (${retired})`);
}

/*
 * three.js is pinned to the version the artwork was written for and built
 * into one chunk of its own: no import map, so no inline script and no
 * relaxing of script-src.
 */
assert.strictEqual(require('../package.json').dependencies.three, '0.185.1', 'three.js must stay pinned to the version the artwork was written for');
const chunks = fs.readdirSync(path.join(built, 'build'));
const library = chunks.filter(file => /^three\.module-.+\.js$/.test(file));
assert.strictEqual(library.length, 1, 'three.js must be one chunk of its own');

/* The static imports of a built chunk, as the browser resolves them from the build directory. */
function staticImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:^|[;}])import\s*(?:[\w$*{}\s,]+from\s*)?["']([^"']+)["']/g)].map(match => match[1]);
}

/*
 * Each piece is a chunk named by its content and cached for a year, which
 * reaches three.js and the entry -- already on the page, holding the loader
 * and the motion rules the pieces share -- and no other chunk.
 */
const { webCacheControl } = require('../apps/api/src/platform/release/web-build.ts');
const shell = builtShell();
const entryName = path.basename(shell.entry);
for (const piece of PIECES) {
  const chunk = chunks.find(file => file.startsWith(`${piece}-`));
  assert(chunk && /-[A-Za-z0-9_-]{8}\.js$/.test(chunk), `${piece} must be built under a content-hashed name`);
  assert.deepStrictEqual(staticImports(path.join(built, 'build', chunk)).map(specifier => path.basename(specifier)).sort(), [entryName, library[0]].sort(),
    `${piece} must import only the library it draws with and the entry it is loaded from`);
  assert.strictEqual(webCacheControl(built, path.join(built, 'build', chunk)), 'public, max-age=31536000, immutable');
}
assert.strictEqual(webCacheControl(built, path.join(built, 'theme-boot.js')), 'no-cache',
  'a file whose name does not change with its contents must be revalidated');

/* The entry never imports the artwork or three.js statically: a page that never draws one never downloads it. */
const entry = path.join(built, shell.entry.replace(/^\//, ''));
assert(!staticImports(entry).some(specifier => /three|nebula-galaxy|nebula-singularity/.test(specifier)),
  'the entry must not import the artwork or three.js statically');

/*
 * The worker precaches the entry, which holds the loader, and does not warm
 * the heavy pieces: warming them would spend the whole download on install,
 * for every reader, including the ones who never open a screen that draws them.
 */
assert(shell.precaches(shell.entry), 'the worker must precache the entry, which holds the artwork loader');
for (const heavy of ['three.module-', ...PIECES.map(piece => `${piece}-`)]) {
  assert(!shell.worker.includes(`/build/${heavy}`), `${heavy} must not be warmed on install; it is cached on first use`);
}

console.log('nebula visuals contract tests passed');
