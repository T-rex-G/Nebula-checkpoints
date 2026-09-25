'use strict';

/*
 * What makes two sightings of a credential the same finding.
 *
 * Identity has to survive the things that change for reasons unrelated to the
 * exposure -- a file reformatted, an import added above, a Windows checkout --
 * and it has to separate the things that are genuinely different, including
 * two credentials that look alike at a glance and the same credential in two
 * repositories. Get that wrong in either direction and the product lies: a
 * finding that changes identity on every commit can never be marked triaged,
 * and one that collapses two credentials lets a reader revoke one and believe
 * they are done.
 *
 * The fingerprint is keyed, and the key version travels with it. Rotating a
 * key or changing a rule is allowed; silently reporting every prior finding as
 * resolved because their fingerprints no longer match is not, and the
 * reconciliation here refuses rather than diffs when the versions differ.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');
const { adapterForCandidate } = require('../src/credential-verification');
const { detectInText } = require('../src/exposure-detection');
const {
  FINGERPRINT_KEY_VERSION,
  buildFindings,
  fingerprintFor,
  reconcileFindings,
  revealForVerification
} = require('../src/exposure-findings');

const TOKEN_A = `gh${'p'}_${'A'.repeat(36)}`;
const TOKEN_B = `gh${'p'}_${'A'.repeat(35)}B`;
const SLACK = `xo${'xb'}-${'C'.repeat(24)}`;

const MASTER = 'q'.repeat(64);
const fingerprintKey = deriveKey(MASTER, KEY_PURPOSES.EXPOSURE_FINDING_FINGERPRINT);
const otherKey = deriveKey('r'.repeat(64), KEY_PURPOSES.EXPOSURE_FINDING_FINGERPRINT);

const scope = Object.freeze({
  provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo'
});
const COMMIT = 'a'.repeat(40);

function print(overrides = {}) {
  return fingerprintFor({
    hmacKey: 'hmacKey' in overrides ? overrides.hmacKey : fingerprintKey,
    keyVersion: overrides.keyVersion || FINGERPRINT_KEY_VERSION,
    scope: overrides.scope || scope,
    path: 'path' in overrides ? overrides.path : 'app/config.js',
    rule: overrides.rule || 'github-token',
    secret: 'secret' in overrides ? overrides.secret : TOKEN_A,
    rulesVersion: overrides.rulesVersion,
    engineVersion: overrides.engineVersion
  });
}

function findingsFor(text, overrides = {}) {
  return buildFindings({
    detection: detectInText({ text, path: overrides.path || 'app/config.js' }),
    path: overrides.path || 'app/config.js',
    scope: overrides.scope || scope,
    commit: overrides.commit || COMMIT,
    hmacKey: overrides.hmacKey || fingerprintKey
  });
}

/* ---- What identity is, and is not -------------------------------------- */

/* Stable across the things that are not the exposure. */
{
  assert.strictEqual(print(), print(), 'identical inputs produce an identical fingerprint');
  assert.match(print(), /^[0-9a-f]{64}$/);
}

/* Different across the things that are. */
{
  const base = print();
  const different = {
    'the credential bytes': print({ secret: SLACK }),
    'a credential differing in its last byte': print({ secret: TOKEN_B }),
    'the rule': print({ rule: 'slack-token' }),
    'the path': print({ path: 'app/other.js' }),
    'the provider': print({ scope: { ...scope, provider: 'gitea' } }),
    'the authority': print({ scope: { ...scope, authority: 'gitea.example' } }),
    'the owner': print({ scope: { ...scope, owner: 'Other' } }),
    'the repository': print({ scope: { ...scope, repo: 'Other' } }),
    'the key': print({ hmacKey: otherKey }),
    'the key version': print({ keyVersion: FINGERPRINT_KEY_VERSION + 1 }),
    'the rules version': print({ rulesVersion: 99 }),
    'the engine version': print({ engineVersion: 99 })
  };
  for (const [label, value] of Object.entries(different)) {
    assert.notStrictEqual(value, base, `${label} must change identity`);
  }
  assert.strictEqual(new Set(Object.values(different)).size, Object.keys(different).length,
    'and each must change it differently');
}

/*
 * Two credentials sharing a visible prefix are two credentials. A prefix is
 * what a redacted display shows, and identity that stopped at the prefix would
 * merge every token issued to the same account.
 */
{
  assert.strictEqual(TOKEN_A.slice(0, 30), TOKEN_B.slice(0, 30), 'the fixtures do share a prefix');
  assert.notStrictEqual(print({ secret: TOKEN_A }), print({ secret: TOKEN_B }));
}

