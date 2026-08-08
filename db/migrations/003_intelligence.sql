CREATE TABLE IF NOT EXISTS nv_intelligence_events (
  event_id text PRIMARY KEY,
  provider text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  identity_key text NOT NULL DEFAULT '',
  event_type text NOT NULL,
  action text NOT NULL DEFAULT '',
  actor text NOT NULL DEFAULT '',
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  ref text NOT NULL DEFAULT '',
  before_sha text NOT NULL DEFAULT '',
  after_sha text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'normal',
  risk_score integer NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text NOT NULL DEFAULT '',
  paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE nv_intelligence_events ADD COLUMN IF NOT EXISTS identity_key text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS nv_intelligence_events_repo_time_idx ON nv_intelligence_events(provider, owner, repo, created_at DESC);
CREATE INDEX IF NOT EXISTS nv_intelligence_events_identity_repo_time_idx ON nv_intelligence_events(identity_key, provider, owner, repo, created_at DESC);
