/* Security models for browser and framework operations with a source-level identity.
 * The project has no ambient DOM or package declarations. Follow local bindings
 * and actual module specifiers to distinguish a platform operation from a lookalike. */
import ts from 'typescript';
import { htmlTextPieces } from './uranus-sanitise.ts';
import { htmlInvocation } from './uranus-ts-methods.ts';
import { constantText, globalName, importOrigin, initializer, member, methodReplaced, reassigned, unwrap, valueDeclaration } from './uranus-ts-symbols.ts';

type BrowserRole = 'window' | 'document' | 'element' | 'frame' | 'raw-text-element' | 'range' | 'dom-parser' | 'location' |
  'external-url' | 'external-search' | 'input-element' | 'message';
type FrameworkRole = 'route' | 'snapshot' | 'params' | 'param-map' | 'sanitizer' |
  'declared-route' | 'declared-snapshot' | 'declared-params' | 'declared-param-map';
type Role = BrowserRole | FrameworkRole;
type InputModel = 'input' | 'possible-input';
type ValueModel = InputModel | 'encoded-text' | 'scalar';

export interface SemanticSink {
  readonly site?: ts.Node;
  readonly value: ts.Expression;
  readonly additionalValues?: readonly ts.Expression[];
  readonly kind: 'dom' | 'html';
  readonly context: 'markup' | 'text';
  readonly policy: 'trust-boundary' | 'unknown-receiver' | 'detached-document' | null;
  readonly label: string;
}

const LOCATION_DATA = new Set(['href', 'search', 'hash', 'pathname']);
const SELECTION = new Set(['querySelector', 'getElementById', 'closest']);
const RELATIVE_POSITIONS = new Set(['beforebegin', 'afterbegin', 'beforeend', 'afterend']);
const MODULE_DEPTH = 18;
const element = (role: Role | null) => role === 'element' || role === 'input-element' || role === 'frame' || role === 'raw-text-element';

function constructorRole(decl: ts.Declaration, checker: ts.TypeChecker): Role | null {
  if (!ts.isParameter(decl) || !ts.isConstructorDeclaration(decl.parent) || !ts.isParameterPropertyDeclaration(decl, decl.parent) ||
      decl.initializer || !decl.type || !ts.isTypeReferenceNode(decl.type) || ts.getDecorators(decl)?.length) return null;
  // A constructor token is evidence of the intended Angular service. A caller
  // can still provide a substitute; only a runtime service lookup is definitive.
  const origin = importOrigin(decl.type.typeName, checker, 'value');
  if (origin?.package === '@angular/platform-browser' && origin.name === 'DomSanitizer') return 'sanitizer';
  if (origin?.package === '@angular/router') {
    if (origin.name === 'ActivatedRoute') return 'declared-route';
    if (origin.name === 'ActivatedRouteSnapshot') return 'declared-snapshot';
  }
  return null;
}

function createdElement(tag: ts.Expression | undefined): BrowserRole {
  if (!tag || !ts.isStringLiteralLike(tag)) return 'element';
  switch (tag.text.toLowerCase()) {
    case 'iframe': return 'frame';
    case 'input': case 'textarea': return 'input-element';
    case 'script': case 'style': return 'raw-text-element';
    default: return 'element';
  }
}

function callbackRole(declaration: ts.Declaration | null, checker: ts.TypeChecker, depth: number): Role | null {
  if (!declaration || !ts.isParameter(declaration)) return null;
  const fn = declaration.parent;
  if ((!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) || fn.parameters[0] !== declaration) return null;
  const call = fn.parent;
  if (!ts.isCallExpression(call)) return null;
  const method = member(call.expression, checker);
  if (!method) return null;
  if (method.name === 'addEventListener' && call.arguments[1] === fn && call.arguments[0] &&
      ts.isStringLiteralLike(call.arguments[0]) && call.arguments[0].text === 'message' &&
      roleOf(method.base, checker, depth + 1) === 'window') return 'message';
  if (method.name !== 'subscribe' || call.arguments[0] !== fn) return null;
  const property = member(method.base, checker);
  if (!property) return null;
  const route = roleOf(property.base, checker, depth + 1);
  if (route !== 'route' && route !== 'declared-route') return null;
  if (property.name === 'queryParamMap' || property.name === 'paramMap') return route === 'route' ? 'param-map' : 'declared-param-map';
  if (property.name === 'queryParams' || property.name === 'params') return route === 'route' ? 'params' : 'declared-params';
  return null;
}

