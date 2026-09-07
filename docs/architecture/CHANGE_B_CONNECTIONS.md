# Change B1 — owner Git connections and read-only repository listing

Status: first Change B implementation slice, stacked on Change A. The owner can
connect, list, explicitly select and disconnect Git accounts from the owner card,
then list repositories visible to the selected GitHub credential without a tester
invitation. This does not yet enable repository creation, the repository workbench
or commits through owner authority. Those remain Change B2.

## Identity and access

Ownership still comes from the server-resolved principal/workspace binding.
Connecting another Git account is not identity linking, and selecting it never
changes the workspace owner. Neither a browser mode nor an account name grants
owner authority. Existing cohort APIs, invitations, repository allowlists,
provider sessions, safety records and cleanup remain separate.

The new read-only route is `GET /api/workspace/repositories`. It requires a live
workspace session, an explicitly selected connection and that session's encrypted
credential. It enforces the existing `repository.read` capability and makes only
a GitHub `/user/repos` read with the selected credential. It lists at most 100
repositories, with a truncation notice when more may exist. Only selected display
fields leave the server; no raw provider response or token reaches the browser.

The first repository adapter supports GitHub. GitLab/Gitea accounts can be bound,
selected and disconnected but their owner repository listing is not implemented.
The provider's own permissions still apply. No capability is promoted by this PR.

## Credential lifecycle

`POST /api/workspace/connections/connect` performs fresh server-side human-account
verification. Only this explicit connect operation stores a credential; the
original `POST /connections`, setup and sign-in remain metadata-only. The credential is sealed
with the existing server AES-256-GCM codec and held in `nv_workspace_credentials`.
Binding metadata and replacing this session's credential are atomic.

The authenticated envelope binds the token to the principal, workspace,
connection, workspace session hash, provider, instance and verified provider
user ID. Copying ciphertext to another session or connection does not authorize
its use. No credential is borrowed from an existing tester/provider session.

- Restart: the encrypted credential survives while its workspace session is valid.
- Another browser session: reconnect explicitly; it cannot borrow the first
  session's credential even when both belong to the same owner.
- Sign-in rotation/sign-out: the old session's credential rows are deleted by
  foreign-key cascade; durable identity and connection metadata stay intact.
- Disconnect: revoke only this workspace's connection, clear its selections and
  remove its credentials across this workspace's sessions. This does not revoke
  the provider token itself or disconnect a cohort account using that provider.
- Reactivation after out-of-band revocation: discard any leftover credentials
  before binding again; metadata-only binding never resurrects old tokens.
- Expiry: the session immediately stops authorizing reads. The existing database
  maintenance task removes expired workspace sessions and their credential rows
  at startup and periodically (12 hours); a new sign-in also removes expired
  sessions for that principal. Offline services cannot run physical cleanup.
- Server key loss/rotation: unreadable ciphertext requires reconnection; it never
  falls back to another session's credential. Existing sealed workspace cookies
  also need a fresh sign-in after a server-key change.

The UI clears the connection token field after each attempt and serializes owner
and connection actions. It clears old repository results on account actions.
Lost mutation replies are never automatically replayed; the Change A session
reconciliation and visible uncertain-outcome handling remain in force.

`GET /api/workspace/connections` returns only this principal/workspace's active
bindings. `credentialStored` means this session has a credential row, not that a
provider token can never expire or that any experimental feature is qualified.

## Database rollout

No new Neon project or database is required for owner/cohort isolation. This slice
adds migration `017_workspace_credentials` to the existing migration sequence;
it does not edit migration 016 or legacy tables. The new table references only
workspace sessions and connections, not tester lifecycle tables.

Before deployment, identify the actual database used by Render, back it up and
verify its existing ledger/checksums. A deployment currently on 015 needs both
016 and 017, tested together, before this candidate starts in strict verify mode.
This is a coordinated migration/deployment operation, not something enabled by
merely opening this draft PR. No live migration is performed by this change.

Disabling the workspace feature does not erase credentials or undo the schema;
expired sessions are still pruned by database maintenance. Rolling application
code back to 015/016 will reject unknown later migrations in strict verify mode.
Use a reviewed forward fix or backup/restore plan rather than dropping tables.

## Verification and next slice

- Credential unit tests use authenticated encryption and reject copied/tampered
  ciphertext, cross-session/workspace/account bindings and invalid credentials.
- HTTP tests verify anonymous rejection, isolated session/CSRF handling, no token
  disclosure, no repository-write route, and unchanged legacy invitation checks.
- PostgreSQL tests cover restart, cross-session isolation, failed reconnect
  rollback, database constraints, rotation/sign-out/disconnect and legacy cleanup.
- Browser tests exercise connect → select → list → disconnect from the invitation
  gate in both viewports without changing the owner principal.

Tests use synthetic provider seams; they do not claim a live GitHub owner flow or
a Render deployment. CI must confirm actual PostgreSQL and browser behavior.

Next, B2 introduces the explicit owner/cohort authorization and resource-cleanup
compatibility adapter for repository create → open → ordinary verified commit.
It must retain provider permissions, mutation authorization and safety controls.
Do not populate `req.alpha` with a fake tester, widen workspace-cookie paths
without a cookie/CSRF migration plan, or treat legacy identity hashes as ownership.
