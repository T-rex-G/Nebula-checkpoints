-- Exposure scanning: what a scan of a repository was, what it found, and what
-- each scan observed. Three tables, and the shape of each is decided by one
-- rule: this server stores what it learned about a repository and never any
-- part of the repository itself.
--
-- That rule cannot be kept by a serializer alone. A serializer is a promise in
-- application code, and the next caller to add a column will not read it. So
-- the columns that could plausibly carry a credential are constrained to
-- shapes a credential cannot take: fingerprints and digests are fixed-length
-- hex, the placeholder is a generated label matched by pattern, and the
-- locations of a credential inside a file are integer arrays. An integer array
-- cannot hold a secret. Neither can a column that only admits 64 hex
-- characters. The absence of a `secret` column proves nothing; these do.
--
-- What is deliberately not here: no file contents, no source excerpt, no
-- redacted line, no probe response body, no provider credential, and no
-- session. A scan job resolves an existing authorized session at execution
-- rather than keeping a copy of one, so revocation stops the next read instead
-- of being a row somebody has to remember to delete.

-- One row per scan run. A scan is an observation of one commit, and a rescan
-- of the same commit is a new observation rather than an edit of the old one.
CREATE TABLE nv_exposure_scans (
  scan_id uuid PRIMARY KEY,

  -- The existing scope quadruple, so every read can apply the boundary the
  -- rest of the server already applies.
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 255),
  owner_login text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 255),
  repo_name text NOT NULL CHECK (length(repo_name) BETWEEN 1 AND 255),

  -- The identity the work belongs to, in the same hashed form every other
  -- table here uses, so the existing purge path can delete it by the same key
  -- rather than needing a second model of who owns what.
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 255),

  -- A ref is what the reader authorized; a commit is what was actually read.
  -- Both are stored because a branch moves. Comparing two scans of one branch
  -- is only meaningful if each says which tree it saw.
  ref_name text NOT NULL CHECK (length(ref_name) BETWEEN 1 AND 255),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),

  -- Identity of a finding depends on all four, so a scan records all four.
  -- Without them, a scan run after a key rotation or a rule change would be
  -- compared against one run before it, and every finding would look resolved.
  rules_version integer NOT NULL CHECK (rules_version >= 1),
  engine_version integer NOT NULL CHECK (engine_version >= 1),
  fingerprint_key_version integer NOT NULL CHECK (fingerprint_key_version >= 1),
  config_version integer NOT NULL CHECK (config_version >= 1),

  state text NOT NULL
    CHECK (state IN ('queued', 'running', 'complete', 'partial', 'failed', 'canceled')),

  -- Coverage is separate from state on purpose. A scan can finish and still
  -- have read only part of a repository, and the difference decides whether it
  -- is allowed to conclude anything about a finding that is no longer there.
  coverage text NOT NULL CHECK (coverage IN ('unknown', 'complete', 'partial')),
  skipped_reason text NULL
    CHECK (skipped_reason IS NULL OR skipped_reason IN (
      'file-count-limit', 'byte-limit', 'time-limit', 'tree-truncated',
      'unreadable-files', 'canceled', 'transport-refused'
    )),

  files_scanned integer NOT NULL DEFAULT 0 CHECK (files_scanned >= 0),
  bytes_scanned bigint NOT NULL DEFAULT 0 CHECK (bytes_scanned >= 0),

  -- Explicit lineage rather than an inferred predecessor. A comparison needs to
  -- know which earlier scan it is comparing against, and inferring "the last
  -- complete one" silently compares across refs the moment a second branch is
  -- ever scanned.
  parent_scan_id uuid NULL REFERENCES nv_exposure_scans (scan_id) ON DELETE SET NULL,

  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),

  -- Execution ownership, leased rather than held. A worker that dies holds
  -- nothing once its lease expires, and the reclaim is a condition on the
  -- expiry rather than a heartbeat somebody has to trust.
  claim_owner text NULL CHECK (claim_owner IS NULL OR length(claim_owner) BETWEEN 1 AND 200),
  claim_expires_at timestamptz NULL,

  retain_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,

  -- A terminal scan has finished; a live one has not. Stated as a constraint
  -- because a status API that reports a finish time for a queued scan is a
  -- status API nobody can read.
  CHECK ((state IN ('complete', 'partial', 'failed', 'canceled')) = (finished_at IS NOT NULL)),
  -- Only a scan that finished and read everything may be used to conclude that
  -- something is gone. Recorded here so the conclusion cannot be reached by an
  -- application forgetting to check.
  CHECK (coverage <> 'complete' OR state = 'complete'),
  CHECK (state <> 'partial' OR coverage = 'partial')
);

-- Idempotency is the database's, not the caller's. Two requests carrying one
-- key cannot both create a scan, whatever order they arrive in and however
-- many processes they arrive at.
CREATE UNIQUE INDEX nv_exposure_scans_idempotency_idx
  ON nv_exposure_scans (provider, authority, owner_login, repo_name, idempotency_key);

-- One live scan per repository, enforced by a partial unique index. This is
-- the whole of the admission control for execution ownership: a second worker
-- cannot start a scan of a repository that already has one, because the insert
-- fails. Nothing depends on a process remembering what it started.
CREATE UNIQUE INDEX nv_exposure_scans_active_idx
  ON nv_exposure_scans (provider, authority, owner_login, repo_name)
  WHERE state IN ('queued', 'running');

CREATE INDEX nv_exposure_scans_identity_idx ON nv_exposure_scans (identity_key);
CREATE INDEX nv_exposure_scans_retention_idx ON nv_exposure_scans (retain_until);
CREATE INDEX nv_exposure_scans_lineage_idx
  ON nv_exposure_scans (provider, authority, owner_login, repo_name, ref_name, finished_at);

