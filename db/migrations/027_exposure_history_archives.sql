-- A scan that reads history, credentials found by decoding, and archives.
--
-- A credential deleted in the commit after the one that added it is still in
-- the repository: anyone with a clone can check out the earlier commit. The
-- tree at one commit cannot show that, so a scan can now also read every
-- commit's changes. These columns say which kind of scan a row is, how much of
-- the history it read, and -- per observation -- whether the credential is in
-- the current tree at all, and which commit introduced it.
--
-- Nothing here holds more of a repository than before: a commit id, a date and
-- counts. No author, no message, no line of any file.

-- 'history' reads the tree at the scan's commit and every commit's changes
-- reachable from it. A history scan may start from where an earlier complete
-- history scan of the same ref by the same person stopped, and says so.
ALTER TABLE nv_exposure_scans
  ADD COLUMN scan_mode text NOT NULL DEFAULT 'tree'
    CHECK (scan_mode IN ('tree', 'history')),
  ADD COLUMN history_base_commit text NULL
    CHECK (history_base_commit IS NULL OR history_base_commit ~ '^[0-9a-f]{40}$'),
  ADD COLUMN commits_total integer NULL
    CHECK (commits_total IS NULL OR commits_total BETWEEN 0 AND 2000000000),
  ADD COLUMN commits_scanned integer NULL
    CHECK (commits_scanned IS NULL OR commits_scanned BETWEEN 0 AND 2000000000),
  ADD COLUMN commits_skipped integer NULL
    CHECK (commits_skipped IS NULL OR commits_skipped BETWEEN 0 AND 2000000000),
  ADD COLUMN archives_scanned integer NULL
    CHECK (archives_scanned IS NULL OR archives_scanned BETWEEN 0 AND 2000000000),
  ADD COLUMN archive_members_scanned integer NULL
    CHECK (archive_members_scanned IS NULL OR archive_members_scanned BETWEEN 0 AND 2000000000),
  ADD CONSTRAINT nv_exposure_scans_history_base_check
    CHECK (history_base_commit IS NULL OR scan_mode = 'history');

-- Two more ways a scan can stop short, each of them partial coverage: the
-- commit ceiling, and the provider asking for fewer requests.
ALTER TABLE nv_exposure_scans DROP CONSTRAINT nv_exposure_scans_skipped_reason_check;
ALTER TABLE nv_exposure_scans ADD CONSTRAINT nv_exposure_scans_skipped_reason_check
  CHECK (skipped_reason IS NULL OR skipped_reason IN (
    'file-count-limit', 'byte-limit', 'time-limit', 'tree-truncated',
    'unreadable-files', 'canceled', 'transport-refused', 'authorization-revoked',
    'finding-limit', 'configuration-changed', 'commit-limit', 'rate-limited'
  ));

-- Where a scan saw a credential. `in_tree` is null on an observation recorded
-- before this migration, which only ever read the tree. An observation not in
-- the tree has to say which commit introduced it -- a credential found
-- nowhere is not a finding -- and `decoded_from` names the encoding it was
-- hidden in, from a closed set, never the encoded bytes.
ALTER TABLE nv_exposure_observations
  ADD COLUMN in_tree boolean NULL,
  ADD COLUMN introduced_commit text NULL
    CHECK (introduced_commit IS NULL OR introduced_commit ~ '^[0-9a-f]{40}$'),
  ADD COLUMN introduced_at timestamptz NULL,
  ADD COLUMN history_commits integer NULL
    CHECK (history_commits IS NULL OR history_commits BETWEEN 1 AND 2000000000),
  ADD COLUMN decoded_from text NULL
    CHECK (decoded_from IS NULL OR decoded_from IN ('base64')),
  ADD CONSTRAINT nv_exposure_observations_history_check
    CHECK ((introduced_commit IS NULL) = (history_commits IS NULL)),
  ADD CONSTRAINT nv_exposure_observations_presence_check
    CHECK (in_tree IS NOT FALSE OR introduced_commit IS NOT NULL);

-- Finding the history an incremental scan can start from.
CREATE INDEX nv_exposure_scans_history_base_idx
  ON nv_exposure_scans (provider, authority, owner_login, repo_name, identity_key, ref_name, finished_at DESC)
  WHERE scan_mode = 'history' AND state = 'complete';
