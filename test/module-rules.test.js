'use strict';
/*
 * What the modules' code does, read from its syntax tree, where no request
 * can show it.
 *
 * Each property here sits behind a guard that already refuses what it would
 * let through, so asking the server finds the guard's answer, not this one:
 * defence in depth is invisible from outside by design. They are held over
 * the syntax tree rather than the text, so a comment or a string that only
 * names a property neither passes nor fails them.
 *
 *   - No module takes who is acting, or what they may do, from a request's
 *     body: governance roles, repository access, an actor's or a reviewer's
 *     identity, or an authorization. They are the server's to resolve.
 *   - Kepler's routes hand the governance service only the governance
 *     context's authorization, the one the server resolved for this request.
 *     (Other modules' authorizations are other things: a restore's signed
 *     grant, a verification's.)
 *   - Kepler's own-work allowance, which lets a public reader into their own
 *     scans and audits, is handed to routes as an allowance and used nowhere
 *     else.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'apps', 'api', 'src');
function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}
const files = sources(SOURCE);
assert(files.length > 100, 'the server\'s source must be found');

const CLAIMED = new Set(['governanceRoles', 'repositoryAccess', 'actorIdentityKey', 'reviewerIdentityKey', 'authorization']);
/* An expression with its parentheses, casts and assertions taken off: `(req.body as Fields)!` is `req.body`. */
const bare = node => {
  let at = node;
  while (at && (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isTypeAssertionExpression(at)
    || ts.isNonNullExpression(at) || ts.isSatisfiesExpression(at))) at = at.expression;
  return at;
};
/* `req.body`, however the request is named, or a name bound to it. */
const isBody = node => { const at = bare(node); return ts.isPropertyAccessExpression(at) && at.name.text === 'body'; };
const nameOf = node => (ts.isPropertyAccessExpression(node) ? node.name.text
  : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null);
/* What the governance context resolved: `governance(req).authorization` or `req.governance.authorization`. */
const isResolved = node => ts.isPropertyAccessExpression(node) && node.name.text === 'authorization' && (
  (ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'governance')
  || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'governance'));
/* Kepler's routes; the governance context is where the authorization is resolved. */
const KEPLER_HTTP = path.join(SOURCE, 'modules', 'kepler', 'http');
const isRoute = file => path.dirname(file) === KEPLER_HTTP && path.basename(file) !== 'governance-context.ts';
const OWN_WORK_HOME = new Set([path.join(SOURCE, 'modules', 'kepler', 'http', 'governance-context.ts'), path.join(SOURCE, 'modules', 'kepler', 'index.ts')]);

const claimed = [];
const handed = [];
const allowance = [];
let routesHandingAuthorization = 0;
let ownWorkAllowances = 0;
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const where = node => `${path.relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  /* Names bound to a request's body, as in `const body = req.body`. */
  const bodies = new Set();
  const bind = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isBody(node.initializer)) bodies.add(node.name.text);
    ts.forEachChild(node, bind);
  };
  bind(source);
  const fromBody = node => isBody(node) || (ts.isIdentifier(bare(node)) && bodies.has(bare(node).text));
  const visit = node => {
    /* req.body.governanceRoles, req.body['authorization'], body.actorIdentityKey */
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && fromBody(node.expression) && CLAIMED.has(nameOf(node))) {
      claimed.push(`${where(node)} reads ${nameOf(node)} from a request's body`);
    }
    /* const { governanceRoles } = req.body */
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && fromBody(node.initializer)) {
      for (const element of node.name.elements) {
        const name = (element.propertyName || element.name).getText(source);
        if (CLAIMED.has(name)) claimed.push(`${where(element)} takes ${name} from a request's body`);
      }
    }
    if (isRoute(file) && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'authorization') {
      if (isResolved(node.initializer)) routesHandingAuthorization += 1;
      else handed.push(`${where(node)} hands on ${node.initializer.getText(source)} as the authorization`);
    }
    if (ts.isShorthandPropertyAssignment(node) && isRoute(file) && node.name.text === 'authorization') {
      handed.push(`${where(node)} hands on a local authorization`);
    }
    if (ts.isIdentifier(node) && node.text === 'OWN_WORK' && !OWN_WORK_HOME.has(file)) {
      const parent = node.parent;
      const asAllowance = ts.isCallExpression(parent) && parent.arguments[1] === node
        && ts.isIdentifier(parent.expression) && parent.expression.text === 'governanceAccess';
      const declared = (ts.isPropertySignature(parent) || ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) && parent.name === node;
      const passedOn = ts.isShorthandPropertyAssignment(parent) && /[\\/]composition[\\/]/.test(file);
      if (asAllowance) ownWorkAllowances += 1;
      else if (!declared && !passedOn) allowance.push(`${where(node)} uses OWN_WORK other than as a route's allowance`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

assert.deepEqual(claimed, [], 'no module takes who is acting, or what they may do, from a request\'s body');
assert.deepEqual(handed, [], 'Kepler\'s routes hand on only the authorization the governance context resolved');
assert(routesHandingAuthorization > 20, `the routes that hand on an authorization are found (${routesHandingAuthorization})`);
assert.deepEqual(allowance, [], 'the own-work allowance is a route\'s allowance, and nothing else');
assert(ownWorkAllowances > 10, `the routes that take it are found (${ownWorkAllowances})`);

console.log('module rules: ok');
