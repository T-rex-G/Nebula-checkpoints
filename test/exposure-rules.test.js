'use strict';

/*
 * The scan's own detectors, and the three ways a detector goes wrong.
 *
 * It misses a real credential: every rule has a positive fixture shaped like
 * the issuer's real tokens, and each must be found under its own rule and no
 * other.
 *
 * It reports something that is not a credential: documentation placeholders,
 * lockfile hashes, UUIDs, colours, commit ids and ordinary JWTs are run through
 * every rule and must produce nothing. A detector that fires on a lockfile
 * teaches a reader to stop reading the findings.
 *
 * Or it is fast only because it is wrong: the keyword pre-filter that keeps
 * sixty rules as cheap as six is proven to change no answer, by running the
 * whole corpus with it on and off.
 *
 * No fixture is written out as a literal. Each is assembled from pieces and a
 * deterministic generator, so this file never contains a string a secret
 * scanner -- this repository's own gate, or a provider's push protection --
 * would take for a real key.
 */

const assert = require('assert');
const crypto = require('crypto');

const { EXPOSURE_RULES, PATH_RULES, detectInText, detectInPath, createLocator } = require('../src/exposure-detection');
const { plausibleSecret, plausibleConnectionString, shannonEntropy, MIN_ENTROPY_BITS } = require('../src/exposure-rules');

const { ALL_FIXTURES, FIXTURES, SUPABASE_FIXTURES, jwt, random } = require('./fixtures/exposure-rule-fixtures');

function fixtureFor(rule) {
  const built = ALL_FIXTURES[rule]();
  return { secret: built.secret, line: built.line || `const value = '${built.secret}';` };
}

function scanRules(result) {
  const names = new Set(EXPOSURE_RULES.map(rule => rule.rule));
  return result.candidates.filter(candidate => names.has(candidate.rule));
}

/* ---- Every rule has a fixture, and every fixture is found -------------- */

{
  assert(EXPOSURE_RULES.length >= 60, `the catalogue must be broad: ${EXPOSURE_RULES.length}`);
  const names = EXPOSURE_RULES.map(rule => rule.rule);
  assert.strictEqual(new Set(names).size, names.length, 'rule names must be unique');
  /*
   * A rule's name becomes part of a finding's placeholder, and the database
   * admits a placeholder only as `<lower-case-and-dashes #n>`. A rule named
   * with a digit would find credentials and then fail to record every one.
   */
  const migration = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'db', 'migrations', '022_exposure_scans.sql'), 'utf8'
  );
  assert(migration.includes("placeholder ~ '^<[a-z-]+ #[0-9]+>$'"), 'the constraint this check mirrors must still be the one in the schema');
  for (const name of [...names, ...PATH_RULES.map(rule => rule.rule)]) {
    assert(/^[a-z-]+$/.test(name) && name.length <= 64, `${name}: a rule name must be storable in a placeholder`);
  }
  assert.deepStrictEqual(
    names.filter(name => !ALL_FIXTURES[name]), [],
    'every rule needs a positive fixture, or nothing proves it can find anything'
  );
  assert.deepStrictEqual(
    Object.keys(ALL_FIXTURES).filter(name => !names.includes(name)), [],
    'and no fixture may describe a rule that does not exist'
  );

  for (const name of names) {
    const { secret, line } = fixtureFor(name);
    const result = detectInText({ text: `${line}\n`, path: 'app/config.js' });
    const found = result.candidates;
    /*
     * Exactly one candidate, under exactly this rule, with exactly these
     * bytes. Two would be one credential reported twice -- once under a rule
     * whose narration is wrong for it -- and a reader told the wrong provider
     * rotates the wrong thing.
     */
    assert.strictEqual(found.length, 1, `${name}: expected one candidate, found ${found.map(item => item.rule).join(', ') || 'none'}`);
    assert.strictEqual(found[0].rule, name, `${name}: reported under ${found[0].rule}`);
    assert.strictEqual(found[0].secret, secret, `${name}: the match must be the credential and nothing around it`);
    assert.strictEqual(found[0].placeholder, `<${name} #1>`);
    /* The random tail: a provider's public prefix can share a word with the
       rule's name (`rubygems_`), and that is not a byte of the secret. */
    assert.strictEqual(found[0].placeholder.includes(secret.slice(-8)), false, `${name}: the label must not carry the bytes`);
  }
}

/* ---- Keywords are necessary, and the pre-filter changes nothing -------- */

/*
 * A keyword is a substring every match must contain. Two checks, because a
 * wrong keyword is a silent miss: the rule is simply never run on the file
 * that holds the credential. Each keyword must appear literally in the rule's
 * own pattern, and each positive fixture must contain one.
 */
{
  for (const rule of EXPOSURE_RULES) {
    assert(Array.isArray(rule.keywords) && rule.keywords.length, `${rule.rule}: a scan rule must name its keywords`);
    const source = rule.regex.source.replace(/\\/g, '').toLowerCase();
    for (const keyword of rule.keywords) {
      assert.strictEqual(keyword, keyword.toLowerCase(), `${rule.rule}: keywords are compared lower-case`);
      assert(source.includes(keyword), `${rule.rule}: keyword ${JSON.stringify(keyword)} is not in its own pattern`);
    }
    const { line } = fixtureFor(rule.rule);
    assert(
      rule.keywords.some(keyword => line.toLowerCase().includes(keyword)),
      `${rule.rule}: its fixture contains none of its keywords, so the pre-filter would never run it`
    );
  }
}

