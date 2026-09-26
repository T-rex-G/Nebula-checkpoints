# Dispatching the alpha.17 live-provider qualification

Two providers are qualified. Run 65 on 3 September 2026 passed both live legs
on the same candidate: GitHub with seventeen checks and twelve capabilities,
GitLab with fourteen checks and nine. Gitea has never been run and has no
reachable instance.

Everything here is operator work. The workflow runs candidate code in a job
that holds live credentials, so the approval is a human act by design and no
part of it is automated away.

Each provider needs its own target, its own two credentials and its own
fixtures. The sections below are per-provider for that reason: a GitLab target
set up from the GitHub instructions will fail, and it will fail late.

## What the gate needs, and what already exists

Shared by every provider:

| Requirement | State |
| --- | --- |
| `alpha17-live-qualification` environment holding every live secret | Confirm — scopes them to the live jobs; see below on approval |
| Independent review of the exact candidate bytes | Required before dispatch |

### GitHub

| Requirement | State |
| --- | --- |
| Disposable target repository, `nvx-alpha17-` prefix | `T-rex-G/nvx-alpha17-github-qualification`, private, `main` at a real commit |
| Actions, pulls, issues and releases reachable on that target | All four answer, and all four carry a permanent fixture — see below |
| Code search fixture on the default branch | `NVX_SEARCH_FIXTURE.md` containing the word `nvx-alpha17-search-fixture` — see below |
| Mutation credential permissions | Repository: Metadata read, Contents read and write, Actions read and write, Issues read and write, Pull requests read and write. Account: Starring read and write |
| Read-only credential permissions | Metadata read, Contents read. **No write of any kind** |
| `ALPHA17_GITHUB_REPOSITORY` variable | Confirm — set to the target's `owner/name` |
| `ALPHA17_GITHUB_MUTATION_CREDENTIAL` secret | Confirm |
| `ALPHA17_GITHUB_READ_ONLY_CREDENTIAL` secret | Confirm |

The API URL is fixed in the workflow at `https://api.github.com` and is not an
operator setting.

### GitLab

| Requirement | State |
| --- | --- |
| Disposable target project, `nvx-alpha17-` prefix | `T-rex-G/nvx-alpha17-gitlab-qualification`, private, `main` at a real commit |
| Merge requests and issues reachable on that project | Both answer, and both carry a permanent fixture — see below |
| Mutation credential scope | `api` — already covers the issue and merge-request writes the leg now proves |
| Read-only credential scope | `read_api`. **No `api` scope of any kind** |
| `ALPHA17_GITLAB_REPOSITORY` variable | Confirm — set to the project's `namespace/name`, not its numeric id |
| `ALPHA17_GITLAB_MUTATION_CREDENTIAL` secret | Confirm |
| `ALPHA17_GITLAB_READ_ONLY_CREDENTIAL` secret | Confirm |

The API URL is fixed in the workflow at `https://gitlab.com/api/v4`. A
self-managed instance would need that line changed, not a variable set.

GitLab's token scopes are coarse where GitHub's are per-permission: `api` is
read and write across the whole API surface, and there is no way to grant
Contents-write without also granting issues, merge requests and everything
else. That has two consequences worth knowing before you create the token.

Extending the GitLab leg later — releases, pipelines, search — needs no new
credential, because `api` already covers them. And the mutation token is
broader than the GitHub one by construction: what confines it is the project it
can reach, not the operations it can perform. Create it as a **project** access
token on the disposable project, never a personal or group token.

### Gitea

Not run. `ALPHA17_GITEA_REPOSITORY` and `ALPHA17_GITEA_API_URL` exist in the
workflow and there is no instance behind them. Its five `Provider-verified`
registry claims have no run supporting them; see the limitations in
`WORK_CONTINUITY.json`.

### Both credentials, every provider

They must reach only the disposable target: no organization or group scope, no
production repository, disposable after the run. The read-only one exists to be
refused — the `permission-denial` proof depends on it failing to write.

Granting the read-only credential write access does not break the run in a way
anyone would notice by reading a pass: the write it is supposed to be refused
would succeed, and `permission-denial` would have proved nothing. The gate
catches it — a read-only credential that mutates the branch fails the run with
`ALPHA17_PERMISSION_SCOPE_INVALID` — and that refusal is covered by a test that
was watched to fail before it was trusted. Keep the token read-only anyway; the
guard is the backstop, not the plan.

## The fixtures on the targets, and why deleting them is not free

GitHub's target carries four permanent objects, each labelled in its own body:

| Fixture | Proves |
| --- | --- |
| Issue, open | `issues.read` detail agreement |
| Pull request, open, from `nvx-alpha17-fixture-pull` | `pulls.read` detail agreement |
| Release, published — not a draft, `GET /releases` does not list drafts | `releases.read` detail agreement |
| One dispatched run of the fixture workflow | `workflows.read` detail agreement; `workflows.rerun` dispatches the same workflow again and re-runs that new run |
| `NVX_SEARCH_FIXTURE.md` on the default branch, containing `nvx-alpha17-search-fixture` | `search` and `global-search`: GitHub indexes only the default branch, so the probe cannot search for anything the run itself writes |

