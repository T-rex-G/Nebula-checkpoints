# Nebulaverse-X v5.3.0-alpha.5 — Phase 1 Task 5 report

## Scope

This prerelease implements the Provider Permission and Governance Role Resolver required by later governance APIs, policy workflows and Central Mutation Gateway policy evaluation.

Task 5 derives a trusted, repository-scoped authorization snapshot from server-held provider credentials and provider responses. It records evidence on every mutation descriptor but deliberately does not yet allow, warn or block existing repository operations according to governance policy. Existing GitHub PAT, GitHub OAuth, optional GitHub App, GitLab token and Gitea token behavior remains supported.

This is Task 5 of the controlled 21-task Phase 1 roadmap, not the completed v5.3 release.

## Architecture

- `src/authorization-resolver.js` owns provider permission resolution, normalization, evidence status, governance-role derivation, cache isolation and immutable snapshot validation.
- `src/provider-credentials.js` remains the credential boundary.
- `src/github-app.js` now returns fresh sanitized installation metadata alongside the ephemeral installation token so repository selection and installation identity can be proven server-side.
- `server.js` resolves authorization after provider credentials and request security, but before mutation descriptor creation.
- `src/mutation-gateway.js` independently normalizes the snapshot and binds it to the exact mutation repository and actor.

No provider token, authorization header, cookie, private key, raw provider response body or unrestricted provider metadata is retained in the snapshot.

## Authorization snapshot

Schema version 1 contains:

- canonical provider authority, owner, repository and scope key;
- execution principal identity and authentication method;
- separately identified human governance actor;
- normalized base role, provider role, access level, evidence source and completeness;
- derived reader, author, reviewer, activator and administrator roles;
- sanitized GitHub App repository-selection and API-permission capability where applicable;
- bounded `resolved`, `partial` or `unavailable` evidence with fetch/expiry timestamps and a stable reason code.

Snapshots are deeply frozen. Validation rejects sensitive field names, malformed identities, inconsistent scope, incompatible principal/authentication combinations, mismatched role/access levels and incomplete evidence that attempts to grant governance authority.

## Provider resolution

### GitHub PAT and OAuth

The resolver requests the active user's calculated collaborator permission for the exact repository and preserves a sanitized provider role such as `triage` or `maintain`. Unknown custom roles cannot elevate beyond the provider-reported base `read`, `write` or `admin` permission.

### Optional GitHub App

The installation account is the execution principal, not the human governance actor. The resolver requires:

1. fresh broker-sanitized installation identity and permission metadata;
2. proof that the installation token can resolve the exact repository;
3. current collaborator permission for the stored human authorizer.

If repository selection or current human authority cannot be proven, installation capabilities may be recorded but every governance role remains false.

### GitLab

The resolver reads the authenticated project response and uses the highest valid project/group access level. Access levels are mapped conservatively:

- Guest, Planner, Reporter and Security Manager → reader;
- Developer → author;
- Maintainer → reviewer;
- Owner → activator and administrator.

Maintainer and Owner are intentionally distinct.

### Gitea

The resolver uses the repository collaborator-permission response and normalizes `read`, `write` and `admin` without trusting client claims. Self-hosted provider authority is part of the canonical scope and cache key.

## Failure and cache behavior

Provider 401, 403, 404, 429, timeout, malformed response or missing installation evidence produces a minimized `partial` or `unavailable` snapshot. Provider response bodies and credentials are not copied into errors or evidence.

The cache is short-lived and bounded. Keys include provider authority, repository, authentication mode, execution identity and governance actor identity. Concurrent identical lookups coalesce; different identities, repositories and self-hosted authorities cannot share entries.

Task 5 records evidence without globally blocking current repository behavior when permission discovery is unavailable. Task 6 must fail closed for governance APIs when evidence is stale, unavailable or insufficient.

## Test-first evidence

The implementation began with failing tests for:

- module and snapshot contract absence;
- provider role normalization;
- GitHub App execution/human identity separation;
- missing installation and repository-selection evidence;
- provider failures and malformed responses;
- cache expiry, identity isolation and concurrent coalescing;
- gateway snapshot requirements and server wiring.

The independent review then produced additional failing regressions for GitLab Maintainer privilege inflation, forged access/role combinations and mutation actor mismatch.

## Independent review corrections

The read-only security review identified and corrected these issues before packaging:

1. GitLab Maintainer (`40`) was initially normalized as Owner/Admin (`50`). It now grants reviewer authority only; Owner remains required for activator/administrator.
2. Snapshot validation initially accepted independently supplied base role, numeric level and governance booleans. These fields are now required to match one deterministic mapping.
3. User execution identity and governance actor identity are now required to match, preventing a user snapshot from combining two identities.
4. The Mutation Gateway now binds user authorization identity and execution login to the mutation actor, in addition to exact repository scope.
5. GitHub App human permission resolution now occurs only after exact repository-selection proof.

No P0 or unresolved P1 finding remains in the source-level Task 5 review.

## Boundaries

- Task 5 does not expose governance HTTP APIs or authorize policy lifecycle operations; that is Task 6.
- Task 5 does not evaluate active policy, implement policy simulation, reviewer workflow UI, exceptions or enforcement modes.
- Authorization evidence is intentionally short-lived; Task 6 must check freshness at the point of each governance decision.
- Real provider responses can vary by version and custom roles; unknown or contradictory evidence intentionally under-grants rather than elevates.
- No live provider credentials, disposable repositories or Neon database were used in this environment.
- Dependency-backed server, browser and online advisory checks unavailable in this environment must be repeated in CI or staging as detailed in `BUILD_REPORT.md`.

## Next task

**Phase 1 Task 6 — Governance API and Authorization Boundary** will add authenticated repository-governance APIs and one server-side role/ownership/freshness boundary before governance-store operations. It must preserve Task 5 principal separation, require durable storage, enforce separation of duties and reject browser-supplied authority.
