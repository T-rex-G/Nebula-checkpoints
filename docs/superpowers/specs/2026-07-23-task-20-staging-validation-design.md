# Task 20 — End-to-End Staging Validation Design

## Goal

Create a fail-closed, reproducible validation gate for the frozen Phase 1 system. The gate must distinguish locally proven checks from dependency-backed, browser, live-Neon, live-provider and destructive sandbox checks. It must never translate an unavailable environment into a pass.

## Non-goals

- No new product feature.
- No production deployment.
- No customer-controlled evidence storage.
- No synthetic claim that GitHub, GitLab, Gitea, GitHub App, Neon or browser checks ran when credentials or dependencies are absent.

## Evidence model

Every required check has a stable identifier, category, execution tier, destructive flag and evidence requirements. Results are canonical JSON records with only non-secret environment fingerprints and artifact hashes. Raw credentials, tokens, cookies, URLs containing credentials and provider response bodies are forbidden.

The Task 20 gate passes only when every required check has a valid `pass` record. `blocked`, `failed`, missing, expired or malformed evidence keeps the gate closed.

## Validation tiers

1. Source and contract checks.
2. Dependency-backed runtime checks.
3. Browser, keyboard and accessibility checks.
4. Live Neon migration and concurrency checks.
5. Live provider compatibility checks for GitHub, GitLab and Gitea.
6. Optional GitHub App execution check when configured.
7. Destructive sandbox mutations and recovery checks.
8. Webhook delivery, DNS rebinding, retry, restart and dead-letter checks.

## Safety

Destructive checks require an explicit sandbox acknowledgement and must target repositories whose names contain the configured sandbox marker. Reports record hashes and stable identifiers, never secrets. Evidence expires after seven days by default so stale staging runs cannot authorize release.
