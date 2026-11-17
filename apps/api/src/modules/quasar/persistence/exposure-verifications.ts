import { randomUUID } from 'node:crypto';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import { type Row } from '../../../platform/persistence/queryable.ts';
import { trimmedText } from '../../../platform/values/fields.ts';
import {
  boundedInteger, fail, requireScope, requireDigest, requireText, instant, rowsOf, findingFromRow,
  normalizeVerification, DEFAULT_VERIFICATION_FRESHNESS_MS, verificationFromRow, MAX_LIST_LIMIT, verificationOf,
  normalizeReadabilityProbe, DEFAULT_PROBE_FRESHNESS_MS, readabilityProbeFromRow, readabilityProbeOf, observationOf,
  type Fields
} from './exposure-records.ts';
import type { ExposureStoreContext } from './exposure-records.ts';

/*
 * What was learned about a finding after it was found: whether its
 * credential still works, whether the repository can be read without one,
 * and a reader's decision to accept the risk. Each answer is kept with when
 * it was asked, and the latest answers are read back for a page.
 */

/*
 * The provider said no. This is the only disposition that means the exposure
 * is actually over, and it is the provider's word rather than ours -- so it
 * is recorded without an actor, because nobody here decided it.
 */
export async function markCredentialRejected(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
  const identityKey = requireDigest(input.identityKey, 'Finding identity');
  const now = instant(input.now == null ? Date.now() : input.now, 'Rejection time');
  const updated = await store.query(
    `UPDATE nv_exposure_findings
        SET disposition='credential-rejected', disposition_at=$6, disposition_by=NULL
      WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
        AND fingerprint=$5 AND identity_key=$7
        AND disposition <> 'accepted-risk'
     RETURNING *`,
    [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, now, identityKey],
    'record a rejected credential'
  );
  return findingFromRow(rowsOf(updated)[0] || null);
}

/*
 * Recording what the provider said.
 *
 * Two writes in one transaction, because they are one fact. The attempt is
 * appended -- always, whatever the answer -- and a `rejected` answer also
 * moves the finding, because the issuing provider refusing a credential is
 * the only thing that means the exposure is over.
 *
 * The disposition move is deliberately narrow. It does not touch a finding
 * somebody has already accepted the risk of: a person's decision is not
 * overturned by a later provider answer, and a provider saying no to an
 * accepted risk is simply good news recorded in the attempt history.
 */
