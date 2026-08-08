# Tasks 15–16 — Policy Templates, Repository Baselines and Digital Twin Read Model

## Goal

Provide immutable, versioned policy starting points and one repository-scoped, credential-free governance projection without creating, activating or mutating policy state.

## Task 15 — templates and baselines

- Built-in templates are source-controlled, immutable and versioned by catalog and template version.
- Template documents are normalized through the canonical governance policy model.
- Baseline generation is deterministic for an exact normalized repository scope, template and bounded server-resolved facts.
- Request bodies may select a template only; repository facts, roles, identities, policy state and provenance cannot be supplied by the browser.
- Generated output includes template/catalog provenance, scope hash, facts hash, document hash and baseline hash.
- Baselines default to `observe` and never create a policy, draft, version, approval, activation, exception or audit record.
- Baseline generation remains available under global read-only safeguards because it is an exact, enumerated non-mutating route.
- Provider branch discovery uses provider-native bounded pagination and marks exact completeness/truncation rather than guessing.
- Existing immutable policy versions are never modified.

## Task 16 — Digital Twin read model

- One reader-authorized endpoint returns current policy heads, proposed immutable versions, effective active-policy/exception state and bounded history references.
- The store reads the projection in one PostgreSQL `REPEATABLE READ READ ONLY` transaction.
- The read model is deterministic, deeply immutable, credential-free and repository/provider-authority scoped.
- History uses bounded limits and decision-sequence cursors.
- Freshness exposes one database snapshot timestamp and whether each bounded section is complete.
- No final UI is included; Task 17 owns presentation and interaction.

## Non-goals

- No template marketplace, remote template download or user-authored global template registry.
- No implicit draft creation or activation.
- No provider mutation or background worker.
- No Digital Twin UI.
- No Task 19 notifications, webhooks or exports.
- No external evidence storage.