/*
 * Git paths are bytes. `README` and `readme` are two files in a Git tree even
 * where a filesystem disagrees, and `é` written as one code point is a
 * different path from `é` written as two. Display normalisation is a rendering
 * decision and must never reach identity.
 */
{
  assert.notStrictEqual(print({ path: 'README.md' }), print({ path: 'readme.md' }));
  const composed = 'app/café.js';
  const decomposed = 'app/café.js';
  assert.notStrictEqual(composed, decomposed);
  assert.strictEqual(composed.normalize('NFC'), decomposed.normalize('NFC'), 'the fixtures differ only in form');
  assert.notStrictEqual(
    print({ path: composed }), print({ path: decomposed }),
    'two distinct Git paths must not collapse into one finding'
  );
}

/*
 * Length-prefixed parts, so no rearrangement of one finding's fields can
 * produce another's message.
 *
 * The fixtures have to contain the separator to test this, which is the point
 * the first version of this check missed: two fields that merely shift a
 * boundary still differ once joined, because the separator lands in a
 * different place. A field that *contains* the separator is what collides --
 * a repository literally named with a pipe, or a path ending in one, is
 * unusual but a Git tree permits it and identity must not depend on nobody
 * trying.
 */
{
  assert.notStrictEqual(
    print({ scope: { ...scope, repo: 'Demo|x' }, path: 'y' }),
    print({ scope: { ...scope, repo: 'Demo' }, path: 'x|y' }),
    'a repository name containing the separator must not forge part of a path'
  );
  assert.notStrictEqual(
    print({ path: 'a|b', rule: 'c' }),
    print({ path: 'a', rule: 'b|c' }),
    'and a path containing it must not forge part of a rule'
  );
  assert.notStrictEqual(
    print({ scope: { ...scope, owner: 'Acme|Demo', repo: 'x' } }),
    print({ scope: { ...scope, owner: 'Acme', repo: 'Demo|x' } }),
    'nor an owner part of a repository'
  );
}

/* Keyed, and not merely hashed. An unkeyed digest of a credential is offline
   guessable at the speed of the guesser's hardware, and the whole population
   of a provider's token format is small. */
{
  assert.notStrictEqual(
    print(), crypto.createHash('sha256').update(TOKEN_A, 'utf8').digest('hex'),
    'a fingerprint must not be a plain digest of the credential'
  );
  assert.notStrictEqual(print({ hmacKey: otherKey }), print());
  assert.throws(() => print({ hmacKey: undefined }), /key/i, 'and there is no unkeyed path');
}

/* ---- Findings ---------------------------------------------------------- */

{
  const findings = findingsFor(`a=${TOKEN_A}\nb=${SLACK}\nc=${TOKEN_A}\n`);
  assert.strictEqual(findings.findings.length, 2, 'one finding per credential, however many occurrences');
  assert(Object.isFrozen(findings.findings));

  const [github] = findings.findings.filter(item => item.rule === 'github-token');
  assert.deepStrictEqual(Object.keys(github).sort(), [
    'commit', 'decodedFrom', 'engineVersion', 'fingerprint', 'fingerprintKeyVersion', 'occurrenceCount',
    'occurrences', 'path', 'placeholder', 'rule', 'rulesVersion', 'scope', 'truncated'
  ], 'the finding shape is closed: a field added here has to be considered for leakage');
  /* Considered: it is `base64` or nothing, so it cannot carry what was decoded. */
  assert.strictEqual(github.decodedFrom, null);
  assert(Object.isFrozen(github));
  assert.strictEqual(github.occurrenceCount, 2);
  assert.deepStrictEqual(github.occurrences.map(item => item.line), [1, 3]);
  assert.strictEqual(github.fingerprintKeyVersion, FINGERPRINT_KEY_VERSION);
  assert.deepStrictEqual(github.scope, scope);

  /* The fingerprint is the one the standalone function computes, so nothing
     downstream has a second definition of identity. */
  assert.strictEqual(github.fingerprint, print({ secret: TOKEN_A }));

  /* No credential in the findings, at any slice length worth having. */
  const serialized = JSON.stringify(findings.findings);
  for (const secret of [TOKEN_A, SLACK]) {
    for (const length of [8, 16, 24, secret.length]) {
      assert.strictEqual(serialized.includes(secret.slice(0, length)), false, `${length} bytes leaked`);
    }
  }
}

/* The same credential in two repositories is two findings, and neither can be
   reached from the other's record. */
{
  const here = findingsFor(`a=${TOKEN_A}\n`);
  const there = findingsFor(`a=${TOKEN_A}\n`, { scope: { ...scope, repo: 'Elsewhere' } });
  assert.notStrictEqual(here.findings[0].fingerprint, there.findings[0].fingerprint);
}

