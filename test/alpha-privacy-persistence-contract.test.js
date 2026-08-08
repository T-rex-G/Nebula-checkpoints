'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  'db',
  'migrations',
  '015_alpha_privacy.sql'
);

assert(fs.existsSync(migrationPath), 'missing alpha privacy migration');
const sql = fs.readFileSync(migrationPath, 'utf8');

for (const table of [
  'nv_alpha_provider_bindings',
  'nv_alpha_cleanup_manifest',
  'nv_alpha_cleanup_tasks',
  'nv_alpha_provider_session_ownership',
  'nv_alpha_audit_purge_authorizations',
  'nv_alpha_feedback',
  'nv_alpha_deletion_requests',
  'nv_alpha_deletion_blocks',
  'nv_alpha_purge_reports'
]) {
  assert(
    sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
    `missing ${table}`
  );
}

assert(sql.includes("CHECK (status IN ('pending','verified','failed'))"));
assert(sql.includes("CHECK (status IN ('requested','blocked','complete'))"));
assert.match(
  sql,
  /FOREIGN KEY\(manifest_id,tester_id,identity_key,provider,resource_type,resource_key_hash\)[\s\S]+REFERENCES nv_alpha_cleanup_manifest/
);
assert.match(sql, /UNIQUE\(manifest_id\)/);
assert.match(sql, /nv_alpha_cleanup_manifest_immutable/);
assert.match(sql, /nv_alpha_cleanup_tasks_monotonic/);
assert.match(sql, /OLD\.status='verified'/);
assert.match(sql, /nv_alpha_provider_bindings_monotonic/);
assert.match(sql, /nv_alpha_provider_session_ownership_monotonic/);
assert.match(
  sql,
  /OLD\.disconnected_at IS NOT NULL[\s\S]+NEW\.disconnected_at IS DISTINCT FROM OLD\.disconnected_at/
);
assert.match(
  sql,
  /OLD\.released_at IS NOT NULL[\s\S]+NEW\.released_at IS DISTINCT FROM OLD\.released_at/
);
assert.doesNotMatch(sql, /NEW\.(?:disconnected_at|released_at)<>OLD\./);
assert.match(sql, /nv_alpha_governance_audit_purge_guard/);
assert.match(sql, /nv_alpha_governance_decision_purge_guard/);
assert.match(sql, /nv_alpha_audit_purge_authorizations_cleared/);
assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
assert.match(sql, /DROP TRIGGER IF EXISTS nv_governance_audit_immutable/);
assert.match(sql, /DROP TRIGGER IF EXISTS nv_governance_policy_decisions_immutable/);
assert.match(sql, /nv_alpha_governance_export_retention_guard/);
assert.match(sql, /DROP TRIGGER IF EXISTS nv_governance_exports_immutable/);
assert.match(sql, /ADD COLUMN IF NOT EXISTS metadata_purged_at timestamptz/);
assert.match(sql, /nv_alpha_cohort_metadata_purge_guard/);
assert.match(sql, /current_timestamp<boundary/);
assert.match(sql, /nv_alpha_invites_metadata_purge/);
assert.match(sql, /nv_alpha_testers_metadata_purge/);
for (const column of [
  'secret_digest', 'tester_label', 'repository_scopes', 'terms_version',
  'created_at', 'expires_at', 'terms_accepted_at', 'revocation_reason'
]) {
  assert.match(sql, new RegExp(`ALTER COLUMN ${column} DROP NOT NULL`));
}

assert.match(sql, /ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0/);
assert.match(sql, /PRIMARY KEY\(session_key_hash,tester_id,identity_key,provider\)/);
assert.match(sql, /nv_alpha_provider_session_owner_guard/);
assert.match(sql, /existing\.tester_id<>NEW\.tester_id/);
assert.match(sql, /CHECK \(provider IN \('github','gitlab','gitea'\)\)/);
assert.match(sql, /CHECK \(capability_status IN \('Supported','Experimental','Unavailable'\)\)/);
assert.match(sql, /CHECK \(runtime IN \('chrome','firefox','safari','edge','node','unknown'\)\)/);
assert.match(sql, /CHECK \(feature ~ '\^\[a-z\]\[a-z0-9\._-\]\{0,79\}\$'\)/);
assert.match(sql, /CHECK \(error_code ~ '\^\[A-Z\]\[A-Z0-9_\]\{1,79\}\$'\)/);

const purgeTable = sql.slice(
  sql.indexOf('CREATE TABLE IF NOT EXISTS nv_alpha_purge_reports'),
  sql.indexOf(');', sql.indexOf('CREATE TABLE IF NOT EXISTS nv_alpha_purge_reports')) + 2
);
for (const field of [
  'tester_id_hash',
  'provider_sessions_removed',
  'webhooks_removed',
  'events_removed',
  'snapshots_removed',
  'feedback_removed',
  'completed_at'
]) {
  assert(purgeTable.includes(field), `purge report is missing ${field}`);
}
assert(!/\bjsonb\b/i.test(purgeTable), 'purge reports must use bounded scalar columns');

const deletionBlocksTable = sql.slice(
  sql.indexOf('CREATE TABLE IF NOT EXISTS nv_alpha_deletion_blocks'),
  sql.indexOf(');', sql.indexOf('CREATE TABLE IF NOT EXISTS nv_alpha_deletion_blocks')) + 2
);
for (const code of [
  'CLEANUP_MISSING',
  'CLEANUP_ORPHAN',
  'CLEANUP_MISMATCHED',
  'CLEANUP_EXTRA',
  'CLEANUP_REPLACEMENT',
  'CLEANUP_UNVERIFIED'
]) assert(deletionBlocksTable.includes(`'${code}'`), `missing cleanup diagnostic ${code}`);
assert.match(deletionBlocksTable, /blocked_count integer NOT NULL CHECK \(blocked_count BETWEEN 1 AND 10000\)/);
assert.match(deletionBlocksTable, /cardinality\(cleanup_ids\)<=100/);
assert(!/(?:identity_key|provider|resource_key_hash|\bdescription\b|\bjsonb\b)/i.test(deletionBlocksTable),
  'cleanup diagnostics may contain only bounded codes, counts, and cleanup UUIDs');

assert(!/(?:\bdescription\b|repository_content|provider_payload|private_event_body|\bcredential\b|\btoken\b|\blogin\b|provider_id)/i.test(sql),
  'privacy schema must not add free text, credentials, provider payloads/IDs, source bodies, or logins');

console.log('alpha privacy persistence contract tests passed');
