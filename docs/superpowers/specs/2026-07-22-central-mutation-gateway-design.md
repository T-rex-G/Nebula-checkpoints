# Central Mutation Gateway Foundation Design

## Status

Approved from the Phase 1 roadmap and the user's instruction to continue with Task 4 while making the release package independently recoverable in a new conversation.

## Goal

Create one fail-closed, repository-scoped execution boundary for every outbound provider mutation, without yet evaluating governance policies or changing existing route behavior.

## Scope

Task 4 adds:

- a canonical registry of repository mutation actions;
- immutable mutation descriptors bound to provider authority, repository scope, actor identity, route, risk and non-secret metadata;
- an asynchronous request context that survives nested awaits and provider helper calls;
- mandatory gateway assertions inside GitHub, GitLab and Gitea write helpers;
- direct gateway assertions for Git transport and Git LFS write paths;
- action-to-provider-operation binding so one route's authority cannot be reused for another write on the same repository;
- Task 1 step-up proof binding for repository deletion, hard reset and pull-request merge;
- minimized credential-free lifecycle events;
- static coverage contracts for every known repository-changing route;
- self-contained roadmap, project-state, architecture-decision and continuation artifacts.

Task 4 does not add:

- policy evaluation or enforcement decisions;
- provider permission or organization-role resolution;
- policy APIs, reviewer workflows, simulation, activation or rollback UI;
- direct provider-side ruleset changes;
- organization-wide inheritance.

## Architecture

`src/mutation-gateway.js` is a framework-light security boundary. It uses `AsyncLocalStorage` to bind one normalized mutation descriptor to the current asynchronous execution path. The descriptor is immutable and contains no provider credential, cookie, authorization header, commit message or file content.

`server.js` creates one gateway instance. Every repository-changing route enters the gateway through `mutationContext(action)`. The provider write helpers (`gh`, `glFetch`) and transport writers (`uploadViaGitPush`, `uploadViaLFS`) independently call `assertProviderMutation(...)` immediately before the outbound write. This creates defense in depth: a forgotten route wrapper fails closed at the helper, and a mismatched route action fails closed before the provider request.

The gateway is policy-neutral in Task 4. Later tasks can insert permission resolution, policy simulation and enforcement between descriptor normalization and outbound authorization without changing every route again.

## Mutation descriptor

A descriptor contains:

- UUID mutation identifier;
- stable action ID, category and risk;
- normalized provider, authority, owner, repository and scope key;
- immutable actor identity key and display login;
- HTTP method and Express route pattern;
- bounded, allowlisted, credential-free metadata;
- optional proof that the Task 1 step-up grant was consumed.

Descriptors reject unknown actions, malformed actor identities, unsafe route strings, non-mutating methods, oversized metadata, excessive nesting and sensitive field names.

## Action and operation binding

The route action is not sufficient by itself. Every provider request is classified into a lower-level operation such as:

- `repository.create` or `repository.delete`;
- `git.refs.create`, `git.refs.update` or `git.refs.delete`;
- `git.blob.create`, `git.tree.create` or `git.commit.create`;
- `gitlab.file.write` or `gitlab.file.delete`;
- `pull.create`, `pull.merge` or `pull.review`;
- issue, star, workflow, release and webhook operations;
- `git-receive-pack` and `git-lfs` transports.

Each registered mutation action declares the exact operation classes it may execute. A `repository.star` context cannot authorize deletion, and a `file.write` context cannot merge a pull request even when both target the same repository.

## Security invariants

- Every outbound repository write requires an active gateway context.
- Provider, authority, owner and repository must match the descriptor.
- The classified provider operation must be explicitly allowed for the active action.
- Unknown mutation actions and unknown provider operations fail closed.
- Nested gateway contexts are rejected to prevent authority confusion.
- Repository deletion, branch reset and pull-request merge require matching Task 1 step-up evidence.
- Metadata is JSON-compatible, bounded to 16 KiB, depth-limited, key-limited and rejects credential-bearing field names.
- Event sinks receive only minimized identifiers, action, risk, scope and stable error codes.
- PAT, OAuth, optional GitHub App, GitLab and Gitea credential behavior is unchanged.
- GitHub App authentication remains optional.

## Route coverage

Task 4 assigns stable actions to 28 route-level mutation workflows covering repository, branch, file, history, pull request, issue, star, automation, release, upload, recovery and webhook changes. Static contracts verify every known route declares the expected action, while runtime helper assertions protect newly added writes that forget to enter the gateway.

## Error handling

The gateway returns stable `MutationGatewayError` codes and fails before an outbound provider side effect. Representative codes include:

- `MUTATION_GATEWAY_REQUIRED`;
- `MUTATION_ACTION_UNKNOWN`;
- `MUTATION_PROVIDER_MISMATCH`;
- `MUTATION_SCOPE_MISMATCH`;
- `MUTATION_ACTION_MISMATCH`;
- `MUTATION_OPERATION_UNREGISTERED`;
- `MUTATION_STEP_UP_REQUIRED`;
- `MUTATION_SENSITIVE_FIELD`.

Provider errors remain handled by the existing route logic after the gateway has authorized the write boundary.

## Verification strategy

- Pure unit tests prove descriptor normalization, immutability, sensitive-field rejection, scope parsing, operation classification, async context propagation, nested-context rejection, action binding and event minimization.
- Static server contracts prove all known mutation routes declare the exact action and all provider write helpers assert the gateway.
- Existing security, governance, GitHub App, migration, hardening, package and smoke tests remain regression requirements.
- Clean-package verification must inspect archive paths, extract into a new directory, install the lockfile, run checks and validate packaged runtime when the environment permits dependency restoration.

## Continuity strategy

The alpha.4 package is self-describing. `PROJECT_STATE.md`, `PHASE_1_ROADMAP.md`, `ARCHITECTURE_DECISIONS.md`, `CONTINUATION_PROMPT.md` and task reports identify the canonical version, completed work, exact next task, constraints and known verification boundaries. A future conversation should be able to continue from the ZIP without relying on shared-chat history.
