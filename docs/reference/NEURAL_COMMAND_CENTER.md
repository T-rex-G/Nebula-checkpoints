# Nebulaverse-X Neural Command Center v5.2.2
The Neural Command Center is an operational graph built from repository, identity, policy, dependency, recovery, and verified event data. It is not a decorative background and it does not require an AI API.

## Data sources

| Graph information | Source |
|---|---|
| Current repository and operator | Active encrypted Nebulaverse-X session |
| Other Nebulaverse-X sessions | Existing Neon `nv_sessions` store |
| Branches and tags | Provider references APIs |
| Commits, PRs, issues, releases | Provider activity APIs |
| Workflow state | GitHub Actions API |
| Dependencies and advisories | Manifest parsing, OSV, and Dependabot when authorized |
| Safeguards and protected paths | `nv_security_state` in Neon, session fallback without Neon |
| Signed snapshots | `nv_recovery_snapshots` in Neon |
| Verified provider events | GitHub webhook → `nv_intelligence_events` |
| Access posture | GitHub collaborators, deploy keys, and minimized webhook destination metadata |
| Recovery preview | Live refs/file manifest compared with a selected signed or local snapshot |
| Evidence integrity | `nv_evidence_chain` |

## Verified live mode

The **Connect verified live events** control performs this sequence:

1. Generates a random public hook identifier and 256-bit webhook secret.
2. Encrypts the secret before storing it in Neon.
3. Creates a repository webhook through GitHub.
4. Registers pushes, pull requests, workflows, issues, releases, reference changes, deployments, and repository vulnerability alerts.
5. Receives the exact raw request body at `/hooks/github/:hookId`.
6. Verifies `X-Hub-Signature-256` with a timing-safe HMAC comparison.
7. Confirms the payload belongs to the configured repository.
8. Deduplicates the GitHub delivery ID.
9. Minimizes and stores the event.
10. Scores it with deterministic rules.
11. Appends evidence and streams the event through SSE.
12. On reconnect, requests persisted events after the last opaque timestamp/event-ID cursor and pages until caught up.

A per-hook/IP rate guard rejects excessive webhook deliveries. The webhook receiver never accepts ordinary JSON parsing before signature verification. Cursor tie-breaking prevents events that share one PostgreSQL timestamp from being skipped.

## Risk scoring

Risk scoring is rule-based and capped at 100. A finding contains:

```json
{
  "score": 90,
  "severity": "critical",
  "reasons": [
    { "code": "FORCE_PUSH", "points": 45, "message": "A force push rewrote branch history." },
    { "code": "PROTECTED_PATH_CHANGED", "points": 45, "message": "Protected path change detected..." }
  ]
}
```

Current rules cover:

- Force pushes
- Branch/default-branch deletion
- Default-branch writes
- Protected wildcard/folder/file changes
- Workflow-file changes
- Common sensitive credential paths
- Failed workflow and deployment outcomes
- Repository vulnerability alerts
- Unknown actors

Scores are decision support, not proof of malicious intent. The inspector always shows the underlying reasons.

## Shadow Access Radar

Security and Governance modes add real access-path nodes for GitHub collaborators, deploy keys, and webhook integrations. Writable deploy keys and webhook configurations that disable TLS verification are treated as critical signals. Admin collaborators, inactive integrations, unverified keys, and partial inventories are shown with explicit reasons. The endpoint returns only minimized metadata and never returns deploy-key material, credentials, webhook secrets, or complete destination URLs.

## Explain this connection

Select a starting node, then a destination node. Nebulaverse-X uses breadth-first graph traversal to return the shortest visible relationship path.

Example:

```text
Actor alice
→ verified push
Commit 8ac21f
→ updated ref
Branch main
→ triggered workflow
Deploy production
```

Verified webhook edges are marked separately from relationships inferred from current provider state.

## Timeline and incident replay

The timeline combines provider-polled activity and signature-verified persisted events. Initial loading retrieves the latest bounded history; SSE reconnect, tab wake, and delivery bursts use cursor-based catch-up from Neon. You can:

- Move chronologically through events
- Select previous/next events
- Jump to affected nodes
- Pause graph animation
- Filter by severity
- Search nodes
- Inspect risk reasons and evidence

