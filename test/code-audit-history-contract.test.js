'use strict';

/*
 * The schema half of the audit history, and the structural half the schema
 * cannot hold. `test/code-audit-history.test.js` proves the behaviour against a
 * real server; this runs everywhere and asserts what a reviewer would otherwise
 * check by eye each time the store grows:
 *
 *   - no column can take free text: every text column is an enumeration, a
 *     pattern, or a bounded path, and there is no json anywhere;
 *   - the store's vocabulary is the schema's, value for value;
 *   - every statement names the identity its rows belong to, directly or
 *     through the audit that owns them;
 *   - no row is ever spread into an answer;
 *   - the account purge knows about the tables.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'db', 'migrations', '029_code_audit_history.sql'), 'utf8');
/* The store's vocabularies, as its rows module declares them, and its SQL fragments. */
const rows = require('../apps/api/src/modules/uranus/persistence/audit-history-rows.ts');
const fragments = require('../apps/api/src/modules/uranus/persistence/audit-history-sql.ts');
const coverageMigration = fs.readFileSync(path.join(root, 'db', 'migrations', '032_code_audit_analysis_coverage.sql'), 'utf8').replace(/--.*$/gm, '').trim();
assert.strictEqual(coverageMigration, 'ALTER TABLE nv_code_audits ADD COLUMN analysis_complete boolean NULL;',
  'analysis proof is additive, nullable for existing rows, and never backfilled as complete');
const { SHAPE } = require('../apps/api/src/modules/uranus/index.ts').auditHistory;

const TABLES = ['nv_code_audits', 'nv_code_audit_findings', 'nv_code_audit_components', 'nv_code_audit_alerts'];
for (const table of TABLES) assert(sql.includes(`CREATE TABLE ${table} (`), `missing ${table}`);

/* ---- No column that free text fits in -------------------------------------------- */
{
  assert(!/\bjsonb?\b/i.test(sql.replace(/--.*$/gm, '')), 'no json column: a serializer could widen it without a migration');
  const body = table => {
    const start = sql.indexOf(`CREATE TABLE ${table} (`);
    return sql.slice(start, sql.indexOf('\n);', start));
  };
  /* Text columns that may be bounded by length alone: the scope, the branch, and a path. Everything else has a shape. */
  const LENGTH_ONLY = new Set(['provider', 'authority', 'owner_login', 'repo_name', 'ref_name', 'file_path']);
  let textColumns = 0;
  for (const table of TABLES) {
    for (const line of body(table).split('\n')) {
      const column = /^\s{2}([a-z_]+) (text(?:\[\])?)\b(.*)$/.exec(line);
      if (!column) continue;
      textColumns += 1;
      const [, name, type] = column;
      const definition = body(table).slice(body(table).indexOf(line));
      const upToNext = definition.split(/\n\s{2}[a-z_]+ (?:text|uuid|integer|smallint|boolean|numeric|timestamptz|date)/)[0];
      if (LENGTH_ONLY.has(name)) {
        assert(/length\([a-z_]+\) BETWEEN 1 AND (40|255|1024)/.test(upToNext), `${table}.${name} must be bounded`);
        continue;
      }
      assert(/ IN \(|~ '\^/.test(upToNext), `${table}.${name} (${type}) must be an enumeration or match a pattern, not free text`);
    }
  }
  assert(textColumns >= 40, `the column scan must find the text columns: ${textColumns}`);
}

/* ---- The store's shapes are the schema's ------------------------------------------ */
{
  const pattern = regex => regex.source.replace(/\\\./g, '.');
  const inSql = source => sql.includes(source);
  for (const [name, regex] of Object.entries(SHAPE)) {
    if (['uuid', 'day', 'engine'].includes(name)) continue;
    const source = regex.source.replace(/\{0,213\}\$$/, '*$');
    assert(inSql(source) || inSql(pattern(regex)) || inSql(regex.source.slice(0, -1)), `SHAPE.${name} (${regex.source}) must be the pattern the migration checks`);
  }
  /* Each vocabulary the store writes is the one its column's constraint admits. */
  const vocabulary = (constant, column) => {
    const values = rows[constant];
    assert(Array.isArray(values) && Object.isFrozen(values), `missing ${constant}`);
    const checked = new RegExp(`${column} IN \\(([^)]+)\\)`).exec(sql);
    assert(checked, `missing constraint on ${column}`);
    assert.deepStrictEqual(checked[1].match(/'[^']+'/g).map(value => value.slice(1, -1)).sort(), [...values].sort(), `${constant} and the ${column} constraint must agree`);
  };
  vocabulary('ECOSYSTEMS', 'ecosystem');
  vocabulary('SEVERITIES', 'severity');
  vocabulary('VERDICTS', 'verdict');
  vocabulary('RISK_BANDS', 'risk_band');
  vocabulary('REACH_TIERS', 'reach_tier');
  vocabulary('GRADES', 'grade');
  vocabulary('CAP_REASONS', 'cap_reason');
  vocabulary('WATCH_STATES', 'watch_state');
  assert.strictEqual(rows.WATCH_STATES, require('../packages/contracts/src/evidence.ts').AUDIT_WATCH_STATES, 'the store reads its watch states from the evidence contract');
  vocabulary('WATCH_KEV', 'watch_kev');
  vocabulary('ALERT_KINDS', 'kind');
}

/* ---- Every statement is scoped to an identity -------------------------------------- */
/*
 * The scope every statement on an audit carries is the repository and the
 * identity, whole, and the workspace reads start from one identity's audits.
 * That each statement carries one of them, or is an insert of an audit's own
 * rows a statement after the audit; that no read selects everything or spreads
 * a row; and that the tester purge leaves findings, components and alerts to
 * their audit's cascade, is test/module-rules.test.js's, over the store's
 * syntax tree. That the purge takes a tester's audits and their rows is asked
 * of PostgreSQL by test/alpha-privacy-purge-postgres.js.
 */
assert.strictEqual(fragments.SCOPE_SQL, 'provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4 AND identity_key=$5');
assert.match(fragments.WORKSPACE_SQL, /^WITH latest AS \([^]*FROM nv_code_audits\s+WHERE provider=\$1 AND authority=\$2 AND identity_key=\$3\s/,
  'the workspace reads start from one identity\'s audits');
for (const table of TABLES.slice(1)) {
  assert(new RegExp(`${table} \\([\\s\\S]*?audit_id uuid NOT NULL REFERENCES nv_code_audits \\(audit_id\\) ON DELETE CASCADE`).test(sql), `${table} must cascade from its audit`);
}

console.log('code audit history contract tests passed');
