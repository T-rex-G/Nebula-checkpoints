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

Counted from the capability registry: 31 Supported, 4 Experimental, 0 Unavailable. Of those, 26 carry
`Provider-verified` evidence.

| Status | Capabilities |
| --- | --- |
| Supported | repository reads; branch reads and controlled writes; bounded file read/write/delete; file rename; folder move; single-commit batch; native push; Git LFS; provider rate-limit and tree reads; pull-request, issue, workflow and release reads; pull-request and issue writes; release write; workflow rerun; bounded and global search; star read/write; exposure scanning; access-surface analysis; dependency audit; recovery; governance; upload security |
| Experimental | repository create/delete; notifications; live events |
| Unavailable | none at the provider level; connection permissions and invitation scopes still apply |

Repository creation/deletion and notifications are usable experimental
operations with deterministic coverage, not live-provider qualification claims,
and each says why: the harness credential is confined to one disposable
repository, so it can neither create nor delete one, and GitHub does not serve
notifications to the fine-grained credential the harness uses. Live events need
a deployment the provider can deliver webhooks to, which the harness does not
have. Creation verifies the personal account identity and reads
the resulting repository back by name and ID. An existing restricted invitation
must already authorize the exact new repository name; creation never expands
its scope. With invitations off, the normal connected account can create in its
personal namespace. Organization creation is not included in this flow.

Deletion requires the full `owner/repository` confirmation, fresh step-up,
administrator access, and provider permission. OAuth/classic connections need
`delete_repo`; ordinary OAuth sign-in still requests only `repo`, so deletion
needs a suitably authorized connection. OAuth users can explicitly choose
**Accounts → Allow repository deletion on GitHub** to request `delete_repo`;
the app never adds it to ordinary sign-in automatically. Existing safeguards
and governance apply.
An installation connection additionally needs Administration write permission
and a fresh administrator permission check for the human who connected it.

Restricted invitations search and fetch notifications through their exact
GitHub repositories, with results checked again before returning them. Search
returns up to 25 matches; notifications return up to 30 recent threads. With
invitations off, search uses GitHub's accessible code index (public and permitted
private repositories), and notifications use the connected user's inbox.
Installation connections cannot create personal repositories. GitHub
installation and fine-grained-token connections cannot read notifications.
`/api/account/capabilities` privately projects these connection restrictions;
the public `/api/capabilities` remains a provider-level description.

Repository read, branch read/write, bounded file read/write/delete, the recursive
tree and provider rate-limit reads, the pull-request, issue, workflow and
release list/detail reads, and the two push capabilities -- Git Data object
upload and single-commit batch -- use `Provider-verified` evidence. The push
pair is proven as one chain: the identity the provider returns for uploaded
bytes must be the hash git itself gives them, and that identity is then spent
in a tree whose commit descends from the head the run read, lands both of its
paths, and refuses a ref move back to its parent. The hosted size ceiling on
native push is a deployment bound, not a capability limit.

The workbench operations are proven through the product's own requests, each
checked against something read independently rather than the provider's
acknowledgement. A rename re-links the blob at its new path in one commit on
the observed head and keeps its object identity; a folder move does the same
for every file under the folder, nested ones included, and leaves nothing at
the source. Both refuse a destination that already holds something rather than
replacing it. An issue is created, commented on and closed, each read back, and
the read-only credential is refused. A pull request is opened between two
disposable branches, reviewed, refused a merge against a head it no longer has
and merged against the head it reported -- the pinned head the product now
sends so a merge confirmed against one set of commits cannot take another. A
prerelease is published with its tag at the branch head and removed with it.
The account's star is set, cleared and left as it was found. The scoped code
query finds the permanent search fixture, only in the target, and a word that
exists nowhere finds nothing; qualifiers that would widen the scope are
refused, which is also what makes the hosted-alpha global search the same
query. A dispatched workflow run is re-run once finished and reported at its
next attempt. Exposure scanning's reader -- the product's own module -- resolves
the ref, lists the tree bound to a file the run wrote, reads that blob back
exactly and walks history to the commit that added it; detection, identity,
storage and verification are deterministic.

Access-surface, dependency-audit, recovery, governance, and upload-security
decisions use `Deterministic` evidence.

## GitLab — registry-qualified subset

Counted from the capability registry: 12 Supported, 3 Experimental, 20 Unavailable. Of those, 11 carry
`Provider-verified` evidence.

| Status | Capabilities |
| --- | --- |
| Supported | repository and branch reads; controlled branch writes; bounded file read/write/delete; recursive tree read; merge-request and issue reads; merge-request and issue writes; upload security |
| Experimental | dependency audit; read-only recovery comparison; governance views |
| Unavailable | repository create/delete; provider rate-limit read; file rename/batch; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis; exposure scanning, which has no repository reader for this provider |

Repository read, branch read/write, bounded file read/write/delete, the recursive
tree read, and the merge-request and issue list/detail reads use
`Provider-verified` evidence. Upload security, dependency audit, recovery, and
governance use `Deterministic` evidence; the latter three remain experimental,
because their provider coverage is genuinely narrower: recovery here compares
and previews but does not restore, and governance shows policy without enforcing
it on provider mutations.

Merge-request and issue writes use `Provider-verified` evidence, through the
product's own GitLab requests: an issue is created, noted and closed by state
event, each read back, and the `read_api` credential is refused; a merge request
between two disposable branches is reviewed by note, refused a merge against a
head it no longer has, and merged against the head it reported, after GitLab
has finished checking that it can be. GitLab has no review object, so a comment
review is a note and an approval is its approval; "request changes" has no
counterpart in its API and is refused by name.

## Gitea — registry-qualified subset

Counted from the capability registry: 6 Supported, 4 Experimental, 25 Unavailable. Of those, 5 carry
`Provider-verified` evidence.

| Status | Capabilities |
| --- | --- |
| Supported | repository and branch reads; bounded file read/write/delete; upload security |
| Experimental | tree read; dependency audit; read-only recovery comparison; governance views |
| Unavailable | repository create/delete; provider rate-limit read; branch write; file rename/batch; pulls; issues; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis; exposure scanning, which has no repository reader for this provider |

Repository read, branch read, and bounded file read/write/delete use
`Provider-verified` evidence. Upload security, dependency audit, recovery, and
governance use `Deterministic` evidence; the latter three remain experimental.
Tree read remains `Experimental` + `Inferred`. Gitea batch mutation remains
unavailable because only single-file Contents API write and delete received
provider qualification.

Unknown providers, deployments, and capabilities default to `Unavailable`.
