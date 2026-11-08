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
 *     identity, a tester, or an authorization. They are the server's to
 *     resolve.
 *   - Kepler's routes hand the governance service only the governance
 *     context's authorization, the one the server resolved for this request.
 *     (Other modules' authorizations are other things: a restore's signed
 *     grant, a verification's.)
 *   - Kepler's own-work allowance, which lets a public reader into their own
 *     scans and audits, is handed to routes as an allowance and used nowhere
 *     else.
 *   - An account is disconnected -- its webhooks removed and read back, its
 *     provider session ended -- only by the routes that remove one: removing
 *     an account, signing out, disconnecting the GitHub App, disconnecting
 *     every provider and deleting the alpha's data. What each of them does is
 *     asked of it (test/identity-account-routes.test.js,
 *     test/identity-security-routes.test.js); that no other route does it is
 *     held here.
 *   - An installation's record is removed only by that disconnect, after the
 *     provider is cleaned up.
 *   - Quasar's scanning code -- the background worker, the repository reader,
 *     the credential verifier and the readability probe -- reaches the network,
 *     the disk and other processes only through what it is handed. The worker
 *     cannot load the verifier at all, nor resolve a ref: a background job
 *     acts on what the request path resolved, and never decides a credential
 *     is live.
 *   - Exposure evidence is append-only, and every statement that reaches a
 *     scan or a finding is held to its owner. Observations change only to
 *     reconcile their deduplicated count; verifications and readability probes
 *     never change; none of the three is deleted anywhere in the server -- they
 *     leave with their scan or finding, by cascade. A statement on a scan or a
 *     finding carries the identity or the worker's claim, or is one of five
 *     stated exceptions. Recording a probe moves no finding, and a row leaves
 *     the store field by field, never spread.
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

const CLAIMED = new Set(['governanceRoles', 'repositoryAccess', 'actorIdentityKey', 'reviewerIdentityKey', 'testerId', 'authorization']);
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

/* The account disconnect, by the name the routes are handed it or by the account lifecycle's own. */
const DISCONNECT = new Set(['disconnectProviderAccounts', 'disconnectAlphaProviderAccount']);
const REMOVAL_ROUTES = ['/api/accounts/remove', '/api/alpha/delete', '/api/alpha/providers/disconnect-all', '/api/github-app/disconnect', '/api/logout'];
const calledName = node => {
  const callee = bare(node.expression);
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
};
/* The route a node is registered under: the path of the nearest enclosing `app.post('/api/…', …)`. */
const routeOf = node => {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && ts.isIdentifier(at.expression.expression)
      && at.expression.expression.text === 'app' && /^(get|post|put|patch|delete)$/.test(at.expression.name.text)
      && at.arguments.length && ts.isStringLiteralLike(at.arguments[0])) return at.arguments[0].text;
  }
  return null;
};
/* The function a node is written in, by its declared name. */
const functionOf = node => {
  for (let at = node.parent; at; at = at.parent) if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
  return null;
};

const claimed = [];
const handed = [];
const allowance = [];
const strayDisconnects = [];
const disconnectingRoutes = new Set();
const strayRemovals = [];
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
    /* member(req.body, 'testerId'), read(body, 'authorization'): a field reader handed the body; bodyField(req, 'testerId'), one handed the request. */
    if (ts.isCallExpression(node) && node.arguments.length >= 2 && ts.isStringLiteralLike(node.arguments[1]) && CLAIMED.has(node.arguments[1].text)
      && (fromBody(node.arguments[0]) || (ts.isIdentifier(node.expression) && node.expression.text === 'bodyField'))) {
      claimed.push(`${where(node)} reads ${node.arguments[1].text} from a request's body`);
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
    if (ts.isCallExpression(node) && DISCONNECT.has(calledName(node))) {
      const route = routeOf(node);
      if (REMOVAL_ROUTES.includes(route)) disconnectingRoutes.add(route);
      else strayDisconnects.push(`${where(node)} disconnects an account${route ? ` in ${route}` : ''}, which removes none`);
    }
    if (ts.isCallExpression(node) && calledName(node) === 'removeGithubAppInstallation'
      && !(path.basename(file) === 'account-lifecycle.ts' && functionOf(node) === 'disconnectAlphaProviderAccount')) {
      strayRemovals.push(`${where(node)} removes an installation's record outside the account disconnect`);
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
/* ---- Quasar: what the scanning code reaches, and what the exposure store's statements do ---- */
const QUASAR = path.join(SOURCE, 'modules', 'quasar');
const parsedFiles = new Map();
const parse = file => {
  if (!parsedFiles.has(file)) parsedFiles.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return parsedFiles.get(file);
};
const each = (node, visit) => { visit(node); ts.forEachChild(node, child => each(child, visit)); };
/* The modules a file loads, as written: value imports, re-exports and require() calls. */
const specifiersOf = source => {
  const found = [];
  each(source, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && !(node.importClause && node.importClause.isTypeOnly)) found.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && !node.isTypeOnly) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) found.push(node.arguments[0].text);
  });
  return found;
};
const REACHING = new Set(['child_process', 'fs', 'fs/promises', 'http', 'https', 'net', 'tls', 'dgram', 'undici']);
const RUNNING = new Set(['fetch', 'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const SCANNING = ['application/exposure-worker.ts', 'client/exposure-reader.ts', 'client/anonymous-readability-probe.ts', 'client/credential-verification.ts']
  .map(file => path.join(QUASAR, file));
const reaching = [];
for (const file of SCANNING) {
  const source = parse(file);
  for (const specifier of specifiersOf(source)) {
    if (REACHING.has(specifier.replace(/^node:/, ''))) reaching.push(`${path.relative(ROOT, file)} loads ${specifier}`);
  }
  each(source, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && RUNNING.has(node.expression.text)) {
      reaching.push(`${path.relative(ROOT, file)} calls ${node.expression.text}() itself`);
    }
  });
}
/* Everything the worker loads, followed through its relative imports. */
const WORKER = path.join(QUASAR, 'application', 'exposure-worker.ts');
const workerLoads = new Set();
const follow = file => {
  if (workerLoads.has(file)) return;
  workerLoads.add(file);
  for (const specifier of specifiersOf(parse(file))) {
    const target = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;
    if (target && fs.existsSync(target)) follow(target);
  }
};
follow(WORKER);
const resolving = [];
each(parse(WORKER), node => { if (ts.isIdentifier(node) && node.text === 'resolveCommit') resolving.push(node.getStart()); });

