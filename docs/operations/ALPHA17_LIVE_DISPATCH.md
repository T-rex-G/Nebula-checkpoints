# Dispatching the GitHub golden qualification

GitHub is the only supported repository provider and the only live-provider
job in `.github/workflows/public-alpha-alpha17.yml`. Hosted Render/Neon,
independent review, manual accessibility and final release gates remain
separate requirements. Removing other providers does not close any of them.

This guide is an operator procedure, not authorization to dispatch. The current
PR must remain open and unmerged for another AI review. A later live run needs
an explicit instruction covering the reviewed candidate and disposable targets.

Historical runs, including the September provider runs, qualify only their own
candidate bytes. They do not qualify this PR. See the
[evidence index](../release/EVIDENCE_INDEX.md) and
[remediation report](../qualification/PRODUCT_REVIEW_REMEDIATION.md).

## Preflight before a separately authorized run

The workflow executes candidate code with live credentials. Review the source
commit and exact disposable GitHub repository before dispatch. Its `automated`
job builds and freezes an archive from the selected commit; every subsequent
artifact must bind that archive digest and source commit. A source change
requires a new candidate and new evidence.

The prior review could not read protected settings or workflow target variables
with its connected token (HTTP 403). The target descriptions below are setup
requirements, not a current readback. Confirm reachability, permissions,
fixtures and environment protection before supplying credentials.

| Requirement | Required state |
| --- | --- |
| Independent review | Exact candidate bytes reviewed before live credentials are exposed |
| Live environment | `alpha17-live-qualification`, holding only the secrets needed by the selected live jobs |
| Disposable GitHub target | Pre-created `owner/nvx-alpha17-…` repository with a real default-branch commit. Private or public: on a public one GitHub lets any reader open an issue, so the read-only refusal is proven by a label it may not create |
| API authority | `https://api.github.com`, fixed by the workflow |
| Mutation credential | Repository Metadata read; Contents, Actions, Issues and Pull requests read/write; account Starring read/write |
| Read-only credential | Metadata read and Contents read, with no write permission |
| Repository administration credential | A fine-grained token of a **dedicated qualification account** that owns nothing else: Administration read/write and Metadata read on all of that account's repositories. It creates one private `nvx-alpha17-<run>-repository` and deletes only that one |
| Notification credential | A **classic** token (prefix `ghp_`) of a bot account that is a collaborator on the disposable target only, with the `notifications` and `repo` scopes. GitHub serves notifications to no fine-grained token |
| Repository variable | `ALPHA17_GITHUB_REPOSITORY`, the exact `owner/name` |
| Live secrets | `ALPHA17_GITHUB_MUTATION_CREDENTIAL`, `ALPHA17_GITHUB_READ_ONLY_CREDENTIAL`, `ALPHA17_GITHUB_REPOSITORY_ADMIN_CREDENTIAL` and `ALPHA17_GITHUB_NOTIFICATIONS_CREDENTIAL` |

Every credential must be disposable and scoped to the dedicated sandbox or the
dedicated qualification account, never a production repository, a personal
account that owns real work, or a broad organization. The mutation credential
must be fine-grained: the notification proof checks that GitHub refuses it. The read-only credential exists
to prove `permission-denial`. If it can mutate the branch, the run must fail
with `ALPHA17_PERMISSION_SCOPE_INVALID`; granting it write permission cannot
be treated as a passing denial test.

### When the run says a credential was denied

`ALPHA17_PERMISSION_DENIED: provider denied the <name> credential on <METHOD>
<path>` means GitHub answered 401 or 403 to that credential on that request.
On the first request it has expired or been revoked; later in the run it is
short of one permission. Where GitHub names the permission it would have
accepted, the line ends `(the provider accepts: <permission>=<level>)`. Fine-grained
tokens expire on the date chosen at creation. Issue a new token with the
permissions above, replace the secret of the same name in the
`alpha17-live-qualification` environment, and dispatch again. Nothing else
needs to change.

`ALPHA17_REPOSITORY_CLEANUP_INCOMPLETE` names a repository in the
qualification account that the run could not prove it removed. Inspect it, and
delete it by hand only once it is confirmed to be that run's disposable
repository.

Retired-provider variables, credentials, jobs and harnesses are not inputs to
current qualification. Revoke any credentials that were issued for former
integrations in their original provider settings. Local removal of an account
or a workflow reference does not revoke a remote credential.

## Permanent fixtures

The GitHub target must contain these inert fixtures before dispatch:

| Fixture | Proves |
| --- | --- |
| Open issue, labelled in its body as a qualification fixture | `issues.read` list/detail agreement |
| Open pull request from a fixture branch | `pulls.read` list/detail agreement |
| Published release, not a draft | `releases.read` list/detail agreement |
| A completed run of a short `workflow_dispatch`-only workflow | `workflows.read`; the re-run probe dispatches a fresh run and re-runs that one |
| `NVX_SEARCH_FIXTURE.md` on the default branch containing `nvx-alpha17-search-fixture` | `search` and `global-search`, because GitHub indexes the default branch |

