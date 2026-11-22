/* Runtime models for Express request data and node-postgres statement text. */
import ts from 'typescript';
import { globalName, importOrigin, initializer, member, reassigned, unwrap, valueDeclaration } from './uranus-ts-symbols.ts';

const MAX_ALIASES = 16;
const METHODS = new Set(['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const CHANNELS = new Set(['params', 'query', 'body', 'headers']);
const PROTOTYPE = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

type LibraryExport = { package: string; name: string };
type Instance = 'pg-pool' | 'pg-client' | 'express-router' | 'express-route';
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

function instance(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): Instance | null {
  if (depth > MAX_ALIASES) return null;
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    const decl = valueDeclaration(node, checker);
    const init = decl && !reassigned(decl, checker) && initializer(decl);
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
    const method = member(node.expression);
    if (method?.name === 'route' && staticPath(node.arguments[0]) && intact(method.base, ['route'], checker) &&
        instance(method.base, checker, depth + 1) === 'express-router') return 'express-route';
  }
  if (ts.isAwaitExpression(node)) {
    const call = unwrap(node.expression);
    if (ts.isCallExpression(call) && !call.arguments.length) {
      const method = member(call.expression);
      if (method?.name === 'connect' && intact(method.base, ['connect'], checker) && instance(method.base, checker, depth + 1) === 'pg-pool') return 'pg-client';
    }
  }
  return null;
}

function staticPath(expr: ts.Expression | undefined): boolean {
  return !!expr && ((ts.isStringLiteralLike(expr) && expr.text.startsWith('/')) || ts.isRegularExpressionLiteral(expr));
}

function requestHandler(decl: ts.Declaration | undefined, checker: ts.TypeChecker): boolean {
  if (!decl || !ts.isParameter(decl) || !ts.isIdentifier(decl.name) || decl.dotDotDotToken || reassigned(decl, checker)) return false;
  const fn = decl.parent;
  if ((!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) || fn.parameters[0] !== decl || fn.parameters.length > 3) return false;
  const call = fn.parent;
  if (!ts.isCallExpression(call)) return false;
  const slot = call.arguments.indexOf(fn), method = member(call.expression);
  if (slot < 0 || !method || !METHODS.has(method.name) || !intact(method.base, [method.name], checker)) return false;
  const role = instance(method.base, checker);
  return role === 'express-route' || (role === 'express-router' && slot > 0 && staticPath(call.arguments[0]));
}

export function semanticRequestInput(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const node = unwrap(expression);
  const getter = ts.isCallExpression(node) ? member(node.expression) : null;
  if (ts.isCallExpression(node) && (!getter || !['get', 'header'].includes(getter.name) || node.arguments.length !== 1 ||
      !node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))) return false;
  if (!getter && !member(node)) return false;
  const value = getter?.base ?? node;
  const ref = reference(value, checker);
  if (!ref || !requestHandler(ref.symbol.valueDeclaration, checker)) return false;
  if (getter) return !ref.path.length && intact(value, [getter.name], checker);
  const [channel] = ref.path;
  if (!channel || !intact(node, [], checker)) return false;
  if (ref.path.length === 1) return ['url', 'originalUrl', 'path', 'hostname'].includes(channel);
  return ref.path.length === 2 && CHANNELS.has(channel) && !PROTOTYPE.has(ref.path[1] ?? '');
}

/* The pg API accepts statement text as its first argument or its config.text
 * property. A custom submit object has its own execution semantics. Spreads,
 * accessors and computed names cannot prove which text the driver receives. */
export function semanticSqlSink(node: ts.Node, checker: ts.TypeChecker): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  const method = member(node.expression), first = node.arguments[0];
  if (!first || ts.isSpreadElement(first) || method?.name !== 'query' || !intact(method.base, ['query'], checker)) return null;
  const receiver = instance(method.base, checker);
  if (receiver !== 'pg-client' && receiver !== 'pg-pool') return null;
  const argument = unwrap(first);
  if (!ts.isObjectLiteralExpression(argument)) return argument;
  let text: ts.Expression | null = null;
  for (const prop of argument.properties) {
    if ((!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) ||
        (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name)) || ['__proto__', 'submit'].includes(prop.name.text)) return null;
    if (prop.name.text === 'text') text = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
  }
  return text;
}
