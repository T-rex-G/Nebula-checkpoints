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

## GitHub — complete intended golden path

| Status | Capabilities |
| --- | --- |
| Supported | repository, commit, branch, and GitHub rate-limit reads; controlled branch writes; tree and file read/write/delete/rename; bounded file batch; pull-request and issue read/write; workflow reads; release reads; bounded search; notifications; star read/write; folder move; live events; access-surface analysis; dependency audit; recovery; governance; upload security |
| Experimental | workflow rerun; release write; native push (16 MB on Render Free); Git LFS |
| Unavailable | repository create/delete; global search |

Repository/workbench operations use `Provider-verified` evidence. Access-surface,
dependency-audit, recovery, governance, and upload-security decisions use
`Deterministic` evidence as recorded in the registry.

## GitLab — registry-qualified subset

| Status | Capabilities |
| --- | --- |
| Supported | repository, commit, branch, tree, and file reads; bounded file write/delete; merge-request read; issue read; upload security |
| Experimental | merge-request write; issue write; dependency audit; read-only recovery comparison; governance views |
| Unavailable | repository create/delete; provider rate-limit read; branch write; file rename/batch; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis |

Provider repository operations use `Provider-verified` evidence. Upload security,
dependency audit, recovery, and governance use `Deterministic` evidence.

## Gitea — registry-qualified subset

| Status | Capabilities |
| --- | --- |
| Supported | repository, commit, branch, tree, and file reads; expected-head single-file write/delete; upload security |
| Experimental | dependency audit; read-only recovery comparison; governance views |
| Unavailable | repository create/delete; provider rate-limit read; branch write; file rename/batch; pulls; issues; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis |

Provider repository operations use `Provider-verified` evidence. Upload security,
dependency audit, recovery, and governance use `Deterministic` evidence. Gitea
batch mutation remains unavailable because only single-file Contents API write
and delete received provider qualification.

Unknown providers, deployments, and capabilities default to `Unavailable`.
