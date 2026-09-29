-- Repository audits, kept: what each audit concluded, what it found, what the
-- repository was built from, and what has been published about those
-- components since.
--
-- The rule is the one the exposure tables follow: this server stores what it
-- learned about a repository and never any part of the repository itself. An
-- audit reads source files, and its result in memory carries a trace through
-- them, a fix prompt, advisory summaries and the lines where a waiver was
-- written. None of that is stored. What is stored is shaped so that it cannot
-- be: a rule id, a severity, a verdict, a bounded path and a line number; a
-- package name, a version and advisory ids, each matched against the shape
-- such a thing takes; counts; and a handful of numbers. There is no free-text
-- column in these tables that a line of code could be written into, and no
-- jsonb column that a later serializer could quietly widen.
--
-- Everything belongs to an identity -- the same hashed key every other table
-- here uses -- so an account purge removes it by that key, and a reader sees
-- only the audits they ran.

-- One row per completed audit. An audit of the same commit twice is two rows:
-- each is an observation, and the history is the list of them.
CREATE TABLE nv_code_audits (
  audit_id uuid PRIMARY KEY,

  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 255),
  owner_login text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 255),
  repo_name text NOT NULL CHECK (length(repo_name) BETWEEN 1 AND 255),
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),

  -- The branch that was asked for and the commit that was read. A branch
  -- moves; the history compares audits of one branch, each at its commit.
  ref_name text NOT NULL CHECK (length(ref_name) BETWEEN 1 AND 255),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  engine_version text NOT NULL CHECK (engine_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  audited_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  grade text NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  cap_reason text NULL CHECK (cap_reason IS NULL OR cap_reason IN ('critical', 'exploited')),

  -- Category scores as two parallel arrays in the engine's own order, so a
  -- category added later is a longer array rather than a new column.
  category_ids text[] NOT NULL
    CHECK (cardinality(category_ids) BETWEEN 0 AND 16
      AND (cardinality(category_ids) = 0 OR array_to_string(category_ids, ',') ~ '^[a-z][a-z-]{1,31}(,[a-z][a-z-]{1,31})*$')),
  category_scores smallint[] NOT NULL
    CHECK (cardinality(category_scores) = cardinality(category_ids)
      AND 0 <= ALL (category_scores) AND 100 >= ALL (category_scores)),

  critical_count integer NOT NULL CHECK (critical_count >= 0),
  serious_count integer NOT NULL CHECK (serious_count >= 0),
  warning_count integer NOT NULL CHECK (warning_count >= 0),
  to_confirm_count integer NOT NULL CHECK (to_confirm_count >= 0),
  waived_count integer NOT NULL CHECK (waived_count >= 0),
  exploited_count integer NOT NULL CHECK (exploited_count >= 0),
  risk_urgent integer NOT NULL CHECK (risk_urgent >= 0),
  risk_high integer NOT NULL CHECK (risk_high >= 0),
  risk_moderate integer NOT NULL CHECK (risk_moderate >= 0),
  risk_low integer NOT NULL CHECK (risk_low >= 0),

  files_read integer NOT NULL CHECK (files_read >= 0),
  files_eligible integer NOT NULL CHECK (files_eligible >= 0),
  coverage_complete boolean NOT NULL,
  components_total integer NOT NULL CHECK (components_total >= 0),

  -- Findings are stored up to a ceiling, worst first. A history row always
  -- says how many there were, so a truncated list never reads as a short one.
  findings_total integer NOT NULL CHECK (findings_total >= 0),
  findings_stored integer NOT NULL CHECK (findings_stored BETWEEN 0 AND 1500),
  CHECK (findings_stored <= findings_total),

  -- Against the previous audit of the same branch, decided when this one was
  -- recorded: null on the first, because nothing was compared.
  new_count integer NULL CHECK (new_count IS NULL OR new_count >= 0),
  resolved_count integer NULL CHECK (resolved_count IS NULL OR resolved_count >= 0),
  CHECK ((new_count IS NULL) = (resolved_count IS NULL)),

  -- The watch's last answer for this audit's components.
  watch_checked_at timestamptz NULL,
  watch_state text NULL CHECK (watch_state IS NULL OR watch_state IN ('ok', 'partial', 'unavailable')),
  watch_checked integer NULL CHECK (watch_checked IS NULL OR watch_checked >= 0),
  watch_total integer NULL CHECK (watch_total IS NULL OR watch_total >= 0),
  watch_kev text NULL CHECK (watch_kev IS NULL OR watch_kev IN ('ok', 'unavailable', 'not-needed')),
  CHECK ((watch_checked_at IS NULL) = (watch_state IS NULL))
);

