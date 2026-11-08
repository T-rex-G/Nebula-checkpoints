'use strict';
/*
 * Every type assertion the server makes, counted and held.
 *
 * A type assertion is a claim the compiler takes on trust: `value as T`
 * tells it what a value is without proving it, `value!` that it is not null,
 * and `value as unknown as T` that two types it knows to be unrelated are the
 * same. Each is a place where strict TypeScript stops checking, so each is
 * counted here, by the syntax tree, file by file -- the server's source in
 * apps/api/src and the contracts in packages/contracts/src.
 *
 * The register beside it (test/oracles/type-assertions.json) holds each
 * file's count exactly. A new assertion fails here until it is recorded, and
 * one taken away fails here too until the record is lowered, so the register
 * always says how many remain and where. `as const` claims nothing about a
 * value and is not counted. A double cast is counted on its own as well:
 * those are the claims the compiler would refuse outright.
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

/* The assertions in one file: every claim, and the double casts among them. */
function assertionsIn(file) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  const counted = { assertions: 0, double: 0 };
  const isConst = node => ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === 'const';
  const visit = node => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !isConst(node)) {
      counted.assertions += 1;
      const inner = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
      if ((ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) counted.double += 1;
    } else if (ts.isNonNullExpression(node)) {
      counted.assertions += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counted;
}

const found = {};
for (const root of SOURCES) {
  for (const file of sources(path.join(ROOT, root)).sort()) {
    const counted = assertionsIn(file);
    if (counted.assertions) found[path.relative(ROOT, file).split(path.sep).join('/')] = counted;
  }
}
const total = Object.values(found).reduce((sum, counted) => sum + counted.assertions, 0);
const doubles = Object.values(found).reduce((sum, counted) => sum + counted.double, 0);

if (process.env.NV_TYPE_ASSERTIONS_WRITE === '1') {
  fs.writeFileSync(REGISTER, `${JSON.stringify({ total, double: doubles, files: found }, null, 1)}\n`);
  console.log(`type assertions: register written, ${total} in ${Object.keys(found).length} files`);
  process.exit(0);
}

/* The counting itself, on what it must and must not count. */
{
  const probe = path.join(require('node:os').tmpdir(), `nv-type-assertions-${process.pid}.ts`);
  fs.writeFileSync(probe, [
    'const a = value as string;', 'const b = <number>value;', 'const c = value!;', 'const d = value as unknown as Date;',
    "const e = ['x'] as const;", 'const f = (value as unknown) as Date;', 'const g = value satisfies object;'
  ].join('\n'));
  try {
    assert.deepEqual(assertionsIn(probe), { assertions: 7, double: 2 }, 'casts, angle casts and non-null claims count; as const and satisfies do not');
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
const files = new Set([...Object.keys(found), ...Object.keys(register.files)]);
const differences = [...files].sort().flatMap(file => {
  const now = found[file] || { assertions: 0, double: 0 };
  const recorded = register.files[file] || { assertions: 0, double: 0 };
  if (now.assertions === recorded.assertions && now.double === recorded.double) return [];
  return [`${file}: ${now.assertions} assertions (${now.double} double), recorded ${recorded.assertions} (${recorded.double})`];
});
assert.deepEqual(differences, [],
  'a type assertion added or removed: prove the value instead of claiming it, or record the change in test/oracles/type-assertions.json (NV_TYPE_ASSERTIONS_WRITE=1)');
assert.deepEqual([register.total, register.double], [total, doubles], 'the register\'s totals are its files\'');

console.log(`type assertions: ${total} in ${Object.keys(found).length} files, ${doubles} double`);
