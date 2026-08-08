'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const migration = path.join(root, 'db', 'migrations', '007_governance.sql');
assert(fs.existsSync(migration), 'governance migration must exist');
const sql = fs.readFileSync(migration, 'utf8');
for (const table of [
  'nv_governance_policies', 'nv_governance_policy_versions', 'nv_governance_approvals',
  'nv_governance_policy_heads', 'nv_governance_activations', 'nv_governance_audit'
]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'), `missing ${table}`);
assert.match(sql, /UNIQUE\s*\(scope_key,\s*policy_key\)/i);
assert.match(sql, /UNIQUE\s*\(policy_id,\s*version_number\)/i);
assert.match(sql, /UNIQUE\s*\(policy_id,\s*document_hash\)/i);
assert.match(sql, /UNIQUE\s*\(version_id,\s*actor_identity_key\)/i);
assert.match(sql, /required_approvals\s+smallint\s+NOT NULL/i);
assert.match(sql, /disallow_author_approval\s+boolean\s+NOT NULL/i);
assert.match(sql, /authority\s+text\s+NOT NULL/i);
assert.match(sql, /seq\s+bigserial\s+UNIQUE\s+NOT NULL/i);
assert.match(sql, /active_version_id\s+uuid/i);
assert.match(sql, /revision\s+bigint\s+NOT NULL\s+DEFAULT\s+0/i);
assert.match(sql, /action\s+text\s+NOT NULL\s+CHECK\s*\(action\s+IN\s*\('activate',\s*'rollback'\)\)/i);
assert.match(sql, /previous_version_id\s+uuid/i);
assert.match(sql, /expected_revision\s+bigint\s+NOT NULL/i);
assert.match(sql, /resulting_revision\s+bigint\s+NOT NULL/i);
assert.match(sql, /previous_hash\s+text\s+NOT NULL/i);
assert.match(sql, /record_hash\s+text\s+NOT NULL/i);
assert.match(sql, /details_hash\s+text\s+NOT NULL/i);
assert.match(sql, /CREATE OR REPLACE FUNCTION nv_governance_reject_history_mutation/i);
for (const table of ['nv_governance_policy_versions', 'nv_governance_approvals', 'nv_governance_activations', 'nv_governance_audit']) {
  assert.match(sql, new RegExp(`CREATE TRIGGER ${table}_immutable`, 'i'), `missing immutable trigger for ${table}`);
}
assert.match(sql, /BEFORE UPDATE OR DELETE/i);
assert.match(sql, /BEFORE TRUNCATE/i);
assert.match(sql, /nv_governance_versions_policy_time_idx/i);
assert.match(sql, /nv_governance_audit_policy_time_idx/i);
assert.match(sql, /FOREIGN KEY\s*\(policy_id,\s*active_version_id\)/i);
assert.match(sql, /FOREIGN KEY\s*\(policy_id,\s*previous_version_id\)/i);
assert(!/(access_token|refresh_token|client_secret|private_key|password|authorization_header|cookie_value)/i.test(sql), 'schema must not persist credentials');
console.log('governance persistence contract tests passed');
