DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM nv_governance_policies p
    JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
    WHERE p.archived_at IS NULL AND h.active_version_id IS NOT NULL
    GROUP BY p.scope_key
    HAVING count(*) > 100
  ) THEN
    RAISE EXCEPTION 'Nebulaverse runtime enforcement supports at most 100 active policies per repository scope. Deactivate policies before applying migration 011.'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS nv_governance_policy_decisions (
  seq bigserial UNIQUE NOT NULL,
  decision_id uuid PRIMARY KEY,
  mutation_id uuid NOT NULL UNIQUE,
  scope_key text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  authority text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  actor_identity_key text NOT NULL CHECK (actor_identity_key ~ '^[0-9a-f]{64}$'),
  actor_login text NOT NULL CHECK (length(actor_login) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9._-]{1,99}$'),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 80),
  risk text NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  source text NOT NULL CHECK (source IN ('active-policy-set','no-active-policy')),
  descriptor_hash text NOT NULL CHECK (descriptor_hash ~ '^[0-9a-f]{64}$'),
  policy_set_hash text NOT NULL CHECK (policy_set_hash ~ '^[0-9a-f]{64}$'),
  active_policy_count smallint NOT NULL CHECK (active_policy_count BETWEEN 0 AND 100),
  effective_effect text NOT NULL CHECK (effective_effect IN ('allow','require-approval','deny')),
  rollout_mode text NOT NULL CHECK (rollout_mode IN ('observe','warn','block')),
  enforcement_outcome text NOT NULL CHECK (enforcement_outcome IN ('allow','warn','block')),
  warning_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warning_codes)='array'),
  block_code text CHECK (block_code IS NULL OR block_code IN ('POLICY_MUTATION_BLOCKED','POLICY_APPROVAL_REQUIRED')),
  control_mapping jsonb NOT NULL CHECK (jsonb_typeof(control_mapping)='object')
    CHECK ((control_mapping->>'schemaVersion')='1')
    CHECK ((control_mapping->>'status') IN ('mapped','partial','unmapped','unavailable'))
    CHECK ((control_mapping->>'mappingHash') ~ '^[0-9a-f]{64}$'),
  decision jsonb NOT NULL CHECK (jsonb_typeof(decision)='object'),
  decision_hash text NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
  previous_hash text NOT NULL CHECK (previous_hash='NV-POLICY-DECISION-GENESIS-V1' OR previous_hash ~ '^[0-9a-f]{64}$'),
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((enforcement_outcome='block') = (block_code IS NOT NULL)),
  CHECK ((decision->>'schemaVersion')='1'),
  CHECK ((decision->>'descriptorHash')=descriptor_hash),
  CHECK ((decision->>'mutationId')=mutation_id::text),
  CHECK ((decision->'scope'->>'scopeKey')=scope_key),
  CHECK ((decision->>'action')=action)
);
CREATE INDEX IF NOT EXISTS nv_governance_policy_decisions_scope_time_idx
  ON nv_governance_policy_decisions(scope_key,seq ASC);
CREATE INDEX IF NOT EXISTS nv_governance_policy_decisions_action_time_idx
  ON nv_governance_policy_decisions(action,created_at DESC);
CREATE INDEX IF NOT EXISTS nv_governance_policy_decisions_control_mapping_idx
  ON nv_governance_policy_decisions USING gin(control_mapping jsonb_path_ops);
CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_policy_decisions_scope_record_hash_idx
  ON nv_governance_policy_decisions(scope_key,record_hash);

DROP TRIGGER IF EXISTS nv_governance_policy_decisions_immutable ON nv_governance_policy_decisions;
CREATE TRIGGER nv_governance_policy_decisions_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_policy_decisions
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_policy_decisions_immutable_truncate ON nv_governance_policy_decisions;
CREATE TRIGGER nv_governance_policy_decisions_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_policy_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();
