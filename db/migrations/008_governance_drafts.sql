CREATE TABLE IF NOT EXISTS nv_governance_policy_drafts (
  draft_id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES nv_governance_policies(policy_id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  document_hash text NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  authored_by_identity_key text NOT NULL CHECK (authored_by_identity_key ~ '^[0-9a-f]{64}$'),
  authored_by_login text NOT NULL,
  required_approvals smallint NOT NULL CHECK (required_approvals BETWEEN 1 AND 5),
  disallow_author_approval boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nv_governance_active_draft_per_author UNIQUE(policy_id, authored_by_identity_key)
);
CREATE INDEX IF NOT EXISTS nv_governance_drafts_policy_time_idx
  ON nv_governance_policy_drafts(policy_id, updated_at DESC, draft_id DESC);

CREATE TABLE IF NOT EXISTS nv_governance_idempotency (
  scope_key text NOT NULL,
  actor_identity_key text NOT NULL CHECK (actor_identity_key ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9._-]{2,99}$'),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope_key, actor_identity_key, operation, idempotency_key_hash)
);
CREATE INDEX IF NOT EXISTS nv_governance_idempotency_created_idx
  ON nv_governance_idempotency(created_at ASC);
