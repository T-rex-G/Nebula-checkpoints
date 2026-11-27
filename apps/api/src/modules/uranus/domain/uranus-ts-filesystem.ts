/* Node core filesystem APIs take filenames in documented argument slots. No
 * repository module, filename, or input string is evaluated by this model. */
import ts from 'typescript';
import type { SemanticValue } from './uranus-ts-values.ts';
import { filesystemPathCount } from './uranus-ts-candidates.ts';
import { guardedComparison } from './uranus-ts-control.ts';
import { intact, library } from './uranus-ts-libraries.ts';
import { member, methodReplaced, unwrap } from './uranus-ts-symbols.ts';

type PathDialect = 'native' | 'posix' | 'win32';
type PathOperation = 'join' | 'resolve' | 'relative' | 'isAbsolute' | 'sep';
function knownOperation(name: string): name is PathOperation {
  return name === 'join' || name === 'resolve' || name === 'relative' || name === 'isAbsolute' || name === 'sep';
}

export function pathOperation(expression: ts.Expression, checker: ts.TypeChecker): { name: PathOperation; dialect: PathDialect } | null {
  const callee = unwrap(expression);
  const prop = member(callee, checker);
  if (prop ? !knownOperation(prop.name) : !ts.isIdentifier(callee)) return null;
  const id = library(callee, checker);
  if (!id || !/^(?:node:)?path(?:\/(?:posix|win32))?$/.test(id.package)) return null;
  const parts = id.name.split('.');
  const name = parts.pop() ?? '';
  if (!knownOperation(name) || parts.length > 1) return null;
  if (prop && (!intact(prop.base, [prop.name], checker) || methodReplaced(callee, prop.base, prop.name, checker))) return null;
  const selector = parts[0] ?? id.package.split('/')[1];
  if (selector !== undefined && selector !== 'posix' && selector !== 'win32') return null;
  return { name, dialect: selector ?? 'native' };
}

/* A Windows root-relative path inherits its drive. For a native import the
 * deployment OS is unknown, so a reset must hold under both interpretations. */
function resetsPath(text: string, dialect: PathDialect): boolean {
  const posix = text.startsWith('/');
  if (dialect === 'posix') return posix;
  const windows = /^[a-z]:[\\/]/i.test(text) || /^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]+/.test(text);
  return windows && (dialect === 'win32' || posix);
}

export function constructedPath(args: readonly ts.Expression[], name: 'join' | 'resolve', dialect: PathDialect,
    valueOf: (argument: ts.Expression) => SemanticValue): SemanticValue {
  let witness: SemanticValue | undefined;
  let unknownPart = false, maySelectDrive = false;
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (!arg) return { kind: 'unknown', reason: 'unresolved-call' };
    const part = valueOf(arg);
    // join checks every segment. resolve never uses segments left of
    // one that throws, even when a later absolute path skips that check.
    if (part.kind === 'literal' && (part.reason === 'undefined' || (part.atom !== undefined && typeof part.atom !== 'string'))) {
      if (name === 'join') return { kind: 'literal', pathConstruction: true };
      break;
    }
    if (part.kind === 'input') witness = part;
    else if (part.kind !== 'literal' && part.kind !== 'scalar') unknownPart = true;
    if (name === 'resolve' && typeof part.atom === 'string' && resetsPath(part.atom, dialect) &&
        (dialect === 'posix' || !maySelectDrive)) break;
    // A drive-qualified suffix can cause win32.resolve to skip an
    // earlier absolute segment on a different device.
    if (typeof part.atom !== 'string' || /^[a-z]:|^[\\/]{2}/i.test(part.atom)) maySelectDrive = true;
  }
  if (witness) return { ...witness, conditional: witness.conditional || unknownPart, pathConstruction: true, filterOperand: 'primitive' };
  return unknownPart ? { kind: 'unknown', reason: 'unresolved-call' } : { kind: 'literal', pathConstruction: true };
}

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
  return guardedComparison(expression, guards, checker, (left, right) =>
    ts.isStringLiteralLike(left) ? right : ts.isStringLiteralLike(right) ? left : undefined);
}
