# Task 19 — Governance Notifications, Webhooks and Signed Audit Exports

## Goal
Provide failure-isolated lifecycle notifications, signed outbound webhook events and bounded verifiable evidence exports without exposing credentials or implementing external evidence storage.

## Contracts
- Authoritative governance transactions append immutable outbox references; delivery happens asynchronously and cannot roll back governance state.
- Event payloads are versioned, bounded, credential-free and linked to immutable source hashes.
- Webhook destinations require HTTPS port 443, no credentials/query/fragment, and only public DNS answers. DNS is revalidated immediately before delivery and TLS is pinned to a validated address while preserving hostname verification.
- Webhook payloads are canonicalized and HMAC-signed with delivery ID, timestamp, event hash and idempotency key. Secrets are generated server-side, encrypted/derived outside evidence, shown once and rotatable.
- Retry is lease-based, bounded to five attempts, retries only transient failures and records dead-letter status without response bodies.
- Evidence exports contain at most 1,000 events and 4 MiB, use deterministic JSON or formula-safe CSV, and are wrapped in a signed immutable envelope.
- Notification preferences are repository- and verified-identity-scoped. Browser delivery state is live-only and never persisted offline.
- Phase 5 customer-controlled storage is explicitly out of scope; it consumes this stable envelope later.

## Acceptance evidence
- Unit and contract tests cover schemas, SSRF/IP validation, signatures, CSV safety, persistence, API authorization, worker retry/dead-letter behavior, routes and UI trust boundaries.
- Migration sequence remains linear with migration 013 as head.
- Historical control catalog versions remain available.
