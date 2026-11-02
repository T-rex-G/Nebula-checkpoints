'use strict';
/*
 * The module system and the boundaries between the parts, as tests (ADR-088,
 * ADR-089, ADR-094).
 *
 *  - The root package stays CommonJS; apps/ and packages/ are ES-module scopes
 *    declared by a package.json that says nothing else.
 *  - Nothing under apps/ or packages/ awaits at the top level: a CommonJS test
 *    or tool that require()s such a graph fails with ERR_REQUIRE_ASYNC_MODULE.
 *  - A worker or child-process entry file is named in one place,
 *    apps/api/src/entrypoint.ts, anywhere in the server, so the native and
 *    compiled runtimes resolve the same file.
 *  - The page never imports the server, the server never imports the page,
 *    and the shared contracts import neither.
 *  - A module of the server is reached through its index only, by the other
 *    modules and by the CommonJS server code that remains, and its domain
 *    layer imports no transport, persistence or process package -- neither
 *    itself nor through anything it loads -- and none of its own module's
 *    other layers: a decision does not depend on how it is fetched or kept.
 *  - The platform imports only the platform and the shared contracts: the
 *    modules stand on it, so it depends on none of them, nor on the server
 *    code still in src/.
 *  - No dependency cycle anywhere in the backend: one graph over src, apps
 *    and packages, so a cycle that runs through a TypeScript module and back
 *    into the CommonJS code still in src/ is seen as well.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const rel = file => path.relative(root, file).split(path.sep).join('/');

/*
 * The baseline had one cycle, N-01: the mutation gateway, governance
 * simulation, enforcement and exceptions, each requiring the next. D2 broke it
 * -- the gateway is handed its policy port and imports no policy module, and
 * policy reads the action catalogue from the mutation contract -- so the
 * record is empty and any cycle fails.
 */
const RECORDED_CYCLES = Object.freeze([]);

const DOMAIN_FORBIDDEN = /^(?:node:)?(?:child_process|cluster|dgram|dns|fs|fs\/promises|http|https|http2|net|tls|worker_threads)$|^(?:express|pg|playwright-core)$/;

function walk(directory, out = []) {
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parse(file) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

/* Static imports and re-exports (the edges that order evaluation), and dynamic import() targets. */
function importsOf(source) {
  const statics = [];
  const dynamics = [];
  const requires = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!(ts.isImportDeclaration(node) && node.importClause && node.importClause.isTypeOnly)) statics.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      dynamics.push(node.arguments[0].text);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      requires.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { statics, dynamics, requires };
}

