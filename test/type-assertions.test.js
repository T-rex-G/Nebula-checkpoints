'use strict';
/*
 * Every type assertion the server makes, counted and held.
 *
 * A type assertion is a claim the compiler takes on trust: `value as T`
 * tells it what a value is without proving it, and `value!` that it is not
 * null. Each is a place where strict TypeScript stops checking, so each is
 * counted here, by the syntax tree, file by file -- the server's source in
 * apps/api/src and the contracts in packages/contracts/src.
 *
 * The register beside it (test/oracles/type-assertions.json) holds each
 * file's count exactly. A new assertion fails here until it is recorded, and
 * one taken away fails here too until the record is lowered, so the register
 * always says how many remain and where. `as const` and `satisfies` claim
 * nothing about a value and are not counted.
 *
 * Two kinds are not counted but refused: a double cast (`value as unknown as
 * T`), which claims two types the compiler knows to be unrelated are the
 * same, and a cast to `never`, which makes a value fit anywhere at all. None
 * is left, and none may come back: type the value instead.
 *
 * NV_TYPE_ASSERTIONS_WRITE=1 rewrites the register from the source.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const REGISTER = path.join(__dirname, 'oracles', 'type-assertions.json');
const SOURCES = ['apps/api/src', 'packages/contracts/src'];

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/* The assertions in one file, and where any refused one is. */
function assertionsIn(file) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  const counted = { assertions: 0, refused: [] };
  const isCast = node => ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
  const isConst = node => ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === 'const';
  const where = node => `${path.relative(ROOT, file).split(path.sep).join('/')}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const visit = node => {
    if (isCast(node) && !isConst(node)) {
      counted.assertions += 1;
      const inner = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
      if (isCast(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) counted.refused.push(`${where(node)} casts through unknown`);
      if (node.type.kind === ts.SyntaxKind.NeverKeyword) counted.refused.push(`${where(node)} casts to never`);
    } else if (ts.isNonNullExpression(node)) {
      counted.assertions += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counted;
}

const found = {};
const refused = [];
for (const root of SOURCES) {
  for (const file of sources(path.join(ROOT, root)).sort()) {
    const counted = assertionsIn(file);
    if (counted.assertions) found[path.relative(ROOT, file).split(path.sep).join('/')] = counted.assertions;
    refused.push(...counted.refused);
  }
}
const total = Object.values(found).reduce((sum, count) => sum + count, 0);

if (process.env.NV_TYPE_ASSERTIONS_WRITE === '1') {
  fs.writeFileSync(REGISTER, `${JSON.stringify({ total, files: found }, null, 1)}\n`);
  console.log(`type assertions: register written, ${total} in ${Object.keys(found).length} files`);
  process.exit(0);
}

/* The counting itself, on what it must and must not count, and what it refuses. */
{
  const probe = path.join(require('node:os').tmpdir(), `nv-type-assertions-${process.pid}.ts`);
  fs.writeFileSync(probe, [
    'const a = value as string;', 'const b = <number>value;', 'const c = value!;', 'const d = value as unknown as Date;',
    "const e = ['x'] as const;", 'const f = (value as unknown) as Date;', 'const g = value satisfies object;',
    'const h = value as never;', 'const i = <unknown>value as Date;'
  ].join('\n'));
  try {
    const counted = assertionsIn(probe);
    assert.equal(counted.assertions, 10, 'casts, angle casts and non-null claims count; as const and satisfies do not');
    assert.deepEqual(counted.refused.map(entry => entry.replace(/^.*:(\d+) /, '$1 ')), [
      '4 casts through unknown', '6 casts through unknown', '8 casts to never', '9 casts through unknown'
    ], 'a cast through unknown, in either form, and a cast to never are refused');
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

assert.deepEqual(refused, [], 'a double cast or a cast to never claims what the compiler would refuse: type the value instead');

const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
const files = new Set([...Object.keys(found), ...Object.keys(register.files)]);
const differences = [...files].sort().flatMap(file => {
  const now = found[file] || 0;
  const recorded = register.files[file] || 0;
  return now === recorded ? [] : [`${file}: ${now} assertions, recorded ${recorded}`];
});
assert.deepEqual(differences, [],
  'a type assertion added or removed: prove the value instead of claiming it, or record the change in test/oracles/type-assertions.json (NV_TYPE_ASSERTIONS_WRITE=1)');
assert.equal(register.total, total, 'the register\'s total is its files\'');

console.log(`type assertions: ${total} in ${Object.keys(found).length} files, none refused`);
