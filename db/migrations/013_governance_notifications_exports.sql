CREATE TABLE IF NOT EXISTS nv_governance_event_outbox (
  event_seq bigserial PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('lifecycle','runtime-decision')),
  source_seq bigint NOT NULL CHECK (source_seq > 0),
  source_id uuid NOT NULL,
  scope_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'policy.created','draft.created','draft.updated','version.created',
    'reviewer.assigned','approval.recorded','policy.activated','policy.rolled-back',
    'exception.requested','exception.approved','exception.rejected','exception.revoked',
    'policy.decision.allow','policy.decision.warn','policy.decision.block'
  )),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_kind,source_id),
  UNIQUE(source_kind,source_seq)
);
CREATE INDEX IF NOT EXISTS nv_governance_event_outbox_scope_seq_idx
  ON nv_governance_event_outbox(scope_key,event_seq ASC);
CREATE INDEX IF NOT EXISTS nv_governance_event_outbox_type_time_idx
  ON nv_governance_event_outbox(event_type,occurred_at DESC);

INSERT INTO nv_governance_event_outbox(source_kind,source_seq,source_id,scope_key,event_type,occurred_at)
SELECT source_kind,source_seq,source_id,scope_key,event_type,occurred_at
FROM (
  SELECT 'lifecycle'::text AS source_kind,a.seq AS source_seq,a.event_id AS source_id,
         a.scope_key,a.event_type,a.created_at AS occurred_at
    FROM nv_governance_audit a
  UNION ALL
  SELECT 'runtime-decision'::text,d.seq,d.mutation_id,d.scope_key,
         ('policy.decision.' || d.enforcement_outcome)::text,d.created_at
    FROM nv_governance_policy_decisions d
) historical
ORDER BY occurred_at ASC,source_kind ASC,source_seq ASC
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION nv_governance_enqueue_lifecycle_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO nv_governance_event_outbox(source_kind,source_seq,source_id,scope_key,event_type,occurred_at)
  VALUES('lifecycle',NEW.seq,NEW.event_id,NEW.scope_key,NEW.event_type,NEW.created_at)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION nv_governance_enqueue_policy_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO nv_governance_event_outbox(source_kind,source_seq,source_id,scope_key,event_type,occurred_at)
  VALUES('runtime-decision',NEW.seq,NEW.mutation_id,NEW.scope_key,'policy.decision.' || NEW.enforcement_outcome,NEW.created_at)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_governance_audit_event_outbox ON nv_governance_audit;
CREATE TRIGGER nv_governance_audit_event_outbox
  AFTER INSERT ON nv_governance_audit
  FOR EACH ROW EXECUTE FUNCTION nv_governance_enqueue_lifecycle_event();

DROP TRIGGER IF EXISTS nv_governance_policy_decision_event_outbox ON nv_governance_policy_decisions;
CREATE TRIGGER nv_governance_policy_decision_event_outbox
  AFTER INSERT ON nv_governance_policy_decisions
  FOR EACH ROW EXECUTE FUNCTION nv_governance_enqueue_policy_decision();

CREATE TABLE IF NOT EXISTS nv_governance_notification_preferences (
  scope_key text NOT NULL,
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  event_types jsonb NOT NULL CHECK (jsonb_typeof(event_types)='array' AND jsonb_array_length(event_types) <= 15),
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope_key,identity_key)
);

