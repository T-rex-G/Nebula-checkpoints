'use strict';

/*
 * Every environment variable this project reads, and what each one means.
 *
 * Written because the only way to find out what a deployment needed was to
 * start it and watch which throw came first. There are 111 of them across the
 * server, the operator scripts and the CI authorization gate, and nothing
 * named them in one place -- so "what do I have to set" had no answer short of
 * reading the source.
 *
 * This is data, not documentation: scripts/doctor.js evaluates a live
 * environment against it, and test/config-registry.test.js checks it against
 * the source in both directions, so an entry cannot quietly outlive the code
 * that read it and a new read cannot appear without an entry. A list that can
 * drift is worth very little, and this list is large enough that it would.
 *
 * requirement:
 *   'always'       -- the process will not run correctly without it
 *   'production'   -- required once NODE_ENV=production
 *   'hosted-alpha' -- required when NV_DEPLOYMENT_PROFILE=hosted-alpha
 *   'group'        -- optional, but once anything in its group is set the rest
 *                     of the group's required members become required too
 *   'optional'     -- has a working default, or enables something that is off
 *
 * fallback is the value the code uses when the variable is absent, written
 * exactly as the code computes it, or null where absence is not defaulted.
 */

const GROUPS = Object.freeze({
  server: 'Process and session',
  database: 'PostgreSQL',
  oauth: 'GitHub OAuth (personal access)',
  'github-app': 'GitHub App installation',
  'alpha-access': 'Invite-only alpha access',
  limits: 'Bounded runtime limits',
  governance: 'Governance runtime',
  snapshots: 'Snapshot signing',
  scanning: 'File scanning',
  operator: 'Operator scripts',
  ci: 'Release authorization and live validation',
  tooling: 'Local tooling'
});

