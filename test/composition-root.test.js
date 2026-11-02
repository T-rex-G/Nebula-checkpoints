'use strict';
/*
 * What the server's composition root does, read from its syntax tree.
 *
 * The root (apps/api/src/main.ts and apps/api/src/composition) builds the
 * platform and the modules and registers their routes. What the composed
 * server does is asked of it by test/composition.test.js and its database
 * and invite-only companions. Two properties no request can show are held
 * here instead, over the root's syntax rather than its text, so a comment or
 * a string that merely mentions a name neither passes nor fails them:
 *
 *   - The root disconnects no account itself. The central disconnect is
 *     handed to the routes that run it; the root calls no disconnect.
 *   - The root speaks to no provider itself. No string it holds names a
 *     provider's host or a Git, LFS or REST path: every provider exchange is
 *     a module's, behind the mutation gateway.
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
const PROVIDER_ENDPOINT = /\bgithub\.com\b|\bapi\.github\b|githubusercontent|\/info\/lfs\b|git-(?:receive|upload)-pack|\/repos\//i;

const calls = [];
const endpoints = [];
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const where = node => `${path.relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      if (ts.isIdentifier(callee) && DISCONNECTS.has(callee.text)) calls.push(`${where(node)} calls ${callee.text}`);
    }
    const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    const specifier = node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent));
    if (literal && !specifier && PROVIDER_ENDPOINT.test(node.text)) endpoints.push(`${where(node)} holds ${JSON.stringify(node.text)}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

assert.deepEqual(calls, [], 'the composition root calls no account disconnect: it hands the central one to the routes that run it');
assert.deepEqual(endpoints, [], 'the composition root names no provider host or Git, LFS or REST path: provider exchanges are the modules\'');

console.log('composition root: ok');
