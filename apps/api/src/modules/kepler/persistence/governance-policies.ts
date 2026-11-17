import {
  GovernanceError, normalizeUuid, normalizePolicyScope, normalizePolicyKey, normalizePolicyDocument,
  normalizeApprovalPolicy, policyDocumentHash, verifyGovernanceAuditChain
} from '../domain/governance-model.ts';
import {
  requiredText, rowsOf, actorOf, optionalText, mapPolicy, onlyRow, boundedListLimit, mapPolicyState, mapVersion,
  normalizedDraftContent, mapDraft, expectedRevisionOf, dateOf, type Fields
} from './governance-records.ts';
import type { GovernanceStoreContext } from './governance-store.ts';

/*
 * Policies and their versions: a policy created, a draft written, revised
 * and submitted as a version, and the policy's state and audit chain read
 * back. Every write is audited in the same transaction, and a write that
 * carries an idempotency key answers a repeat with what it answered first.
 */

export async function createPolicy(store: GovernanceStoreContext, input: Fields) {
  const actor = actorOf(input.actor);
  const scope = normalizePolicyScope(input.scope);
  const policyKey = normalizePolicyKey(input.policyKey);
  const name = requiredText(input.name, 'Policy name', 200);
  const description = optionalText(input.description, 'Policy description', 4000);
  const policyId = normalizeUuid(store.idFactory(), 'policy id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.policy.create',
    request: { policyKey, name, description }
  }, async client => {
    const inserted = await client.query(
      `INSERT INTO nv_governance_policies(
        policy_id,scope_key,provider,authority,owner,repo,policy_key,name,description,
        created_by_identity_key,created_by_login,created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [policyId, scope.scopeKey, scope.provider, scope.authority, scope.owner, scope.repo, policyKey, name, description,
       actor.identityKey, actor.login, store.now().toISOString()]
    );
    await client.query(
      'INSERT INTO nv_governance_policy_heads(policy_id,active_version_id,revision,updated_at) VALUES($1,NULL,0,$2)',
      [policyId, store.now().toISOString()]
    );
    await store.appendAudit(client, {
      policyId, scopeKey: scope.scopeKey, eventType: 'policy.created', actor,
      details: { policyKey, name, provider: scope.provider, authority: scope.authority, owner: scope.owner, repo: scope.repo }
    });
    return mapPolicy(onlyRow(inserted));
  });
}

export async function listPolicies(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const capped = boundedListLimit(input.limit);
  const result = await store.pool.query(
    `SELECT p.*,h.active_version_id,h.revision,h.updated_at,
            v.version_number AS active_version_number,v.document_hash AS active_document_hash
     FROM nv_governance_policies p
     JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
     LEFT JOIN nv_governance_policy_versions v ON v.version_id=h.active_version_id
     WHERE p.scope_key=$1 AND p.archived_at IS NULL
     ORDER BY p.created_at ASC,p.policy_id ASC LIMIT $2`,
    [scope.scopeKey, capped]
  );
  return rowsOf(result).map(mapPolicyState);
}

export async function getPolicyStateInScope(store: GovernanceStoreContext, input: Fields = {}) {
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const scope = normalizePolicyScope(input.scope);
  const result = await store.pool.query(
    `SELECT p.*,h.active_version_id,h.revision,h.updated_at,
            v.version_number AS active_version_number,v.document_hash AS active_document_hash
     FROM nv_governance_policies p
     JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
     LEFT JOIN nv_governance_policy_versions v ON v.version_id=h.active_version_id
     WHERE p.policy_id=$1 AND p.scope_key=$2 AND p.archived_at IS NULL`,
    [policyId, scope.scopeKey]
  );
  if (!rowsOf(result)[0]) throw new GovernanceError('Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
  return mapPolicyState(onlyRow(result));
}

export async function createVersion(store: GovernanceStoreContext, input: Fields) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const document = normalizePolicyDocument(input.document);
  const documentHash = policyDocumentHash(document);
  const approval = normalizeApprovalPolicy(input.approvalPolicy);
  const versionId = normalizeUuid(store.idFactory(), 'policy version id');
  return store.transaction(async client => {
    const policyResult = await client.query(
      `SELECT policy_id,scope_key,provider,authority,owner,repo,policy_key,name,description,
              created_by_identity_key,created_by_login,created_at
       FROM nv_governance_policies WHERE policy_id=$1 AND archived_at IS NULL FOR UPDATE`,
      [policyId]
    );
    const policy = rowsOf(policyResult)[0];
    if (!policy) throw new GovernanceError('Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
    const maxResult = await client.query(
      'SELECT COALESCE(MAX(version_number),0)::int AS version_number FROM nv_governance_policy_versions WHERE policy_id=$1',
      [policyId]
    );
    const versionNumber = Number(rowsOf(maxResult)[0]?.version_number || 0) + 1;
    const inserted = await client.query(
      `INSERT INTO nv_governance_policy_versions(
        version_id,policy_id,version_number,document,document_hash,authored_by_identity_key,authored_by_login,
        required_approvals,disallow_author_approval,created_at
       ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [versionId, policyId, versionNumber, JSON.stringify(document), documentHash, actor.identityKey, actor.login,
       approval.requiredApprovals, approval.disallowAuthorApproval, store.now().toISOString()]
    );
    await store.appendAudit(client, {
      policyId, versionId, scopeKey: policy.scope_key, eventType: 'version.created', actor,
      details: { versionNumber, documentHash, requiredApprovals: approval.requiredApprovals, disallowAuthorApproval: approval.disallowAuthorApproval }
    });
    return mapVersion(onlyRow(inserted));
  });
}

