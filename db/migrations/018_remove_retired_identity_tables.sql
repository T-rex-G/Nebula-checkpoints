-- The application no longer consumes these tables. Keep earlier migration
-- files immutable; refuse to discard any unreviewed account or credential data.
LOCK TABLE nv_workspace_credentials, nv_workspace_sessions,
  nv_workspace_connections, nv_workspace_bootstrap, nv_workspaces,
  nv_login_identities, nv_principals IN ACCESS EXCLUSIVE MODE;

DO $retirement$
BEGIN
  IF EXISTS (SELECT 1 FROM nv_workspace_credentials)
    OR EXISTS (SELECT 1 FROM nv_workspace_sessions)
    OR EXISTS (SELECT 1 FROM nv_workspace_connections)
    OR EXISTS (SELECT 1 FROM nv_workspaces)
    OR EXISTS (SELECT 1 FROM nv_login_identities)
    OR EXISTS (SELECT 1 FROM nv_principals)
    OR EXISTS (SELECT 1 FROM nv_workspace_bootstrap
      WHERE claimed_workspace_id IS NOT NULL OR claimed_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Retired identity tables contain data; complete the scoped data cleanup before migrating';
  END IF;
END
$retirement$;

-- RESTRICT is intentional: an unexpected external dependency must stop the
-- migration rather than cascade into ordinary sessions, evidence, or policy.
DROP TABLE nv_workspace_credentials;
DROP TABLE nv_workspace_sessions;
DROP TABLE nv_workspace_connections;
DROP TABLE nv_workspace_bootstrap;
DROP TABLE nv_workspaces;
DROP TABLE nv_login_identities;
DROP TABLE nv_principals;
