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
| Disposable GitHub target | Pre-created `owner/nvx-alpha17-…` repository, private, with a real default-branch commit |
| API authority | `https://api.github.com`, fixed by the workflow |
| Mutation credential | Repository Metadata read; Contents, Actions, Issues and Pull requests read/write; account Starring read/write |
| Read-only credential | Metadata read and Contents read, with no write permission |
| Repository variable | `ALPHA17_GITHUB_REPOSITORY`, the exact `owner/name` |
| Live secrets | `ALPHA17_GITHUB_MUTATION_CREDENTIAL` and `ALPHA17_GITHUB_READ_ONLY_CREDENTIAL` |

Both credentials must be disposable and scoped to the dedicated sandbox, not a
production repository or a broad organization. The read-only credential exists
to prove `permission-denial`. If it can mutate the branch, the run must fail
with `ALPHA17_PERMISSION_SCOPE_INVALID`; granting it write permission cannot
be treated as a passing denial test.

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

The workflow exposes only `run_github` and `run_hosted`. A retired provider must
not be reintroduced through an old input, target map or artifact. Independent
hosted and manual evidence must bind the same candidate before a final GO.

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
