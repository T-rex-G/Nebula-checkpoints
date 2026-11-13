'use strict';
/*
 * No test reads how the server is wired.
 *
 * D14 replaced every check that read the server's composition root as source
 * (through test/helpers/server-source.js) with one that asks the composed
 * server how it behaves, or, for what no request can show, with a rule over
 * the root's syntax tree (test/composition-root.test.js). Before D14, 118
 * statements read it; none do now, and this keeps it so.
 *
 * The helper offers the root's file list alone, and nothing else may come
 * back to it. A statement would read the composition if it used a name bound
 * to serverSource() or serverImports(), or called serverLoads(),
 * serverImports() or serverModules() -- the readers the helper used to offer;
 * every test and script is searched for one, by statement and over the syntax
 * tree, so a comment that mentions the server reads nothing. The checks that
 * scan every source file for what it says -- the error codes, the contracts,
 * the provider-route inventory, the route surface -- take the composition's
 * files (serverFiles()) among all the others; they read no wiring.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const READERS = new Set(['serverSource', 'serverImports']);
const CALLS = new Set(['serverLoads', 'serverImports', 'serverModules']);

function programs(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : programs(full);
    return /\.(?:c?js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

/* The statements in one file that read the composition, by line. */
function reads(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/helpers\/server-source/.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /* The helper's exports, under whatever local names the file gives them. */
  const alias = new Map();
  const bound = new Set();
  const collect = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
      const callee = node.initializer.expression.text;
      const argument = node.initializer.arguments[0];
      if (callee === 'require' && argument && ts.isStringLiteral(argument) && /helpers\/server-source$/.test(argument.text) && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) alias.set(element.name.text, (element.propertyName || element.name).text);
      }
      if (READERS.has(alias.get(callee)) && ts.isIdentifier(node.name)) bound.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const statementOf = node => {
    let at = node;
    while (at.parent && !ts.isSourceFile(at.parent) && !ts.isBlock(at.parent)) at = at.parent;
    return at;
  };
  const lines = new Set();
  const visit = node => {
    const use = ts.isIdentifier(node) && bound.has(node.text)
      && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) && !ts.isBindingElement(node.parent);
    const call = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CALLS.has(alias.get(node.expression.text))
      && !ts.isVariableDeclaration(node.parent);
    if (use || call) {
      const statement = statementOf(node);
      lines.add(source.getLineAndCharacterOfPosition(statement.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...lines].sort((a, b) => a - b).map(line => `${path.relative(ROOT, file)}:${line}`);
}

const found = [...programs(path.join(ROOT, 'test')), ...programs(path.join(ROOT, 'scripts'))]
  .filter(file => !file.endsWith(path.join('helpers', 'server-source.js')))
  .flatMap(reads);

assert.deepEqual(Object.keys(require('./helpers/server-source')), ['serverFiles'],
  'the helper offers the composition\'s files alone: a reader of its wiring does not come back');
assert.deepEqual(found, [], `a statement reads the composition's source; ask the composed server instead:\n${found.join('\n')}`);

console.log('composition reads: none');