CREATE TABLE IF NOT EXISTS nv_governance_webhooks (
  webhook_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  authority text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  endpoint_url text NOT NULL CHECK (length(endpoint_url) BETWEEN 1 AND 2000),
  event_types jsonb NOT NULL CHECK (jsonb_typeof(event_types)='array' AND jsonb_array_length(event_types) BETWEEN 1 AND 15),
  enabled boolean NOT NULL DEFAULT true,
  secret_salt text NOT NULL CHECK (secret_salt ~ '^[0-9a-f]{64}$'),
  secret_version integer NOT NULL DEFAULT 1 CHECK (secret_version BETWEEN 1 AND 1000000),
  created_by_identity_key text NOT NULL CHECK (created_by_identity_key ~ '^[0-9a-f]{64}$'),
  created_by_login text NOT NULL CHECK (length(created_by_login) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_webhooks_scope_name_idx
  ON nv_governance_webhooks(scope_key,lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS nv_governance_webhooks_scope_idx
  ON nv_governance_webhooks(scope_key,created_at ASC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS nv_governance_webhook_deliveries (
  delivery_id uuid PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES nv_governance_webhooks(webhook_id) ON DELETE RESTRICT,
  event_seq bigint NOT NULL REFERENCES nv_governance_event_outbox(event_seq) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','retry','delivered','dead-letter')),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_status_code integer CHECK (last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(webhook_id,event_seq)
);
CREATE INDEX IF NOT EXISTS nv_governance_webhook_deliveries_due_idx
  ON nv_governance_webhook_deliveries(next_attempt_at,delivery_id)
  WHERE status IN ('pending','retry','delivering');
CREATE INDEX IF NOT EXISTS nv_governance_webhook_deliveries_webhook_time_idx
  ON nv_governance_webhook_deliveries(webhook_id,created_at DESC,delivery_id DESC);

CREATE TABLE IF NOT EXISTS nv_governance_webhook_attempts (
  attempt_id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES nv_governance_webhook_deliveries(delivery_id) ON DELETE RESTRICT,
  attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 5),
  event_hash text NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  request_timestamp timestamptz NOT NULL,
  signature_hash text NOT NULL CHECK (signature_hash ~ '^[0-9a-f]{64}$'),
  result text NOT NULL CHECK (result IN ('delivered','retry','dead-letter')),
  status_code integer CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(delivery_id,attempt_number)
);
CREATE INDEX IF NOT EXISTS nv_governance_webhook_attempts_delivery_idx
  ON nv_governance_webhook_attempts(delivery_id,attempt_number ASC);

CREATE TABLE IF NOT EXISTS nv_governance_exports (
  export_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  authority text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  actor_identity_key text NOT NULL CHECK (actor_identity_key ~ '^[0-9a-f]{64}$'),
  actor_login text NOT NULL CHECK (length(actor_login) BETWEEN 1 AND 200),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  export_format text NOT NULL CHECK (export_format IN ('json','csv')),
  after_event_seq bigint NOT NULL CHECK (after_event_seq >= 0),
  through_event_seq bigint CHECK (through_event_seq IS NULL OR through_event_seq > after_event_seq),
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 1000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object' AND (manifest->>'schemaVersion')='1'),
  signature jsonb NOT NULL CHECK (jsonb_typeof(signature)='object' AND (signature->>'algorithm')='hmac-sha256'),
  content text NOT NULL CHECK (octet_length(content) <= 4194304),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nv_governance_exports_idempotency_idx
  ON nv_governance_exports(scope_key,actor_identity_key,idempotency_key_hash);
CREATE INDEX IF NOT EXISTS nv_governance_exports_scope_time_idx
  ON nv_governance_exports(scope_key,created_at DESC,export_id DESC);

CREATE OR REPLACE FUNCTION nv_governance_delivery_uuid(webhook uuid,event_number bigint)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (substr(value,1,8) || '-' || substr(value,9,4) || '-4' || substr(value,14,3) || '-8' || substr(value,18,3) || '-' || substr(value,21,12))::uuid
  FROM (SELECT md5(webhook::text || ':' || event_number::text) AS value) source;
$$;

CREATE OR REPLACE FUNCTION nv_governance_enqueue_webhook_deliveries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO nv_governance_webhook_deliveries(delivery_id,webhook_id,event_seq,status,attempt_count,next_attempt_at,created_at,updated_at)
  SELECT nv_governance_delivery_uuid(w.webhook_id,NEW.event_seq),w.webhook_id,NEW.event_seq,'pending',0,NEW.created_at,NEW.created_at,NEW.created_at
    FROM nv_governance_webhooks w
   WHERE w.scope_key=NEW.scope_key AND w.enabled=true AND w.deleted_at IS NULL
     AND w.event_types @> to_jsonb(ARRAY[NEW.event_type]::text[])
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nv_governance_event_webhook_deliveries ON nv_governance_event_outbox;
CREATE TRIGGER nv_governance_event_webhook_deliveries
  AFTER INSERT ON nv_governance_event_outbox
  FOR EACH ROW EXECUTE FUNCTION nv_governance_enqueue_webhook_deliveries();

DROP TRIGGER IF EXISTS nv_governance_event_outbox_immutable ON nv_governance_event_outbox;
CREATE TRIGGER nv_governance_event_outbox_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_event_outbox
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();
DROP TRIGGER IF EXISTS nv_governance_event_outbox_immutable_truncate ON nv_governance_event_outbox;
CREATE TRIGGER nv_governance_event_outbox_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_event_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_webhook_attempts_immutable ON nv_governance_webhook_attempts;
CREATE TRIGGER nv_governance_webhook_attempts_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_webhook_attempts
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();
DROP TRIGGER IF EXISTS nv_governance_webhook_attempts_immutable_truncate ON nv_governance_webhook_attempts;
CREATE TRIGGER nv_governance_webhook_attempts_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_webhook_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();

DROP TRIGGER IF EXISTS nv_governance_exports_immutable ON nv_governance_exports;
CREATE TRIGGER nv_governance_exports_immutable
  BEFORE UPDATE OR DELETE ON nv_governance_exports
  FOR EACH ROW EXECUTE FUNCTION nv_governance_reject_history_mutation();
DROP TRIGGER IF EXISTS nv_governance_exports_immutable_truncate ON nv_governance_exports;
CREATE TRIGGER nv_governance_exports_immutable_truncate
  BEFORE TRUNCATE ON nv_governance_exports
  FOR EACH STATEMENT EXECUTE FUNCTION nv_governance_reject_history_mutation();
