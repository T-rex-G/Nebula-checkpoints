-- Preserve the identity and exact commit behind each finding. Old queued scans
-- have no key identifier and are refused by the worker until requested again.
LOCK TABLE nv_exposure_scans, nv_exposure_findings, nv_exposure_observations,
  nv_exposure_verifications, nv_exposure_readability_probes IN ACCESS EXCLUSIVE MODE;

ALTER TABLE nv_exposure_scans ADD COLUMN fingerprint_key_id text NULL
  CHECK (fingerprint_key_id IS NULL OR fingerprint_key_id ~ '^[0-9a-f]{64}$');
ALTER TABLE nv_exposure_scans DROP CONSTRAINT nv_exposure_scans_skipped_reason_check;
ALTER TABLE nv_exposure_scans ADD CONSTRAINT nv_exposure_scans_skipped_reason_check
  CHECK (skipped_reason IS NULL OR skipped_reason IN (
    'file-count-limit', 'byte-limit', 'time-limit', 'tree-truncated',
    'unreadable-files', 'canceled', 'transport-refused', 'authorization-revoked',
    'finding-limit', 'configuration-changed'
  ));
ALTER TABLE nv_exposure_findings ADD COLUMN commit_sha text NULL
  CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$');

-- Remove dependent foreign keys before replacing the shared finding key.
DO $$
DECLARE dependent record;
BEGIN
  FOR dependent IN
    SELECT conrelid::regclass AS relation, conname
      FROM pg_constraint
     WHERE contype='f' AND confrelid='nv_exposure_findings'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', dependent.relation, dependent.conname);
  END LOOP;
END $$;

ALTER TABLE nv_exposure_findings DROP CONSTRAINT nv_exposure_findings_pkey;
ALTER TABLE nv_exposure_findings ADD PRIMARY KEY
  (provider, authority, owner_login, repo_name, fingerprint, identity_key);

-- Recover another identity's own observations without copying the first
-- identity's risk decisions or verification history.
INSERT INTO nv_exposure_findings (
  provider, authority, owner_login, repo_name, fingerprint, identity_key,
  fingerprint_key_version, rules_version, engine_version, rule, file_path,
  placeholder, first_observed_at, last_observed_at, commit_sha
)
SELECT DISTINCT ON (s.identity_key, f.provider, f.authority, f.owner_login, f.repo_name, f.fingerprint)
  f.provider, f.authority, f.owner_login, f.repo_name, f.fingerprint, s.identity_key,
  f.fingerprint_key_version, f.rules_version, f.engine_version, f.rule, f.file_path,
  f.placeholder, o.observed_at, o.observed_at, s.commit_sha
FROM nv_exposure_findings f
JOIN nv_exposure_observations o ON o.fingerprint=f.fingerprint
JOIN nv_exposure_scans s ON s.scan_id=o.scan_id AND s.provider=f.provider
  AND s.authority=f.authority AND s.owner_login=f.owner_login AND s.repo_name=f.repo_name
WHERE s.identity_key<>f.identity_key
ORDER BY s.identity_key, f.provider, f.authority, f.owner_login, f.repo_name, f.fingerprint,
  o.observed_at DESC, s.scan_id
ON CONFLICT DO NOTHING;

UPDATE nv_exposure_findings f
SET commit_sha=(
  SELECT s.commit_sha
  FROM nv_exposure_observations o
  JOIN nv_exposure_scans s ON s.scan_id=o.scan_id
  WHERE o.fingerprint=f.fingerprint AND s.identity_key=f.identity_key
    AND s.provider=f.provider AND s.authority=f.authority
    AND s.owner_login=f.owner_login AND s.repo_name=f.repo_name
  ORDER BY o.observed_at DESC, s.scan_id LIMIT 1
);

ALTER TABLE nv_exposure_verifications ADD FOREIGN KEY
  (provider, authority, owner_login, repo_name, fingerprint, identity_key)
  REFERENCES nv_exposure_findings
  (provider, authority, owner_login, repo_name, fingerprint, identity_key) ON DELETE CASCADE;
ALTER TABLE nv_exposure_readability_probes ADD FOREIGN KEY
  (provider, authority, owner_login, repo_name, fingerprint, identity_key)
  REFERENCES nv_exposure_findings
  (provider, authority, owner_login, repo_name, fingerprint, identity_key) ON DELETE CASCADE;
