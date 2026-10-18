'use strict';
/*
 * The HTTP surface as policy: every global middleware and every route, in the
 * order Express runs them, with the guard chain each route declares.
 *
 * Captured from the monolith's source before the architecture mission moved
 * anything, so the decomposed server can be held to it. The chain is read as
 * written -- `capabilityAccess('governance')`, `governanceAccess('reader')` --
 * because the closures those calls return carry no name at runtime; the words
 * in the source are the policy. Position is policy too: a route registered
 * above the alpha access boundary is public because of where it sits, so the
 * snapshot keeps every route's place relative to every middleware.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);
const SETTINGS = new Set(['set', 'disable', 'enable']);

/*
 * The global middlewares have no names in the monolith; these are the names the
 * decomposed pipeline must give them, in registration order. A thirteenth
 * app.use, or one fewer, fails the capture rather than shifting every label.
 */
const MIDDLEWARE_LABELS = Object.freeze([
  'retire-legacy-cookies',
  'correlation-id',
  'structured-logging',
  'security-headers',
  'api-no-store',
  'api-same-origin',
  'api-rate-admission',
  'json-body',
  'api-maintenance',
  'stripped-public-assets',
  'static-files',
  'alpha-access-boundary'
]);

function text(node, source) {
  return node.getText(source).replace(/\s+/g, ' ').trim();
}

/*
 * A route's path as Express receives it: a literal, an array of literals, or
 * the variable of an enclosing `for (const x of [...])` over literals -- the
 * iOS icon aliases are registered that way. Each alias is its own route.
 */
function literalPaths(node, source) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isRegularExpressionLiteral(node)) return [text(node, source)];
  if (ts.isArrayLiteralExpression(node)) {
    const paths = node.elements.map(element => literalPaths(element, source));
    return paths.every(Boolean) ? paths.flat() : null;
  }
  if (ts.isIdentifier(node)) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (ts.isForOfStatement(scope) && ts.isVariableDeclarationList(scope.initializer) &&
          scope.initializer.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === node.text) &&
          ts.isArrayLiteralExpression(scope.expression)) {
        return literalPaths(scope.expression, source);
      }
    }
  }
  return null;
}

function literalPath(node, source) {
  const paths = literalPaths(node, source);
  return paths && paths.length === 1 ? paths[0] : null;
}

function handlerName(node, source) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 'inline';
  return text(node, source);
}

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/* `const access = [a, b(c), d]` inside the registering function, for `...access`. */
function spreadBindings(source) {
  const bindings = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)) {
      bindings.set(node.name.text, node.initializer.elements.map(element => text(element, source)));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function argumentsAsGuards(args, source, spreads) {
  const guards = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg) && ts.isIdentifier(arg.expression) && spreads.has(arg.expression.text)) {
      guards.push(...spreads.get(arg.expression.text));
    } else {
      guards.push(text(arg, source));
    }
  }
  return guards;
}

function registrationsIn(source, spreads, file, root, expand) {
  const entries = [];
  const visitCall = node => {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'app') {
      const method = callee.name.text;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const at = `${path.relative(root, file)}:${line}`;
      const args = [...node.arguments];
      if (ROUTE_METHODS.has(method) && args.length >= 2) {
        const routePaths = literalPaths(args[0], source);
        if (routePaths === null) throw new Error(`${at}: a route path the policy cannot read`);
        for (const routePath of routePaths) {
          entries.push({
            kind: 'route', method: method.toUpperCase(), path: routePath,
            guards: argumentsAsGuards(args.slice(1, -1), source, spreads),
            handler: handlerName(args[args.length - 1], source), at
          });
        }
        return true;
      }
      if (method === 'use') {
        const mount = args.length > 1 ? literalPath(args[0], source) : null;
        entries.push({
          kind: 'use', mount: mount || '/',
          middleware: text(args[args.length - 1], source).startsWith('(') ? 'inline' : text(args[args.length - 1], source),
          at
        });
        return true;
      }
      if (SETTINGS.has(method)) {
        entries.push({ kind: 'setting', call: `${method}(${args.map(arg => text(arg, source)).join(', ')})`, at });
        return true;
      }
    }
    if (ts.isIdentifier(callee) && expand.has(callee.text)) {
      entries.push(...expand.get(callee.text)());
      return true;
    }
    return false;
  };
  const visit = node => {
    if (ts.isCallExpression(node) && visitCall(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return entries;
}

/*
 * The baseline form: server.js, with registerRenderedAudit(app, ...) expanded
 * in place from src/routes/rendered-audit.js.
 */
function extractMonolithPolicy(root) {
  const serverFile = path.join(root, 'server.js');
  const renderedFile = path.join(root, 'src', 'routes', 'rendered-audit.js');
  const rendered = parse(renderedFile);
  const expand = new Map([[
    'registerRenderedAudit',
    () => registrationsIn(rendered, spreadBindings(rendered), renderedFile, root, new Map())
  ]]);
  const server = parse(serverFile);
  const entries = registrationsIn(server, new Map(), serverFile, root, expand);
  return canonicalPolicy(entries);
}

function canonicalPolicy(entries) {
  const uses = entries.filter(entry => entry.kind === 'use');
  if (uses.length !== MIDDLEWARE_LABELS.length) {
    throw new Error(`expected ${MIDDLEWARE_LABELS.length} global middlewares, found ${uses.length}`);
  }
  let useIndex = 0;
  let beforeBoundary = true;
  const sequence = [];
  for (const entry of entries) {
    if (entry.kind === 'use') {
      const label = MIDDLEWARE_LABELS[useIndex++];
      if (label === 'alpha-access-boundary') beforeBoundary = false;
      sequence.push({ kind: 'middleware', label, mount: entry.mount });
    } else if (entry.kind === 'setting') {
      sequence.push({ kind: 'setting', call: entry.call });
    } else {
      sequence.push({
        kind: 'route', method: entry.method, path: entry.path,
        guards: entry.guards, publicByPosition: beforeBoundary
      });
    }
  }
  return {
    schemaVersion: 1,
    routes: sequence.filter(entry => entry.kind === 'route').length,
    sequence
  };
}

function locations(root) {
  const serverFile = path.join(root, 'server.js');
  const renderedFile = path.join(root, 'src', 'routes', 'rendered-audit.js');
  const rendered = parse(renderedFile);
  const expand = new Map([[
    'registerRenderedAudit',
    () => registrationsIn(rendered, spreadBindings(rendered), renderedFile, root, new Map())
  ]]);
  return registrationsIn(parse(serverFile), new Map(), serverFile, root, expand);
}

module.exports = { MIDDLEWARE_LABELS, extractMonolithPolicy, canonicalPolicy, locations };
