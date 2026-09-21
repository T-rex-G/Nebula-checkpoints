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
assert.strictEqual(pkg.scripts.typecheck, 'tsc --project jsconfig.json');

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
 * A real type error in a covered file fails, and emits nothing. The fixture is
 * a copy of a file the configuration already checks, so the error is the only
 * difference between passing and failing.
 */
{
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-typecheck-'));
  try {
    const subject = config.files.find(file => file.endsWith('single-use-store.js')) || config.files[0];
    const source = fs.readFileSync(path.join(root, subject), 'utf8');
    /*
     * Not a syntax error and not a lint complaint: a number where the callee
     * takes a string, which only a type checker can see.
     */
    const broken = `${source}\nconst brokenOnPurpose = guardKeyFor(42, Symbol('not a key'));\nmodule.exports.brokenOnPurpose = brokenOnPurpose;\n`;
    fs.writeFileSync(path.join(fixture, 'subject.js'), broken);
    fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { ...config.compilerOptions, types: [], strict: true },
      files: ['subject.js']
    }));

    const before = fs.readdirSync(fixture).sort();
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
      fs.readdirSync(fixture).sort(), before,
      'a failing check must leave no file behind: this is a checker, not a build step'
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

console.log('typecheck gate tests passed');
