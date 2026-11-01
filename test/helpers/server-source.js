'use strict';
/*
 * The server's composition root, for the checks that read how the server
 * wires the platform and the modules together.
 *
 * While server.js is the root it is that one file. Once the decomposed entry
 * point replaces it, the root is apps/api/src/main.ts and the composition it
 * calls in apps/api/src/composition/, read as one text in that order. A check
 * that reads the root through here holds wherever in it the wiring lives, and
 * holds across the move from one root to the other.
 *
 * What the root loads is read from its module syntax rather than its text:
 * `const { a, b: c } = require('…')` and `import { a, b as c } from '…'` both
 * take a and b -- the names the module exports, whatever the root calls them.
 * A type-only import loads nothing and is not counted.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPOSITION = path.join('apps', 'api', 'src', 'composition');

/* The root's files, relative to the tree, in the order they are read. */
function serverFiles(root = ROOT) {
  if (fs.existsSync(path.join(root, 'server.js'))) return ['server.js'];
  const composition = path.join(root, COMPOSITION);
  const parts = fs.existsSync(composition)
    ? fs.readdirSync(composition).filter(name => name.endsWith('.ts')).sort().map(name => path.posix.join('apps', 'api', 'src', 'composition', name))
    : [];
  return [path.posix.join('apps', 'api', 'src', 'main.ts'), ...parts];
}

function serverSource(root = ROOT) {
  return serverFiles(root).map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
}

/* Every module the root loads, with the names it takes from each; `*` for a whole module. */
function serverModules(root = ROOT) {
  const loads = new Map();
  const take = (specifier, names) => {
    if (!loads.has(specifier)) loads.set(specifier, new Set());
    for (const name of names) loads.get(specifier).add(name);
  };
  const requiredSpecifier = node => (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
      ? node.arguments[0].text : null
  );
  for (const file of serverFiles(root)) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const visit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (clause && !clause.isTypeOnly) {
          const names = [];
          if (clause.name) names.push('default');
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) if (!element.isTypeOnly) names.push((element.propertyName || element.name).text);
          }
          take(node.moduleSpecifier.text, names);
        } else if (!clause) {
          take(node.moduleSpecifier.text, []);
        }
        return;
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const specifier = requiredSpecifier(node.initializer);
        if (specifier !== null) {
          if (ts.isObjectBindingPattern(node.name)) {
            take(specifier, node.name.elements.map(element => (element.propertyName || element.name).getText(source)));
          } else {
            take(specifier, ['*']);
          }
          return;
        }
      }
      const specifier = requiredSpecifier(node);
      if (specifier !== null) take(specifier, ['*']);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return loads;
}

/* Whether the root loads the module whose specifier ends so, e.g. 'platform/release/version.ts'. */
function serverLoads(ending, root = ROOT) {
  return [...serverModules(root).keys()].some(specifier => specifier === ending || specifier.endsWith(`/${ending}`));
}

/* The names the root takes from that module, as one text for a check to match; null when it does not load it. */
function serverImports(ending, root = ROOT) {
  const names = new Set();
  let found = false;
  for (const [specifier, taken] of serverModules(root)) {
    if (specifier === ending || specifier.endsWith(`/${ending}`)) {
      found = true;
      for (const name of taken) names.add(name);
    }
  }
  return found ? [...names].join(', ') : null;
}

module.exports = { serverFiles, serverSource, serverModules, serverLoads, serverImports };