export async function createDraft(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const scope = normalizePolicyScope(input.scope);
  const { document, documentHash, approval } = normalizedDraftContent(input);
  const draftId = normalizeUuid(store.idFactory(), 'policy draft id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.draft.create',
    request: { policyId, documentHash, approval }
  }, async client => {
    const policy = await client.query(
      `SELECT policy_id,scope_key FROM nv_governance_policies
       WHERE policy_id=$1 AND scope_key=$2 AND archived_at IS NULL FOR SHARE`,
      [policyId, scope.scopeKey]
    );
    if (!rowsOf(policy)[0]) throw new GovernanceError('Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
    const inserted = await client.query(
      `INSERT INTO nv_governance_policy_drafts(
        draft_id,policy_id,revision,document,document_hash,authored_by_identity_key,authored_by_login,
        required_approvals,disallow_author_approval,created_at,updated_at
       ) VALUES($1,$2,0,$3::jsonb,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [draftId, policyId, JSON.stringify(document), documentHash, actor.identityKey, actor.login,
       approval.requiredApprovals, approval.disallowAuthorApproval, store.now().toISOString()]
    );
    await store.appendAudit(client, {
      policyId, scopeKey: scope.scopeKey, eventType: 'draft.created', actor,
      details: { draftId, revision: 0, documentHash, requiredApprovals: approval.requiredApprovals,
        disallowAuthorApproval: approval.disallowAuthorApproval }
    });
    return mapDraft(onlyRow(inserted));
  });
}

export async function getDraft(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const draftId = normalizeUuid(input.draftId, 'policy draft id');
  const scope = normalizePolicyScope(input.scope);
  const result = await store.pool.query(
    `SELECT d.* FROM nv_governance_policy_drafts d
     JOIN nv_governance_policies p ON p.policy_id=d.policy_id
     WHERE d.draft_id=$1 AND d.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
       AND d.authored_by_identity_key=$4`,
    [draftId, policyId, scope.scopeKey, actor.identityKey]
  );
  if (!rowsOf(result)[0]) throw new GovernanceError('Governance draft was not found', 'GOVERNANCE_DRAFT_NOT_FOUND', 404);
  return mapDraft(onlyRow(result));
}

export async function updateDraft(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const draftId = normalizeUuid(input.draftId, 'policy draft id');
  const scope = normalizePolicyScope(input.scope);
  const expectedRevision = expectedRevisionOf(input.expectedRevision);
  const { document, documentHash, approval } = normalizedDraftContent(input);
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.draft.update',
    request: { policyId, draftId, expectedRevision, documentHash, approval }
  }, async client => {
    const found = await client.query(
      `SELECT d.*,p.scope_key FROM nv_governance_policy_drafts d
       JOIN nv_governance_policies p ON p.policy_id=d.policy_id
       WHERE d.draft_id=$1 AND d.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
         AND d.authored_by_identity_key=$4 FOR UPDATE`,
      [draftId, policyId, scope.scopeKey, actor.identityKey]
    );
    const draft = rowsOf(found)[0];
    if (!draft) throw new GovernanceError('Governance draft was not found', 'GOVERNANCE_DRAFT_NOT_FOUND', 404);
    if (Number(draft.revision) !== expectedRevision) {
      throw new GovernanceError('Policy draft changed; reload before saving', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409, {
        expectedRevision, currentRevision: Number(draft.revision)
      });
    }
    const updated = await client.query(
      `UPDATE nv_governance_policy_drafts
       SET revision=revision+1,document=$1::jsonb,document_hash=$2,required_approvals=$3,
           disallow_author_approval=$4,authored_by_login=$5,updated_at=$6
       WHERE draft_id=$7 AND revision=$8 RETURNING *`,
      [JSON.stringify(document), documentHash, approval.requiredApprovals, approval.disallowAuthorApproval,
       actor.login, store.now().toISOString(), draftId, expectedRevision]
    );
    if (!updated.rowCount) throw new GovernanceError('Policy draft changed during save', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409);
    const nextRevision = expectedRevision + 1;
    await store.appendAudit(client, {
      policyId, scopeKey: scope.scopeKey, eventType: 'draft.updated', actor,
      details: { draftId, previousRevision: expectedRevision, revision: nextRevision, documentHash,
        requiredApprovals: approval.requiredApprovals, disallowAuthorApproval: approval.disallowAuthorApproval }
    });
    return mapDraft(onlyRow(updated));
  });
}

export async function submitDraft(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const draftId = normalizeUuid(input.draftId, 'policy draft id');
  const scope = normalizePolicyScope(input.scope);
  const expectedRevision = expectedRevisionOf(input.expectedRevision);
  const versionId = normalizeUuid(store.idFactory(), 'policy version id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.draft.submit',
    request: { policyId, draftId, expectedRevision }
  }, async client => {
    const found = await client.query(
      `SELECT d.*,p.scope_key FROM nv_governance_policy_drafts d
       JOIN nv_governance_policies p ON p.policy_id=d.policy_id
       WHERE d.draft_id=$1 AND d.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
         AND d.authored_by_identity_key=$4 FOR UPDATE`,
      [draftId, policyId, scope.scopeKey, actor.identityKey]
    );
    const draft = rowsOf(found)[0];
    if (!draft) throw new GovernanceError('Governance draft was not found', 'GOVERNANCE_DRAFT_NOT_FOUND', 404);
    if (Number(draft.revision) !== expectedRevision) {
      throw new GovernanceError('Policy draft changed; reload before submitting', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409, {
        expectedRevision, currentRevision: Number(draft.revision)
      });
    }
    const document = normalizePolicyDocument(draft.document);
    const documentHash = policyDocumentHash(document);
    if (documentHash !== draft.document_hash) {
      throw new GovernanceError('Stored policy draft failed its integrity check', 'GOVERNANCE_DRAFT_INTEGRITY_FAILED', 500);
    }
    const approval = normalizeApprovalPolicy({
      requiredApprovals: Number(draft.required_approvals),
      disallowAuthorApproval: !!draft.disallow_author_approval
    });
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
    const maxResult = await client.query(
      'SELECT COALESCE(MAX(version_number),0)::int AS version_number FROM nv_governance_policy_versions WHERE policy_id=$1',
      [policyId]
    );
    const versionNumber = Number(rowsOf(maxResult)[0]?.version_number || 0) + 1;
    const inserted = await client.query(
      `INSERT INTO nv_governance_policy_versions(
        version_id,policy_id,version_number,document,document_hash,authored_by_identity_key,authored_by_login,
        required_approvals,disallow_author_approval,created_at
       ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [versionId, policyId, versionNumber, JSON.stringify(document), documentHash, actor.identityKey, actor.login,
       approval.requiredApprovals, approval.disallowAuthorApproval, store.now().toISOString()]
    );
    const removed = await client.query(
      'DELETE FROM nv_governance_policy_drafts WHERE draft_id=$1 AND revision=$2',
      [draftId, expectedRevision]
    );
    if (!removed.rowCount) throw new GovernanceError('Policy draft changed during submission', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409);
    await store.appendAudit(client, {
      policyId, versionId, scopeKey: scope.scopeKey, eventType: 'version.created', actor,
      details: { sourceDraftId: draftId, versionNumber, documentHash,
        requiredApprovals: approval.requiredApprovals, disallowAuthorApproval: approval.disallowAuthorApproval }
    });
    return mapVersion(onlyRow(inserted));
  });
}

export async function listVersions(store: GovernanceStoreContext, input: Fields = {}) {
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const scope = normalizePolicyScope(input.scope);
  const capped = boundedListLimit(input.limit);
  const result = await store.pool.query(
    `SELECT v.* FROM nv_governance_policy_versions v
     JOIN nv_governance_policies p ON p.policy_id=v.policy_id
     WHERE v.policy_id=$1 AND p.scope_key=$2 AND p.archived_at IS NULL
     ORDER BY v.version_number DESC,v.created_at DESC LIMIT $3`,
    [policyId, scope.scopeKey, capped]
  );
  return rowsOf(result).map(mapVersion);
}

export async function getVersionInScope(store: GovernanceStoreContext, input: Fields = {}) {
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = normalizeUuid(input.versionId, 'policy version id');
  const scope = normalizePolicyScope(input.scope);
  const result = await store.pool.query(
    `SELECT v.* FROM nv_governance_policy_versions v
     JOIN nv_governance_policies p ON p.policy_id=v.policy_id
     WHERE v.version_id=$1 AND v.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL`,
    [versionId, policyId, scope.scopeKey]
  );
  if (!rowsOf(result)[0]) throw new GovernanceError('Policy version was not found', 'GOVERNANCE_VERSION_NOT_FOUND', 404);
  return mapVersion(onlyRow(result));
}

export async function getPolicyState(store: GovernanceStoreContext, policyId: unknown) {
  const id = normalizeUuid(policyId, 'policy id');
  const result = await store.pool.query(
    `SELECT p.*,h.active_version_id,h.revision,h.updated_at,
            v.version_number AS active_version_number,v.document_hash AS active_document_hash
     FROM nv_governance_policies p
     JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
     LEFT JOIN nv_governance_policy_versions v ON v.version_id=h.active_version_id
     WHERE p.policy_id=$1`,
    [id]
  );
  const row = rowsOf(result)[0];
  if (!row) throw new GovernanceError('Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
  return {
    ...mapPolicy(row),
    activeVersionId: row.active_version_id || null,
    activeVersionNumber: row.active_version_number == null ? null : Number(row.active_version_number),
    activeDocumentHash: row.active_document_hash || null,
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at
  };
}

export async function verifyAudit(store: GovernanceStoreContext, policyId: unknown, limit: unknown = 5000) {
  const id = normalizeUuid(policyId, 'policy id');
  const capped = Math.min(Math.max(Number(limit) || 1, 1), 5000);
  const result = await store.pool.query(
    `SELECT seq,event_id,policy_id,version_id,event_type,actor_identity_key,actor_login,details,details_hash,
            previous_hash,record_hash,created_at,count(*) OVER()::int AS total_count
     FROM nv_governance_audit WHERE policy_id=$1 ORDER BY seq ASC LIMIT $2`,
    [id, capped]
  );
  const records = rowsOf(result).map(row => ({
    eventId: row.event_id,
    policyId: row.policy_id,
    versionId: row.version_id,
    eventType: row.event_type,
    actorIdentityKey: row.actor_identity_key,
    actorLogin: row.actor_login,
    details: row.details,
    detailsHash: row.details_hash,
    previousHash: row.previous_hash,
    recordHash: row.record_hash,
    createdAt: dateOf(row.created_at).toISOString()
  }));
  const verification = verifyGovernanceAuditChain(store.secret, records);
  const total = Number(rowsOf(result)[0]?.total_count || 0);
  return { ...verification, total, complete: records.length === total };
}