The current implementation is a deterministic replay surface, not an automated root-cause claim. GitHub push payloads that omit part of a large changeset are marked `CHANGESET_TRUNCATED` rather than treated as fully inspected.

## Protected assets

Safeguards accept:

```text
.github/workflows/deploy.yml   exact file
.github/workflows              folder and descendants
.github/workflows/**           recursive wildcard
src/*.js                       one directory level
```

Protected paths block Nebulaverse-X write routes including edits, uploads, deletes, renames, staged commits, and other operations that expose candidate paths to the guard.

Enforcement label:

```text
🛡 Nebulaverse-X enforced
```

Provider rulesets remain necessary for enforcement outside Nebulaverse-X.

## Verified recovery preview

A snapshot node can open a non-mutating comparison against the current repository. The workflow shows branch resets/recreation, preserved newer branches, file-manifest differences, truncation limits, provider-protected branches, and active Nebulaverse-X policies. Read-only mode or protected-path policies make the preview fail closed until the operator explicitly unlocks them. A second typed confirmation is required before reference changes. The preview also returns a short-lived encrypted server authorization bound to the repository, active identity, and exact branch actions. The write route rejects expired/replayed authorizations and stops with `RESTORE_PREVIEW_STALE` if a branch moved after preview.

## Emergency Shield

Emergency Shield coordinates existing controls:

1. Calls one authenticated server-side containment endpoint.
2. Captures a bounded branch, tag, and file manifest.
3. Enables persistent Nebulaverse-X read-only mode.
4. Freezes offline/background synchronization.
5. Revokes other Neon-backed sessions for the same identity and closes their live streams.
6. Signs the emergency manifest and persists it/evidence when Neon is available.
7. Exports recent repository activity and updates the graph to show containment.

Activation requires typing `FREEZE`.

Read-only mode blocks writes through Nebulaverse-X only. It does not disable direct Git/provider access.

## Dependency and upload security posture

Dependencies are resolved from supported manifests/lockfiles and queried through OSV, with Dependabot data included when authorized. If OSV is unavailable, the graph creates an explicit incomplete-scan node rather than showing a clean result.

The Security and Dependencies views also show the upload malware gate:

- Active whole-file built-in signature scanning for every raw/batch upload
- Optional administrator-managed YARA CLI rules
- Warning state when a configured required scanner is incomplete

YARA is an optional deployment adapter. Render Free does not supply a YARA binary automatically, and the built-in gate is not a substitute for an isolated malware sandbox.

## Signed snapshots and evidence

A signed snapshot contains:

- Repository/provider identity
- Default branch
- Branch names, SHAs, and protection status
- Tags and SHAs, plus an explicit availability/error state when the provider tag inventory cannot be read
- Optional default-branch file manifest with path, blob SHA, size, and Git mode
- Capture timestamp
- HMAC signature

The evidence export includes:

- Recent normalized events
- Signed snapshots and signature-validation status
- Evidence-chain verification result
- The bounded sequence/hash records used by that verification

Changing `SESSION_SECRET` invalidates old signature verification by design.

## Privacy model

- Authenticated API responses are network-only by default. Only allowlisted small repository reads may use the opt-in, account/session-scoped offline cache; Neural security, live-event, evidence, recovery, session, notification, raw-file and ZIP endpoints remain network-only.
- Sensitive Neural data is not available as stale cross-account browser cache.
- Offline drafts and explicitly queued writes remain in the application's browser storage until sent or cleared.
- Webhook records store minimized fields rather than complete raw GitHub payloads.

## Operating modes

### Security
Actors, sessions, verified events, workflows, vulnerabilities, protected assets, and containment.

### Recovery
Branches, tags, snapshots, releases, and recovery gaps.

### Dependencies
Packages, advisories, protected manifests, and affected relationships.

### Governance
Safeguards, protected paths, branch protection, identities, and evidence.

### Activity
Commits, pull requests, issues, releases, workflows, and live provider events.

## Scale limits

The Canvas renderer is optimized for repository-level operational views. The client deliberately caps many node families to keep the map understandable. Organization-scale graphs with thousands of nodes should use clustering, pagination, and potentially a WebGL renderer in a later release.
