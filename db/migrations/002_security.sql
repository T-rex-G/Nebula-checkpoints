CREATE TABLE IF NOT EXISTS nv_security_state (
  identity_key text PRIMARY KEY,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nv_webhooks (
  hook_id text PRIMARY KEY,
  provider text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  identity_key text NOT NULL,
  secret_enc text NOT NULL,
  provider_hook_id bigint,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, owner, repo, identity_key)
);