A fixture pull request needs a real difference from its base. Keep the workflow
short and disabled on `push`, so disposable proof branches do not start
unbounded CI. The re-run probe waits for its newly dispatched run to finish;
an unfinished run fails the probe rather than counting as success.

Each collection probe lists, fetches the listed object's detail and asks for a
nonexistent identifier. An empty collection fails: a successful empty listing
does not prove detail agreement. GitHub's issues endpoint also lists pull
requests, so one issue and one pull request may produce `listed: 2`.

## Activation envelope and approval boundary

The `authorize-live` job mints its own short-lived activation envelope after
`automated` freezes the candidate. It generates an ephemeral signing key,
binds the workflow, repository, dispatch ref, event, source parent and commit,
archive digest, selected jobs and exact target hashes, then discards the key.
The authorization contract uses schema `1.3.0`. The accepted job set is GitHub
and/or hosted; unsupported selections must fail before a live request.

This run-minted envelope binds **what ran**, not **who independently approved
it**. Repository write access permits workflow dispatch unless separately
configured protection prevents it. The live environment scopes secrets to
jobs but is not proof of independent approval. Inspect its actual protection
rules; do not assume a required reviewer is configured or available.

The release process still needs an independent reviewer or operator-held
approval where separation of duties is required. The operator-signing CLI
`node scripts/alpha17-authorize.js` remains available for reviewed authorization
workflows, but the current dispatch form does not accept an operator token.
Changing the workflow to require that token would be a separate reviewed change.

The nonce ledger rejects reuse of a spent approval identifier. A run-minted
envelope uses a fresh identifier for each run. The ledger currently lives in a
CI cache; losing that cache can reopen the replay window for an otherwise valid
unexpired approval. This limitation remains an operational release concern,
not evidence of a stronger approval boundary.

## Dispatch

After candidate review, target verification and explicit live-run authorization:

1. Open Actions → **Nebulaverse-X alpha.17 qualification** → Run workflow.
2. Select the reviewed branch/commit and set `run_github` to true.
3. Leave `run_hosted` false unless that separate target and destructive restore
   procedure were also reviewed and authorized. A GitHub-only dispatch does
   not pass the hosted gate.
4. Complete any configured environment review and record the actor/run link.
5. Inspect the candidate digest, source commit, target binding, probe outcomes
   and cleanup before accepting the artifact.

The hosted run's `live-events-delivery` check needs a deployment that serves
live events before they are Supported. Only the staging target does, set with
`NV_QUALIFICATION_CAPABILITIES=live-events`; it reports
`qualification.capabilities` in `/api/config`, and the cohort readiness check
fails it. Remove the variable in the same change that promotes live events: a
server still naming a Supported capability refuses to start.

The workflow exposes `run_github`, `run_hosted` and `run_drills`. A retired
provider must not be reintroduced through an old input, target map or artifact.
Independent hosted and manual evidence must bind the same candidate before a
final GO.

## Hosted drills and the operator record

The hosted gate trusts one Ed25519-signed operator record for the observations
no runner can make on its own behalf: a live event delivered by GitHub, a
provider rate limit, session revocation, provider disconnect, a restart, a
scale-to-zero wake, a database interruption, a rollback and a tester purge.
`run_drills` performs every one of them against the staging target and reports
them; a person reads the report and signs it.

1. **Dispatch `run_drills` alone.** The `hosted-drills` job verifies the same
   signed hosted target the gate does, then runs `ci/run-alpha17-hosted-drills.js`
   from the trusted checkout. Before it touches anything it refuses
   (`ALPHA17_DRILL_TARGET_REFUSED`) a service that deploys on its own, one
   that is not serving live events, or one whose deployment fingerprint is not
   the candidate's. It restarts, suspends, interrupts and redeploys that
   service and its cohort compute, so it never runs unless named.
2. **Read the report.** It is the one line between
   `ALPHA17_DRILL_REPORT_BEGIN` and `ALPHA17_DRILL_REPORT_END` in the job log:
   each check with its observations (latencies, statuses, counts) and the
   cleanup readback: compute enabled, no webhook left on the sandbox, the
   candidate served again, no active drill tester. It carries no invitation,
   cookie, token, database address or pepper. A run that did not pass or did
   not clean up prints `"ok": false` and the job fails.
3. **Sign it.** The operator holds the private key; it never enters the
   repository, the environment or a job.

   ```bash
   node scripts/alpha17-operator-record.js keygen --out ~/.nvx-operator   # once
   node scripts/alpha17-operator-record.js sign \
     --report job.log --key ~/.nvx-operator/operator.pem --key-id <keyId>
   ```

   `keygen` prints the key ID and the public key and never overwrites a key.
   `sign` takes the report JSON or the whole job log, refuses a failed or
   uncleaned run, signs exactly the fields the gate validates and checks the
   result with the gate's own validator before printing it.
4. **Set three variables** in the `alpha17-live-qualification` environment:
   `ALPHA17_OPERATOR_KEY_ID`, `ALPHA17_OPERATOR_PUBLIC_KEY_BASE64` and
   `ALPHA17_OPERATIONAL_RECORD_BASE64`. None is secret. The record binds the
   candidate archive digest and source commit and is accepted for 72 hours
   from `completedAt`; a new candidate needs a new drill run and a new
   signature.