/*
 * The same answers with the pre-filter on and off, over everything here --
 * in files of twenty fixtures each, because one file of all of them would hit
 * the per-file candidate ceiling and the comparison would be between two
 * truncated answers.
 */
{
  const lines = Object.keys(ALL_FIXTURES).map(name => fixtureFor(name).line);
  const found = new Set();
  for (let start = 0; start < lines.length; start += 20) {
    const corpus = lines.slice(start, start + 20).join('\n');
    const on = detectInText({ text: corpus, path: 'corpus.txt' });
    const off = detectInText({ text: corpus, path: 'corpus.txt', prefilter: false });
    assert.strictEqual(on.truncated, false, 'a chunk must stay under the ceiling for the comparison to mean anything');
    assert.deepStrictEqual(
      on.candidates.map(item => [item.rule, item.secret, item.occurrences]),
      off.candidates.map(item => [item.rule, item.secret, item.occurrences]),
      'the keyword pre-filter is an optimisation and must never change an answer'
    );
    for (const item of on.candidates) found.add(item.rule);
  }
  assert.deepStrictEqual(
    EXPOSURE_RULES.map(rule => rule.rule).filter(name => !found.has(name)), [],
    'every rule is found among its neighbours as well as alone'
  );
}

/* ---- Placeholders and near misses ------------------------------------ */

/*
 * Documentation is full of these, and a scanner that reports them is a
 * scanner people stop reading. Each is shaped closely enough to a real token
 * that only the plausibility check or a boundary stops it.
 */
{
  const negatives = [
    ['a run of x', `sk${'_live_'}${'x'.repeat(32)}`],
    ['a run of X', `AI${'za'}${'X'.repeat(35)}`],
    ['the word EXAMPLE', `AI${'za'}SyEXAMPLE${random('n1', 'b62', 26)}`],
    ['a sequential run', `np${'m_'}${'1234567890'.repeat(3)}abcdef`],
    ['a repeated character', `gs${'k_'}${'a'.repeat(52)}`],
    ['two alternating characters', `hf_${'ab'.repeat(17)}`],
    ['a documentation webhook', `https://hooks.${'slack.com'}/services/T00000000/B00000000/${'X'.repeat(24)}`],
    ['inside a longer identifier', `xsk${'_live_'}${random('n2', 'b62', 40)}`],
    ['a token that runs on', `np${'m_'}${random('n3', 'b62', 40)}`],
    ['a placeholder password', `mongodb://user:${'password'}@localhost:27017/app`],
    ['a template reference', `mysql://app:${'${DB_PASSWORD}'}@db.internal/app`],
    ['an environment reference', `redis://default:${'$REDIS_PASSWORD'}@cache:6379`],
    ['masked with stars', `amqp://guest:${'********'}@mq:5672`],
    /* The gate owns long PostgreSQL passwords; the scan rule stops below them
       so one connection string is never reported under two rules. */
    ['a long postgres password', `postgres://app:${random('n4', 'b62', 24)}@db.example.net/app`]
  ];
  for (const [label, text] of negatives) {
    const found = scanRules(detectInText({ text: `const v = "${text}";\n`, path: 'README.md' }));
    assert.deepStrictEqual(found.map(item => item.rule), [], `${label} must not be reported`);
  }
}

/*
 * A short PostgreSQL password is the scan's, not the gate's -- the other half
 * of the boundary above, so the split is proven from both sides.
 */
{
  const found = scanRules(detectInText({
    text: `DATABASE_URL=postgres://app:${random('pg', 'b62', 12)}@db.example.net/app\n`, path: '.env'
  }));
  assert.deepStrictEqual(found.map(item => item.rule), ['database-url-password']);
}

/* ---- Things that are not credentials --------------------------------- */

/*
 * Material every repository has, run through every rule. Any finding here is
 * a false positive a reader would see on day one.
 */
{
  const noise = [
    `"integrity": "sha512-${random('lock', 'b64', 86)}==",`,
    `"resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",`,
    `id: ${crypto.randomUUID()} parent: ${crypto.randomUUID()}`,
    `commit ${random('sha1', 'hex', 40)} tree ${random('sha2', 'hex', 40)}`,
    `color: #1f2937; background: #f9fafb; border-color: #e5e7eb;`,
    `<img src="data:image/png;base64,${random('png', 'b64', 200)}">`,
    `session = "${jwt({ sub: '123', name: 'A Person', iat: 1 })}"`,
    `const key = 'key-value store'; const skip = 'SKIP'; const patch = 'patch-1';`,
    `re_render(); hf_config = {}; pat = pattern; sk = sketch;`,
    `https://example.com/api/webhooks/not-a-discord-hook`,
    `password: process.env.DATABASE_PASSWORD`,
    `const AIza = 'AIza'; // prefix alone`,
    `-----BEGIN CERTIFICATE-----`,
    `-----BEGIN PUBLIC KEY-----`
  ].join('\n');
  const found = scanRules(detectInText({ text: noise, path: 'package-lock.json' }));
  assert.deepStrictEqual(found.map(item => `${item.rule}`), [], 'ordinary repository content must produce no finding');
}

