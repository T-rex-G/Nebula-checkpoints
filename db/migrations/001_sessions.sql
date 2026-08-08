CREATE TABLE IF NOT EXISTS nv_sessions (
  sid text PRIMARY KEY,
  data text NOT NULL,
  identity_keys text[] NOT NULL DEFAULT '{}'::text[],
  updated timestamptz DEFAULT now()
);
ALTER TABLE nv_sessions ADD COLUMN IF NOT EXISTS identity_keys text[] NOT NULL DEFAULT '{}'::text[];
CREATE INDEX IF NOT EXISTS nv_sessions_identity_keys_idx ON nv_sessions USING GIN(identity_keys);
