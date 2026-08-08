# Nebulaverse-X v5.3.0-alpha.1 — Phase 1 Task 1 report

## Scope

This prerelease implements the first approved Phase 1 security-foundation slice without changing the Render Free + optional Neon architecture or removing PAT, OAuth, GitLab, or Gitea connectivity. GitHub App authentication remains optional and is not enabled by this task.

## Implemented controls

- Session- and active-identity-bound CSRF tokens for authenticated unsafe API requests.
- Same-origin browser enforcement through the application header, Fetch Metadata, and explicit Origin validation.
- Short-lived step-up grants bound to one action and one normalized operation scope.
- Server-side pending-grant state and a bounded process replay registry; grants are consumed before protected handlers execute.
- Provider credential re-entry for PAT/token accounts.
- Provider authorization revalidation for OAuth accounts, with a distinct assurance claim reserved for future optional GitHub App sessions.
- Step-up protection for repository deletion, hard branch reset, pull-request merge, direct revocation of other sessions, and Emergency Shield’s indirect session-revocation path.
- In-memory-only browser CSRF state, identity-boundary clearing, and immediate removal of re-entered credentials from the hidden modal inputs.

## Security contracts

- Signed tokens reject tampering, expiry, identity changes, session changes, action changes, and scope changes.
- A consumed grant cannot be replayed from the same session state.
- Parallel copies of the same session cannot consume the same grant twice on the running service instance.
- CSRF rejection occurs before mutation handlers, allowing one safe client-side token refresh and retry.

## Boundaries

- This is **Task 1 of the approved 21-task Phase 1 plan**, not the completed v5.3 release.
- No real provider credentials or destructive disposable repositories were available in the build environment.
- OAuth authorization is revalidated, but a provider-hosted fresh-login challenge requires the later identity-flow work.
- The in-process replay registry protects Render Free's single running instance. With cookie-only sessions, replay of an old pre-consumption cookie after a process restart remains bounded by the five-minute grant lifetime. Optional Neon sessions preserve consumed session state across restarts.