/* ---- The plausibility check itself ----------------------------------- */

{
  assert(shannonEntropy('aaaaaaaa') === 0);
  assert(Math.abs(shannonEntropy('abababab') - 1) < 1e-9);
  assert(shannonEntropy(random('entropy', 'hex', 64)) > 3.5, 'random hex sits near four bits');
  assert(shannonEntropy(random('entropy', 'b62', 64)) > 5, 'random base-62 sits near six');
  assert.strictEqual(MIN_ENTROPY_BITS, 3);
  assert.strictEqual(plausibleSecret(random('p', 'b62', 40)), true);
  assert.strictEqual(plausibleSecret('your_api_key_here_12345'), false);
  assert.strictEqual(plausibleSecret('${STRIPE_SECRET_KEY}'), false);
  assert.strictEqual(plausibleConnectionString(`mongodb://u:${random('c', 'b62', 16)}@h/db`), true);
  assert.strictEqual(plausibleConnectionString('mongodb://u:changeme@h/db'), false);
  assert.strictEqual(plausibleConnectionString('mongodb://u:@h/db'), false);
}

/* ---- Files that are exposures by name --------------------------------- */

{
  const sha = random('blob', 'hex', 40);
  for (const [filePath, rule] of [
    ['android/app/release.jks', 'keystore-file'],
    ['certs/server.P12', 'keystore-file'],
    ['deploy/signing.pfx', 'keystore-file'],
    ['vault/passwords.kdbx', 'password-database-file']
  ]) {
    const result = detectInPath({ path: filePath, sha });
    assert.strictEqual(result.candidates.length, 1, filePath);
    assert.strictEqual(result.candidates[0].rule, rule, filePath);
    /* The identity is the blob: the same file again is the same finding. */
    assert.strictEqual(result.candidates[0].secret, `blob:${sha}`);
    assert.deepStrictEqual(result.candidates[0].occurrences, [{ line: 1, column: 1 }]);
  }
  for (const [filePath, blob] of [
    ['README.md', sha], ['keystore', sha], ['.jks', sha], ['app/release.jks', 'not-a-sha'], ['app/release.jks', '']
  ]) {
    assert.strictEqual(detectInPath({ path: filePath, sha: blob }).candidates.length, 0, `${filePath} ${blob}`);
  }
  assert.deepStrictEqual(PATH_RULES.map(rule => rule.rule), ['keystore-file', 'password-database-file']);
}

/* ---- The locator is the walk it replaced ----------------------------- */

/*
 * Held to the line-by-line walk on every offset of a file mixing all three
 * line endings, including a \r\n split across nothing and a trailing bare \r.
 */
{
  function walk(text, index) {
    let line = 1;
    let lineStart = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      const code = text.charCodeAt(cursor);
      if (code === 10) { line += 1; lineStart = cursor + 1; }
      else if (code === 13) {
        line += 1;
        if (text.charCodeAt(cursor + 1) === 10) cursor += 1;
        lineStart = cursor + 1;
      }
    }
    return { line, column: index - lineStart + 1 };
  }
  const text = 'one\ntwo\r\nthree\rfour\n\n\r\r\nfive\r';
  const locate = createLocator(text);
  let compared = 0;
  for (let index = 0; index <= text.length; index += 1) {
    /*
     * One offset is excluded, and deliberately: the \n of a \r\n pair. The
     * walk answered "column 0" there, which is not a position in any line,
     * and no pattern can begin a match on a line ending -- so it is not an
     * offset a finding can ever carry.
     */
    if (text[index] === '\n' && text[index - 1] === '\r') continue;
    assert.deepStrictEqual(locate(index), walk(text, index), `offset ${index}`);
    compared += 1;
  }
  assert(compared >= text.length - 3, 'every other offset is compared');
}

/* ---- A large file with nothing in it stays cheap --------------------- */

/*
 * Not a timing assertion -- those flake -- but the property that makes the
 * breadth affordable: a megabyte of ordinary text containing no keyword yields
 * nothing, and is refused by no ceiling.
 */
{
  const text = 'the quick brown fox jumps over the lazy dog\n'.repeat(20_000);
  const result = detectInText({ text, path: 'big.txt' });
  assert.strictEqual(result.scanned, true);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.candidates.length, 0);
}

console.log(`exposure rules tests passed (${EXPOSURE_RULES.length} text rules, ${PATH_RULES.length} path rules)`);
