-- The single-use guards that stop a grant being spent twice lived in three
-- module-scope Maps in server.js: step-up grants, GitHub App OAuth states, and
-- restore authorizations. A Map is per-process, so what each one guaranteed
-- was that a grant could not be replayed against the process that spent it. A
-- second instance shares none of that, and would honour every grant again.
--
-- One table, namespaced by guard kind, because these are the same problem
-- three times and a shared sweep is worth more than three schemas.
--
-- The key is a digest, never the grant. A grant id, an OAuth state and a
-- restore authorization are all credentials for the moment they are alive, and
-- a guard table is the wrong place to keep a copy of one. The digest is
-- unkeyed on purpose: every value that reaches it is already high-entropy
-- random -- a UUID or a 24-byte nonce -- so there is nothing to brute force,
-- and a keyed digest would make the guard depend on key material being
-- identical across instances, which is one more way for a second instance to
-- silently not share the guard it appears to share.
--
-- There is no capacity ceiling here, and that is deliberate. The Map this
-- replaces evicted its oldest entry once it held ten thousand, which means a
-- live grant could be forgotten under load and then replayed -- a guard that
-- fails open exactly when it is under the most pressure. Rows leave when they
-- expire and at no other time; if the table cannot accept a row, the insert
-- fails and the caller refuses the action.
CREATE TABLE nv_single_use_guards (
  guard_kind text NOT NULL
    CHECK (guard_kind IN ('step-up', 'github-app-state', 'restore-authorization')),
  guard_key text NOT NULL
    CHECK (guard_key ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guard_kind, guard_key)
);

-- The sweep orders by expiry and takes a bounded slice, so it reads an index
-- rather than the table.
CREATE INDEX nv_single_use_guards_expiry_idx
  ON nv_single_use_guards (expires_at);
