'use strict';
/*
 * The compiled server tree (scripts/build-server.js), checked as it was built:
 * run by the `server-compiled` CI job after `npm run build:server:check`.
 *
 *  - It holds JavaScript only, laid out as the source is, and every relative
 *    specifier it carries resolves to a file it contains.
 *  - Worker and child-process entries resolve to the emitted files, and an
 *    analysis started on a worker thread there returns what the source does.
 *  - The tree names itself as the server will at startup.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { describeServerRuntime } = require('../../apps/api/src/platform/release/server-runtime.ts');
const { listFiles } = require('../../apps/api/src/platform/release/directory-digest.ts');

const root = path.resolve(__dirname, '..', '..');
const compiled = path.join(root, 'dist', 'server');
assert(fs.existsSync(path.join(compiled, 'server.js')), 'the compiled server is not built: run npm run build:server');

const files = listFiles(compiled, 'the compiled server');
const code = files.filter(file => /^(?:server\.js|src\/.+\.js|apps\/api\/src\/.+\.js|packages\/contracts\/src\/.+\.js)$/.test(file));
assert.deepEqual(files.filter(file => /\.(?:ts|tsx|mts|cts)$/.test(file)), [], 'the compiled tree carries TypeScript source');
for (const scope of ['package.json', 'apps/package.json', 'packages/package.json']) {
  assert.deepEqual(fs.readFileSync(path.join(compiled, scope), 'utf8'), fs.readFileSync(path.join(root, scope), 'utf8'), `${scope} is copied as it is`);
}

/* Every relative require and import the server's code carries names a file in the tree. */
const unresolved = [];
for (const file of code) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(compiled, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = node => {
    let specifier = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      specifier = node.arguments[0].text;
    }
    if (specifier && specifier.startsWith('.')) {
      const target = path.resolve(path.dirname(path.join(compiled, file)), specifier);
      const found = [target, `${target}.js`, `${target}.json`, path.join(target, 'index.js')].some(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (/\.ts$/.test(specifier) || !found) unresolved.push(`${file}: ${specifier}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
assert.deepEqual(unresolved, [], 'a compiled module names a file the compiled tree does not have');

/* Entries resolve to the emitted files, and a worker thread runs from them. */
const { entryFile } = require(path.join(compiled, 'apps', 'api', 'src', 'entrypoint.js'));
assert.equal(entryFile('code-audit-worker'), path.join(compiled, 'src', 'code-audit-worker.js'));
assert.equal(entryFile('rendered-site-worker'), path.join(compiled, 'src', 'rendered-site-worker.js'));
assert(fs.existsSync(entryFile('rendered-site-worker')));

const runtime = describeServerRuntime(compiled);
assert.equal(runtime.mode, 'compiled');
assert.equal(runtime.sourceRoot, root);

(async () => {
  const input = { mode: 'rules', files: [{ path: 'server.js', text: "const { exec } = require('child_process');\nexec(req.query.cmd);\n" }] };
  const native = await require('../../src/code-audit-worker').scanOffThread(input);
  const fromTree = await require(path.join(compiled, 'src', 'code-audit-worker.js')).scanOffThread(input);
  assert(native.raw.some(finding => finding.rule === 'SEC-010'), 'the analysis found the command injection it was given');
  assert.deepEqual(fromTree, native, 'the compiled worker returns what the source worker returns');
  console.log(`compiled server tests passed (${code.length} modules, ${files.length} files, serverBuildSha256 ${runtime.buildSha256})`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