GitLab's target carries two:

| Fixture | Proves |
| --- | --- |
| Issue, open | `issues.read` detail agreement |
| Merge request, open, from `nvx-alpha17-fixture-merge` into `main` | `pulls.read` detail agreement |

The merge request needs a real difference between the two branches or GitLab
will refuse to open it, so `nvx-alpha17-fixture-merge` carries one committed
file that `main` does not. GitLab also requires a description on some project
configurations and silently keeps the form open without one; give both objects
a body saying what they are for.

Two things GitLab does *not* have, and no fixture can supply: there is no
release or workflow-run probe on its leg, because `releases.read` and
`workflows.read` are `Unavailable` for GitLab in the registry. GitLab's
pipelines are the analogue of GitHub Actions and nothing is wired to them.

One asymmetry in the recorded numbers is worth expecting rather than
investigating. GitHub's issues endpoint returns pull requests as issues, so its
`issues-read` probe records `listed: 2` against one issue and one pull request.
GitLab keeps them separate, so both of its probes record `listed: 1`.

Each collection probe lists, then fetches every listed object on its own, then
asks for an identifier that cannot exist and requires a refusal. Against an
empty target the middle step never runs: the probe passes on an empty listing
having proved the endpoint answers and discriminates, which is *not* the
capability being claimed. `listed` in the artifact is how you tell the two
apart — run 65 recorded 1, 2, 1 and 1 for GitHub and 1 and 1 for GitLab, not 0.

Deleting a fixture used to fail nothing: the probe listed zero objects, never
ran the detail comparison, and passed having proved only that the endpoint
answers. That was written here as a hazard for a human to remember, which is
the wrong place for it — a gate that can enforce a rule should not be asking
someone to hold it in their head. An empty listing now fails the run outright.

So the fixtures are permanent, and GitHub's workflow one is
`workflow_dispatch` only — on `push` it would fire on every proof branch the
qualification creates and deletes, and the targets are meant to be inert
between runs. Keep it short: the re-run probe dispatches it, waits about three
minutes for that run to finish, and fails naming `dispatchedRunCompleted` if it
has not. A run can only be re-run for thirty days, which is why the probe never
re-runs the permanent one.

### What a GitHub run leaves behind, on purpose

GitHub offers no way to delete an issue or a pull request over REST, so each
run leaves one closed issue and one merged pull request, both titled with the
run they came from. The pull request was merged between two disposable branches
cut for it — one from the run's branch, one from the default head — and both are
deleted before the probe reports, with `refsRemoved` recording that they are
gone; the default branch is never touched. The release and its tag are deleted
and read back as absent. The account's star is put back the way it was found.
The dispatched workflow run stays, with two attempts.

GitLab leaves the same two: a closed issue and a merged merge request, both
titled with their run, the merge request's two disposable branches deleted. A
project access token cannot delete an issue; only an owner can. GitLab has no equivalent fixture because it has no workflow
probe, but the same rule applies to its project: if you add CI there, keep it
off `push`.

## The activation envelope

The run mints its own. There is no key to generate, no digest to compute in
advance, and no candidate to freeze: the `automated` job builds the candidate
from the commit you dispatch, then hands its digest, source commit and parent
to the authorize job, which signs an envelope over exactly those facts with a
keypair it generates and discards.

That envelope goes through the same verifier it always did, so every binding
still holds — workflow, repository, dispatch ref, event, source parent and
commit, candidate digest, authorized jobs, and a hash of each target's exact
shape. A target changed mid-run no longer matches, and the run stops.

What a run-minted envelope cannot carry is **who** approved, and on this
repository nothing else carries it either.

Required reviewers are an environment *protection rule*, and GitHub offers
protection rules on a private repository only to paid plans. This repository is
private on a personal free account, which is why the environment page shows no
reviewer to add. The environment is still doing real work — it scopes the two
live credentials so only the jobs that name it can read them, which keeps them
away from the `automated` job and away from anything a pull request can reach —
but it approves nothing.

So the honest statement of what gates a live dispatch today is: **write access
to this private repository, and nothing more.** One person holds it, and that
person is the operator. That is a real reduction from an operator-held signing
key, and it is written here rather than implied, because a gate that is
described as approval and is not one is worse than no gate at all.

Two things restore a genuine second factor, neither of them required to run:
adding a required reviewer once the repository is on a plan that allows it, or
returning to the operator-signed flow below.

An operator who holds a key can return to the stronger flow at any time by
minting the envelope themselves:

