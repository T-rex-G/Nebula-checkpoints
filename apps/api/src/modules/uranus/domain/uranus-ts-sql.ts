/* Runtime models for Express request data and database statement text. */
import ts from 'typescript';
import { globalName, importOrigin, initializer, member, reassigned, unwrap, valueDeclaration } from './uranus-ts-symbols.ts';

const MAX_ALIASES = 16;
const METHODS = new Set(['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const CHANNELS = new Set(['params', 'query', 'body', 'headers']);
const PROTOTYPE = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

type LibraryExport = { package: string; name: string };
interface MysqlHandle {
  driver: 'mysql' | 'mysql2';
  pool: boolean;
  promise: boolean;
  defaultFormat: boolean;
  defaultPromise: boolean;
}
type Instance = 'pg-pool' | 'pg-client' | 'express-router' | 'express-route' | MysqlHandle;
interface Reference { symbol: ts.Symbol; path: readonly string[] }
interface Changes { writes: Set<string>; escapes: Set<string> }
const changesByFile = new WeakMap<ts.SourceFile, ReadonlyMap<ts.Symbol, Changes>>();

/* Follow local const aliases all the way to the receiver, including aliases of
 * a request's query or body record. An assigned binding has no stable alias. */
function reference(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): Reference | null {
  if (depth > MAX_ALIASES) return null;
  const node = unwrap(expression);
  const prop = member(node);
  if (prop) {
    const base = reference(prop.base, checker, depth + 1);
    return base && { symbol: base.symbol, path: [...base.path, prop.name] };
  }
  if (!ts.isIdentifier(node)) return null;
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  const decl = symbol.valueDeclaration;
  const init = initializer(decl ?? null);
  const alias = init && decl && !reassigned(decl, checker) ? reference(init, checker, depth + 1) : null;
  return alias ?? { symbol, path: [] };
}

/* Replacing a method or passing the receiver to unknown code invalidates a
 * runtime model. Passing a scalar field cannot replace the field on its owner. */
function changesIn(file: ts.SourceFile, checker: ts.TypeChecker): ReadonlyMap<ts.Symbol, Changes> {
  const saved = changesByFile.get(file);
  if (saved) return saved;
  const changes = new Map<ts.Symbol, Changes>();
  function mark(expr: ts.Expression, kind: 'writes' | 'escapes') {
    const node = unwrap(expr);
    if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression)) {
      mark(node.expression, 'escapes'); return;
    }
    const ref = reference(node, checker);
    if (!ref) return;
    const keys = changes.get(ref.symbol) ?? { writes: new Set<string>(), escapes: new Set<string>() };
    keys[kind].add(JSON.stringify(ref.path));
    changes.set(ref.symbol, keys);
  }
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left, 'writes');
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) mark(node.operand, 'writes');
    if (ts.isDeleteExpression(node)) mark(node.expression, 'writes');
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) mark(node.initializer, 'writes');
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const arg of node.arguments ?? []) mark(ts.isSpreadElement(arg) ? arg.expression : arg, 'escapes');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  changesByFile.set(file, changes);
  return changes;
}

function intact(expression: ts.Expression, suffix: readonly string[], checker: ts.TypeChecker): boolean {
  const ref = reference(expression, checker);
  if (!ref) return true;
  const changes = changesIn(expression.getSourceFile(), checker).get(ref.symbol);
  if (!changes) return true;
  const path = [...ref.path, ...suffix];
  for (let i = 0; i <= path.length; i++) {
    const key = JSON.stringify(path.slice(0, i));
    if (changes.writes.has(key) || (i < path.length && changes.escapes.has(key))) return false;
  }
  return true;
}

function library(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): LibraryExport | null {
  if (depth > MAX_ALIASES) return null;
  const node = unwrap(expression);
  const imported = importOrigin(node, checker, 'value');
  if (imported && intact(node, [], checker)) return imported;
  if (ts.isCallExpression(node) && globalName(node.expression, 'require', checker) &&
      node.arguments.length === 1 && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
    return { package: node.arguments[0].text, name: 'module' };
  }
  const prop = member(node);
  if (prop) {
    const root = library(prop.base, checker, depth + 1);
    if (root && ['default', '*', 'module'].includes(root.name) && intact(prop.base, [prop.name], checker)) {
      return { package: root.package, name: prop.name };
    }
  }
  if (!ts.isIdentifier(node)) return null;
  const decl = valueDeclaration(node, checker);
  if (!decl || reassigned(decl, checker)) return null;
  if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) && !decl.dotDotDotToken && !decl.initializer) {
    const init = initializer(decl.parent.parent);
    const key = decl.propertyName ?? decl.name;
    if (init && (ts.isIdentifier(key) || ts.isStringLiteralLike(key))) {
      const source = library(init, checker, depth + 1);
      if (source && ['default', 'module', '*'].includes(source.name) && intact(init, [key.text], checker)) return { package: source.package, name: key.text };
    }
    return null;
  }
  const init = initializer(decl);
  return init ? library(init, checker, depth + 1) : null;
}