-- The only two shapes anything reads: one branch's history for one identity,
-- newest first, and everything one identity owns, for the purge.
CREATE INDEX nv_code_audits_history_idx
  ON nv_code_audits (provider, authority, owner_login, repo_name, identity_key, ref_name, audited_at DESC, audit_id);
CREATE INDEX nv_code_audits_identity_idx ON nv_code_audits (identity_key);

-- What one audit found, one row per finding.
CREATE TABLE nv_code_audit_findings (
  audit_id uuid NOT NULL REFERENCES nv_code_audits (audit_id) ON DELETE CASCADE,
  finding_id text NOT NULL CHECK (finding_id ~ '^[0-9a-f]{24}$'),
  rule text NOT NULL CHECK (rule ~ '^[A-Z]{2,4}-[0-9]{3}$'),
  category text NOT NULL CHECK (category ~ '^[a-z][a-z-]{1,31}$'),
  severity text NOT NULL CHECK (severity IN ('critical', 'serious', 'warning')),
  verdict text NOT NULL CHECK (verdict IN ('confirmed', 'needs-validation')),
  file_path text NULL CHECK (file_path IS NULL OR length(file_path) BETWEEN 1 AND 1024),
  line_number integer NULL CHECK (line_number IS NULL OR line_number BETWEEN 1 AND 100000000),

  -- A vulnerable package, when the finding is one.
  ecosystem text NULL
    CHECK (ecosystem IS NULL OR ecosystem IN ('npm', 'pypi', 'go', 'maven', 'packagist', 'rubygems', 'cargo', 'nuget')),
  package_name text NULL
    CHECK (package_name IS NULL OR (length(package_name) BETWEEN 1 AND 214 AND package_name ~ '^[A-Za-z0-9@_.][A-Za-z0-9@/._:+~-]*$')),
  package_version text NULL
    CHECK (package_version IS NULL OR package_version ~ '^[A-Za-z0-9][A-Za-z0-9._+~:!-]{0,99}$'),
  fixed_version text NULL
    CHECK (fixed_version IS NULL OR fixed_version ~ '^[A-Za-z0-9][A-Za-z0-9._+~:!-]{0,99}$'),
  advisory_ids text[] NULL
    CHECK (advisory_ids IS NULL OR (cardinality(advisory_ids) BETWEEN 1 AND 6
      AND array_to_string(advisory_ids, ' ') ~ '^[A-Za-z][A-Za-z0-9._-]{2,63}( [A-Za-z][A-Za-z0-9._-]{2,63})*$')),
  cve_ids text[] NULL
    CHECK (cve_ids IS NULL OR (cardinality(cve_ids) BETWEEN 1 AND 6
      AND array_to_string(cve_ids, ' ') ~ '^CVE-[0-9]{4}-[0-9]{4,7}( CVE-[0-9]{4}-[0-9]{4,7})*$')),
  cvss numeric(3, 1) NULL CHECK (cvss IS NULL OR cvss BETWEEN 0 AND 10),
  risk_score smallint NULL CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
  risk_band text NULL CHECK (risk_band IS NULL OR risk_band IN ('urgent', 'high', 'moderate', 'low')),
  reach_tier text NULL
    CHECK (reach_tier IS NULL OR reach_tier IN ('imported', 'named', 'bundled', 'transitive', 'installed', 'unknown', 'build', 'test', 'dev')),
  exploited boolean NOT NULL DEFAULT false,
  ransomware boolean NOT NULL DEFAULT false,
  epss numeric(6, 5) NULL CHECK (epss IS NULL OR epss BETWEEN 0 AND 1),
  CHECK (ransomware = false OR exploited = true),
  CHECK ((package_name IS NULL) = (ecosystem IS NULL) AND (package_name IS NULL) = (package_version IS NULL)),
  PRIMARY KEY (audit_id, finding_id)
);

