-- What the issuing provider said about a credential, and when.
--
-- This is a separate table rather than a column on the finding, and rather
-- than an edit to the observation that found it, for two reasons.
--
-- An observation records what a scan saw in a tree at a commit. It is a
-- measurement and it is written once. Whether the credential still works is a
-- different question, asked later, answered by somebody else's service, and
-- answerable again tomorrow with a different answer. Storing it on the
-- observation would mean editing a measurement after the fact.
--
-- And the history matters. "Verified live on Tuesday, rejected on Friday" is
-- the sequence that tells a reader their revocation worked. Keeping only the
-- latest answer throws away the one thing that proves the exposure ended, so
-- every attempt is kept and none is ever updated.
--
-- What is deliberately absent: the credential, any part of it, the response
-- body, and the provider login. The subject arrives already digested under its
-- own derived key, so two findings belonging to one provider account can be
-- recognised as such without this table holding the account.
CREATE TABLE nv_exposure_verifications (
  verification_id uuid PRIMARY KEY,

  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 255),
  owner_login text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 255),
  repo_name text NOT NULL CHECK (length(repo_name) BETWEEN 1 AND 255),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),

  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  -- Who asked. A verification uses somebody else's credential against a third
  -- party, so the person who decided that is part of the record.
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 255),

  -- Which adapter asked, and at what version. An answer from a reviewed
  -- adapter and an answer from a later, different one are not the same
  -- evidence.
  adapter text NULL CHECK (adapter IS NULL OR adapter ~ '^[a-z][a-z0-9-]{2,63}$'),
  adapter_version integer NULL CHECK (adapter_version IS NULL OR adapter_version >= 1),
  target_id text NULL CHECK (target_id IS NULL OR length(target_id) BETWEEN 1 AND 255),
  authorization_id text NULL CHECK (authorization_id IS NULL OR length(authorization_id) BETWEEN 1 AND 200),

  state text NOT NULL CHECK (state IN ('verified', 'rejected', 'unverifiable')),
  reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9-]{2,63}$'),
  subject_digest text NULL CHECK (subject_digest IS NULL OR subject_digest ~ '^[0-9a-f]{32}$'),
  retry_after_ms integer NULL
    CHECK (retry_after_ms IS NULL OR retry_after_ms BETWEEN 1000 AND 3600000),

  -- Only a verdict can name a provider account. An unverifiable attempt never
  -- reached one, so a subject on it would be an invention.
  CHECK (subject_digest IS NULL OR state = 'verified'),

  observed_at timestamptz NOT NULL DEFAULT now(),
  -- When this answer stops being current. A stale `verified` is still a record
  -- of a credential seen live; it never becomes a rejection by waiting.
  freshness_deadline timestamptz NOT NULL,
  CHECK (freshness_deadline > observed_at),

  FOREIGN KEY (provider, authority, owner_login, repo_name, fingerprint)
    REFERENCES nv_exposure_findings (provider, authority, owner_login, repo_name, fingerprint)
    ON DELETE CASCADE
);

-- The latest attempt for a finding is the common read, and the history is the
-- occasional one. Both walk this index.
CREATE INDEX nv_exposure_verifications_finding_idx
  ON nv_exposure_verifications (provider, authority, owner_login, repo_name, fingerprint, observed_at DESC);

CREATE INDEX nv_exposure_verifications_identity_idx
  ON nv_exposure_verifications (identity_key);
