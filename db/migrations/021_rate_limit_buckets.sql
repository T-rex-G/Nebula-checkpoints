-- The API and webhook rate limits counted in module-scope Maps, so a limit of
-- N was N per process. Two instances served 2N, which is the opposite of what
-- a limit is for: the ceiling loosened exactly as capacity was added.
--
-- One row per identity per window. The window start is stored rather than a
-- rolling timestamp, because the limiters this replaces reset by comparing
-- "now" against the moment the window opened, and a durable counter that
-- silently switched to epoch-aligned windows would change every boundary in a
-- way no caller asked for.
--
-- The identity is a digest, as it is in nv_single_use_guards and for the same
-- reason: a session identifier is a credential while it lives, and a counter
-- table is the wrong place to keep one. Namespaces keep the API budget and the
-- webhook budget from ever being the same row.
--
-- No capacity ceiling and no eviction of a live window. The Map this replaces
-- discarded its oldest entry past five thousand, which means a caller near
-- their limit could have their count forgotten under load and start again --
-- a limit that fails open exactly when the most traffic is arriving. Rows
-- leave when their window has closed and at no other time.
CREATE TABLE nv_rate_limit_buckets (
  bucket_namespace text NOT NULL
    CHECK (bucket_namespace IN ('api', 'webhook')),
  bucket_key text NOT NULL
    CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0
    CHECK (request_count >= 0),
  PRIMARY KEY (bucket_namespace, bucket_key)
);

-- The sweep reads this rather than the table.
CREATE INDEX nv_rate_limit_buckets_window_idx
  ON nv_rate_limit_buckets (window_started_at);
