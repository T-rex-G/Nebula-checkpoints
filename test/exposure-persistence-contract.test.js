'use strict';

/*
 * The schema half of exposure storage, plus the structural half the schema
 * cannot hold.
 *
 * `test/exposure-store.test.js` runs the store against a real server and is
 * where the behaviour is proved. This is the gate that runs everywhere: it
 * asserts the migration says what the store depends on, and that the store's
 * own queries carry the boundaries a reviewer would otherwise have to check by
 * eye every time this file grows.
 *
 * The privacy claim here is deliberately not "there is no column called
 * secret". A column name proves nothing. What proves something is a column
 * typed as an integer array, a column constrained to 64 hex characters, and a
 * placeholder matched against a generated-label pattern that a partially
 * redacted credential cannot satisfy.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  COVERAGE, DISPOSITIONS, EXPOSURE_CONFIG_VERSION, SCAN_STATES, SKIPPED_REASONS, TERMINAL_STATES
} = require('../src/exposure-store');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '022_exposure_scans.sql'), 'utf8'
);
const storeSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'exposure-store.js'), 'utf8'
);

/* ---- The tables exist and the store's vocabulary is the schema's ------- */

for (const table of ['nv_exposure_scans', 'nv_exposure_findings', 'nv_exposure_observations']) {
  assert(sql.includes(`CREATE TABLE ${table}`), `missing ${table}`);
}

/*
 * Every state, coverage, reason and disposition the store can write must be one
 * the schema admits, and vice versa. A value in one list and not the other is
 * either a write that fails at run time or a state nothing can produce.
 */
function checkedValues(pattern) {
  const source = pattern.source.includes('skipped_reason')
    ? fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '025_exposure_identity_provenance.sql'), 'utf8')
    : sql;
  const match = source.match(pattern);
  assert(match, `missing constraint: ${pattern}`);
  return (match[1].match(/'[^']+'/g) || []).map(value => value.slice(1, -1)).sort();
}

assert.deepStrictEqual(checkedValues(/CHECK \(state IN \(([^)]+)\)\)/), [...SCAN_STATES].sort());
assert.deepStrictEqual(checkedValues(/CHECK \(coverage IN \(([^)]+)\)\)/), [...COVERAGE].sort());
assert.deepStrictEqual(
  checkedValues(/skipped_reason IN \(([\s\S]*?)\)\s*\)/), [...SKIPPED_REASONS].sort()
);
assert.deepStrictEqual(
  checkedValues(/CHECK \(disposition IN \(([^)]+)\)\)/), [...DISPOSITIONS].sort()
);
for (const state of TERMINAL_STATES) {
  assert(SCAN_STATES.includes(state), `a terminal state must be a state: ${state}`);
}
assert(Number.isInteger(EXPOSURE_CONFIG_VERSION) && EXPOSURE_CONFIG_VERSION >= 1);

/* ---- The columns that could carry a credential cannot ------------------ */

/*
 * Locations as integer arrays. This is the strongest statement in the schema:
 * a caller that tried to store a source line alongside a finding would be
 * writing text into an integer column, and PostgreSQL refuses before any
 * application logic is consulted.
 */
assert.match(sql, /occurrence_lines integer\[\] NOT NULL/, 'locations must be integers, not a structure that can hold text');
assert.match(sql, /occurrence_columns integer\[\] NOT NULL/);
assert.match(
  sql, /CHECK \(array_length\(occurrence_lines, 1\) BETWEEN 1 AND 20\)/,
  'and bounded, or one finding can carry a file-sized list'
);
assert.match(
  sql, /CHECK \(array_length\(occurrence_columns, 1\) = array_length\(occurrence_lines, 1\)\)/,
  'a column without its line is a location nobody can read'
);
assert.match(
  sql, /CHECK \(truncated = \(occurrence_count > array_length\(occurrence_lines, 1\)\)\)/,
  'the truncation flag must be the truth about the list rather than a caller assertion'
);

/*
 * The placeholder pattern. A partial redaction -- the usual instinct -- would
 * publish the prefix of a token, which is the part identifying the provider
 * and often the account. The pattern admits a generated label and nothing
 * else, so that mistake is a failed insert.
 */
