-- The same history scan can restart after a lost lease. Keep each commit's
-- sighting once instead of incrementing a counter every time it is replayed.
-- Only bounded identifiers are retained; deletion follows the observation.
CREATE TABLE nv_exposure_history_sightings (
  scan_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  PRIMARY KEY (scan_id, fingerprint, commit_sha),
  FOREIGN KEY (scan_id, fingerprint)
    REFERENCES nv_exposure_observations (scan_id, fingerprint) ON DELETE CASCADE
);

-- Old counts cannot be reconstructed from the single introduction commit.
-- Preserve their evidence, but expose no exact count for those legacy rows.
-- Only writers that maintain the dedupe ledger may opt into exact counts.
-- Older writers must retain an unknown count during deployment or rollback.
ALTER TABLE nv_exposure_observations
  ADD COLUMN history_count_exact boolean NOT NULL DEFAULT false;
