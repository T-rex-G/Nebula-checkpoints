CREATE TABLE IF NOT EXISTS nv_github_app_installations (
  identity_key text NOT NULL,
  installation_id bigint NOT NULL,
  account_login text NOT NULL,
  account_id bigint NOT NULL,
  account_type text NOT NULL,
  authorized_by_login text NOT NULL,
  authorized_by_id bigint NOT NULL,
  repository_selection text NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'suspended', 'revoked', 'disconnected')),
  suspended_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(identity_key, installation_id)
);
CREATE INDEX IF NOT EXISTS nv_github_app_installations_id_idx
  ON nv_github_app_installations(installation_id);

CREATE TABLE IF NOT EXISTS nv_github_app_audit (
  event_id text PRIMARY KEY,
  identity_key text NOT NULL,
  event_type text NOT NULL,
  installation_id bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nv_github_app_audit_identity_time_idx
  ON nv_github_app_audit(identity_key, created_at DESC);
