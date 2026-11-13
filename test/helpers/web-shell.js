'use strict';
/*
 * What the page loads and what the service worker keeps, read from the build's
 * own inputs and outputs.
 *
 * A browser file used to be part of the page because index.html named it in a
 * <script> tag, and part of the offline shell because sw.js listed it beside a
 * version stamp. Both are now facts of the build: a module is on the page when
 * the entry imports it, itself or through a module it imports, and in the
 * shell when the chunk that holds it is in the worker's generated list. These
 * helpers answer those two questions, so a contract test keeps asserting the
 * property rather than a tag that no longer exists.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'apps', 'web', 'src', 'main.js');
const BUILT = path.join(ROOT, 'dist', 'web');

const SCRIPT = /\.(?:[cm]?js|tsx?)$/;

/*
 * Root-relative paths of the page's script modules, in the order the browser
 * evaluates them: each after every module it imports, from the entry down,
 * read from the syntax tree of each. A module the page loads on demand, with
 * import(), is not among them until it is asked for, and an import of types
 * alone loads nothing.
 */
function pageGraph() {
  const order = [];
  const packages = new Set();
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
    for (const statement of tree.statements) {
      const from = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
      if (!from || !ts.isStringLiteral(from)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause && statement.importClause.isTypeOnly) continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      if (!from.text.startsWith('.')) packages.add(from.text);
      else if (SCRIPT.test(from.text)) visit(path.resolve(path.dirname(file), from.text));
    }
    order.push(path.relative(ROOT, file).split(path.sep).join('/'));
  };
  visit(ENTRY);
  return { order, packages };
}

function shellImports() {
  return pageGraph().order;
}

/* The packages the page's modules import by name, a library's own files (codemirror/mode/...) included. */
function pagePackages() {
  return [...pageGraph().packages].sort();
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

module.exports = { ROOT, shellImports, pagePackages, loadsInShell, builtShell };