const ENTRIES = Object.freeze([
  /* ---------------- Process and session ---------------- */
  { name: 'PORT', group: 'server', requirement: 'optional', fallback: '10000',
    format: 'TCP port number',
    summary: 'Port the HTTP server binds. Hosting platforms usually set this for you.' },
  { name: 'NODE_ENV', group: 'server', requirement: 'production', fallback: null,
    format: "'production' enables the production posture",
    summary: 'Turns on HSTS, Secure cookies, TLS enforcement on the database URL, and every production-only requirement in this table.' },
  { name: 'SESSION_SECRET', group: 'server', requirement: 'production', fallback: "'dev-secret-change-me'",
    format: 'at least 32 bytes in production',
    summary: 'Signs session cookies. Production refuses to start on the development default or on anything shorter than 32 bytes.' },
  { name: 'NV_DEPLOYMENT_PROFILE', group: 'server', requirement: 'optional', fallback: "'local'",
    format: "'local' or 'hosted-alpha'",
    summary: 'Selects the deployment posture. hosted-alpha applies the hosted limit ceilings and requires migrations to be verified rather than applied.' },
  { name: 'PUBLIC_BASE_URL', group: 'server', requirement: 'production', fallback: null,
    format: 'absolute URL, https in production, no credentials or fragment',
    summary: 'The externally reachable origin. Live events refuse to run in production without it, and the GitHub App callback is derived from it when no explicit callback is set.' },
  { name: 'RENDER_EXTERNAL_URL', group: 'server', requirement: 'optional', fallback: null,
    format: 'absolute URL',
    summary: 'Accepted in place of PUBLIC_BASE_URL. Render sets it automatically.' },
  { name: 'NV_MAINTENANCE_MODE', group: 'server', requirement: 'optional', fallback: 'off',
    format: "'1', 'true', 'on' or 'yes' to enable",
    summary: 'Closes the API with 503 and drains readiness while keeping the health check green, so the host does not recycle the instance during a maintenance window. Static assets and the application shell still load.' },
  { name: 'NV_GIT_HOST_ALLOWLIST', group: 'server', requirement: 'optional', fallback: "'' (empty)",
    format: 'comma-separated hostnames',
    summary: 'Git hosts this deployment may reach. Checked when a server URL is connected, not at startup: in production a self-hosted Git server is refused unless its host is listed, while gitlab.com is allowed as a canonical hosted provider. Leaving it empty is fine for a deployment that only uses the hosted providers.' },

  /* ---------------- PostgreSQL ---------------- */
  { name: 'DATABASE_URL', group: 'database', requirement: 'production', fallback: "'' (in-memory only)",
    format: 'postgres:// or postgresql:// URL',
    summary: 'Primary database. TLS is normalised to verify-full unless explicitly disabled, and production rejects sslmode=disable.' },
  { name: 'NV_DB_INSECURE', group: 'database', requirement: 'optional', fallback: null,
    format: "'1' to allow",
    summary: 'Permits a database URL that disables TLS. For local work against a non-TLS PostgreSQL; never set this in production.' },
  { name: 'NV_DATABASE_MIGRATION_MODE', group: 'database', requirement: 'hosted-alpha', fallback: "'apply'",
    format: "'apply' or 'verify'",
    summary: 'Whether startup applies migrations or only checks that they match. hosted-alpha in production must be verify, so a deploy cannot silently migrate.' },
  { name: 'NV_RESTORE_DATABASE_URL', group: 'database', requirement: 'optional', fallback: null,
    format: 'postgres:// URL',
    summary: 'Target database for a restore drill, kept separate so a restore cannot be aimed at the live one by omission.' },

  /* ---------------- GitHub OAuth ---------------- */
  { name: 'GITHUB_CLIENT_ID', group: 'oauth', requirement: 'group', fallback: "'' (sign-in disabled)",
    format: 'OAuth app client id',
    summary: 'Enables signing in with GitHub rather than pasting a personal access token.' },
  { name: 'GITHUB_CLIENT_SECRET', group: 'oauth', requirement: 'group', fallback: "'' (sign-in disabled)",
    format: 'OAuth app client secret',
    summary: 'Paired with GITHUB_CLIENT_ID. Both or neither.' },

  /* ---------------- GitHub App ---------------- */
  { name: 'GITHUB_APP_ID', group: 'github-app', requirement: 'group', fallback: null,
    format: 'positive integer',
    summary: 'Numeric id of the GitHub App. Setting any GITHUB_APP_* value makes the whole group required.' },
  { name: 'GITHUB_APP_SLUG', group: 'github-app', requirement: 'group', fallback: null,
    format: 'lowercase app slug, up to 100 characters',
    summary: 'URL slug of the App, used to build its installation links.' },
  { name: 'GITHUB_APP_CLIENT_ID', group: 'github-app', requirement: 'group', fallback: null,
    format: '3-200 characters of [A-Za-z0-9._-]',
    summary: 'OAuth client id belonging to the App.' },
  { name: 'GITHUB_APP_CLIENT_SECRET', group: 'github-app', requirement: 'group', fallback: null,
    format: '10-1000 characters',
    summary: 'OAuth client secret belonging to the App.' },
  { name: 'GITHUB_APP_PRIVATE_KEY', group: 'github-app', requirement: 'group', fallback: null,
    format: 'RSA private key, PEM',
    summary: 'Signs App tokens. Mutually exclusive with the base64 form; supplying both is rejected rather than resolved.' },
  { name: 'GITHUB_APP_PRIVATE_KEY_BASE64', group: 'github-app', requirement: 'group', fallback: null,
    format: 'base64 of an RSA PEM',
    summary: 'The same key for environments that cannot carry newlines. Mutually exclusive with the plain form.' },
  { name: 'GITHUB_APP_CALLBACK_URL', group: 'github-app', requirement: 'group', fallback: 'derived from PUBLIC_BASE_URL',
    format: 'absolute URL ending /api/github-app/oauth/callback, no query',
    summary: 'OAuth callback for the App. Derived from PUBLIC_BASE_URL when unset, so one of the two must exist.' },
  { name: 'GITHUB_APP_WEBHOOK_SECRET', group: 'github-app', requirement: 'optional', fallback: "'' (webhooks unverified)",
    format: '16-1000 characters',
    summary: 'Verifies webhook deliveries. Without it the App works but webhook payloads are not authenticated.' },

  /* ---------------- Invite-only alpha access ---------------- */
  { name: 'NV_ALPHA_ACCESS_MODE', group: 'alpha-access', requirement: 'optional', fallback: "'off'",
    format: "'off' or 'invite'",
    summary: 'Gates the application behind invite codes. invite requires PostgreSQL and the two values below.' },
  { name: 'NV_ALPHA_INVITE_PEPPER', group: 'alpha-access', requirement: 'group', fallback: null,
    format: 'at least 32 bytes',
    summary: 'Peppers stored invite hashes, so the invite table alone cannot be brute-forced.' },
  { name: 'NV_ALPHA_TERMS_VERSION', group: 'alpha-access', requirement: 'group', fallback: null,
    format: 'YYYY-MM-DD, optionally .N',
    summary: 'Which terms a tester accepted. Bumping it requires testers to accept again.' },

  /* ---------------- Bounded runtime limits ---------------- */
  { name: 'NV_UPLOAD_MAX_MB', group: 'limits', requirement: 'optional', fallback: '2048',
    format: 'integer, clamped 25-2048',
    summary: 'Largest single upload. A hosted profile caps it lower and refuses a larger value at startup.' },
  { name: 'NV_UPLOAD_CONCURRENCY', group: 'limits', requirement: 'optional', fallback: '1',
    format: 'integer, clamped from 1',
    summary: 'How many uploads may run at once.' },
  { name: 'NV_UPLOAD_TIMEOUT_MINUTES', group: 'limits', requirement: 'optional', fallback: '20',
    format: 'integer minutes',
    summary: 'How long an upload may stay open before it is abandoned.' },
  { name: 'NV_STALE_UPLOAD_HOURS', group: 'limits', requirement: 'optional', fallback: '6',
    format: 'integer hours, clamped from 1',
    summary: 'Age at which an interrupted upload is swept.' },
  { name: 'NV_GIT_DATA_MAX_MB', group: 'limits', requirement: 'optional', fallback: '64',
    format: 'integer, clamped 10-95',
    summary: 'Ceiling on git data pulled in one operation.' },
  { name: 'NV_NATIVE_PUSH_MAX_MB', group: 'limits', requirement: 'optional', fallback: '64',
    format: 'integer, clamped from 10',
    summary: 'Ceiling on a native push.' },
  { name: 'NV_LIVE_CLIENTS_PER_REPO', group: 'limits', requirement: 'optional', fallback: '5',
    format: 'integer',
    summary: 'Live-event listeners allowed on one repository.' },
  { name: 'NV_LIVE_CLIENTS_TOTAL', group: 'limits', requirement: 'optional', fallback: '100',
    format: 'integer',
    summary: 'Live-event listeners allowed across the deployment.' },
  { name: 'NV_EVENT_RETENTION_DAYS', group: 'limits', requirement: 'optional', fallback: '90',
    format: 'integer days',
    summary: 'How long evidence events are kept before pruning.' },
  { name: 'NV_SESSION_RETENTION_DAYS', group: 'limits', requirement: 'optional', fallback: '35',
    format: 'integer days',
    summary: 'How long session records are kept.' },
  { name: 'NV_SNAPSHOT_MANIFEST_MAX', group: 'limits', requirement: 'optional', fallback: '10000',
    format: 'integer entries',
    summary: 'Largest snapshot manifest accepted.' },
  { name: 'NV_SNAPSHOT_RETENTION_COUNT', group: 'limits', requirement: 'optional', fallback: 'bounded integer',
    format: 'integer',
    summary: 'How many snapshots are retained per repository.' },

  /* ---------------- Governance runtime ---------------- */
  { name: 'NV_GOVERNANCE_RUNTIME_FAILURE_MODE', group: 'governance', requirement: 'optional', fallback: "'warn'",
    format: "'warn' or 'block'",
    summary: 'What happens when a policy decision cannot be evaluated: warn continues, block refuses the operation.' },
  { name: 'NV_GOVERNANCE_AUDIT_SECRET', group: 'governance', requirement: 'optional', fallback: 'SESSION_SECRET',
    format: 'at least 32 bytes in production',
    summary: 'Signs the governance audit chain. Falls back to SESSION_SECRET, so set it only to rotate the two independently.' },

  /* ---------------- Snapshot signing ---------------- */
  { name: 'NV_SNAPSHOT_SIGNING_KEY_ID', group: 'snapshots', requirement: 'group', fallback: null,
    format: 'key identifier',
    summary: 'Names the key that signs snapshots, so a verifier knows which secret to expect.' },
  { name: 'NV_SNAPSHOT_SIGNING_SECRET', group: 'snapshots', requirement: 'group', fallback: null,
    format: 'signing secret',
    summary: 'The active snapshot signing secret.' },
  { name: 'NV_SNAPSHOT_RETIRED_KEYS_JSON', group: 'snapshots', requirement: 'optional', fallback: "'' (none)",
    format: 'JSON array of retired keys',
    summary: 'Keys that may still verify existing snapshots but may not sign new ones.' },
  { name: 'NV_SNAPSHOT_LEGACY_KEYS_JSON', group: 'snapshots', requirement: 'optional', fallback: "'' (none)",
    format: 'JSON array of legacy keys',
    summary: 'Older keys kept so snapshots signed before a rotation still verify.' },

  /* ---------------- File scanning ---------------- */
  { name: 'NV_REQUIRE_YARA', group: 'scanning', requirement: 'optional', fallback: 'false',
    format: 'boolean-ish',
    summary: 'Makes YARA scanning mandatory. Without it the built-in bounded signature gate runs alone.' },
  { name: 'NV_YARA_BIN', group: 'scanning', requirement: 'optional', fallback: "'yara'",
    format: 'executable name or path',
    summary: 'Which YARA binary to invoke.' },
  { name: 'NV_YARA_RULES_PATH', group: 'scanning', requirement: 'group', fallback: "'' (YARA off)",
    format: 'filesystem path',
    summary: 'Rules file. YARA scanning stays off until this is set.' },
  { name: 'NV_YARA_TIMEOUT_SECONDS', group: 'scanning', requirement: 'optional', fallback: '5',
    format: 'integer, clamped 1-30',
    summary: 'How long a single YARA scan may run before it is killed.' },
  { name: 'PATH', group: 'scanning', requirement: 'always', fallback: "'' ",
    format: 'OS search path',
    summary: 'Passed through to the YARA subprocess, which is otherwise given a deliberately bare environment.' },

  /* ---------------- Operator scripts ---------------- */
  { name: 'NEON_API_KEY', group: 'operator', requirement: 'optional', fallback: null,
    format: 'Neon API key',
    summary: 'Lets scripts/alpha-db.js drive Neon branches directly. Only needed for hosted database work.' },
  { name: 'NV_BACKUP_KEY_BASE64', group: 'operator', requirement: 'optional', fallback: null,
    format: 'base64 key material',
    summary: 'Encrypts and decrypts database backups. Without it a backup cannot be read back.' },
  { name: 'NV_RESTORE_TARGET_FINGERPRINT', group: 'operator', requirement: 'optional', fallback: null,
    format: 'fingerprint string',
    summary: 'Identifies the intended restore target, so a restore refuses to run against anything else.' },
  { name: 'PGHOST', group: 'operator', requirement: 'optional', fallback: null,
    format: 'hostname', summary: 'Standard libpq setting, used by the database scripts when no URL is supplied.' },
  { name: 'PGPORT', group: 'operator', requirement: 'optional', fallback: null,
    format: 'port', summary: 'Standard libpq setting.' },
  { name: 'PGUSER', group: 'operator', requirement: 'optional', fallback: null,
    format: 'role name', summary: 'Standard libpq setting.' },
  { name: 'PGPASSWORD', group: 'operator', requirement: 'optional', fallback: null,
    format: 'password', summary: 'Standard libpq setting.' },
  { name: 'PGDATABASE', group: 'operator', requirement: 'optional', fallback: null,
    format: 'database name', summary: 'Standard libpq setting.' },
  { name: 'PGSSLMODE', group: 'operator', requirement: 'optional', fallback: null,
    format: 'libpq sslmode', summary: 'Standard libpq setting. Prefer verify-full.' },
  { name: 'PGSSLROOTCERT', group: 'operator', requirement: 'optional', fallback: null,
    format: 'path to a CA bundle', summary: 'Standard libpq setting, needed for verify-full against a private CA.' },
  { name: 'NV_ALPHA_BASE_URL', group: 'operator', requirement: 'optional', fallback: null,
    format: 'absolute URL',
    summary: 'Deployment the load planner aims at.' },
  { name: 'NV_ALPHA_TESTERS', group: 'operator', requirement: 'optional', fallback: null,
    format: 'integer', summary: 'Simulated tester count for the load planner.' },
  { name: 'NV_ALPHA_READS_PER_TESTER', group: 'operator', requirement: 'optional', fallback: null,
    format: 'integer', summary: 'Read operations per simulated tester.' },
  { name: 'NV_ALPHA_MUTATIONS', group: 'operator', requirement: 'optional', fallback: null,
    format: 'integer', summary: 'Mutating operations in the load plan.' },
  /*
   * The production dependency gate's retry budget. It retries because the step
   * failed on runs where the dependencies had not changed: npm exhausted its
   * attempts against the bulk advisory endpoint, fell back to the retiring
   * quick endpoint, and that answered 400. Retrying is the mitigation; the
   * gate still fails when no audit can be obtained, because an unknown is not
   * a clean tree.
   */
  { name: 'NV_AUDIT_ATTEMPTS', group: 'operator', requirement: 'optional', fallback: '3',
    format: 'integer from 1 to 5', summary: 'How many times a dependency audit is attempted before the build fails as unavailable.' },
  { name: 'NV_AUDIT_BACKOFF_MS', group: 'operator', requirement: 'optional', fallback: '5000',
    format: 'integer milliseconds from 0 to 60000', summary: 'Base backoff between dependency audit attempts; it grows with each attempt.' },
  { name: 'NV_AUDIT_ATTEMPT_TIMEOUT_MS', group: 'operator', requirement: 'optional', fallback: '75000',
    format: 'integer milliseconds from 1 to 240000',
    summary: 'Maximum runtime of one dependency audit attempt; the complete retry budget is capped below the candidate qualifier timeout.' },
  { name: 'NV_STAGING_SUBJECT_SHA256', group: 'operator', requirement: 'optional', fallback: null,
    format: 'hex sha256',
    summary: 'The artifact the staging gate is being run against, so evidence cannot be attributed to a different build.' },
  { name: 'NV_PUBLIC_ALPHA_SUBJECT_SHA256', group: 'operator', requirement: 'optional', fallback: null,
    format: 'hex sha256', summary: 'Subject artifact for the public-alpha qualification gate.' },
  { name: 'NV_PUBLIC_ALPHA_SOURCE_COMMIT', group: 'operator', requirement: 'optional', fallback: null,
    format: 'commit sha', summary: 'Commit the qualified artifact was built from.' },
  { name: 'NV_PUBLIC_ALPHA_RESTORE_WITNESS', group: 'operator', requirement: 'optional', fallback: null,
    format: 'path to a witness document',
    summary: 'Signed evidence that a restore drill actually happened.' },
  { name: 'NV_ALPHA17_OPERATOR_KEY_ID', group: 'operator', requirement: 'group', fallback: null,
    format: 'key identifier', summary: 'Names the operator key that signs restore witnesses.' },
  { name: 'NV_ALPHA17_OPERATOR_PRIVATE_KEY_BASE64', group: 'operator', requirement: 'group', fallback: null,
    format: 'base64 private key',
    summary: 'Signs a restore witness. Held by a person, not by the deployment.' },
  { name: 'NV_ALPHA17_OPERATOR_PUBLIC_KEY_BASE64', group: 'operator', requirement: 'group', fallback: null,
    format: 'base64 public key',
    summary: 'Verifies a restore witness during qualification.' },

  /* ----------- Release authorization and live validation -----------
   *
   * This group is the owner-authorisation gate. Live-provider and hosted
   * validation will not run unless a signed claim matches every expectation
   * below, which is why these are unset in ordinary development and why the
   * live runs cannot be self-authorised from inside a session.
   */
  { name: 'NV_ALPHA17_AUTHORIZATION_CLAIM_DIR', group: 'ci', requirement: 'group', fallback: null,
    format: 'directory path', summary: 'Where the signed authorization claims are read from.' },
  { name: 'NV_ALPHA17_AUTHORIZATION_PUBLIC_KEY_BASE64', group: 'ci', requirement: 'group', fallback: null,
    format: 'base64 public key', summary: 'Verifies the signature on an authorization claim.' },
  { name: 'NV_ALPHA17_REQUESTED_JOBS', group: 'ci', requirement: 'group', fallback: null,
    format: 'comma-separated job names', summary: 'Which validation jobs this run is asking to perform.' },
  { name: 'NV_ALPHA17_EXPECTED_WORKFLOW', group: 'ci', requirement: 'group', fallback: null,
    format: 'workflow name', summary: 'Workflow the claim must name, so a claim cannot be replayed from another workflow.' },
  { name: 'NV_ALPHA17_EXPECTED_REPOSITORY', group: 'ci', requirement: 'group', fallback: null,
    format: 'owner/repo', summary: 'Repository the claim must name.' },
  { name: 'NV_ALPHA17_EXPECTED_REF', group: 'ci', requirement: 'group', fallback: null,
    format: 'git ref', summary: 'Ref the claim must name.' },
  { name: 'NV_ALPHA17_EXPECTED_EVENT', group: 'ci', requirement: 'group', fallback: null,
    format: 'workflow event', summary: 'Triggering event the claim must name.' },
  { name: 'NV_ALPHA17_EXPECTED_SOURCE_COMMIT', group: 'ci', requirement: 'group', fallback: null,
    format: 'commit sha', summary: 'Commit the claim must name.' },
  { name: 'NV_ALPHA17_EXPECTED_SOURCE_PARENT', group: 'ci', requirement: 'group', fallback: null,
    format: 'commit sha', summary: 'Parent commit the claim must name, pinning the run to one point in history.' },
  { name: 'NV_ALPHA17_EXPECTED_SUBJECT_SHA256', group: 'ci', requirement: 'group', fallback: null,
    format: 'hex sha256', summary: 'Artifact hash the claim must name.' },
  { name: 'NV_ALPHA17_SIGNED_TARGET_SHA256', group: 'ci', requirement: 'group', fallback: null,
    format: 'hex sha256', summary: 'Hash of the signed target descriptor, binding the claim to one deployment.' },
  { name: 'NV_ALPHA17_TARGET_JOB', group: 'ci', requirement: 'group', fallback: null,
    format: 'job name', summary: 'Which job the target descriptor describes.' },
  { name: 'NV_ALPHA17_TARGET_BASE_URL', group: 'ci', requirement: 'group', fallback: null,
    format: 'absolute URL', summary: 'Base URL of the deployment being validated.' },
  { name: 'NV_ALPHA17_TARGET_API_URL', group: 'ci', requirement: 'group', fallback: null,
    format: 'absolute URL', summary: 'Provider API the validation run is allowed to reach.' },
  { name: 'NV_ALPHA17_TARGET_REPOSITORY', group: 'ci', requirement: 'group', fallback: null,
    format: 'owner/repo', summary: 'Repository the provider validation is allowed to touch.' },
  { name: 'NV_ALPHA17_TARGET_RENDER_SERVICE_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Render service id', summary: 'Hosting service the run is authorised against.' },
  { name: 'NV_ALPHA17_TARGET_NEON_PROJECT_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon project id', summary: 'Database project the run is authorised against.' },
  { name: 'NV_ALPHA17_TARGET_COHORT_NEON_BRANCH_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon branch id', summary: 'Cohort branch the run is authorised against.' },
  { name: 'NV_ALPHA17_TARGET_RESTORE_NEON_PROJECT_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon project id', summary: 'Restore-drill project the run is authorised against.' },
  { name: 'NV_ALPHA17_TARGET_RESTORE_NEON_BRANCH_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon branch id', summary: 'Restore-drill branch the run is authorised against.' },
  { name: 'NV_ALPHA17_TARGET_RESTORE_TARGET_KIND', group: 'ci', requirement: 'group', fallback: null,
    format: 'target kind', summary: 'What kind of thing the restore drill restores into.' },
  { name: 'NV_ALPHA17_TARGET_RESTORE_TARGET_FINGERPRINT', group: 'ci', requirement: 'group', fallback: null,
    format: 'fingerprint', summary: 'Fingerprint the restore target must match.' },
  { name: 'NV_ALPHA17_TARGET_RESTORE_APP_BASE_URL', group: 'ci', requirement: 'group', fallback: null,
    format: 'absolute URL', summary: 'Application the restored database is checked through.' },
  { name: 'NV_ALPHA17_TARGET_RESTORE_APP_DEPLOY_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'deploy id', summary: 'Exact deployment of that application.' },
  { name: 'NV_ALPHA17_GITHUB_API_URL', group: 'ci', requirement: 'group', fallback: null,
    format: 'absolute URL', summary: 'GitHub API endpoint for the live provider run.' },
  { name: 'NV_ALPHA17_GITHUB_LFS_URL', group: 'ci', requirement: 'optional', fallback: 'https://github.com',
    format: 'absolute URL',
    summary: 'Git LFS host for the live provider run. Separate from the API endpoint because the LFS store lives on the web host.' },
  { name: 'NV_ALPHA17_GITLAB_API_URL', group: 'ci', requirement: 'group', fallback: null,
    format: 'absolute URL', summary: 'GitLab API endpoint for the live provider run.' },
  { name: 'NV_ALPHA17_NEON_PROJECT_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon project id', summary: 'Neon project the hosted validation run uses.' },
  { name: 'NV_ALPHA17_COHORT_NEON_BRANCH_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon branch id', summary: 'Cohort branch the hosted validation run uses.' },
  { name: 'NV_ALPHA17_RENDER_SERVICE_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Render service id', summary: 'Render service the hosted validation run uses.' },
  { name: 'NV_ALPHA17_RESTORE_NEON_PROJECT_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon project id', summary: 'Neon project for the hosted restore drill.' },
  { name: 'NV_ALPHA17_RESTORE_NEON_BRANCH_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon branch id', summary: 'Neon branch for the hosted restore drill.' },
  { name: 'NV_ALPHA17_RESTORE_TARGET_KIND', group: 'ci', requirement: 'group', fallback: null,
    format: 'target kind', summary: 'Kind of restore target for the hosted drill.' },
  { name: 'NV_ALPHA17_RESTORE_APP_BASE_URL', group: 'ci', requirement: 'group', fallback: null,
    format: 'absolute URL', summary: 'Application the hosted restore drill checks through.' },
  { name: 'NV_ALPHA17_RESTORE_APP_DEPLOY_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'deploy id', summary: 'Deployment of that application.' },
  { name: 'NV_ALPHA17_RESTORE_ATTESTATION', group: 'ci', requirement: 'group', fallback: null,
    format: 'path to an attestation', summary: 'Where the restore attestation is written or read.' },
  { name: 'NV_ALPHA17_OPERATIONAL_RECORD', group: 'ci', requirement: 'group', fallback: null,
    format: 'path to a record', summary: 'Operational record produced by the hosted validation run.' },
  { name: 'NV_COHORT_NEON_PROJECT_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon project id', summary: 'Cohort project for the standalone restore validation.' },
  { name: 'NV_COHORT_NEON_BRANCH_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon branch id', summary: 'Cohort branch for the standalone restore validation.' },
  { name: 'NV_RESTORE_NEON_PROJECT_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon project id', summary: 'Restore project for the standalone restore validation.' },
  { name: 'NV_RESTORE_NEON_BRANCH_ID', group: 'ci', requirement: 'group', fallback: null,
    format: 'Neon branch id', summary: 'Restore branch for the standalone restore validation.' },
  { name: 'NV_RESTORE_TARGET_KIND', group: 'ci', requirement: 'group', fallback: null,
    format: 'target kind', summary: 'Kind of restore target for the standalone restore validation.' },

  /* ---------------- Local tooling ---------------- */
  { name: 'NV_REVIEW_URL', group: 'tooling', requirement: 'optional', fallback: "'http://127.0.0.1:21999'",
    format: 'absolute URL',
    summary: 'Where scripts/design-review.js points its browser.' },
  { name: 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', group: 'tooling', requirement: 'optional', fallback: "'' (Playwright default)",
    format: 'path to a Chromium binary',
    summary: 'Uses a preinstalled Chromium instead of downloading one.' }
]);

module.exports = { GROUPS, ENTRIES };