/* A line shift does not change identity; it changes a location. */
{
  const before = findingsFor(`a=${TOKEN_A}\n`);
  const after = findingsFor(`// added\n// added\na=${TOKEN_A}\n`);
  assert.strictEqual(before.findings[0].fingerprint, after.findings[0].fingerprint);
  assert.notDeepStrictEqual(before.findings[0].occurrences, after.findings[0].occurrences);
}

/* ---- The bytes and their one door -------------------------------------- */

/*
 * A probe is the only thing that ever holds the credential, and it is built so
 * that the accident is impossible rather than forbidden: serialising it,
 * printing it, interpolating it into a string or inspecting it all produce a
 * redaction. `revealForVerification` is the single deliberate exit.
 */
{
  const { probes, findings } = findingsFor(`a=${TOKEN_A}\n`);
  assert.strictEqual(probes.length, 1);
  const [probe] = probes;

  assert.strictEqual(probe.fingerprint, findings[0].fingerprint, 'a probe names the finding it belongs to');
  /*
   * Two separate claims, and they are worth separating because they are held
   * by different mechanisms.
   *
   * The barrier is the private field: a `#field` is not an own property, so
   * `JSON.stringify` and `util.inspect` cannot see it even with `showHidden`,
   * and no amount of nosiness changes that. Nothing in the class can leak the
   * bytes by omission -- only by actively handing them out, which is what a
   * `toJSON` returning them would be.
   */
  const surfaces = {
    'JSON.stringify': JSON.stringify(probe),
    'nested JSON.stringify': JSON.stringify({ nested: { probe } }),
    'String()': String(probe.secret),
    'interpolation': `${probe.secret}`,
    'util.inspect': require('util').inspect(probe),
    'a nosy util.inspect': require('util').inspect(probe, { depth: 10, showHidden: true }),
    /*
     * Called directly, which is the one surface `Symbol.toPrimitive` does not
     * cover: it wins over `toString` for `String()` and for interpolation, so
     * `toString` exists for the caller who reaches for it by name.
     */
    'toString()': probe.secret.toString(),
    'util.format': require('util').format('%s', probe.secret)
  };
  for (const [label, rendered] of Object.entries(surfaces)) {
    assert.strictEqual(rendered.includes(TOKEN_A), false, `${label} reached the credential`);
    assert.strictEqual(rendered.includes(TOKEN_A.slice(4, 20)), false, `${label} reached part of it`);
  }

  /*
   * The second claim is legibility, which is what the explicit `toJSON`,
   * `toString` and inspect hooks are for. Without them every surface above
   * renders an empty object, which is safe and tells a reader nothing -- they
   * see `CandidateSecret {}` in a log and cannot tell whether the value was
   * absent, empty or withheld. Saying so is the difference between a redaction
   * and a mystery, so the word is asserted rather than left to taste.
   */
  for (const [label, rendered] of Object.entries(surfaces)) {
    assert(rendered.includes('[redacted]'), `${label} must say it withheld something: ${rendered}`);
  }

  /*
   * And the enumerating accidents, which the hooks above do not cover at all.
   * A spread while building a record, or an `Object.values` in a serializer,
   * walks own properties and never consults `toJSON` -- so the bytes have to
   * not be an own property in the first place. This is what makes the private
   * field load-bearing rather than stylistic.
   */
  assert.deepStrictEqual(Object.keys(probe.secret), [], 'the wrapper has no own enumerable property');
  assert.deepStrictEqual(Object.getOwnPropertyNames(probe.secret), []);
  for (const [label, rendered] of Object.entries({
    'a spread': JSON.stringify({ ...probe.secret }),
    'Object.values': JSON.stringify(Object.values(probe.secret)),
    'Object.entries': JSON.stringify(Object.entries(probe.secret)),
    'a spread of the probe': JSON.stringify({ ...probe })
  })) {
    assert.strictEqual(rendered.includes(TOKEN_A), false, `${label} reached the credential`);
    assert.strictEqual(rendered.includes(TOKEN_A.slice(4, 20)), false, `${label} reached part of it`);
  }

  /* The deliberate exit yields exactly the shape the verifier consumes, which
     is checked by handing it to the verifier's own classifier rather than by
     comparing key names. */
  const candidate = revealForVerification(probe);
  assert.strictEqual(candidate.secret, TOKEN_A);
  assert.strictEqual(candidate.rule, 'github-token');
  assert.strictEqual(candidate.fingerprint, findings[0].fingerprint);
  assert.deepStrictEqual(candidate.scope, scope);
  assert.strictEqual(candidate.commit, COMMIT);
  assert.strictEqual(
    (adapterForCandidate(candidate) || {}).id, 'github-user-token',
    'the verifier accepts it without a translation layer in between'
  );

  /* And the revealed candidate is not the probe: nothing that was handed out
     can be mutated into the stored finding. */
  assert.notStrictEqual(candidate, probe);
  assert(Object.isFrozen(findings[0]));

  /*
   * The exit takes a real probe and nothing else. This is what keeps the
   * wrapper from becoming optional: a refactor that started passing plain
   * objects through here would drop every protection above without changing a
   * single assertion about leakage, because a plain string secret has nothing
   * to leak *from*.
   */
  for (const fake of [
    { rule: 'github-token', secret: TOKEN_A, fingerprint: 'x', scope, commit: COMMIT },
    { rule: 'github-token', secret: { reveal: () => TOKEN_A } },
    { rule: 'github-token' },
    null,
    undefined,
    'a string'
  ]) {
    assert.throws(
      () => revealForVerification(fake),
      /probe/i,
      `a fabricated probe must be refused: ${JSON.stringify(fake)}`
    );
  }
}

