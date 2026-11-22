// Structural control facts shared by reaching definitions and function-return summaries.
import ts from 'typescript';
import { unwrap } from './uranus-ts-symbols.ts';

export function runtimeFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

export function primitive(node: ts.Expression): string | number | boolean | null | undefined {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

export function constantTruth(expression: ts.Expression): boolean | undefined {
  const node = unwrap(expression);
  const value = primitive(node);
  if (value !== undefined) return Boolean(value);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = constantTruth(node.operand);
    return inner === undefined ? undefined : !inner;
  }
  if (ts.isBinaryExpression(node)) {
    const left = primitive(node.left), right = primitive(node.right);
    if (left !== undefined && right !== undefined) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
      if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
    }
  }
  return undefined;
}

export type Owner = ts.SourceFile | ts.FunctionLikeDeclaration;
export interface ControlFacts {
  readonly owner: Owner;
  readonly live: boolean;
  readonly tests: ReadonlyMap<ts.Node, boolean>;
}

interface Prior {
  readonly parent?: Prior;
  readonly test?: ts.Expression;
  readonly taken?: boolean;
  readonly dead?: boolean;
}
const entry: Prior = {};

export function controlReader(visit: () => boolean) {
  const summaries = new WeakMap<ts.Statement, boolean>();
  const prefixes = new WeakMap<ts.Statement, Prior>();
  const blocks = new WeakSet<ts.Node>();
  const cache = new WeakMap<ts.Node, ControlFacts>();
  const conditions = new WeakMap<ts.Node, ts.Expression>();

  function exits(stmt: ts.Statement, depth = 0, truth = constantTruth): boolean {
    const prior = truth === constantTruth ? summaries.get(stmt) : undefined;
    if (prior !== undefined) return prior;
    if (depth > 48 || !visit()) return false;
    let result = ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt) || ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt);
    const ends = (child: ts.Statement) => exits(child, depth + 1, truth);
    if (ts.isBlock(stmt)) result = stmt.statements.some(ends);
    if (ts.isIfStatement(stmt)) {
      const condition = truth(stmt.expression);
      if (condition === true) result = ends(stmt.thenStatement);
      else if (condition === false) result = !!stmt.elseStatement && ends(stmt.elseStatement);
      else result = !!stmt.elseStatement && ends(stmt.thenStatement) && ends(stmt.elseStatement);
    }
    if (ts.isTryStatement(stmt)) result = (!!stmt.finallyBlock && ends(stmt.finallyBlock)) ||
      (ends(stmt.tryBlock) && (!stmt.catchClause || ends(stmt.catchClause.block)));
    if (truth === constantTruth) summaries.set(stmt, result);
    return result;
  }

  function prefix(block: ts.Block | ts.SourceFile | ts.CaseClause | ts.DefaultClause, statement: ts.Statement): Prior {
    if (!blocks.has(block)) {
      let prior = entry;
      for (const child of block.statements) {
        if (!visit()) break;
        prefixes.set(child, prior);
        if (prior.dead) continue;
        if (exits(child)) prior = { dead: true };
        else if (ts.isIfStatement(child)) {
          if (exits(child.thenStatement)) prior = { parent: prior, test: child.expression, taken: false };
          else if (child.elseStatement && exits(child.elseStatement)) prior = { parent: prior, test: child.expression, taken: true };
        }
      }
      blocks.add(block);
    }
    return prefixes.get(statement) ?? entry;
  }

  function facts(node: ts.Node): ControlFacts {
    const saved = cache.get(node);
    if (saved) return saved;
    let current = node;
    let live = true;
    const tests = new Map<ts.Node, boolean>();
    function add(test: ts.Expression, taken: boolean): void {
      conditions.set(test, test);
      const fixed = constantTruth(test);
      if ((fixed !== undefined && fixed !== taken) || (tests.has(test) && tests.get(test) !== taken)) live = false;
      tests.set(test, taken);
    }
    while (current.parent && !ts.isSourceFile(current) && (current === node || !runtimeFunction(current))) {
      if (!visit()) break;
      const parent = current.parent;
      if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
        if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) tests.set(parent, true);
        if (ts.isStatement(current)) {
          let prior: Prior | undefined = prefix(parent, current);
          while (prior && visit()) {
            if (prior.dead) live = false;
            if (prior.test) add(prior.test, !!prior.taken);
            prior = prior.parent;
          }
        }
      } else if (ts.isIfStatement(parent)) {
        if (current === parent.thenStatement) add(parent.expression, true);
        if (current === parent.elseStatement) add(parent.expression, false);
      } else if (ts.isConditionalExpression(parent)) {
        if (current === parent.whenTrue) add(parent.condition, true);
        if (current === parent.whenFalse) add(parent.condition, false);
      } else if (ts.isBinaryExpression(parent) && current === parent.right) {
        const op = parent.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) add(parent.left, true);
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.BarBarEqualsToken) add(parent.left, false);
        if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
          const left = primitive(parent.left);
          if (left !== undefined && left !== null) live = false;
          if (left === undefined) tests.set(parent.operatorToken, true);
        }
      } else if (ts.isIterationStatement(parent, false)) {
        const update = ts.isForStatement(parent) && current === parent.incrementor;
        const nextItem = (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && current === parent.initializer;
        if (current === parent.statement || update || nextItem) {
          tests.set(parent, true);
          if (ts.isWhileStatement(parent)) add(parent.expression, true);
          if (ts.isForStatement(parent) && parent.condition) add(parent.condition, true);
          // An update precedes the body lexically but first executes after it.
          if (update) tests.set(parent.statement, true);
        }
      } else if ((ts.isCallExpression(parent) || ts.isElementAccessExpression(parent)) &&
          ts.isOptionalChain(parent) && current !== parent.expression) tests.set(parent, true);
      else if (ts.isCatchClause(parent) || ts.isLabeledStatement(parent)) tests.set(parent, true);
      else if (ts.isTryStatement(parent) && current === parent.tryBlock) tests.set(parent, true);
      current = parent;
    }
    const owner = runtimeFunction(current) || ts.isSourceFile(current) ? current : node.getSourceFile();
    const result = { owner, live, tests };
    cache.set(node, result);
    return result;
  }
  return { facts, exits, condition: (guard: ts.Node) => conditions.get(guard) };
}

// Split a still-unexplained path by the guards on a candidate assignment.
// The intersection takes that definition; each disjoint residual reaches an earlier one.
export function subtractGuards(path: ReadonlyMap<ts.Node, boolean>, guards: ReadonlyMap<ts.Node, boolean>):
    ReadonlyMap<ts.Node, boolean>[] | null {
  for (const [test, taken] of guards) if (path.has(test) && path.get(test) !== taken) return null;
  const missing = [...guards].filter(([test]) => !path.has(test));
  const remaining: ReadonlyMap<ts.Node, boolean>[] = [];
  let matched = path;
  for (const [test, taken] of missing) {
    remaining.push(new Map(matched).set(test, !taken));
    matched = new Map(matched).set(test, taken);
  }
  return remaining;
}
