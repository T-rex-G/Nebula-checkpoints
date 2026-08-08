'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'db', 'migrations', '010_governance_activation_evidence.sql');
assert(fs.existsSync(file), 'activation evidence migration must exist');
const sql = fs.readFileSync(file, 'utf8');
for (const text of ['nv_governance_activation_evidence', 'simulation_hash', 'scenario_set_hash', 'result_hash', 'proposed_document_hash', 'rollback_source_activation_id', 'authorization_expires_at']) {
  assert(sql.includes(text), `migration must contain ${text}`);
}
assert(/BEFORE UPDATE OR DELETE ON nv_governance_activation_evidence/.test(sql), 'activation evidence must be immutable');
assert(/BEFORE TRUNCATE ON nv_governance_activation_evidence/.test(sql), 'activation evidence truncate must be rejected');
console.log('governance activation persistence contract tests passed');
