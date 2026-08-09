# Nebulaverse-X v5.3.0-alpha.4 — Phase 1 Task 4 report

## Scope

This prerelease implements the Central Mutation Gateway Foundation required by later provider-role resolution, governance APIs, policy simulation and enforcement.

Task 4 establishes one controlled execution boundary for repository-changing provider operations. It does not yet decide whether an active policy allows, warns about or blocks a mutation. Existing GitHub PAT, GitHub OAuth, optional GitHub App, GitLab token and Gitea token behavior is preserved.

This is Task 4 of the controlled 21-task Phase 1 roadmap, not the completed v5.3 release.

## Architecture

- `src/mutation-gateway.js` defines the canonical action registry, immutable mutation descriptor, provider target parser, provider-operation classifier and asynchronous gateway context.
- `server.js` creates a single gateway and wraps every known repository-changing route with `mutationContext(action)`.
- GitHub/Gitea `gh(...)` writes and GitLab `glFetch(...)` writes independently assert the active gateway immediately before the outbound request.
- Git receive-pack and Git LFS write paths assert the gateway directly because they bypass JSON provider helpers.
- `AsyncLocalStorage` carries the immutable descriptor through awaited route logic without global mutable state.

## Registered route actions

The gateway covers 28 route-level workflows:

- repository create/delete;
- branch create/delete/reset;
- file write/delete/rename/batch/upload;
- directory move;
- blob creation;
- commit revert/restore/restore-paths;
- pull or merge-request create/merge/review;
- issue create/comment/update;
- star/unstar;
- workflow rerun;
- release creation;
- recovery reference restoration;
- webhook connect/disconnect.

## Descriptor and metadata contract

Each mutation is bound to:

- a generated UUID;
- stable action, category and risk;
- normalized provider authority and repository scope;
- immutable actor identity key and login;
- mutating HTTP method and route pattern;
- bounded allowlisted operational metadata;
- matching Task 1 step-up proof when required.

Mutation metadata is JSON-compatible, depth/key/string/array bounded, limited to 16 KiB and rejected when field names resemble tokens, secrets, passwords, private keys, authorization headers or cookies. Credentials, file contents and commit messages are not part of the descriptor.

## Defense-in-depth authorization boundary

The gateway enforces four independent matches before a provider write:

1. An active gateway context exists.
2. Provider authority and repository scope match.
3. The outbound write is classifiable as a registered provider operation.
4. That operation is explicitly allowed by the active route action.

This action-to-operation binding prevents a context for one write—such as starring—from authorizing repository deletion or another operation on the same repository.

Critical actions retain Task 1 protections. Repository deletion, hard reset and pull-request merge require proof that the exact matching single-use step-up grant was consumed before entering the gateway.

## Fail-closed behavior

Representative stable failure codes include:

- `MUTATION_GATEWAY_REQUIRED`;
- `MUTATION_ACTION_UNKNOWN`;
- `MUTATION_CONTEXT_NESTED`;
- `MUTATION_PROVIDER_MISMATCH`;
- `MUTATION_SCOPE_MISMATCH`;
- `MUTATION_ACTION_MISMATCH`;
- `MUTATION_OPERATION_UNREGISTERED`;
- `MUTATION_STEP_UP_REQUIRED`;
- `MUTATION_SENSITIVE_FIELD`.

The gateway fails before an outbound provider request. Unknown future write operations therefore require explicit registration and review rather than silently bypassing governance.

## Event boundary

An optional event sink receives minimized credential-free events for mutation entry, completion, failure and provider-write authorization. Events include stable mutation/action/scope identifiers and bounded error codes, not provider credentials or user content. Durable governance audit integration belongs to a later task.

## Continuity pack

The alpha.4 package adds:

- `PROJECT_STATE.md` — canonical checkpoint, constraints and exact next task;
- `PHASE_1_ROADMAP.md` — all 21 Phase 1 tasks plus Phases 2–4;
- `ARCHITECTURE_DECISIONS.md` — durable technical decisions;
- `CONTINUATION_PROMPT.md` — ready-to-paste recovery prompt;
- this Task 4 report;
- the approved Task 4 design and completed implementation plan.

These files make the release package—not chat history—the project source of truth.

## Test-first evidence

The implementation began with failing tests for:

- the action registry and descriptor contract;
- canonical repository scoping and immutability;
- invalid actors and sensitive metadata;
- missing Task 1 step-up evidence;
- GitHub/Gitea/GitLab target parsing;
- provider-operation classification;
- asynchronous context propagation;
- missing/nested contexts;
- provider, scope and action mismatches;
- minimized lifecycle events;
- exact server route coverage and helper assertions;
- required continuity artifacts and roadmap content.

The focused mutation gateway, server-contract, continuity, governance model/store, security-foundation and static compatibility checks are recorded in `BUILD_REPORT.md`.

## Independent review correction

A security review identified that repository-scope matching alone was insufficient: a route context for a lower-risk action could potentially authorize a different provider write against the same repository. The final design classifies every outbound operation and checks it against the exact action allowlist. The regression test demonstrates that the mismatched write is rejected.

## Boundaries

- Task 4 records and authenticates mutation intent but does not yet evaluate active policy.
- Provider permissions and governance roles are not yet resolved; that is Task 5.
- Bulk-operation per-item evidence, policy decisions, durable mutation audit linking, exception handling and enforcement modes arrive in later tasks.
- Real-provider destructive tests require disposable GitHub/GitLab/Gitea repositories and staging credentials.
- Real Neon migration and governance lifecycle rehearsal remains required before production promotion.
- The exact dependency-install, browser and online advisory verification available in this execution environment is documented in `BUILD_REPORT.md`; repeat unavailable checks in CI/staging.

## Next task

**Phase 1 Task 5 — Provider Permission and Governance Role Resolver** will derive a trusted, credential-free authorization snapshot for the active identity and repository. It must handle user and GitHub App installation identities, incomplete provider evidence, self-hosted providers and governance administration roles without trusting browser-supplied claims.
