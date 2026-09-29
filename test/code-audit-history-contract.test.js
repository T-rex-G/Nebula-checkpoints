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
const storeSource = fs.readFileSync(path.join(root, 'src', 'code-audit-history.js'), 'utf8');
const { SHAPE } = require('../src/code-audit-history');

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
  const vocabulary = (constant, column) => {
    const listed = [...storeSource.matchAll(new RegExp(`const ${constant} = Object\\.freeze\\(\\[([^\\]]+)\\]\\)`, 'g'))][0];
    assert(listed, `missing ${constant}`);
    const values = listed[1].match(/'[^']+'/g).map(value => value.slice(1, -1)).sort();
    const checked = new RegExp(`${column} IN \\(([^)]+)\\)`).exec(sql);
    assert(checked, `missing constraint on ${column}`);
    assert.deepStrictEqual(checked[1].match(/'[^']+'/g).map(value => value.slice(1, -1)).sort(), values, `${constant} and the ${column} constraint must agree`);
  };
  vocabulary('ECOSYSTEMS', 'ecosystem');
  vocabulary('SEVERITIES', 'severity');
  vocabulary('VERDICTS', 'verdict');
  vocabulary('RISK_BANDS', 'risk_band');
  vocabulary('REACH_TIERS', 'reach_tier');
  vocabulary('GRADES', 'grade');
  vocabulary('CAP_REASONS', 'cap_reason');
  vocabulary('WATCH_STATES', 'watch_state');
  vocabulary('WATCH_KEV', 'watch_kev');
  vocabulary('ALERT_KINDS', 'kind');
}

/* ---- Every statement is scoped to an identity -------------------------------------- */
{
  const statements = [...storeSource.matchAll(/`([^`]*nv_code_audit[^`]*)`/g)].map(match => match[1].replace(/\s+/g, ' ').trim());
  assert(statements.length >= 16, `the statement scan must find statements: ${statements.length}`);
  const unscoped = [];
  for (const statement of statements) {
    if (/identity_key|\$\{SCOPE_SQL\}/.test(statement)) continue;
    /*
     * The findings and components of an audit inserted in the same transaction,
     * a statement ago, under the identity it was inserted with: the only
     * statements that name an audit id without re-proving whose it is.
     */
    if (/^INSERT INTO nv_code_audit_(findings|components|alerts) /.test(statement)) continue;
    unscoped.push(statement);
  }
  assert.deepStrictEqual(unscoped, [], 'a statement reaches audit rows without an identity or a stated exception');
  assert(/const SCOPE_SQL = 'provider=\$1 AND authority=\$2 AND owner_login=\$3 AND repo_name=\$4 AND identity_key=\$5'/.test(storeSource));
  /* The alert insert is reached only after the audit row was updated under the identity, and returned early if it was not. */
  assert(/if \(!updated\.rowCount\) return null;[\s\S]*INSERT INTO nv_code_audit_alerts/.test(storeSource));
}

/* ---- Rows leave field by field --------------------------------------------------- */
assert(!/\.\.\.(row|rows\[\d+\])\s*[,})]/.test(storeSource), 'a row must never be spread into an answer');
assert(!/SELECT \*/.test(storeSource), 'every read names its columns');

/* ---- The account purge knows about the tables ---------------------------------- */
{
  const privacySource = fs.readFileSync(path.join(root, 'src', 'alpha-privacy-store.js'), 'utf8');
  assert(/DELETE FROM nv_code_audits WHERE identity_key=ANY/.test(privacySource), 'the tester purge must delete nv_code_audits by identity key');
  /* The other three cascade from their audit; a second delete would make two places responsible for the same rows. */
  for (const table of TABLES.slice(1)) {
    assert(new RegExp(`${table} \\([\\s\\S]*?audit_id uuid NOT NULL REFERENCES nv_code_audits \\(audit_id\\) ON DELETE CASCADE`).test(sql), `${table} must cascade from its audit`);
    assert(!new RegExp(`DELETE FROM ${table}`).test(privacySource), `${table} leaves with its audit`);
  }
}

console.log('code audit history contract tests passed');