-- What the repository was built from at the latest audit of each branch: the
-- bill of materials, reduced to what the watch needs, with the advisory ids,
-- CVEs and catalog-listed CVEs the audit already knew for each version. Only
-- the latest audits of a repository keep these rows; the store removes them
-- from an audit once a newer one of the same branch is recorded.
CREATE TABLE nv_code_audit_components (
  audit_id uuid NOT NULL REFERENCES nv_code_audits (audit_id) ON DELETE CASCADE,
  ecosystem text NOT NULL
    CHECK (ecosystem IN ('npm', 'pypi', 'go', 'maven', 'packagist', 'rubygems', 'cargo', 'nuget')),
  package_name text NOT NULL
    CHECK (length(package_name) BETWEEN 1 AND 214 AND package_name ~ '^[A-Za-z0-9@_.][A-Za-z0-9@/._:+~-]*$'),
  package_version text NOT NULL CHECK (package_version ~ '^[A-Za-z0-9][A-Za-z0-9._+~:!-]{0,99}$'),
  direct boolean NOT NULL,
  dev boolean NOT NULL,
  advisory_ids text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(advisory_ids) <= 200
      AND (cardinality(advisory_ids) = 0 OR array_to_string(advisory_ids, ' ') ~ '^[A-Za-z][A-Za-z0-9._-]{2,63}( [A-Za-z][A-Za-z0-9._-]{2,63})*$')),
  cve_ids text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(cve_ids) <= 200
      AND (cardinality(cve_ids) = 0 OR array_to_string(cve_ids, ' ') ~ '^CVE-[0-9]{4}-[0-9]{4,7}( CVE-[0-9]{4}-[0-9]{4,7})*$')),
  exploited_cve_ids text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(exploited_cve_ids) <= 200
      AND (cardinality(exploited_cve_ids) = 0 OR array_to_string(exploited_cve_ids, ' ') ~ '^CVE-[0-9]{4}-[0-9]{4,7}( CVE-[0-9]{4}-[0-9]{4,7})*$')),
  PRIMARY KEY (audit_id, ecosystem, package_name, package_version)
);

-- What the watch found for an audit's components: an advisory published for
-- a stored version since the audit, or a CVE the audit reported that CISA has
-- since listed as exploited. Keyed by a digest of what it is about, so a
-- second check finds the same row and keeps the date it was first seen.
CREATE TABLE nv_code_audit_alerts (
  audit_id uuid NOT NULL REFERENCES nv_code_audits (audit_id) ON DELETE CASCADE,
  alert_key text NOT NULL CHECK (alert_key ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('advisory', 'exploited')),
  ecosystem text NOT NULL
    CHECK (ecosystem IN ('npm', 'pypi', 'go', 'maven', 'packagist', 'rubygems', 'cargo', 'nuget')),
  package_name text NOT NULL
    CHECK (length(package_name) BETWEEN 1 AND 214 AND package_name ~ '^[A-Za-z0-9@_.][A-Za-z0-9@/._:+~-]*$'),
  package_version text NOT NULL CHECK (package_version ~ '^[A-Za-z0-9][A-Za-z0-9._+~:!-]{0,99}$'),
  direct boolean NOT NULL,
  dev boolean NOT NULL,
  advisory_id text NULL CHECK (advisory_id IS NULL OR advisory_id ~ '^[A-Za-z][A-Za-z0-9._-]{2,63}$'),
  cve_id text NULL CHECK (cve_id IS NULL OR cve_id ~ '^CVE-[0-9]{4}-[0-9]{4,7}$'),
  severity text NULL CHECK (severity IS NULL OR severity IN ('critical', 'serious', 'warning')),
  cvss numeric(3, 1) NULL CHECK (cvss IS NULL OR cvss BETWEEN 0 AND 10),
  fixed_version text NULL CHECK (fixed_version IS NULL OR fixed_version ~ '^[A-Za-z0-9][A-Za-z0-9._+~:!-]{0,99}$'),
  malicious boolean NOT NULL DEFAULT false,
  exploited boolean NOT NULL DEFAULT false,
  ransomware boolean NOT NULL DEFAULT false,
  kev_added date NULL,
  kev_due date NULL,
  epss numeric(6, 5) NULL CHECK (epss IS NULL OR epss BETWEEN 0 AND 1),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (kind <> 'advisory' OR advisory_id IS NOT NULL),
  CHECK (kind <> 'exploited' OR (cve_id IS NOT NULL AND exploited = true)),
  CHECK (ransomware = false OR exploited = true),
  PRIMARY KEY (audit_id, alert_key)
);