export async function recordVerification(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Verification identity');
  const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
  const requestedBy = requireText(input.requestedBy, 'Verification actor', 255);
  const attempt = normalizeVerification(input.record);
  if (!attempt) throw new TypeError('A verification attempt requires a record');
  const verificationId = trimmedText(input.verificationId) || randomUUID();
  const adapterVersion = Number.isInteger(input.adapterVersion) ? input.adapterVersion : null;
  const targetId = trimmedText(input.targetId) || null;
  const authorizationId = trimmedText(input.authorizationId) || null;
  /*
   * A record without a deadline gets the store's own, rather than being
   * written with none: an attempt that never goes stale would read as
   * current forever.
   */
  const freshnessDeadline = attempt.freshnessDeadline
    || new Date(attempt.observedAt.getTime() + DEFAULT_VERIFICATION_FRESHNESS_MS);

  return store.transaction(async client => {
    const owned = await client.query(
      `SELECT fingerprint FROM nv_exposure_findings
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND fingerprint=$5 AND identity_key=$6
        FOR UPDATE`,
      [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, identityKey]
    );
    if (!rowsOf(owned).length) {
      fail('That finding does not exist for this identity', 'EXPOSURE_FINDING_NOT_FOUND', 404);
    }

    const inserted = await client.query(
      `INSERT INTO nv_exposure_verifications (
         verification_id, provider, authority, owner_login, repo_name, fingerprint,
         identity_key, requested_by, adapter, adapter_version, target_id, authorization_id,
         state, reason, subject_digest, retry_after_ms, observed_at, freshness_deadline
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        verificationId, scope.provider, scope.authority, scope.owner, scope.repo, fingerprint,
        identityKey, requestedBy, attempt.adapter, adapterVersion, targetId, authorizationId,
        attempt.state, attempt.reason,
        /* Only a verdict names an account; the schema insists on it too. */
        attempt.state === 'verified' ? attempt.subjectDigest : null,
        attempt.retryAfterMs, attempt.observedAt, freshnessDeadline
      ]
    );

    let finding = null;
    if (attempt.state === 'rejected') {
      const moved = await client.query(
        `UPDATE nv_exposure_findings
            SET disposition='credential-rejected', disposition_at=$6, disposition_by=NULL
          WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
            AND fingerprint=$5 AND identity_key=$7 AND disposition <> 'accepted-risk'
            AND (disposition_at IS NULL OR disposition_at <= $6)
            AND NOT EXISTS (
              SELECT 1 FROM nv_exposure_verifications newer
               WHERE newer.provider=$1 AND newer.authority=$2 AND newer.owner_login=$3
                 AND newer.repo_name=$4 AND newer.fingerprint=$5 AND newer.identity_key=$7
                 AND newer.state IN ('verified','rejected')
                 AND (newer.observed_at > $6 OR (newer.observed_at = $6 AND newer.state='verified')))
         RETURNING *`,
        [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, attempt.observedAt, identityKey]
      );
      finding = findingFromRow(rowsOf(moved)[0] || null);
    } else if (attempt.state === 'verified') {
      /*
       * A newer live verdict invalidates a machine rejection, never a
       * person's accepted-risk decision. Late replies cannot regress it.
       *
       * The verdict is about the credential, not the tree. A finding the
       * tree had already been shown to have lost -- a complete scan after
       * it was last seen, missing it, whose complete parent on the same ref
       * held it, which is exactly what concludeRemovedFromTree requires --
       * goes back to removed-from-tree, not into the tree.
       */
      const moved = await client.query(
        `WITH target AS (
           SELECT f.provider, f.authority, f.owner_login, f.repo_name, f.fingerprint, f.identity_key,
                  EXISTS (
                    SELECT 1 FROM nv_exposure_scans AS after
                      JOIN nv_exposure_scans AS before ON before.scan_id = after.parent_scan_id
                     WHERE after.provider=$1 AND after.authority=$2 AND after.owner_login=$3 AND after.repo_name=$4
                       AND after.identity_key=$7 AND before.identity_key=$7
                       AND after.state='complete' AND after.coverage='complete'
                       AND before.state='complete' AND before.coverage='complete'
                       AND before.ref_name = after.ref_name
                       AND after.rules_version = f.rules_version AND before.rules_version = f.rules_version
                       AND after.engine_version = f.engine_version AND before.engine_version = f.engine_version
                       AND after.fingerprint_key_version = f.fingerprint_key_version
                       AND before.fingerprint_key_version = f.fingerprint_key_version
                       AND after.finished_at >= f.last_observed_at
                       AND EXISTS (SELECT 1 FROM nv_exposure_observations AS seen
                                    WHERE seen.scan_id = before.scan_id AND seen.fingerprint = f.fingerprint)
                       AND NOT EXISTS (SELECT 1 FROM nv_exposure_observations AS gone
                                        WHERE gone.scan_id = after.scan_id AND gone.fingerprint = f.fingerprint)
                  ) AS removed
             FROM nv_exposure_findings AS f
            WHERE f.provider=$1 AND f.authority=$2 AND f.owner_login=$3 AND f.repo_name=$4
              AND f.fingerprint=$5 AND f.identity_key=$7
         )
         UPDATE nv_exposure_findings AS finding
            SET disposition = CASE WHEN target.removed THEN 'removed-from-tree' ELSE 'open' END,
                disposition_at = CASE WHEN target.removed THEN $6::timestamptz ELSE NULL END,
                disposition_by = NULL
           FROM target
          WHERE finding.provider=target.provider AND finding.authority=target.authority
            AND finding.owner_login=target.owner_login AND finding.repo_name=target.repo_name
            AND finding.fingerprint=target.fingerprint AND finding.identity_key=target.identity_key
            AND finding.disposition='credential-rejected'
            AND (finding.disposition_at IS NULL OR finding.disposition_at <= $6)
            AND NOT EXISTS (
              SELECT 1 FROM nv_exposure_verifications newer
               WHERE newer.provider=$1 AND newer.authority=$2 AND newer.owner_login=$3
                 AND newer.repo_name=$4 AND newer.fingerprint=$5 AND newer.identity_key=$7
                 AND newer.state IN ('verified','rejected') AND newer.observed_at > $6)
         RETURNING finding.*`,
        [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, attempt.observedAt, identityKey]
      );
      finding = findingFromRow(rowsOf(moved)[0] || null);
    }
    return Object.freeze({
      verification: verificationFromRow(rowsOf(inserted)[0]),
      finding
    });
  }, 'record a verification');
}

/*
 * The attempts for one finding, newest first. The history is the point: a
 * `verified` on Tuesday and a `rejected` on Friday is what proves somebody's
 * revocation worked, and keeping only the latest answer would throw that
 * away.
 */
export async function listVerifications(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Verification identity');
  const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
  const limit = boundedInteger(input.limit, 20, 1, MAX_LIST_LIMIT);
  const found = await store.query(
    `SELECT * FROM nv_exposure_verifications
      WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
        AND fingerprint=$5 AND identity_key=$6
      ORDER BY observed_at DESC, CASE state WHEN 'verified' THEN 0 ELSE 1 END, verification_id
      LIMIT $7`,
    [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, identityKey, limit],
    'list verifications'
  );
  return Object.freeze(rowsOf(found).map(row => verificationOf(row)));
}

/*
 * Recording what the project allowed the anonymous role to read.
 *
 * Appended, never updated, and appended whatever the answer -- including the
 * attempts that never reached the network. An attempt refused for its shape
 * is evidence too: it says this server was asked to probe something it will
 * not probe, and a history that kept only the requests that went out could
 * not show that.
 *
 * Unlike a verification this moves no disposition, and that is the honest
 * behaviour rather than an omission. A readable table is not the credential
 * being live and a denied one is not the exposure ending: what the anonymous
 * role can reach says nothing about whether this particular key still works,
 * so inferring a disposition from it would be inventing a fact.
 */
export async function recordReadabilityProbe(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Probe identity');
  const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
  const requestedBy = requireText(input.requestedBy, 'Probe actor', 255);
  const attempt = normalizeReadabilityProbe(input.record);
  if (!attempt) throw new TypeError('A readability probe requires an observation');
  const probeId = trimmedText(input.probeId) || randomUUID();
  const authorizationId = trimmedText(input.authorizationId) || null;
  const freshnessDeadline = attempt.freshnessDeadline
    || new Date(attempt.observedAt.getTime() + DEFAULT_PROBE_FRESHNESS_MS);

  return store.transaction(async client => {
    const owned = await client.query(
      `SELECT fingerprint FROM nv_exposure_findings
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND fingerprint=$5 AND identity_key=$6
        FOR UPDATE`,
      [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, identityKey]
    );
    if (!rowsOf(owned).length) {
      fail('That finding does not exist for this identity', 'EXPOSURE_FINDING_NOT_FOUND', 404);
    }
    const inserted = await client.query(
      `INSERT INTO nv_exposure_readability_probes (
         probe_id, provider, authority, owner_login, repo_name, fingerprint,
         identity_key, requested_by, authorization_id,
         project_ref, relation, projection,
         state, reason, tested_role, row_count, observed_at, freshness_deadline
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        probeId, scope.provider, scope.authority, scope.owner, scope.repo, fingerprint,
        identityKey, requestedBy, authorizationId,
        attempt.projectRef, attempt.relation, attempt.projection,
        attempt.state, attempt.reason, attempt.testedRole, attempt.rowCount,
        attempt.observedAt, freshnessDeadline
      ]
    );
    return Object.freeze({ probe: readabilityProbeFromRow(rowsOf(inserted)[0]) });
  }, 'record a readability probe');
}