```
node scripts/alpha17-authorize.js keygen --out-dir ~/.nvx-alpha17
node scripts/alpha17-authorize.js sign --key ~/.nvx-alpha17/alpha17-authorization-key.pem …
```

The nonce ledger is kept for that reason. Against a run-minted envelope it can
never fire, because each run draws a fresh identifier no earlier run can have
spent.

## Dispatch

Actions → **Nebulaverse-X alpha.17 qualification** → Run workflow.

Pick the branch you want qualified, set `run_github` and `run_gitlab` true,
leave `run_gitea` and `run_hosted` false, and run it. There are no other
inputs. Approve the `alpha17-live-qualification` environment when it asks.

The two provider legs run in parallel against separate targets and produce
separate evidence artifacts. They are independent: one can fail while the other
passes, and run 64 did exactly that. Both artifacts bind to the same
`subjectSha256` and `sourceCommit`, so a GO needs them from the same run.

## What the run proves

Every provider runs the same mutation sequence on a disposable branch it creates
and removes, then whatever probes its own contract adds. GitHub records
twenty-nine checks for twenty-six capabilities, GitLab sixteen for eleven.
Run 65's seventeen GitHub and fourteen GitLab checks predate the write probes
below.

Shared by both:

- repository and default-branch reads
- disposable branch create, then absence after cleanup
- expected-head write and UTF-8 readback
- conditional update, stale-head refusal, permission denial, stale-head delete
  refusal, expected-head delete
- recursive tree listing bound to the file the run wrote

GitHub only:

- provider rate-limit ceiling and remaining budget
- release and workflow-run list/detail agreement
- the push chain (object identity, single-commit batch) and the LFS store
- the capability probes, each through the product's own requests: the
  exposure reader against the run's branch; a rename and a folder move that
  keep object identity on the observed head; an issue created, commented on,
  closed and refused to the read-only credential; a pull request reviewed,
  refused a merge against a stale head and merged against the reported one; a
  prerelease and its tag published and removed; the account's star set and
  restored; the scoped code search against its fixture; a workflow re-run

Both, over their own objects:

- pull-request (merge-request) and issue list/detail agreement with
  absent-identifier discrimination
- an issue created, commented on (a note on GitLab) and closed, each read back,
  and refused to the read-only credential
- a pull request (merge request) between two disposable branches, reviewed,
  refused a merge against a stale head and merged against the reported one;
  both branches are deleted and read back as gone. On GitLab the probe waits
  for the mergeability check to finish first, so the project must not require a
  pipeline to merge

### The concurrency proof, and why it is two checks

`conditional-update` and `stale-head` are one proof in two halves, and reading
either alone will mislead you. The run holds the concurrency token for the
file it wrote — the blob sha on GitHub, the last-touching commit on GitLab —
and sends the same token twice: once while it is current, which the provider
must accept, and once after a write has landed under it, which the provider
must refuse. The accepted half is the control. A refusal on its own proves only
that the provider disliked something about the request.

This is the third shape this proof has had, and the first two both passed
while proving less than they claimed. It refused the write in the client
before the provider was called. Then it sent a synthetic token, which GitHub
refused and GitLab accepted — runs 63 and 64 died there, because GitLab's
conflict check resolves the file's last commit at both refs and reads "no
commit there" as no information rather than as a conflict, so a token from
before the file existed is not stale to it. Do not simplify this back into one
call.

### Reading the collection probes

Each records what it actually verified. Run 65 recorded, for GitHub, `listed`
of 1 for pull requests, 2 for issues, 1 for releases and 1 for workflow runs;
for GitLab, 1 for merge requests and 1 for issues. Every one carried
`detailAgreed` and `absentDiscriminated` true.

A `listed: 0` cannot reach an artifact any more — an empty listing fails the
run outright — but a listing that dropped from 2 to 1 would still pass while
proving less. The counts above are what to compare against.

## If it fails

No artifact is published on a failure, so the job log is what you have. The
failure line carries the error code, the unmet conditions by name, and — for
the checks that build one — the check object as JSON on the next line. Runs 63
and 64 both failed with only `stale-head attempt changed the branch or file`,
which covered a provider that accepted the write, a read that lagged behind one
that refused it, and a file whose identity moved. Two runs went by without
telling those apart. If you get a failure that names no condition, that is a
defect in the proof, not a hard diagnosis.

Nothing here is retried blind: a probe failure is a finding about the provider
path, not a flake. The method that has found every defect so far is to read the
provider's published specification — and, where the docs are silent, its source
— before changing client code. GitLab's docs do not say what a mismatched
`last_commit_id` returns; its `Files::BaseService` does, and it was not what
the client assumed.

The disposable branch is removed on the failure path as well, and
`cleanup-absence` reports whether that succeeded, with `reasonCode` naming what
refused if it did not. A run that leaves a branch behind needs it deleted by
hand before the next dispatch — `nvx-alpha17-33658675617-proof` from run 57 is
still on the GitHub target and still needs removing.
