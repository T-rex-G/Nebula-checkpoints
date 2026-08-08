CREATE TABLE IF NOT EXISTS nv_governance_policies (
  policy_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea')),
  authority text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  policy_key text NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9._-]{1,63}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by_identity_key text NOT NULL CHECK (created_by_identity_key ~ '^[0-9a-f]{64}$'),
  created_by_login text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE(scope_key, policy_key)
);
CREATE INDEX IF NOT EXISTS nv_governance_policies_scope_idx
  ON nv_governance_policies(scope_key, created_at DESC);

CREATE TABLE IF NOT EXISTS nv_governance_policy_versions (
  version_id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES nv_governance_policies(policy_id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  document_hash text NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  authored_by_identity_key text NOT NULL CHECK (authored_by_identity_key ~ '^[0-9a-f]{64}$'),
  authored_by_login text NOT NULL,
  required_approvals smallint NOT NULL CHECK (required_approvals BETWEEN 1 AND 5),
  disallow_author_approval boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(policy_id, version_number),
  UNIQUE(policy_id, document_hash),
  UNIQUE(policy_id, version_id)
);
CREATE INDEX IF NOT EXISTS nv_governance_versions_policy_time_idx
  ON nv_governance_policy_versions(policy_id, version_number DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS nv_governance_approvals (
  approval_id uuid PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES nv_governance_policy_versions(version_id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  actor_identity_key text NOT NULL CHECK (actor_identity_key ~ '^[0-9a-f]{64}$'),
  actor_login text NOT NULL,
  rationale text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(version_id, actor_identity_key)
);
CREATE INDEX IF NOT EXISTS nv_governance_approvals_version_time_idx
  ON nv_governance_approvals(version_id, created_at ASC);

CREATE TABLE IF NOT EXISTS nv_governance_policy_heads (
  policy_id uuid PRIMARY KEY REFERENCES nv_governance_policies(policy_id) ON DELETE RESTRICT,
  active_version_id uuid,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(policy_id, active_version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS nv_governance_activations (
  activation_id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES nv_governance_policies(policy_id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  previous_version_id uuid,
  action text NOT NULL CHECK (action IN ('activate', 'rollback')),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision bigint NOT NULL CHECK (resulting_revision = expected_revision + 1),
  actor_identity_key text NOT NULL CHECK (actor_identity_key ~ '^[0-9a-f]{64}$'),
  actor_login text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(policy_id, version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT,
  FOREIGN KEY(policy_id, previous_version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS nv_governance_activations_policy_time_idx
  ON nv_governance_activations(policy_id, created_at DESC, activation_id DESC);
CREATE INDEX IF NOT EXISTS nv_governance_activations_version_idx
  ON nv_governance_activations(policy_id, version_id);

CREATE TABLE IF NOT EXISTS nv_governance_audit (
  seq bigserial UNIQUE NOT NULL,
  event_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  policy_id uuid NOT NULL REFERENCES nv_governance_policies(policy_id) ON DELETE RESTRICT,
  version_id uuid,
  event_type text NOT NULL,
  actor_identity_key text NOT NULL CHECK (actor_identity_key ~ '^[0-9a-f]{64}$'),
  actor_login text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  details_hash text NOT NULL CHECK (details_hash ~ '^[0-9a-f]{64}$'),
  previous_hash text NOT NULL,
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(policy_id, version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS nv_governance_audit_policy_time_idx
  ON nv_governance_audit(policy_id, seq ASC);
CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_audit_policy_record_hash_idx
  ON nv_governance_audit(policy_id, record_hash);

CREATE OR REPLACE FUNCTION nv_governance_reject_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Nebulaverse-X governance history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS nv_governance_policy_versions_immutable ON nv_governance_policy_versions;
CREATE TRIGGER nv_governance_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_policy_versions
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_approvals_immutable ON nv_governance_approvals;
CREATE TRIGGER nv_governance_approvals_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_approvals
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_activations_immutable ON nv_governance_activations;
CREATE TRIGGER nv_governance_activations_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_activations
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_audit_immutable ON nv_governance_audit;
CREATE TRIGGER nv_governance_audit_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_audit
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_policy_versions_immutable_truncate ON nv_governance_policy_versions;
CREATE TRIGGER nv_governance_policy_versions_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_approvals_immutable_truncate ON nv_governance_approvals;
CREATE TRIGGER nv_governance_approvals_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_activations_immutable_truncate ON nv_governance_activations;
CREATE TRIGGER nv_governance_activations_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_activations
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_audit_immutable_truncate ON nv_governance_audit;
CREATE TRIGGER nv_governance_audit_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_audit
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();
