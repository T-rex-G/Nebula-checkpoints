'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '014_alpha_access.sql'),
  'utf8'
);

for (const table of [
  'nv_alpha_invites',
  'nv_alpha_testers',
  'nv_alpha_sessions',
  'nv_alpha_redemption_locks'
]) {
  assert(
    sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
    `missing ${table}`
  );
}

assert.match(sql, /secret_digest text NOT NULL/);
assert.match(sql, /repository_scopes text\[\] NOT NULL/g);
assert.match(sql, /UNIQUE\s*\(invite_id,\s*tester_id\)/);
assert.match(sql, /failed_count integer NOT NULL/);
assert.match(sql, /CHECK\s*\(secret_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/);
assert.match(sql, /CHECK\s*\(cardinality\(repository_scopes\) BETWEEN 1 AND 20\)/g);
assert.match(sql, /CHECK\s*\(expires_at > created_at\)/g);
assert.match(sql, /nv_alpha_sessions_tester_idx/);
assert.match(
  sql,
  /CREATE INDEX IF NOT EXISTS nv_alpha_sessions_expiry_idx\s+ON nv_alpha_sessions\(expires_at, session_id\)/
);
assert.match(
  sql,
  /CREATE INDEX IF NOT EXISTS nv_alpha_sessions_last_seen_idx\s+ON nv_alpha_sessions\(last_seen_at, session_id\)/
);
assert.match(sql, /nv_alpha_invites_expiry_idx/);
assert.match(sql, /nv_alpha_redemption_locks_expiry_idx/);
assert(!/\b(?:code|secret|pepper|ip_address)\s+text\b/i.test(sql), 'schema must not persist invitation or IP plaintext');

console.log('alpha access persistence contract tests passed');
