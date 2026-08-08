# Nebulaverse-X Phase 0 Stabilization Design

## Goal

Release Nebulaverse-X v5.2.2 as a stable, privacy-safe and reproducible upgrade of v5.2.1 without changing its Render Free + existing Neon architecture or removing existing functionality.

## Constraints

- Official product and Render service name: `Nebulaverse-X`.
- Existing Neon database remains optional for basic use and required for persistent intelligence features.
- No Render-managed database, paid AI, worker or paid service is introduced.
- Existing provider support, Neural Command Center, security, upload and recovery functions remain available.
- Private repository data is never shared across provider accounts or server sessions.

## Architecture

### Release identity

`package.json` is the only authored application-version source. The server imports it through `src/version.js`. Browser asset versioning and the service-worker release identifier are injected when the server serves `index.html` and `sw.js`, so release numbers are not manually duplicated in source files.

### PWA caches

The service worker maintains two cache classes:

1. A versioned application-shell cache for HTML, CSS, JavaScript, icons and local vendor libraries.
2. Optional private offline caches partitioned by an opaque server-issued account/session scope.

Private caching is disabled by default and enabled per repository. Requests become cache-eligible only when the application adds an opaque scope header and a repository-opt-in header. The service worker caches only allowlisted small JSON/text GET responses, using network-first behavior, a 24-hour TTL, a 1 MiB response limit, 100 entries and a 25 MiB total budget. Raw files, ZIPs, binaries, sessions, account details, notifications, security, evidence, recovery, uploads and destructive responses are network-only.

All identity transitions await local private-data deletion before the server-side transition proceeds. Logout still clears local private data even when remote session revocation fails, while warning the user that the remote session may remain active.

### Database migrations

Startup schema creation moves into numbered SQL files under `db/migrations/`. `src/migrations.js` creates `nv_schema_migrations`, obtains a PostgreSQL advisory lock, applies pending migrations transactionally and records each checksum. Existing `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE IF NOT EXISTS` statements preserve compatibility with current Neon databases.

### Verification

- Existing unit/contract tests remain.
- New tests cover release identity, service-worker cache policy, migration ordering/checksums and account-boundary cleanup.
- Playwright covers login/logout shell behavior, PWA startup, account cache isolation and sensitive-route network-only policy using a deterministic mock server.
- GitHub Actions runs install, tests, Playwright, syntax checks, dependency audit, secret scan and release-package validation.

### Packaging

A release script creates a deterministic ZIP excluding `.git`, `node_modules`, `.env`, logs, temporary files and macOS metadata. `.gitignore`, `.env.example`, deployment documentation and changelog are included.

## Error handling

- Missing or malformed cache scope disables private caching rather than falling back to a shared cache.
- Cache-storage or quota failures never block a live API response.
- Migration checksum changes fail startup with an explicit error instead of silently modifying history.
- Failed remote logout still clears local data and returns the user to the login screen with a warning.

## Release gate

v5.2.2 is releasable only when clean install, all unit/contract tests, Playwright critical journeys, JavaScript syntax checks, dependency audit, migration tests, Render/Neon smoke tests and clean-package validation pass.
