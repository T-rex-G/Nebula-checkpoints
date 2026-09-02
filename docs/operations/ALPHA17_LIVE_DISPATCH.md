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
| Actions, pulls, issues and releases reachable on that target | All four answer; all empty |
| `ALPHA17_GITHUB_REPOSITORY` variable | Confirm — set to the target's `owner/name` |
| `ALPHA17_GITHUB_MUTATION_CREDENTIAL` secret | Confirm |
| `ALPHA17_GITHUB_READ_ONLY_CREDENTIAL` secret | Confirm |
| `alpha17-live-qualification` environment with a required reviewer | Confirm |
| Independent review of the exact candidate bytes | Required before dispatch |

The two credentials must reach only the disposable target: no organization
scope, no production repository, disposable after the run. The read-only one
exists to be refused — the `permission-denial` proof depends on it failing to
write.

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

What a run-minted envelope cannot carry is **who** approved. On this path the
human approval is the environment's required reviewer and nothing else. That is
a real reduction from an operator-held key, stated here rather than implied: it
costs a second factor that matters when several people can dispatch, and this
alpha has one operator.

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

Sixteen checks on a disposable branch it creates and removes:

- repository and default-branch reads
- disposable branch create, then absence after cleanup
- expected-head write, UTF-8 readback, stale-head refusal, permission denial,
  stale-head delete refusal, expected-head delete
- recursive tree listing bound to the file the run wrote
- provider rate-limit ceiling and remaining budget
- pull-request, issue, release and workflow-run list/detail agreement with
  absent-identifier discrimination

The four collection probes will record `listed: 0` against the empty target.
That is the honest number: the pair answered, agreed and discriminated, and no
object was there to verify. Seeding the target with one open pull request, one
issue and one release strengthens the same proof without changing it.

## If it fails

The artifact names the failing check and the run stops before publishing
evidence. Nothing here is retried blind: a probe failure is a finding about
the provider path, not a flake. The disposable branch is removed on the
failure path as well, and `cleanup-absence` reports whether that succeeded.
