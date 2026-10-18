'use strict';

/*
 * CODEOWNERS, matched the way GitHub documents it. Each case is one of the
 * documented examples or a way the matching could hand a finding to the wrong
 * person: an earlier line winning over a later one, a shallow pattern
 * reaching nested files, an anchored pattern matching at any depth.
 */

const assert = require('assert');
const owners = require('../public/codeowners');

const FILE = [
  '# Lines starting with # are comments.',
  '*       @global-owner1 @global-owner2',
  '*.js    @js-owner #This is an inline comment.',
  '*.go docs@example.com',
  '*.txt @octo-org/octocats',
  '/build/logs/ @doctocat',
  'docs/*  docs@example.com',
  'apps/ @octocat',
  '/docs/ @doctocat',
  '/scripts/ @doctocat @octocat',
  '**/logs @octocat',
  '/apps/github',
  '!secret.txt @nobody',
  '[abc].md @nobody',
  '\\#notes.md @hash-owner',
  'odd @not-an-owner!'
].join('\n');

const rules = owners.parse(FILE);
const of = path => owners.ownersOf(rules, path);

assert.deepStrictEqual(of('README.md'), ['@global-owner1', '@global-owner2'], 'the catch-all owns what nothing later claims');
assert.deepStrictEqual(of('src/deep/app.js'), ['@js-owner'], 'an unanchored pattern matches at any depth, and a later line wins');
assert.deepStrictEqual(of('main.go'), ['docs@example.com']);
assert.deepStrictEqual(of('notes/a.txt'), ['@octo-org/octocats'], 'a team owner is kept');
assert.deepStrictEqual(of('build/logs/today.log'), ['@octocat'], 'the later **/logs line wins over /build/logs/');
assert.deepStrictEqual(of('docs/getting-started.md'), ['@doctocat'], '/docs/ is later than docs/*');
assert.deepStrictEqual(of('apps/web/index.html'), ['@octocat'], 'a trailing slash owns everything under the directory');
assert.deepStrictEqual(of('lib/apps/x.rb'), ['@octocat'], 'apps/ is matched at any depth');
assert.deepStrictEqual(of('apps/github/x.rb'), [], 'a pattern with no owners clears ownership');
assert.deepStrictEqual(of('scripts/run.sh'), ['@doctocat', '@octocat']);
assert.deepStrictEqual(of('src/scripts/run.sh'), ['@global-owner1', '@global-owner2'], 'an anchored pattern does not match deeper');
assert.deepStrictEqual(of('secret.txt'), ['@octo-org/octocats'], 'negation is not supported, so the line is skipped');
assert.deepStrictEqual(of('a.md'), ['@global-owner1', '@global-owner2'], 'character ranges are not supported, so the line is skipped');
assert.deepStrictEqual(of('#notes.md'), ['@hash-owner'], 'an escaped # starts a pattern, not a comment');
assert.deepStrictEqual(of('odd'), [], 'something that is not a handle or an address is not an owner');
assert.deepStrictEqual(of(''), []);

/* docs/* is shallow, on its own. */
{
  const shallow = owners.parse('docs/* @docs\n');
  assert.deepStrictEqual(owners.ownersOf(shallow, 'docs/a.md'), ['@docs']);
  assert.deepStrictEqual(owners.ownersOf(shallow, 'docs/build/b.md'), [], 'docs/* does not reach nested files');
  assert.deepStrictEqual(owners.ownersOf(owners.parse('docs/** @deep\n'), 'docs/build/b.md'), ['@deep'], 'docs/** does');
}

/* Across the wire and back, the same answers. */
{
  const revived = owners.revive(JSON.parse(JSON.stringify(owners.serialize(rules))));
  for (const path of ['README.md', 'src/deep/app.js', 'build/logs/today.log', 'apps/github/x.rb', 'docs/getting-started.md']) {
    assert.deepStrictEqual(owners.ownersOf(revived, path), of(path), path);
  }
  assert.ok(!JSON.stringify(owners.serialize(rules)).includes('regex'), 'no regex crosses the wire');
}

/* Bounded. */
{
  const huge = Array.from({ length: owners.MAX_RULES + 50 }, (_, index) => `f${index}.x @o`).join('\n');
  assert.strictEqual(owners.parse(huge).length, owners.MAX_RULES);
  assert.deepStrictEqual(owners.LOCATIONS, ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
}

console.log('codeowners tests passed');
