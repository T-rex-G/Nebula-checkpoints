-- What a scan did not read, in numbers, and a history that can be listed.
--
-- A finished scan already records how many files it read and the one reason
-- its coverage is partial. That reason is honest and not very useful: almost
-- every repository contains an image, so almost every scan is "partial,
-- unreadable files", and a reader cannot tell a scan that skipped three
-- logos from one that skipped half the tree. These three counts are what
-- lets a report say which it was.
--
-- They are counts and nothing else. Which files were skipped is not stored:
-- a path list would be a second copy of the repository's layout kept for as
-- long as the scan is, for a sentence that only needs the numbers.
--
-- Null on a scan that finished before this migration, rather than a zero that
-- would claim nothing was skipped.
ALTER TABLE nv_exposure_scans
  ADD COLUMN files_total integer NULL
    CHECK (files_total IS NULL OR files_total BETWEEN 0 AND 2000000000),
  ADD COLUMN files_skipped_binary integer NULL
    CHECK (files_skipped_binary IS NULL OR files_skipped_binary BETWEEN 0 AND 2000000000),
  ADD COLUMN files_skipped_other integer NULL
    CHECK (files_skipped_other IS NULL OR files_skipped_other BETWEEN 0 AND 2000000000);

-- The history is read newest first, for one repository and one identity --
-- the only shape a reader ever asks for, so it is the one indexed.
CREATE INDEX nv_exposure_scans_history_idx
  ON nv_exposure_scans (provider, authority, owner_login, repo_name, identity_key, created_at DESC, scan_id);
