-- Additive foundation only. No legacy identity rewrites, credential copies,
-- evidence backfill, or foreign keys into tester-owned lifecycle tables.
CREATE TABLE nv_principals (
  principal_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE nv_login_identities (
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea')),
  instance text NOT NULL,
  provider_user_id text NOT NULL CHECK (provider_user_id ~ '^[1-9][0-9]*$'),
  principal_id uuid NOT NULL REFERENCES nv_principals(principal_id) ON DELETE RESTRICT,
  login text NOT NULL,
  PRIMARY KEY (provider, instance, provider_user_id)
);

CREATE TABLE nv_workspaces (
  workspace_id uuid PRIMARY KEY,
  owner_principal_id uuid NOT NULL REFERENCES nv_principals(principal_id) ON DELETE RESTRICT,
  name text NOT NULL DEFAULT 'Personal workspace',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE nv_workspace_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  claimed_workspace_id uuid UNIQUE REFERENCES nv_workspaces(workspace_id) ON DELETE RESTRICT,
  claimed_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  CHECK ((claimed_workspace_id IS NULL) = (claimed_at IS NULL))
);
INSERT INTO nv_workspace_bootstrap(singleton) VALUES(true);

-- Metadata/proof of a connection, NOT a credential vault or authorization to
-- use retained legacy resources. Operational adoption belongs to Change B.
CREATE TABLE nv_workspace_connections (
  connection_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES nv_workspaces(workspace_id) ON DELETE RESTRICT,
  principal_id uuid NOT NULL REFERENCES nv_principals(principal_id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea')),
  instance text NOT NULL,
  provider_user_id text NOT NULL CHECK (provider_user_id ~ '^[1-9][0-9]*$'),
  login text NOT NULL,
  legacy_identity_key text NOT NULL CHECK (legacy_identity_key ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (workspace_id, principal_id, provider, instance, provider_user_id),
  UNIQUE (connection_id, workspace_id, principal_id)
);

CREATE TABLE nv_workspace_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  principal_id uuid NOT NULL REFERENCES nv_principals(principal_id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES nv_workspaces(workspace_id) ON DELETE RESTRICT,
  connection_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (connection_id, workspace_id, principal_id)
    REFERENCES nv_workspace_connections(connection_id, workspace_id, principal_id) ON DELETE RESTRICT
);
CREATE INDEX nv_workspace_sessions_expiry_idx ON nv_workspace_sessions(expires_at);
CREATE INDEX nv_workspace_sessions_principal_idx ON nv_workspace_sessions(principal_id);