/* The text of every string the exposure store holds, its statements among them. */
const STORE = path.join(QUASAR, 'persistence', 'exposure-store.ts');
const stringsIn = (source, within = source) => {
  const found = [];
  each(within, node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) found.push(node.getText(source).slice(1, -1));
  });
  return found;
};
const storeSource = parse(STORE);
const statements = stringsIn(storeSource).filter(text => /nv_exposure/.test(text)).map(text => text.replace(/\s+/g, ' ').trim());
const observationUpdates = statements.filter(statement => /UPDATE nv_exposure_observations/.test(statement));
const rewritten = statements.filter(statement => /UPDATE nv_exposure_(?:verifications|readability_probes)/.test(statement));
/* The five statements that reach a scan or a finding without its identity or a claim, each for a stated reason. */
const UNSCOPED = [
  /FOR UPDATE SKIP LOCKED/, /* The claim picks up work for whichever worker asks: a worker is not a tenant. */
  /^SELECT \* FROM nv_exposure_scans WHERE scan_id=\$1$/, /* The parent lookup inside concludeRemovedFromTree, after its first statement matched the scan on its identity. */
  /DELETE FROM nv_exposure_scans WHERE ctid IN/, /* Retention: time-scoped by design, and needs nobody signed in. */
  /UPDATE nv_exposure_findings AS finding/, /* A scan's conclusion, run under the scan's claim. */
  /UPDATE nv_exposure_findings SET disposition='credential-rejected'/ /* The disposition move in recordVerification, on a finding its transaction locked by identity. */
];
const unscoped = statements.filter(statement => /nv_exposure_scans|nv_exposure_findings/.test(statement)
  && !/identity_key/.test(statement) && !/claim_owner=\$/.test(statement) && !UNSCOPED.some(pattern => pattern.test(statement)));
let probeMethod = null;
each(storeSource, node => { if (ts.isMethodDeclaration(node) && node.name.getText(storeSource) === 'recordReadabilityProbe') probeMethod = node; });
const spread = [];
each(storeSource, node => {
  if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && ts.isIdentifier(bare(node.expression)) && /^row$|Row$/.test(bare(node.expression).text)) {
    spread.push(`${path.relative(ROOT, STORE)}:${storeSource.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
  }
});
const evidenceDeleted = [];
for (const file of files) {
  for (const text of stringsIn(parse(file))) {
    if (/DELETE FROM nv_exposure_(?:observations|verifications|readability_probes)\b/.test(text)) evidenceDeleted.push(`${path.relative(ROOT, file)}: ${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
  }
}

assert.deepEqual(reaching, [], 'Quasar\'s scanning code reaches the network, the disk and other processes only through what it is handed');
assert(workerLoads.size > 5, `the worker's imports are followed (${workerLoads.size})`);
assert(!workerLoads.has(path.join(QUASAR, 'client', 'credential-verification.ts')), 'a background scan cannot load the credential verifier at all');
assert.deepEqual(resolving, [], 'nor resolve a ref: it is resolved once, on the request path');
assert(statements.length >= 12, `the store's statements are found (${statements.length})`);
assert.equal(observationUpdates.length, 1, 'an observation changes only to reconcile its deduplicated count');
assert.match(observationUpdates[0], /^UPDATE nv_exposure_observations SET history_commits=\( ?SELECT count\(\*\)::integer FROM nv_exposure_history_sightings/);
assert.match(observationUpdates[0], /WHERE scan_id=\$1 AND fingerprint=\$2$/);
assert.deepEqual(rewritten, [], 'a verification or a probe is evidence: never edited');
assert.deepEqual(evidenceDeleted, [], 'observations, verifications and probes leave with their scan or finding, by cascade, and not otherwise');
assert.deepEqual(unscoped, [], 'a statement on a scan or a finding carries its identity, the worker\'s claim, or a stated exception');
assert(probeMethod, 'the probe recorder is found');
assert.deepEqual(stringsIn(storeSource, probeMethod).filter(text => /UPDATE nv_exposure_findings/.test(text)), [], 'what the anonymous role can read moves no finding');
assert.deepEqual(spread, [], 'a row leaves the store field by field: spreading one publishes the next column added');

assert.deepEqual(strayDisconnects, [], 'only a route that removes an account disconnects one');
assert.deepEqual([...disconnectingRoutes].sort(), REMOVAL_ROUTES, 'and each of them is found');
assert.deepEqual(strayRemovals, [], 'an installation\'s record is removed only by the account disconnect');

console.log('module rules: ok');
