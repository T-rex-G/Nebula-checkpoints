CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_activations_policy_identity_idx
  ON nv_governance_activations(policy_id, activation_id);

CREATE TABLE IF NOT EXISTS nv_governance_activation_evidence (
  activation_id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES nv_governance_policies(policy_id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  scope_key text NOT NULL,
  simulation_schema_version smallint NOT NULL CHECK (simulation_schema_version = 1),
  simulation_engine_version smallint NOT NULL CHECK (simulation_engine_version > 0),
  simulation_hash text NOT NULL CHECK (simulation_hash ~ '^[0-9a-f]{64}$'),
  scenario_set_hash text NOT NULL CHECK (scenario_set_hash ~ '^[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  proposed_document_hash text NOT NULL CHECK (proposed_document_hash ~ '^[0-9a-f]{64}$'),
  baseline_kind text NOT NULL CHECK (baseline_kind IN ('no-policy','active-version')),
  baseline_version_id uuid,
  baseline_document_hash text NOT NULL CHECK (baseline_document_hash ~ '^[0-9a-f]{64}$'),
  scenario_count smallint NOT NULL CHECK (scenario_count BETWEEN 1 AND 200),
  strengthened_count smallint NOT NULL CHECK (strengthened_count BETWEEN 0 AND 200),
  relaxed_count smallint NOT NULL CHECK (relaxed_count BETWEEN 0 AND 200),
  changed_count smallint NOT NULL CHECK (changed_count BETWEEN 0 AND 200),
  rollback_source_activation_id uuid,
  actor_access_level smallint NOT NULL CHECK (actor_access_level = 50),
  actor_provider_role text NOT NULL CHECK (length(actor_provider_role) BETWEEN 1 AND 120),
  authorization_source text NOT NULL CHECK (length(authorization_source) BETWEEN 1 AND 120),
  authorization_fetched_at timestamptz NOT NULL,
  authorization_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (authorization_expires_at > authorization_fetched_at),
  CHECK ((baseline_kind='no-policy' AND baseline_version_id IS NULL) OR
         (baseline_kind='active-version' AND baseline_version_id IS NOT NULL)),
  FOREIGN KEY(policy_id, activation_id)
    REFERENCES nv_governance_activations(policy_id, activation_id) ON DELETE RESTRICT,
  FOREIGN KEY(policy_id, version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT,
  FOREIGN KEY(policy_id, baseline_version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT,
  FOREIGN KEY(policy_id, rollback_source_activation_id)
    REFERENCES nv_governance_activations(policy_id, activation_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS nv_governance_activation_evidence_policy_time_idx
  ON nv_governance_activation_evidence(policy_id, created_at DESC, activation_id DESC);

DROP TRIGGER IF EXISTS nv_governance_activation_evidence_immutable ON nv_governance_activation_evidence;
CREATE TRIGGER nv_governance_activation_evidence_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_activation_evidence
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_activation_evidence_immutable_truncate ON nv_governance_activation_evidence;
CREATE TRIGGER nv_governance_activation_evidence_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_activation_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();
