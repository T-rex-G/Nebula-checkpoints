# Personal workspace foundation — Change A

Status: opt-in backend foundation. This change does not activate a new owner UI,
enable repository creation, change any capability status, or change a live
deployment. It is the first implementation slice of the BYO-AI workspace plan.

## Contract

A verified human plus a deployment-controlled, one-time setup credential can
claim one personal workspace. The server resolves ownership from PostgreSQL on
every request. A Git connection is an execution identity, not the person who
owns the workspace. There is no browser-controlled owner/tester switch.

The observable foundation workflow is: establish a CSRF challenge, claim setup,
read the owner context, explicitly bind a verified Git account, and select that
connection without changing the principal or workspace. Subsequent sign-in
re-verifies the same provider user ID and rotates the workspace session.

| Authority or record | Source of truth | What it does not grant |
| --- | --- | --- |
| Human principal | Internal UUID and verified provider/instance/user-ID binding | Provider repository permissions |
| Workspace owner | `nv_workspaces.owner_principal_id` | Global administrator status or another user's credentials |
| Git connection | Explicit verified metadata bound to principal and workspace | A new login identity or ownership |
| Legacy cohort session | Existing invitation, tester, provider-session and scope checks | Workspace ownership |
| Setup credential | Operator-provisioned verifier and fixed expiry, plus durable claim row | Ownership after initial setup or an automatic recovery path |

The schema deliberately permits future workspaces and membership support;
the current resolver supports only the actual owner. Non-owner administration,
cohort membership management, workspace selection UI, ownership transfer,
identity-linking UI and tester preview are not implemented by this change.

## Identity and credential boundaries

`workspace-identity.js` uses the provider, canonical HTTPS instance (including a
self-hosted base path), and verified numeric user ID. A rename or replacement
token for that identity resolves to the same principal. An installation ID,
username, request-supplied role or invitation label cannot claim ownership.
GitHub App installation sign-in is not supported on this surface. Human token
verification reuses the existing GitHub/GitLab/Gitea `/user` adapters and
self-hosted host validation. Unsupported or bot identities are refused.

Only `/setup` creates a login identity. `/connections` re-verifies a provider
credential but stores metadata only: no token, OAuth secret or installation
credential. It cannot log the connected account in as the owner. Neither the
workspace session nor CSRF responses contain provider credentials. The legacy
identity reference is retained unchanged as metadata, not adopted as resource
ownership. Readiness of a provider-specific workflow still needs its own tests.

## Legacy compatibility is isolation, not an invitation bypass

The narrow `/api/workspace` router is mounted after security headers,
same-origin API intent checks, request limits and maintenance, but before the
global invitation boundary. It authenticates its own exact endpoints. Unknown
paths terminate with 404; the rest of `/api` still passes through the unchanged
cohort boundary.

| Existing surface | Change A behavior |
| --- | --- |
| `nv_session`, `nv_alpha_access`, account switching and disconnect | Existing handlers and lifecycle remain authoritative |
| Repository APIs, provider permissions, mutation gateway, protected paths | Unchanged; a workspace cookie alone cannot authorize them |
| Evidence, safety, webhooks and legacy hashed identities | No rewrite, backfill, sharing or new ownership assertion |
| Tester revocation/deletion and cleanup | Continue using existing ownership tables; new tables have no cascade from them |
| New workspace logout/disconnect | Affect only that principal's foundation records, not a cohort session or provider account |

This is intentionally an API foundation, not a claim that owner repository work
is already unlocked. Before Change B lets workspace sessions consume legacy
resources, its compatibility adapter must account for every active owner and
cohort binding during cleanup and revocation. A matching legacy hash alone is
not permission to consume retained data or reuse another session's credential.

## Configuration and activation

Disabled by default. No Render blueprint or live environment is changed.

| Setting | Meaning |
| --- | --- |
| `NV_WORKSPACE_FOUNDATION_ENABLED=1` | Enables only the foundation API; requires `DATABASE_URL` |
| `NV_WORKSPACE_SETUP_SHA256` | Lowercase SHA-256 digest of a separately generated random setup credential |
| `NV_WORKSPACE_SETUP_EXPIRES_AT` | Absolute UTC ISO timestamp, paired with the digest; no restart-relative deadline |

An operator generates at least 32 random bytes, encoded as base64url (43 or more
characters), using a local cryptographic generator. Keep the original credential
private; configure only its SHA-256 verifier and a short explicit expiry
(for example, one hour). Do not use a memorable password. Do not put either the
provider credential or setup credential in a URL, issue, PR, screenshot, source
file, shell history or application log. No actual credential is supplied here.

