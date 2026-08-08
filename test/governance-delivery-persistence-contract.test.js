'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '013_governance_notifications_exports.sql'), 'utf8');
for (const table of [
  'nv_governance_event_outbox', 'nv_governance_notification_preferences', 'nv_governance_webhooks',
  'nv_governance_webhook_deliveries', 'nv_governance_webhook_attempts', 'nv_governance_exports'
]) assert(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `missing ${table}`);
for (const marker of [
  'nv_governance_enqueue_lifecycle_event', 'nv_governance_enqueue_policy_decision',
  'nv_governance_enqueue_webhook_deliveries', 'AFTER INSERT ON nv_governance_audit',
  'AFTER INSERT ON nv_governance_policy_decisions', 'policy.decision.block',
  'UNIQUE(webhook_id,event_seq)', 'octet_length(content) <= 4194304',
  'nv_governance_exports_immutable', 'nv_governance_webhook_attempts_immutable'
]) assert(sql.includes(marker), `migration contract missing ${marker}`);
assert(!/access_token|private_key|authorization_header/i.test(sql), 'delivery schema must not persist credentials');
console.log('governance delivery persistence contract tests passed');
