'use strict';
/*
 * Which statements of the tests and scripts read a part of the source as text.
 *
 * Shared by the two censuses: test/module-reads.test.js counts the reads of
 * the server's source, test/page-reads.test.js those of the page's. A
 * statement reads a part when it reads one of its files as text, uses a name
 * bound to such text, or calls a function whose body carries it, such as one
 * that slices a block out of its file. Found by the syntax tree, so a comment
 * or a string that merely names a file reads nothing. Loading a module with
 * require() reads nothing: that is asking it, and so is running a page module
 * whole against a stand-in browser (test/helpers/page-module.js). Text handed
 * straight to the TypeScript parser is read for its syntax tree, and reads no
 * text either.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');

/* Every statement, as file:line, that reads a file whose path matches `pattern`. Its own census is left out. */
function sourceReads(pattern, census) {
  const SERVER_PATH = pattern;
  const __filename = census;
  function programs(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : programs(full);
      return /\.(?:c?js|mjs)$/.test(entry.name) ? [full] : [];
    });
  }

  const calleeName = node => ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
  const isReadFile = node => ts.isCallExpression(node) && calleeName(node) === 'readFileSync';
  /* Text handed to the parser is read for its syntax tree: a rule over that tree reads no text. */
  const isParse = node => ts.isCallExpression(node) && calleeName(node) === 'createSourceFile';
  const parsed = node => {
    for (let at = node.parent; at; at = at.parent) {
      if (isParse(at)) return true;
      if (ts.isStatement(at) || ts.isFunctionLike(at)) return false;
    }
    return false;
  };
  const ITERATORS = new Set(['map', 'flatMap', 'forEach', 'filter', 'some', 'every', 'find', 'reduce']);

  const files = [...programs(path.join(ROOT, 'test')), ...programs(path.join(ROOT, 'scripts'))]
    .filter(file => file !== __filename && /readFileSync/.test(fs.readFileSync(file, 'utf8')));
  /* One program over them all, so a name is the declaration it resolves to in its own scope, not its spelling. */
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: false, noResolve: true, noLib: true, noEmit: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  });
  const checker = program.getTypeChecker();
  const symbolOf = node => {
    if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) return checker.getShorthandAssignmentValueSymbol(node.parent);
    return checker.getSymbolAtLocation(node);
  };

  /* The statements in one file that read a server module's text, by line. */
  function reads(source) {
    /* Whether a function reads a file as text: a read it hands to the parser does not count. */
    const containsRead = node => {
      let found = false;
      const look = inner => { if (!found && isReadFile(inner) && !parsed(inner)) found = true; else ts.forEachChild(inner, look); };
      look(node);
      return found;
    };
    /* Readers: the file's functions that read whatever path they are handed. */
    const readers = new Set();
    const gather = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && containsRead(node.initializer)) {
        readers.add(symbolOf(node.name));
      }
      if (ts.isFunctionDeclaration(node) && node.name && containsRead(node)) readers.add(symbolOf(node.name));
      ts.forEachChild(node, gather);
    };
    gather(source);

    /* What an expression names, with each name it uses replaced by what that name was given. */
    const origin = declaration => {
      if (ts.isVariableDeclaration(declaration)) {
        if (declaration.initializer) return declaration.initializer;
        const loop = declaration.parent && declaration.parent.parent;
        if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop))) return loop.expression;
      }
      if (ts.isBindingElement(declaration)) {
        let at = declaration.parent;
        while (at && !ts.isVariableDeclaration(at) && !ts.isParameter(at)) at = at.parent;
        return at ? origin(at) : null;
      }
      if (ts.isParameter(declaration)) {
        const fn = declaration.parent;
        const call = fn && fn.parent;
        if (call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ITERATORS.has(call.expression.name.text)) return call.expression.expression;
      }
      return null;
    };
    const expanded = (node, seen = new Set()) => {
      let out = node.getText();
      const visit = inner => {
        if (ts.isIdentifier(inner)) {
          const symbol = symbolOf(inner);
          const declaration = symbol && symbol.declarations && symbol.declarations[0];
          const from = declaration && !seen.has(declaration) ? origin(declaration) : null;
          /* A module loaded with require() is asked, not read: what it names is no path of this file's. */
          if (from && from !== node && !requires(from)) {
            seen.add(declaration);
            out += ` ${expanded(from, seen)}`;
          }
        }
        ts.forEachChild(inner, visit);
      };
      visit(node);
      return out;
    };
    const requires = node => {
      let found = false;
      const look = inner => { if (!found && ts.isCallExpression(inner) && calleeName(inner) === 'require') found = true; else if (!found) ts.forEachChild(inner, look); };
      look(node);
      return found;
    };
    const namesServer = node => Boolean(node) && SERVER_PATH.test(expanded(node));
    /* A read of a server module's text: readFileSync of a server path, or a reader handed one. */
    const isServerRead = node => ts.isCallExpression(node) && node.arguments.length > 0 && !parsed(node) && (
      (isReadFile(node) && namesServer(node.arguments[0]))
      || (ts.isIdentifier(node.expression) && readers.has(symbolOf(node.expression)) && namesServer(node.arguments[0])));

    /* The names bound to such text, however it is passed on within the file. */
    const bound = new Set();
    /* Functions that close over such text: what they return is cut from it, as a route's body is sliced from its file. */
    const derivers = new Set();
    const carries = node => {
      let found = false;
      const look = inner => {
        if (found) return;
        if (isParse(inner)) return;
        if (isServerRead(inner) || (ts.isIdentifier(inner) && bound.has(symbolOf(inner)))
          || (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && derivers.has(symbolOf(inner.expression)))) found = true;
        else ts.forEachChild(inner, look);
      };
      look(node);
      return found;
    };
    const bindName = name => {
      if (ts.isIdentifier(name)) {
        const symbol = symbolOf(name);
        if (symbol && !bound.has(symbol) && !readers.has(symbol)) { bound.add(symbol); return true; }
        return false;
      }
      let grew = false;
      for (const element of name.elements || []) if (!ts.isOmittedExpression(element)) grew = bindName(element.name) || grew;
      return grew;
    };
    let grew = true;
    while (grew) {
      grew = false;
      const bind = node => {
        if (ts.isVariableDeclaration(node) && node.initializer && !ts.isArrowFunction(node.initializer) && !ts.isFunctionExpression(node.initializer) && carries(node.initializer)) {
          grew = bindName(node.name) || grew;
        }
        const fn = ts.isFunctionDeclaration(node) && node.name && node.body ? [node.name, node.body]
          : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
            ? [node.name, node.initializer.body] : null;
        if (fn) {
          const symbol = symbolOf(fn[0]);
          if (symbol && !derivers.has(symbol) && !readers.has(symbol) && carries(fn[1])) { derivers.add(symbol); grew = true; }
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && carries(node.right)) {
          grew = bindName(node.left) || grew;
        }
        /* A loop over such text, or a callback handed it element by element, binds its variable. */
        if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer) && carries(node.expression)) {
          for (const declaration of node.initializer.declarations) grew = bindName(declaration.name) || grew;
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ITERATORS.has(node.expression.name.text) && carries(node.expression.expression)) {
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters[0]) grew = bindName(callback.parameters[0].name) || grew;
        }
        ts.forEachChild(node, bind);
      };
      bind(source);
    }

    const statementOf = node => {
      let at = node;
      while (at.parent && !ts.isSourceFile(at.parent) && !ts.isBlock(at.parent) && !ts.isCaseClause(at.parent)) at = at.parent;
      return at;
    };
    /* A declaration that only binds the text is counted where the text is used -- or, read and never used, where it is read. */
    const used = new Set();
    const note = node => {
      if (ts.isIdentifier(node) && !((ts.isVariableDeclaration(node.parent) || ts.isBindingElement(node.parent) || ts.isParameter(node.parent)) && node.parent.name === node)) {
        const symbol = symbolOf(node);
        if (symbol && bound.has(symbol)) used.add(symbol);
      }
      ts.forEachChild(node, note);
    };
    note(source);
    const declaresOnly = statement => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.every(declaration => ts.isIdentifier(declaration.name) && bound.has(symbolOf(declaration.name)) && used.has(symbolOf(declaration.name)));
    const lines = new Set();
    const visit = node => {
      const use = ts.isIdentifier(node) && bound.has(symbolOf(node)) && !parsed(node)
        && !((ts.isVariableDeclaration(node.parent) || ts.isBindingElement(node.parent) || ts.isParameter(node.parent)) && node.parent.name === node);
      if (use || isServerRead(node)) {
        const statement = statementOf(node);
        if (!declaresOnly(statement)) lines.add(source.getLineAndCharacterOfPosition(statement.getStart()).line + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return [...lines].sort((a, b) => a - b).map(line => `${path.relative(ROOT, source.fileName)}:${line}`);
  }
  return files.map(file => program.getSourceFile(file)).flatMap(reads);
}

module.exports = { sourceReads };
