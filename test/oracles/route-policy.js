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
 * The global middlewares had no names in the monolith, so each is named by
 * what it does: the first signature its source matches. These are the names
 * the decomposed pipeline must give them. A middleware no signature matches
 * fails the capture rather than being guessed at.
 *
 * Since D11 each step is built by a factory in apps/api/src/http/pipeline and
 * installed where it always was; the factory's name is the second signature.
 * The baseline's inline form is the first, so the record still reads.
 */
const MIDDLEWARE_SIGNATURES = Object.freeze([
  ['retire-legacy-cookies', /nv_workspace_session|^retireLegacyCookies\(/],
  ['correlation-id', /x-nebulaverse-correlation-id|^correlationId\(/],
  ['structured-logging', /res\.on\('finish'|^structuredLogging\(/],
  ['security-headers', /Content-Security-Policy|^securityHeaders\(/],
  ['api-no-store', /writeOfflineCacheHeaders|^apiNoStore\(/],
  ['api-same-origin', /APP_HEADER_REQUIRED|^apiSameOrigin\(/],
  ['api-rate-admission', /rateLimitIdentity|^apiRateAdmission\(/],
  ['json-body', /^express\.json\(|^jsonBody\(/],
  ['api-maintenance', /SERVICE_IN_MAINTENANCE|^apiMaintenance\(/],
  ['stripped-public-assets', /PUBLIC_ASSETS/],
  ['static-files', /^express\.static\(|^staticFiles\(/],
  ['alpha-access-boundary', /^alphaAccessBoundary$/]
]);
const MIDDLEWARE_LABELS = Object.freeze(MIDDLEWARE_SIGNATURES.map(([label]) => label));

function middlewareLabel(source, at) {
  const match = MIDDLEWARE_SIGNATURES.find(([, pattern]) => pattern.test(source));
  if (!match) throw new Error(`${at}: a global middleware the policy cannot name`);
  return match[0];
}

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
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

/* `const access = [a, b(c), d]` inside the registering function, for `...access`. */
function spreadBindings(scope, source) {
  const bindings = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)) {
      bindings.set(node.name.text, node.initializer.elements.map(element => text(element, source)));
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return bindings;
}

/*
 * Since D12 the routes leave server.js for registration functions in the
 * modules: `register...(app, deps)` in an `http` folder under apps/api/src
 * (and, until it moved, src/routes). Since D13 the composition root that
 * calls them is apps/api/src/main.ts, and its own segments are registration
 * functions in apps/api/src/composition. A call to one is read in place --
 * the routes its body registers, in that order, and the registration
 * functions it calls in turn -- so a route keeps its place in the policy
 * wherever its code lives. A name defined twice is resolved within the
 * calling file, and refused when the server calls it, rather than guessed at.
 */
function registrationFiles(root) {
  const files = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(?:js|ts)$/.test(entry.name) && ['http', 'routes', 'composition'].includes(path.basename(directory))) files.push(full);
    }
  };
  visit(path.join(root, 'apps', 'api', 'src'));
  visit(path.join(root, 'src', 'routes'));
  return files.sort();
}

function registrationFunctions(root) {
  const byName = new Map();
  for (const file of registrationFiles(root)) {
    const source = parse(file);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && /^register[A-Z]/.test(statement.name.text)) {
        const name = statement.name.text;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ file, source, node: statement });
      }
    }
  }
  return byName;
}

function expander(root) {
  const functions = registrationFunctions(root);
  const expanding = new Set();
  const expand = (name, callerFile) => {
    const candidates = functions.get(name) || [];
    const own = candidates.filter(candidate => candidate.file === callerFile);
    const chosen = own.length === 1 ? own[0] : candidates.length === 1 ? candidates[0] : null;
    if (!chosen) throw new Error(`${path.relative(root, callerFile)}: ${name} names ${candidates.length} registration functions`);
    const key = `${chosen.file}#${name}`;
    if (expanding.has(key)) throw new Error(`${name} registers itself`);
    expanding.add(key);
    try {
      return registrationsIn(chosen.node.body, chosen.source, spreadBindings(chosen.node.body, chosen.source), chosen.file, root, expand);
    } finally {
      expanding.delete(key);
    }
  };
  expand.knows = (name, callerFile) => (functions.get(name) || []).length > 0 && callerFile !== undefined;
  return expand;
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

function registrationsIn(scope, source, spreads, file, root, expand) {
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
          label: middlewareLabel(args[args.length - 1].getText(source), at),
          at
        });
        return true;
      }
      if (SETTINGS.has(method)) {
        entries.push({ kind: 'setting', call: `${method}(${args.map(arg => text(arg, source)).join(', ')})`, at });
        return true;
      }
    }
    if (ts.isIdentifier(callee) && /^register[A-Z]/.test(callee.text) && expand.knows(callee.text, file)) {
      entries.push(...expand(callee.text, file));
      return true;
    }
    return false;
  };
  const visit = node => {
    if (ts.isCallExpression(node) && visitCall(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return entries;
}

/* The composition root -- server.js while it existed, apps/api/src/main.ts since -- with every registration function it calls read in place. */
function serverRegistrations(root) {
  const monolith = path.join(root, 'server.js');
  const serverFile = fs.existsSync(monolith) ? monolith : path.join(root, 'apps', 'api', 'src', 'main.ts');
  const server = parse(serverFile);
  return registrationsIn(server, server, new Map(), serverFile, root, expander(root));
}

function extractMonolithPolicy(root) {
  return canonicalPolicy(serverRegistrations(root));
}

function canonicalPolicy(entries) {
  let beforeBoundary = true;
  const sequence = [];
  for (const entry of entries) {
    if (entry.kind === 'use') {
      if (entry.label === 'alpha-access-boundary') beforeBoundary = false;
      sequence.push({ kind: 'middleware', label: entry.label, mount: entry.mount });
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
  return serverRegistrations(root);
}

module.exports = { MIDDLEWARE_LABELS, extractMonolithPolicy, canonicalPolicy, locations };