function resolveRelative(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}.json`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function topLevelAwait(source) {
  let found = null;
  const visit = node => {
    if (found) return;
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

function entryPathLiterals(source) {
  const hits = [];
  const literalPath = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /\.(?:[cm]?[jt]s)$/.test(node.text);
  const literalSpecifier = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^\.\.?\//.test(node.text);
  /* Constants the file declares, so an entry held in one (`const WORKER = path.join(...)`) is still seen where it is started. */
  const constants = new Map();
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  /*
   * A literal path, this file (`__filename`), a file beside it
   * (`path.join(__dirname, 'x.js')`) or a module resolved by name
   * (`require.resolve('./x')`).
   */
  const entryPath = (node, depth = 0) => {
    if (!node) return null;
    if (ts.isIdentifier(node) && constants.has(node.text) && depth < 4) return entryPath(constants.get(node.text), depth + 1);
    if (literalPath(node)) return node.text;
    if (ts.isIdentifier(node) && node.text === '__filename') return '__filename';
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: owner, name } = node.expression;
      if (['join', 'resolve'].includes(name.text) && !(ts.isIdentifier(owner) && owner.text === 'require')) {
        const last = node.arguments[node.arguments.length - 1];
        if (literalPath(last)) return last.text;
      }
      if (name.text === 'resolve' && ts.isIdentifier(owner) && owner.text === 'require' && literalSpecifier(node.arguments[0])) {
        return node.arguments[0].text;
      }
    }
    return null;
  };
  /* An entry passed directly, or as an element of the argument list (`spawn(process.execPath, [entry])`). */
  const entryIn = args => {
    for (const arg of args || []) {
      const direct = entryPath(arg);
      if (direct) return direct;
      const list = arg && ts.isIdentifier(arg) && constants.has(arg.text) ? constants.get(arg.text) : arg;
      if (list && ts.isArrayLiteralExpression(list)) {
        const element = list.elements.map(element => entryPath(element)).find(Boolean);
        if (element) return element;
      }
    }
    return null;
  };
  const STARTERS = ['fork', 'spawn', 'spawnSync', 'execFile', 'execFileSync'];
  const visit = node => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['URL', 'Worker', 'spawn'].includes(node.expression.text) &&
        node.arguments && entryPath(node.arguments[0])) hits.push(entryPath(node.arguments[0]));
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (STARTERS.includes(name) && entryIn(node.arguments)) hits.push(entryIn(node.arguments));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/*
 * An error class that declares fields names itself first. The JavaScript it
 * replaced assigned `this.name` before its other properties, and a field
 * declaration is defined as soon as `super()` returns, so a `this.name`
 * assigned in the constructor -- or a `name` field after another -- would
 * move the name behind them, in the order the error's properties serialize.
 */
function errorsNamedLate(source) {
  const out = [];
  const visit = node => {
    const extendsError = ts.isClassLike(node) && (node.heritageClauses || [])
      .some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some(type => /Error$/.test(type.expression.getText(source))));
    if (extendsError) {
      const fields = node.members.filter(member => ts.isPropertyDeclaration(member)
        && !(ts.getModifiers(member) || []).some(modifier => [ts.SyntaxKind.StaticKeyword, ts.SyntaxKind.DeclareKeyword].includes(modifier.kind)));
      const label = node.name ? node.name.text : 'an anonymous error class';
      const named = fields.findIndex(field => field.name.getText(source) === 'name');
      if (named > 0) out.push(`${label} declares its name after another field`);
      let assigned = false;
      const assigns = inner => {
        if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(inner.left)
          && inner.left.expression.kind === ts.SyntaxKind.ThisKeyword && inner.left.name.text === 'name') assigned = true;
        if (!ts.isClassLike(inner)) ts.forEachChild(inner, assigns);
      };
      for (const member of node.members) if (ts.isConstructorDeclaration(member) && member.body) assigns(member.body);
      if (assigned && fields.length) out.push(`${label} assigns this.name after its fields are defined`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function stronglyConnected(edges) {
  let index = 0;
  const stack = [];
  const on = new Set();
  const indices = new Map();
  const lows = new Map();
  const components = [];
  const strong = node => {
    indices.set(node, index); lows.set(node, index); index += 1;
    stack.push(node); on.add(node);
    for (const next of edges.get(node) || []) {
      if (!indices.has(next)) { strong(next); lows.set(node, Math.min(lows.get(node), lows.get(next))); }
      else if (on.has(next)) lows.set(node, Math.min(lows.get(node), indices.get(next)));
    }
    if (lows.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do { member = stack.pop(); on.delete(member); component.push(member); } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of edges.keys()) if (!indices.has(node)) strong(node);
  return components.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/* --- module scopes --------------------------------------------------------- */

assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).type, 'commonjs',
  'the root package must stay CommonJS: every test, script and CI tool is CommonJS');
for (const scope of ['apps', 'packages']) {
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, scope, 'package.json'), 'utf8')), { type: 'module' },
    `${scope}/package.json must declare the ES-module scope and nothing else`);
}
console.log('  ok  the root stays CommonJS; apps/ and packages/ are ES-module scopes');

/* --- the new code ---------------------------------------------------------- */

const scoped = [...walk(path.join(root, 'apps')), ...walk(path.join(root, 'packages'))]
  .filter(file => !/[/\\](?:public|dist)[/\\]/.test(file) && !/vite\.config\.js$/.test(file));
const DOMAIN_FILE = /^apps\/api\/src\/modules\/([^/]+)\/domain\//;
const edges = new Map();
const forbiddenPackages = new Map();
const violations = [];
for (const file of scoped) {
  const name = rel(file);
  const source = parse(file);
  const awaited = topLevelAwait(source);
  if (awaited) violations.push(`${name}: top-level await at line ${source.getLineAndCharacterOfPosition(awaited.getStart(source)).line + 1}`);
  if (name !== 'apps/api/src/entrypoint.ts') {
    for (const literal of entryPathLiterals(source)) violations.push(`${name}: names the entry file ${literal}; only apps/api/src/entrypoint.ts may`);
  }
  for (const late of errorsNamedLate(source)) violations.push(`${name}: ${late}`);
  const { statics, dynamics, requires } = importsOf(source);
  if (requires.length) violations.push(`${name}: require() in an ES module (${requires.join(', ')})`);
  const targets = [];
  for (const specifier of [...statics, ...dynamics]) {
    const target = resolveRelative(file, specifier);
    if (!target) {
      if (specifier.startsWith('.')) violations.push(`${name}: ${specifier} does not resolve`);
      if (DOMAIN_FORBIDDEN.test(specifier)) {
        forbiddenPackages.set(name, [...(forbiddenPackages.get(name) || []), specifier]);
        if (DOMAIN_FILE.test(name)) violations.push(`${name}: domain code imports ${specifier}`);
      }
      continue;
    }
    const to = rel(target);
    if (name.startsWith('packages/') && to.startsWith('apps/')) violations.push(`${name}: the contracts import ${to}`);
    if (name.startsWith('apps/web/') && to.startsWith('apps/api/')) violations.push(`${name}: the page imports the server (${to})`);
    if (name.startsWith('apps/api/') && to.startsWith('apps/web/')) violations.push(`${name}: the server imports the page (${to})`);
    if (name.startsWith('apps/api/src/platform/') && !/^(?:apps\/api\/src\/platform\/|packages\/contracts\/src\/)/.test(to) && to !== 'package.json') {
      violations.push(`${name}: the platform imports ${to}; it may import only the platform and the contracts`);
    }
    const fromModule = /^apps\/api\/src\/modules\/([^/]+)\//.exec(name);
    const toModule = /^apps\/api\/src\/modules\/([^/]+)\/(.+)$/.exec(to);
    if (toModule && (!fromModule || fromModule[1] !== toModule[1]) && toModule[2] !== 'index.ts') {
      violations.push(`${name}: reaches into module ${toModule[1]} past its index (${to})`);
    }
    const fromDomain = DOMAIN_FILE.exec(name);
    if (fromDomain && toModule && toModule[1] === fromDomain[1] && !toModule[2].startsWith('domain/')) {
      violations.push(`${name}: domain code imports its own module's ${toModule[2].split('/')[0]} layer (${to})`);
    }
    if (statics.includes(specifier)) targets.push(to);
  }
  edges.set(name, targets);
}
/* What a domain file loads, at any depth, is held to the domain's rule too. */
for (const name of edges.keys()) {
  if (!DOMAIN_FILE.test(name)) continue;
  const seen = new Set([name]);
  const pending = [...edges.get(name)];
  while (pending.length) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    for (const specifier of forbiddenPackages.get(next) || []) {
      violations.push(`${name}: domain code loads ${next}, which imports ${specifier}`);
    }
    pending.push(...(edges.get(next) || []));
  }
}
assert.deepStrictEqual(violations, [], `module rules broken:\n- ${violations.join('\n- ')}`);
assert.deepStrictEqual(stronglyConnected(edges), [], 'a dependency cycle in apps/ or packages/');
console.log(`  ok  ${scoped.length} ES modules: no top-level await, no stray entry paths, errors named first, boundaries held, no cycle`);