function roleOf(expression: ts.Expression, checker: ts.TypeChecker, depth = 0): Role | null {
  if (depth > MODULE_DEPTH) return null;
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    if (globalName(node, 'document', checker)) return 'document';
    if (globalName(node, 'location', checker)) return 'location';
    if (globalName(node, 'window', checker) || globalName(node, 'self', checker)) return 'window';
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const decl = valueDeclaration(node, checker);
    if (decl && reassigned(decl, checker)) return null;
    const bound = initializer(decl);
    if (bound) return roleOf(bound, checker, depth + 1);
    const injected = decl && constructorRole(decl, checker);
    if (injected) return injected;
    const callback = callbackRole(decl, checker, depth);
    if (callback) return callback;
  }
  const prop = member(node, checker);
  if (prop) {
    const host = roleOf(prop.base, checker, depth + 1);
    if (host === 'window') {
      if (prop.name === 'document') return 'document';
      if (prop.name === 'location') return 'location';
    }
    if (host === 'document') {
      if (prop.name === 'location') return 'location';
      if (['body', 'head', 'documentElement', 'activeElement'].includes(prop.name)) return 'element';
      if (prop.name === 'defaultView') return 'window';
    }
    if (element(host) && ['parentElement', 'firstElementChild', 'lastElementChild', 'nextElementSibling', 'previousElementSibling', 'shadowRoot'].includes(prop.name)) return 'element';
    if ((host === 'route' || host === 'declared-route') && prop.name === 'snapshot') return host === 'route' ? 'snapshot' : 'declared-snapshot';
    if (host === 'snapshot' || host === 'declared-snapshot') {
      if (prop.name === 'paramMap' || prop.name === 'queryParamMap') return host === 'snapshot' ? 'param-map' : 'declared-param-map';
      if (prop.name === 'params' || prop.name === 'queryParams') return host === 'snapshot' ? 'params' : 'declared-params';
    }
    if (host === 'external-url' && prop.name === 'searchParams') return 'external-search';
  }
  if (ts.isCallExpression(node)) {
    const callee = member(node.expression, checker);
    if (callee) {
      const host = roleOf(callee.base, checker, depth + 1);
      if (host === 'document') {
        if (callee.name === 'createElement') return createdElement(node.arguments[0]);
        if (callee.name === 'createElementNS') return createdElement(node.arguments[1]);
        if (callee.name === 'createRange') return 'range';
      }
      if ((host === 'document' || element(host)) && SELECTION.has(callee.name)) return 'element';
      if (element(host) && callee.name === 'attachShadow') return 'element';
    }
    const calleeOrigin = importOrigin(node.expression, checker, 'value');
    if (calleeOrigin?.package === '@angular/core' && calleeOrigin.name === 'inject' && node.arguments[0]) {
      const argument = importOrigin(node.arguments[0], checker, 'value');
      if (argument?.package === '@angular/router' && argument.name === 'ActivatedRoute') return 'route';
      if (argument?.package === '@angular/platform-browser' && argument.name === 'DomSanitizer') return 'sanitizer';
    }
  }
  if (ts.isNewExpression(node)) {
    const constructor = unwrap(node.expression);
    if (!node.arguments?.length) {
      if (globalName(constructor, 'DOMParser', checker)) return 'dom-parser';
      const qualified = member(constructor, checker);
      if (qualified?.name === 'DOMParser' && !methodReplaced(constructor, qualified.base, 'DOMParser', checker) &&
          roleOf(qualified.base, checker, depth + 1) === 'window') return 'dom-parser';
    }
    if (node.arguments?.[0] && inputOf(node.arguments[0], checker, depth + 1) === 'input') {
      if (globalName(constructor, 'URLSearchParams', checker)) return 'external-search';
      if (globalName(constructor, 'URL', checker)) return 'external-url';
    }
  }
  return null;
}

function inputOf(expression: ts.Expression, checker: ts.TypeChecker, depth: number): InputModel | null {
  if (depth > MODULE_DEPTH) return null;
  const node = unwrap(expression);
  const prop = member(node, checker);
  if (prop) {
    const host = roleOf(prop.base, checker, depth + 1);
    if ((host === 'location' || host === 'external-url') && LOCATION_DATA.has(prop.name)) return 'input';
    if (host === 'document' && ['URL', 'documentURI', 'referrer'].includes(prop.name)) return 'input';
    if (host === 'window' && prop.name === 'name') return 'input';
    if (host === 'message' && prop.name === 'data') return 'input';
    if (host === 'input-element' && prop.name === 'value') return 'input';
    if (host === 'params') return 'input';
    if (host === 'declared-params') return 'possible-input';
  }
  if (ts.isElementAccessExpression(node) && !prop) {
    const host = roleOf(node.expression, checker, depth + 1);
    if (host === 'params') return 'input';
    if (host === 'declared-params') return 'possible-input';
  }
  if (ts.isCallExpression(node)) {
    const method = member(node.expression, checker);
    if (method && method.name === 'get' && node.arguments.length === 1) {
      const host = roleOf(method.base, checker, depth + 1);
      if (host === 'param-map' || host === 'external-search') return 'input';
      if (host === 'declared-param-map') return 'possible-input';
    }
  }
  return null;
}

