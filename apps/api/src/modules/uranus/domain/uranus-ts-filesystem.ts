/* Node core filesystem APIs take filenames in documented argument slots. No
 * repository module, filename, or input string is evaluated by this model. */
import ts from 'typescript';
import { filesystemPathCount } from './uranus-ts-candidates.ts';
import { library } from './uranus-ts-libraries.ts';
import { member, reassigned, unwrap } from './uranus-ts-symbols.ts';

/* Stream overrides, symbolic-link targets and FileHandle methods have different
 * contracts. Only plain path positions on a recognized module export qualify. */
export function filesystemPaths(call: ts.CallExpression, checker: ts.TypeChecker): readonly ts.Expression[] {
  const callee = unwrap(call.expression);
  if (!call.arguments.length) return [];
  const prop = member(callee, checker);
  if (prop ? !filesystemPathCount(prop.name.replace(/Sync$/, '')) : !ts.isIdentifier(callee)) return [];
  const id = library(callee, checker);
  if (!id || !['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].includes(id.package)) return [];
  const nested = id.name.startsWith('promises.');
  const promisesModule = id.package.endsWith('/promises');
  if (promisesModule && nested) return [];
  const name = nested ? id.name.slice('promises.'.length) : id.name;
  const sync = name.endsWith('Sync');
  if (sync && (nested || promisesModule)) return [];
  const operation = sync ? name.slice(0, -4) : name;
  const count = filesystemPathCount(operation);
  const callback = !sync && !nested && !promisesModule;
  const required = operation === 'writeFile' || operation === 'appendFile' ? 2 : count;
  if (!count || call.arguments.length < required + Number(callback) || call.arguments.some(ts.isSpreadElement)) return [];
  if (callback) {
    const last = call.arguments[call.arguments.length - 1];
    const fn = last && unwrap(last);
    if (!fn || (!ts.isIdentifier(fn) && !ts.isPropertyAccessExpression(fn) && !ts.isElementAccessExpression(fn) &&
        !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return [];
  }
  return call.arguments.slice(0, count);
}

/* A strict comparison can restrict an unchanged local binding to a finite set
 * of actual string literals. Property getters, conversions and mutable bindings
 * do not preserve this fact between the guard and the filesystem call. */
export function fixedPathChoice(expression: ts.Expression, guards: ReadonlyMap<ts.Node, boolean>, checker: ts.TypeChecker): boolean {
  const value = unwrap(expression);
  if (!ts.isIdentifier(value) || !guards.size) return false;
  const symbol = checker.getSymbolAtLocation(value);
  const decl = symbol?.valueDeclaration;
  if (!decl || (!ts.isVariableDeclaration(decl) && !ts.isParameter(decl)) || reassigned(decl, checker)) return false;
  let budget = 64;
  function restricts(condition: ts.Expression, taken: boolean): boolean {
    if (--budget < 0) return false;
    const node = unwrap(condition);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return restricts(node.operand, !taken);
    if (!ts.isBinaryExpression(node)) return false;
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
      // A disjunction taken (or a conjunction rejected) admits either branch.
      if ((op === ts.SyntaxKind.BarBarToken) === taken) return restricts(node.left, taken) && restricts(node.right, taken);
      return restricts(node.left, taken) || restricts(node.right, taken);
    }
    if (op !== (taken ? ts.SyntaxKind.EqualsEqualsEqualsToken : ts.SyntaxKind.ExclamationEqualsEqualsToken)) return false;
    const left = unwrap(node.left), right = unwrap(node.right);
    const tested = ts.isStringLiteralLike(left) ? right : ts.isStringLiteralLike(right) ? left : undefined;
    return !!tested && ts.isIdentifier(tested) && checker.getSymbolAtLocation(tested) === symbol;
  }
  for (const [guard, taken] of guards) {
    if (budget <= 0) break;
    if (ts.isExpression(guard) && restricts(guard, taken)) return true;
  }
  return false;
}
