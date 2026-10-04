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

Counted from the capability registry: 33 Supported, 4 Experimental, 0 Unavailable. Of those, 26 carry
`Provider-verified` evidence.

| Status | Capabilities |
| --- | --- |
| Supported | repository reads; branch reads and controlled writes; bounded file read/write/delete; file rename; folder move; single-commit batch; native push; Git LFS; provider rate-limit and tree reads; pull-request, issue, workflow and release reads; pull-request and issue writes; release write; workflow rerun; bounded and global search; star read/write; exposure scanning; repository audit; site check; access-surface analysis; dependency audit; recovery; governance; upload security |
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

The repository audit and the site check are `Deterministic` too, and every
rule is fixture-tested firing and staying quiet. The audit reads the branch
through the same Provider-verified reader as exposure scanning -- files are read,
judged and dropped, and findings name a path and a line, never the code -- and
asks the public npm and PyPI registries whether each declared package exists,
reading an unanswered lookup as unknown rather than missing. It asks OSV --
anonymously, through the guarded transport's advisory profile, which can reach
`api.osv.dev` and nothing else -- which installed versions (from the lockfile,
or a declared range's floor, marked as such) have a published or malicious-
package advisory, in npm, PyPI, Go, Maven, Composer, RubyGems, crates.io and
NuGet, reading each ecosystem's manifests and lockfiles and leaving out any
version a file does not write down. The same inventory is exported as a bill
of materials in CycloneDX 1.5 or SPDX 2.3: package URLs, versions, licences,
requirements, and the vulnerabilities found. Each version's licence is read
where its lockfile states one (npm and Composer) and otherwise asked of
deps.dev -- anonymously, through the guarded transport's licence profile,
which is GET only, carries the ecosystem, name and version in its path and
nothing else, and reaches `api.deps.dev` and nothing else -- the project's own
dependencies first, at most 600 versions an audit. Every SPDX expression is
read as a choice (OR asks the least of its options) or a combination (AND asks
the most), and placed in a family: public domain, permissive, weak, strong or
network copyleft, restricted use, no licence, or unknown. The project's own
licence comes from its root manifest or licence file, and a project that
states none is judged as proprietary code. Network copyleft in something that
ships, strong copyleft in a project that is not itself copyleft, a restriction
on use, a direct dependency with no readable licence, and the settled GNU
incompatibilities (Apache-2.0 or GPL-3.0 in a GPL-2.0-only work; the BSD
advertising clause, OpenSSL, EPL-1.0 and CDDL in any GPL work) are findings.
A repository may allow and refuse licences or families and clear packages by
name in `.nebulaverse/licences.json`; a cleared package stays in the report as
waived, with its reason. Licence findings are compliance rather than security:
they form a family weighed at nothing in the grade, never enter Fix first,
claim no CWE, and are exported to SARIF tagged `compliance` without a security
severity. An unanswered lookup is unknown, never permissive. For the CVEs those advisories carry -- and only their
identifiers -- it asks FIRST's EPSS for the probability of exploitation and
CISA's Known Exploited Vulnerabilities catalog whether each is exploited in the
wild, through the guarded transport's threat-intel profile, which is anonymous,
GET only and reaches `api.first.org` and `www.cisa.gov` and nothing else; both
answers are public and cached in the process, and a source that cannot be read
leaves its answers unknown, never negative. Each vulnerable package is then
placed by how close it sits to the code that runs -- imported, named where a
framework loads it by name, bundled or served from node_modules by the build,
brought in by a dependency the code imports (the
lockfile's requirement graph names which), installed with no import found,
build tooling, tests or development only -- and given one risk number from its
CVSS impact, that threat and that reach. No tier says "unused": a production
dependency with no import found is "installed". A vulnerability CISA lists as
exploited, in a package that ships, holds the grade below 50 and leads Fix
first. It reports credentials with the same detectors as exposure
scanning, keeping only the detector's name and the line, and reads Supabase
migrations and Firebase rules for tables and paths anyone can read or write.
Its engine, Uranus, follows values through JavaScript, TypeScript, Python, Go,
Java and PHP -- from a route parameter, a request body, a message or a model's
reply, across helpers and files, to a query, a command, a request, a path,
markup, a deserializer or an XML parser that resolves external entities -- and
maps every endpoint and server action with the guard in front of it: Express,
Fastify, Koa, Hono, NestJS, Next.js, SvelteKit, Remix, Supabase edge functions,
Flask, FastAPI and Django; net/http, Gin, Echo, Fiber, chi and gorilla/mux;
Spring and JAX-RS; Laravel and Symfony. A handler named at its route and
written elsewhere -- a Laravel controller, a Go handler in another package --
is read where it is written, with the middleware its controller applies. A
check before the call that settles a value (a number test, an anchored
pattern, an allow-list, equality with literals, or its negation before an
early exit) quiets the flow inside what it guards, and what was built from the
checked value is settled with it. A finding
is `confirmed` when the file states it or the whole path was traced, and `to
confirm` when one decisive fact is out of reach; a lead names that fact and the
local check that settles it, weighs half, and is exported to SARIF as a note to
review. The grade is held below 50 only while a confirmed critical finding, or
a vulnerability exploited in the wild in a package that ships, is open, and the result carries a coverage ledger -- each class of attack traced,
pattern-checked, absent or not assessed -- so a clean list is never read as a
clean repository. It states how much of the branch, how many packages and how
many versions it checked. The audit runs as a job the page follows by run id,
held in memory only, for the identity that started it, and dropped two minutes
after it finishes. What is kept afterwards, with a database, is a reduction of
it for that identity (`db/migrations/029_code_audit_history.sql`): the grade,
the counts, and each finding's rule, severity, file and line or package,
version, fix, advisory and CVE identifiers and scores -- never a trace, a
prompt, an advisory summary or any text from a file -- the 30 latest audits
of a branch for up to 400 days, removed by the account purge or on request.
The latest audit's package versions are watched: every six hours, or when
asked, OSV is asked again by name and version and CISA's catalog by CVE, through
the same two anonymous profiles, and only an advisory the audit did not
already report under any alias, or a CVE CISA has listed since, is shown as
new; an unanswered question leaves the watch partial, never clear. The analysis runs on a worker thread with a capped heap and
a time limit, so the server keeps answering while it works. A branch too large
for the instance is checked against every rule without tracing, and the ledger
names how many files were left untraced and which limit stopped them. Past the
traced set -- the prioritised files within the audit budget -- every eligible
file, up to 6,000 more, is read a hundred at a time through GitHub's GraphQL
API, by the guarded transport's provider-query profile (POST, to
`api.github.com/graphql` and nothing else, each path a query variable), and
checked against every per-file rule on the analysis worker a batch at a time,
each batch's text dropped before the next is read. Coverage states how many
files were traced and how many were checked against the rules alone.

Any repository the signed-in account can read is opened, audited and scanned
the same way, not only its own: a pasted address or owner/name opens it. Where
the provider reports that the account cannot push, it opens read-only -- every
control that would change it, and everything its collaborators share, is put
away, and the provider refuses them regardless. GitHub answers the
collaborator-permission question only to people who can push; for anyone else
the resolver asks the repository itself, and a public one grants the reader
level everyone has on it, recorded with the source `github.repository.public`
(`gitlab.project.public` for a public GitLab project the account is not a
member of). Only the routes whose data is the reader's own accept it -- their
audits, kept audits and watch, and their exposure scans, all keyed by identity
-- and everything a repository's collaborators share, its governance above
all, refuses it. Checking a credential, probing readability and accepting an
exception stay with administrators, so reading a public repository never
lends anyone else's credentials to a test.

The site check runs for any address, from a repository's Audit tab or on its
own Website page, as a job the page follows by run id and stage, like the
audit. It makes at most sixty anonymous GET requests in forty-five seconds to
the origin a user names -- following up to three HTTPS redirects to the page a
visitor actually lands on -- through the guarded transport's site profile: HTTPS on
443 to a public address, no credential and no cookie, every body cut at a
bound (two megabytes for a script). It reads the certificate's end date,
issuer and the negotiated protocol from the handshake; asks once over plain
HTTP on port 80 -- the only plain request the profile allows, whose answer body
is never read -- whether the site sends visitors on to HTTPS; asks once as
another origin whether the answer is shared with the visitor's cookies; asks
for about twenty files that must never be served (environment, Git and other
version-control files, credential files, diagnostics pages); reads a missing
page for a framework's debug output; follows up to five of the landing page's
own links, never one `robots.txt` closes to crawlers or a sign-out; and reads
the scripts those pages load from the site itself for credentials (named by
kind, never shown; keys that are public by design are not findings), public
source maps and library versions, which OSV is asked about through the
advisory profile. The domain's SPF and DMARC records are read from public DNS
by the transport's bounded TXT lookup, and skipped on a shared platform's
domain, which is not the site's to answer for. A path is reported as served
only when what came back has the shape that file must have, so a single-page
app's catch-all page is not a leaked `.env`; a question that could not be
asked is reported as not checked, never as passed; and a site that cannot be
reached is an error, not a clean report. One check per identity at a time, a
new one at most every fifteen seconds, and any one site at most every thirty
seconds, whoever asks.

## GitLab — registry-qualified subset

Counted from the capability registry: 13 Supported, 3 Experimental, 21 Unavailable. Of those, 11 carry
`Provider-verified` evidence.

| Status | Capabilities |
| --- | --- |
| Supported | repository and branch reads; controlled branch writes; bounded file read/write/delete; recursive tree read; merge-request and issue reads; merge-request and issue writes; site check; upload security |
| Experimental | dependency audit; read-only recovery comparison; governance views |
| Unavailable | repository create/delete; provider rate-limit read; file rename/batch; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis; exposure scanning and repository audit, which have no repository reader for this provider |

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

The site check is `Deterministic` and the same as GitHub's, since it reads the
deployed site rather than the repository; the repository audit is unavailable
until a GitLab reader exists, and the screen says so rather than showing an
empty result.

## Gitea — registry-qualified subset

Counted from the capability registry: 7 Supported, 4 Experimental, 26 Unavailable. Of those, 5 carry
`Provider-verified` evidence.

| Status | Capabilities |
| --- | --- |
| Supported | repository and branch reads; bounded file read/write/delete; site check; upload security |
| Experimental | tree read; dependency audit; read-only recovery comparison; governance views |
| Unavailable | repository create/delete; provider rate-limit read; branch write; file rename/batch; pulls; issues; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis; exposure scanning and repository audit, which have no repository reader for this provider |

Repository read, branch read, and bounded file read/write/delete use
`Provider-verified` evidence. Upload security, dependency audit, recovery, and
governance use `Deterministic` evidence; the latter three remain experimental.
The site check is `Deterministic` and the same as GitHub's, since it reads the
deployed site rather than the repository. Tree read remains `Experimental` +
`Inferred`. Gitea batch mutation remains
unavailable because only single-file Contents API write and delete received
provider qualification.

Unknown providers, deployments, and capabilities default to `Unavailable`.
