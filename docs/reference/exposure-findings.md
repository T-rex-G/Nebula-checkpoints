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
another scan. Leaving the Exposure tab stops polling; returning resumes it.
Reloading the page restores the newest scan from the history, including one
still running, so the proof card always describes a real scan rather than
inviting a new one as though none had run.

## What is detected

A scan runs the release gate's seven rules and the scan's own catalogue of
sixty-eight more, plus two rules that recognise a file by its name. The
catalogue covers cloud and infrastructure (AWS secret keys, Google, Azure
storage, DigitalOcean, Cloudflare, Vault, Terraform Cloud, Doppler, Pulumi,
Render, Neon, Fly.io, Netlify, PlanetScale, Databricks), packages and CI (npm,
PyPI, Docker Hub, CircleCI, Buildkite, JFrog, Atlassian, Linear, Postman, Figma,
Sentry, Grafana, New Relic, Dynatrace), AI providers (OpenAI, Anthropic, Hugging
Face, Replicate, Groq, Perplexity), payments (Stripe live and test keys and
webhook secrets, Square, Shopify, Braintree, Flutterwave, EasyPost), messaging
and webhooks (SendGrid, Mailgun, Mailchimp, Resend, Twilio, Slack, Discord and
Teams webhook URLs, Telegram bots, Firebase messaging, X, Mapbox), content
platforms (Notion, Airtable, HubSpot, Contentful), keys (age, PGP, DSA,
encrypted PKCS#8, PuTTY), database connection strings with a password, and
Supabase anonymous and service-role keys. The complete list is
`src/exposure-rules.js`, and every rule has an entry in the narration table.

Each rule is chosen for precision, because a findings list that is mostly
documentation placeholders is a list people stop reading:

- **A distinctive shape.** Almost every rule anchors on a prefix its issuer
  chose so tokens could be recognised, bounded on both sides so a match inside a
  longer identifier is not reported.
- **A plausibility check.** A match that reads as a placeholder
  (a key prefix followed by a run of x's, `YOUR_API_KEY`, `${SECRET}`) or whose characters are too
  uniform to be random (under three bits of entropy per character) is not
  reported. Connection strings with a placeholder password are not reported.
- **Keywords.** Each rule names substrings every match must contain, and a file
  containing none of them is never searched with that rule. A test runs the
  whole fixture corpus with this pre-filter on and off and requires identical
  results.

What is deliberately not detected: generic `password = ...` assignments, bare
hexadecimal strings, and anything that needs surrounding code to mean
something. Those are where secret scanners earn their reputation for noise.

A committed keystore (`.p12`, `.pfx`, `.jks`, `.keystore`, `.bks`) or password
database (`.kdbx`, `.kdb`) is reported from its name alone. It is never
fetched; its identity is the blob, so the same file committed again is the same
finding and a replaced one is a new one.

## How a scan reads

A scan opens one connection pool for its duration, pinned to validated
addresses, and reads up to six files at a time; results are consumed in tree
order, so the same inputs make the same decisions whatever order answers arrive
in. Every ceiling is decided when a read is started -- the byte ceiling at the
size the tree declares -- so it falls on the same file at any concurrency.
Images, fonts, archives, media, compiled objects and credential containers are
recognised by extension and never fetched; they are counted, and they still
make coverage partial, because they are places a scan did not look.

The scan's claim and the requesting session are rechecked before the tree is
read, every twenty-five reads or five seconds (whichever comes first), before
every write, and before the scan is finished. A cancellation or a revoked
session stops the scan within that bound, and no read is started after one has
been noticed. A requested scan starts immediately rather than at the worker's
next poll, and a queue of scans drains one after another.

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
coverage. Workers recheck the claim and current session authorization on the
schedule described under *How a scan reads*. A changed fingerprint key, rules, engine or configuration
refuses queued work rather than running it with a different identity scheme.
Source text, credentials, provider response bodies and returned data rows are
never persisted by these operations.

## History and reports

Every scan of a repository is kept, newest first and grouped by day, until its
retention date. Each entry says when it ran, how it ended, which branch and
commit it read, and how many findings of each severity it recorded -- readable
without opening it. Opening an entry shows that scan's report: what it read in
numbers (text files read, binary files not scanned, others not read, and any a
ceiling stopped before, which add up to the tree), and each finding it observed
with the locations it saw.

A report is a record. Acting on a finding -- checking it, accepting it, asking
a project -- happens on the current findings list, where the disposition and the
latest answers are.

Findings on the current list are summaries a reader scans down: severity as a
word, the credential's kind, the file and line, and what has been decided.
Opening one shows the explanation and the controls. A file named with a
credential is described in the summary rather than printed.

## Clearing

**Clear history** deletes every scan, finding, verification and readability
result recorded for the repository under the reader's own account. It takes two
presses, the first saying exactly what will go, and it is refused while a scan
is queued or running. Another person's record for the same repository is
untouched, and the governance ledger keeps its entry for the clear itself, so
clearing the evidence of a decision never clears the evidence of the clear. The
credentials stay in the repository; clearing a record changes nothing about
them.
