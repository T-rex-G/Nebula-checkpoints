# Deploy Nebulaverse-X 5.3.0-alpha.17.0 Controlled Alpha

Public alpha: **NO-GO** until the exact documentation successor completes the
automated, live-provider, hosted, manual-accessibility, and final release gates.
Use one dedicated Render Free service and one dedicated Neon Free project for
the cohort; do not reuse a production environment.

This package intentionally deploys only one Render resource:

```text
Nebulaverse-X — Web Service — Free
```

It does not create a Render PostgreSQL database.

The built-in bounded upload signature gate requires no extra package. The optional YARA adapter is not required for deployment and should remain disabled on Render Free unless you deliberately provide and maintain a trusted YARA binary and rules file.

## 1. Repository

Extract the ZIP and put its contents at the root of your private GitHub repository. Do not upload `node_modules`, `.env`, database URLs, PATs, or secrets.

## 2. Render Blueprint

Create or update the Blueprint from that repository. Confirm the review screen shows only the free web service.

The Blueprint runs:

```text
Build: npm ci --omit=dev
Start: npm start
Health check: /healthz
```

## 3. Environment

Open:

```text
Render Dashboard
→ Nebulaverse-X
→ Environment
```

Keep these values:

```text
NODE_ENV=production
SESSION_SECRET=<Render-generated value of at least 32 bytes>
DATABASE_URL=<your existing Neon pooled connection string>
NV_ALPHA_ACCESS_MODE=invite
NV_ALPHA_INVITE_PEPPER=<independent random value of at least 32 UTF-8 bytes>
NV_ALPHA_TERMS_VERSION=2026-07-29
```

The Neon URL normally contains `-pooler` and SSL parameters. Nebulaverse-X normalizes secure connections to `sslmode=verify-full` while retaining other parameters such as channel binding.

Before opening the cohort, verify the deployed environment still reports
invite access as active. Do not issue or accept tester invitations while
`NV_ALPHA_ACCESS_MODE` is absent or `off`, and rotate the invite pepper only
through the documented invitation invalidation procedure.

Do not create a Render database and do not add a `fromDatabase` block.

## 4. Deploy and verify

After deployment, open:

```text
https://YOUR-SERVICE.onrender.com/healthz
https://YOUR-SERVICE.onrender.com/readyz
https://YOUR-SERVICE.onrender.com/api/version
```

Expected:

```json
{ "ok": true }
{ "ok": true, "database": "connected" }
{ "version": "5.3.0-alpha.17.0", "product": "Nebulaverse-X", "releaseTreeSha256": "<64 lowercase hex characters>" }
```

The `releaseTreeSha256` value must equal the runtime release fingerprint recorded
for the frozen candidate; a version string alone is not deployment identity.

`/readyz` reports `optional-not-configured` when `DATABASE_URL` is intentionally absent. Basic repository functions can then use encrypted cookie sessions. When `DATABASE_URL` is configured, session storage fails closed during a Neon outage; verified live events, cross-session policies, signed snapshots, and evidence persistence also remain unavailable until readiness recovers.

## 5. Connect GitHub live events

1. Sign in to Nebulaverse-X.
2. Open a GitHub repository.
3. Open **Neural**.
4. Select **Connect verified live events**.

Render supplies the callback origin through `RENDER_EXTERNAL_URL`. No extra callback environment variable is required for the default Render URL.

## 6. Existing Blueprint note

When updating an existing Blueprint, Render does not prompt again for manually managed secrets. If `DATABASE_URL` is missing, add it directly under the web service's Environment page and redeploy.

## 7. Safe rollback

Deploy the last externally qualified commit only after confirming database
compatibility and preserving an encrypted backup. Never delete a table as part
of rollback; use the verified migration and restore procedures.


## Optional free-tier resource controls

```text
NV_LIVE_CLIENTS_PER_REPO=2
NV_LIVE_CLIENTS_TOTAL=10
NV_SNAPSHOT_RETENTION_COUNT=10
NV_SNAPSHOT_MANIFEST_MAX=5000
NV_EVENT_RETENTION_DAYS=30
NV_SESSION_RETENTION_DAYS=7
NV_GIT_DATA_MAX_MB=16
NV_NATIVE_PUSH_MAX_MB=16
NV_UPLOAD_MAX_MB=25
NV_UPLOAD_CONCURRENCY=1
NV_UPLOAD_TIMEOUT_MINUTES=20
NV_STALE_UPLOAD_HOURS=6

# Advanced/self-hosted only; leave empty on ordinary Render Free deployments
NV_YARA_RULES_PATH=
NV_YARA_BIN=yara
NV_YARA_TIMEOUT_SECONDS=5
NV_REQUIRE_YARA=0
```

The defaults are intentionally conservative for one Render Free Node process. Native pushes build an in-memory Git pack, so raising `NV_NATIVE_PUSH_MAX_MB` can multiply memory usage. Do not increase these values without checking memory, temporary disk, database, and connection usage.


## Optional GitHub App configuration

The GitHub App path is optional. If every `GITHUB_APP_*` value is absent, Nebulaverse-X starts normally and PAT/OAuth/GitLab/Gitea connectivity is unchanged. A partial configuration fails startup instead of silently running with broken authentication.

Create a GitHub App with these callback URLs:

```text
User authorization callback: https://YOUR-HOST/api/github-app/oauth/callback
Setup URL:                 https://YOUR-HOST/api/github-app/setup
```