export function frameworkValue(expression: ts.Expression, checker: ts.TypeChecker): ValueModel | null {
  const node = unwrap(expression);
  const source = inputOf(node, checker, 0);
  if (source) return source;
  if (!ts.isCallExpression(node)) return null;
  const callee = unwrap(node.expression);
  const first = node.arguments[0];
  if (!first || ts.isSpreadElement(first)) return null;
  if (ts.isIdentifier(callee) && globalName(callee, callee.text, checker) &&
      ['Number', 'parseInt', 'parseFloat', 'Boolean'].includes(callee.text)) return 'scalar';
  if (node.arguments.length !== 1 || !ts.isIdentifier(callee)) return null;
  const origin = importOrigin(callee, checker, 'value');
  if ((origin?.package === 'escape-html' && origin.name === 'default') ||
      ((origin?.package === 'lodash' || origin?.package === 'lodash-es') && origin.name === 'escape')) return 'encoded-text';
  return null;
}

/* A non-escaping local with an own data property is a JavaScript record. A
 * setter, spread, alias or unknown use could change the side effects of a
 * write. In those cases the receiver stays unresolved. */
const plainVariables = new WeakMap<ts.SourceFile, ReadonlySet<ts.Symbol>>();
function nonEscapingRecords(file: ts.SourceFile, checker: ts.TypeChecker): ReadonlySet<ts.Symbol> {
  const cached = plainVariables.get(file);
  if (cached) return cached;
  const candidates = new Set<ts.Symbol>();
  const escapes = new Set<ts.Symbol>();
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const init = ts.isVariableDeclaration(parent) && parent.initializer ? unwrap(parent.initializer) : null;
      if (ts.isVariableDeclaration(parent) && parent.name === node && init &&
          (ts.isObjectLiteralExpression(init) || ts.isNewExpression(init)) && ts.isVariableDeclarationList(parent.parent) &&
          (parent.parent.flags & ts.NodeFlags.Const) && ts.isVariableStatement(parent.parent.parent) &&
          !parent.parent.parent.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) candidates.add(symbol);
      } else if (!((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node &&
            !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent) && !ts.isDeleteExpression(parent.parent))) {
        const symbol = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) :
          ts.isExportSpecifier(parent) ? checker.getExportSpecifierLocalTargetSymbol(parent) : checker.getSymbolAtLocation(node);
        if (symbol) escapes.add(symbol);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const symbol of escapes) candidates.delete(symbol);
  plainVariables.set(file, candidates);
  return candidates;
}

function ordinaryData(base: ts.Expression, key: string, checker: ts.TypeChecker): boolean {
  let expression = unwrap(base);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || !nonEscapingRecords(expression.getSourceFile(), checker).has(symbol)) return false;
    const init = initializer(symbol.valueDeclaration ?? null);
    if (!init) return false;
    expression = unwrap(init);
  }
  if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
    const decl = valueDeclaration(expression.expression, checker);
    if (!decl || !ts.isClassDeclaration(decl) || decl.heritageClauses?.length || decl.modifiers?.some(mod =>
        mod.kind === ts.SyntaxKind.Decorator || mod.kind === ts.SyntaxKind.DeclareKeyword || mod.kind === ts.SyntaxKind.AbstractKeyword) ||
        reassigned(decl, checker)) return false;
    // An undecorated data class with only primitive instance fields installs
    // own properties. A constructor, base class, accessor or arbitrary field
    // initializer could instead install a setter or return another object.
    let own = false;
    for (const field of decl.members) {
      if (!ts.isPropertyDeclaration(field) || !field.initializer || !(ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name)) ||
          field.name.text === '__proto__' || field.modifiers?.some(mod => mod.kind === ts.SyntaxKind.StaticKeyword ||
            mod.kind === ts.SyntaxKind.Decorator || mod.kind === ts.SyntaxKind.AccessorKeyword || mod.kind === ts.SyntaxKind.DeclareKeyword ||
            mod.kind === ts.SyntaxKind.AbstractKeyword)) return false;
      const value = unwrap(field.initializer);
      if (!ts.isStringLiteralLike(value) && !ts.isNumericLiteral(value) &&
          ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind)) return false;
      if (field.name.text === key) own = true;
    }
    return own;
  }
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.every(item => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) &&
    (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)) && item.name.text !== '__proto__') &&
    expression.properties.some(item => item.name && (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)) && item.name.text === key);
}