/* Both drivers permit a connection-level queryFormat hook which replaces the
 * statement sent by query(). mysql2.execute() prepares the SQL separately. */
function defaultMysqlOption(config: ts.Expression | undefined, name: string): boolean {
  if (!config) return true;
  const node = unwrap(config);
  if (ts.isStringLiteralLike(node)) return true;
  return ts.isObjectLiteralExpression(node) && node.properties.every(prop =>
    (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
    (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
    prop.name.text !== '__proto__' && prop.name.text !== name);
}

function mysqlFactory(call: ts.CallExpression, factory: LibraryExport | null, awaited: boolean): MysqlHandle | null {
  if (!factory || (factory.name !== 'createConnection' && factory.name !== 'createPool')) return null;
  const promise = factory.package === 'mysql2/promise';
  if (!promise && factory.package !== 'mysql' && factory.package !== 'mysql2') return null;
  const pool = factory.name === 'createPool';
  // Only the promise driver's connection factory returns a promise of a handle.
  const defaultPromise = defaultMysqlOption(call.arguments[0], 'Promise');
  if (promise && ((!pool && !awaited) || !defaultPromise)) return null;
  return { driver: factory.package === 'mysql' ? 'mysql' : 'mysql2', pool, promise,
    defaultFormat: defaultMysqlOption(call.arguments[0], 'queryFormat'), defaultPromise };
}

function mysqlHandle(role: Instance | null): role is MysqlHandle { return role !== null && typeof role === 'object'; }

function hasDriverFormat(receiver: ts.Expression, checker: ts.TypeChecker, core: readonly string[] = []): boolean {
  return intact(receiver, [...core, 'format'], checker) && intact(receiver, [...core, 'config', 'queryFormat'], checker) &&
    intact(receiver, [...core, 'config', 'connectionConfig', 'queryFormat'], checker);
}

function instance(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): Instance | null {
  if (depth > MAX_ALIASES) return null;
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    const decl = valueDeclaration(node, checker);
    if (!decl || reassigned(decl, checker)) return null;
    if (ts.isParameter(decl)) {
      const cb = decl.parent;
      const call = cb.parent;
      if ((!ts.isFunctionExpression(cb) && !ts.isArrowFunction(cb)) || cb.parameters[1] !== decl || decl.dotDotDotToken ||
          !ts.isCallExpression(call) || call.arguments.length !== 1 || call.arguments[0] !== cb) return null;
      const method = member(call.expression, checker);
      if (method?.name !== 'getConnection' || !intact(method.base, ['getConnection'], checker)) return null;
      const role = instance(method.base, checker, depth + 1);
      return mysqlHandle(role) && role.pool && !role.promise ? { ...role, pool: false,
        defaultFormat: role.defaultFormat && hasDriverFormat(method.base, checker) } : null;
    }
    const init = initializer(decl);
    return init ? instance(init, checker, depth + 1) : null;
  }
  if (ts.isNewExpression(node)) {
    const ctor = library(node.expression, checker);
    if (ctor?.package === 'pg' && intact(node.expression, ['prototype', 'query'], checker)) {
      if (ctor.name === 'Pool') return 'pg-pool';
      if (ctor.name === 'Client') return 'pg-client';
    }
  }
  if (ts.isCallExpression(node)) {
    const factory = library(node.expression, checker);
    if (factory?.package === 'express' && ['default', 'Router', 'module'].includes(factory.name)) return 'express-router';
    const mysql = mysqlFactory(node, factory, false);
    if (mysql) return mysql;
    const method = member(node.expression, checker);
    if (method?.name === 'promise' && !node.arguments.length && intact(method.base, ['promise'], checker)) {
      const role = instance(method.base, checker, depth + 1);
      if (mysqlHandle(role) && role.driver === 'mysql2' && !role.promise && role.defaultPromise &&
          intact(method.base, ['config', 'Promise'], checker) && intact(method.base, ['query'], checker) &&
          intact(method.base, ['execute'], checker)) return { ...role, promise: true,
            defaultFormat: role.defaultFormat && hasDriverFormat(method.base, checker) };
    }
    if (method?.name === 'route' && staticPath(node.arguments[0]) && intact(method.base, ['route'], checker) &&
        instance(method.base, checker, depth + 1) === 'express-router') return 'express-route';
  }
  if (ts.isAwaitExpression(node)) {
    const call = unwrap(node.expression);
    if (!ts.isCallExpression(call)) return null;
    const mysql = mysqlFactory(call, library(call.expression, checker), true);
    if (mysql) return mysql;
    if (!call.arguments.length) {
      const method = member(call.expression, checker);
      if (method?.name === 'getConnection' && intact(method.base, ['getConnection'], checker)) {
        const role = instance(method.base, checker, depth + 1);
        if (mysqlHandle(role) && role.pool && role.promise) return { ...role, pool: false,
          defaultFormat: role.defaultFormat && hasDriverFormat(method.base, checker) };
      }
      if (method?.name === 'connect' && intact(method.base, ['connect'], checker) && instance(method.base, checker, depth + 1) === 'pg-pool') return 'pg-client';
    }
  }
  return null;
}

function staticPath(expr: ts.Expression | undefined): boolean {
  return !!expr && ((ts.isStringLiteralLike(expr) && expr.text.startsWith('/')) || ts.isRegularExpressionLiteral(expr));
}

export function firstExpressHandler(call: ts.CallExpression, checker: ts.TypeChecker): number | undefined {
  const method = member(call.expression);
  if (!method || !METHODS.has(method.name) || !intact(method.base, [method.name], checker)) return undefined;
  const role = instance(method.base, checker);
  if (role === 'express-route') return 0;
  if (role === 'express-router' && staticPath(call.arguments[0])) return 1;
  return undefined;
}

function requestHandler(decl: ts.Declaration | undefined, checker: ts.TypeChecker,
  registered?: (parameter: ts.ParameterDeclaration) => boolean): 'inline' | 'registered' | false {
  if (!decl || !ts.isParameter(decl) || !ts.isIdentifier(decl.name) || decl.dotDotDotToken || reassigned(decl, checker)) return false;
  const fn = decl.parent;
  if (fn.parameters[0] !== decl || fn.parameters.length > 3) return false;
  if (registered?.(decl)) return 'registered';
  if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return false;
  const call = fn.parent;
  if (!ts.isCallExpression(call)) return false;
  const start = firstExpressHandler(call, checker);
  return start !== undefined && call.arguments.indexOf(fn) >= start ? 'inline' : false;
}

export function semanticRequestInput(expression: ts.Expression, checker: ts.TypeChecker,
  registered?: (parameter: ts.ParameterDeclaration) => boolean): 'inline' | 'registered' | false {
  const node = unwrap(expression);
  const getter = ts.isCallExpression(node) ? member(node.expression) : null;
  if (ts.isCallExpression(node) && (!getter || !['get', 'header'].includes(getter.name) || node.arguments.length !== 1 ||
      !node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))) return false;
  if (!getter && !member(node)) return false;
  const value = getter?.base ?? node;
  const ref = reference(value, checker);
  if (!ref) return false;
  const source = requestHandler(ref.symbol.valueDeclaration, checker, registered);
  if (!source) return false;
  if (getter) return !ref.path.length && intact(value, [getter.name], checker) && source;
  const [channel] = ref.path;
  if (!channel || !intact(node, [], checker)) return false;
  if (ref.path.length === 1) return ['url', 'originalUrl', 'path', 'hostname'].includes(channel) && source;
  return ref.path.length === 2 && CHANNELS.has(channel) && !PROTOTYPE.has(ref.path[1] ?? '') && source;
}

