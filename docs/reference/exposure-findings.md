# Exposure findings

What a finding says, what each word in it is allowed to mean, and what it
deliberately does not claim.

This is the reference for reading a finding. The implementation lives in
`src/exposure-detection.js`, `src/exposure-findings.js`,
`src/credential-verification.js`, `src/anonymous-readability-probe.js` and
`src/exposure-narration.js`; the wording a reader sees comes from the last of
those and is a lookup table, so the sentences in this document are the
sentences the product says.

## What can be scanned today

Exposure reads files from one selected GitHub branch at an immutable commit,
looking for supported credential patterns. It does not execute repository code,
audit all application vulnerabilities, or scan a hosted application by URL.
Hosted URL scanning is not implemented; it is a separate capability, not an
alternative input to **Scan this branch**.

The page tracks a requested scan through queued, running and finished states,
then reloads its findings. A failed status check can be retried without starting
another scan. Leaving the Exposure tab stops polling; returning resumes a scan
still held in the current session. Reloading the whole page does not restore that
scan's progress, although retained findings can still be loaded.

GitHub reads use a fixed User-Agent and resolve a branch with the SHA-only media
type. The outbound transport supports Node 22's `lookup({ all: true })` callback
while preserving DNS pinning and TLS hostname checks. Tree reads are bounded at
8 MiB and blob responses at 1 MiB; credential verification and webhook response
limits remain 256 KiB.

## The shape of a finding

| Field | What it is |
| --- | --- |
| `fingerprint` | A keyed identifier for this credential in this repository at this path. It is for matching one scan against the next, not for reading. |
| `rule` | Which detection rule matched. |
| `path` | The exact Git path, unfolded: `README` and `readme` are two paths, and a composed accent is a different path from a decomposed one. |
| `placeholder` | A generated label such as `<github-token #1>`. It is **not** a redacted credential and carries no part of one. |
| `occurrences` | Up to twenty bounded `{ line, column }` locations. |
| `occurrenceCount` | How many times the credential appears, which may exceed the number of locations recorded. |
| `disposition` | `open`, `credential-rejected`, `accepted-risk` or `removed-from-tree`. |

What is **not** in a finding, anywhere, at any point: the credential, any part
of the credential, the line it was found on, any other content of the file, or
any response a provider returned.

## What identity means

Two sightings are the same finding when the scope, the exact path, the rule and
the credential bytes are the same. A line number is a location, not an
identity — adding an import above a credential moves it without making it a new
finding.

Identity also depends on four version numbers: the fingerprint key, the rule
set, the detection engine and the scan configuration. When any of them changes,
every fingerprint changes at once. That is why a comparison across a version
change is **refused** rather than performed: a diff would otherwise show every
previous finding as resolved and every current one as new, which reads as
"everything was fixed" and means nothing happened.

## Coverage, and why `partial` is not a detail

A scan reports `complete` coverage only when it read everything it was given.
Any of the following makes it `partial`, with the reason recorded:

- a file, byte or wall-clock ceiling was reached
- the provider's tree listing was truncated
- a file was skipped: a symlink, a submodule, a binary, an LFS pointer, an
  oversized blob, an unsafe path, or one the provider would not return

**Partial coverage is not an all-clear with an asterisk.** It means there are
places a credential could be that this scan did not look at. A scan that
stopped at a ceiling and reported success would tell somebody their repository
is clean because the scan gave up, which is the worst thing this feature could
do.

## Liveness is not severity

Severity comes from the credential class: a private key in a repository is
serious whether or not anybody has tried it. Liveness is a separate question,
answered only by asking the provider that issued the credential, and only under
a signed authorization naming that exact candidate.

The answer is three-state, and the third state is the important one.

| State | What it means |
| --- | --- |
| `verified` | The provider identified the account this credential belongs to. It is live. |
| `rejected` | The provider refused it. This is the **only** outcome that means the exposure is over. |
| `unverifiable` | We could not tell. |

`unverifiable` covers being rate-limited, a policy restriction, an unsupported
token class, an incomplete credential, a malformed answer, a timeout, and a
Slack `invalid_auth` — which Slack returns both for a revoked token and for a
live token used from a restricted address. None of these may be read as safety:
"we could not tell" and "it is harmless" are different sentences and only one
of them is true.

An observation is good for a day. Past that it is stale, and a stale `verified`
record is still a record of a credential seen live — staleness never becomes a
verdict, because a finding that resolved itself by waiting would be worse than
no finding.

## Anonymous readability

Where a finding is a project URL and a public key, the question is whether a
stranger can actually read the data. That is settled by asking, under a grant
naming the exact project, table and columns, with the anonymous role, for one
row, never `select=*`, and never following a page. The result is a count and no
values.

| Outcome | What it proves |
| --- | --- |
| A row came back | That projection of that table was readable anonymously at that moment. Nothing about other columns or other tables. |
| No rows came back | Nothing. An empty table, a filter that matched nothing and a policy that hides every row are indistinguishable from outside. |
| The request was refused | That this request was refused. Not that the table is protected, and not that row-level security is switched on. |

A service-role key, a secret key or a user session is never used for this. A
stronger key bypasses the policies the question is about, so a row would come
back whatever the configuration is — proving nothing, with an administrator
credential.

## Dispositions

| Disposition | What it means |
| --- | --- |
| `open` | The credential is in the tree and nothing has established that it stopped working. |
| `credential-rejected` | The issuing provider refused it. The exposure is over for this credential. |
| `accepted-risk` | A person reviewed it and accepted the risk. It records who. |
| `removed-from-tree` | A complete scan of the same branch no longer finds it. |

`removed-from-tree` is the one to read carefully. A credential absent from HEAD
**is still in the repository's history** and still reachable by anyone with a
clone. It needs revoking unless it has already been revoked. Nothing in this
product reports that state as resolved, and a credential that reappears in the
tree returns to `open`, because the removal claim was simply wrong.

A conclusion of `removed-from-tree` is only drawn when the scan completed, read
everything, compared against a recorded predecessor on the same ref, and ran
under identical versions. A canceled, failed, truncated or incompatible scan
cannot mark anything as gone.

## Review corrections and authorization

Passive scans remain available to repository readers. Sending a discovered
credential to its issuer, or probing a project's anonymous readability, requires
a governance administrator and explicit confirmation that the operator owns the
credential/project or has permission to test it. The warning explains the request
and retained result before confirmation.

Findings retain the exact Git path and immutable commit used to read them.
Migration 025 separates finding identities and backfills provenance only from
that identity's own observations. It does not copy another identity's risk
decisions. A legacy finding without surviving provenance requires a new scan
before verification.

The 500-finding ceiling applies to the entire scan. Reaching it reports partial
coverage. Workers recheck the claim and current session authorization around
provider reads and writes. A changed fingerprint key, rules, engine or configuration
refuses queued work rather than running it with a different identity scheme.
Source text, credentials, provider response bodies and returned data rows are
never persisted by these operations.
