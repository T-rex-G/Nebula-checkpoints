// Demand-driven reaching definitions and call-site return values for the bounded JS/TS project.
import ts from 'typescript';
import { constantTruth, controlReader, guardedComparison, primitive, runtimeFunction, subtractGuards, type ControlFacts } from './uranus-ts-control.ts';
import { frameworkValue } from './uranus-ts-framework.ts';
import { firstExpressHandler, semanticRequestInput } from './uranus-ts-sql.ts';
import { member, unwrap } from './uranus-ts-symbols.ts';
import { htmlTextPieces } from './uranus-sanitise.ts';

export interface SemanticValue {
  readonly kind: 'literal' | 'scalar' | 'encoded-text' | 'trusted-html' | 'input' | 'unknown';
  readonly origin?: ts.Node;
  readonly steps?: readonly ts.Node[];
  readonly conditional?: boolean;
  /** Runtime shape for query fields. A node witnesses an unrestricted Express field. */
  readonly filterOperand?: ts.Node | 'primitive';
  readonly truth?: boolean;
  readonly atom?: string | number | boolean | null;
  readonly plain?: boolean;
  readonly reason?: string;
  readonly project?: (name: string, depth: number) => SemanticValue;
}
const unknown: SemanticValue = { kind: 'unknown' };
const unresolvedCall: SemanticValue = { kind: 'unknown', reason: 'unresolved-call' };
const unresolvedTag: SemanticValue = { kind: 'unknown', reason: 'unresolved-tag' };
const unresolvedMember: SemanticValue = { kind: 'unknown', reason: 'unresolved-member' };
const literal: SemanticValue = { kind: 'literal' };
const undefinedValue: SemanticValue = { kind: 'literal', truth: false, plain: true, reason: 'undefined' };
const scalar: SemanticValue = { kind: 'scalar' };
const MAX_DEPTH = 52;
const MAX_PATHS = 32;
const MAX_CALLEES = 16;
const MAX_DEFINITIONS = 128;
const MAX_VISITS = 900_000;
const numericAssignments = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
]);

type Environment = ReadonlyMap<ts.Symbol, SemanticValue>;
const empty: Environment = new Map();
interface Definition {
  readonly node: ts.Node;
  readonly expression?: ts.Expression;
  readonly previous?: ts.Expression;
  readonly logical?: ts.SyntaxKind;
  readonly value?: SemanticValue;
}
type RuntimeFunction = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

function scalarOperand(left: ts.Expression, right: ts.Expression): ts.Expression | undefined {
  const type = ts.isTypeOfExpression(left) ? left : ts.isTypeOfExpression(right) ? right : undefined;
  const tag = type === left ? right : left;
  return type && ts.isStringLiteralLike(tag) && ['string', 'number', 'boolean', 'bigint'].includes(tag.text)
    ? unwrap(type.expression) : undefined;
}

function through(value: SemanticValue, node: ts.Node): SemanticValue {
  const project = value.project;
  if (project) return { ...value, project: (name, depth) => through(project(name, depth), node) };
  if (value.kind !== 'input') return value;
  const prior = value.steps ?? [];
  if (prior.includes(node) || prior.length >= 10 || node === value.origin) return value;
  return { ...value, steps: [...prior, node] };
}

function outerExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isExpression(current.parent) && unwrap(current.parent) === node) current = current.parent;
  return current;
}

function writeOrEscape(read: ts.Expression): boolean {
  let node = outerExpression(read);
  let parent = node.parent;
  // Follow a nested destructuring target to the enclosing assignment or loop.
  while (ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent) || ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) || (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
      (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
    if (ts.isBinaryExpression(parent)) return true;
    const next = parent.parent;
    if (ts.isExpression(parent)) node = parent;
    parent = next;
  }
  if (ts.isBinaryExpression(parent)) return parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return parent.initializer === node;
  if (ts.isCallExpression(parent) || ts.isTaggedTemplateExpression(parent))
    return ts.isCallExpression(parent) ? parent.expression === node : parent.tag === node;
  return ts.isDeleteExpression(parent) || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken));
}

function staticName(node: ts.PropertyName | ts.Expression): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
  return undefined;
}

