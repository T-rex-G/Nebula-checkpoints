'use strict';
/*
 * What the page loads and what the service worker keeps, read from the build's
 * own inputs and outputs.
 *
 * A browser file used to be part of the page because index.html named it in a
 * <script> tag, and part of the offline shell because sw.js listed it beside a
 * version stamp. Both are now facts of the build: a module is on the page when
 * the entry imports it, and in the shell when the chunk that holds it is in the
 * worker's generated list. These helpers answer those two questions, so a
 * contract test keeps asserting the property rather than a tag that no longer
 * exists.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'apps', 'web', 'src', 'main.js');
const BUILT = path.join(ROOT, 'dist', 'web');

/* Root-relative paths the entry imports, in order. */
function shellImports() {
  const source = fs.readFileSync(ENTRY, 'utf8');
  return [...source.matchAll(/^import\s+(?:[^'"]+\s+from\s+)?'(\.[^']+)';$/gm)]
    .map(match => path.relative(ROOT, path.resolve(path.dirname(ENTRY), match[1])).split(path.sep).join('/'));
}

function loadsInShell(relativePath) {
  return shellImports().includes(relativePath);
}

/* The built worker's precache list, and the entry chunk the built page loads. */
function builtShell() {
  const page = fs.readFileSync(path.join(BUILT, 'index.html'), 'utf8');
  const worker = fs.readFileSync(path.join(BUILT, 'sw.js'), 'utf8');
  const entry = (/<script type="module" crossorigin src="([^"]+)"><\/script>/.exec(page) || [])[1];
  const stylesheet = (/<link rel="stylesheet" crossorigin href="([^"]+)">/.exec(page) || [])[1];
  const quoted = url => ['"', "'", '`'].some(quote => worker.includes(`${quote}${url}${quote}`));
  return { page, worker, entry, stylesheet, precaches: quoted };
}

module.exports = { ROOT, shellImports, loadsInShell, builtShell };
