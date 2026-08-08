# Provider Permission and Governance Role Resolver Design

## Goal

Derive one immutable, credential-free authorization snapshot for the active provider identity and repository scope from trusted server/provider evidence. The snapshot prepares the Central Mutation Gateway and later governance APIs without changing current repository mutation behavior.

## Boundary

The resolver sits after provider credential resolution and before mutation descriptor creation:

```text
session account -> provider credential broker -> authorization resolver -> mutation descriptor -> mutation gateway
```

The resolver owns provider permission normalization, evidence status, short-lived caching and governance-role derivation. It does not own credentials, durable policy state, route authorization, policy evaluation, approval workflow or UI.

## Snapshot contract

Schema version 1 contains:

- canonical provider authority and repository scope;
- execution principal (user or GitHub App installation);
- separately identified human governance actor;
- normalized repository access and provider role;
- conservative governance role booleans;
- credential-free GitHub App installation capabilities when applicable;
- bounded evidence status, timestamps and reason code.

Snapshots are deeply frozen and reject token-, secret-, password-, authorization- and cookie-like fields.

## Provider evidence

- GitHub PAT/OAuth: `GET /repos/{owner}/{repo}/collaborators/{login}/permission`.
- Optional GitHub App: fresh broker installation metadata, repository visibility through `GET /repos/{owner}/{repo}`, and current human authorizer permission through the collaborator permission endpoint.
- GitLab: authenticated `GET /projects/{encoded path}` and the highest of `permissions.project_access.access_level` and `permissions.group_access.access_level`.
- Gitea: `GET /repos/{owner}/{repo}/collaborators/{login}/permission`.

Browser-supplied permission names, role flags or installation capability claims are never inputs.

## Conservative role mapping

- Reader: normalized read access or higher.
- Author: normalized write/Developer access or higher.
- Reviewer: normalized maintain/Maintainer access or higher.
- Activator and administrator: normalized repository administration/ownership access only.

Unknown custom roles never elevate beyond their provider-reported base access. Incomplete evidence grants no governance role.

## Failure behavior

Provider 401, 403, 404, 429, timeout, malformed response or missing fresh installation evidence returns a bounded `partial` or `unavailable` snapshot. It does not disclose upstream response bodies. Existing browsing and mutation behavior remains compatible because Task 5 records evidence only; Task 6 will enforce governance API authorization.

## Cache

Cache keys include provider authority, repository scope, execution identity, governance actor identity and authentication mode. Entries are short-lived and bounded. Concurrent identical resolutions coalesce; different identities, authorities and repositories never share evidence.

## Non-goals

No governance APIs, policy draft workflow, reviewer UI, simulation, active-policy decision, exception workflow, organization inheritance or provider-side permission mutation.
