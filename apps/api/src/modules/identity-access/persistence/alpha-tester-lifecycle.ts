import type { PoolClient } from '../../../platform/persistence/queryable.ts';
import {
  requirePlainObject, toDate, rowsOf, AlphaPrivacyStoreError, requireTesterId, requireHash, toIso, onlyRow,
  requireProvider, testerPurgeHash, purgeReportFromRow, FEEDBACK_INPUT_FIELDS, requirePattern, RELEASE_VERSION_RX,
  CORRELATION_ID_RX, FEATURE_RX, requireEnum, CAPABILITY_STATUSES, ERROR_CODE_RX, RUNTIMES, DAY_MS
} from './alpha-privacy-records.ts';
import type { AlphaPrivacyStoreContext } from './alpha-privacy-store.ts';

/*
 * A tester's last steps and the cohort's: a tester purged with a report of
 * what went, feedback recorded within its bounds, a cohort closed, and the
 * retention that removes what is past its time.
 */

export async function scrubCompletedTesterSessions(store: AlphaPrivacyStoreContext, client: PoolClient, testerId: string): Promise<number | null | undefined> {
  const ownershipResult = await client.query(
    `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
       FROM nv_alpha_provider_session_ownership
      WHERE session_key_hash IN (
        SELECT DISTINCT session_key_hash
          FROM nv_alpha_provider_session_ownership
         WHERE tester_id=$1
      )
      ORDER BY session_key_hash,tester_id,identity_key,provider FOR UPDATE`,
    [testerId]
  );
  const ownersByHash = new Map<string, Set<string>>();
  for (const row of rowsOf(ownershipResult)) {
    const sessionKeyHash = requireHash(row.session_key_hash, 'owned sessionKeyHash');
    const owners = ownersByHash.get(sessionKeyHash) || new Set<string>();
    owners.add(String(row.tester_id || '').toLowerCase());
    ownersByHash.set(sessionKeyHash, owners);
  }
  const exclusivelyOwnedHashes = [...ownersByHash]
    .filter(([, owners]) => owners.size === 1 && owners.has(testerId))
    .map(([sessionKeyHash]) => sessionKeyHash)
    .sort();
  if (!exclusivelyOwnedHashes.length) return 0;
  const removed = await client.query(
    `DELETE FROM nv_sessions
      WHERE session_key_hash=ANY($1::text[])
      RETURNING sid`,
    [exclusivelyOwnedHashes]
  );
  return removed.rowCount;
}

