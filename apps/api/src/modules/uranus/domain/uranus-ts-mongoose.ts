import ts from 'typescript';
import { primitive } from './uranus-ts-control.ts';
import { intact, library } from './uranus-ts-libraries.ts';
import { constInitializer, globalName, member, unwrap } from './uranus-ts-symbols.ts';
import type { createSemanticReader, SemanticValue } from './uranus-ts-values.ts';

const filterMethods = new Set(['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments']);
function mongooseModel(expression: ts.Expression, method: string, checker: ts.TypeChecker, depth = 0): boolean {
  const node = unwrap(expression);
  if (ts.isIdentifier(node) && depth < 12) {
    const init = constInitializer(node, checker);
    if (!init || !ts.isVariableDeclaration(init.parent) || !ts.isIdentifier(init.parent.name) ||
        !intact(init.parent.name, [method], checker)) return false;
    return mongooseModel(init, method, checker, depth + 1);
  }
  if (!ts.isCallExpression(node)) return false;
  const factory = library(node.expression, checker);
  return factory?.package === 'mongoose' && factory.name === 'model';
}

function fieldName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}
function explicitEquality(node: ts.ObjectLiteralExpression): boolean {
  const [condition] = node.properties;
  return node.properties.length === 1 && !!condition && ts.isPropertyAssignment(condition) && fieldName(condition) === '$eq';
}

/* A plain field accepts a query operator document. Explicit equality binds its
 * operand as data. Unknown keys or spreads may replace an earlier field. */
export function mongooseFilter(call: ts.CallExpression, name: string, base: ts.Expression, checker: ts.TypeChecker,
  values: () => ReturnType<typeof createSemanticReader>): 'safe' | SemanticValue | undefined {
  const first = call.arguments[0];
  if (!first || !filterMethods.has(name) || !mongooseModel(base, name, checker) || !intact(base, [name], checker)) return;
  const filter = unwrap(first);
  if (!ts.isObjectLiteralExpression(filter) || filter.properties.length > 64) return;
  const fields = new Map<string, ts.Expression>();
  for (const property of filter.properties) {
    const key = fieldName(property);
    if (!key || key === '__proto__' || fields.has(key) || (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))) return;
    fields.set(key, ts.isPropertyAssignment(property) ? property.initializer : property.name);
  }
  const reader = values();
  if (!reader.reachable(call)) return;
  let safe = true;
  for (const [key, operand] of fields) {
    if (key.startsWith('$')) { safe = false; continue; }
    const field = unwrap(operand);
    if (ts.isObjectLiteralExpression(field) && explicitEquality(field)) continue;
    if (primitive(field) !== undefined || ts.isTemplateExpression(field)) continue;
    if (ts.isCallExpression(field) && ['String', 'Number', 'Boolean'].some(builtin => globalName(field.expression, builtin, checker))) continue;
    const value = reader.read(field);
    if (value.filterOperand && value.filterOperand !== 'primitive') {
      return value.origin === value.filterOperand ? value : { kind: 'input', origin: value.filterOperand, conditional: true };
    }
    if (value.kind !== 'literal' && value.kind !== 'scalar' && value.filterOperand !== 'primitive') safe = false;
  }
  return safe ? 'safe' : undefined;
}
