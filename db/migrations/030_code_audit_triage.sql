-- What a team decided about its audit findings, how long it gives itself to
-- act on the rest, and how long the fixing took.
--
-- The rule is still the one 029 follows: nothing here can hold a line of the
-- repository. A decision is a finding id, a rule, a disposition and a reason
-- from a fixed list -- there is no note column, because a note is where a
-- line of code would be pasted -- with who made it and when. A clock is a
-- number of days. A resolution is a finding id, a rule, a severity and two
-- instants.
--
-- Additive only: two tables gain nullable columns, three are new, and nothing
-- that exists is rewritten or dropped.

-- The days the audited branch gave each severity, from its
-- .nebulaverse/audit.json or the defaults. Null on audits kept before clocks.
ALTER TABLE nv_code_audits
  ADD COLUMN sla_critical smallint NULL CHECK (sla_critical IS NULL OR sla_critical BETWEEN 1 AND 365),
  ADD COLUMN sla_serious smallint NULL CHECK (sla_serious IS NULL OR sla_serious BETWEEN 1 AND 365),
  ADD COLUMN sla_warning smallint NULL CHECK (sla_warning IS NULL OR sla_warning BETWEEN 1 AND 365),
  ADD COLUMN policy_source text NULL CHECK (policy_source IS NULL OR policy_source IN ('default', 'repository', 'invalid')),
  ADD CONSTRAINT nv_code_audits_sla_complete CHECK (
    (sla_critical IS NULL) = (policy_source IS NULL)
    AND (sla_serious IS NULL) = (policy_source IS NULL)
    AND (sla_warning IS NULL) = (policy_source IS NULL));

-- When a finding was first seen by this identity's audits of the repository,
-- carried from audit to audit; and whether this audit found it waived --
-- in the code beside it, in the repository's licence policy, or by a team
-- decision -- rather than open. A waived finding is kept so that its clock
-- survives the waiver: one whose acceptance lapses is not new.
ALTER TABLE nv_code_audit_findings
  ADD COLUMN first_seen_at timestamptz NULL,
  ADD COLUMN waived text NULL CHECK (waived IS NULL OR waived IN ('code', 'policy', 'triage'));

-- One decision per finding of a repository, shared by its collaborators: a
-- false positive, or a risk accepted until a date. Reopening a finding
-- removes its row; the event log below remembers that it was there.
CREATE TABLE nv_code_audit_triage (
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 255),
  owner_login text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 255),
  repo_name text NOT NULL CHECK (length(repo_name) BETWEEN 1 AND 255),
  finding_id text NOT NULL CHECK (finding_id ~ '^[0-9a-f]{24}$'),
  rule text NOT NULL CHECK (rule ~ '^[A-Z]{2,4}-[0-9]{3}$'),
  disposition text NOT NULL CHECK (disposition IN ('accepted-risk', 'false-positive')),
  reason text NOT NULL CHECK (reason IN (
    'not-reachable', 'validated', 'test-code', 'not-sensitive', 'misread',
    'compensating-control', 'low-impact', 'fix-scheduled', 'no-fix-available', 'third-party')),
  decided_by text NOT NULL CHECK (decided_by ~ '^(alpha:[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9._-]{0,254})$'),
  decided_by_key text NOT NULL CHECK (decided_by_key ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL,
  -- An accepted risk is accepted until a date; a false positive is not a risk to revisit.
  expires_at timestamptz NULL,
  CHECK ((disposition = 'accepted-risk') = (expires_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > decided_at),
  CHECK ((disposition = 'false-positive') = (reason IN ('not-reachable', 'validated', 'test-code', 'not-sensitive', 'misread'))),
  PRIMARY KEY (provider, authority, owner_login, repo_name, finding_id)
);
CREATE INDEX nv_code_audit_triage_decider_idx ON nv_code_audit_triage (decided_by_key);

-- Every decision and every reopening, in order: the record a reviewer reads
-- to see who accepted what, for how long, and who took it back.
CREATE TABLE nv_code_audit_triage_events (
  event_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 255),
  owner_login text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 255),
  repo_name text NOT NULL CHECK (length(repo_name) BETWEEN 1 AND 255),
  finding_id text NOT NULL CHECK (finding_id ~ '^[0-9a-f]{24}$'),
  rule text NOT NULL CHECK (rule ~ '^[A-Z]{2,4}-[0-9]{3}$'),
  event text NOT NULL CHECK (event IN ('decided', 'reopened')),
  disposition text NULL CHECK (disposition IS NULL OR disposition IN ('accepted-risk', 'false-positive')),
  reason text NULL CHECK (reason IS NULL OR reason IN (
    'not-reachable', 'validated', 'test-code', 'not-sensitive', 'misread',
    'compensating-control', 'low-impact', 'fix-scheduled', 'no-fix-available', 'third-party')),
  expires_at timestamptz NULL,
  actor text NOT NULL CHECK (actor ~ '^(alpha:[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9._-]{0,254})$'),
  actor_key text NOT NULL CHECK (actor_key ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  CHECK ((event = 'decided') = (disposition IS NOT NULL AND reason IS NOT NULL)),
  CHECK (expires_at IS NULL OR disposition = 'accepted-risk')
);
CREATE INDEX nv_code_audit_triage_events_finding_idx
  ON nv_code_audit_triage_events (provider, authority, owner_login, repo_name, finding_id, occurred_at DESC);
CREATE INDEX nv_code_audit_triage_events_actor_idx ON nv_code_audit_triage_events (actor_key);

-- A finding an audit saw that the next audit of the same branch, at the same
-- engine version and with every eligible file read, did not: the evidence
-- time to fix is measured from. Each belongs to the identity whose audits
-- observed it, like the audits themselves.
CREATE TABLE nv_code_audit_resolutions (
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 255),
  owner_login text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 255),
  repo_name text NOT NULL CHECK (length(repo_name) BETWEEN 1 AND 255),
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  ref_name text NOT NULL CHECK (length(ref_name) BETWEEN 1 AND 255),
  finding_id text NOT NULL CHECK (finding_id ~ '^[0-9a-f]{24}$'),
  rule text NOT NULL CHECK (rule ~ '^[A-Z]{2,4}-[0-9]{3}$'),
  severity text NOT NULL CHECK (severity IN ('critical', 'serious', 'warning')),
  first_seen_at timestamptz NOT NULL,
  resolved_at timestamptz NOT NULL,
  CHECK (resolved_at >= first_seen_at),
  PRIMARY KEY (provider, authority, owner_login, repo_name, identity_key, ref_name, finding_id, resolved_at)
);
CREATE INDEX nv_code_audit_resolutions_identity_idx ON nv_code_audit_resolutions (identity_key);