export async function purgeTester(store: AlphaPrivacyStoreContext, input: unknown) {
  const purge = requirePlainObject(input, 'tester purge input');
  const testerId = requireTesterId(purge.testerId);
  const testerIdHash = testerPurgeHash(testerId);
  const now = store.currentTime();

  return store.withLifecycleTransaction(
    testerId,
    { allowDeletion: true, allowRevoked: true },
    async (client, lifecycle) => {
      const previousReport = await client.query(
        `SELECT status,token_bearing_state_removed,provider_cleanup_verified,
                retained_integrity_metadata,provider_sessions_removed,
                webhooks_removed,events_removed,snapshots_removed,feedback_removed,
                completed_at
           FROM nv_alpha_purge_reports WHERE tester_id_hash=$1`,
        [testerIdHash]
      );
      if (rowsOf(previousReport)[0]) {
        await store.scrubCompletedTesterSessions(client, testerId);
        return purgeReportFromRow(onlyRow(previousReport));
      }
      if (!lifecycle.deletion) {
        throw new AlphaPrivacyStoreError(
          'Deletion request is required before purge',
          'ALPHA_DELETION_REQUEST_REQUIRED'
        );
      }

      const readiness = await store.cleanupReadiness(client, testerId);
      if (!readiness.verified) {
        if (lifecycle.deletion.status === 'blocked') {
          await client.query(
            `UPDATE nv_alpha_deletion_requests
                SET status=$2,blocked_cleanup_ids=$3
              WHERE tester_id=$1
              RETURNING request_id,status,blocked_cleanup_ids,requested_at,completed_at`,
            [testerId, 'blocked', [...readiness.blockedCleanupIds]]
          );
        }
        await store.replaceCleanupBlocks(
          client,
          lifecycle.deletion.request_id,
          readiness.cleanupBlocks
        );
        return Object.freeze({
          status: 'blocked',
          providerCleanupVerified: false,
          blockedCleanupIds: readiness.blockedCleanupIds,
          cleanupBlocks: readiness.cleanupBlocks
        });
      }
      if (lifecycle.deletion.status === 'complete') {
        throw new AlphaPrivacyStoreError(
          'Completed deletion is missing its immutable report',
          'ALPHA_PURGE_REPORT_MISSING'
        );
      }
      if (lifecycle.deletion.status === 'blocked') {
        await client.query(
          `UPDATE nv_alpha_deletion_requests
              SET status=$2,blocked_cleanup_ids=$3
            WHERE tester_id=$1
            RETURNING request_id,status,blocked_cleanup_ids,requested_at,completed_at`,
          [testerId, 'requested', []]
        );
      }
      await store.replaceCleanupBlocks(client, lifecycle.deletion.request_id, []);

      await client.query(
        `UPDATE nv_alpha_sessions
            SET revoked_at=COALESCE(revoked_at,$2)
          WHERE tester_id=$1`,
        [testerId, now]
      );
      await client.query(
        `UPDATE nv_alpha_provider_bindings
            SET disconnected_at=COALESCE(disconnected_at,$2)
          WHERE tester_id=$1`,
        [testerId, now]
      );
      const exclusiveResult = await client.query(
        `SELECT DISTINCT binding.identity_key
           FROM nv_alpha_provider_bindings binding
          WHERE binding.tester_id=$1
            AND NOT EXISTS (
              SELECT 1
                FROM nv_alpha_provider_bindings shared_binding
                JOIN nv_alpha_testers shared_tester
                  ON shared_tester.tester_id=shared_binding.tester_id
               WHERE shared_binding.identity_key=binding.identity_key
                 AND shared_binding.tester_id<>$1
                 AND shared_binding.disconnected_at IS NULL
                 AND shared_tester.revoked_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
                FROM nv_alpha_provider_session_ownership shared_owner
                JOIN nv_alpha_testers owner_tester
                  ON owner_tester.tester_id=shared_owner.tester_id
               WHERE shared_owner.identity_key=binding.identity_key
                 AND shared_owner.tester_id<>$1
                 AND shared_owner.released_at IS NULL
                 AND owner_tester.revoked_at IS NULL
            )
          ORDER BY binding.identity_key`,
        [testerId]
      );
      const exclusiveIdentityKeys = rowsOf(exclusiveResult).map(row => row.identity_key);

      await client.query(
        `INSERT INTO nv_alpha_retained_integrity(
           tester_id_hash,record_kind,record_hash,previous_hash,payload_hash,
           recorded_at,retained_at
         )
         SELECT $1,'governance-audit',record_hash,previous_hash,details_hash,
                created_at,$3::timestamptz
           FROM nv_governance_audit
          WHERE actor_identity_key=ANY($2::text[])
         UNION ALL
         SELECT $1,'governance-decision',record_hash,previous_hash,decision_hash,
                created_at,$3::timestamptz
           FROM nv_governance_policy_decisions
          WHERE actor_identity_key=ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [testerIdHash, exclusiveIdentityKeys, now]
      );
      await client.query(
        `INSERT INTO nv_alpha_audit_purge_authorizations(
           tester_id,tester_id_hash,identity_key,record_kind,record_hash,
           previous_hash,payload_hash,created_at
         )
         SELECT $1::uuid,$2,actor_identity_key,'governance-audit',record_hash,
                previous_hash,details_hash,$4::timestamptz
           FROM nv_governance_audit
          WHERE actor_identity_key=ANY($3::text[])
         UNION ALL
         SELECT $1::uuid,$2,actor_identity_key,'governance-decision',record_hash,
                previous_hash,decision_hash,$4::timestamptz
           FROM nv_governance_policy_decisions
          WHERE actor_identity_key=ANY($3::text[])`,
        [testerId, testerIdHash, exclusiveIdentityKeys, now]
      );
      await client.query(
        `DELETE FROM nv_governance_audit
          WHERE actor_identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      await client.query(
        `DELETE FROM nv_governance_policy_decisions
          WHERE actor_identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      await client.query(
        `DELETE FROM nv_alpha_audit_purge_authorizations WHERE tester_id=$1`,
        [testerId]
      );

      const providerSessions = await client.query(
        `DELETE FROM nv_sessions session
          WHERE session.identity_keys && $2::text[]
            AND NOT EXISTS (
              SELECT 1 FROM nv_alpha_provider_bindings shared_binding
              JOIN nv_alpha_testers shared_tester
                ON shared_tester.tester_id=shared_binding.tester_id
              WHERE shared_binding.tester_id<>$1
                AND shared_binding.identity_key=ANY(session.identity_keys)
                AND shared_binding.disconnected_at IS NULL
                AND shared_tester.revoked_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM nv_alpha_provider_session_ownership shared_owner
              JOIN nv_alpha_testers owner_tester
                ON owner_tester.tester_id=shared_owner.tester_id
              WHERE shared_owner.tester_id<>$1
                AND shared_owner.identity_key=ANY(session.identity_keys)
                AND shared_owner.released_at IS NULL
                AND owner_tester.revoked_at IS NULL
            )`,
        [testerId, exclusiveIdentityKeys]
      );
      const webhooks = await client.query(
        `DELETE FROM nv_webhooks WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      const events = await client.query(
        `DELETE FROM nv_intelligence_events WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      const snapshots = await client.query(
        `DELETE FROM nv_recovery_snapshots WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      await client.query(
        `DELETE FROM nv_github_app_installations WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      await client.query(
        `DELETE FROM nv_security_state WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      await client.query(
        `DELETE FROM nv_github_app_audit WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      /*
       * Exposure scanning, added alongside the tables it owns rather than
       * afterwards. A scan and its findings are things this server learned
       * about somebody's repository -- bounded locations, a keyed fingerprint,
       * a placeholder -- and none of it should outlive the tester it was
       * learned for.
       *
       * Observations are deliberately not listed. They reference their scan
       * with ON DELETE CASCADE, so they leave with it; a second delete here
       * would make two places responsible for the same rows and one of them
       * would eventually be wrong.
       */
      await client.query(
        `DELETE FROM nv_exposure_scans WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      await client.query(
        `DELETE FROM nv_exposure_findings WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      /*
       * Repository audits, by the same key. Their findings, components and
       * watch alerts reference the audit with ON DELETE CASCADE and leave
       * with it, for the reason observations leave with their scan.
       */
      await client.query(
        `DELETE FROM nv_code_audits WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      /*
       * The time to fix those audits measured, by the same key. And the
       * tester's triage: a decision is shared with a repository's other
       * collaborators, but it carries the tester's name, so it leaves with
       * them -- the findings it covered read as open again -- and so does
       * every event that records them deciding or reopening.
       */
      await client.query(
        `DELETE FROM nv_code_audit_resolutions WHERE identity_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      await client.query(
        `DELETE FROM nv_code_audit_triage WHERE decided_by_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      await client.query(
        `DELETE FROM nv_code_audit_triage_events WHERE actor_key=ANY($1::text[])`,
        [exclusiveIdentityKeys]
      );
      const feedback = await client.query(
        `DELETE FROM nv_alpha_feedback WHERE tester_id=$1`,
        [testerId]
      );
      await client.query(
        `UPDATE nv_alpha_provider_session_ownership
            SET released_at=COALESCE(released_at,$2)
          WHERE tester_id=$1`,
        [testerId, now]
      );
      await client.query(
        `UPDATE nv_alpha_testers
            SET revoked_at=COALESCE(revoked_at,$2)
          WHERE tester_id=$1`,
        [testerId, now]
      );
      await client.query(
        `UPDATE nv_alpha_deletion_requests
            SET status='complete',blocked_cleanup_ids='{}'::uuid[],completed_at=$2
          WHERE tester_id=$1 AND status='requested'
          RETURNING request_id,status,completed_at`,
        [testerId, now]
      );

      const insertedReport = await client.query(
        `INSERT INTO nv_alpha_purge_reports(
           report_id,tester_id_hash,status,token_bearing_state_removed,
           provider_cleanup_verified,retained_integrity_metadata,
           provider_sessions_removed,webhooks_removed,events_removed,
           snapshots_removed,feedback_removed,completed_at,created_at
         ) VALUES($1,$2,'complete',true,true,true,$3,$4,$5,$6,$7,$8,$8)
         RETURNING status,token_bearing_state_removed,provider_cleanup_verified,
                   retained_integrity_metadata,provider_sessions_removed,
                   webhooks_removed,events_removed,snapshots_removed,feedback_removed,
                   completed_at`,
        [
          store.nextUuid('purge report'),
          testerIdHash,
          providerSessions.rowCount,
          webhooks.rowCount,
          events.rowCount,
          snapshots.rowCount,
          feedback.rowCount,
          now
        ]
      );
      return purgeReportFromRow(onlyRow(insertedReport));
    }
  );
}

export async function recordFeedback(store: AlphaPrivacyStoreContext, input: unknown) {
  const feedback = requirePlainObject(input, 'feedback input');
  if (Object.keys(feedback).some(key => !FEEDBACK_INPUT_FIELDS.has(key))) {
    throw new AlphaPrivacyStoreError(
      'Feedback contains unsupported fields',
      'ALPHA_FEEDBACK_FIELDS_REJECTED'
    );
  }
  const testerId = requireTesterId(feedback.testerId);
  const releaseVersion = requirePattern(
    feedback.releaseVersion,
    RELEASE_VERSION_RX,
    'releaseVersion'
  );
  const correlationId = requirePattern(
    feedback.correlationId,
    CORRELATION_ID_RX,
    'correlationId'
  );
  const provider = requireProvider(feedback.provider);
  const feature = requirePattern(feedback.feature, FEATURE_RX, 'feature');
  const capabilityStatus = requireEnum(
    feedback.capabilityStatus,
    CAPABILITY_STATUSES,
    'capabilityStatus'
  );
  const errorCode = requirePattern(feedback.errorCode, ERROR_CODE_RX, 'errorCode');
  const runtime = requireEnum(feedback.runtime, RUNTIMES, 'runtime');
  const occurredAt = toDate(feedback.occurredAt, 'occurredAt');
  const now = store.currentTime();

  return store.withLifecycleTransaction(
    testerId,
    { allowDeletion: false, allowRevoked: false },
    async client => {
      const inserted = await client.query(
        `INSERT INTO nv_alpha_feedback(
           feedback_id,tester_id,release_version,correlation_id,provider,
           feature,capability_status,error_code,runtime,occurred_at,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING created_at`,
        [
          store.nextUuid('feedback'), testerId, releaseVersion, correlationId,
          provider, feature, capabilityStatus, errorCode, runtime, occurredAt, now
        ]
      );
      return Object.freeze({
        recorded: true,
        createdAt: toIso(onlyRow(inserted).created_at)
      });
    }
  );
}

export async function cohortClose(store: AlphaPrivacyStoreContext, input: unknown) {
  const close = requirePlainObject(input, 'cohort close input');
  const closedAt = toDate(close.closedAt, 'closedAt');
  const purgeAfter = new Date(closedAt.getTime() + 30 * DAY_MS);
  const now = store.currentTime();

  return store.withGlobalTransaction(async client => {
    const existingResult = await client.query(
      `SELECT cohort_key,closed_at,purge_after,created_at
         FROM nv_alpha_cohort_retention
        WHERE cohort_key='public-alpha-17' FOR UPDATE`
    );
    const existing = rowsOf(existingResult)[0];
    if (existing) {
      if (
        toDate(existing.closed_at, 'cohort closed timestamp').getTime() !== closedAt.getTime()
        || toDate(existing.purge_after, 'cohort purge timestamp').getTime()
          !== purgeAfter.getTime()
      ) {
        throw new AlphaPrivacyStoreError(
          'Cohort close boundary conflicts with retained metadata',
          'ALPHA_COHORT_CLOSE_CONFLICT'
        );
      }
      return Object.freeze({
        created: false,
        closedAt: toIso(existing.closed_at),
        purgeAfter: toIso(existing.purge_after)
      });
    }
    const inserted = await client.query(
      `INSERT INTO nv_alpha_cohort_retention(
         cohort_key,closed_at,purge_after,created_at
       ) VALUES('public-alpha-17',$1,$2,$3)
       RETURNING closed_at,purge_after`,
      [closedAt, purgeAfter, now]
    );
    return Object.freeze({
      created: true,
      closedAt: toIso(onlyRow(inserted).closed_at),
      purgeAfter: toIso(onlyRow(inserted).purge_after)
    });
  });
}

export async function runRetention(store: AlphaPrivacyStoreContext) {
  const now = store.currentTime();
  const sessionCutoff = new Date(now.getTime() - 7 * DAY_MS);
  const feedbackCutoff = new Date(now.getTime() - 14 * DAY_MS);
  const evidenceCutoff = new Date(now.getTime() - 30 * DAY_MS);

  return store.withGlobalTransaction(async client => {
    const cohortResult = await client.query(
      `SELECT cohort_key,closed_at,purge_after,created_at
         FROM nv_alpha_cohort_retention
        WHERE cohort_key='public-alpha-17' FOR UPDATE`
    );
    const alphaSessions = await client.query(
      `DELETE FROM nv_alpha_sessions
        WHERE expires_at<=$1 OR created_at<=$2`,
      [now, sessionCutoff]
    );
    const providerSessions = await client.query(
      `DELETE FROM nv_sessions session
        WHERE session.updated<=$1
          AND EXISTS (
            SELECT 1
              FROM nv_alpha_provider_bindings binding
             WHERE binding.identity_key=ANY(session.identity_keys)
          )`,
      [sessionCutoff]
    );
    const events = await client.query(
      `DELETE FROM nv_intelligence_events event
        WHERE event.created_at<=$1
          AND EXISTS (
            SELECT 1 FROM nv_alpha_provider_bindings binding
            WHERE binding.identity_key=event.identity_key
          )`,
      [evidenceCutoff]
    );
    const snapshots = await client.query(
      `DELETE FROM nv_recovery_snapshots snapshot
        WHERE snapshot.created_at<=$1
          AND EXISTS (
            SELECT 1 FROM nv_alpha_provider_bindings binding
            WHERE binding.identity_key=snapshot.identity_key
          )`,
      [evidenceCutoff]
    );
    const exports = await client.query(
      `DELETE FROM nv_governance_exports export
        WHERE export.created_at<=$1
          AND EXISTS (
            SELECT 1 FROM nv_alpha_provider_bindings binding
            WHERE binding.identity_key=export.actor_identity_key
          )`,
      [evidenceCutoff]
    );
    const feedback = await client.query(
      `DELETE FROM nv_alpha_feedback
        WHERE created_at<=$1`,
      [feedbackCutoff]
    );
    const cohort = rowsOf(cohortResult)[0];
    let testerMetadataPurged: number | null | undefined = 0;
    let inviteMetadataPurged: number | null | undefined = 0;
    if (
      cohort
      && now >= toDate(cohort.purge_after, 'cohort purge timestamp')
    ) {
      const testerMetadata = await client.query(
        `UPDATE nv_alpha_testers
            SET tester_label=NULL,repository_scopes=NULL,terms_version=NULL,
                terms_accepted_at=NULL,created_at=NULL,revoked_at=NULL,
                revocation_reason=NULL,metadata_purged_at=$1
          WHERE metadata_purged_at IS NULL`,
        [now]
      );
      const inviteMetadata = await client.query(
        `UPDATE nv_alpha_invites
            SET secret_digest=NULL,tester_label=NULL,repository_scopes=NULL,
                terms_version=NULL,created_at=NULL,expires_at=NULL,
                redeemed_at=NULL,revoked_at=NULL,metadata_purged_at=$1
          WHERE metadata_purged_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM nv_alpha_testers tester
               WHERE tester.invite_id=nv_alpha_invites.invite_id
                 AND tester.metadata_purged_at IS NULL
            )`,
        [now]
      );
      testerMetadataPurged = testerMetadata.rowCount;
      inviteMetadataPurged = inviteMetadata.rowCount;
    }
    return Object.freeze({
      alphaSessionsRemoved: alphaSessions.rowCount,
      providerSessionsRemoved: providerSessions.rowCount,
      eventsRemoved: events.rowCount,
      snapshotsRemoved: snapshots.rowCount,
      evidenceExportsRemoved: exports.rowCount,
      feedbackRemoved: feedback.rowCount,
      testerMetadataPurged,
      inviteMetadataPurged,
      cohortMetadataPreserved: !cohort || now < toDate(cohort.purge_after, 'cohort purge timestamp'),
      completedAt: now.toISOString()
    });
  });
}