/*
 * The latest answer of each kind for a page of findings, in two queries
 * rather than two per finding.
 *
 * This exists because a screen that only shows what was asked in the current
 * session is a screen that forgets. A verification from yesterday and a
 * readability answer from last week are the evidence a reader came back for,
 * and making them appear by re-asking would mean using somebody's credential
 * again to redisplay a fact already recorded.
 *
 * Only the latest of each, because that is what a list can show. The full
 * sequence -- which is what proves a revocation or a policy change landed --
 * stays behind the history reads, where a reader asks for one finding.
 */
export async function latestAnswers(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Answer identity');
  const fingerprints = [...new Set(
    (Array.isArray(input.fingerprints) ? input.fingerprints : [])
      .map(value => trimmedText(value).toLowerCase())
      .filter(isSha256Hex)
  )].slice(0, MAX_LIST_LIMIT);
  if (!fingerprints.length) {
    return Object.freeze({ verifications: Object.freeze({}), probes: Object.freeze({}) });
  }
  const parameters = [scope.provider, scope.authority, scope.owner, scope.repo, identityKey, fingerprints];
  const [verifications, probes] = await Promise.all([
    store.query(
      `SELECT DISTINCT ON (fingerprint) * FROM nv_exposure_verifications
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND identity_key=$5 AND fingerprint = ANY($6)
        ORDER BY fingerprint, observed_at DESC, CASE state WHEN 'verified' THEN 0 ELSE 1 END, verification_id`,
      parameters,
      'read the latest verifications'
    ),
    store.query(
      `SELECT DISTINCT ON (fingerprint) * FROM nv_exposure_readability_probes
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND identity_key=$5 AND fingerprint = ANY($6)
        ORDER BY fingerprint, observed_at DESC, probe_id`,
      parameters,
      'read the latest readability probes'
    )
  ]);
  const index = <T>(rows: readonly Row[], map: (row: Row) => T): Readonly<Record<string, T>> => Object.freeze(Object.fromEntries(
    rows.map(row => [String(row.fingerprint), map(row)])
  ));
  return Object.freeze({
    verifications: index(rowsOf(verifications), verificationOf),
    probes: index(rowsOf(probes), readabilityProbeOf)
  });
}

