'use strict';

/*
 * A test that only greps package.json for a script name proves the script was
 * spelled, not that anything is checked. These run the checker.
 *
 * Three properties matter. The project's own configuration passes, so a red
 * result is always a regression rather than inherited debt. A real type error
 * in a file the configuration covers actually fails. And nothing is emitted --
 * the whole point is a checker that reads the JavaScript already running, not
 * a build step arriving by the back door.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(
  /* jsconfig.json carries comments, as tsc allows. Strip them to read it. */
  fs.readFileSync(path.join(root, 'jsconfig.json'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
);

function tsc(args, cwd = root) {
  return spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ...args], {
    cwd, encoding: 'utf8', timeout: 180_000
  });
}

/* The checker is a pinned development dependency, not something fetched at
   run time: a gate that reaches the network is a gate that can be offline. */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.strictEqual(
  pkg.devDependencies.typescript, '5.9.3',
  'the checker must be pinned exactly, like every other dependency here'
);
assert(
  fs.existsSync(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')),
  'the checker must be installed from the lockfile rather than resolved globally'
);
/*
 * The JavaScript that remains, then the strict TypeScript areas. The shared
 * contracts are checked under each platform that runs them: none of their
 * own, the server's (Node) and the page's (the DOM).
 */
assert.strictEqual(pkg.scripts.typecheck,
  'tsc --project jsconfig.json && tsc --project packages/contracts && tsc --project apps/api && tsc --project apps/web');
for (const project of ['packages/contracts', 'apps/api', 'apps/web']) {
  const result = tsc(['--project', project]);
  assert.strictEqual(result.status, 0, `${project} must pass the strict checker:\n${result.stdout || ''}${result.stderr || ''}`);
}

/* Nothing is emitted, and the configuration says so rather than relying on
   the invocation to pass --noEmit. */
assert.strictEqual(config.compilerOptions.noEmit, true, 'the checker must never produce a file');
assert.strictEqual(config.compilerOptions.checkJs, true);
assert.strictEqual(config.compilerOptions.allowJs, true);
assert(Array.isArray(config.files) && config.files.length > 0, 'the checked set must be explicit');
for (const file of config.files) {
  assert(fs.existsSync(path.join(root, file)), `jsconfig lists a file that does not exist: ${file}`);
}

/* The project passes today. */
{
  const result = tsc(['--project', 'jsconfig.json']);
  assert.strictEqual(
    result.status, 0,
    `the checked set must pass:\n${result.stdout || ''}${result.stderr || ''}`
  );
}

/*
 * A real type error in a covered file fails, and emits nothing. Each fixture is
 * a copy of a file a configuration already checks, shown to pass as copied, so
 * the planted error is the only difference between passing and failing. One is
 * the JavaScript that remains, under the JavaScript options made strict; the
 * other a server module under the strict TypeScript options it is held to.
 */
function provesTypeError({ files, compilerOptions, plant, subject }) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-typecheck-'));
  try {
    for (const [to, from] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(fixture, to)), { recursive: true });
      fs.copyFileSync(path.join(root, from), path.join(fixture, to));
    }
    fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: [subject] }));

    const clean = tsc(['--project', 'tsconfig.json'], fixture);
    assert.strictEqual(clean.status, 0, `the copied ${subject} must pass as it is:\n${clean.stdout || ''}${clean.stderr || ''}`);

    fs.appendFileSync(path.join(fixture, subject), plant);
    const before = fs.readdirSync(fixture, { recursive: true }).sort();
    const result = tsc(['--project', 'tsconfig.json'], fixture);
    assert.notStrictEqual(
      result.status, 0,
      'a real type error must fail the checker rather than be reported and ignored'
    );
    assert.match(
      `${result.stdout || ''}${result.stderr || ''}`, /error TS\d+/,
      'and must say what it found'
    );
    assert.deepStrictEqual(
      fs.readdirSync(fixture, { recursive: true }).sort(), before,
      'a failing check must leave no file behind: this is a checker, not a build step'
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

/* Not a syntax error and not a lint complaint: a number used as text, which only a type checker can see. */
assert(config.files.includes('src/config-registry.js'), 'the JavaScript fixture is a file the configuration covers');
provesTypeError({
  files: { 'subject.js': 'src/config-registry.js' },
  compilerOptions: { ...config.compilerOptions, types: [], strict: true },
  subject: 'subject.js',
  plant: '\nconst brokenOnPurpose = ENTRIES.length.toUpperCase();\nmodule.exports.brokenOnPurpose = brokenOnPurpose;\n'
});

/* A number where the callee takes a string, in a server module checked strictly. */
const base = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8')).compilerOptions;
const api = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'api', 'tsconfig.json'), 'utf8')).compilerOptions;
provesTypeError({
  files: {
    'package.json': 'apps/package.json',
    'rate-limit/single-use-store.ts': 'apps/api/src/platform/rate-limit/single-use-store.ts',
    'persistence/queryable.ts': 'apps/api/src/platform/persistence/queryable.ts'
  },
  compilerOptions: { ...base, ...api, typeRoots: [path.join(root, 'node_modules', '@types')] },
  subject: 'rate-limit/single-use-store.ts',
  plant: "\nexport const brokenOnPurpose = guardKeyFor(42, 'not a kind');\n"
});

console.log('typecheck gate tests passed');
