CREATE TABLE IF NOT EXISTS nv_governance_review_assignments (
  assignment_id uuid PRIMARY KEY,
  policy_id uuid NOT NULL,
  version_id uuid NOT NULL,
  reviewer_identity_key text NOT NULL CHECK (reviewer_identity_key ~ '^[0-9a-f]{64}$'),
  reviewer_login text NOT NULL CHECK (length(reviewer_login) BETWEEN 1 AND 200),
  reviewer_access_level smallint NOT NULL CHECK (reviewer_access_level IN (40, 50)),
  reviewer_provider_role text NOT NULL CHECK (length(reviewer_provider_role) BETWEEN 1 AND 120),
  authorization_source text NOT NULL CHECK (length(authorization_source) BETWEEN 1 AND 120),
  authorization_fetched_at timestamptz NOT NULL,
  authorization_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (authorization_expires_at > authorization_fetched_at),
  FOREIGN KEY(policy_id, version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT,
  UNIQUE(version_id, reviewer_identity_key),
  UNIQUE(assignment_id, version_id, reviewer_identity_key)
);
CREATE INDEX IF NOT EXISTS nv_governance_review_assignments_version_time_idx
  ON nv_governance_review_assignments(version_id, created_at ASC, assignment_id ASC);

ALTER TABLE nv_governance_approvals
  ADD COLUMN IF NOT EXISTS assignment_id uuid;
ALTER TABLE nv_governance_approvals
  ADD COLUMN IF NOT EXISTS reviewer_access_level smallint;
ALTER TABLE nv_governance_approvals
  ADD COLUMN IF NOT EXISTS reviewer_provider_role text;
ALTER TABLE nv_governance_approvals
  ADD COLUMN IF NOT EXISTS authorization_source text;
ALTER TABLE nv_governance_approvals
  ADD COLUMN IF NOT EXISTS authorization_fetched_at timestamptz;
ALTER TABLE nv_governance_approvals
  ADD COLUMN IF NOT EXISTS authorization_expires_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_approvals_assignment_once_idx
  ON nv_governance_approvals(assignment_id)
  WHERE assignment_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nv_governance_approvals_assignment_fk'
  ) THEN
    ALTER TABLE nv_governance_approvals
      ADD CONSTRAINT nv_governance_approvals_assignment_fk
      FOREIGN KEY(assignment_id, version_id, actor_identity_key)
      REFERENCES nv_governance_review_assignments(assignment_id, version_id, reviewer_identity_key)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nv_governance_approvals_review_evidence_check'
  ) THEN
    ALTER TABLE nv_governance_approvals
      ADD CONSTRAINT nv_governance_approvals_review_evidence_check CHECK (
        assignment_id IS NULL OR (
          reviewer_access_level IN (40, 50) AND
          length(reviewer_provider_role) BETWEEN 1 AND 120 AND
          length(authorization_source) BETWEEN 1 AND 120 AND
          authorization_fetched_at IS NOT NULL AND
          authorization_expires_at IS NOT NULL AND
          authorization_expires_at > authorization_fetched_at
        )
      );
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS nv_governance_review_assignments_immutable ON nv_governance_review_assignments;
CREATE TRIGGER nv_governance_review_assignments_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_review_assignments
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_review_assignments_immutable_truncate ON nv_governance_review_assignments;
CREATE TRIGGER nv_governance_review_assignments_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_review_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();
