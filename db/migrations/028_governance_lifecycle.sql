-- The rest of a policy's life.
--
-- A policy could be created, drafted, reviewed, activated and rolled back, and
-- nothing else: there was no way to switch one off, set one aside, throw away
-- a draft, take back a version still waiting for review, or clear a repository
-- and start again. History stays append-only through all of it -- every change
-- here is a new row or a state column, never an edit to a record of what
-- happened.

-- Switching a policy off is one more entry in its activation history, beside
-- activate and rollback. It names the version it switched off as both the
-- version and the previous version, so "what was running before" still has
-- an answer.
ALTER TABLE nv_governance_activations DROP CONSTRAINT nv_governance_activations_action_check;
ALTER TABLE nv_governance_activations ADD CONSTRAINT nv_governance_activations_action_check
  CHECK (action IN ('activate', 'rollback', 'deactivate'));
ALTER TABLE nv_governance_activations ADD CONSTRAINT nv_governance_activations_deactivate_check
  CHECK (action <> 'deactivate' OR previous_version_id = version_id);

-- An archived policy gives its key back, so a repository that was reset can
-- be set up again from the same template without inventing a new name. Only
-- live policies need distinct keys.
ALTER TABLE nv_governance_policies DROP CONSTRAINT nv_governance_policies_scope_key_policy_key_key;
CREATE UNIQUE INDEX nv_governance_policies_live_key_idx
  ON nv_governance_policies(scope_key, policy_key) WHERE archived_at IS NULL;
CREATE INDEX nv_governance_policies_archived_idx
  ON nv_governance_policies(scope_key, archived_at DESC) WHERE archived_at IS NOT NULL;

-- A version taken back before review finished. The row carries the identity
-- key and nothing else about the person: the login and the reason are in the
-- audit ledger, which the privacy purge can reach, and this table is not.
CREATE TABLE nv_governance_version_withdrawals (
  version_id uuid PRIMARY KEY,
  policy_id uuid NOT NULL,
  scope_key text NOT NULL,
  actor_identity_key text NOT NULL CHECK (actor_identity_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (policy_id, version_id)
    REFERENCES nv_governance_policy_versions(policy_id, version_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_id, scope_key)
    REFERENCES nv_governance_policies(policy_id, scope_key) ON DELETE RESTRICT
);
CREATE TRIGGER nv_governance_version_withdrawals_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_version_withdrawals
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();
CREATE TRIGGER nv_governance_version_withdrawals_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_version_withdrawals
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();

-- The new lifecycle events reach notifications and webhooks like the others.
ALTER TABLE nv_governance_event_outbox DROP CONSTRAINT nv_governance_event_outbox_event_type_check;
ALTER TABLE nv_governance_event_outbox ADD CONSTRAINT nv_governance_event_outbox_event_type_check
  CHECK (event_type IN (
    'policy.created','draft.created','draft.updated','version.created',
    'reviewer.assigned','approval.recorded','policy.activated','policy.rolled-back',
    'exception.requested','exception.approved','exception.rejected','exception.revoked',
    'policy.decision.allow','policy.decision.warn','policy.decision.block',
    'policy.deactivated','policy.archived','policy.restored','draft.discarded','version.withdrawn'
  ));

-- A subscription may name every event type there now is. The old bound was
-- the size of the old list, so the default "everything but allow" would no
-- longer have fitted.
ALTER TABLE nv_governance_notification_preferences DROP CONSTRAINT nv_governance_notification_preferences_event_types_check;
ALTER TABLE nv_governance_notification_preferences ADD CONSTRAINT nv_governance_notification_preferences_event_types_check
  CHECK (jsonb_typeof(event_types) = 'array' AND jsonb_array_length(event_types) <= 32);
ALTER TABLE nv_governance_webhooks DROP CONSTRAINT nv_governance_webhooks_event_types_check;
ALTER TABLE nv_governance_webhooks ADD CONSTRAINT nv_governance_webhooks_event_types_check
  CHECK (jsonb_typeof(event_types) = 'array' AND jsonb_array_length(event_types) BETWEEN 1 AND 32);
