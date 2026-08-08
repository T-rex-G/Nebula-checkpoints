CREATE TABLE IF NOT EXISTS nv_evidence_chain (
  seq bigserial PRIMARY KEY,
  repo_key text NOT NULL,
  kind text NOT NULL,
  record_id text NOT NULL,
  previous_hash text NOT NULL,
  record_hash text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nv_evidence_chain_repo_seq_idx ON nv_evidence_chain(repo_key, seq);
