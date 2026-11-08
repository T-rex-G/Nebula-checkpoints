'use strict';

/*
 * The schema half of triage, clocks and time to fix, and the structural half
 * the schema cannot hold, asserted the way the audit history's are:
 *
 *   - no column added can take free text: every text column is an
 *     enumeration, a pattern, or a bounded scope name, and there is no json;
 *   - the migration only adds;
 *   - every statement the triage store runs names the repository it is
 *     about, and none spreads a row or selects everything;
 *   - the account purge removes what carries a tester's identity.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'db', 'migrations', '030_code_audit_triage.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const { SHAPE } = require('../apps/api/src/modules/uranus/index.ts').auditTriage;

const TABLES = ['nv_code_audit_triage', 'nv_code_audit_triage_events', 'nv_code_audit_resolutions'];
for (const table of TABLES) assert(sql.includes(`CREATE TABLE ${table} (`), `missing ${table}`);

/* ---- Only additions ---------------------------------------------------------- */
assert(!/\b(DROP|TRUNCATE|DELETE|UPDATE|RENAME|ALTER\s+COLUMN)\b/i.test(code), 'the migration adds; it never drops, rewrites or renames');
assert(!/ADD COLUMN [a-z_]+ [a-z]+(?:\[\])? NOT NULL/i.test(code), 'a column added to a table with rows is nullable');
assert(!/\bjsonb?\b/i.test(code), 'no json column: a serializer could widen it without a migration');

/* ---- No column that free text fits in ---------------------------------------- */
{
  const LENGTH_ONLY = new Set(['provider', 'authority', 'owner_login', 'repo_name', 'ref_name']);
  const definitions = [];
  for (const table of TABLES) {
    const start = sql.indexOf(`CREATE TABLE ${table} (`);
    const body = sql.slice(start, sql.indexOf('\n);', start));
    const lines = body.split('\n');
    lines.forEach((line, index) => {
      const column = /^\s{2}([a-z_]+) (text(?:\[\])?)\b(.*)$/.exec(line);
      if (column) definitions.push({ table, name: column[1], text: [line, ...lines.slice(index + 1, index + 4)].join('\n').split(/\n\s{2}[a-z_]+ (?:text|uuid|integer|smallint|boolean|timestamptz)/)[0] });
    });
  }
  for (const match of sql.matchAll(/ADD COLUMN ([a-z_]+) text NULL([^\n]*)/g)) definitions.push({ table: 'altered', name: match[1], text: match[2] });
  assert(definitions.length >= 20, `the column scan must find the text columns: ${definitions.length}`);
  for (const { table, name, text } of definitions) {
    if (LENGTH_ONLY.has(name)) {
      assert(/length\([a-z_]+\) BETWEEN 1 AND (40|255)/.test(text), `${table}.${name} must be bounded`);
      continue;
    }
    assert(/ IN \(|~ '\^/.test(text), `${table}.${name} must be an enumeration or match a pattern, not free text`);
  }
  /* There is no note: a reason is chosen, never written. */
  assert(!/\b(note|comment|justification|description|message)\b\s+text/i.test(code));
}

/* ---- The store's shapes are the schema's ------------------------------------- */
for (const [name, regex] of Object.entries(SHAPE)) {
  assert(sql.includes(regex.source), `SHAPE.${name} (${regex.source}) must be the pattern the migration checks`);
}

/*
 * Every statement the triage store runs names the repository it is about --
 * an insert by its columns, everything else through the repository's whole
 * scope -- none selects everything or spreads a row, and who decided is
 * written but never read back: test/module-rules.test.js's, over the store's
 * syntax tree. That the account purge removes every decision, event and
 * resolution a tester made, and nobody else's, is asked of PostgreSQL by
 * test/alpha-privacy-purge-postgres.js.
 */

console.log('code audit triage contract tests passed');
