'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '012_governance_exceptions.sql'), 'utf8');
for (const token of [
  'nv_governance_exception_requests', 'nv_governance_exception_events',
  "CHECK (kind IN ('exception', 'waiver'))", "CHECK (event_type IN ('approve', 'reject', 'revoke'))",
  'authorization_expires_at', 'document_hash', 'head_revision', 'target', 'target_hash', 'rule_ids', 'expires_at',
  'nv_governance_exception_requests_immutable', 'nv_governance_exception_events_immutable'
]) assert(sql.includes(token), `migration must contain ${token}`);
assert.match(sql, /target <> '\{\}'::jsonb[\s\S]*octet_length\(target::text\) <= 4096/, 'database must bound persisted target metadata');
assert.match(sql, /UNIQUE INDEX[\s\S]*exception.*decision/i);
assert.match(sql, /FOREIGN KEY\(policy_id, version_id\)/i);
assert.match(sql, /FOREIGN KEY\(policy_id, scope_key\)[\s\S]*REFERENCES nv_governance_policies\(policy_id, scope_key\)/i, 'exception scope must be relationally bound to its policy');
console.log('governance exception persistence contract tests passed');