5. **Dispatch `run_hosted`.** It needs no session material: the job makes its
   own five testers by invitation for the sandbox repository, the first signed
   in with the mutation credential and the rest read-only, after the restore,
   and releases them on every exit -- revoked, and the last one's data deleted,
   which removes every session that still carries the shared GitHub identity.
   The `ALPHA17_SESSION_COOKIES`, `ALPHA17_MUTATION_REQUEST` and
   `ALPHA17_CLEANUP_REQUEST` secrets are no longer read; delete them. Nor is
   a backup key: the restore draws its own for the run and never stores it.

**Where the target variables live.** `authorize-live` binds the hosted target
before any live job starts, and it runs outside the live environment, so it
reads only **repository** variables: `ALPHA17_HOSTED_BASE_URL`,
`ALPHA17_RENDER_SERVICE_ID`, `ALPHA17_NEON_PROJECT_ID`,
`ALPHA17_COHORT_NEON_BRANCH_ID`, `ALPHA17_RESTORE_APP_BASE_URL`,
`ALPHA17_RESTORE_APP_DEPLOY_ID`, `ALPHA17_RESTORE_NEON_PROJECT_ID`,
`ALPHA17_RESTORE_NEON_BRANCH_ID` and `ALPHA17_RESTORE_TARGET_FINGERPRINT`.
Set them there. The live jobs run inside `alpha17-live-qualification`, where a
variable of the same name overrides the repository's; keep no copy there, or
keep it identical. A copy that differs is refused as a target that does not
match its binding, never silently used. A base URL is an origin; one trailing
slash, as a browser copies it, reads as the same origin, and a path is refused.
Every new candidate is a new restore deployment, so
`ALPHA17_RESTORE_APP_DEPLOY_ID` changes with each one.

**What the disconnect drill holds the product to.** After "Disconnect from
Nebulaverse-X", a copy of the old session cookie is answered `401
AUTH_REQUIRED`, the same as no session, and another tester presenting it is
refused `403 ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT`. Neither is a server
fault: a `500` fails the drill.

The drills and the hosted gate read the staging service's `DATABASE_URL` and
`NV_ALPHA_INVITE_PEPPER` from Render with `ALPHA17_RENDER_API_KEY`, so testers
are issued by the deployment under test. `ALPHA17_NEON_API_KEY` suspends and
interrupts only the cohort branch's compute and re-enables it in a `finally`;
the cleanup readback fails the run if it did not.

## What the GitHub run proves

The probe catalog and `src/qualification-evidence.js` define the exact current
claim set. The run creates a disposable branch from the observed default head
and exercises the product's own provider boundary:

- Repository/default-branch reads, branch creation and absence after cleanup.
- Expected-head write and UTF-8 readback; conditional update, stale-head write
  and delete refusal, insufficient-permission denial, and a valid delete.
- Recursive tree listing bound to the written file and provider rate limits.
- Pull-request, issue, release and workflow list/detail agreement with
  nonexistent-identifier discrimination.
- Git object identity and single-commit batch, native push and LFS storage.
- The exposure reader, rename and folder move preserving object identity.
- Issue creation/comment/close; pull-request review, stale-head merge refusal
  and merge against the reported head on disposable branches.
- Prerelease/tag publication and removal, star-state restoration, scoped search
  against its permanent fixture and workflow rerun.

Provider-verified registry labels record claim history. They do not prove that
the current candidate ran these probes. Repository create/delete,
notifications and verified live events remain subject to their own current
maturity and qualification requirements; a standard sandbox run must not claim
unexecuted probes.

### Concurrency proof

`conditional-update` and `stale-head` are two halves of one proof. The same
concurrency token must be accepted while current and refused after a real
write makes it stale. The accepted half is the control: a refusal alone may
only show malformed input or a different request failure. Refusal must come
from the provider with no unintended commit, not only from a client precheck.

### Intentional residue and cleanup

A run can leave a closed issue, a merged pull request and a dispatched workflow
run with two attempts. The merge is between disposable branches; the default
branch is never the mutation target. Both branches must be deleted and read
back as absent. The prerelease and tag are removed and read back; the account's
star is restored to its original state. Record intentional retained objects by
run identity so they cannot be confused with cleanup failures.

Unexpected branch/file/tag residue blocks acceptance. `cleanup-absence` must
prove cleanup, including on failed runs where possible. Before another dispatch,
inspect any residue, confirm ownership and remove only the disposable objects
covered by the run's authorization. Never infer that an old named branch still
exists without a fresh readback.

## If a check fails

Inspect sanitized job logs, the named unmet condition and any available failure
artifact. A failed run is not passing qualification evidence, even if a previous
run was green. Do not retry a mutation blindly: determine whether it executed,
read back its result and reconcile cleanup before a new authorized run.

A failure that does not distinguish transport, assertion and cleanup outcomes
is a diagnostics defect to fix. Compare the provider contract with the actual
request and response behavior, preserve the failed result and requalify the
changed candidate. Do not weaken evidence or permission assertions to obtain a
pass.
