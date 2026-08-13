# Provider Capabilities

This is the human-readable interpretation of the validated server-owned
`config/public-alpha-capabilities.json` registry for deployment
`hosted-alpha`, release `5.3.0-alpha.17.0`.

These are candidate declarations, not completed hosted-public-alpha
qualification. A `Supported` claim remains release-blocked until the exact
candidate has applicable live-provider and hosted evidence. The server is
authoritative and rejects an `Unavailable` operation before provider transport.

See the generated [project state](PROJECT_STATE.md) for the current candidate
boundary and [release gates](../release/RELEASE_SECURITY_GATES.md) for the
evidence still required.

Current-state terms are intentionally distinct: **implemented** means code is
present; **candidate-qualified** means a bounded checkpoint passed its own
gates; **alpha-supported** means a `Supported` capability whose exact hosted
release gates have passed; **experimental** means safe but limitation-labelled;
**planned** means not yet implemented; and **unsupported** is represented by the
registry status `Unavailable`.

## Vocabulary

| Status | Meaning |
| --- | --- |
| `Supported` | Intended alpha-supported surface after exact-candidate release gates pass. |
| `Experimental` | Safe to try outside the golden path with the recorded limitation. |
| `Unavailable` | Hidden or disabled for this provider/deployment with a reason. |

| Evidence state | Meaning |
| --- | --- |
| `Provider-verified` | Based on applicable live-provider evidence at the registry input boundary. |
| `Deterministic` | Derived by a tested deterministic rule from available evidence. |
| `Inferred` | Explicitly uncertain because evidence is incomplete. |
| `Stale` | Outside its freshness boundary. |
| `Unavailable` | Required evidence is absent or unsupported. |

`Supported` is not a synonym for `Provider-verified`.

Every `Experimental` path requires an explicit UI and server-route opt-in.
Provider-specific `Unavailable` entries still fail closed. GitLab and Gitea
recovery opt-ins are limited to read-only comparison/preview routes, and their
governance opt-ins are limited to view routes; recovery and governance
mutations remain blocked.

## GitHub — evidence-bounded alpha subset

| Status | Capabilities |
| --- | --- |
| Supported | repository reads; branch reads and controlled writes; bounded file read/write/delete; access-surface analysis; dependency audit; recovery; governance; upload security |
| Experimental | provider rate-limit and tree reads; file rename/batch; pull-request and issue read/write; workflow read/rerun; release read/write; bounded search; star read/write; native push (16 MB on Render Free); Git LFS; folder move; live events |
| Unavailable | repository create/delete; global search; notifications |

Only repository read, branch read/write, and bounded file read/write/delete use
`Provider-verified` evidence. Access-surface, dependency-audit, recovery,
governance, and upload-security decisions use `Deterministic` evidence. Other
implemented workbench operations remain `Experimental` + `Inferred` until a
live harness exercises their exact proof contract.

## GitLab — registry-qualified subset

| Status | Capabilities |
| --- | --- |
| Supported | repository and branch reads; bounded file read/write/delete; upload security |
| Experimental | tree read; merge-request and issue read/write; dependency audit; read-only recovery comparison; governance views |
| Unavailable | repository create/delete; provider rate-limit read; branch write; file rename/batch; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis |

Only repository read, branch read, and bounded file read/write/delete use
`Provider-verified` evidence. Upload security, dependency audit, recovery, and
governance use `Deterministic` evidence; the latter three remain experimental.
Tree, merge-request, and issue paths remain `Experimental` + `Inferred`.

## Gitea — registry-qualified subset

| Status | Capabilities |
| --- | --- |
| Supported | repository and branch reads; bounded file read/write/delete; upload security |
| Experimental | tree read; dependency audit; read-only recovery comparison; governance views |
| Unavailable | repository create/delete; provider rate-limit read; branch write; file rename/batch; pulls; issues; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis |

Only repository read, branch read, and bounded file read/write/delete use
`Provider-verified` evidence. Upload security, dependency audit, recovery, and
governance use `Deterministic` evidence; the latter three remain experimental.
Tree read remains `Experimental` + `Inferred`. Gitea batch mutation remains
unavailable because only single-file Contents API write and delete received
provider qualification.

Unknown providers, deployments, and capabilities default to `Unavailable`.