export function createSemanticReader(checker: ts.TypeChecker, pathOf: (node: ts.Node) => string,
    stop: () => boolean, files: readonly ts.SourceFile[] = []) {
  const definitions = new Map<ts.Symbol, Definition[]>();
  const calls = new Map<RuntimeFunction, ts.CallExpression[]>();
  const routeParameters = new Set<ts.Symbol>();
  const returns = new Map<RuntimeFunction, ts.ReturnStatement[]>();
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const pathsBySymbol = new Map<ts.Symbol, Map<string, boolean>>();
  const dynamicScopes = new WeakSet<ts.Node>();
  const argumentsMayAlias = new WeakSet<ts.Node>();
  const active = new Set<ts.Node>();
  const activeCalls = new Set<RuntimeFunction>();
  const results = new WeakMap<ts.Expression, SemanticValue>();
  let visits = 0, interrupted = false, limited = false;
  function visit(): boolean {
    if (interrupted) return false;
    if (++visits > MAX_VISITS || ((visits & 255) === 0 && stop())) interrupted = limited = true;
    return !interrupted;
  }
  function cutoff(): SemanticValue { limited = true; return unknown; }
  const control = controlReader(visit);

  /* A join represents alternatives. A concrete input on only one arm remains a
   * witness, with its conditional status carried through every caller. */
  function alternatives(values: readonly SemanticValue[]): SemanticValue {
    if (!values.length) return unknown;
    const witness = values.find(value => value.kind === 'input');
    if (witness) {
      const source = values.find(value => value.kind === 'input' && value.reason === 'unverified-tag') ??
        values.find(value => value.kind === 'input' && !value.conditional) ?? witness;
      const conditional = values.some(value => value.kind !== 'input' || value.conditional || value.origin !== source.origin);
      const open = values.find(v => v.filterOperand && v.filterOperand !== 'primitive');
      const filterOperand = open?.filterOperand ?? (values.every(v => v.filterOperand === 'primitive' || v.kind === 'scalar' ||
        v.kind === 'literal') ? 'primitive' : undefined);
      return { ...source, conditional: source.conditional || conditional, filterOperand };
    }
    const first = values[0];
    if (values.some(value => value.project)) {
      if (values.length === 1 && first) return first;
      return { kind: 'unknown', truth: values.every(value => value.truth === true) ? true : undefined,
        project(name, depth) {
            if (depth >= MAX_DEPTH || !visit()) return cutoff();
            const fields: SemanticValue[] = [];
            for (const value of values) {
              if (!visit()) return cutoff();
              fields.push(value.project?.(name, depth + 1) ?? unknown);
            }
            return alternatives(fields);
          } };
    }
    if (values.some(value => value.reason === 'unresolved-tag')) return unresolvedTag;
    if (values.some(value => value.kind === 'unknown' && value.reason === 'unresolved-call')) return unresolvedCall;
    if (values.some(value => value.reason === 'unresolved-member'))
      return values.every(value => value.reason === 'unresolved-member' || value.kind === 'literal' || value.kind === 'scalar') ? unresolvedMember : unknown;
    if (first && values.every(value => value.kind === first.kind)) {
      if (first.kind === 'literal' || first.kind === 'scalar') return { kind: first.kind,
        truth: values.every(value => value.truth === first.truth) ? first.truth : undefined, plain: values.every(value => value.plain),
        atom: values.every(value => value.atom === first.atom) ? first.atom : undefined,
        reason: values.every(value => value.reason === first.reason) ? first.reason : undefined };
      return first;
    }
    if (values.every(value => value.kind === 'literal' || value.kind === 'scalar')) return literal;
    return unknown;
  }

  function symbol(node: ts.Node): ts.Symbol | undefined {
    let id = checker.getSymbolAtLocation(node);
    for (let depth = 0; id && (id.flags & ts.SymbolFlags.Alias); depth++) {
      if (depth > 16) return undefined;
      for (const d of id.declarations ?? []) {
        if ((ts.isImportClause(d) || ts.isImportSpecifier(d) || ts.isExportSpecifier(d)) && d.isTypeOnly) return undefined;
        if (ts.isImportSpecifier(d) && d.parent.parent.isTypeOnly) return undefined;
        if (ts.isExportSpecifier(d) && d.parent.parent.isTypeOnly) return undefined;
      }
      id = checker.getImmediateAliasedSymbol(id);
    }
    return id;
  }

  function define(name: ts.Identifier, definition: Definition) {
    const id = symbol(name);
    if (!id) return;
    const list = definitions.get(id);
    if (list) list.push(definition);
    else definitions.set(id, [definition]);
  }

  /* Only direct lexical functions and literal module namespaces have an exact
   * call identity. A type signature on a dynamic instance does not identify
   * the implementation that will run. */
  function target(expression: ts.Expression, depth = 0): RuntimeFunction | undefined {
    if (depth > 8 || !visit()) return undefined;
    const node = unwrap(expression);
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
    const access = member(node);
    if (access) {
      if (!ts.isIdentifier(access.base)) return undefined;
      const decls = checker.getSymbolAtLocation(access.base)?.declarations;
      if (decls?.length !== 1 || !decls[0] || !ts.isNamespaceImport(decls[0]) || decls[0].parent.isTypeOnly) return undefined;
    } else if (!ts.isIdentifier(node)) return undefined;
    const id = symbol(access?.key ?? node);
    const fn = id?.valueDeclaration;
    if (!id || definitions.get(id)?.some(d => d.node !== fn)) return undefined;
    if (fn && ts.isFunctionDeclaration(fn) && hasBody(fn)) return fn;
    if (fn && ts.isVariableDeclaration(fn) && ts.isVariableDeclarationList(fn.parent)
        && (fn.parent.flags & ts.NodeFlags.Const) && fn.initializer) return target(fn.initializer, depth + 1);
    return undefined;
  }
  function fnWithBody(fn: ts.FunctionLikeDeclaration): RuntimeFunction | undefined {
    return fn.body && hasBody(fn) ? fn : undefined;
  }
  function hasBody(fn: ts.FunctionLikeDeclaration): fn is RuntimeFunction { return fn.body !== undefined; }

  function writeTarget(left: ts.Expression, definition: Definition): void {
    const node = unwrap(left);
    if (ts.isIdentifier(node)) { define(node, definition); return; }
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
      const slots = ts.isArrayLiteralExpression(node) ? node.elements : node.properties;
      for (const slot of slots) {
        if (ts.isIdentifier(slot)) define(slot, { node: definition.node });
        else if (ts.isShorthandPropertyAssignment(slot)) {
          const id = checker.getShorthandAssignmentValueSymbol(slot);
          if (id) {
            const list = definitions.get(id) ?? [];
            list.push({ node: definition.node }); definitions.set(id, list);
          }
        } else if (ts.isPropertyAssignment(slot)) writeTarget(slot.initializer, { node: definition.node });
        else if (ts.isSpreadElement(slot) || ts.isSpreadAssignment(slot)) writeTarget(slot.expression, { node: definition.node });
        else if (ts.isBinaryExpression(slot)) writeTarget(slot.left, { node: definition.node });
        else if (ts.isObjectLiteralExpression(slot) || ts.isArrayLiteralExpression(slot)) writeTarget(slot, { node: definition.node });
      }
    }
  }

  function indexFiles() {
    const callSites: ts.CallExpression[] = [];
    const stack: { node: ts.Node; fn?: RuntimeFunction }[] = files.map(node => ({ node }));
    while (stack.length && visit()) {
      const current = stack.pop();
      if (!current) break;
      const node = current.node;
      const fn = runtimeFunction(node) ? fnWithBody(node) : current.fn;
      const callee = ts.isCallExpression(node) ? unwrap(node.expression) : undefined;
      if (ts.isWithStatement(node) || (callee && ts.isIdentifier(callee) && callee.text === 'eval' &&
          !checker.getSymbolAtLocation(callee)?.declarations?.length)) {
        // Direct eval and with can introduce writes invisible to the lexical index,
        // including writes to a binding captured from an enclosing function.
        for (let owner: ts.Node | undefined = node; owner && visit(); owner = owner.parent) {
          if (!runtimeFunction(owner) && !ts.isSourceFile(owner)) continue;
          if (dynamicScopes.has(owner)) break;
          dynamicScopes.add(owner);
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const list = node.parent;
        const loopItem = ts.isVariableDeclarationList(list) && (ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent));
        if (node.initializer || loopItem || ts.isCatchClause(list) || (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient))
          define(node.name, { node, expression: node.initializer });
        else if (ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Let))
          define(node.name, { node, value: undefinedValue });
        // A var redeclaration without an initializer does not overwrite a prior value.
      }
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const op = node.operatorToken.kind;
        const logical = op === ts.SyntaxKind.AmpersandAmpersandEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken ||
          op === ts.SyntaxKind.QuestionQuestionEqualsToken;
        const write = logical ? { node, previous: node.left, expression: node.right, logical: op } :
          op === ts.SyntaxKind.EqualsToken ? { node, expression: node.right } :
          op === ts.SyntaxKind.PlusEqualsToken ? { node, previous: node.left, expression: node.right } :
          { node, value: numericAssignments.has(op) ? scalar : undefined };
        writeTarget(node.left, write);
      } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
          && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        writeTarget(node.operand, { node, value: scalar });
      } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
        writeTarget(node.initializer, { node: node.initializer });
      } else if (ts.isReturnStatement(node) && fn) {
        const list = returns.get(fn) ?? [];
        list.push(node); returns.set(fn, list);
      } else if (ts.isCallExpression(node)) callSites.push(node);
      if (ts.isIdentifier(node)) {
        if (node.text === 'arguments' && !checker.getSymbolAtLocation(node)?.declarations?.length) {
          const base = outerExpression(node), parent = base.parent;
          const memberRead = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === base;
          if (!memberRead || writeOrEscape(parent)) {
            let owner: ts.Node | undefined = node.parent;
            while (owner && (!runtimeFunction(owner) || ts.isArrowFunction(owner))) owner = owner.parent;
            if (owner) argumentsMayAlias.add(owner);
          }
        }
        const id = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(node.parent) : symbol(node);
        const decl = id?.valueDeclaration;
        if (id && decl && (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isBindingElement(decl) || ts.isFunctionDeclaration(decl))
            && node !== decl.name) {
          const list = references.get(id) ?? [];
          if (list.length <= MAX_DEFINITIONS) list.push(node);
          references.set(id, list);
        }
      }
      ts.forEachChild(node, child => { stack.push({ node: child, fn }); });
    }
    for (const call of callSites) {
      if (!visit()) break;
      if (call.arguments.some(ts.isIdentifier)) {
        const start = firstExpressHandler(call, checker);
        if (start !== undefined && control.facts(call).live) {
          for (const arg of call.arguments.slice(start)) {
            if (!ts.isIdentifier(arg)) continue;
            const parameter = target(arg)?.parameters[0];
            const id = parameter && ts.isIdentifier(parameter.name) && symbol(parameter.name);
            if (id) routeParameters.add(id);
          }
        }
      }
      const called = target(call.expression);
      if (!called) continue;
      const list = calls.get(called) ?? [];
      list.push(call); calls.set(called, list);
    }
    for (const list of definitions.values()) list.sort((a, b) => b.node.end - a.node.end);
    for (const list of calls.values()) list.sort((a, b) => pathOf(a).localeCompare(pathOf(b)) || a.pos - b.pos);
  }
  indexFiles();

  // Call arguments and immutable lexical constants can decide a guard. Avoid
  // evaluating arbitrary code or reusing a parameter after a possible write.
  function truth(expression: ts.Expression, env: Environment, depth: number): boolean | undefined {
    const fixed = constantTruth(expression);
    if (fixed !== undefined || depth >= MAX_DEPTH || !visit()) return fixed;
    const node = unwrap(expression);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = truth(node.operand, env, depth + 1);
      return inner === undefined ? undefined : !inner;
    }
    if (env.size && ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
      const atom = (operand: ts.Expression) => {
        const value = unwrap(operand), direct = primitive(value);
        if (direct !== undefined) return direct;
        return !active.has(value) && (ts.isIdentifier(value) || member(value)) ? read(value, env, depth + 1).atom : undefined;
      };
      const left = atom(node.left), right = atom(node.right);
      if (left !== undefined && right !== undefined) return node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? left === right : left !== right;
    }
    if (env.size && member(node) && !active.has(node)) return read(node, env, depth + 1).truth;
    if (!ts.isIdentifier(node)) return undefined;
    const id = symbol(node), decl = id?.valueDeclaration;
    if (!id || !decl) return undefined;
    const writes = definitions.get(id);
    if (writes?.some(write => write.node !== decl)) return undefined;
    if (env.has(id)) return dynamicScopes.has(control.facts(node).owner) ||
      (ts.isParameter(decl) && argumentsMayAlias.has(decl.parent)) ? undefined : env.get(id)?.truth;
    if (ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) &&
        (decl.parent.flags & ts.NodeFlags.Const) && decl.initializer && decl.end <= node.getStart() && decl.getSourceFile() === node.getSourceFile())
      return truth(decl.initializer, env, depth + 1);
    return undefined;
  }

  function feasible(facts: ControlFacts, env: Environment, depth: number): ReadonlyMap<ts.Node, boolean> | null {
    if (!facts.live) return null;
    let remaining: Map<ts.Node, boolean> | undefined;
    for (const [guard, taken] of facts.tests) {
      const test = control.condition(guard);
      const decided = test && truth(test, env, depth + 1);
      if (decided === undefined) continue;
      if (decided !== taken) return null;
      (remaining ??= new Map(facts.tests)).delete(guard);
    }
    return remaining ?? facts.tests;
  }

  /** A property proof requires a fresh data object and read-only uses of every
   * alias along that path. Passing the selected scalar onwards cannot modify
   * the slot. Passing its containing object to unknown code can. */
  function readOnly(id: ts.Symbol | undefined, path: readonly string[], seen: ReadonlySet<ts.Symbol>, depth: number): boolean {
    if (!id || seen.has(id) || depth >= MAX_DEPTH || !visit()) return false;
    const decl = id.valueDeclaration;
    if (!decl || dynamicScopes.has(control.facts(decl).owner) || (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) ||
        definitions.get(id)?.some(write => write.node !== decl) || (ts.isParameter(decl) && argumentsMayAlias.has(decl.parent))) return false;
    const uses = references.get(id) ?? [];
    if (uses.length > MAX_DEFINITIONS) { cutoff(); return false; }
    const next = new Set(seen).add(id);
    return uses.every(use => readOnlyUse(use, path, next, depth + 1));
  }

  function bindingReads(name: ts.BindingName, path: readonly string[], seen: ReadonlySet<ts.Symbol>, depth: number): boolean {
    if (ts.isIdentifier(name)) return readOnly(symbol(name), path, seen, depth + 1);
    if (!ts.isObjectBindingPattern(name)) return false;
    for (const element of name.elements) {
      const key = element.propertyName ? staticName(element.propertyName) : ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (key === undefined || element.dotDotDotToken) return false;
      if (key === path[0] && path.length > 1 && !bindingReads(element.name, path.slice(1), seen, depth + 1)) return false;
    }
    return true;
  }

  function readOnlyUse(value: ts.Expression, path: readonly string[], seen: ReadonlySet<ts.Symbol>, depth: number): boolean {
    if (depth >= MAX_DEPTH || !visit()) return false;
    let node = outerExpression(value), remaining = path, diverged = false;
    while ((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node) {
      const access = member(node.parent);
      if (!access) return false;
      if (remaining.length) {
        if (access.name !== remaining[0]) diverged = true;
        remaining = remaining.slice(1);
      }
      node = outerExpression(node.parent);
    }
    if (writeOrEscape(node)) return false;
    if (diverged || !remaining.length) return true;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isVariableDeclarationList(parent.parent) &&
        (parent.parent.flags & ts.NodeFlags.Const)) return bindingReads(parent.name, remaining, seen, depth);
    if (ts.isCallExpression(parent) && !parent.arguments.some(ts.isSpreadElement)) {
      const fn = target(parent.expression), position = parent.arguments.indexOf(node);
      const formal = fn?.parameters[position];
      return !!formal && !formal.dotDotDotToken && bindingReads(formal.name, remaining, seen, depth);
    }
    if (ts.isShorthandPropertyAssignment(parent) || (ts.isPropertyAssignment(parent) && parent.initializer === node)) {
      const key = staticName(parent.name);
      return key !== undefined && readOnlyUse(parent.parent, [key, ...remaining], seen, depth + 1);
    }
    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node)) {
      const fn = ts.isArrowFunction(parent) ? parent : control.facts(parent).owner;
      if (!runtimeFunction(fn) || !hasBody(fn)) return false;
      const declaration = ts.isFunctionDeclaration(fn) ? fn : ts.isVariableDeclaration(fn.parent) ? fn.parent : undefined;
      const name = declaration?.name;
      if (!declaration || !name || !ts.isIdentifier(name) || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export)) return false;
      const id = symbol(name), sites = calls.get(fn) ?? [];
      const refs = id && references.get(id);
      if (!id || seen.has(id) || !refs || refs.length > MAX_DEFINITIONS || refs.length !== sites.length) return false;
      const next = new Set(seen).add(id);
      return refs.every(ref => {
        const callee = outerExpression(ref), call = callee.parent;
        return ts.isCallExpression(call) && call.expression === callee && readOnlyUse(call, remaining, next, depth + 1);
      });
    }
    return false;
  }

  function protect(value: SemanticValue, id: ts.Symbol, prefix: readonly string[] = []): SemanticValue {
    const project = value.project;
    if (!project) return value;
    return { kind: 'unknown', truth: value.truth, project(name, depth) {
      if (depth >= MAX_DEPTH || !visit()) return cutoff();
      const path = [...prefix, name], key = JSON.stringify(path);
      const cache = pathsBySymbol.get(id) ?? new Map<string, boolean>();
      let safe = cache.get(key);
      if (safe === undefined) {
        safe = readOnly(id, path, new Set(), 0);
        cache.set(key, safe); pathsBySymbol.set(id, cache);
      }
      return safe ? protect(project(name, depth + 1), id, path) : unknown;
    } };
  }

  function record(node: ts.ObjectLiteralExpression, env: Environment): SemanticValue {
    if (node.properties.length > MAX_DEFINITIONS) return cutoff();
    const fields = new Map<string, ts.Expression>();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return unknown;
      const name = staticName(property.name);
      if (name === undefined || name === '__proto__') return unknown;
      fields.set(name, ts.isPropertyAssignment(property) ? property.initializer : property.name);
    }
    return { kind: 'unknown', truth: true, project(name, depth) {
      const field = fields.get(name);
      return field ? read(field, env, depth + 1) : unknown;
    } };
  }

  function field(object: ts.Expression, key: string | undefined, env: Environment, depth: number): SemanticValue {
    const base = unwrap(object), value = read(base, env, depth + 1);
    if (key !== undefined && value.project) return value.project(key, depth + 1);
    if (value.reason === 'unresolved-member' || (ts.isIdentifier(base) && !checker.getSymbolAtLocation(base))) return unresolvedMember;
    return unknown;
  }

  function parameter(decl: ts.ParameterDeclaration, env: Environment, depth: number, binding?: ts.BindingElement): SemanticValue {
    const name = binding?.name ?? decl.name;
    if (!ts.isIdentifier(name) || !runtimeFunction(decl.parent) || !hasBody(decl.parent) || binding?.dotDotDotToken) return unknown;
    const fn = decl.parent, id = symbol(name);
    const supplied = id && env.get(id);
    if (supplied) return supplied;
    const incoming = calls.get(fn) ?? [];
    if (!incoming.length) return unknown;
    if (incoming.length > MAX_DEFINITIONS) return cutoff();
    const position = fn.parameters.indexOf(decl);
    // A function whose body contains the sink may also be called through an
    // exported or escaped reference that this project cannot see.
    const observations: SemanticValue[] = [unknown];
    for (const call of incoming) {
      if (!feasible(control.facts(call), env, depth) || call.arguments.some(ts.isSpreadElement)) continue;
      const arg = call.arguments[position];
      let value: SemanticValue;
      if (binding) {
        const property = binding.propertyName ? staticName(binding.propertyName) : name.text;
        const object = arg ?? decl.initializer;
        if (!object || property === undefined) continue;
        value = defaulted(field(object, property, env, depth + 1), binding.initializer, env, depth);
      } else {
        value = defaulted(arg ? read(arg, env, depth + 1) : undefinedValue, decl.initializer, env, depth);
      }
      observations.push(through(value, call));
    }
    return alternatives(observations);
  }

  function definitionValue(d: Definition, env: Environment, depth: number): SemanticValue {
    if (d.value) return d.value;
    if (!d.expression) return unknown;
    if (d.logical && d.previous) return through(logicalValue(d.logical, d.previous, d.expression, env, depth), d.node);
    const value = read(d.expression, env, depth + 1);
    return through(d.previous ? concatenate([read(d.previous, env, depth + 1), value], undefined) : value, d.node);
  }
  function reaching(id: ts.Symbol, use: ts.Node, env: Environment, depth: number): SemanticValue {
    if (depth > MAX_DEPTH || !visit()) return cutoff();
    const decl = id.valueDeclaration;
    const facts = control.facts(use);
    const useGuards = feasible(facts, env, depth);
    if (!useGuards) return unknown;
    const writes = definitions.get(id) ?? [];
    if (writes.length > MAX_DEFINITIONS) return cutoff();
    const found: SemanticValue[] = [];
    let paths: ReadonlyMap<ts.Node, boolean>[] = [useGuards];
    let externalWrite = writes.some(d => d.node !== decl && control.facts(d.node).owner !== facts.owner);
    if (dynamicScopes.has(facts.owner) || (decl && dynamicScopes.has(control.facts(decl).owner)) ||
        (decl && ts.isParameter(decl) && argumentsMayAlias.has(decl.parent))) externalWrite = true;
    for (const d of writes) {
      const where = control.facts(d.node);
      if (!where.live) continue;
      if (where.owner !== facts.owner) {
        if (d.node === decl && decl && ts.isVariableDeclaration(decl) && writes.length === 1) {
          const value = definitionValue(d, env, depth);
          return externalWrite ? alternatives([value, unknown]) : value;
        }
        externalWrite = true; continue;
      }
      if (d.node.end > use.getStart()) {
        // An assignment after this read may have executed in a previous iteration.
        for (const guard of where.tests.keys()) {
          if (ts.isIterationStatement(guard, false) && guard.pos <= use.pos && use.end <= guard.end &&
              feasible(where, env, depth)) {
            const value = definitionValue(d, env, depth);
            found.push(value.kind === 'input' ? { ...value, conditional: true } : value);
            break;
          }
        }
        continue;
      }
      const writeGuards = feasible(where, env, depth);
      if (!writeGuards) continue;
      const next: ReadonlyMap<ts.Node, boolean>[] = [];
      let reaches = false;
      for (const path of paths) {
        const residual = subtractGuards(path, writeGuards);
        if (residual === null) next.push(path);
        else { reaches = true; next.push(...residual); }
        if (next.length > MAX_PATHS) return cutoff();
      }
      if (reaches) found.push(definitionValue(d, env, depth));
      paths = next;
      if (!paths.length) break;
    }
    if (paths.length) {
      if (decl && ts.isParameter(decl)) found.push(parameter(decl, env, depth));
      else if (decl && ts.isBindingElement(decl) && ts.isVariableDeclaration(decl.parent.parent) && decl.parent.parent.initializer
          && ts.isObjectBindingPattern(decl.parent) && !decl.dotDotDotToken) {
        const key = decl.propertyName ? staticName(decl.propertyName) : ts.isIdentifier(decl.name) ? decl.name.text : undefined;
        if (key !== undefined) found.push(field(decl.parent.parent.initializer, key, env, depth + 1));
        else found.push(unknown);
        if (decl.initializer) found.push(read(decl.initializer, env, depth + 1));
      } else if (decl && ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) && ts.isParameter(decl.parent.parent))
        found.push(parameter(decl.parent.parent, env, depth, decl));
      else if (decl && ts.isVariableDeclaration(decl) && !decl.initializer && ts.isVariableDeclarationList(decl.parent) &&
          (decl.parent.flags & ts.NodeFlags.BlockScoped) === 0 && !(ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient) &&
          !ts.isForOfStatement(decl.parent.parent) && !ts.isForInStatement(decl.parent.parent)) found.push(undefinedValue);
      else found.push(unknown);
    }
    if (externalWrite) found.push(unknown);
    return alternatives(found);
  }

  function concatenate(parts: readonly SemanticValue[], text: readonly string[] | undefined): SemanticValue {
    const source = parts.find(value => value.kind === 'input');
    if (source) return { ...source, filterOperand: 'primitive' };
    if (parts.some(v => v.reason === 'unresolved-tag')) return unresolvedTag;
    if (parts.some(v => v.reason === 'unresolved-call')) return unresolvedCall;
    if (parts.some(v => v.reason === 'unresolved-member') &&
        parts.every(v => v.reason === 'unresolved-member' || v.kind === 'literal' || v.kind === 'scalar')) return unresolvedMember;
    if (parts.every(v => v.kind === 'literal' || v.kind === 'scalar')) return literal;
    if (text && htmlTextPieces(text) && parts.every(v => v.kind === 'encoded-text' || v.kind === 'scalar' || v.plain)) return { kind: 'encoded-text' };
    return unknown;
  }

  function invocation(node: ts.CallExpression, env: Environment, depth: number): SemanticValue {
    const fn = target(node.expression);
    if (!fn || dynamicScopes.has(control.facts(fn).owner) || fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) || fn.asteriskToken ||
        node.arguments.some(ts.isSpreadElement) || fn.parameters.some(p => p.dotDotDotToken || ts.isArrayBindingPattern(p.name))) return unresolvedCall;
    if (activeCalls.has(fn) || activeCalls.size >= MAX_CALLEES) return cutoff();
    activeCalls.add(fn);
    try {
      const args = new Map(env);
      for (const [i, param] of fn.parameters.entries()) {
        const input = node.arguments[i];
        if (ts.isObjectBindingPattern(param.name)) {
          for (const element of param.name.elements) {
            if (element.dotDotDotToken || !ts.isIdentifier(element.name)) return unresolvedCall;
            const key = symbol(element.name);
            const property = element.propertyName ? staticName(element.propertyName) : element.name.text;
            if (!key || property === undefined) return unresolvedCall;
            const object = input ?? param.initializer;
            const value = object ? field(object, property, input ? env : args, depth + 1) : unknown;
            args.set(key, through(defaulted(value, element.initializer, args, depth), node));
          }
        } else {
          const key = symbol(param.name);
          if (!key) return unresolvedCall;
          const value = input ? read(input, env, depth + 1) : undefinedValue;
          args.set(key, through(defaulted(value, param.initializer, args, depth), node));
        }
      }
      if (!ts.isBlock(fn.body)) return through(through(read(fn.body, args, depth + 1), fn.body), node);
      const values: SemanticValue[] = [];
      const exits = returns.get(fn) ?? [];
      if (exits.length > MAX_DEFINITIONS) return cutoff();
      const decides = (test: ts.Expression) => truth(test, args, depth + 1);
      for (const ret of exits) {
        if (!feasible(control.facts(ret), args, depth)) continue;
        let point: ts.Node = ret;
        while (point !== fn && !ts.isSourceFile(point)) {
          const parent: ts.Node = point.parent;
          if (ts.isTryStatement(parent) && parent.finallyBlock && point !== parent.finallyBlock &&
              control.exits(parent.finallyBlock, 0, decides)) break;
          point = parent;
        }
        if (point === fn) values.push(ret.expression ? through(read(ret.expression, args, depth + 1), ret) : undefinedValue);
      }
      if (!control.exits(fn.body, 0, decides)) values.push(undefinedValue);
      return through(alternatives(values), node);
    } finally { activeCalls.delete(fn); }
  }

  function defaulted(value: SemanticValue, fallback: ts.Expression | undefined, env: Environment, depth: number) {
    if (!fallback) return value;
    if (value.reason === 'undefined') return read(fallback, env, depth + 1);
    return (value.kind === 'unknown' && value.truth !== true) || (value.kind === 'literal' && value.truth === undefined)
      ? alternatives([value, read(fallback, env, depth + 1)]) : value;
  }

  function logicalValue(op: ts.SyntaxKind, left: ts.Expression, right: ts.Expression, env: Environment, depth: number): SemanticValue {
    const prior = read(left, env, depth + 1);
    let useRight: boolean | undefined;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) useRight = prior.truth;
    else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.BarBarEqualsToken)
      useRight = prior.truth === undefined ? undefined : !prior.truth;
    else if (prior.reason === 'undefined' || primitive(left) === null) useRight = true;
    else if (primitive(left) !== undefined || prior.truth === true || prior.kind === 'scalar') useRight = false;
    if (useRight === false) return prior;
    const next = read(right, env, depth + 1);
    return useRight === true ? next : alternatives([prior, next]);
  }

  function evaluate(node: ts.Expression, env: Environment, depth: number): SemanticValue {
    const constant = primitive(node);
    if (constant !== undefined) return { kind: 'literal', atom: constant, truth: !!constant,
      plain: typeof constant !== 'string' || /^[a-z0-9 _.-]*$/i.test(constant) };
    if (ts.isBigIntLiteral(node)) return literal;
    const modeled = frameworkValue(node, checker);
    if (modeled === 'possible-input') return { kind: 'input', origin: node, conditional: true, reason: 'declared-input' };
    if (modeled) return modeled === 'input' ? { kind: 'input', origin: node } : { kind: modeled };
    const request = semanticRequestInput(node, checker, parameter => {
      const id = symbol(parameter.name);
      return !!id && routeParameters.has(id) && !env.has(id);
    });
    if (request) return { kind: 'input', origin: node, conditional: request.conditional, filterOperand: request.objectInput ? node : undefined };
    if (ts.isObjectLiteralExpression(node)) return record(node, env);
    if (ts.isIdentifier(node)) {
      const id = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ?
        checker.getShorthandAssignmentValueSymbol(node.parent) : symbol(node);
      if (node.text === 'undefined' && !checker.getSymbolAtLocation(node)?.declarations?.length) return undefinedValue;
      return id ? protect(reaching(id, node, env, depth + 1), id) : unknown;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      if (!ts.isTemplateExpression(node.template)) return unresolvedTag;
      for (const span of node.template.templateSpans) {
        const part = read(span.expression, env, depth + 1);
        if (part.kind === 'input') return through({ ...part, filterOperand: undefined, conditional: true, reason: 'unverified-tag' }, node);
      }
      return unresolvedTag;
    }
    if (ts.isCallExpression(node)) return invocation(node, env, depth);
    if (ts.isConditionalExpression(node)) {
      const selected = truth(node.condition, env, depth + 1);
      if (selected !== undefined) return read(selected ? node.whenTrue : node.whenFalse, env, depth + 1);
      return alternatives([read(node.whenTrue, env, depth + 1), read(node.whenFalse, env, depth + 1)]);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.CommaToken) return read(node.right, env, depth + 1);
      if (op === ts.SyntaxKind.PlusToken) {
        const a = primitive(node.left), b = primitive(node.right);
        if (typeof a === 'string') return concatenate([read(node.right, env, depth + 1)], [a, '']);
        if (typeof b === 'string') return concatenate([read(node.left, env, depth + 1)], ['', b]);
        return concatenate([read(node.left, env, depth + 1), read(node.right, env, depth + 1)], undefined);
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken ||
          op === ts.SyntaxKind.AmpersandAmpersandEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken)
        return logicalValue(op, node.left, node.right, env, depth);
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken ||
          op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.GreaterThanToken ||
          op === ts.SyntaxKind.LessThanEqualsToken || op === ts.SyntaxKind.GreaterThanEqualsToken ||
          op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.AsteriskToken || op === ts.SyntaxKind.SlashToken ||
          op === ts.SyntaxKind.PercentToken || op === ts.SyntaxKind.InKeyword || op === ts.SyntaxKind.InstanceOfKeyword) return scalar;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = node.templateSpans.map(span => read(span.expression, env, depth + 1));
      return concatenate(parts, [node.head.text, ...node.templateSpans.map(span => span.literal.text)]);
    }
    if (ts.isVoidExpression(node)) return undefinedValue;
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) || ts.isTypeOfExpression(node)) return scalar;
    const access = member(node);
    if (access) return field(access.base, access.name, env, depth + 1);
    if (ts.isElementAccessExpression(node)) return field(node.expression, undefined, env, depth + 1);
    return unknown;
  }

  function read(expression: ts.Expression, env: Environment = empty, depth = 0): SemanticValue {
    if (!visit() || depth >= MAX_DEPTH) return cutoff();
    const node = unwrap(expression);
    const saved = env === empty && results.get(node);
    if (saved) return saved;
    if (active.has(node)) return cutoff();
    active.add(node);
    try {
      let value = evaluate(node, env, depth);
      if (value.filterOperand && value.filterOperand !== 'primitive' && ts.isIdentifier(node)) {
        const facts = control.facts(node);
        if (!dynamicScopes.has(facts.owner) && guardedComparison(node, facts.tests, checker, scalarOperand))
          value = { ...value, filterOperand: 'primitive' };
      }
      if (env === empty && !interrupted) results.set(node, value);
      return interrupted ? unknown : value;
    } finally { active.delete(node); }
  }

  return { read: (expression: ts.Expression) => read(expression), guards: (node: ts.Node) => control.facts(node).tests,
    reachable: (node: ts.Node) => !!feasible(control.facts(node), empty, 0),
    limited: () => limited || interrupted };
}
