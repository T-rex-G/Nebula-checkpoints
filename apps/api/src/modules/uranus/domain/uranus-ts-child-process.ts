import ts from 'typescript';
import { childProcessMethod } from './uranus-ts-candidates.ts';
import { library } from './uranus-ts-libraries.ts';
import { constantText, member, methodReplaced, reassigned, unwrap, valueDeclaration } from './uranus-ts-symbols.ts';
import type { createSemanticReader, SemanticValue } from './uranus-ts-values.ts';

type Reader = ReturnType<typeof createSemanticReader>;
export type Shell = 'enabled' | 'disabled' | 'unknown';
export type CommandBlocker = 'shell-option' | 'argv-shape';

function childMethod(call: ts.CallExpression, checker: ts.TypeChecker): string | null {
  const callee = unwrap(call.expression), prop = member(callee, checker);
  if (prop ? !childProcessMethod(prop.name) : !ts.isIdentifier(callee)) return null;
  const api = library(callee, checker);
  if (!api || (api.package !== 'node:child_process' && api.package !== 'child_process') || !childProcessMethod(api.name)) return null;
  return prop && methodReplaced(call, prop.base, prop.name, checker) ? null : api.name;
}

/** Node copies the options record and argument vector. Another call may have
 * mutated an alias, so follow its initializer only when its other uses are reads. */
function argumentValue(expression: ts.Expression, reader: Reader, checker: ts.TypeChecker): ts.Expression {
  let node = unwrap(expression);
  for (let depth = 0; depth < 12 && ts.isIdentifier(node); depth++) {
    const init = reader.argumentInitializer(node, use => {
      const call = use.parent;
      return ts.isCallExpression(call) && (call.arguments[1] === use || call.arguments[2] === use) && !!childMethod(call, checker);
    });
    if (!init) break;
    node = unwrap(init);
  }
  return node;
}

function shellMode(options: ts.Expression, checker: ts.TypeChecker, reader: Reader): Shell {
  const node = argumentValue(options, reader, checker);
  if (!ts.isObjectLiteralExpression(node)) {
    const decl = ts.isIdentifier(node) && valueDeclaration(node, checker);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 'disabled';
    if (decl && ts.isFunctionDeclaration(decl) && !reassigned(decl, checker))
      return methodReplaced(node, node, 'shell', checker) ? 'unknown' : 'disabled';
    const value = reader.read(node);
    return value.kind === 'literal' || value.kind === 'scalar' ? 'disabled' : 'unknown';
  }
  if (!reader.withinLimit(node.properties.length, 64)) return 'unknown';
  // The last own property wins. A later spread or computed key can overwrite shell.
  for (let i = node.properties.length - 1; i >= 0; i--) {
    const property = node.properties[i], name = property?.name;
    if (!name) return 'unknown';
    const key = ts.isComputedPropertyName(name) ? constantText(name.expression, checker) : name.text;
    if (key === null) return 'unknown';
    if (key !== 'shell') continue;
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return 'unknown';
    const value = reader.read(ts.isPropertyAssignment(property) ? property.initializer : property.name);
    if (value.atom === true || (typeof value.atom === 'string' && value.atom.length > 0 && !value.atom.includes('\0'))) return 'enabled';
    if (value.atom !== undefined || value.reason === 'undefined') return 'disabled';
    return 'unknown';
  }
  return 'disabled';
}

interface CommandArgument { value: SemanticValue; blocker: CommandBlocker | null }
export function commandCall(call: ts.CallExpression, checker: ts.TypeChecker, values: () => Reader):
    { shell: Shell; argument?: CommandArgument } | undefined {
  const [, args, options] = call.arguments;
  if (!args || call.arguments.some(ts.isSpreadElement) || !childMethod(call, checker)) return;
  const reader = values();
  if (!reader.reachable(call)) return;
  const vector = argumentValue(args, reader, checker);
  if (ts.isObjectLiteralExpression(vector)) return { shell: shellMode(vector, checker, reader) };
  if (!options) return { shell: ts.isArrayLiteralExpression(vector) ? 'disabled' : 'unknown' };
  const shell = shellMode(options, checker, reader);
  if (shell === 'disabled') return { shell };
  return { shell, argument: vectorArgument(vector, args, shell, reader) };
}

function vectorArgument(vector: ts.Expression, args: ts.Expression, shell: Shell, reader: Reader): CommandArgument | undefined {
  const blocker = shell === 'unknown' ? 'shell-option' : null;
  function fromVector(expression: ts.Expression): CommandArgument | undefined {
    // A whole request field may supply an array. Its runtime shape is unresolved.
    const value = reader.read(expression), origin = value.filterOperand;
    if (!origin || origin === 'primitive') return;
    return { value: origin === value.origin ? value : { kind: 'input', origin, conditional: true }, blocker: blocker ?? 'argv-shape' };
  }
  if (!ts.isArrayLiteralExpression(vector)) return fromVector(args);
  let witness: CommandArgument | undefined;
  const elements = reader.withinLimit(vector.elements.length, 128) ? vector.elements : vector.elements.slice(0, 128);
  for (const element of elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isSpreadElement(element)) {
      witness ??= fromVector(element.expression);
      continue;
    }
    const value = reader.read(element);
    if (value.kind !== 'input') continue;
    const found: CommandArgument = { value, blocker };
    if (!value.conditional && !value.reason) return found;
    witness ??= found;
  }
  return witness;
}