-- One row per credential per repository. The fingerprint already includes the
-- scope, so a fingerprint from one repository cannot match a row in another;
-- the scope is in the key as well, because a boundary held in two places is a
-- boundary that survives one of them being forgotten.
CREATE TABLE nv_exposure_findings (
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 255),
  owner_login text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 255),
  repo_name text NOT NULL CHECK (length(repo_name) BETWEEN 1 AND 255),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),

  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),

  fingerprint_key_version integer NOT NULL CHECK (fingerprint_key_version >= 1),
  rules_version integer NOT NULL CHECK (rules_version >= 1),
  engine_version integer NOT NULL CHECK (engine_version >= 1),

  rule text NOT NULL CHECK (length(rule) BETWEEN 1 AND 64),
  -- A path is the only free-form text here, and it is bounded. It is also the
  -- only column a pathological repository could use to store text of its
  -- choosing, which is why nothing downstream renders it as anything but text.
  file_path text NOT NULL CHECK (length(file_path) BETWEEN 1 AND 1024),
  -- A generated label, matched by pattern. A partially redacted credential
  -- would fail this check, which is the point: the prefix of a token is the
  -- part that identifies the provider and often the account.
  placeholder text NOT NULL CHECK (placeholder ~ '^<[a-z-]+ #[0-9]+>$'),

  -- Four dispositions, and the distinctions between them are the product.
  --
  -- `open` is a credential believed live or unexamined. `credential-rejected`
  -- is the issuing provider saying the credential no longer works, which is
  -- the only disposition that means the exposure is actually over.
  -- `accepted-risk` is a person deciding, and it records who.
  --
  -- `removed-from-tree` is the careful one. It means a complete scan of the
  -- same ref no longer finds the credential in the tree -- and that is not the
  -- same as the credential being safe. It is still in the repository's history,
  -- reachable by anybody with a clone, so this disposition deliberately does
  -- not read as resolved anywhere.
  disposition text NOT NULL DEFAULT 'open'
    CHECK (disposition IN ('open', 'credential-rejected', 'accepted-risk', 'removed-from-tree')),
  disposition_at timestamptz NULL,
  disposition_by text NULL CHECK (disposition_by IS NULL OR length(disposition_by) BETWEEN 1 AND 255),
  -- Only a person's decision names a person. A provider's refusal and a tree
  -- comparison have no actor, and recording one would invent an approval.
  CHECK ((disposition = 'accepted-risk') = (disposition_by IS NOT NULL)),
  CHECK ((disposition = 'open') = (disposition_at IS NULL)),

  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_observed_at >= first_observed_at),

  PRIMARY KEY (provider, authority, owner_login, repo_name, fingerprint)
);

CREATE INDEX nv_exposure_findings_identity_idx ON nv_exposure_findings (identity_key);
CREATE INDEX nv_exposure_findings_disposition_idx
  ON nv_exposure_findings (provider, authority, owner_login, repo_name, disposition);

-- One row per finding per scan, written once and never updated. A scan is a
-- measurement, and editing a measurement after the fact loses the only record
-- of what was true at a commit.
CREATE TABLE nv_exposure_observations (
  scan_id uuid NOT NULL REFERENCES nv_exposure_scans (scan_id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),

  occurrence_count integer NOT NULL CHECK (occurrence_count >= 1),
  -- Locations as integer arrays rather than a structure that could carry text.
  -- This is the schema making the privacy claim instead of the serializer: a
  -- caller that tried to store a source line here would be storing it in an
  -- integer column, which fails.
  occurrence_lines integer[] NOT NULL
    CHECK (array_length(occurrence_lines, 1) BETWEEN 1 AND 20),
  occurrence_columns integer[] NOT NULL
    CHECK (array_length(occurrence_columns, 1) = array_length(occurrence_lines, 1)),
  truncated boolean NOT NULL DEFAULT false,
  CHECK (occurrence_count >= array_length(occurrence_lines, 1)),
  CHECK (truncated = (occurrence_count > array_length(occurrence_lines, 1))),

  -- What the issuing provider said, if it was asked. Three states, a bounded
  -- reason, and a keyed digest of the provider identity rather than the login.
  verification_state text NULL
    CHECK (verification_state IS NULL OR verification_state IN ('verified', 'rejected', 'unverifiable')),
  verification_reason text NULL CHECK (verification_reason IS NULL OR verification_reason ~ '^[a-z][a-z0-9-]{2,63}$'),
  verification_adapter text NULL CHECK (verification_adapter IS NULL OR verification_adapter ~ '^[a-z][a-z0-9-]{2,63}$'),
  verification_subject_digest text NULL
    CHECK (verification_subject_digest IS NULL OR verification_subject_digest ~ '^[0-9a-f]{32}$'),
  verification_observed_at timestamptz NULL,
  verification_freshness_deadline timestamptz NULL,
  verification_retry_after_ms integer NULL
    CHECK (verification_retry_after_ms IS NULL OR verification_retry_after_ms BETWEEN 1000 AND 3600000),
  -- A verification either happened or did not. A state without a time, or a
  -- time without a state, is a half-written record nobody can interpret.
  CHECK ((verification_state IS NULL) = (verification_observed_at IS NULL)),
  CHECK (verification_state IS NOT NULL OR verification_reason IS NULL),

  observed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (scan_id, fingerprint)
);

CREATE INDEX nv_exposure_observations_fingerprint_idx
  ON nv_exposure_observations (fingerprint);
