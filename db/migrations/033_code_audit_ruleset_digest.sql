-- Older rows retain unknown detector provenance. A new scan supplies its own digest.
ALTER TABLE nv_code_audits ADD COLUMN ruleset_digest text NULL
  CHECK (ruleset_digest ~ '^[a-f0-9]{64}$');
