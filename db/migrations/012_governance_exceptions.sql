CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_policies_id_scope_key_idx
  ON nv_governance_policies(policy_id, scope_key);

CREATE TABLE IF NOT EXISTS nv_governance_exception_requests (
  exception_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  policy_id uuid NOT NULL,
  version_id uuid NOT NULL,
  document_hash text NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  head_revision bigint NOT NULL CHECK (head_revision >= 0),
  kind text NOT NULL CHECK (kind IN ('exception', 'waiver')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9._-]{1,99}$'),
  rule_ids jsonb NOT NULL CHECK (jsonb_typeof(rule_ids) = 'array' AND jsonb_array_length(rule_ids) BETWEEN 1 AND 50),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND target <> '{}'::jsonb AND octet_length(target::text) <= 4096),
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  requested_by_identity_key text NOT NULL CHECK (requested_by_identity_key ~ '^[0-9a-f]{64}$'),
  requested_by_login text NOT NULL CHECK (length(requested_by_login) BETWEEN 1 AND 200),
  authorization_access_level smallint NOT NULL CHECK (authorization_access_level IN (30, 40, 50)),
  authorization_provider_role text NOT NULL CHECK (length(authorization_provider_role) BETWEEN 1 AND 120),
  authorization_source text NOT NULL CHECK (length(authorization_source) BETWEEN 1 AND 120),
  authorization_fetched_at timestamptz NOT NULL,
  authorization_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (authorization_expires_at > authorization_fetched_at),
  CHECK (expires_at >= created_at + interval '5 minutes'),
  CHECK (expires_at <= created_at + interval '30 days'),
  FOREIGN KEY(policy_id, version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT,
  FOREIGN KEY(policy_id, scope_key)
    REFERENCES nv_governance_policies(policy_id, scope_key) ON DELETE RESTRICT,
  UNIQUE(exception_id, policy_id, version_id)
);
CREATE INDEX IF NOT EXISTS nv_governance_exception_requests_scope_time_idx
  ON nv_governance_exception_requests(scope_key, created_at DESC, exception_id DESC);
CREATE INDEX IF NOT EXISTS nv_governance_exception_requests_runtime_idx
  ON nv_governance_exception_requests(scope_key, action, version_id, expires_at);

CREATE TABLE IF NOT EXISTS nv_governance_exception_events (
  event_id uuid PRIMARY KEY,
  exception_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  version_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('approve', 'reject', 'revoke')),
  actor_identity_key text NOT NULL CHECK (actor_identity_key ~ '^[0-9a-f]{64}$'),
  actor_login text NOT NULL CHECK (length(actor_login) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  authorization_access_level smallint NOT NULL CHECK (authorization_access_level = 50),
  authorization_provider_role text NOT NULL CHECK (length(authorization_provider_role) BETWEEN 1 AND 120),
  authorization_source text NOT NULL CHECK (length(authorization_source) BETWEEN 1 AND 120),
  authorization_fetched_at timestamptz NOT NULL,
  authorization_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (authorization_expires_at > authorization_fetched_at),
  FOREIGN KEY(exception_id, policy_id, version_id)
    REFERENCES nv_governance_exception_requests(exception_id, policy_id, version_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_exception_one_decision_idx
  ON nv_governance_exception_events(exception_id)
  WHERE event_type IN ('approve', 'reject');
CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_exception_one_revoke_idx
  ON nv_governance_exception_events(exception_id)
  WHERE event_type = 'revoke';
CREATE INDEX IF NOT EXISTS nv_governance_exception_events_request_time_idx
  ON nv_governance_exception_events(exception_id, created_at ASC, event_id ASC);

DROP TRIGGER IF EXISTS nv_governance_exception_requests_immutable ON nv_governance_exception_requests;
CREATE TRIGGER nv_governance_exception_requests_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_exception_requests
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();
DROP TRIGGER IF EXISTS nv_governance_exception_events_immutable ON nv_governance_exception_events;
CREATE TRIGGER nv_governance_exception_events_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_exception_events
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();
DROP TRIGGER IF EXISTS nv_governance_exception_requests_immutable_truncate ON nv_governance_exception_requests;
CREATE TRIGGER nv_governance_exception_requests_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_exception_requests
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();
DROP TRIGGER IF EXISTS nv_governance_exception_events_immutable_truncate ON nv_governance_exception_events;
CREATE TRIGGER nv_governance_exception_events_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_exception_events
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();