assert.match(
  sql, /placeholder text NOT NULL CHECK \(placeholder ~ '\^<\[a-z-\]\+ #\[0-9\]\+>\$'\)/,
  'the placeholder must be constrained to a generated label'
);
for (const attempt of ['<ghp_AAAABBBB...>', '<redacted ghp_AA>', 'ghp_AAAA', '<github-token: ghp_AA>']) {
  assert.strictEqual(
    /^<[a-z-]+ #[0-9]+>$/.test(attempt), false,
    `the pattern must refuse a partial redaction: ${attempt}`
  );
}
assert(/^<[a-z-]+ #[0-9]+>$/.test('<github-token #1>'), 'and admit the generated form');

/* Digests are digests. */
assert.match(sql, /fingerprint text NOT NULL CHECK \(fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/);
assert.match(sql, /identity_key text NOT NULL CHECK \(identity_key ~ '\^\[0-9a-f\]\{64\}\$'\)/);
assert.match(sql, /commit_sha text NOT NULL CHECK \(commit_sha ~ '\^\[0-9a-f\]\{40\}\$'\)/);
assert.match(
  sql, /verification_subject_digest text NULL\s*\n?\s*CHECK \(verification_subject_digest IS NULL OR verification_subject_digest ~ '\^\[0-9a-f\]\{32\}\$'\)/,
  'a provider identity is stored as a digest, never as a login'
);
assert.match(
  sql, /verification_reason text NULL CHECK \(verification_reason IS NULL OR verification_reason ~ '\^\[a-z\]\[a-z0-9-\]\{2,63\}\$'\)/,
  'a reason is a bounded code, not a message a provider wrote'
);

/*
 * Every text column is bounded or shape-constrained. An unbounded text column
 * is somewhere a file could be stored, whatever it is named.
 */
{
  const columns = [...sql.matchAll(/^\s{2}(\w+) text (?:NOT NULL|NULL)([^\n]*(?:\n\s{4}[^\n]*)*)/gm)];
  assert(columns.length >= 12, `the column scan must find columns: ${columns.length}`);
  const unbounded = columns
    .filter(([, , rest]) => !/CHECK/.test(rest))
    .map(([, name]) => name);
  assert.deepStrictEqual(
    unbounded, [],
    `every text column must be bounded or shape-constrained: ${unbounded.join(', ')}`
  );
}

/* Nothing here stores bytes. A bytea column would be a file. */
assert.strictEqual(/\bbytea\b/i.test(sql), false, 'no column may hold binary content');
assert.strictEqual(/\bjsonb?\b/i.test(sql), false, 'no column may hold free-form structured content');

/* ---- The properties the store hands to the database -------------------- */

/* Idempotency is a unique index, not a read-then-write. */
assert.match(
  sql, /CREATE UNIQUE INDEX nv_exposure_scans_idempotency_idx\s*\n\s*ON nv_exposure_scans \(provider, authority, owner_login, repo_name, idempotency_key\)/,
  'two requests carrying one key must not both create a scan'
);

/* One live scan per repository is a partial unique index. */
assert.match(
  sql, /CREATE UNIQUE INDEX nv_exposure_scans_active_idx\s*\n\s*ON nv_exposure_scans \(provider, authority, owner_login, repo_name\)\s*\n\s*WHERE state IN \('queued', 'running'\)/,
  'execution ownership must be enforced by the database, not by a process remembering'
);

/* The finish time and the terminal state cannot disagree. */
assert.match(
  sql, /CHECK \(\(state IN \('complete', 'partial', 'failed', 'canceled'\)\) = \(finished_at IS NOT NULL\)\)/
);
/* Complete coverage is only available to a scan that completed. */
assert.match(sql, /CHECK \(coverage <> 'complete' OR state = 'complete'\)/);
assert.match(sql, /CHECK \(state <> 'partial' OR coverage = 'partial'\)/);

/* Only a person's decision names a person. */
assert.match(
  sql, /CHECK \(\(disposition = 'accepted-risk'\) = \(disposition_by IS NOT NULL\)\)/,
  'a provider refusal and a tree comparison have no actor; recording one would invent an approval'
);

/* An observation belongs to one scan and is written once. */
assert.match(sql, /PRIMARY KEY \(scan_id, fingerprint\)/);
assert.match(
  sql, /scan_id uuid NOT NULL REFERENCES nv_exposure_scans \(scan_id\) ON DELETE CASCADE/,
  'retention removes a measurement with its scan'
);
/* A finding is keyed by scope as well as fingerprint, so the boundary survives
   one of its two holders being forgotten. */
assert.match(sql, /PRIMARY KEY \(provider, authority, owner_login, repo_name, fingerprint\)/);

/* ---- What the store must never do ------------------------------------- */

/*
 * Observations are append-only. Nothing enforces that in the schema -- a
 * trigger would be heavier than the property is worth -- so it is enforced
 * here, against the store's own source.
 */
assert.strictEqual(
  /UPDATE nv_exposure_observations/.test(storeSource), false,
  'an observation is a measurement; editing one loses the only record of what was true at a commit'
);
assert.strictEqual(
  /DELETE FROM nv_exposure_observations/.test(storeSource), false,
  'observations leave with their scan, by cascade, and not otherwise'
);

/*
 * Every row that leaves the store is built field by field. Spreading a row
 * would publish whatever the schema grows next, which is exactly the leak this
 * whole design is about.
 */
assert.strictEqual(
  /\.\.\.row\b/.test(storeSource), false,
  'a serializer must name its columns: spreading a row publishes the next one added'
);

/*
 * And every statement that reads or writes a scan or a finding carries the
 * identity boundary, the claim token, or is one of the three that deliberately
 * does not -- named here so that adding a fourth is a decision rather than an
 * omission.
 *
 * The count is asserted too. A scan of a source file that found nothing would
 * pass every assertion in this block.
 */
{
  const statements = [...storeSource.matchAll(/`([^`]*nv_exposure[^`]*)`/g)].map(match => match[1]);
  assert(statements.length >= 12, `the statement scan must find statements: ${statements.length}`);

  const unscoped = [];
  for (const statement of statements) {
    const normalized = statement.replace(/\s+/g, ' ').trim();
    const touchesOwned = /nv_exposure_scans|nv_exposure_findings/.test(normalized);
    if (!touchesOwned) continue;

    const carriesIdentity = /identity_key/.test(normalized);
    const carriesClaim = /claim_owner=\$/.test(normalized);
    /*
     * The three exceptions, each for a stated reason.
     *
     * The claim query picks up work for whoever asks and cannot be scoped to
     * an identity: a worker is not a tenant. The parent lookup runs inside
     * `concludeRemovedFromTree`, whose first statement already matched the
     * scan on its identity, and re-checking would be re-checking. The sweep is
     * retention, which is time-scoped by design and must not depend on anybody
     * being signed in.
     */
    const declaredException = /FOR UPDATE SKIP LOCKED/.test(normalized)
      || /SELECT \* FROM nv_exposure_scans WHERE scan_id=\$1$/.test(normalized)
      || /DELETE FROM nv_exposure_scans WHERE ctid IN/.test(normalized)
      || /UPDATE nv_exposure_findings AS finding/.test(normalized)
      /*
       * The disposition move inside `recordVerification`. Its transaction's
       * first statement selects the finding FOR UPDATE on the identity, so
       * this statement runs only for a row already proven to belong to the
       * caller -- and repeating the identity here would be re-checking a lock
       * we are holding. Listed rather than pattern-matched so a fifth
       * exception has to be argued for.
       */
      || /UPDATE nv_exposure_findings SET disposition='credential-rejected'/.test(normalized);

    if (!carriesIdentity && !carriesClaim && !declaredException) {
      unscoped.push(normalized.slice(0, 90));
    }
  }
  assert.deepStrictEqual(
    unscoped, [],
    `a statement reaches a scan or finding without an identity, a claim, or a stated exception:\n${unscoped.join('\n')}`
  );
}

/* ---- Verification attempts are append-only, like observations --------- */

/*
 * A provider's answer is evidence, and the sequence of answers is what proves
 * a revocation worked. Editing one would lose the only record of what was true
 * at a moment, so the store never updates or deletes them; they leave with the
 * finding, by cascade.
 */
{
  const attempts = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '023_exposure_verifications.sql'), 'utf8'
  );
  assert(attempts.includes('CREATE TABLE nv_exposure_verifications'), 'missing nv_exposure_verifications');
  assert.match(
    attempts, /ON DELETE CASCADE/,
    'attempts leave with the finding they are about'
  );
  assert.match(
    attempts, /CHECK \(state IN \('verified', 'rejected', 'unverifiable'\)\)/,
    'the three-state vocabulary is the schema\'s, not just the application\'s'
  );
  assert.match(
    attempts, /CHECK \(subject_digest IS NULL OR state = 'verified'\)/,
    'only a verdict may name a provider account: an unverifiable attempt reached none'
  );
  assert.match(
    attempts, /CHECK \(freshness_deadline > observed_at\)/,
    'an answer that never goes stale would read as current forever'
  );
  assert.match(
    attempts, /subject_digest text NULL CHECK \(subject_digest IS NULL OR subject_digest ~ '\^\[0-9a-f\]\{32\}\$'\)/,
    'the provider account is stored as a digest, never as a login'
  );
  assert.strictEqual(
    /\bbytea\b|\bjsonb?\b/i.test(attempts), false,
    'no column may hold a response body'
  );

  assert.strictEqual(
    /UPDATE nv_exposure_verifications/.test(storeSource), false,
    'an attempt is evidence; editing one loses what was true at that moment'
  );
  assert.strictEqual(
    /DELETE FROM nv_exposure_verifications/.test(storeSource), false,
    'attempts leave with their finding, by cascade, and not otherwise'
  );
}

