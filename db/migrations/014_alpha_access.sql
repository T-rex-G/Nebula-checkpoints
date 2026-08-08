CREATE TABLE IF NOT EXISTS nv_alpha_invites (
  invite_id text PRIMARY KEY CHECK (invite_id ~ '^[0-9a-z]{20,40}$'),
  secret_digest text NOT NULL CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
  tester_label text NOT NULL CHECK (length(tester_label) BETWEEN 1 AND 120),
  repository_scopes text[] NOT NULL
    CHECK (cardinality(repository_scopes) BETWEEN 1 AND 20),
  terms_version text NOT NULL
    CHECK (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[1-9][0-9]*)?$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS nv_alpha_invites_expiry_idx
  ON nv_alpha_invites(expires_at, invite_id)
  WHERE redeemed_at IS NULL;

CREATE TABLE IF NOT EXISTS nv_alpha_testers (
  tester_id uuid PRIMARY KEY,
  invite_id text NOT NULL UNIQUE
    REFERENCES nv_alpha_invites(invite_id) ON DELETE RESTRICT,
  tester_label text NOT NULL CHECK (length(tester_label) BETWEEN 1 AND 120),
  repository_scopes text[] NOT NULL
    CHECK (cardinality(repository_scopes) BETWEEN 1 AND 20),
  terms_version text NOT NULL
    CHECK (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[1-9][0-9]*)?$'),
  terms_accepted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revocation_reason text NOT NULL DEFAULT ''
    CHECK (length(revocation_reason) <= 240),
  UNIQUE(invite_id, tester_id)
);

CREATE INDEX IF NOT EXISTS nv_alpha_testers_revocation_idx
  ON nv_alpha_testers(revoked_at, tester_id);

CREATE TABLE IF NOT EXISTS nv_alpha_sessions (
  session_id text PRIMARY KEY CHECK (session_id ~ '^[A-Za-z0-9_-]{43}$'),
  tester_id uuid NOT NULL
    REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at),
  CHECK (last_seen_at <= expires_at)
);

CREATE INDEX IF NOT EXISTS nv_alpha_sessions_tester_idx
  ON nv_alpha_sessions(tester_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS nv_alpha_sessions_expiry_idx
  ON nv_alpha_sessions(expires_at, session_id);

CREATE INDEX IF NOT EXISTS nv_alpha_sessions_last_seen_idx
  ON nv_alpha_sessions(last_seen_at, session_id);

CREATE TABLE IF NOT EXISTS nv_alpha_redemption_locks (
  ip_hash text PRIMARY KEY CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  failed_count integer NOT NULL CHECK (failed_count BETWEEN 0 AND 1000),
  locked_until timestamptz
);

CREATE INDEX IF NOT EXISTS nv_alpha_redemption_locks_expiry_idx
  ON nv_alpha_redemption_locks(window_started_at, locked_until, ip_hash);