/* Only a driver's statement argument is parsed as SQL. Values in a separate
 * argument or an options.values array have no bearing on this evidence. */
export function semanticSqlSink(node: ts.Node, checker: ts.TypeChecker): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  const method = member(node.expression, checker), first = node.arguments[0];
  if (!first || ts.isSpreadElement(first) || !method || (method.name !== 'query' && method.name !== 'execute') ||
      !intact(method.base, [method.name], checker)) return null;
  const receiver = instance(method.base, checker);
  const mysql = mysqlHandle(receiver);
  if (mysql) {
    if (method.name === 'execute' && receiver.driver !== 'mysql2') return null;
    const core = receiver.promise ? [receiver.pool ? 'pool' : 'connection'] : [];
    if (receiver.promise && (!intact(method.base, ['Promise'], checker) || !intact(method.base, [...core, method.name], checker))) return null;
    if (receiver.pool && !intact(method.base, [...core, 'getConnection'], checker)) return null;
    if (method.name === 'query' && (!receiver.defaultFormat || !hasDriverFormat(method.base, checker, core))) return null;
  } else if ((receiver !== 'pg-client' && receiver !== 'pg-pool') || method.name !== 'query') return null;
  const argument = unwrap(first);
  if (!ts.isObjectLiteralExpression(argument)) return argument;
  const key = mysql ? 'sql' : 'text';
  let text: ts.Expression | null = null;
  for (const prop of argument.properties) {
    if ((!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) ||
        (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name)) || prop.name.text === '__proto__' ||
        (!mysql && prop.name.text === 'submit')) return null;
    if (prop.name.text === key) text = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
  }
  return text;
}
