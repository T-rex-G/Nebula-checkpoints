'use strict';
/*
 * What the server's composition root does, read from its syntax tree.
 *
 * The root (apps/api/src/main.ts and apps/api/src/composition) builds the
 * platform and the modules and registers their routes. What the composed
 * server does is asked of it by test/composition.test.js and its database
 * and invite-only companions. Four properties no request can show are held
 * here instead, over the root's syntax rather than its text, so a comment or
 * a string that merely mentions a name neither passes nor fails them:
 *
 *   - The root disconnects no account itself. The central disconnect is
 *     handed to the routes that run it; the root calls no disconnect.
 *   - The root speaks to no provider itself. No string it holds names a
 *     provider's host or a Git, LFS or REST path: every provider exchange is
 *     a module's, behind the mutation gateway.
 *   - The root makes no keyed construction of its own. Every key is the
 *     settings', derived for its own purpose (KEY_PURPOSES); a hash, an HMAC,
 *     a cipher or a key derivation called here would be a key nobody derived.
 *   - Every failure answer the root hands a route is the central one,
 *     sendFailure, and every public error body the central publicErrorBody,
 *     so a failure anywhere is answered with the public error body. That the
 *     composed server answers so is test/composition.test.js's; this holds
 *     every route that takes one to it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const COMPOSITION = path.join(ROOT, 'apps', 'api', 'src', 'composition');
const files = [
  path.join(ROOT, 'apps', 'api', 'src', 'main.ts'),
  ...fs.readdirSync(COMPOSITION).filter(name => name.endsWith('.ts')).sort().map(name => path.join(COMPOSITION, name))
];
assert(files.length > 2, 'the composition root must be found');

const DISCONNECTS = new Set(['disconnectAlphaProviderAccount', 'disconnectProviderAccounts']);
const KEYED = new Set(['createHmac', 'createHash', 'createCipheriv', 'createDecipheriv', 'createSign', 'createVerify', 'pbkdf2', 'pbkdf2Sync', 'scrypt', 'scryptSync', 'hkdf', 'hkdfSync']);
const CENTRAL = Object.freeze({ __proto__: null, fail: 'sendFailure', publicErrorBody: 'publicErrorBody' });
const PROVIDER_ENDPOINT = /\bgithub\.com\b|\bapi\.github\b|githubusercontent|\/info\/lfs\b|git-(?:receive|upload)-pack|\/repos\//i;

const calls = [];
const endpoints = [];
const keyed = [];
const failures = [];
const handed = { fail: 0, publicErrorBody: 0 };
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const where = node => `${path.relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      if (ts.isIdentifier(callee) && DISCONNECTS.has(callee.text)) calls.push(`${where(node)} calls ${callee.text}`);
      if (ts.isIdentifier(callee) && KEYED.has(callee.text)) keyed.push(`${where(node)} calls ${callee.text}`);
    }
    /* A failure answer handed over as `fail`, and a public error body as `publicErrorBody`: each must be the central one, by name. */
    const central = node.name && ts.isIdentifier(node.name) && CENTRAL[node.name.text];
    if (central && ts.isShorthandPropertyAssignment(node) && node.name.text !== central) failures.push(`${where(node)} hands over its own ${node.name.text}`);
    if (central && ts.isPropertyAssignment(node) && !(ts.isIdentifier(node.initializer) && node.initializer.text === central)) {
      failures.push(`${where(node)} hands over ${node.initializer.getText()} as ${node.name.text}`);
    }
    if (central && (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))) handed[node.name.text] += 1;
    const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    const specifier = node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent));
    if (literal && !specifier && PROVIDER_ENDPOINT.test(node.text)) endpoints.push(`${where(node)} holds ${JSON.stringify(node.text)}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

assert.deepEqual(calls, [], 'the composition root calls no account disconnect: it hands the central one to the routes that run it');
assert.deepEqual(endpoints, [], 'the composition root names no provider host or Git, LFS or REST path: provider exchanges are the modules\'');
assert.deepEqual(keyed, [], 'the composition root makes no keyed construction of its own: every key is the settings\', derived for its purpose');
assert.deepEqual(failures, [], 'every failure answer the composition root hands a route is the central sendFailure, and every public error body the central publicErrorBody');
assert(handed.fail > 0, 'and it does hand routes the central failure answer');
assert(handed.publicErrorBody > 0, 'and the central public error body');

console.log('composition root: ok');
