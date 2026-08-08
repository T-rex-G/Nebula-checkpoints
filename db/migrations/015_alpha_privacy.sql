ALTER TABLE nv_sessions
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0
  CHECK (revision >= 0);

ALTER TABLE nv_sessions
  ADD COLUMN IF NOT EXISTS session_key_hash text
  CHECK (session_key_hash IS NULL OR session_key_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS nv_sessions_alpha_session_key_hash_unique
  ON nv_sessions(session_key_hash)
  WHERE session_key_hash IS NOT NULL;

ALTER TABLE nv_webhooks
  ADD COLUMN IF NOT EXISTS alpha_resource_key_hash text
  CHECK (
    alpha_resource_key_hash IS NULL
    OR alpha_resource_key_hash ~ '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS nv_webhooks_alpha_resource_key_hash_unique
  ON nv_webhooks(alpha_resource_key_hash)
  WHERE alpha_resource_key_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS nv_alpha_provider_bindings (
  tester_id uuid NOT NULL
    REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  authority text NOT NULL
    CHECK (length(authority) BETWEEN 1 AND 255)
    CHECK (authority ~ '^[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?(:[1-9][0-9]{0,4})?$'),
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  PRIMARY KEY(tester_id,identity_key,provider),
  CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
);

CREATE INDEX IF NOT EXISTS nv_alpha_provider_bindings_identity_idx
  ON nv_alpha_provider_bindings(identity_key,tester_id,provider)
  WHERE disconnected_at IS NULL;

CREATE TABLE IF NOT EXISTS nv_alpha_provider_webhook_ownership (
  tester_id uuid NOT NULL,
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  resource_key_hash text NOT NULL CHECK (resource_key_hash ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  FOREIGN KEY(tester_id,identity_key,provider)
    REFERENCES nv_alpha_provider_bindings(tester_id,identity_key,provider)
    ON DELETE RESTRICT,
  PRIMARY KEY(tester_id,identity_key,provider,resource_key_hash),
  CHECK (released_at IS NULL OR released_at >= claimed_at)
);

CREATE INDEX IF NOT EXISTS nv_alpha_provider_webhook_ownership_resource_idx
  ON nv_alpha_provider_webhook_ownership(identity_key,provider,resource_key_hash,tester_id)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS nv_alpha_cleanup_manifest (
  manifest_id uuid PRIMARY KEY,
  tester_id uuid NOT NULL,
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  resource_type text NOT NULL
    CHECK (resource_type IN ('provider-webhook','temporary-branch','provider-session')),
  resource_key_hash text NOT NULL CHECK (resource_key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tester_id,identity_key,provider)
    REFERENCES nv_alpha_provider_bindings(tester_id,identity_key,provider)
    ON DELETE RESTRICT,
  UNIQUE(tester_id,identity_key,provider,resource_type,resource_key_hash),
  UNIQUE(manifest_id,tester_id,identity_key,provider,resource_type,resource_key_hash)
);

CREATE INDEX IF NOT EXISTS nv_alpha_cleanup_manifest_tester_idx
  ON nv_alpha_cleanup_manifest(tester_id,identity_key,provider,created_at);

CREATE TABLE IF NOT EXISTS nv_alpha_cleanup_tasks (
  cleanup_id uuid PRIMARY KEY,
  manifest_id uuid NOT NULL,
  tester_id uuid NOT NULL,
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  resource_type text NOT NULL
    CHECK (resource_type IN ('provider-webhook','temporary-branch','provider-session')),
  resource_key_hash text NOT NULL CHECK (resource_key_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','failed')),
  reason_code text NOT NULL DEFAULT ''
    CHECK (reason_code = '' OR reason_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  FOREIGN KEY(manifest_id,tester_id,identity_key,provider,resource_type,resource_key_hash)
    REFERENCES nv_alpha_cleanup_manifest(
      manifest_id,tester_id,identity_key,provider,resource_type,resource_key_hash
    ) ON DELETE RESTRICT,
  UNIQUE(manifest_id),
  CHECK ((status='verified') = (verified_at IS NOT NULL)),
  CHECK (verified_at IS NULL OR verified_at >= created_at)
);

CREATE INDEX IF NOT EXISTS nv_alpha_cleanup_tasks_tester_idx
  ON nv_alpha_cleanup_tasks(tester_id,status,created_at,cleanup_id);

CREATE TABLE IF NOT EXISTS nv_alpha_provider_session_ownership (
  session_key_hash text NOT NULL CHECK (session_key_hash ~ '^[0-9a-f]{64}$'),
  tester_id uuid NOT NULL,
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  FOREIGN KEY(tester_id,identity_key,provider)
    REFERENCES nv_alpha_provider_bindings(tester_id,identity_key,provider)
    ON DELETE RESTRICT,
  PRIMARY KEY(session_key_hash,tester_id,identity_key,provider),
  CHECK (released_at IS NULL OR released_at >= claimed_at)
);

CREATE INDEX IF NOT EXISTS nv_alpha_provider_session_ownership_session_idx
  ON nv_alpha_provider_session_ownership(session_key_hash,tester_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS nv_alpha_provider_session_ownership_tester_idx
  ON nv_alpha_provider_session_ownership(tester_id,identity_key,provider)
  WHERE released_at IS NULL;

CREATE OR REPLACE FUNCTION nv_alpha_provider_session_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM nv_alpha_provider_session_ownership existing
     WHERE existing.session_key_hash=NEW.session_key_hash
       AND existing.tester_id<>NEW.tester_id
  ) THEN
    RAISE EXCEPTION 'Provider session belongs to another alpha tester';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_provider_session_owner_guard
  ON nv_alpha_provider_session_ownership;
CREATE TRIGGER nv_alpha_provider_session_owner_guard
  BEFORE INSERT OR UPDATE ON nv_alpha_provider_session_ownership
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_provider_session_owner_guard();

CREATE TABLE IF NOT EXISTS nv_alpha_feedback (
  feedback_id uuid PRIMARY KEY,
  tester_id uuid NOT NULL
    REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  release_version text NOT NULL
    CHECK (length(release_version) BETWEEN 1 AND 80)
    CHECK (release_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  correlation_id text NOT NULL
    CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  feature text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9._-]{0,79}$'),
  capability_status text NOT NULL
    CHECK (capability_status IN ('Supported','Experimental','Unavailable')),
  error_code text NOT NULL CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  runtime text NOT NULL
    CHECK (runtime IN ('chrome','firefox','safari','edge','node','unknown')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tester_id,correlation_id)
);

CREATE INDEX IF NOT EXISTS nv_alpha_feedback_tester_time_idx
  ON nv_alpha_feedback(tester_id,created_at,feedback_id);

CREATE TABLE IF NOT EXISTS nv_alpha_deletion_requests (
  request_id uuid PRIMARY KEY,
  tester_id uuid NOT NULL UNIQUE
    REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('requested','blocked','complete')),
  blocked_cleanup_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status='complete') = (completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);

CREATE TABLE IF NOT EXISTS nv_alpha_deletion_blocks (
  request_id uuid NOT NULL
    REFERENCES nv_alpha_deletion_requests(request_id) ON DELETE RESTRICT,
  block_code text NOT NULL CHECK (block_code IN (
    'CLEANUP_MISSING','CLEANUP_ORPHAN','CLEANUP_MISMATCHED',
    'CLEANUP_EXTRA','CLEANUP_REPLACEMENT','CLEANUP_UNVERIFIED'
  )),
  blocked_count integer NOT NULL CHECK (blocked_count BETWEEN 1 AND 10000),
  cleanup_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
    CHECK (cardinality(cleanup_ids)<=100),
  PRIMARY KEY(request_id,block_code)
);

CREATE TABLE IF NOT EXISTS nv_alpha_purge_reports (
  report_id uuid PRIMARY KEY,
  tester_id_hash text NOT NULL UNIQUE CHECK (tester_id_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'complete' CHECK (status='complete'),
  token_bearing_state_removed boolean NOT NULL CHECK (token_bearing_state_removed),
  provider_cleanup_verified boolean NOT NULL CHECK (provider_cleanup_verified),
  retained_integrity_metadata boolean NOT NULL CHECK (retained_integrity_metadata),
  provider_sessions_removed integer NOT NULL CHECK (provider_sessions_removed >= 0),
  webhooks_removed integer NOT NULL CHECK (webhooks_removed >= 0),
  events_removed integer NOT NULL CHECK (events_removed >= 0),
  snapshots_removed integer NOT NULL CHECK (snapshots_removed >= 0),
  feedback_removed integer NOT NULL CHECK (feedback_removed >= 0),
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nv_alpha_retained_integrity (
  tester_id_hash text NOT NULL CHECK (tester_id_hash ~ '^[0-9a-f]{64}$'),
  record_kind text NOT NULL
    CHECK (record_kind IN ('governance-audit','governance-decision')),
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  previous_hash text NOT NULL
    CHECK (previous_hash IN (
      'NEBULAVERSE-GOVERNANCE-GENESIS-V1','NV-POLICY-DECISION-GENESIS-V1'
    ) OR previous_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  retained_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(record_kind,record_hash)
);

CREATE TABLE IF NOT EXISTS nv_alpha_audit_purge_authorizations (
  tester_id uuid NOT NULL
    REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  tester_id_hash text NOT NULL CHECK (tester_id_hash ~ '^[0-9a-f]{64}$'),
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  record_kind text NOT NULL
    CHECK (record_kind IN ('governance-audit','governance-decision')),
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  previous_hash text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tester_id,record_kind,record_hash),
  FOREIGN KEY(record_kind,record_hash)
    REFERENCES nv_alpha_retained_integrity(record_kind,record_hash)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS nv_alpha_cohort_retention (
  cohort_key text PRIMARY KEY CHECK (cohort_key='public-alpha-17'),
  closed_at timestamptz NOT NULL,
  purge_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (purge_after=closed_at + interval '30 days')
);

ALTER TABLE nv_alpha_invites
  ADD COLUMN IF NOT EXISTS metadata_purged_at timestamptz;
ALTER TABLE nv_alpha_invites
  ALTER COLUMN secret_digest DROP NOT NULL,
  ALTER COLUMN tester_label DROP NOT NULL,
  ALTER COLUMN repository_scopes DROP NOT NULL,
  ALTER COLUMN terms_version DROP NOT NULL,
  ALTER COLUMN created_at DROP NOT NULL,
  ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE nv_alpha_testers
  ADD COLUMN IF NOT EXISTS metadata_purged_at timestamptz;
ALTER TABLE nv_alpha_testers
  ALTER COLUMN tester_label DROP NOT NULL,
  ALTER COLUMN repository_scopes DROP NOT NULL,
  ALTER COLUMN terms_version DROP NOT NULL,
  ALTER COLUMN terms_accepted_at DROP NOT NULL,
  ALTER COLUMN created_at DROP NOT NULL,
  ALTER COLUMN revocation_reason DROP NOT NULL;

CREATE OR REPLACE FUNCTION nv_alpha_cohort_metadata_purge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  boundary timestamptz;
BEGIN
  IF OLD.metadata_purged_at IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Purged alpha cohort metadata is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.metadata_purged_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT purge_after INTO boundary
    FROM nv_alpha_cohort_retention
   WHERE cohort_key='public-alpha-17';
  IF boundary IS NULL
     OR current_timestamp<boundary
     OR NEW.metadata_purged_at<boundary THEN
    RAISE EXCEPTION 'Alpha cohort metadata cannot be purged before its boundary';
  END IF;

  IF TG_TABLE_NAME='nv_alpha_invites' THEN
    IF NEW.invite_id IS DISTINCT FROM OLD.invite_id
       OR NEW.secret_digest IS NOT NULL
       OR NEW.tester_label IS NOT NULL
       OR NEW.repository_scopes IS NOT NULL
       OR NEW.terms_version IS NOT NULL
       OR NEW.created_at IS NOT NULL
       OR NEW.expires_at IS NOT NULL
       OR NEW.redeemed_at IS NOT NULL
       OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Alpha invite metadata purge is incomplete';
    END IF;
  ELSIF TG_TABLE_NAME='nv_alpha_testers' THEN
    IF NEW.tester_id IS DISTINCT FROM OLD.tester_id
       OR NEW.invite_id IS DISTINCT FROM OLD.invite_id
       OR NEW.tester_label IS NOT NULL
       OR NEW.repository_scopes IS NOT NULL
       OR NEW.terms_version IS NOT NULL
       OR NEW.terms_accepted_at IS NOT NULL
       OR NEW.created_at IS NOT NULL
       OR NEW.revoked_at IS NOT NULL
       OR NEW.revocation_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Alpha tester metadata purge is incomplete';
    END IF;
  ELSE
    RAISE EXCEPTION 'Alpha cohort metadata purge target is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_invites_metadata_purge ON nv_alpha_invites;
CREATE TRIGGER nv_alpha_invites_metadata_purge
  BEFORE UPDATE ON nv_alpha_invites
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_cohort_metadata_purge_guard();

DROP TRIGGER IF EXISTS nv_alpha_testers_metadata_purge ON nv_alpha_testers;
CREATE TRIGGER nv_alpha_testers_metadata_purge
  BEFORE UPDATE ON nv_alpha_testers
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_cohort_metadata_purge_guard();

CREATE OR REPLACE FUNCTION nv_alpha_privacy_reject_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Nebulaverse-X alpha privacy evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_cleanup_manifest_immutable ON nv_alpha_cleanup_manifest;
CREATE TRIGGER nv_alpha_cleanup_manifest_immutable
  BEFORE UPDATE OR DELETE ON nv_alpha_cleanup_manifest
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_privacy_reject_immutable();

DROP TRIGGER IF EXISTS nv_alpha_cleanup_manifest_immutable_truncate ON nv_alpha_cleanup_manifest;
CREATE TRIGGER nv_alpha_cleanup_manifest_immutable_truncate
  BEFORE TRUNCATE ON nv_alpha_cleanup_manifest
  FOR EACH STATEMENT EXECUTE FUNCTION nv_alpha_privacy_reject_immutable();

CREATE OR REPLACE FUNCTION nv_alpha_cleanup_manifest_require_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM nv_alpha_cleanup_tasks task
    WHERE task.manifest_id=NEW.manifest_id
      AND task.tester_id=NEW.tester_id
      AND task.identity_key=NEW.identity_key
      AND task.provider=NEW.provider
      AND task.resource_type=NEW.resource_type
      AND task.resource_key_hash=NEW.resource_key_hash
  ) THEN
    RAISE EXCEPTION 'Alpha cleanup manifest item requires one matching task';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_cleanup_manifest_task_required ON nv_alpha_cleanup_manifest;
CREATE CONSTRAINT TRIGGER nv_alpha_cleanup_manifest_task_required
  AFTER INSERT ON nv_alpha_cleanup_manifest
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_cleanup_manifest_require_task();

CREATE OR REPLACE FUNCTION nv_alpha_cleanup_tasks_monotonic_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Alpha cleanup tasks cannot be deleted';
  END IF;
  IF NEW.cleanup_id<>OLD.cleanup_id
     OR NEW.manifest_id<>OLD.manifest_id
     OR NEW.tester_id<>OLD.tester_id
     OR NEW.identity_key<>OLD.identity_key
     OR NEW.provider<>OLD.provider
     OR NEW.resource_type<>OLD.resource_type
     OR NEW.resource_key_hash<>OLD.resource_key_hash
     OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Alpha cleanup task identity is immutable';
  END IF;
  IF OLD.status='verified' AND (
       NEW.status<>'verified'
       OR NEW.reason_code<>OLD.reason_code
       OR NEW.verified_at<>OLD.verified_at
     ) THEN
    RAISE EXCEPTION 'Verified alpha cleanup cannot be changed';
  END IF;
  IF OLD.status='failed' AND NEW.status='pending' THEN
    RAISE EXCEPTION 'Failed alpha cleanup cannot return to pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_cleanup_tasks_monotonic ON nv_alpha_cleanup_tasks;
CREATE TRIGGER nv_alpha_cleanup_tasks_monotonic
  BEFORE UPDATE OR DELETE ON nv_alpha_cleanup_tasks
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_cleanup_tasks_monotonic_guard();

DROP TRIGGER IF EXISTS nv_alpha_cleanup_tasks_immutable_truncate ON nv_alpha_cleanup_tasks;
CREATE TRIGGER nv_alpha_cleanup_tasks_immutable_truncate
  BEFORE TRUNCATE ON nv_alpha_cleanup_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION nv_alpha_privacy_reject_immutable();

CREATE OR REPLACE FUNCTION nv_alpha_provider_bindings_monotonic_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Alpha provider bindings cannot be deleted';
  END IF;
  IF NEW.tester_id<>OLD.tester_id
     OR NEW.identity_key<>OLD.identity_key
     OR NEW.provider<>OLD.provider
     OR NEW.authority<>OLD.authority
     OR NEW.connected_at<>OLD.connected_at
     OR (OLD.disconnected_at IS NOT NULL
         AND NEW.disconnected_at IS DISTINCT FROM OLD.disconnected_at) THEN
    RAISE EXCEPTION 'Alpha provider binding lifecycle is monotonic';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_provider_bindings_monotonic ON nv_alpha_provider_bindings;
CREATE TRIGGER nv_alpha_provider_bindings_monotonic
  BEFORE UPDATE OR DELETE ON nv_alpha_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_provider_bindings_monotonic_guard();

CREATE OR REPLACE FUNCTION nv_alpha_provider_session_ownership_monotonic_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Alpha provider session ownership cannot be deleted';
  END IF;
  IF NEW.session_key_hash<>OLD.session_key_hash
     OR NEW.tester_id<>OLD.tester_id
     OR NEW.identity_key<>OLD.identity_key
     OR NEW.provider<>OLD.provider
     OR NEW.claimed_at<>OLD.claimed_at
     OR (OLD.released_at IS NOT NULL
         AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION 'Alpha provider session ownership is monotonic';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_provider_session_ownership_monotonic
  ON nv_alpha_provider_session_ownership;
CREATE TRIGGER nv_alpha_provider_session_ownership_monotonic
  BEFORE UPDATE OR DELETE ON nv_alpha_provider_session_ownership
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_provider_session_ownership_monotonic_guard();

CREATE OR REPLACE FUNCTION nv_alpha_provider_webhook_ownership_monotonic_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Alpha provider webhook ownership cannot be deleted';
  END IF;
  IF NEW.tester_id<>OLD.tester_id
     OR NEW.identity_key<>OLD.identity_key
     OR NEW.provider<>OLD.provider
     OR NEW.resource_key_hash<>OLD.resource_key_hash
     OR NEW.claimed_at<>OLD.claimed_at
     OR (OLD.released_at IS NOT NULL
         AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION 'Alpha provider webhook ownership is monotonic';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_provider_webhook_ownership_monotonic
  ON nv_alpha_provider_webhook_ownership;
CREATE TRIGGER nv_alpha_provider_webhook_ownership_monotonic
  BEFORE UPDATE OR DELETE ON nv_alpha_provider_webhook_ownership
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_provider_webhook_ownership_monotonic_guard();

CREATE OR REPLACE FUNCTION nv_alpha_deletion_requests_monotonic_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Alpha deletion requests cannot be deleted';
  END IF;
  IF NEW.request_id<>OLD.request_id
     OR NEW.tester_id<>OLD.tester_id
     OR NEW.requested_at<>OLD.requested_at
     OR OLD.status='complete'
     OR (OLD.status='requested' AND NEW.status<>'complete') THEN
    RAISE EXCEPTION 'Alpha deletion request lifecycle is monotonic';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_deletion_requests_monotonic ON nv_alpha_deletion_requests;
CREATE TRIGGER nv_alpha_deletion_requests_monotonic
  BEFORE UPDATE OR DELETE ON nv_alpha_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_deletion_requests_monotonic_guard();

DROP TRIGGER IF EXISTS nv_alpha_purge_reports_immutable ON nv_alpha_purge_reports;
CREATE TRIGGER nv_alpha_purge_reports_immutable
  BEFORE UPDATE OR DELETE ON nv_alpha_purge_reports
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_privacy_reject_immutable();

DROP TRIGGER IF EXISTS nv_alpha_retained_integrity_immutable ON nv_alpha_retained_integrity;
CREATE TRIGGER nv_alpha_retained_integrity_immutable
  BEFORE UPDATE OR DELETE ON nv_alpha_retained_integrity
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_privacy_reject_immutable();

CREATE OR REPLACE FUNCTION nv_alpha_audit_purge_authorizations_must_clear()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM nv_alpha_audit_purge_authorizations authorization
     WHERE authorization.tester_id=NEW.tester_id
       AND authorization.record_kind=NEW.record_kind
       AND authorization.record_hash=NEW.record_hash
  ) THEN
    RAISE EXCEPTION 'Alpha audit purge authorization must be transaction-local';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_alpha_audit_purge_authorizations_cleared
  ON nv_alpha_audit_purge_authorizations;
CREATE CONSTRAINT TRIGGER nv_alpha_audit_purge_authorizations_cleared
  AFTER INSERT ON nv_alpha_audit_purge_authorizations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_audit_purge_authorizations_must_clear();

CREATE OR REPLACE FUNCTION nv_alpha_governance_audit_purge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' AND EXISTS (
    SELECT 1
      FROM nv_alpha_audit_purge_authorizations authorization
      JOIN nv_alpha_deletion_requests request
        ON request.tester_id=authorization.tester_id
       AND request.status='requested'
      JOIN nv_alpha_retained_integrity retained
        ON retained.tester_id_hash=authorization.tester_id_hash
       AND retained.record_kind=authorization.record_kind
       AND retained.record_hash=authorization.record_hash
       AND retained.previous_hash=authorization.previous_hash
       AND retained.payload_hash=authorization.payload_hash
     WHERE authorization.record_kind='governance-audit'
       AND authorization.identity_key=OLD.actor_identity_key
       AND authorization.record_hash=OLD.record_hash
       AND authorization.previous_hash=OLD.previous_hash
       AND authorization.payload_hash=OLD.details_hash
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Nebulaverse-X governance history is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION nv_alpha_governance_decision_purge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' AND EXISTS (
    SELECT 1
      FROM nv_alpha_audit_purge_authorizations authorization
      JOIN nv_alpha_deletion_requests request
        ON request.tester_id=authorization.tester_id
       AND request.status='requested'
      JOIN nv_alpha_retained_integrity retained
        ON retained.tester_id_hash=authorization.tester_id_hash
       AND retained.record_kind=authorization.record_kind
       AND retained.record_hash=authorization.record_hash
       AND retained.previous_hash=authorization.previous_hash
       AND retained.payload_hash=authorization.payload_hash
     WHERE authorization.record_kind='governance-decision'
       AND authorization.identity_key=OLD.actor_identity_key
       AND authorization.record_hash=OLD.record_hash
       AND authorization.previous_hash=OLD.previous_hash
       AND authorization.payload_hash=OLD.decision_hash
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Nebulaverse-X governance history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS nv_governance_audit_immutable ON nv_governance_audit;
CREATE TRIGGER nv_governance_audit_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_audit
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_governance_audit_purge_guard();

DROP TRIGGER IF EXISTS nv_governance_policy_decisions_immutable
  ON nv_governance_policy_decisions;
CREATE TRIGGER nv_governance_policy_decisions_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_policy_decisions
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_governance_decision_purge_guard();

CREATE OR REPLACE FUNCTION nv_alpha_governance_export_retention_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE'
     AND OLD.created_at<=current_timestamp - interval '30 days'
     AND EXISTS (
       SELECT 1 FROM nv_alpha_provider_bindings binding
        WHERE binding.identity_key=OLD.actor_identity_key
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Nebulaverse-X governance history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS nv_governance_exports_immutable ON nv_governance_exports;
CREATE TRIGGER nv_governance_exports_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_exports
  FOR EACH ROW EXECUTE FUNCTION nv_alpha_governance_export_retention_guard();
