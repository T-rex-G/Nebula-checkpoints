'use strict';
/*
 * How many tests still read the server's composition root as source.
 *
 * D14 replaces the checks that read how the server is wired (through
 * test/helpers/server-source.js) with checks that ask the composed server
 * how it behaves. This counts what is left, by statement and by the syntax
 * tree: a statement reads the composition when it uses a name bound to
 * serverSource() or serverImports(), or calls serverLoads(), serverImports()
 * or serverModules(). A comment that mentions the server reads nothing.
 *
 * The count is held to the record below, exactly. A new read fails here; a
 * converted one fails here too, until the record is lowered to match, so the
 * record always says how many remain. Before D14 there were 118.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const RECORDED = 36;

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

assert.equal(found.length, RECORDED,
  found.length > RECORDED
    ? `${found.length - RECORDED} more statement(s) read the composition's source than the ${RECORDED} recorded; ask the composed server instead:\n${found.join('\n')}`
    : `${RECORDED - found.length} fewer statement(s) read the composition's source than recorded: lower RECORDED to ${found.length}`);

console.log(`composition reads: ${found.length} remain`);