/* ---- Readability probes are append-only too ---------------------------- */

/*
 * What a project allowed the anonymous role to read, recorded the same way and
 * for the same reason. The one thing this table must never grow is a column
 * that could hold a row: the whole point of the probe is that "a row came
 * back" is the entire finding, and storing the row would turn a security check
 * into a second copy of somebody's data.
 */
{
  const probes = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '024_exposure_readability_probes.sql'), 'utf8'
  );
  assert(probes.includes('CREATE TABLE nv_exposure_readability_probes'), 'missing nv_exposure_readability_probes');
  assert.match(probes, /ON DELETE CASCADE/, 'probes leave with the finding they are about');
  assert.match(
    probes, /CHECK \(state IN \('readable', 'denied', 'unverifiable'\)\)/,
    "the three-state vocabulary is the schema's, not just the application's"
  );
  assert.match(
    probes, /row_count integer NOT NULL DEFAULT 0 CHECK \(row_count BETWEEN 0 AND 1\)/,
    'one row is the whole question, and the column will not hold more'
  );
  assert.match(
    probes, /CHECK \(\(row_count > 0\) = \(state = 'readable'\)\)/,
    'a result claiming to have seen a row it did not count is a result nobody measured'
  );
  assert.match(
    probes, /project_ref text NULL CHECK \(project_ref IS NULL OR project_ref ~ '\^\[a-z\]\{20\}\$'\)/,
    'the only shape this server turns into a host is the one the column admits'
  );
  assert.match(
    probes, /relation text NULL CHECK \(relation IS NULL OR relation ~ '\^\[a-z_\]\[a-z0-9_\]\{0,62\}\$'\)/,
    'a relation name cannot hold a credential if the column will not store one'
  );
  assert.match(
    probes, /projection text NULL\s*\n\s*CHECK \(projection IS NULL OR projection ~ /,
    'the projection is bounded by the same kind of pattern, count and order included'
  );
  assert.match(probes, /CHECK \(freshness_deadline > observed_at\)/, 'an answer that never goes stale would read as current forever');
  assert.strictEqual(
    /\bbytea\b|\bjsonb?\b/i.test(probes), false,
    'no column may hold a response body'
  );

  assert.strictEqual(
    /UPDATE nv_exposure_readability_probes/.test(storeSource), false,
    'a probe is evidence; editing one loses what was true at that moment'
  );
  assert.strictEqual(
    /DELETE FROM nv_exposure_readability_probes/.test(storeSource), false,
    'probes leave with their finding, by cascade, and not otherwise'
  );

  /*
   * And the store does not infer a disposition from a probe. A readable table
   * is not the credential being live and a denied one is not the exposure
   * ending, so a probe that moved a finding would be inventing a fact.
   */
  const probeMethod = storeSource.slice(
    storeSource.indexOf('async recordReadabilityProbe('),
    storeSource.indexOf('async listReadabilityProbes(')
  );
  assert(probeMethod.length > 400, 'the probe method slice must cover the method');
  assert.strictEqual(
    /UPDATE nv_exposure_findings/.test(probeMethod), false,
    'what the anonymous role can reach says nothing about whether this key still works'
  );
}

/*
 * The purge path has to know about these tables. A privacy promise that
 * forgets a table is a privacy promise that does not hold, and the existing
 * purge is the only place in the server that makes it -- so this asserts the
 * extension rather than trusting that somebody remembered.
 */
{
  const privacySource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'alpha-privacy-store.js'), 'utf8'
  );
  for (const table of ['nv_exposure_scans', 'nv_exposure_findings']) {
    assert(
      new RegExp(`DELETE FROM ${table} WHERE identity_key=ANY`).test(privacySource),
      `the tester purge must delete ${table} by identity key, like every other table it owns`
    );
  }
  /*
   * Observations are not listed, and that is correct rather than an omission:
   * they cascade from the scan. Asserted so that somebody adding a third
   * DELETE has to think about why.
   */
  assert.strictEqual(
    /DELETE FROM nv_exposure_observations/.test(privacySource), false,
    'observations cascade from their scan; a second delete would be a second owner of the same rows'
  );
}

console.log('exposure persistence contract tests passed');
