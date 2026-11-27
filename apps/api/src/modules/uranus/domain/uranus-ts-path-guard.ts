// A guard proves only a restriction on normalized path strings. Filesystem
// resolution, including symbolic links, still requires validation.
import { posix, win32 } from 'node:path';
import ts from 'typescript';
import { pathOperation } from './uranus-ts-filesystem.ts';
import { constantText, constInitializer, member, methodReplaced, unwrap } from './uranus-ts-symbols.ts';

type Dialect = NonNullable<ReturnType<typeof pathOperation>>['dialect'];

/* Resolve immutable captures to the same AST value. Repeating a call or
 * reading a property twice does not establish identity. */
function captured(expression: ts.Expression, checker: ts.TypeChecker): ts.Expression | null {
  let node = unwrap(expression);
  for (let depth = 0; depth < 16; depth++) {
    if (!ts.isIdentifier(node)) return node;
    const init = constInitializer(node, checker);
    if (!init) return null;
    node = unwrap(init);
  }
  return null;
}

function directory(expression: ts.Expression, dialect: Dialect, checker: ts.TypeChecker): boolean {
  const value = constantText(expression, checker);
  if (!value || value.includes('\0')) return false;
  if (dialect === 'win32') return /^[a-z]:\\/i.test(value) && win32.normalize(value) === value && value !== win32.parse(value).root;
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value || value === '/') return false;
  // A native slash-rooted spelling must describe the same segments on Windows.
  return dialect === 'posix' || win32.normalize(value).split('\\').join('/') === value;
}

export function restrictedDirectory(expression: ts.Expression, guards: ReadonlyMap<ts.Node, boolean>, checker: ts.TypeChecker): boolean {
  if (!guards.size) return false;
  const target = captured(expression, checker);
  if (!target || !ts.isCallExpression(target)) return false;
  const constructor = pathOperation(target.expression, checker);
  if (!constructor || (constructor.name !== 'join' && constructor.name !== 'resolve')) return false;
  const { dialect } = constructor;
  const first = target.arguments[0];
  // relative() resolves relative input against a working directory that can
  // change before the filesystem call. Require an already anchored target.
  const anchored = constructor.name === 'resolve' || (!!first && directory(first, dialect, checker));
  const exclusions = new Map<ts.CallExpression, Set<'absolute' | 'parent' | 'ancestor'>>();
  let budget = 64;

  function separator(expression: ts.Expression): boolean {
    const op = pathOperation(expression, checker);
    return op?.name === 'sep' && op.dialect === dialect;
  }

  function prefix(expression: ts.Expression, parent: boolean): boolean {
    const node = captured(expression, checker);
    if (!node || !ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken || !separator(node.right)) return false;
    return parent ? constantText(node.left, checker) === '..' : directory(node.left, dialect, checker);
  }

  function exclude(relative: ts.Expression, part: 'absolute' | 'parent' | 'ancestor'): boolean {
    const rel = captured(relative, checker);
    if (!anchored || !rel || !ts.isCallExpression(rel) || rel.arguments.length !== 2) return false;
    const [root, value] = rel.arguments;
    if (!root || !value || captured(value, checker) !== target || !directory(root, dialect, checker)) return false;
    const operation = pathOperation(rel.expression, checker);
    if (operation?.name !== 'relative' || operation.dialect !== dialect) return false;
    const facts = exclusions.get(rel) ?? new Set<'absolute' | 'parent' | 'ancestor'>();
    facts.add(part);
    exclusions.set(rel, facts);
    return facts.size === 3;
  }

  function proves(condition: ts.Expression, taken: boolean): boolean {
    if (--budget < 0) return false;
    const node = unwrap(condition);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return proves(node.operand, !taken);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      // Only facts that hold together can populate the same relative-path proof.
      if (op === (taken ? ts.SyntaxKind.AmpersandAmpersandToken : ts.SyntaxKind.BarBarToken)) {
        return proves(node.left, taken) || proves(node.right, taken);
      }
      if (op !== (taken ? ts.SyntaxKind.ExclamationEqualsEqualsToken : ts.SyntaxKind.EqualsEqualsEqualsToken)) return false;
      if (constantText(node.right, checker) === '..') return exclude(node.left, 'parent');
      return constantText(node.left, checker) === '..' && exclude(node.right, 'parent');
    }
    if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
    const argument = node.arguments[0];
    if (!argument) return false;
    const method = member(node.expression, checker);
    if (method?.name === 'startsWith' && !methodReplaced(node, method.base, method.name, checker)) {
      return taken ? captured(method.base, checker) === target && prefix(argument, false) :
        prefix(argument, true) && exclude(method.base, 'ancestor');
    }
    if (taken) return false;
    const op = pathOperation(node.expression, checker);
    return op?.name === 'isAbsolute' && op.dialect === dialect && exclude(argument, 'absolute');
  }

  for (const [guard, taken] of guards) {
    if (budget <= 0) break;
    if (ts.isExpression(guard) && proves(guard, taken)) return true;
  }
  return false;
}
