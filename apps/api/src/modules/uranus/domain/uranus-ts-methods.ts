/* A detached Web IDL method and a method bound to a genuine receiver have
 * different behavior. Keep the captured receiver and every pre-bound argument
 * through to the invocation that can actually execute the operation. */
import ts from 'typescript';
import { constInitializer, member, methodReplaced, unwrap } from './uranus-ts-symbols.ts';

const HTML_METHODS = new Set(['bypassSecurityTrustHtml', 'insertAdjacentHTML', 'setHTMLUnsafe', 'createContextualFragment',
  'write', 'writeln', 'parseFromString']);
type Method = NonNullable<ReturnType<typeof member>>;
interface Invocation {
  readonly method: Method;
  readonly receiver: ts.Expression;
  readonly bound: boolean;
  readonly args: readonly ts.Expression[];
  readonly site: ts.Node;
}

function capturedMethod(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): Method | null {
  if (depth >= 8) return null;
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    const init = constInitializer(node, checker);
    return init ? capturedMethod(init, checker, depth + 1) : null;
  }
  const method = member(node, checker);
  return method && HTML_METHODS.has(method.name) ? method : null;
}

function boundCall(expr: ts.Expression, args: readonly ts.Expression[], checker: ts.TypeChecker, site: ts.Node, depth = 0): Invocation | null {
  if (depth >= 8) return null;
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) {
    const init = constInitializer(node, checker);
    return init ? boundCall(init, args, checker, site, depth + 1) : null;
  }
  if (!ts.isCallExpression(node) || !node.arguments[0] || node.arguments.length + args.length > 64 ||
      node.arguments.some(ts.isSpreadElement) || args.some(ts.isSpreadElement)) return null;
  const bind = member(node.expression, checker);
  if (!bind || bind.name !== 'bind' || methodReplaced(site, bind.base, 'bind', checker) || methodReplaced(node, bind.base, 'bind', checker)) return null;
  const method = capturedMethod(bind.base, checker);
  if (!method || methodReplaced(method.key, method.base, method.name, checker) || methodReplaced(node, method.base, method.name, checker)) return null;
  return { method, receiver: node.arguments[0], bound: true, args: [...node.arguments.slice(1), ...args], site };
}

export function htmlInvocation(call: ts.CallExpression, checker: ts.TypeChecker): Invocation | null {
  const target = unwrap(call.expression);
  const method = member(target, checker);
  if (method && HTML_METHODS.has(method.name)) {
    if (methodReplaced(method.key, method.base, method.name, checker) || call.arguments.some(ts.isSpreadElement)) return null;
    return { method, receiver: method.base, bound: false, args: call.arguments, site: method.key };
  }
  return ts.isIdentifier(target) || ts.isCallExpression(target) ? boundCall(target, call.arguments, checker, target) : null;
}
