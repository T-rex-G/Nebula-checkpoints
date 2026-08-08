# Nebulaverse-X v5.3.0-alpha.2 — Phase 1 Task 2 report

## Scope

This prerelease adds an optional GitHub App installation-authentication and short-lived credential-brokering foundation without changing the one Render Free service plus optional existing Neon architecture. GitHub PAT, GitHub OAuth, GitLab token, and Gitea token connectivity remain supported. When no GitHub App variables are configured, the feature is disabled and the rest of Nebulaverse-X continues to operate.

This is Task 2 of the approved 21-task Phase 1 plan. It is a reviewable prerelease checkpoint, not the completed v5.3 governance release.

## Implemented controls

- Complete-or-disabled GitHub App configuration validation, RSA private-key validation, canonical production HTTPS callback enforcement, and rejection of callback URLs containing query parameters.
- Server-signed GitHub App JWTs with bounded lifetime and upstream request timeouts.
- Session-, active-identity-, purpose-, and expiry-bound callback state for both user authorization and installation claim flows.
- Single-use pending state consumed before provider side effects, plus a bounded process-level replay registry that rejects stale encrypted-cookie replay on the running service.
- Revalidation of the authorizing GitHub user after OAuth code exchange.
- Installation ownership verification through the user-authorized installation list rather than trusting the callback `installation_id`.
- Server-only installation-token minting with near-expiry refresh, concurrent request coalescing, suspension rejection, and race-safe invalidation.
- Credential caches scoped by configured App, installation, and authorizing identity so credentials cannot cross user or installation boundaries.
- Validation that the fetched installation account ID and login match the tokenless account metadata stored in the session.
- A single provider credential resolver that preserves PAT/OAuth/GitLab/Gitea accounts and injects an ephemeral token only into a cloned GitHub App request account.
- Tokenless GitHub App session accounts and credential-free optional Neon installation/audit records.
- Settings management for repository scope, authorizer, installation health, refresh, reauthorization, provider management link, and local disconnect.
- Explicit capability boundaries for user-scoped actions. Repository creation, user notifications, and user starring remain available through PAT/OAuth, not installation identities.
- Revoked or unavailable installation identities remain locally manageable so the user can switch accounts or disconnect them without requiring a successful provider call.

## Routes and behavior

The optional flow provides connect, user OAuth callback, installation setup, status, refresh, and disconnect routes. State-changing initiation and management routes retain the Phase 1 Task 1 same-origin and CSRF controls. GitHub App installation tokens are created only on the server and are never serialized into browser responses or persisted in session/database metadata.

Repository requests made through a GitHub App identity resolve an installation token at request time. Normal repository-level 403/404 responses do not automatically destroy the credential cache; cache invalidation occurs for credential rejection, disconnect, account removal, or explicit refresh/invalidation.

## Security contracts

- Fully absent configuration disables the feature; partial or unsafe production configuration fails startup.
- The App private key, client secret, temporary user authorization token, and installation token are excluded from public configuration, account/status responses, UI markup, persistence, audit details, and normal logs.
- Callback state rejects tampering, expiry, session changes, active-identity changes, purpose changes, normal replay, and stale-cookie replay on the current process.
- A GitHub user cannot claim an installation absent from that user's authorized installation list.
- Installation data must belong to the configured App, must match stored account metadata, and must not be suspended.
- Cached credentials cannot cross installation IDs or authorizing identities.
- Parallel token requests coalesce, while invalidation prevents an older in-flight mint from repopulating the cache.
- Existing authentication methods and all Phase 1 Task 1 request-security controls remain in the complete regression suite.

## Persistence

Migration `006_github_app.sql` adds:

- `nv_github_app_installations`
- `nv_github_app_audit`

The tables contain installation identifiers, account/scope metadata, status, permissions, timestamps, and minimized lifecycle details. They contain no App private key, client secret, temporary user authorization token, or installation token. Neon remains optional.

## Verification performed

The source workspace passed:

- Complete `npm test` unit, contract, migration, hardening, live-server, package-contract, and server-smoke suite.
- JavaScript syntax validation through `npm run check:syntax`.
- Secret-pattern scanning through `npm run check:secrets`.
- Packaged-runtime validation through `npm run test:release`.
- Focused replay, cache-isolation, invalidation-race, request-timeout, installation-ownership, disabled-feature, configured-server, UI, and credential-boundary tests.

The final deterministic distributable contains 103 safe archive entries under one versioned root. It was checksum-validated, extracted into a clean directory, installed with `npm ci --offline`, and passed the same complete verification set. The clean install audited 132 locked packages and reported 0 vulnerabilities. Its SHA-256 is supplied in the adjacent `.sha256` companion file so it can be validated independently without creating a self-referential archive checksum.

## Review findings resolved before packaging

The independent security/runtime review identified and corrected:

1. A cache boundary that originally allowed two authorizing identities for the same installation to share one cached token.
2. An invalidation race where an older pending request could interfere with a newer token request.
3. Missing strict comparison between stored installation account metadata and the installation returned by GitHub.
4. Missing bounded timeouts on GitHub App upstream requests.
5. User-scoped actions being presented to repository-scoped installation identities.
6. Revoked installation identities becoming difficult to manage locally.
7. Over-broad cache invalidation on ordinary repository permission/not-found responses.
8. Replay of a valid setup state through reuse of an older encrypted session cookie on the same running service.

## Remaining boundaries and staging checks

- No real GitHub App credentials or disposable GitHub organization/repositories were available in this build environment. A staging smoke test must therefore exercise the actual installation, authorization, repository listing, token refresh, suspension/revocation, reauthorization, and disconnect journeys before production promotion.
- The process-level stale-cookie replay registry is intentionally memory-bounded and process-local. Optional Neon sessions persist consumed session state. In cookie-only mode, a full process restart loses the in-memory replay registry; GitHub OAuth authorization codes remain provider-side single-use, while the installation setup callback must still pass signed state and installation ownership validation.
- `GITHUB_APP_WEBHOOK_SECRET` is accepted and exposed only as a configured/unconfigured status. Verified webhook ingestion belongs to a later Phase 1 task.
- Browser end-to-end execution could not run in this sandbox: the bundled Playwright Chromium was unavailable, and the system Chromium was blocked from local URLs by an administrator policy. Browser test coverage is included for CI/staging execution.
- The online npm advisory endpoint was unavailable during final verification (`EAI_AGAIN`/service failure). Dependency installation, lockfile integrity, application tests, and secret/release checks were still verified; an online `npm audit --audit-level=high` must be rerun in CI or a connected release environment.