Add the following values manually in Render Environment:

```text
GITHUB_APP_ID
GITHUB_APP_SLUG
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY_BASE64
GITHUB_APP_CALLBACK_URL=https://YOUR-HOST/api/github-app/oauth/callback
```

`GITHUB_APP_CALLBACK_URL` can be omitted when `PUBLIC_BASE_URL` contains the canonical HTTPS origin. `GITHUB_APP_WEBHOOK_SECRET` is optional in this task and reserved for later verified App-webhook work. Encode the full PEM private-key file as base64 before pasting it into Render; never put it in Git, browser code, logs, or screenshots.

Recommended minimum repository permissions depend on the operations you intend to allow. Start with only the repositories and permissions required for your deployment, then verify the scope shown in Settings. User-scoped capabilities such as creating repositories remain intentionally unavailable through an installation token; use the existing PAT/OAuth account for those operations.

## Optional YARA adapter

YARA is optional and is not installed by the Render Free native Node environment. Leave `NV_YARA_RULES_PATH` empty to use the built-in whole-file signature gate only. On a compatible self-hosted/container deployment, set the rules path and binary. Set `NV_REQUIRE_YARA=true` only after confirming the scanner is present, because uploads then fail closed when it is unavailable.

## Governance API configuration (v5.3 alpha.6)

Governance policy and draft APIs require a reachable `DATABASE_URL`. When PostgreSQL/Neon is absent or unavailable, governance operations fail with `503 GOVERNANCE_DATABASE_REQUIRED`; existing non-governance features keep their prior behavior.

Set `NV_GOVERNANCE_AUDIT_SECRET` to a stable random value of at least 32 bytes before creating production governance data. Back it up securely and do not rotate it casually: it is used to derive both lifecycle audit hashes and runtime policy-decision chain hashes. When omitted, Nebulaverse-X derives a compatibility key from `SESSION_SECRET`, which means changing the session secret also changes the audit verification key.

Governance write clients may send an `Idempotency-Key` of 8–200 printable characters. Exact retries are replayed for 24 hours; the server stores only a SHA-256 hash of the key.


## Runtime governance rollout (v5.3 alpha.10)

Before deployment, confirm no repository scope has more than 100 active governance policies. Migration `011_governance_policy_decisions.sql` deliberately aborts with remediation guidance when this invariant is violated; deactivate excess policies under the previous release and rerun the migration.

Set `NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn` during the first deployment. This is also the explicit Render Blueprint default. It allows an existing repository mutation to continue when active-policy evaluation cannot reach PostgreSQL or encounters invalid stored evidence, while emitting a bounded `POLICY_EVALUATION_UNAVAILABLE` warning and server log. Use this mode while applying migration `011_governance_policy_decisions.sql`, verifying `/readyz`, and exercising representative mutations in staging.

Change the value to `block` only after all of the following are true:

1. Neon is reachable and all migrations have completed.
2. Policy decision history can be listed and `/api/repo/:owner/:repo/governance/decisions/verify` reports a valid complete chain.
3. Active policies have been simulated against representative scenarios.
4. Observe and warn evidence has been reviewed for false positives.
5. Repository deletion, branch reset, pull merge, file writes, and provider-specific mutations have been tested with the intended credentials.

Policy document rollout modes are independent of the deployment failure mode:

- `observe`: record the evaluated effect without changing the mutation result.
- `warn`: allow the mutation and return bounded policy warning headers.
- `block`: stop a matching deny or approval-required decision before the provider transport executes.

Existing policies created before alpha.10 have no enforcement field and therefore remain in `observe`; upgrading does not unexpectedly block them. Governance control-plane and recovery actions are evaluated and recorded, but active policies cannot block them. This prevents a malformed or overly broad policy from trapping an administrator. Authorization, approval, simulation evidence, optimistic revision, Neon availability, and immutable audit checks continue to protect those operations.


## Runtime decision verification

Use the reader-authorized history endpoint with strict integer pagination: `GET /api/repo/:owner/:repo/governance/decisions?limit=100&afterSeq=0`. Continue with the returned `nextAfterSeq` until `complete` is true. Verify the immutable chain with `GET /api/repo/:owner/:repo/governance/decisions/verify?limit=50000`; an otherwise-valid result with `POLICY_DECISION_VERIFICATION_LIMIT` means the requested bounded prefix passed but the full chain is longer.

## Task 14 exception/waiver deployment gate

Before enabling Task 14 in a production repository:

1. Apply and checksum-verify `012_governance_exceptions.sql`.
2. Keep control catalog `1.0.0` available for historical alpha.10 decision verification; Task 14 writes catalog `1.1.0` and engine version 2.
3. Verify a request, independent approval, exact requester/target runtime application, wrong-actor and wrong-target rejection, revocation, expiry and policy-head supersession in staging.
4. Verify that a partial waiver leaves uncovered restrictive rules effective.
5. Verify the runtime decision chain across both engine versions and both catalog versions.
6. Confirm the repository/action active-exception count remains below 100. A 101st approval is rejected; revocation remains available.
7. Exercise concurrent approval/revocation and policy activation against live Neon to confirm advisory-lock behavior.
8. Confirm target metadata remains under 2 KiB, contains no raw content or credentials, and that optional GitHub App operations bind the exception to the verified human actor rather than the installation principal.

Do not remove historical catalog support after migration. Missing exception persistence or unsupported overflow must enter the configured governance runtime failure mode and must never silently grant a bypass.
