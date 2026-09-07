-- Credentials belong to a workspace session, never to legacy tester resources.
-- Expiry is inherited from that session; rotation/sign-out deletes them via FK.
ALTER TABLE nv_workspace_sessions ADD CONSTRAINT nv_workspace_sessions_scope_unique
  UNIQUE (session_hash, workspace_id, principal_id);

CREATE TABLE nv_workspace_credentials (
  session_hash text NOT NULL,
  connection_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  sealed_credential text NOT NULL CHECK (length(sealed_credential) BETWEEN 1 AND 16384),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_hash, connection_id),
  FOREIGN KEY (session_hash, workspace_id, principal_id)
    REFERENCES nv_workspace_sessions(session_hash, workspace_id, principal_id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id, workspace_id, principal_id)
    REFERENCES nv_workspace_connections(connection_id, workspace_id, principal_id) ON DELETE CASCADE
);
CREATE INDEX nv_workspace_credentials_connection_idx ON nv_workspace_credentials(connection_id);
