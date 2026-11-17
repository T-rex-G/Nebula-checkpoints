'use strict';
/*
 * What a protected-path pattern covers, read the two ways it is read: by the
 * server (pathMatches, apps/api/src/platform/values/path-patterns.ts), which
 * refuses a write to a protected path and scores a pushed change to one, and
 * by the page (protectedPatternMatch, apps/web/src/legacy/app.js), which shows
 * a file as protected. A file the page shows as protected must be one the
 * server protects, and the other way round, so one table is put to both.
 *
 * A folder is written either way: `docs` or `docs/`. Both cover the folder and
 * everything beneath it. A folder written with its slash used to cover only
 * the literal `docs/`, which no file is, so the protection a person set
 * protected nothing; the page showed nothing beneath it as protected, so the
 * gap went unseen.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathMatches } = require('../apps/api/src/platform/values/path-patterns.ts');
const { protectedPathError } = require('../apps/api/src/modules/corona/index.ts');

const page = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');
const start = page.indexOf('function protectedPatternMatch(');
const end = page.indexOf('\n}\n', start);
assert(start >= 0 && end > start, 'the page must declare protectedPatternMatch');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${page.slice(start, end + 2)}\nthis.protectedPatternMatch = protectedPatternMatch;`, sandbox);
const readers = Object.freeze({ server: pathMatches, page: sandbox.protectedPatternMatch });

/* [pattern, path, covered] */
const TABLE = Object.freeze([
  /* A plain path covers itself and everything beneath it. */
  ['README.md', 'README.md', true],
  ['infra', 'infra/prod/main.tf', true],
  ['docs', 'docs/guide.md', true],
  ['docs', 'docsite/guide.md', false],
  /* A folder written with its slash covers the same, however the slashes are written. */
  ['docs/', 'docs/guide.md', true],
  ['docs/', 'docs/en/guide.md', true],
  ['.github/workflows/', '.github/workflows/ci.yml', true],
  ['docs//', 'docs/guide.md', true],
  ['/docs/', 'docs/guide.md', true],
  ['\\docs\\', 'docs/guide.md', true],
  ['docs//en', 'docs/en/guide.md', true],
  ['docs', 'docs//guide.md', true],
  ['docs/*.md', 'docs//guide.md', true],
  ['docs/', 'docsite/guide.md', false],
  ['docs/', 'doc/guide.md', false],
  /* `*` and `?` stay within a segment; `**` crosses them, and `**\/` may be no folder at all. */
  ['src/*.js', 'src/app.js', true],
  ['src/*.js', 'src/lib/a.js', false],
  ['docs/??.md', 'docs/en.md', true],
  ['docs/??.md', 'docs/eng.md', false],
  ['.github/workflows/**', '.github/workflows/deploy.yml', true],
  ['**/.env*', '.env', true],
  ['**/.env*', 'apps/api/.env.local', true],
  ['**/migrations/**', 'db/migrations/001_sessions.sql', true],
  /* A wildcard folder covers everything beneath the folders it names, and nothing beside them. */
  ['src/*/', 'src/lib/a.js', true],
  ['src/*/', 'src/lib/deep/b.js', true],
  ['src/*/', 'src/a.js', false],
  /* An empty pattern covers nothing, and none reaches outside the repository. */
  ['', 'src/a.js', false],
  ['/', 'src/a.js', false],
  ['../secret', 'secret', false]
]);

for (const [pattern, candidate, covered] of TABLE) {
  for (const [reader, matches] of Object.entries(readers)) {
    assert.equal(matches(pattern, candidate), covered,
      `${reader}: ${JSON.stringify(pattern)} ${covered ? 'covers' : 'does not cover'} ${candidate}`);
  }
}

/* And the write guard refuses what a folder protection covers, written either way. */
for (const folder of ['docs', 'docs/']) {
  const request = { params: { owner: 'acme', repo: 'demo' }, effectiveSafety: { protected: { 'acme/demo': [folder] } } };
  assert.match(protectedPathError(request, ['docs/en/guide.md']), /^docs\/en\/guide\.md is a protected file/,
    `a write beneath ${JSON.stringify(folder)} is refused`);
  assert.equal(protectedPathError(request, ['docsite/guide.md']), '', `and one beside ${JSON.stringify(folder)} is not`);
}

console.log('protected path patterns: ok');