/*
 * Where each finding was last seen: the lines from the newest observation
 * of it in a scan this identity ran. A finding is the credential, not its
 * place, so its row holds no line; the scans that saw it do. Without this
 * the list could say what was found but not on which line.
 */
export async function latestLocations(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Location identity');
  const fingerprints = [...new Set(
    (Array.isArray(input.fingerprints) ? input.fingerprints : [])
      .map(value => trimmedText(value).toLowerCase())
      .filter(isSha256Hex)
  )].slice(0, MAX_LIST_LIMIT);
  if (!fingerprints.length) return Object.freeze({});
  const found = await store.query(
    `SELECT DISTINCT ON (observation.fingerprint) observation.*
       FROM nv_exposure_observations AS observation
       JOIN nv_exposure_scans AS scan ON scan.scan_id=observation.scan_id
      WHERE scan.provider=$1 AND scan.authority=$2 AND scan.owner_login=$3 AND scan.repo_name=$4
        AND scan.identity_key=$5 AND observation.fingerprint = ANY($6)
      ORDER BY observation.fingerprint, observation.observed_at DESC, observation.scan_id DESC`,
    [scope.provider, scope.authority, scope.owner, scope.repo, identityKey, fingerprints],
    'read the latest finding locations'
  );
  return Object.freeze(Object.fromEntries(rowsOf(found).map(row => {
    const observation = observationOf(row);
    return [String(observation.fingerprint), Object.freeze({
      occurrences: observation.occurrences,
      occurrenceCount: observation.occurrenceCount,
      truncated: observation.truncated,
      inTree: observation.inTree,
      introducedCommit: observation.introducedCommit,
      introducedAt: observation.introducedAt,
      historyCommits: observation.historyCommits,
      decodedFrom: observation.decodedFrom
    })];
  })));
}

/*
 * The probes for one finding, newest first. The history is the point here
 * too: "readable on Tuesday, denied on Friday" is what shows somebody's
 * policy change landed, and it is the only evidence that it did.
 */
export async function listReadabilityProbes(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Probe identity');
  const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
  const limit = boundedInteger(input.limit, 20, 1, MAX_LIST_LIMIT);
  const found = await store.query(
    `SELECT * FROM nv_exposure_readability_probes
      WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
        AND fingerprint=$5 AND identity_key=$6
      ORDER BY observed_at DESC, probe_id
      LIMIT $7`,
    [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, identityKey, limit],
    'list readability probes'
  );
  return Object.freeze(rowsOf(found).map(row => readabilityProbeOf(row)));
}

/* A person decided. It records who, and the schema insists on that. */
export async function acceptRisk(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
  const identityKey = requireDigest(input.identityKey, 'Finding identity');
  const actor = requireText(input.actor, 'Accepting actor', 255);
  const now = instant(input.now == null ? Date.now() : input.now, 'Acceptance time');
  const updated = await store.query(
    `UPDATE nv_exposure_findings
        SET disposition='accepted-risk', disposition_at=$6, disposition_by=$7
      WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
        AND fingerprint=$5 AND identity_key=$8
     RETURNING *`,
    [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, now, actor, identityKey],
    'accept a risk'
  );
  return findingFromRow(rowsOf(updated)[0] || null);
}
