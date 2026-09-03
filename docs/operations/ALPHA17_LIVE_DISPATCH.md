# Dispatching the alpha.17 live-provider qualification

The live-provider gate has never been run. This is the procedure for the first
dispatch, written after building the pieces that were missing.

Everything here is operator work. The workflow runs candidate code in a job
that holds live credentials, so the approval is a human act by design and no
part of it is automated away.

## What the gate needs, and what already exists

| Requirement | State |
| --- | --- |
| Disposable target repository, `nvx-alpha17-` prefix | `T-rex-G/nvx-alpha17-github-qualification`, private, `main` at a real commit |
| Actions, pulls, issues and releases reachable on that target | All four answer, and all four carry a permanent fixture — see below |
| Mutation credential permissions | Metadata read, Contents read and write, Actions read, Issues read, Pull requests read |
| Read-only credential permissions | Metadata read, Contents read. **No write of any kind** |
| `ALPHA17_GITHUB_REPOSITORY` variable | Confirm — set to the target's `owner/name` |
| `ALPHA17_GITHUB_MUTATION_CREDENTIAL` secret | Confirm |
| `ALPHA17_GITHUB_READ_ONLY_CREDENTIAL` secret | Confirm |
| `alpha17-live-qualification` environment holding both secrets | Confirm — scopes them to the live jobs; see below on approval |
| Independent review of the exact candidate bytes | Required before dispatch |

The two credentials must reach only the disposable target: no organization
scope, no production repository, disposable after the run. The read-only one
exists to be refused — the `permission-denial` proof depends on it failing to
write.

Granting the read-only credential write access does not break the run in a way
anyone would notice by reading a pass: the write it is supposed to be refused
would succeed, and `permission-denial` would have proved nothing. The gate
catches it — a read-only credential that mutates the branch fails the run with
`ALPHA17_PERMISSION_SCOPE_INVALID` — and that refusal is covered by a test that
was watched to fail before it was trusted. Keep the token read-only anyway; the
guard is the backstop, not the plan.

## The fixtures on the target, and why deleting them is not free

The target carries four permanent objects, each labelled in its own body:

| Fixture | Proves |
| --- | --- |
| Issue, open | `issues.read` detail agreement |
| Pull request, open, from `nvx-alpha17-fixture-pull` | `pulls.read` detail agreement |
| Release, published — not a draft, `GET /releases` does not list drafts | `releases.read` detail agreement |
| One dispatched run of the fixture workflow | `workflows.read` detail agreement |

Each collection probe lists, then fetches every listed object on its own, then
asks for an identifier that cannot exist and requires a refusal. Against an
empty target the middle step never runs: the probe passes on an empty listing
having proved the endpoint answers and discriminates, which is *not* the
capability being claimed. `listed` in the artifact is how you tell the two
apart — run 58 recorded 1, 2, 1 and 1, not 0.

Deleting a fixture used to fail nothing: the probe listed zero objects, never
ran the detail comparison, and passed having proved only that the endpoint
answers. That was written here as a hazard for a human to remember, which is
the wrong place for it — a gate that can enforce a rule should not be asking
someone to hold it in their head. An empty listing now fails the run outright.

So the fixtures are permanent, and the workflow one is
`workflow_dispatch` only — on `push` it would fire on every proof branch the
qualification creates and delete, and the target is meant to be inert between
runs.

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

Pick the branch you want qualified, set `run_github` true, leave the other three
false, and run it. There are no other inputs. Approve the
`alpha17-live-qualification` environment when it asks.

## What the run proves

Seventeen checks on a disposable branch it creates and removes:

- repository and default-branch reads
- disposable branch create, then absence after cleanup
- expected-head write, UTF-8 readback, conditional update, stale-head refusal,
  permission denial, stale-head delete refusal, expected-head delete
- recursive tree listing bound to the file the run wrote
- provider rate-limit ceiling and remaining budget
- pull-request, issue, release and workflow-run list/detail agreement with
  absent-identifier discrimination

The four collection probes record what they actually verified. Run 58 recorded
`listed` of 1 for pull requests, 2 for issues (the fixture issue and the
fixture pull request, because the issues endpoint returns both), 1 for releases
and 1 for workflow runs, each with `detailAgreed` and `absentDiscriminated`
true. A `listed: 0` in a future artifact means a fixture is gone and that
probe has silently fallen back to proving reachability only.

## If it fails

The artifact names the failing check and the run stops before publishing
evidence. Nothing here is retried blind: a probe failure is a finding about
the provider path, not a flake. The disposable branch is removed on the
failure path as well, and `cleanup-absence` reports whether that succeeded.