function writtenMember(node: ts.Node, checker: ts.TypeChecker) {
  if (!ts.isBinaryExpression(node) || ![ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) return null;
  return member(node.left, checker);
}

export function isOrdinaryHtmlReceiver(node: ts.Node, checker: ts.TypeChecker): boolean {
  const prop = writtenMember(node, checker);
  return !!(prop && ['innerHTML', 'outerHTML', 'srcdoc'].includes(prop.name) && ordinaryData(prop.base, prop.name, checker));
}

/* A character-escaped value only carries its guarantee where the surrounding
 * expression supplies an HTML text insertion. Attribute, URL and raw-script
 * parser states stay distinct. */
function textContext(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (ts.isTemplateExpression(node)) return htmlTextPieces([node.head.text, ...node.templateSpans.map(span => span.literal.text)]);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts = [''];
    let leaves = 0;
    function append(value: ts.Expression): boolean {
      if (++leaves > 64) return false;
      const child = unwrap(value);
      if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.PlusToken) return append(child.left) && append(child.right);
      if (ts.isStringLiteralLike(child)) parts[parts.length - 1] += child.text;
      else parts.push('');
      return true;
    }
    return append(node) && htmlTextPieces(parts);
  }
  return true;
}

function jsxMarkup(node: ts.Node): ts.Expression | null {
  if (!ts.isJsxAttribute(node) || !ts.isIdentifier(node.name) || node.name.text !== 'dangerouslySetInnerHTML') return null;
  const tag = node.parent.parent.tagName;
  if (!ts.isIdentifier(tag) || !/^[a-z]/.test(tag.text) || !node.initializer || !ts.isJsxExpression(node.initializer) ||
      !node.initializer.expression) return null;
  const init = unwrap(node.initializer.expression);
  if (!ts.isObjectLiteralExpression(init)) return null;
  let value: ts.Expression | null = null;
  for (const property of init.properties) {
    if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name))) value = null;
    else if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === '__html') {
      value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : null;
    }
  }
  return value;
}

export function semanticSink(node: ts.Node, checker: ts.TypeChecker): SemanticSink | null {
  if (ts.isBinaryExpression(node)) {
    const prop = writtenMember(node, checker);
    if (!prop || !['innerHTML', 'outerHTML', 'srcdoc'].includes(prop.name) || ordinaryData(prop.base, prop.name, checker)) return null;
    const role = roleOf(prop.base, checker);
    const supported = prop.name === 'srcdoc' ? role === 'frame' : element(role);
    if (role && !supported) return null;
    return { site: prop.key, value: node.right, kind: 'dom', context: role === 'raw-text-element' || !textContext(node.right) ? 'markup' : 'text',
      policy: supported ? null : 'unknown-receiver', label: 'HTML property assignment' };
  }
  if (ts.isCallExpression(node)) {
    const call = htmlInvocation(node, checker);
    if (!call) return null;
    const { method, site, args } = call;
    const first = args[0];
    if (!first) return null;
    const role = roleOf(call.receiver, checker);
    if (call.bound) {
      const original = roleOf(method.base, checker);
      if (!role || !original || (role !== original && !(element(role) && element(original)))) return null;
    }
    if (method.name === 'parseFromString') {
      // The HTML parser returns a detached, inert document. Rendering needs a
      // separate adoption step; parsing on its own is a trust-boundary review.
      return role === 'dom-parser' && args[1] && constantText(args[1], checker) === 'text/html' ?
        { site, value: first, kind: 'dom', context: 'markup', policy: 'detached-document', label: 'detached HTML document parser' } : null;
    }
    if (method.name === 'bypassSecurityTrustHtml') {
      return role === 'sanitizer' ? { site, value: first, kind: 'dom', context: 'markup', policy: 'trust-boundary', label: 'explicit framework HTML trust' } : null;
    }
    if (method.name === 'write' || method.name === 'writeln') {
      return role === 'document' ? { site, value: first, additionalValues: args.slice(1), kind: 'dom', context: 'markup',
        policy: null, label: 'document HTML stream' } : null;
    }
    if (method.name === 'createContextualFragment') {
      return role === 'range' ? { site, value: first, kind: 'dom', context: 'markup', policy: null, label: 'HTML fragment parser' } : null;
    }
    const value = method.name === 'insertAdjacentHTML' ? args[1] : first;
    if (!value || (role && !element(role))) return null;
    if (method.name === 'insertAdjacentHTML') {
      const position = constantText(first, checker);
      if (position !== null ? !RELATIVE_POSITIONS.has(position.toLowerCase()) : call.bound) return null;
    }
    if (ordinaryData(method.base, method.name, checker)) return null;
    return { site, value, kind: 'dom', context: role === 'raw-text-element' || !textContext(value) ? 'markup' : 'text',
      policy: element(role) ? null : 'unknown-receiver', label: 'element HTML parser' };
  }
  const value = jsxMarkup(node);
  return value ? { value, kind: 'dom', context: textContext(value) ? 'text' : 'markup', policy: 'unknown-receiver', label: 'JSX raw HTML attribute' } : null;
}