Use the normal migration/deployment runbook: test the additive migration in an
isolated PostgreSQL database, back up before any live migration, apply migration
016 deliberately, and retain production verify mode. Run `npm run doctor` against
the intended environment. Turning on this feature is a separate operator action,
not a consequence of opening or merging this PR.

After successful setup, remove both setup settings. Sign-in only needs the
durable binding and verified provider identity. A changed verifier, restart,
missing owner login or revoked principal never resets the durable claimed row.

## API protocol

All responses are `no-store`. Use HTTPS in production and the configured public
origin. Every POST requires `Origin`, `X-NV: 1`, a JSON body and `X-NV-CSRF` from
the current session response. Origin is required for non-browser clients too.
Credentials belong only in a protected request body and are never persisted by
this router. Browser same-origin requests supply `Origin` automatically.

| Endpoint | Request / response |
| --- | --- |
| `GET /api/workspace/session` | Anonymous: short-lived challenge cookie and CSRF token. Authenticated: current principal/workspace/owner role, selected connection and fresh CSRF token |
| `POST /api/workspace/setup` | `{provider, token, baseUrl?, setupSecret}`; atomically claims setup and returns owner context with rotated session and CSRF token |
| `POST /api/workspace/sign-in` | `{provider, token, baseUrl?}`; re-verifies an existing login identity and rotates this browser's workspace session |
| `POST /api/workspace/connections` | `{provider, token, baseUrl?}`; explicitly verifies and binds connection metadata; returns its ID, without changing the selected connection or login identity |
| `POST /api/workspace/connections/select` | `{workspaceId, connectionId}`; both must belong to the current server-resolved context |
| `POST /api/workspace/connections/disconnect` | `{connectionId}`; revokes only the caller's metadata binding and clears its selections across their workspace sessions |
| `POST /api/workspace/sign-out` | `{}`; deletes this workspace session and clears the workspace cookies |

Unknown body fields (including role/principal claims) are rejected. Provider
defaults to GitHub; GitLab defaults to its hosted instance; Gitea needs an
approved HTTPS base URL. OAuth callback integration is a later UI/workflow task.

The workspace cookie is HttpOnly, SameSite=Strict, Secure in production and scoped
to `/api/workspace`. It contains only a sealed opaque random session token;
PostgreSQL stores its hash. Sessions expire absolutely after eight hours, with
at most ten live sessions per principal. There are at most twenty connection
records per workspace/principal, including revoked entries; re-verifying an
existing connection reuses its slot. No cache fallback is allowed on DB failure.
The challenge expires after five minutes and cannot authorize a signed-in action.

Setup/sign-in have an additional ten-attempt-per-minute process-local IP limit.
Invalid setup-secret attempts are also counted durably: five attempts lock setup
for fifteen minutes, surviving restart. The durable setup row is locked for the
claim transaction; provider verification uses the existing bounded timeout.
Two concurrent claims cannot overwrite the owner, and a failure rolls back the
principal, login identity, workspace, claim and session together.

## The owner entry point

`public/workspace-ui.js` is the browser transport for the routes above, and the
owner card on the login screen is the only way a person reaches them.

It is deliberately not `app.js`'s `api()`. That client carries the alpha
session's CSRF token; this router issues its own, bound to the challenge cookie
before an owner exists and to the workspace session afterwards. Sending one
where the other is expected fails closed -- correct, but unexplainable to
whoever is reading the screen. Keeping the transports apart is what makes the
boundary above real in the client rather than only on the server.

Three behaviours are load-bearing and each is guarded:

- **A 404 means switched off; a transport failure does not.** An unreachable
  server resolves to unknown, never to disabled. Reporting "off" on a dropped
  request would silently hide the card from an owner whose deployment has the
  foundation enabled.
- **The card is hidden unless the server says the foundation is on.** Every
  deployment currently runs with `NV_WORKSPACE_FOUNDATION_ENABLED` unset, so the
  login screen is unchanged from before this card existed.
- **An expired challenge is recovered once.** The challenge lives five minutes
  and a person reading setup instructions will routinely take longer, so a stale
  one is the expected case: re-probe and replay a single time, then report.

The setup credential's shape is checked in the browser before it is sent. The
server counts five invalid attempts and then locks setup for fifteen minutes;
spending one of those on a typo is a real cost.

### Reaching it past the invitation gate

`alpha-ui.js` raises the invitation gate over every screen whenever the mode is
not `off` and no cohort session exists, so on an `invite` deployment an owner
never reaches the login page. The card is therefore hosted on whichever screen
is showing -- one element moved between the two, not a second copy to drift.

This widens no authorization. `/api/workspace` mounts ahead of
`app.use('/api', alphaAccessBoundary)`, so these routes were always outside the
invitation boundary; only the client was failing to offer the entry point that
the server already accepted.

