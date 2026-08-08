'use strict';

const assert = require('assert');
const { AlphaPrivacyStore } = require('../src/alpha-privacy-store');

const TESTER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_TESTER_ID = '10000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-07-29T18:00:00.000Z');

function normalized(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

class FakePool {
  constructor() {
    this.state = {
      testers: [{ tester_id: TESTER_ID, revoked_at: null }],
      invites: [],
      deletions: [],
      cleanupBlocks: [],
      bindings: [],
      manifests: [],
      tasks: [],
      sessions: [],
      ownership: [],
      webhookOwnership: [],
      providerSessions: [],
      webhooks: [],
      events: [],
      snapshots: [],
      installations: [],
      security: [],
      githubAudit: [],
      feedback: [],
      governanceAudit: [],
      governanceDecisions: [],
      retainedIntegrity: [],
      purgeAuthorizations: [],
      purgeReports: [],
      exports: [],
      cohort: null
    };
    this.calls = [];
    this.nextClientId = 0;
    this.lockTail = Promise.resolve();
    this.failTaskInsert = false;
    this.failBindingDisconnect = false;
    this.failTerminalSessionScrub = false;
  }

  async query() {
    throw new Error('privacy writes must use a transaction client');
  }

  async connect() {
    return new FakeClient(this, ++this.nextClientId);
  }

  async acquire(client) {
    let unlock;
    const previous = this.lockTail;
    this.lockTail = new Promise(resolve => { unlock = resolve; });
    await previous;
    client.unlock = unlock;
  }
}

class FakeClient {
  constructor(pool, id) {
    this.pool = pool;
    this.id = id;
    this.snapshot = null;
    this.unlock = null;
  }

  async query(sql, params = []) {
    const text = normalized(sql);
    this.pool.calls.push({ clientId: this.id, sql: text, params: structuredClone(params) });

    if (text === 'BEGIN') {
      return { rows: [], rowCount: null };
    }
    if (/pg_advisory_xact_lock/.test(text)) {
      await this.pool.acquire(this);
      this.snapshot = structuredClone(this.pool.state);
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    }
    if (text === 'COMMIT') {
      this.snapshot = null;
      this.releaseLock();
      return { rows: [], rowCount: null };
    }
    if (text === 'ROLLBACK') {
      if (this.snapshot) this.pool.state = this.snapshot;
      this.snapshot = null;
      this.releaseLock();
      return { rows: [], rowCount: null };
    }
    if (/FROM nv_alpha_testers WHERE tester_id=\$1 FOR UPDATE/.test(text)) {
      const row = this.pool.state.testers.find(item => item.tester_id === params[0]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM nv_alpha_deletion_requests WHERE tester_id=\$1 FOR UPDATE/.test(text)) {
      const row = this.pool.state.deletions.find(item => item.tester_id === params[0]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM nv_alpha_provider_bindings WHERE tester_id=\$1 AND identity_key=\$2 FOR UPDATE/.test(text)) {
      const rows = this.pool.state.bindings.filter(item => (
        item.tester_id === params[0] && item.identity_key === params[1]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/AS lifecycle_started/.test(text)) {
      const lifecycleStarted = this.pool.state.manifests.some(item => (
        item.tester_id === params[0] && item.identity_key === params[1]
      ));
      return { rows: [{ lifecycle_started: lifecycleStarted }], rowCount: 1 };
    }
    if (/INSERT INTO nv_alpha_provider_bindings/.test(text)) {
      const row = {
        tester_id: params[0], identity_key: params[1], provider: params[2],
        authority: params[3], connected_at: params[4], disconnected_at: null
      };
      this.pool.state.bindings.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/FROM nv_alpha_provider_bindings WHERE tester_id=\$1 AND identity_key=\$2 AND provider=\$3 FOR UPDATE/.test(text)) {
      const rows = this.pool.state.bindings.filter(item => (
        item.tester_id === params[0]
        && item.identity_key === params[1]
        && item.provider === params[2]
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (
      /LEFT JOIN nv_alpha_cleanup_tasks task/.test(text)
      && /FOR UPDATE OF manifest,task/.test(text)
    ) {
      const error = new Error('FOR UPDATE cannot lock the nullable side of an outer join');
      error.code = '0A000';
      throw error;
    }
    if (/FROM nv_alpha_cleanup_manifest manifest INNER JOIN nv_alpha_cleanup_tasks task/.test(text)) {
      const rows = this.pool.state.manifests.filter(item => (
        item.tester_id === params[0]
        && item.identity_key === params[1]
        && item.provider === params[2]
        && item.resource_type === params[3]
        && item.resource_key_hash === params[4]
      )).map(manifest => {
        const task = this.pool.state.tasks.find(item => item.manifest_id === manifest.manifest_id);
        return {
          ...manifest,
          cleanup_id: task && task.cleanup_id,
          status: task && task.status,
          verified_at: task && task.verified_at
        };
      });
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/INSERT INTO nv_alpha_cleanup_manifest/.test(text)) {
      const row = {
        manifest_id: params[0], tester_id: params[1], identity_key: params[2],
        provider: params[3], resource_type: params[4], resource_key_hash: params[5],
        created_at: params[6]
      };
      this.pool.state.manifests.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/INSERT INTO nv_alpha_cleanup_tasks/.test(text)) {
      if (this.pool.failTaskInsert) throw new Error('injected task insert failure');
      const row = {
        cleanup_id: params[0], manifest_id: params[1], tester_id: params[2],
        identity_key: params[3], provider: params[4], resource_type: params[5],
        resource_key_hash: params[6], status: 'pending', reason_code: params[7],
        created_at: params[8], verified_at: null
      };
      this.pool.state.tasks.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/FROM nv_alpha_cleanup_tasks WHERE cleanup_id=\$1 AND tester_id=\$2 FOR UPDATE/.test(text)) {
      const row = this.pool.state.tasks.find(item => (
        item.cleanup_id === params[0] && item.tester_id === params[1]
      ));
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE nv_alpha_cleanup_tasks SET status='verified'/.test(text)) {
      const row = this.pool.state.tasks.find(item => (
        item.cleanup_id === params[0] && item.tester_id === params[1]
      ));
      if (!row || row.status === 'verified') return { rows: [], rowCount: 0 };
      row.status = 'verified';
      row.verified_at = params[2];
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/FROM nv_alpha_provider_bindings WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.bindings.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_cleanup_manifest WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.manifests.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_cleanup_tasks WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.tasks.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_session_ownership WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.ownership.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/FROM nv_alpha_provider_webhook_ownership WHERE tester_id=\$1 ORDER BY/.test(text)) {
      const rows = this.pool.state.webhookOwnership.filter(item => item.tester_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/UPDATE nv_alpha_sessions SET revoked_at=COALESCE/.test(text)) {
      let rowCount = 0;
      for (const session of this.pool.state.sessions) {
        if (session.tester_id === params[0] && !session.revoked_at) {
          session.revoked_at = params[1];
          rowCount += 1;
        }
      }
      return { rows: [], rowCount };
    }
    if (/INSERT INTO nv_alpha_deletion_requests/.test(text)) {
      const row = {
        request_id: params[0], tester_id: params[1], status: params[2],
        blocked_cleanup_ids: structuredClone(params[3]), requested_at: params[4],
        completed_at: null
      };
      this.pool.state.deletions.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/UPDATE nv_alpha_deletion_requests SET status=\$2,blocked_cleanup_ids=\$3/.test(text)) {
      const row = this.pool.state.deletions.find(item => item.tester_id === params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = params[1];
      row.blocked_cleanup_ids = structuredClone(params[2]);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/DELETE FROM nv_alpha_deletion_blocks WHERE request_id=\$1/.test(text)) {
      const before = this.pool.state.cleanupBlocks.length;
      this.pool.state.cleanupBlocks = this.pool.state.cleanupBlocks
        .filter(item => item.request_id !== params[0]);
      return { rows: [], rowCount: before - this.pool.state.cleanupBlocks.length };
    }
    if (/INSERT INTO nv_alpha_deletion_blocks/.test(text)) {
      const row = {
        request_id: params[0], block_code: params[1], blocked_count: params[2],
        cleanup_ids: structuredClone(params[3])
      };
      this.pool.state.cleanupBlocks.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE nv_alpha_provider_bindings SET disconnected_at=\$4/.test(text)) {
      if (this.pool.failBindingDisconnect) return { rows: [], rowCount: 0 };
      const row = this.pool.state.bindings.find(item => (
        item.tester_id === params[0]
        && item.identity_key === params[1]
        && item.provider === params[2]
      ));
      if (!row || row.disconnected_at) return { rows: [], rowCount: 0 };
      row.disconnected_at = params[3];
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/UPDATE nv_alpha_provider_session_ownership SET released_at=\$4/.test(text)) {
      let rowCount = 0;
      for (const row of this.pool.state.ownership) {
        if (
          row.tester_id === params[0]
          && row.identity_key === params[1]
          && row.provider === params[2]
          && !row.released_at
        ) {
          row.released_at = params[3];
          rowCount += 1;
        }
      }
      return { rows: [], rowCount };
    }
    if (/FROM nv_alpha_provider_session_ownership WHERE session_key_hash=\$1 FOR UPDATE/.test(text)) {
      const row = this.pool.state.ownership.find(item => item.session_key_hash === params[0]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO nv_alpha_provider_session_ownership/.test(text)) {
      const row = {
        session_key_hash: params[0], tester_id: params[1], identity_key: params[2],
        provider: params[3], claimed_at: params[4], released_at: null
      };
      this.pool.state.ownership.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (
      /FROM nv_alpha_provider_session_ownership/.test(text)
      && /WHERE session_key_hash IN/.test(text)
      && /FOR UPDATE/.test(text)
    ) {
      const testerHashes = new Set(this.pool.state.ownership
        .filter(item => item.tester_id === params[0])
        .map(item => item.session_key_hash));
      const rows = this.pool.state.ownership.filter(item => (
        testerHashes.has(item.session_key_hash)
      ));
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (/DELETE FROM nv_sessions WHERE session_key_hash=ANY\(\$1::text\[\]\) RETURNING sid/.test(text)) {
      const hashes = new Set(params[0]);
      const removed = this.pool.state.providerSessions.filter(item => hashes.has(item.session_key_hash));
      this.pool.state.providerSessions = this.pool.state.providerSessions
        .filter(item => !hashes.has(item.session_key_hash));
      if (this.pool.failTerminalSessionScrub) {
        throw new Error('injected terminal session scrub failure');
      }
      return {
        rows: removed.map(item => ({ sid: item.sid })),
        rowCount: removed.length
      };
    }
    if (/FROM nv_alpha_purge_reports WHERE tester_id_hash=\$1/.test(text)) {
      const row = this.pool.state.purgeReports.find(item => item.tester_id_hash === params[0]);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE nv_alpha_provider_bindings SET disconnected_at=COALESCE/.test(text)) {
      let rowCount = 0;
      for (const row of this.pool.state.bindings) {
        if (row.tester_id === params[0] && !row.disconnected_at) {
          row.disconnected_at = params[1];
          rowCount += 1;
        }
      }
      return { rows: [], rowCount };
    }
    if (/SELECT DISTINCT binding.identity_key FROM nv_alpha_provider_bindings binding/.test(text)) {
      const testerId = params[0];
      const activeTesterIds = new Set(this.pool.state.testers
        .filter(item => !item.revoked_at)
        .map(item => item.tester_id));
      const identities = [...new Set(this.pool.state.bindings
        .filter(item => item.tester_id === testerId)
        .map(item => item.identity_key))]
        .filter(identityKey => {
          const sharedBinding = this.pool.state.bindings.some(item => (
            item.tester_id !== testerId
            && item.identity_key === identityKey
            && !item.disconnected_at
            && activeTesterIds.has(item.tester_id)
          ));
          const sharedOwnership = this.pool.state.ownership.some(item => (
            item.tester_id !== testerId
            && item.identity_key === identityKey
            && !item.released_at
            && activeTesterIds.has(item.tester_id)
          ));
          return !sharedBinding && !sharedOwnership;
        }).sort();
      return {
        rows: identities.map(identity_key => ({ identity_key })),
        rowCount: identities.length
      };
    }
    if (/INSERT INTO nv_alpha_retained_integrity/.test(text)) {
      const [testerIdHash, identityKeys, retainedAt] = params;
      const records = [
        ...this.pool.state.governanceAudit
          .filter(item => identityKeys.includes(item.actor_identity_key))
          .map(item => ({
            tester_id_hash: testerIdHash,
            record_kind: 'governance-audit',
            record_hash: item.record_hash,
            previous_hash: item.previous_hash,
            payload_hash: item.details_hash,
            recorded_at: item.created_at,
            retained_at: retainedAt
          })),
        ...this.pool.state.governanceDecisions
          .filter(item => identityKeys.includes(item.actor_identity_key))
          .map(item => ({
            tester_id_hash: testerIdHash,
            record_kind: 'governance-decision',
            record_hash: item.record_hash,
            previous_hash: item.previous_hash,
            payload_hash: item.decision_hash,
            recorded_at: item.created_at,
            retained_at: retainedAt
          }))
      ];
      for (const row of records) {
        if (!this.pool.state.retainedIntegrity.some(item => (
          item.record_kind === row.record_kind && item.record_hash === row.record_hash
        ))) this.pool.state.retainedIntegrity.push(row);
      }
      return { rows: [], rowCount: records.length };
    }
    if (/INSERT INTO nv_alpha_audit_purge_authorizations/.test(text)) {
      const [testerId, testerIdHash, identityKeys, createdAt] = params;
      const records = [
        ...this.pool.state.governanceAudit
          .filter(item => identityKeys.includes(item.actor_identity_key))
          .map(item => ({
            tester_id: testerId, tester_id_hash: testerIdHash,
            identity_key: item.actor_identity_key, record_kind: 'governance-audit',
            record_hash: item.record_hash, previous_hash: item.previous_hash,
            payload_hash: item.details_hash, created_at: createdAt
          })),
        ...this.pool.state.governanceDecisions
          .filter(item => identityKeys.includes(item.actor_identity_key))
          .map(item => ({
            tester_id: testerId, tester_id_hash: testerIdHash,
            identity_key: item.actor_identity_key, record_kind: 'governance-decision',
            record_hash: item.record_hash, previous_hash: item.previous_hash,
            payload_hash: item.decision_hash, created_at: createdAt
          }))
      ];
      this.pool.state.purgeAuthorizations.push(...records);
      return { rows: [], rowCount: records.length };
    }
    if (/DELETE FROM nv_governance_audit WHERE actor_identity_key=ANY/.test(text)) {
      return this.deleteIdentityRows('governanceAudit', params[0], 'actor_identity_key');
    }
    if (/DELETE FROM nv_governance_policy_decisions WHERE actor_identity_key=ANY/.test(text)) {
      return this.deleteIdentityRows('governanceDecisions', params[0], 'actor_identity_key');
    }
    if (/DELETE FROM nv_alpha_audit_purge_authorizations WHERE tester_id=\$1/.test(text)) {
      const before = this.pool.state.purgeAuthorizations.length;
      this.pool.state.purgeAuthorizations = this.pool.state.purgeAuthorizations
        .filter(item => item.tester_id !== params[0]);
      return { rows: [], rowCount: before - this.pool.state.purgeAuthorizations.length };
    }
    if (/DELETE FROM nv_sessions session WHERE session.identity_keys/.test(text)) {
      const identityKeys = params[1];
      const before = this.pool.state.providerSessions.length;
      this.pool.state.providerSessions = this.pool.state.providerSessions.filter(item => (
        !item.identity_keys.some(identityKey => identityKeys.includes(identityKey))
      ));
      return { rows: [], rowCount: before - this.pool.state.providerSessions.length };
    }
    if (/DELETE FROM nv_webhooks WHERE identity_key=ANY/.test(text)) {
      return this.deleteIdentityRows('webhooks', params[1]);
    }
    if (/DELETE FROM nv_intelligence_events WHERE identity_key=ANY/.test(text)) {
      return this.deleteIdentityRows('events', params[1]);
    }
    if (/DELETE FROM nv_recovery_snapshots WHERE identity_key=ANY/.test(text)) {
      return this.deleteIdentityRows('snapshots', params[1]);
    }
    if (/DELETE FROM nv_github_app_installations WHERE identity_key=ANY/.test(text)) {
      return this.deleteIdentityRows('installations', params[1]);
    }
    if (/DELETE FROM nv_security_state WHERE identity_key=ANY/.test(text)) {
      return this.deleteIdentityRows('security', params[1]);
    }
    if (/DELETE FROM nv_github_app_audit WHERE identity_key=ANY/.test(text)) {
      return this.deleteIdentityRows('githubAudit', params[1]);
    }
    if (/DELETE FROM nv_alpha_feedback WHERE tester_id=\$1/.test(text)) {
      const before = this.pool.state.feedback.length;
      this.pool.state.feedback = this.pool.state.feedback
        .filter(item => item.tester_id !== params[0]);
      return { rows: [], rowCount: before - this.pool.state.feedback.length };
    }
    if (/UPDATE nv_alpha_provider_session_ownership SET released_at=COALESCE/.test(text)) {
      let rowCount = 0;
      for (const row of this.pool.state.ownership) {
        if (row.tester_id === params[0] && !row.released_at) {
          row.released_at = params[1];
          rowCount += 1;
        }
      }
      return { rows: [], rowCount };
    }
    if (/UPDATE nv_alpha_testers SET revoked_at=COALESCE/.test(text)) {
      const row = this.pool.state.testers.find(item => item.tester_id === params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.revoked_at = row.revoked_at || params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE nv_alpha_deletion_requests SET status='complete'/.test(text)) {
      const row = this.pool.state.deletions.find(item => item.tester_id === params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'complete';
      row.blocked_cleanup_ids = [];
      row.completed_at = params[1];
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/INSERT INTO nv_alpha_purge_reports/.test(text)) {
      const row = {
        report_id: params[0], tester_id_hash: params[1], status: 'complete',
        token_bearing_state_removed: true, provider_cleanup_verified: true,
        retained_integrity_metadata: true,
        provider_sessions_removed: params[2], webhooks_removed: params[3],
        events_removed: params[4], snapshots_removed: params[5], feedback_removed: params[6],
        completed_at: params[7], created_at: params[7]
      };
      this.pool.state.purgeReports.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/INSERT INTO nv_alpha_feedback/.test(text)) {
      const row = {
        feedback_id: params[0], tester_id: params[1], release_version: params[2],
        correlation_id: params[3], provider: params[4], feature: params[5],
        capability_status: params[6], error_code: params[7], runtime: params[8],
        occurred_at: params[9], created_at: params[10]
      };
      this.pool.state.feedback.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/FROM nv_alpha_cohort_retention WHERE cohort_key='public-alpha-17' FOR UPDATE/.test(text)) {
      const row = this.pool.state.cohort;
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO nv_alpha_cohort_retention/.test(text)) {
      const row = {
        cohort_key: 'public-alpha-17', closed_at: params[0],
        purge_after: params[1], created_at: params[2]
      };
      this.pool.state.cohort = row;
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (/DELETE FROM nv_alpha_sessions WHERE expires_at<=\$1 OR created_at<=\$2/.test(text)) {
      const before = this.pool.state.sessions.length;
      this.pool.state.sessions = this.pool.state.sessions.filter(item => (
        !(item.expires_at <= params[0] || item.created_at <= params[1])
      ));
      return { rows: [], rowCount: before - this.pool.state.sessions.length };
    }
    if (
      /DELETE FROM (?:nv_sessions session|nv_intelligence_events event|nv_recovery_snapshots snapshot|nv_governance_exports export|nv_alpha_feedback)/.test(text)
      && /(?:tester\.revoked_at IS NULL|nv_alpha_deletion_requests request)/.test(text)
    ) {
      throw new Error('retention query excluded a revoked or deleting alpha lifecycle');
    }
    if (/DELETE FROM nv_sessions session WHERE session.updated<=\$1/.test(text)) {
      const alphaIdentities = new Set(this.pool.state.bindings.map(item => item.identity_key));
      const before = this.pool.state.providerSessions.length;
      this.pool.state.providerSessions = this.pool.state.providerSessions.filter(item => (
        !(item.updated <= params[0] && item.identity_keys.some(key => alphaIdentities.has(key)))
      ));
      return { rows: [], rowCount: before - this.pool.state.providerSessions.length };
    }
    if (/DELETE FROM nv_intelligence_events event WHERE event.created_at<=\$1/.test(text)) {
      return this.deleteOldAlphaRows('events', params[0]);
    }
    if (/DELETE FROM nv_recovery_snapshots snapshot WHERE snapshot.created_at<=\$1/.test(text)) {
      return this.deleteOldAlphaRows('snapshots', params[0]);
    }
    if (/DELETE FROM nv_governance_exports export WHERE export.created_at<=\$1/.test(text)) {
      return this.deleteOldAlphaRows('exports', params[0], 'actor_identity_key');
    }
    if (/DELETE FROM nv_alpha_feedback WHERE created_at<=\$1/.test(text)) {
      const before = this.pool.state.feedback.length;
      this.pool.state.feedback = this.pool.state.feedback
        .filter(item => item.created_at > params[0]);
      return { rows: [], rowCount: before - this.pool.state.feedback.length };
    }
    if (/UPDATE nv_alpha_testers SET tester_label=NULL/.test(text)) {
      let rowCount = 0;
      for (const tester of this.pool.state.testers) {
        if (tester.metadata_purged_at) continue;
        for (const key of [
          'tester_label', 'repository_scopes', 'terms_version', 'terms_accepted_at',
          'created_at', 'revoked_at', 'revocation_reason'
        ]) tester[key] = null;
        tester.metadata_purged_at = params[0];
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }
    if (/UPDATE nv_alpha_invites SET secret_digest=NULL/.test(text)) {
      let rowCount = 0;
      for (const invite of this.pool.state.invites) {
        if (invite.metadata_purged_at) continue;
        for (const key of [
          'secret_digest', 'tester_label', 'repository_scopes', 'terms_version',
          'created_at', 'expires_at', 'redeemed_at', 'revoked_at'
        ]) invite[key] = null;
        invite.metadata_purged_at = params[0];
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }
    throw new Error(`Unhandled fake SQL: ${text}`);
  }

  releaseLock() {
    if (this.unlock) this.unlock();
    this.unlock = null;
  }

  deleteIdentityRows(name, identityKeys, field = 'identity_key') {
    const before = this.pool.state[name].length;
    this.pool.state[name] = this.pool.state[name]
      .filter(item => !identityKeys.includes(item[field]));
    return { rows: [], rowCount: before - this.pool.state[name].length };
  }

  deleteOldAlphaRows(name, cutoff, identityField = 'identity_key') {
    const alphaIdentities = new Set(this.pool.state.bindings.map(item => item.identity_key));
    const before = this.pool.state[name].length;
    this.pool.state[name] = this.pool.state[name].filter(item => (
      !(item.created_at <= cutoff && alphaIdentities.has(item[identityField]))
    ));
    return { rows: [], rowCount: before - this.pool.state[name].length };
  }

  release() {
    this.releaseLock();
  }
}

function makeStore(pool, currentTime = NOW) {
  let uuidCounter = 0;
  return new AlphaPrivacyStore({
    pool,
    now: () => currentTime,
    randomUUID: () => `20000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`
  });
}

(async () => {
  const pool = new FakePool();
  const store = makeStore(pool);
  const input = {
    testerId: TESTER_ID,
    identityKey: 'a'.repeat(64),
    provider: 'github',
    authority: 'github.com'
  };

  const created = await store.bindProviderIdentity(input);
  assert.deepStrictEqual(created, {
    created: true,
    connectedAt: NOW.toISOString()
  });
  assert.strictEqual(pool.state.bindings.length, 1);

  const idempotent = await store.bindProviderIdentity(input);
  assert.deepStrictEqual(idempotent, {
    created: false,
    connectedAt: NOW.toISOString()
  });
  assert.strictEqual(pool.state.bindings.length, 1, 'idempotent bind must not insert again');

  await assert.rejects(
    () => store.bindProviderIdentity({ ...input, authority: 'github.example.com' }),
    error => error && error.code === 'ALPHA_PROVIDER_BINDING_CONFLICT'
  );
  assert.strictEqual(pool.state.bindings[0].authority, 'github.com');

  pool.state.manifests.push({ tester_id: TESTER_ID, identity_key: input.identityKey });
  await assert.rejects(
    () => store.bindProviderIdentity(input),
    error => error && error.code === 'ALPHA_PROVIDER_LIFECYCLE_STARTED'
  );
  assert.strictEqual(pool.state.manifests.length, 1, 'bind must preserve cleanup evidence');

  assert(pool.calls.some(call => /pg_advisory_xact_lock/.test(call.sql)));
  assert(pool.calls.some(call => call.sql === 'BEGIN'));
  assert(pool.calls.some(call => call.sql === 'COMMIT'));
  assert(pool.calls.some(call => call.sql === 'ROLLBACK'));

  const concurrentPool = new FakePool();
  const concurrentStore = makeStore(concurrentPool);
  const concurrent = await Promise.allSettled([
    concurrentStore.bindProviderIdentity(input),
    concurrentStore.bindProviderIdentity({ ...input, authority: 'github.example.com' })
  ]);
  assert.strictEqual(concurrent.filter(item => item.status === 'fulfilled').length, 1);
  assert.strictEqual(concurrent.filter(item => item.status === 'rejected').length, 1);
  assert.strictEqual(concurrentPool.state.bindings.length, 1, 'lifecycle lock must serialize bind claims');

  const cleanupPool = new FakePool();
  const cleanupStore = makeStore(cleanupPool);
  await cleanupStore.bindProviderIdentity(input);
  const cleanupInput = {
    testerId: TESTER_ID,
    identityKey: input.identityKey,
    provider: 'github',
    resourceType: 'provider-webhook',
    resourceKeyHash: 'b'.repeat(64),
    reasonCode: 'PROVIDER_ABSENCE_UNCONFIRMED'
  };
  const pending = await cleanupStore.createCleanupTask(cleanupInput);
  assert.deepStrictEqual(pending, {
    cleanupId: '20000000-0000-4000-8000-000000000002',
    status: 'pending',
    created: true
  });
  assert.strictEqual(cleanupPool.state.manifests.length, 1);
  assert.strictEqual(cleanupPool.state.tasks.length, 1);
  assert(
    cleanupPool.calls.some(call => (
      /INNER JOIN nv_alpha_cleanup_tasks task/.test(call.sql)
      && /FOR UPDATE OF manifest,task/.test(call.sql)
    )),
    'the production query must lock the guaranteed manifest/task pair without an outer join'
  );
  assert.notStrictEqual(
    cleanupPool.state.manifests[0].manifest_id,
    cleanupPool.state.tasks[0].cleanup_id,
    'manifest identity must be separate from mutable task identity'
  );
  assert.deepStrictEqual(
    cleanupPool.state.tasks[0].resource_key_hash,
    cleanupPool.state.manifests[0].resource_key_hash
  );

  const repeated = await cleanupStore.createCleanupTask(cleanupInput);
  assert.deepStrictEqual(repeated, {
    cleanupId: pending.cleanupId,
    status: 'pending',
    created: false
  });
  assert.strictEqual(cleanupPool.state.manifests.length, 1);
  assert.strictEqual(cleanupPool.state.tasks.length, 1);

  cleanupPool.state.deletions.push({
    request_id: '30000000-0000-4000-8000-000000000001',
    tester_id: TESTER_ID,
    status: 'blocked',
    blocked_cleanup_ids: [pending.cleanupId],
    requested_at: NOW,
    completed_at: null
  });
  const verified = await cleanupStore.completeCleanupTask({
    testerId: TESTER_ID,
    cleanupId: pending.cleanupId
  });
  assert.deepStrictEqual(verified, {
    cleanupId: pending.cleanupId,
    status: 'verified',
    verifiedAt: NOW.toISOString()
  });
  const verifiedAgain = await cleanupStore.completeCleanupTask({
    testerId: TESTER_ID,
    cleanupId: pending.cleanupId
  });
  assert.deepStrictEqual(verifiedAgain, verified, 'verified cleanup is idempotent and monotonic');

  cleanupPool.state.deletions[0].status = 'requested';
  await assert.rejects(
    () => cleanupStore.completeCleanupTask({ testerId: TESTER_ID, cleanupId: pending.cleanupId }),
    error => error && error.code === 'ALPHA_TESTER_DELETING'
  );

  const rollbackPool = new FakePool();
  const rollbackStore = makeStore(rollbackPool);
  await rollbackStore.bindProviderIdentity(input);
  rollbackPool.failTaskInsert = true;
  await assert.rejects(
    () => rollbackStore.createCleanupTask(cleanupInput),
    /injected task insert failure/
  );
  assert.strictEqual(rollbackPool.state.manifests.length, 0, 'rollback must remove manifest insert');
  assert.strictEqual(rollbackPool.state.tasks.length, 0, 'rollback must remove partial task state');

  const deletionPool = new FakePool();
  const deletionStore = makeStore(deletionPool);
  await deletionStore.bindProviderIdentity(input);
  const deletionTask = await deletionStore.createCleanupTask(cleanupInput);
  deletionPool.state.sessions.push({
    session_id: 'alpha-session', tester_id: TESTER_ID, revoked_at: null
  });
  const blocked = await deletionStore.createDeletionRequest({ testerId: TESTER_ID });
  assert.deepStrictEqual(blocked, {
    status: 'blocked',
    providerCleanupVerified: false,
    blockedCleanupIds: [deletionTask.cleanupId],
    cleanupBlocks: [{
      code: 'CLEANUP_UNVERIFIED',
      count: 1,
      cleanupIds: [deletionTask.cleanupId]
    }]
  });
  assert(deletionPool.state.sessions[0].revoked_at instanceof Date);
  assert(!JSON.stringify(blocked).includes(input.identityKey));
  assert(!JSON.stringify(blocked).includes(cleanupInput.resourceKeyHash));

  await deletionStore.completeCleanupTask({
    testerId: TESTER_ID,
    cleanupId: deletionTask.cleanupId
  });
  const requested = await deletionStore.createDeletionRequest({ testerId: TESTER_ID });
  assert.deepStrictEqual(requested, {
    status: 'requested',
    providerCleanupVerified: true,
    blockedCleanupIds: [],
    cleanupBlocks: []
  });
  await assert.rejects(
    () => deletionStore.bindProviderIdentity(input),
    error => error && error.code === 'ALPHA_TESTER_DELETING'
  );
  assert.strictEqual(deletionPool.state.manifests.length, 1);
  assert.strictEqual(deletionPool.state.tasks.length, 1);

  const zeroResourcePool = new FakePool();
  const zeroResourceStore = makeStore(zeroResourcePool);
  await zeroResourceStore.bindProviderIdentity(input);
  const zeroResource = await zeroResourceStore.createDeletionRequest({ testerId: TESTER_ID });
  assert.deepStrictEqual(zeroResource, {
    status: 'blocked',
    providerCleanupVerified: false,
    blockedCleanupIds: [],
    cleanupBlocks: [{ code: 'CLEANUP_MISSING', count: 1, cleanupIds: [] }]
  }, 'an active zero-resource binding is never implicit cleanup proof');

  const emptyTesterPool = new FakePool();
  const emptyTesterStore = makeStore(emptyTesterPool);
  const emptyTester = await emptyTesterStore.createDeletionRequest({ testerId: TESTER_ID });
  assert.deepStrictEqual(emptyTester, {
    status: 'blocked',
    providerCleanupVerified: false,
    blockedCleanupIds: [],
    cleanupBlocks: [{ code: 'CLEANUP_MISSING', count: 1, cleanupIds: [] }]
  }, 'an empty tester lifecycle is never implicit provider cleanup proof');

  const mismatchPool = new FakePool();
  const mismatchStore = makeStore(mismatchPool);
  await mismatchStore.bindProviderIdentity(input);
  const expectedTask = await mismatchStore.createCleanupTask(cleanupInput);
  const replacementTask = await mismatchStore.createCleanupTask({
    ...cleanupInput,
    resourceKeyHash: 'c'.repeat(64)
  });
  await mismatchStore.completeCleanupTask({ testerId: TESTER_ID, cleanupId: expectedTask.cleanupId });
  await mismatchStore.completeCleanupTask({ testerId: TESTER_ID, cleanupId: replacementTask.cleanupId });
  mismatchPool.state.tasks.find(item => (
    item.cleanup_id === replacementTask.cleanupId
  )).resource_key_hash = cleanupInput.resourceKeyHash;
  const mismatch = await mismatchStore.createDeletionRequest({ testerId: TESTER_ID });
  assert.strictEqual(mismatch.status, 'blocked');
  assert.strictEqual(mismatch.providerCleanupVerified, false);
  assert.deepStrictEqual(mismatch.blockedCleanupIds, [
    expectedTask.cleanupId,
    replacementTask.cleanupId
  ].sort());
  assert.deepStrictEqual(mismatch.cleanupBlocks, [
    {
      code: 'CLEANUP_EXTRA',
      count: 1,
      cleanupIds: [
        expectedTask.cleanupId,
        replacementTask.cleanupId
      ].sort()
    },
    { code: 'CLEANUP_MISMATCHED', count: 1, cleanupIds: [replacementTask.cleanupId] },
    { code: 'CLEANUP_MISSING', count: 1, cleanupIds: [] },
    {
      code: 'CLEANUP_REPLACEMENT',
      count: 1,
      cleanupIds: [replacementTask.cleanupId]
    }
  ]);

  const orphanPool = new FakePool();
  const orphanStore = makeStore(orphanPool);
  await orphanStore.bindProviderIdentity(input);
  orphanPool.state.tasks.push({
    cleanup_id: '40000000-0000-4000-8000-000000000003',
    manifest_id: '40000000-0000-4000-8000-000000000004',
    tester_id: TESTER_ID,
    identity_key: input.identityKey,
    provider: input.provider,
    resource_type: 'provider-webhook',
    resource_key_hash: '4'.repeat(64),
    status: 'verified',
    verified_at: NOW
  });
  const orphan = await orphanStore.createDeletionRequest({ testerId: TESTER_ID });
  assert.deepStrictEqual(orphan.cleanupBlocks, [
    { code: 'CLEANUP_MISSING', count: 1, cleanupIds: [] },
    {
      code: 'CLEANUP_ORPHAN',
      count: 1,
      cleanupIds: ['40000000-0000-4000-8000-000000000003']
    }
  ]);
  assert(!JSON.stringify(orphan.cleanupBlocks).includes(input.identityKey));
  assert(!JSON.stringify(orphan.cleanupBlocks).includes('4'.repeat(64)));

  const revokedPool = new FakePool();
  revokedPool.state.testers[0].revoked_at = NOW;
  const revokedStore = makeStore(revokedPool);
  await assert.rejects(
    () => revokedStore.bindProviderIdentity(input),
    error => error && error.code === 'ALPHA_TESTER_REVOKED'
  );
  await assert.rejects(
    () => revokedStore.createDeletionRequest({ testerId: TESTER_ID }),
    error => error && error.code === 'ALPHA_TESTER_REVOKED'
  );

  const disconnectPool = new FakePool();
  const disconnectStore = makeStore(disconnectPool);
  await disconnectStore.bindProviderIdentity(input);
  const disconnectTask = await disconnectStore.createCleanupTask(cleanupInput);
  await assert.rejects(
    () => disconnectStore.markProviderIdentityDisconnected({
      testerId: TESTER_ID,
      identityKey: input.identityKey,
      provider: input.provider
    }),
    error => error && error.code === 'ALPHA_PROVIDER_CLEANUP_UNVERIFIED'
  );
  assert.strictEqual(disconnectPool.state.bindings[0].disconnected_at, null);
  await disconnectStore.completeCleanupTask({
    testerId: TESTER_ID,
    cleanupId: disconnectTask.cleanupId
  });
  const disconnected = await disconnectStore.markProviderIdentityDisconnected({
    testerId: TESTER_ID,
    identityKey: input.identityKey,
    provider: input.provider
  });
  assert.deepStrictEqual(disconnected, {
    disconnected: true,
    disconnectedAt: NOW.toISOString()
  });
  const terminalTask = await disconnectStore.createCleanupTask(cleanupInput);
  assert.deepStrictEqual(terminalTask, {
    cleanupId: disconnectTask.cleanupId,
    status: 'verified',
    created: false
  }, 'an exact immutable cleanup task must be reusable after binding disconnect');
  await assert.rejects(
    () => disconnectStore.bindProviderIdentity(input),
    error => error && error.code === 'ALPHA_PROVIDER_LIFECYCLE_STARTED'
  );

  const ownershipPool = new FakePool();
  ownershipPool.state.testers.push({ tester_id: OTHER_TESTER_ID, revoked_at: null });
  const ownershipStore = makeStore(ownershipPool);
  await ownershipStore.bindProviderIdentity(input);
  await ownershipStore.bindProviderIdentity({ ...input, testerId: OTHER_TESTER_ID });
  const sessionKeyHash = 'c'.repeat(64);
  const claimed = await ownershipStore.claimProviderSessionOwnership({
    testerId: TESTER_ID,
    identityKey: input.identityKey,
    provider: input.provider,
    sessionKeyHash
  });
  assert.deepStrictEqual(claimed, {
    claimed: true,
    claimedAt: NOW.toISOString()
  });
  const claimedAgain = await ownershipStore.claimProviderSessionOwnership({
    testerId: TESTER_ID,
    identityKey: input.identityKey,
    provider: input.provider,
    sessionKeyHash
  });
  assert.deepStrictEqual(claimedAgain, {
    claimed: false,
    claimedAt: NOW.toISOString()
  });
  await assert.rejects(
    () => ownershipStore.claimProviderSessionOwnership({
      testerId: OTHER_TESTER_ID,
      identityKey: input.identityKey,
      provider: input.provider,
      sessionKeyHash
    }),
    error => error && error.code === 'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
  );
  assert.strictEqual(ownershipPool.state.ownership.length, 1);
  assert.strictEqual(ownershipPool.state.ownership[0].session_key_hash, sessionKeyHash);
  assert(!JSON.stringify(claimed).includes(sessionKeyHash));

  const otherSessionKeyHash = '9'.repeat(64);
  await ownershipStore.claimProviderSessionOwnership({
    testerId: OTHER_TESTER_ID,
    identityKey: input.identityKey,
    provider: input.provider,
    sessionKeyHash: otherSessionKeyHash
  });
  const ownershipCleanup = await ownershipStore.createCleanupTask({
    ...cleanupInput,
    resourceType: 'provider-session',
    resourceKeyHash: sessionKeyHash
  });
  await ownershipStore.completeCleanupTask({
    testerId: TESTER_ID,
    cleanupId: ownershipCleanup.cleanupId
  });
  await ownershipStore.markProviderIdentityDisconnected({
    testerId: TESTER_ID,
    identityKey: input.identityKey,
    provider: input.provider
  });
  assert(ownershipPool.state.ownership.find(item => (
    item.tester_id === TESTER_ID && item.session_key_hash === sessionKeyHash
  )).released_at instanceof Date, 'disconnect must release the exact tester ownership');
  assert.strictEqual(ownershipPool.state.ownership.find(item => (
    item.tester_id === OTHER_TESTER_ID && item.session_key_hash === otherSessionKeyHash
  )).released_at, null, 'disconnect must preserve cross-tester shared ownership');

  const disconnectRollbackPool = new FakePool();
  const disconnectRollbackStore = makeStore(disconnectRollbackPool);
  await disconnectRollbackStore.bindProviderIdentity(input);
  await disconnectRollbackStore.claimProviderSessionOwnership({
    testerId: TESTER_ID,
    identityKey: input.identityKey,
    provider: input.provider,
    sessionKeyHash
  });
  const rollbackOwnershipTask = await disconnectRollbackStore.createCleanupTask({
    ...cleanupInput,
    resourceType: 'provider-session',
    resourceKeyHash: sessionKeyHash
  });
  await disconnectRollbackStore.completeCleanupTask({
    testerId: TESTER_ID,
    cleanupId: rollbackOwnershipTask.cleanupId
  });
  disconnectRollbackPool.failBindingDisconnect = true;
  await assert.rejects(
    () => disconnectRollbackStore.markProviderIdentityDisconnected({
      testerId: TESTER_ID,
      identityKey: input.identityKey,
      provider: input.provider
    }),
    error => error && error.code === 'ALPHA_PROVIDER_DISCONNECT_CONFLICT'
  );
  assert.strictEqual(disconnectRollbackPool.state.ownership[0].released_at, null,
    'ownership release must roll back when the binding transition conflicts');

  const ownershipRacePool = new FakePool();
  ownershipRacePool.state.testers.push({ tester_id: OTHER_TESTER_ID, revoked_at: null });
  const ownershipRaceStore = makeStore(ownershipRacePool);
  await ownershipRaceStore.bindProviderIdentity(input);
  await ownershipRaceStore.bindProviderIdentity({ ...input, testerId: OTHER_TESTER_ID });
  const ownershipRace = await Promise.allSettled([
    ownershipRaceStore.claimProviderSessionOwnership({
      testerId: TESTER_ID,
      identityKey: input.identityKey,
      provider: input.provider,
      sessionKeyHash
    }),
    ownershipRaceStore.claimProviderSessionOwnership({
      testerId: OTHER_TESTER_ID,
      identityKey: input.identityKey,
      provider: input.provider,
      sessionKeyHash
    })
  ]);
  assert.strictEqual(ownershipRace.filter(item => item.status === 'fulfilled').length, 1);
  assert.strictEqual(ownershipRace.filter(item => item.status === 'rejected').length, 1);
  assert.strictEqual(ownershipRacePool.state.ownership.length, 1);

  const missingSessionProofPool = new FakePool();
  const missingSessionProofStore = makeStore(missingSessionProofPool);
  await missingSessionProofStore.bindProviderIdentity(input);
  await missingSessionProofStore.claimProviderSessionOwnership({
    testerId: TESTER_ID,
    identityKey: input.identityKey,
    provider: input.provider,
    sessionKeyHash
  });
  const unrelatedTask = await missingSessionProofStore.createCleanupTask(cleanupInput);
  await missingSessionProofStore.completeCleanupTask({
    testerId: TESTER_ID,
    cleanupId: unrelatedTask.cleanupId
  });
  const missingSessionProof = await missingSessionProofStore.createDeletionRequest({
    testerId: TESTER_ID
  });
  assert.deepStrictEqual(missingSessionProof, {
    status: 'blocked',
    providerCleanupVerified: false,
    blockedCleanupIds: [],
    cleanupBlocks: [{ code: 'CLEANUP_MISSING', count: 1, cleanupIds: [] }]
  }, 'an ownership claim requires its own verified provider-session manifest item');

  const purgePool = new FakePool();
  const purgeStore = makeStore(purgePool);
  await purgeStore.bindProviderIdentity(input);
  const purgeSessionHash = 'd'.repeat(64);
  await purgeStore.claimProviderSessionOwnership({
    testerId: TESTER_ID,
    identityKey: input.identityKey,
    provider: input.provider,
    sessionKeyHash: purgeSessionHash
  });
  const purgeTask = await purgeStore.createCleanupTask({
    ...cleanupInput,
    resourceType: 'provider-session',
    resourceKeyHash: purgeSessionHash
  });
  await purgeStore.completeCleanupTask({ testerId: TESTER_ID, cleanupId: purgeTask.cleanupId });
  await purgeStore.createDeletionRequest({ testerId: TESTER_ID });
  purgePool.state.sessions.push({ session_id: 'alpha-session', tester_id: TESTER_ID, revoked_at: null });
  purgePool.state.providerSessions.push({ sid: 'provider-session', identity_keys: [input.identityKey] });
  purgePool.state.webhooks.push({ hook_id: 'hook', identity_key: input.identityKey });
  purgePool.state.events.push({ event_id: 'event', identity_key: input.identityKey });
  purgePool.state.snapshots.push({ snapshot_id: 'snapshot', identity_key: input.identityKey });
  purgePool.state.installations.push({ installation_id: 7, identity_key: input.identityKey });
  purgePool.state.security.push({ identity_key: input.identityKey });
  purgePool.state.githubAudit.push({
    event_id: 'app-audit', identity_key: input.identityKey,
    details: { marker: 'exclusive-app-audit-body' }
  });
  purgePool.state.feedback.push({ feedback_id: 'feedback', tester_id: TESTER_ID });
  purgePool.state.governanceAudit.push({
    actor_identity_key: input.identityKey,
    record_hash: '1'.repeat(64),
    previous_hash: 'NEBULAVERSE-GOVERNANCE-GENESIS-V1',
    details_hash: '2'.repeat(64),
    details: { marker: 'exclusive-governance-audit-body' },
    created_at: NOW
  });
  purgePool.state.governanceDecisions.push({
    actor_identity_key: input.identityKey,
    record_hash: '3'.repeat(64),
    previous_hash: 'NV-POLICY-DECISION-GENESIS-V1',
    decision_hash: '4'.repeat(64),
    decision: { marker: 'exclusive-governance-decision-body' },
    created_at: NOW
  });

  const complete = await purgeStore.purgeTester({ testerId: TESTER_ID });
  assert.deepStrictEqual(complete, {
    status: 'complete',
    tokenBearingStateRemoved: true,
    providerCleanupVerified: true,
    retainedIntegrityMetadata: true,
    removed: {
      providerSessions: 1,
      webhooks: 1,
      events: 1,
      snapshots: 1,
      feedback: 1
    },
    completedAt: NOW.toISOString()
  });
  for (const name of [
    'providerSessions', 'webhooks', 'events', 'snapshots', 'installations',
    'security', 'githubAudit', 'feedback', 'governanceAudit', 'governanceDecisions'
  ]) assert.strictEqual(purgePool.state[name].length, 0, `${name} must be removed`);
  assert.strictEqual(purgePool.state.retainedIntegrity.length, 2);
  assert.deepStrictEqual(
    purgePool.state.retainedIntegrity.map(item => Object.keys(item).sort()),
    [
      ['payload_hash', 'previous_hash', 'record_hash', 'record_kind', 'recorded_at', 'retained_at', 'tester_id_hash'].sort(),
      ['payload_hash', 'previous_hash', 'record_hash', 'record_kind', 'recorded_at', 'retained_at', 'tester_id_hash'].sort()
    ]
  );
  assert.strictEqual(purgePool.state.purgeAuthorizations.length, 0);
  assert(purgePool.state.ownership[0].released_at instanceof Date);
  assert(purgePool.state.bindings[0].disconnected_at instanceof Date);
  assert(purgePool.state.testers[0].revoked_at instanceof Date);
  assert.strictEqual(purgePool.state.deletions[0].status, 'complete');
  assert.strictEqual(purgePool.state.purgeReports.length, 1);
  const serializedComplete = JSON.stringify(complete);
  for (const forbidden of [
    input.identityKey, purgeSessionHash, 'provider-session',
    'exclusive-app-audit-body', 'exclusive-governance-audit-body',
    'exclusive-governance-decision-body'
  ]) assert(!serializedComplete.includes(forbidden));

  const repeatedPurge = await purgeStore.purgeTester({ testerId: TESTER_ID });
  assert.deepStrictEqual(repeatedPurge, complete, 'completed purge must be idempotent');
  assert.strictEqual(purgePool.state.purgeReports.length, 1);

  purgePool.state.testers.push({ tester_id: OTHER_TESTER_ID, revoked_at: null });
  const otherSessionHash = 'e'.repeat(64);
  purgePool.state.ownership.push({
    session_key_hash: otherSessionHash,
    tester_id: OTHER_TESTER_ID,
    identity_key: 'f'.repeat(64),
    provider: 'github',
    claimed_at: NOW,
    released_at: null
  });
  purgePool.state.providerSessions.push(
    {
      sid: 'reintroduced-owned-session',
      session_key_hash: purgeSessionHash,
      identity_keys: [input.identityKey],
      revision: 1
    },
    {
      sid: 'other-tester-session',
      session_key_hash: otherSessionHash,
      identity_keys: ['f'.repeat(64)],
      revision: 1
    }
  );
  purgePool.failTerminalSessionScrub = true;
  await assert.rejects(
    () => purgeStore.purgeTester({ testerId: TESTER_ID }),
    /injected terminal session scrub failure/
  );
  assert.deepStrictEqual(
    purgePool.state.providerSessions.map(item => item.sid).sort(),
    ['other-tester-session', 'reintroduced-owned-session'],
    'a failed terminal scrub must roll back every session mutation'
  );

  purgePool.failTerminalSessionScrub = false;
  const terminalRetry = await purgeStore.purgeTester({ testerId: TESTER_ID });
  assert.deepStrictEqual(terminalRetry, complete,
    'terminal retry must preserve the original immutable purge report');
  assert.deepStrictEqual(
    purgePool.state.providerSessions.map(item => item.sid),
    ['other-tester-session'],
    'terminal retry must scrub only the reintroduced session proven owned by the deleted tester'
  );
  const terminalRetryAgain = await purgeStore.purgeTester({ testerId: TESTER_ID });
  assert.deepStrictEqual(terminalRetryAgain, complete);
  assert.deepStrictEqual(purgePool.state.providerSessions.map(item => item.sid), ['other-tester-session']);
  assert.strictEqual(purgePool.state.purgeReports.length, 1,
    'terminal scrubbing must never rewrite the immutable report');

  const sharedPool = new FakePool();
  sharedPool.state.testers.push({ tester_id: OTHER_TESTER_ID, revoked_at: null });
  const sharedStore = makeStore(sharedPool);
  await sharedStore.bindProviderIdentity(input);
  await sharedStore.bindProviderIdentity({ ...input, testerId: OTHER_TESTER_ID });
  const ownerHash = 'e'.repeat(64);
  await sharedStore.claimProviderSessionOwnership({
    testerId: TESTER_ID, identityKey: input.identityKey,
    provider: input.provider, sessionKeyHash: ownerHash
  });
  await sharedStore.claimProviderSessionOwnership({
    testerId: OTHER_TESTER_ID, identityKey: input.identityKey,
    provider: input.provider, sessionKeyHash: 'f'.repeat(64)
  });
  const sharedCleanup = await sharedStore.createCleanupTask({
    ...cleanupInput,
    resourceType: 'provider-session',
    resourceKeyHash: ownerHash
  });
  await sharedStore.completeCleanupTask({ testerId: TESTER_ID, cleanupId: sharedCleanup.cleanupId });
  await sharedStore.createDeletionRequest({ testerId: TESTER_ID });
  sharedPool.state.providerSessions.push({ sid: 'shared-session', identity_keys: [input.identityKey] });
  sharedPool.state.webhooks.push({ hook_id: 'shared-hook', identity_key: input.identityKey });
  sharedPool.state.events.push({ event_id: 'shared-event', identity_key: input.identityKey });
  sharedPool.state.snapshots.push({ snapshot_id: 'shared-snapshot', identity_key: input.identityKey });
  sharedPool.state.installations.push({ installation_id: 8, identity_key: input.identityKey });
  sharedPool.state.security.push({ identity_key: input.identityKey });
  sharedPool.state.githubAudit.push({ event_id: 'shared-audit', identity_key: input.identityKey });
  sharedPool.state.feedback.push({ feedback_id: 'shared-feedback', tester_id: TESTER_ID });
  sharedPool.state.governanceAudit.push({
    actor_identity_key: input.identityKey,
    record_hash: '5'.repeat(64), previous_hash: '6'.repeat(64),
    details_hash: '7'.repeat(64), details: { marker: 'shared-body' }, created_at: NOW
  });

  const sharedComplete = await sharedStore.purgeTester({ testerId: TESTER_ID });
  assert.deepStrictEqual(sharedComplete.removed, {
    providerSessions: 0,
    webhooks: 0,
    events: 0,
    snapshots: 0,
    feedback: 1
  });
  for (const name of [
    'providerSessions', 'webhooks', 'events', 'snapshots', 'installations',
    'security', 'githubAudit', 'governanceAudit'
  ]) assert.strictEqual(sharedPool.state[name].length, 1, `${name} must survive shared identity purge`);
  assert.strictEqual(sharedPool.state.retainedIntegrity.length, 0);
  assert(sharedPool.state.ownership.find(item => item.tester_id === TESTER_ID).released_at);
  assert.strictEqual(
    sharedPool.state.ownership.find(item => item.tester_id === OTHER_TESTER_ID).released_at,
    null
  );

  const pendingPurgePool = new FakePool();
  const pendingPurgeStore = makeStore(pendingPurgePool);
  await pendingPurgeStore.bindProviderIdentity(input);
  const pendingPurgeTask = await pendingPurgeStore.createCleanupTask({
    ...cleanupInput,
    resourceType: 'provider-session'
  });
  await pendingPurgeStore.createDeletionRequest({ testerId: TESTER_ID });
  const stillBlocked = await pendingPurgeStore.purgeTester({ testerId: TESTER_ID });
  assert.deepStrictEqual(stillBlocked, {
    status: 'blocked',
    providerCleanupVerified: false,
    blockedCleanupIds: [pendingPurgeTask.cleanupId],
    cleanupBlocks: [{
      code: 'CLEANUP_UNVERIFIED',
      count: 1,
      cleanupIds: [pendingPurgeTask.cleanupId]
    }]
  });
  assert.strictEqual(pendingPurgePool.state.purgeReports.length, 0);
  assert.deepStrictEqual(pendingPurgePool.state.cleanupBlocks, [{
    request_id: pendingPurgePool.state.deletions[0].request_id,
    block_code: 'CLEANUP_UNVERIFIED',
    blocked_count: 1,
    cleanup_ids: [pendingPurgeTask.cleanupId]
  }]);

  const feedbackPool = new FakePool();
  const feedbackStore = makeStore(feedbackPool);
  const feedbackResult = await feedbackStore.recordFeedback({
    testerId: TESTER_ID,
    releaseVersion: '5.3.0-alpha.17.0',
    correlationId: 'nvx-1234567890abcdef',
    provider: 'github',
    feature: 'repository-health',
    capabilityStatus: 'Supported',
    errorCode: 'EVIDENCE_STALE',
    runtime: 'safari',
    occurredAt: NOW
  });
  assert.deepStrictEqual(feedbackResult, {
    recorded: true,
    createdAt: NOW.toISOString()
  });
  assert.deepStrictEqual(Object.keys(feedbackPool.state.feedback[0]).sort(), [
    'capability_status', 'correlation_id', 'created_at', 'error_code',
    'feature', 'feedback_id', 'occurred_at', 'provider', 'release_version',
    'runtime', 'tester_id'
  ].sort());
  const serializedFeedback = JSON.stringify(feedbackPool.state.feedback[0]);
  for (const forbidden of [
    'arbitrary prose', 'private source body', 'private provider body',
    'description', 'repositoryContent', 'providerPayload'
  ]) assert(!serializedFeedback.includes(forbidden));

  for (const prohibited of [
    { description: 'arbitrary prose must not cross the boundary' },
    { repositoryContent: 'private source body' },
    { providerPayload: { marker: 'private provider body' } },
    { unexpected: 'unknown field' }
  ]) {
    await assert.rejects(
      () => feedbackStore.recordFeedback({
        testerId: TESTER_ID,
        releaseVersion: '5.3.0-alpha.17.0',
        correlationId: 'nvx-rejected-field',
        provider: 'github',
        feature: 'repository-health',
        capabilityStatus: 'Supported',
        errorCode: 'EVIDENCE_STALE',
        runtime: 'safari',
        occurredAt: NOW,
        ...prohibited
      }),
      error => error && error.code === 'ALPHA_FEEDBACK_FIELDS_REJECTED'
    );
  }
  assert.strictEqual(feedbackPool.state.feedback.length, 1);

  for (const invalid of [
    { feature: 'free text feature value' },
    { capabilityStatus: 'Maybe' },
    { errorCode: 'free text error' },
    { runtime: 'Safari iOS arbitrary' },
    { correlationId: 'correlation value with spaces' }
  ]) {
    await assert.rejects(
      () => feedbackStore.recordFeedback({
        testerId: TESTER_ID,
        releaseVersion: '5.3.0-alpha.17.0',
        correlationId: 'nvx-1234567890abcdef',
        provider: 'github',
        feature: 'repository-health',
        capabilityStatus: 'Supported',
        errorCode: 'EVIDENCE_STALE',
        runtime: 'safari',
        occurredAt: NOW,
        ...invalid
      }),
      TypeError
    );
  }

  const racePool = new FakePool();
  const raceStore = makeStore(racePool);
  await raceStore.createDeletionRequest({ testerId: TESTER_ID });
  const purgeWriterRace = await Promise.allSettled([
    raceStore.purgeTester({ testerId: TESTER_ID }),
    raceStore.recordFeedback({
      testerId: TESTER_ID,
      releaseVersion: '5.3.0-alpha.17.0',
      correlationId: 'nvx-race',
      provider: 'github',
      feature: 'repository-health',
      capabilityStatus: 'Supported',
      errorCode: 'EVIDENCE_STALE',
      runtime: 'node',
      occurredAt: NOW
    })
  ]);
  assert.strictEqual(purgeWriterRace[0].status, 'fulfilled');
  assert.strictEqual(purgeWriterRace[1].status, 'rejected');
  assert([
    'ALPHA_TESTER_DELETING', 'ALPHA_TESTER_REVOKED'
  ].includes(purgeWriterRace[1].reason.code));
  assert.strictEqual(racePool.state.feedback.length, 0, 'writer cannot race completed purge');

  const retentionPool = new FakePool();
  const retentionStore = makeStore(retentionPool);
  await retentionStore.bindProviderIdentity(input);
  const closed = await retentionStore.cohortClose({ closedAt: NOW });
  assert.deepStrictEqual(closed, {
    created: true,
    closedAt: NOW.toISOString(),
    purgeAfter: '2026-08-28T18:00:00.000Z'
  });
  const closedAgain = await retentionStore.cohortClose({ closedAt: NOW });
  assert.deepStrictEqual(closedAgain, { ...closed, created: false });
  await assert.rejects(
    () => retentionStore.cohortClose({
      closedAt: new Date('2026-07-30T18:00:00.000Z')
    }),
    error => error && error.code === 'ALPHA_COHORT_CLOSE_CONFLICT'
  );

  const day = 24 * 60 * 60 * 1000;
  const old7 = new Date(NOW.getTime() - 8 * day);
  const old14 = new Date(NOW.getTime() - 15 * day);
  const old30 = new Date(NOW.getTime() - 31 * day);
  const young = new Date(NOW.getTime() - day);
  retentionPool.state.sessions.push(
    { session_id: 'old-alpha', tester_id: TESTER_ID, created_at: old7, expires_at: NOW },
    { session_id: 'young-alpha', tester_id: TESTER_ID, created_at: young, expires_at: new Date(NOW.getTime() + day) }
  );
  retentionPool.state.providerSessions.push(
    { sid: 'old-provider', identity_keys: [input.identityKey], updated: old7 },
    { sid: 'young-provider', identity_keys: [input.identityKey], updated: young }
  );
  retentionPool.state.events.push(
    { event_id: 'old-event', identity_key: input.identityKey, created_at: old30 },
    { event_id: 'young-event', identity_key: input.identityKey, created_at: young }
  );
  retentionPool.state.snapshots.push(
    { snapshot_id: 'old-snapshot', identity_key: input.identityKey, created_at: old30 },
    { snapshot_id: 'young-snapshot', identity_key: input.identityKey, created_at: young }
  );
  retentionPool.state.exports.push(
    { export_id: 'old-export', actor_identity_key: input.identityKey, created_at: old30 },
    { export_id: 'young-export', actor_identity_key: input.identityKey, created_at: young }
  );
  retentionPool.state.feedback.push(
    { feedback_id: 'old-feedback', tester_id: TESTER_ID, created_at: old14 },
    { feedback_id: 'young-feedback', tester_id: TESTER_ID, created_at: young }
  );
  retentionPool.state.testers[0].revoked_at = old30;
  retentionPool.state.deletions.push({
    request_id: '60000000-0000-4000-8000-000000000001',
    tester_id: TESTER_ID,
    status: 'requested',
    blocked_cleanup_ids: [],
    requested_at: old30,
    completed_at: null
  });

  const retention = await retentionStore.runRetention();
  assert.deepStrictEqual(retention, {
    alphaSessionsRemoved: 1,
    providerSessionsRemoved: 1,
    eventsRemoved: 1,
    snapshotsRemoved: 1,
    evidenceExportsRemoved: 1,
    feedbackRemoved: 1,
    testerMetadataPurged: 0,
    inviteMetadataPurged: 0,
    cohortMetadataPreserved: true,
    completedAt: NOW.toISOString()
  });
  for (const name of ['sessions', 'providerSessions', 'events', 'snapshots', 'exports', 'feedback']) {
    assert.strictEqual(retentionPool.state[name].length, 1, `${name} must retain its young row`);
  }
  assert.strictEqual(retentionPool.state.testers.length, 1);
  assert.strictEqual(retentionPool.state.bindings.length, 1);

  const boundaryPool = new FakePool();
  boundaryPool.state.cohort = {
    cohort_key: 'public-alpha-17',
    closed_at: NOW,
    purge_after: new Date(NOW.getTime() + 30 * day),
    created_at: NOW
  };
  boundaryPool.state.invites.push({
    invite_id: 'alpha17invite0000000001',
    secret_digest: '8'.repeat(64),
    tester_label: 'Tester One',
    repository_scopes: ['owner/repository'],
    terms_version: '2026-07-29',
    created_at: old30,
    expires_at: NOW,
    redeemed_at: NOW,
    revoked_at: old30,
    metadata_purged_at: null
  });
  Object.assign(boundaryPool.state.testers[0], {
    invite_id: 'alpha17invite0000000001',
    tester_label: 'Tester One',
    repository_scopes: ['owner/repository'],
    terms_version: '2026-07-29',
    terms_accepted_at: NOW,
    created_at: old30,
    revoked_at: old30,
    revocation_reason: 'COHORT_CLOSED',
    metadata_purged_at: null
  });
  const boundary = new Date(NOW.getTime() + 30 * day);
  const boundaryStore = makeStore(boundaryPool, boundary);
  const boundaryRetention = await boundaryStore.runRetention();
  assert.deepStrictEqual(boundaryRetention, {
    alphaSessionsRemoved: 0,
    providerSessionsRemoved: 0,
    eventsRemoved: 0,
    snapshotsRemoved: 0,
    evidenceExportsRemoved: 0,
    feedbackRemoved: 0,
    testerMetadataPurged: 1,
    inviteMetadataPurged: 1,
    cohortMetadataPreserved: false,
    completedAt: boundary.toISOString()
  });
  assert.deepStrictEqual(
    Object.fromEntries([
      'tester_label', 'repository_scopes', 'terms_version', 'terms_accepted_at',
      'created_at', 'revoked_at', 'revocation_reason'
    ].map(key => [key, boundaryPool.state.testers[0][key]])),
    {
      tester_label: null,
      repository_scopes: null,
      terms_version: null,
      terms_accepted_at: null,
      created_at: null,
      revoked_at: null,
      revocation_reason: null
    }
  );
  assert.deepStrictEqual(
    Object.fromEntries([
      'secret_digest', 'tester_label', 'repository_scopes', 'terms_version',
      'created_at', 'expires_at', 'redeemed_at', 'revoked_at'
    ].map(key => [key, boundaryPool.state.invites[0][key]])),
    {
      secret_digest: null,
      tester_label: null,
      repository_scopes: null,
      terms_version: null,
      created_at: null,
      expires_at: null,
      redeemed_at: null,
      revoked_at: null
    }
  );
  assert(boundaryPool.state.testers[0].metadata_purged_at instanceof Date);
  assert(boundaryPool.state.invites[0].metadata_purged_at instanceof Date);
  const testerPurgeCall = boundaryPool.calls.findIndex(call => (
    /UPDATE nv_alpha_testers SET tester_label=NULL/.test(call.sql)
  ));
  const invitePurgeCall = boundaryPool.calls.findIndex(call => (
    /UPDATE nv_alpha_invites SET secret_digest=NULL/.test(call.sql)
  ));
  assert(testerPurgeCall >= 0 && invitePurgeCall > testerPurgeCall,
    'cohort metadata purge must clear tester revocation metadata before invite metadata');
  assert(boundaryPool.calls.some(call => /pg_advisory_xact_lock/.test(call.sql)),
    'cohort metadata purge must share the privacy lifecycle lock');
  await assert.rejects(
    () => boundaryStore.recordFeedback({
      testerId: TESTER_ID,
      releaseVersion: '5.3.0-alpha.17.0',
      correlationId: 'nvx-after-metadata-purge',
      provider: 'github',
      feature: 'repository-health',
      capabilityStatus: 'Supported',
      errorCode: 'EVIDENCE_STALE',
      runtime: 'node',
      occurredAt: boundary
    }),
    error => error && error.code === 'ALPHA_TESTER_REVOKED'
  );

  console.log('alpha privacy store tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
