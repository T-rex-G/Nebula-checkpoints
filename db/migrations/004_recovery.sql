CREATE TABLE IF NOT EXISTS nv_recovery_snapshots (
  snapshot_id text PRIMARY KEY,
  provider text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  identity_key text NOT NULL,
  snapshot jsonb NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nv_recovery_snapshots_repo_time_idx ON nv_recovery_snapshots(provider, owner, repo, created_at DESC);
