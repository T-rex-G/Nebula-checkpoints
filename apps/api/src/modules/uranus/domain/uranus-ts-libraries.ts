/* Resolve lexical imports and unshadowed CommonJS modules without loading them. */
import ts from 'typescript';
import { globalName, importOrigin, initializer, member, reassigned, unwrap, valueDeclaration } from './uranus-ts-symbols.ts';

const MAX_ALIASES = 16;
export type LibraryExport = { package: string; name: string; moduleObject?: boolean };
interface Reference { symbol: ts.Symbol; path: readonly string[] }
interface Changes { writes: Set<string>; escapes: Set<string> }
const changesByFile = new WeakMap<ts.SourceFile, ReadonlyMap<ts.Symbol, Changes>>();

/* Follow local const aliases all the way to the receiver, including aliases of
 * a request's query or body record. An assigned binding has no stable alias. */
export function reference(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): Reference | null {
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

export function intact(expression: ts.Expression, suffix: readonly string[], checker: ts.TypeChecker): boolean {
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

function qualifiedName(owner: LibraryExport, key: string): string {
  return owner.moduleObject ? key : owner.name + '.' + key;
}

export function library(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): LibraryExport | null {
  if (depth > MAX_ALIASES) return null;
  const node = unwrap(expression);
  const imported = importOrigin(node, checker, 'value');
  if (imported && !imported.name.includes('.') && intact(node, [], checker)) {
    const namespace = ts.isIdentifier(node) && valueDeclaration(node, checker);
    return { ...imported, moduleObject: imported.name === 'default' ||
      (imported.name === '*' && !!namespace && ts.isNamespaceImport(namespace)) };
  }
  if (ts.isCallExpression(node) && globalName(node.expression, 'require', checker) &&
      node.arguments.length === 1 && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
    return { package: node.arguments[0].text, name: 'module', moduleObject: true };
  }
  const prop = member(node, checker);
  if (prop && !prop.name.includes('.')) {
    const root = library(prop.base, checker, depth + 1);
    if (root && intact(prop.base, [prop.name], checker)) {
      return { package: root.package, name: qualifiedName(root, prop.name) };
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
      if (source && !key.text.includes('.') && intact(init, [key.text], checker)) return { package: source.package, name: qualifiedName(source, key.text) };
    }
    return null;
  }
  const init = initializer(decl);
  return init ? library(init, checker, depth + 1) : null;
}
