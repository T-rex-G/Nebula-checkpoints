-- What the anonymous role could read, and what it was asked about.
--
-- A readability probe answers a question a scan cannot: an anonymous key in a
-- repository is published on purpose, and whether it can read anything is
-- decided by row-level security policies that live in somebody's project
-- rather than in their tree. The only honest way to find out is to ask the
-- project, with the key it published, for one row of a relation somebody
-- named.
--
-- That is an outbound request made with a discovered credential, so it is
-- recorded the same way a verification is: append-only, every attempt kept,
-- including the ones that never reached the network. An attempt refused for
-- its shape is evidence too -- it says this server was asked to probe
-- something it will not probe.
--
-- What is deliberately absent: the key, the response body, and any value from
-- inside a row. `row_count` is capped at one by the prober and is the whole
-- payload this table keeps, because "a row came back" is the entire finding.
-- Reading a row and storing it would turn a security check into a second copy
-- of somebody's data.
--
-- The relation and the projection are here because they are the question, and
-- a result without its question means nothing: "readable" is only alarming if
-- a reader knows what was read. They are operator-typed text, so they carry
-- the prober's own patterns as column constraints rather than as a promise --
-- a table name and a column name cannot hold a credential if the column will
-- not store one.
CREATE TABLE nv_exposure_readability_probes (
  probe_id uuid PRIMARY KEY,

  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 255),
  owner_login text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 255),
  repo_name text NOT NULL CHECK (length(repo_name) BETWEEN 1 AND 255),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),

  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  -- Who asked. Somebody decided to contact a third party's project with a key
  -- found in a repository, and that decision has a name on it.
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 255),
  authorization_id text NULL CHECK (authorization_id IS NULL OR length(authorization_id) BETWEEN 1 AND 200),

  -- Twenty lowercase letters, which is the only shape this server will turn
  -- into a host. Null when the attempt was refused before a project was
  -- resolved at all.
  project_ref text NULL CHECK (project_ref IS NULL OR project_ref ~ '^[a-z]{20}$'),
  -- A plain relation name: no schema qualification, no query string, no
  -- traversal, no `rpc/` call. The prober refuses anything else and so does
  -- this column, so a stored row cannot describe a request that was never
  -- permitted.
  relation text NULL CHECK (relation IS NULL OR relation ~ '^[a-z_][a-z0-9_]{0,62}$'),
  -- The columns that were asked for, in the order they were asked for, because
  -- the grant was signed over that order and a grant for `id,title` is not a
  -- grant for `title,id`.
  --
  -- Comma-joined rather than an array, and that is the point: one pattern over
  -- the whole value bounds the count, the order and every name at once, and a
  -- CHECK cannot run a subquery so an array could only have been constrained by
  -- promise. Null when the projection was refused before anything was asked --
  -- an unaskable projection is not a projection, and `reason` already says so.
  projection text NULL
    CHECK (projection IS NULL OR projection ~ '^[a-z_][a-z0-9_]{0,62}(,[a-z_][a-z0-9_]{0,62}){0,7}$'),

  state text NOT NULL CHECK (state IN ('readable', 'denied', 'unverifiable')),
  reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9-]{2,63}$'),
  -- Which role actually asked. A publishable key and an anon JWT are both the
  -- anonymous role and are not the same credential, and an answer is only
  -- evidence about the role that produced it.
  tested_role text NULL CHECK (tested_role IS NULL OR tested_role IN ('anon', 'publishable')),
  -- One row is the whole question, so this is 0 or 1. It is a count and never
  -- a row.
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count BETWEEN 0 AND 1),

  -- A count above zero is what `readable` means. Anything else claiming to
  -- have seen a row would be a result nobody measured.
  CHECK ((row_count > 0) = (state = 'readable')),

  observed_at timestamptz NOT NULL DEFAULT now(),
  -- When this answer stops being current. A policy changed an hour after a
  -- probe makes the probe history rather than news, and it never becomes a
  -- denial by waiting.
  freshness_deadline timestamptz NOT NULL,
  CHECK (freshness_deadline > observed_at),

  FOREIGN KEY (provider, authority, owner_login, repo_name, fingerprint)
    REFERENCES nv_exposure_findings (provider, authority, owner_login, repo_name, fingerprint)
    ON DELETE CASCADE
);

-- The latest attempt for a finding is the common read, and the history is the
-- occasional one. Both walk this index.
CREATE INDEX nv_exposure_readability_probes_finding_idx
  ON nv_exposure_readability_probes (provider, authority, owner_login, repo_name, fingerprint, observed_at DESC);

CREATE INDEX nv_exposure_readability_probes_identity_idx
  ON nv_exposure_readability_probes (identity_key);
