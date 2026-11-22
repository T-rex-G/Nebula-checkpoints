import ts from 'typescript';

export function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) ||
      ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

export function member(expression: ts.Expression): { base: ts.Expression; name: string; key: ts.Node } | null {
  const value = unwrap(expression);
  if (ts.isPropertyAccessExpression(value)) return { base: value.expression, name: value.name.text, key: value.name };
  if (ts.isElementAccessExpression(value) && ts.isStringLiteralLike(value.argumentExpression)) {
    return { base: value.expression, name: value.argumentExpression.text, key: value.argumentExpression };
  }
  return null;
}

interface ImportOrigin { package: string; name: string }
type ImportUse = 'value' | 'type';

/* TypeScript can bind names in JavaScript or an unchecked TypeScript file even
 * when the source reassigns an imported function. A binding with an observed
 * write cannot certify a platform object or a text encoder. */
interface Writes { readonly bindings: Set<ts.Declaration>; readonly globals: Set<string> }
const writesByFile = new WeakMap<ts.SourceFile, Writes>();
function writesIn(file: ts.SourceFile, checker: ts.TypeChecker): Writes {
  const cached = writesByFile.get(file);
  if (cached) return cached;
  const writes: Writes = { bindings: new Set(), globals: new Set() };
  function record(target: ts.Expression): void {
    const node = unwrap(target);
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) if (!ts.isOmittedExpression(item)) record(ts.isSpreadElement(item) ? item.expression : item);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) record(prop.initializer);
        if (ts.isShorthandPropertyAssignment(prop)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(prop);
          for (const decl of symbol?.declarations ?? []) writes.bindings.add(decl);
          if (!symbol?.declarations?.length) writes.globals.add(prop.name.text);
        }
        if (ts.isSpreadAssignment(prop)) record(prop.expression);
      }
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) { record(node.left); return; }
    const prop = member(node);
    const key = prop?.key ?? node;
    const symbol = checker.getSymbolAtLocation(key);
    for (const decl of symbol?.declarations ?? []) writes.bindings.add(decl);
    if (ts.isIdentifier(node) && !symbol?.declarations?.length) writes.globals.add(node.text);
    if (prop && ts.isIdentifier(prop.base)) {
      const host = checker.getSymbolAtLocation(prop.base);
      for (const decl of host?.declarations ?? []) if (ts.isNamespaceImport(decl)) writes.bindings.add(decl);
      if (!host?.declarations?.length && ['globalThis', 'window', 'self'].includes(prop.base.text)) writes.globals.add(prop.name);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) record(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) record(node.operand);
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) record(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(file);
  writesByFile.set(file, writes);
  return writes;
}

export function reassigned(decl: ts.Declaration, checker: ts.TypeChecker): boolean {
  return writesIn(decl.getSourceFile(), checker).bindings.has(decl);
}

/* Resolve the lexical import itself. A locally declared lookalike or a
 * type-only import used as a value has no runtime library identity. */
function importedName(node: ts.Identifier, checker: ts.TypeChecker, use: ImportUse): ImportOrigin | null {
  const declarations = checker.getSymbolAtLocation(node)?.declarations;
  if (declarations?.length !== 1) return null;
  const declaration = declarations[0];
  if (!declaration || (use === 'value' && reassigned(declaration, checker))) return null;
  let clause: ts.ImportClause, name: string;
  if (ts.isImportSpecifier(declaration)) {
    if (declaration.isTypeOnly && use === 'value') return null;
    clause = declaration.parent.parent;
    name = (declaration.propertyName ?? declaration.name).text;
  } else if (ts.isNamespaceImport(declaration)) {
    clause = declaration.parent;
    name = '*';
  } else if (ts.isImportClause(declaration)) {
    clause = declaration;
    name = 'default';
  } else return null;
  if ((clause.isTypeOnly && use === 'value') || !ts.isStringLiteral(clause.parent.moduleSpecifier)) return null;
  return { package: clause.parent.moduleSpecifier.text, name };
}

export function importOrigin(expression: ts.Expression | ts.EntityName, checker: ts.TypeChecker, use: ImportUse): ImportOrigin | null {
  if (ts.isIdentifier(expression)) return importedName(expression, checker, use);
  const root = ts.isQualifiedName(expression) ? expression.left : ts.isPropertyAccessExpression(expression) ? expression.expression : null;
  if (!root || !ts.isIdentifier(root)) return null;
  const origin = importedName(root, checker, use);
  if (origin?.name !== '*') return null;
  const name = ts.isQualifiedName(expression) ? expression.right.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
  return name === null ? null : { package: origin.package, name };
}

export function valueDeclaration(expr: ts.Expression, checker: ts.TypeChecker): ts.Declaration | null {
  const node = unwrap(expr), symbol = checker.getSymbolAtLocation(member(node)?.key ?? node);
  return symbol?.valueDeclaration ?? (symbol?.declarations?.length === 1 ? symbol.declarations[0] ?? null : null);
}

export function initializer(decl: ts.Declaration | null): ts.Expression | null {
  if (decl && ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const)) return decl.initializer ?? null;
  if (decl && ts.isPropertyDeclaration(decl) && decl.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ReadonlyKeyword)) {
    return decl.initializer ?? null;
  }
  return null;
}

/* The virtual project has no ambient npm or framework libraries. When the
 * built-in library is absent an unbound lexical name can denote the platform
 * global; a declaration in scanned source takes precedence. */
export function globalName(node: ts.Node, name: string, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  const symbol = checker.getSymbolAtLocation(node);
  const file = node.getSourceFile();
  if (name === 'require' && /\.m[jt]s$/.test(file.fileName)) return false;
  // For JavaScript the binder synthesizes a declaration-free CommonJS loader symbol.
  const implicitRequire = name === 'require' && symbol?.flags === (ts.SymbolFlags.Transient | ts.SymbolFlags.Property)
    && !symbol.declarations?.length;
  return (symbol === undefined || implicitRequire) && !writesIn(file, checker).globals.has(name);
}
