'use strict';
/*
 * The server's composition root, for the checks that read how the server
 * wires the platform and the modules together.
 *
 * The root is apps/api/src/main.ts and the composition it calls in
 * apps/api/src/composition/, read as one text in that order (server.js was
 * the root until D13 replaced it). A check that reads the root through here
 * holds wherever in it the wiring lives.
 *
 * What the root loads is read from its module syntax rather than its text:
 * `const { a, b: c } = require('…')` and `import { a, b as c } from '…'` both
 * take a and b -- the names the module exports, whatever the root calls them.
 * So does `import m from '…'` followed by `const { a, b: c } = m`, the way an
 * ES module reads a CommonJS module's exports. A type-only import loads
 * nothing and is not counted. A module is named by its path in the tree: a
 * relative specifier is resolved from the folder of the file that holds it,
 * so a check names the module once, wherever in the root it is loaded from.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPOSITION = path.join('apps', 'api', 'src', 'composition');

/* The root's files, relative to the tree, in the order they are read. */
function serverFiles(root = ROOT) {
  const composition = path.join(root, COMPOSITION);
  const parts = fs.existsSync(composition)
    ? fs.readdirSync(composition).filter(name => name.endsWith('.ts')).sort().map(name => path.posix.join('apps', 'api', 'src', 'composition', name))
    : [];
  return [path.posix.join('apps', 'api', 'src', 'main.ts'), ...parts];
}

function serverSource(root = ROOT) {
  return serverFiles(root).map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
}

/* A specifier as the tree names it: a relative one resolved from its file's folder, a package's as written. */
function treePath(file, specifier) {
  return specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier;
}

/* Every module the root loads, by its path in the tree, with the names it takes from each; `*` for a whole module. */
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
    /* A default import's local name, and the module whose exports it holds. */
    const defaults = new Map();
    const destructured = binding => binding.elements.map(element => (element.propertyName || element.name).getText(source));
    const visit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = treePath(file, node.moduleSpecifier.text);
        const clause = node.importClause;
        if (clause && !clause.isTypeOnly) {
          const names = [];
          if (clause.name) {
            names.push('default');
            defaults.set(clause.name.text, module);
          }
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) if (!element.isTypeOnly) names.push((element.propertyName || element.name).text);
          }
          take(module, names);
        } else if (!clause) {
          take(module, []);
        }
        return;
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const specifier = requiredSpecifier(node.initializer);
        if (specifier !== null) {
          take(treePath(file, specifier), ts.isObjectBindingPattern(node.name) ? destructured(node.name) : ['*']);
          return;
        }
        if (ts.isIdentifier(node.initializer) && defaults.has(node.initializer.text) && ts.isObjectBindingPattern(node.name)) {
          take(defaults.get(node.initializer.text), destructured(node.name));
          return;
        }
      }
      const specifier = requiredSpecifier(node);
      if (specifier !== null) take(treePath(file, specifier), ['*']);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return loads;
}

/* Whether a loaded module is the one a check names by the end of its path, with or without its extension. */
function isModule(module, ending) {
  const bare = text => text.replace(/\.(?:[cm]?js|ts)$/, '');
  return bare(module) === bare(ending) || bare(module).endsWith(`/${bare(ending)}`);
}

/* Whether the root loads the module whose path ends so, e.g. 'platform/release/version.ts'. */
function serverLoads(ending, root = ROOT) {
  return [...serverModules(root).keys()].some(module => isModule(module, ending));
}

/* The names the root takes from that module, as one text for a check to match; null when it does not load it. */
function serverImports(ending, root = ROOT) {
  const names = new Set();
  let found = false;
  for (const [module, taken] of serverModules(root)) {
    if (isModule(module, ending)) {
      found = true;
      for (const name of taken) names.add(name);
    }
  }
  return found ? [...names].join(', ') : null;
}

module.exports = { serverFiles, serverSource, serverModules, serverLoads, serverImports };