/* --- the CommonJS server code that remains in src/ -------------------------- */

const legacy = walk(path.join(root, 'src'));
const legacyEdges = new Map();
const legacyEntries = [];
for (const file of legacy) {
  const source = parse(file);
  for (const literal of entryPathLiterals(source)) legacyEntries.push(`${rel(file)}: names the entry file ${literal}; only apps/api/src/entrypoint.ts may`);
  const { requires } = importsOf(source);
  legacyEdges.set(rel(file), requires.map(specifier => resolveRelative(file, specifier)).filter(Boolean).map(rel)
    .filter(target => /^(?:src|apps|packages)\//.test(target)));
}
/* The server code still in src/ reaches a module through its index, as the modules do. */
const legacyReaches = [...legacyEdges].flatMap(([name, targets]) => targets
  .map(target => /^apps\/api\/src\/modules\/([^/]+)\/(.+)$/.exec(target))
  .filter(match => match && match[2] !== 'index.ts')
  .map(match => `${name}: reaches into module ${match[1]} past its index (${match[0]})`));
assert.deepStrictEqual(legacyReaches, [], 'the CommonJS server reaches into a module past its index');
const backend = new Map([...[...edges].filter(([name]) => !name.startsWith('apps/web/')), ...legacyEdges]);
assert.deepStrictEqual(stronglyConnected(backend), RECORDED_CYCLES.map(cycle => [...cycle].sort()),
  'the backend\'s dependency cycles changed: a new one appeared, or a recorded one is gone and must be struck from the list');
assert.deepStrictEqual(legacyEntries, [], 'a worker or child process started by a path written at its spawn site');
console.log(`  ok  ${legacy.length} CommonJS server files: no stray entry paths; ${backend.size} backend files, no dependency cycle`);