The card carries its own provider, server URL and token fields. Reading the
login page's inputs was tried first and is wrong twice over: the gate covers
that page, so the card would read fields its own reader cannot see, and owner
sign-in is a different authentication path from the cohort login beside it --
sharing one token box would make the credential in use depend on which button
was pressed.

What owner sign-in does **not** grant is stated on the card itself. Repository
routes resolve their authority from `req.alpha`, the cohort session, at
thirty-six call sites -- twenty of which read `testerId` for session ownership,
privacy purge, webhook and evidence identity, and one of which enforces the
invitation's repository allowlist. A workspace session is not that object and
must not be made to impersonate one. So an owner who signs in has a workspace
and a verified login identity, and the repository app is unchanged for them
until Change B introduces the compatibility adapter that lets those call sites
resolve either authority. The screen says so rather than leaving the next
refusal unexplained.

Connection binding and selection likewise have routes but no controls yet;
Change B is where connections are adopted operationally.

### Running the gates this work is checked by

The card's first push failed CI on `npm run lint` -- a `no-undef` in an
end-to-end callback -- after its tests had been run and passed. `npm test` is
one of eleven commands the verify job runs, and working from a remembered list
is how ten of them get skipped.

`npm run ci:local` runs that job's steps in order, parsed out of
`.github/workflows/ci.yml` rather than restated, so a gate added to the
workflow is picked up without editing anything. Two steps are skipped with
printed reasons: `npm ci`, and the Playwright browser install this environment
already provides. `test/ci-local.test.js` holds it honest -- it counts the
workflow's `run:` steps independently of the parser, requires every skip to
carry a reason, and names the eleven gates that must still be reached. A runner
that quietly missed one would report a pass for a check that never ran, which
is the same mistake it exists to prevent wearing a green tick.

The migration gate needs `NV_TEST_DATABASE_URL`; the runner refuses rather than
reporting a pass for a database it never consulted.

## Recovery and rollback

First try a new provider token for the same verified user ID; a rename does not
require identity migration. A setup response lost after commit is recovered by
signing in, not by claiming again.

If the original human provider identity is genuinely lost, there is no public
recovery endpoint. Recovery requires the authenticated deployment/database
operator, a backup, a maintenance window, fresh verification of the replacement
human identity, and an explicitly reviewed transaction targeting the existing
principal/workspace. Check the existing owner and claimed workspace under lock;
add the verified replacement login binding to that same principal only if its
provider/instance/user ID is not bound elsewhere. Never use an upsert to steal a
binding. Remove a compromised login binding only after a replacement is secured,
revoke workspace sessions for that exact principal, and record the recovery
without credentials. Confirm new sign-in and unchanged workspace ownership before
ending maintenance. This is login recovery, not an ownership-transfer feature.
Do not delete/reset `nv_workspace_bootstrap` or infer ownership from the next
visitor. If deployment control or identity proof is uncertain, stop recovery.

To disable the API, turn the feature flag off; existing cohort behavior remains
the same. Keep additive tables and the claimed row. Rolling application code
back to a version expecting only migration 015 will fail strict migration
verification because 016 is then unknown. Prefer a forward fix or disable the
feature; a schema rollback requires a separately reviewed backup/restore plan.
Never edit an already applied migration or drop owner data to make startup green.

Backup manifests now read the source database's applied migration while holding
the migration lock through the dump. A pre-upgrade 015 backup remains labeled
015; a 016 backup is labeled 016. Qualification binds the restored migration to
the candidate's required migration instead of hardcoding 015, so old restore
evidence cannot qualify the new schema. Historical records remain unchanged.

## Evidence and next slice

- `workspace-identity.test.js`: stable-ID renames/rotation, provider and instance
  isolation, non-human rejection, configuration and credential expiry.
- `workspace-api.test.js`: real HTTP router with fake persistence/provider seams;
  CSRF, origin, role injection, cookies, isolated cohort routing and DB failure.
- `workspace-store-postgres.js`, invoked by `npm run test:migrations`: real
  PostgreSQL claim race, interrupted setup, session rotation, fresh store/restart
  context, connection isolation, revocation and legacy-table cleanup isolation.
- Existing cohort/privacy/session, provider authorization, capability, security,
  documentation and release tests remain required regressions.

Mocks do not prove SQL, durable concurrency, live provider authentication or a
Render deployment. The PostgreSQL gate must pass before this foundation is called
verified. Production smoke and owner UI usability are not claimed by these tests.

Next: Change B consumes the verified context through an explicit session and
cleanup compatibility adapter, builds on the owner setup/sign-in UI above, and implements the
eligible GitHub create → open → ordinary verified commit workflow. It must keep
provider permissions, mutation authorization, safety and experimental maturity
honest. Other capabilities and the BYO-AI Companion follow in separate slices.