/* An unsupported class still produces a finding, and still produces a probe:
   deciding not to ask is the verifier's judgement to make, not detection's. */
{
  const key = `-----BEGIN ${'PRIVATE'} KEY-----`;
  const { findings, probes } = findingsFor(`${key}\n`);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].rule, 'private-key');
  assert.strictEqual(probes.length, 1);
  assert.strictEqual(adapterForCandidate(revealForVerification(probes[0])), null);
}

/* ---- Reconciliation ---------------------------------------------------- */

/*
 * The failure this guards against is the quiet one. Rotate the fingerprint
 * key, or edit a rule, and every fingerprint changes: a diff would then show
 * every previous finding as resolved and every current one as new, and a
 * reader would see a wall of green that means nothing happened.
 */
{
  const previous = findingsFor(`a=${TOKEN_A}\nb=${SLACK}\n`).findings;
  const current = findingsFor(`a=${TOKEN_A}\nc=${TOKEN_B}\n`).findings;

  const diff = reconcileFindings({ previous, current });
  assert.strictEqual(diff.comparable, true);
  assert.deepStrictEqual(
    diff.unchanged.map(item => item.rule), ['github-token'], 'the credential still there'
  );
  assert.deepStrictEqual(diff.resolved.map(item => item.rule), ['slack-token']);
  assert.deepStrictEqual(diff.appeared.map(item => item.rule), ['github-token']);

  const rotated = findingsFor(`a=${TOKEN_A}\n`, { hmacKey: otherKey }).findings;
  const refused = reconcileFindings({
    previous,
    current: rotated.map(item => ({ ...item, fingerprintKeyVersion: FINGERPRINT_KEY_VERSION + 1 }))
  });
  assert.strictEqual(refused.comparable, false);
  assert.strictEqual(refused.reason, 'fingerprint-key-version-changed');
  assert.deepStrictEqual(refused.resolved, [], 'a refusal reports nothing resolved');
  assert.deepStrictEqual(refused.appeared, []);

  for (const [field, reason] of [
    ['rulesVersion', 'rules-version-changed'],
    ['engineVersion', 'engine-version-changed']
  ]) {
    const moved = reconcileFindings({
      previous,
      current: current.map(item => ({ ...item, [field]: item[field] + 1 }))
    });
    assert.strictEqual(moved.comparable, false, field);
    assert.strictEqual(moved.reason, reason);
    assert.deepStrictEqual(moved.resolved, [], `${field}: nothing may be called resolved`);
  }

  /* An empty previous set is a first scan, not a version change. */
  const first = reconcileFindings({ previous: [], current });
  assert.strictEqual(first.comparable, true);
  assert.strictEqual(first.appeared.length, current.length);
  assert.deepStrictEqual(first.resolved, []);

  /* A mixed previous set -- findings written under two key versions -- is not
     comparable either. Picking the majority would resolve the minority. */
  const mixed = reconcileFindings({
    previous: [previous[0], { ...previous[1], fingerprintKeyVersion: FINGERPRINT_KEY_VERSION + 1 }],
    current
  });
  assert.strictEqual(mixed.comparable, false);
  assert.strictEqual(mixed.reason, 'fingerprint-key-version-changed');
}

/* ---- The version is stated, not inferred ------------------------------- */

{
  assert(Number.isInteger(FINGERPRINT_KEY_VERSION) && FINGERPRINT_KEY_VERSION >= 1);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-findings.js'), 'utf8');
  for (const forbidden of [/\.normalize\(/, /\.toLowerCase\(\)/, /\.toUpperCase\(\)/]) {
    assert.strictEqual(
      forbidden.test(source), false,
      `identity must not fold anything: ${forbidden}`
    );
  }
}

console.log('exposure findings tests passed');
