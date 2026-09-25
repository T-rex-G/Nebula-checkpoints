# Changelog

## Unreleased

### Neural: A Graph You Can Read, and Cards Where You Click

The graph was glowing spheres on a starfield with letters for icons, labels
only on hover, and details in a panel that on most screens sat below the
graph, out of sight of the node that was pressed.

- **Panels around a hub.** The repository is a hub carrying the product mark;
  every group is a panel with its icon, name and count, one row per member,
  critical first. Two columns either side of the hub on a wide stage, groups
  keeping their side by meaning; one column beside a spine on a phone. A
  panel shows six rows and folds the rest behind `+ n more`.
- **Strands in the group's colour.** Each row is joined to the hub by a
  glowing strand in its group's colour; a critical node's strand turns red and
  carries a signal. Severity is also a ring colour and a rim badge on the row.
  Every change of mode, filter or search moves the graph smoothly instead of
  redrawing it.
- **Cards where you click.** Pressing a row opens its card beside the panel,
  joined to the row by a line, with its facts, connections (each one a button
  that moves there) and actions. On a phone it is a sheet. The rest of the
  graph dims to the node's neighbourhood and its links animate toward it.
  Pressing a panel's header lights and frames the group. Dragging always moves
  the stage; rows never leave their panels.
- **Groups on screen, organised.** The side panel lists the groups under
  Access, Code, Delivery, Supply chain and Protection, each with its icon,
  critical and warning counts and count; pressing one lights and frames it,
  its eye hides it from the graph (remembered in this browser), and **Open
  all**, **Fold all** and **Show all** manage every group at once. Zoom
  buttons join the tools.
- **Large repositories.** An opened group pages ten rows at a time
  (`‹ 11–20 of 60 ›`, or Page Up and Page Down), and selecting a node on
  another page turns to it. Where the repository has more than the graph
  holds, the panel says `60/312`; the branches kept are the default, working
  and protected ones first. Fits stop at a readable zoom, and a minimap shows
  the whole graph and moves the stage when pressed.
- **Lighter to run.** The graph is drawn only when it changes; a separate
  effects layer animates the signals at half rate once it rests, and nothing
  is drawn while paused, hidden or scrolled away. At rest it uses about a
  quarter of the CPU it did. The dark ground is a deeper navy with faint
  clouds and a vignette, painted once in CSS.
- **Keyboard.** Arrow keys walk the graph, Enter opens the card, Escape closes
  it, and every move is announced.

### Governance: Switch Off, Archive, Restore, Reset

A policy could be created, reviewed, activated and rolled back, and nothing
else: there was no way to switch one off, set one aside, throw away a draft,
take back a version, or clear a repository and start again. Now there is, and
the history stays append-only through all of it.

- **Switch off** stops a policy being enforced at once; **Turn v*n* back on**
  returns the version that was running, through the rollback workflow with a
  fresh simulation.
- **Archive** takes a policy out of the Digital Twin (switching it off first if
  it is running) and frees its key; **Archived policies** lists them and
  **Restore** brings one back, switched off.
- **Discard** a draft and **Withdraw** a version that never ran; authors for
  their own, administrators for anybody's.
- **Reset governance** switches off and archives every policy in one
  transaction, after step-up re-authentication and the repository name typed.
  The ledger, exports, webhooks and notification settings are kept, and every
  policy can be restored.
- Five new ledger events (`policy.deactivated`, `policy.archived`,
  `policy.restored`, `draft.discarded`, `version.withdrawn`) reach
  notifications and webhooks. Control catalog **1.5.0** maps the six new
  actions; 1.4.0 is unchanged.
- Migration **028** admits `deactivate` in the activation history, makes policy
  keys unique among live policies only, adds the append-only
  `nv_governance_version_withdrawals` table, and widens the event-type limits.
  `npm run test:governance-lifecycle` exercises all of it against PostgreSQL.
- Reference: `docs/reference/governance-lifecycle.md`.

### Security Surfaces Grouped Together

Neural, Governance, Exposure and Safeguards now sit together under
**Security** in the phone menu and the sidebar, in the same order in both.
Safeguards had been nine rows away from the other three, between "Delete
repository" and Settings. The phone menu is grouped into Repository, Security
and Workspace, and Safeguards has its own lock icon instead of Governance's
shield.

### Exposure: History, Encoded Credentials, Archives, and Many More Checks

A credential deleted in the commit after the one that added it is still in the
repository -- anyone with a clone can read it -- and Exposure could not see
that. It now can, alongside the kinds of hiding places a real scanner has to
look in.

- **History.** With **Include every commit** on (the default), a scan reads
  the current files and then every commit's changes, oldest first, up to 1,000
  commits. Only the lines a commit added are reported, so a credential is found
  once, at the commit that introduced it. A finding only in history is tagged
  and explained: which commit, when, and that deleting it did not help. The
  next history scan of the same branch starts where the last complete one
  stopped. Commit ceilings and provider throttling are partial coverage that
  names itself.
- **Encoded credentials.** Base64 runs are decoded and scanned (Kubernetes
  secrets, Docker configs, kubeconfig keys), one level deep and bounded; UTF-16
  files are read as text instead of being skipped as binary.
- **Archives.** `.zip`, `.jar`, `.war`, `.whl`, Office documents, `.tar`,
  `.tgz` and `.gz` are opened in memory and their files scanned as
  `archive!/member`, with per-member and per-archive inflation ceilings that a
  zip bomb cannot talk its way past.
- **Detectors: 68 -> 99.** Supabase management tokens, Azure Entra secrets,
  Heroku, Tailscale, 1Password, Datadog, package registries (RubyGems, NuGet,
  crates.io, Clojars, `.npmrc`), xAI, OpenRouter, Pinecone, LangSmith, Plaid,
  Discord bots, Docker config `auth` and more. Rules version 4.
- **Verifiers: 3 -> 43.** "Check whether it still works" now answers for
  OpenAI, Anthropic, Stripe, Google, SendGrid, npm, Notion, Heroku, the
  Supabase management token and 30 more, each through one read-only endpoint
  with the credential in a header, and regional or sandbox-ambiguous refusals
  reported as ambiguous rather than rejected.
- **No duplicates after an upgrade.** The findings list shows the generation
  of the newest finished scan, so findings are not listed twice once a scan
  runs under the new rules.
- Migration **027** adds the scan mode, commit and archive counts, and each
  observation's place (in the tree or only in history), introducing commit and
  decoding. It must be applied before this release is deployed.

### Exposure: File Names, Line Numbers and a Cleaner Findings Header

- **Findings name their file again.** A path was withheld whenever its file
  name held twenty letters, digits, hyphens or underscores in a row -- which is
  most test files and workflows (`anonymous-readability-probe.test.js`,
  `public-alpha-alpha17.yml`), so findings read "a file whose name is not
  shown". A path is now withheld only where a part of it is credential-shaped
  by the detection rules or by a token-shape test, and only that part:
  `secrets/‹hidden›.txt`.
- **The list says which line.** Lines live on each scan's observation, and only
  a scan's report carried them. The findings list now carries the lines from
  the newest scan that saw each finding (`latestLocations`), scoped to the
  reader's own scans.
- **Paths wrap instead of being cut.** On a phone the badge and status share
  the top row and the title and `path:line` take the full width.
- **Findings header.** A count beside the title, severity chips instead of a
  wrapping sentence (the sentence stays for screen readers), and a lighter
  Expand all control.
- **Sidebar.** Overview has a subtitle, "Workspace pulse", like every other
  entry, so the four line up.

### Exposure: Faster Scans, Broader Detection, History and a Clear Button

Exposure worked, but it was slow, recognised seven kinds of credential, forgot
every scan the moment the page reloaded, and had no way to read a report
except as a wall of text. This round addresses all four.

**Speed.** Measured on the scan loop alone with a fixed 100 ms per read, 200
files went from 23.1 s to 3.5 s, and the authorization checks from 402 to 9.
That excludes the two changes below that save most on a real network.

- **The access check was most of what a scan did.** The worker renewed its
  lease and fully re-resolved the requesting session -- several database
  queries and an unseal -- before *and* after every file. It is now due every
  25 reads or 5 seconds, whichever is first, and unconditionally before every
  write and before finishing. No read is started after a revocation is noticed,
  and nothing read under a revoked session is ever written.
- **Every file paid a DNS lookup and a TLS handshake.** The transport refused
  connection pools, because a pooled socket could be one opened to a different
  address for the same name. A scan now opens one keep-alive pool per
  *validated address* (`createGuardedSession`), so that property holds by
  construction; the transport also refuses any pool it did not mint, or one
  minted for another name or address. Provider reads only -- signed webhooks
  and credential probes keep one connection per request.
- **Reads overlap**, up to six at once, and are consumed in tree order, so the
  same inputs make the same decisions however the network orders its answers.
  Every ceiling is decided when a read starts -- the byte ceiling at the size
  the tree declares -- so it falls on the same file at every concurrency, and a
  test holds it there.
- **Binaries are recognised by name and never fetched.** Every image, font and
  archive used to cost a request only to be refused once its bytes arrived.
  Only formats that cannot be UTF-8 text are skipped this way; SVG, `.bin` and
  `.dat` are still read. Skipped files still make coverage partial.
- **A requested scan starts immediately** instead of waiting up to fifteen
  seconds for the next poll, and a queue of scans drains back to back.
- **Line numbers are computed once per file** rather than by walking from the
  top of the file for every match.

**A deliberate trade-off to review.** The review round's guarantee was that a
revocation *during* a read stops the scan before a second read -- which holds
only if reads are strictly sequential with a check between each, the very
pattern that made scans slow. The default is now the bounded guarantee above:
reads already in flight (at most five) may complete, but none is started after
the revocation is noticed and none of their results is written. The strict
guarantee is kept as a tested configuration (`readConcurrency: 1,
renewEveryFiles: 1`) and the default's bounded guarantee has its own test.

**Breadth.** 68 scan-only rules beside the release gate's seven, plus two that
recognise a file by its name -- cloud and infrastructure, CI and package
registries, AI providers, payments, messaging and webhook URLs, content
platforms, private-key formats the gate does not cover, and database
connection strings. Each is built for precision, because a findings list that
is mostly documentation placeholders is a list people stop reading:

- **A distinctive, bounded shape** -- almost every rule anchors on a prefix its
  issuer chose so tokens could be recognised.
- **A plausibility check** refuses placeholders (a key prefix followed by a run of x's, `YOUR_API_KEY`,
  `${SECRET}`) and anything under three bits of entropy per character;
  connection strings with a placeholder password are not reported.
- **Keywords** skip a rule entirely on a file that cannot contain it, which is
  what keeps seventy rules as cheap as seven. A test runs the whole corpus with
  the pre-filter on and off and requires identical answers.
- **Every rule has a positive fixture** found under exactly its own rule and no
  other, placeholders and near misses produce nothing, and a corpus of ordinary
  repository content -- lockfile hashes, UUIDs, commit ids, colours, base64
  images, session JWTs -- produces no finding.
- **Keystores and password databases** (`.p12`, `.pfx`, `.jks`, `.kdbx`, ...)
  are found from the tree by name, never fetched, with the blob as identity.
- Every new rule has its own consequence and revocation step in the narration
  table. `RULES_VERSION` moves to 3 and the scan configuration to 2, so a new
  scan is never compared with one that ran a different rule set.
- Verification is now offered only where a verifier exists. Three do; offering
  a two-press check on dozens of rules that would always answer
  "unverifiable" would teach people to ignore the control.

**History.** Every scan of a repository is listed newest first and grouped by
day ("Today", "Yesterday", then dates), each row saying when it ran, how it
ended, which branch and commit, and what it found by severity -- readable
without opening it. Opening a row fetches that scan's report once: what it read
in numbers that add up to the tree (read, binary, other, stopped by a limit),
and each finding it observed. Older scans load a page at a time, continued from
the last row seen rather than by offset. Reloading the page now restores the
newest scan, including one still running, instead of offering to start one as
though none had run. Migration 026 adds the skip counts and a history index.

**Report.** Findings are disclosures sorted worst first: a summary row with
severity as a word, the credential's kind, the file and line, and what has been
decided; opened, the full explanation and the controls. One button expands or
collapses them all. A file *named* with a credential is described in the
summary rather than printed -- the summary row was the one place the raw path
would otherwise have reached the screen.

**Clear.** *Clear history* removes every scan, finding and check result recorded
for the repository under the reader's own account. Two presses, the first
saying exactly what goes; refused while a scan is queued or running; nobody
else's record is touched. It is a governed action (`exposure.history.clear`,
control catalog **1.4.0**); revision 1.3.0 is unchanged and hashes byte-for-byte
as before, so policies approved against it still mean what they meant.

**Two things the tests caught in my own work this round.** The summary row
first printed the raw path, bypassing the credential-shaped-name guard; it now
uses a server-computed `displayPath`. And `src/supabase-key-kinds.js` from the
previous round had never been added to the typechecked set; it is now, with the
new rules module.

Ratchets moved with reasons: routes 157 → 159, exposure routes 10 → 12,
migrations 025 → 026. 17 sabotages across the transport, worker, detectors
and screen, all caught.

### Using a Finding: Verification, Acceptance, and Asking the Project

The three routes built in the previous rounds could not be reached from
anywhere. A verifier nothing calls is not a feature, so this round wires all
of them end to end — and closing the gap turned up two judgements worth
recording as reversals rather than as quiet edits.

- **The accept-risk capability gate was wrong, and it is reversed.** It was
  gated on `exposure.scan` being *Supported*, on the reasoning that accepting
  the risk of a live credential is the most consequential decision on the
  screen. What that actually produced was a reader with a false positive — a
  sample key in a fixture, a credential revoked before anybody looked — and no
  way to say so. A screen people stop reading costs more than the thing the
  gate was protecting. The route now passes `allowExperimental`; the control
  that matters is the **role**, and that stays: it is still the only exposure
  route needing a governance administrator, so a repository reader cannot wave
  away their own finding and an administrator who does has their name on it.
  The two tests that praised the old split now assert the new one and say why.
- **The verification route was never in the mutation inventory.** The
  contract test caught it as an unclassified repository-mutating route the
  moment the probe route was added beside it. Both are inventoried now, with
  their actions and execution contracts, rather than exempted — an exemption
  list only records that somebody decided not to look.
- `POST .../findings/:fingerprint/verify` and its history read, behind an
  explicit `confirm: 'use-this-credential'` that is refused **before any
  repository read happens**. The handler re-reads the blob, re-detects, matches
  by fingerprint, mints a grant bound to that candidate, commit, adapter and
  target that expires in a minute, and records the attempt whatever the answer.
  A file that changed since the scan yields no match and says so: verifying a
  credential the repository no longer contains would be using a secret nobody
  asked about.
- **The e2e suite caught a second real bug in this application's own
  conventions.** The UI passed `body: JSON.stringify(...)`, but `api()`
  serialises the body itself — the server would have seen `req.body.confirm`
  undefined and refused every verification, and the scan request would have
  silently ignored the branch. Both call sites are fixed and a case asserts the
  parsed body shape rather than that a request was made.
- **Two-press controls, and only one armed at a time.** Checking whether a
  credential is live sends somebody's leaked secret to a third party;
  accepting the risk is recorded under a name with no route that undoes it.
  The first press arms and names what the next one does — "Send this credential
  to the provider", "Record me as accepting this exposure" — rather than asking
  whether the reader is sure. Arming either disarms every other control on the
  screen, because a second armed button makes the next click ambiguous and one
  of these clicks is irreversible.
- **The list no longer forgets.** A screen that showed only what was asked in
  the current session would lose a verification from yesterday and a
  readability answer from last week — and making them reappear by asking again
  would mean using somebody's credential a second time to redisplay a fact
  already recorded. The findings read now carries the latest answer of each
  kind, fetched in two `DISTINCT ON` queries rather than two per finding. Only
  the latest, because that is what a list can show; the full sequence — which
  is what proves a revocation or a policy change landed — stays behind the
  per-finding history reads.
- A finding now leaves the server with **two** sentences: what the credential
  is, and what this repository has since decided about it. The disposition
  table was written in Task 7 and never wired; the screen printed
  `Status: accepted-risk`, which reads as machine bookkeeping rather than
  something a named person did. An accepted finding also shows who accepted it
  and when — an acceptance nobody can be asked about is not a decision, it is a
  disappearance. A refused acceptance says it needs a governance administrator,
  not "that did not work": the reader can act on the first sentence and not on
  the second.

### The Readability Probe, Made Reachable

The prober was written in Task 6 and nothing could call it — and the reason
turned out to be a real gap rather than missing plumbing. **No detection rule
produced its inputs.** Nothing matched a Supabase project URL or an anonymous
key, and neither belongs in the shared release-gate rule set: an anonymous key
is published in client bundles by design, so a gate rule for one would fail
builds for every repository that legitimately ships one.

- **The scan now has rules of its own, separate from the gate's.** The gate
  asks whether there is a secret; a scan asks what in this tree decides who can
  read the data, which is a wider question. `supabase-anon-key` is detected so
  it can be *asked about*, and its narration is the one entry in the table that
  says plainly that finding one is not a leak: *"Do not rotate it; that fixes
  nothing and breaks the app."*
- `supabase-service-role-key` is the opposite case and comes out of the same
  shape. Which rule a match belongs to is decided by **decoding the key**, not
  by where it was found: a service-role key bypasses row-level security
  entirely, and a probe with one comes back readable whatever the project
  permits — proving nothing, having used an administrator credential to do it.
  A user-session JWT is neither, because it answers as a person. An unrelated
  JWT is not a Supabase key at all, and a test asserts that too: without it the
  rule is a token-shaped wildcard that reports every session fixture in the
  repository, which is the noise that gets a screen ignored.
- The two rules are the same pattern, so the detector now **walks a shared
  shape once**. Compiling them as two passes spent two of a file's match budget
  on every key it contained — including keys neither rule wanted — so a file of
  unrelated JWTs would have reported itself truncated: a scan claiming it could
  not read everything about a file where there was nothing to read. A match
  belongs to the first rule in the pass that accepts it.
- `RULES_VERSION` moves 1 → 2 and the rule-set digest is recomputed over both
  halves. The digest test covered only the shared set, so the scan's own rules
  — the ones whose wording matters most, being the ones a reader has never seen
  — could have changed silently; it now covers both, in order.
- Added `src/supabase-key-kinds.js`. Telling an anonymous key from a
  service-role key is knowledge about **text**; the prober is knowledge about
  **contacting a service**. The scanner needs the first and must never acquire
  the second, because a scan walks somebody's whole repository and the module
  that does it should not have an outbound transport anywhere in its import
  graph. The prober re-exports it, so there is one definition rather than two
  that drift.
- Migration **024** records readability probes, append-only, beside the
  verification attempts. What it will not hold is a row: `row_count` is capped
  at 0–1 by a CHECK and constrained to agree with the state, because "a row came
  back" is the entire finding and storing the row would turn a security check
  into a second copy of somebody's data. The relation and the projection carry
  the prober's own patterns as column constraints — a table name cannot hold a
  credential if the column will not store one — and the projection is stored
  comma-joined precisely because a CHECK cannot run a subquery, so an array
  could only have been constrained by promise.
- A probe **moves no disposition**, and that is the honest behaviour rather
  than an omission. A readable table is not the credential being live and a
  denied one is not the exposure ending; inferring a disposition from either
  would be inventing a fact. A test asserts the method contains no
  `UPDATE nv_exposure_findings`.
- `POST .../findings/:fingerprint/probe-readability` and its history read. The
  operator supplies three things this route will not invent: the confirmation,
  the relation and the columns. The project reference comes from the file's own
  text through `discoverProject`, which **rebuilds** the origin from twenty
  validated letters rather than trusting a URL a repository chose — asserted by
  requiring that `server.js` never writes a provider address itself. The grant
  is signed over the project, the relation and the columns in order, under its
  own derived key: a grant to ask a provider "is this credential yours" is not
  a grant to ask a project "may the public read this table", and a shared key
  would let one signature satisfy both checks.
- The screen asks for a table and columns rather than guessing, and a press
  with nothing typed is treated as a mis-click rather than a question. What
  will and will not be asked for is the prober's decision and is not duplicated
  in the browser — duplicating it would mean two answers. Typed values live in
  state rather than in the DOM, because the list is rebuilt on every render and
  a half-typed table name would otherwise vanish.
- **The answer carries the question.** "Readable" means nothing without what
  was asked, so the result line reads *"… Asked: profiles (id, email)."* A
  denied answer is not shown in a safe tone and the narration says it is
  evidence about *that request*, not about the table: a reader told their table
  is protected stops looking. A service-role finding gets no form at all.
- The ratchets moved deliberately and with reasons written into them: route
  surface 155 → 157, exposure routes 8 → 10, migrations 023 → 024, narration
  coverage widened to both rule sets, the text-column bound check widened to
  migration 024, and the credential-search dump extended to the new table.
- Seventeen sabotages this round, all caught: a single-press accept; a missing
  acceptance provenance line; two controls armed at once; a generic message
  where the required role should be named; a disposition printed as a slug; a
  finding leaving the server undescribed; the payload dropping the disposition
  sentence; a service-role key allowed to be probed; the probe form offered for
  one; a typed question lost to a re-render; an answer shown without its
  question; an empty question sent anyway; a generic message where the missing
  project should be named; the confirmation moved after the repository read;
  the verification key reused for the probe grant; and the detector compiling
  one pass per rule instead of one per shape; and the screen dropping the
  answers already on record.

### Governable Findings, and the Screen That Shows Them

- Control catalog **1.3.0** maps six exposure actions. Revisions are
  append-only because a stored policy names a catalog version and hash: editing
  1.2.0 to add these would change what an already-approved policy covers
  without anybody approving it. A test asserts the earlier revisions report
  these actions as unmapped and that a revision may only add.
- The bindings are the distinction that matters. `exposure.scan.request` binds
  to whoever executes it — it reads a repository the caller can already read.
  `exposure.finding.accept-risk` binds to a **governance** role and is marked
  critical: deciding that an exposed credential is acceptable is a decision
  about somebody else's security, and a repository reader cannot wave away
  their own finding. Using a discovered credential (`exposure.credential.verify`,
  `exposure.readability.probe`) is `high`, which is what it is.
- Six routes, each carrying the full chain — provider session, repository
  boundary, capability gate, authentication, governance role, and a mutation
  context on the three that decide something. The identity is passed **into**
  the store on every call so the boundary lands in a WHERE clause rather than in
  a comparison somebody could forget; a scan id is a uuid a caller could hold
  without owning. The routes are inventoried rather than exempted, so route,
  action and execution contract are checked together.
- The ref is resolved to a commit **once**, on the request path, and the worker
  cannot reach the resolver at all — asserted by requiring its source not to
  mention it. That is what stops a branch moving mid-scan from producing a
  finding set assembled from two trees.
- The route-surface ratchet moved from 147 to 153, deliberately and with the
  reason it asks for: these six are registration and nothing else, each
  validating a couple of parameters and calling one method on a module that has
  its own tests. That is the shape the ratchet exists to encourage.
- `exposure.scan` is **Experimental** for GitHub — implemented and fixture-tested
  end to end, not exercised by the live-provider harness, which is exactly what
  that status means here and what `file.rename` already carries. The consequence
  is the interesting part: reading and scanning routes opt in and work, while
  **accepting the risk of a live credential does not**, because it does not pass
  `allowExperimental`. A feature being usable and its most consequential
  decision being usable are separate questions, and the capability gate is where
  they separate.
- **The screen leads with what was proven, then coverage, then the list.** That
  order is the argument: a findings list on its own invites the reading "nothing
  here, so nothing is wrong", which is precisely the conclusion a partial scan
  does not support. An empty list under partial coverage says *"No credentials
  were found in the part of the tree this scan read. That is not an all-clear."*
  Queued, running, partial, failed and canceled all render in a warning tone;
  only a complete scan with complete coverage reads as settled, and even that is
  neutral rather than a green tick.
- Added `test/e2e/exposure.spec.js`: eight cases covering the proof-before-list
  order, the empty-list-under-partial-coverage sentence, a scan in progress
  never looking settled, no credential reaching the DOM or browser storage,
  provider text inserted as text rather than markup, the keyboard path and the
  live region, both themes, 320px reflow, and findings not surviving a
  repository switch.
- **The e2e suite caught a real bug before anybody ran the feature.** The UI
  built its request URLs from `state.owner`/`state.repo`, which this application
  does not have — the repository lives on `state.work` and paths are built with
  `wPath()`. Every exposure request would have gone to `/api/repo//exposure/...`
  and failed silently, showing an empty screen that looked like a clean
  repository. It is fixed, and the loaders now return early when no repository
  is open rather than asking the server about one nobody named.
- **And a second real defect, found the same way.** The screen existed only as
  a tab, and the tab strip is hidden at phone width — so the whole destination
  was unreachable on the device this product is most used on. It now has a More
  sheet entry and a command-palette entry alongside Governance, and a case named
  for it asserts both paths exist. The browser-purge suite gained the exposure
  clear, because findings carry a placeholder, a path and bounded locations for
  somebody's credentials and must not survive into the next session.
- Thirteen sabotages across the catalog, the routes, the capability document,
  the screen and the purge path;
  all eleven caught, including a reader being allowed to accept their own risk,
  a route losing the repository boundary, a read dropping the identity, the
  caller supplying a commit instead of the ref being resolved, an error message
  returned raw, and a decision no longer being recorded.

### Anonymous Readability, and Saying What a Finding Means

- Added `src/anonymous-readability-probe.js`: establishing whether a discovered
  project is actually readable by a stranger, rather than reasoning about
  whether its configuration looks wrong. The temptation with a leaked project
  URL and public key is to infer — this key is anonymous, that table probably
  has no policy, therefore the data is exposed — and every step of that is a
  guess. The only thing that settles it is asking the way an anonymous stranger
  would.
- **What that proves is narrower than it looks, and most of the module is about
  saying so precisely.** A row came back: that projection of that relation was
  readable by the anonymous role at that moment, and nothing else. No rows came
  back: *nothing is known* — an empty table, a filter that matched nothing and a
  policy that permits the read while hiding every row are indistinguishable from
  outside. The request was refused: *that request* was refused.
- The vocabulary contains no word for "protected", and a test asserts that: no
  reason code may contain `protected` or `rls`, and the narration for an empty
  result or a refusal may not read as safety. A reader told their table is
  protected stops looking.
- **A service-role key is refused, and so is a user session.** A stronger key
  bypasses the policies the question is about, so a row would come back whatever
  the configuration is — proving nothing, using an administrator credential to
  do it. A token carrying a subject is somebody's session whatever its role
  claims; the test for that uses a token claiming `role: anon` *with* a subject,
  because a token with a non-anonymous role is already refused by its role and
  would not exercise the check.
- The origin is rebuilt from a validated twenty-letter project reference, never
  copied from the discovered text. `https://<ref>.supabase.co.evil.example` and
  `https://evil.example/<ref>.supabase.co` are both refused. Discovery itself is
  pure text and sends nothing: the whole consent model rests on it being free.
- One row, named columns only, `select=*` refused outright, no pagination ever
  requested, and the result carries a **count and no values**. Embedded
  resources, aliases, casts and function calls are refused for the same reason —
  each reaches past the columns an operator agreed to.
- **A real bug the sabotage pass found:** the relation guard refused any name
  beginning `rpc`, which was wrong in both directions. `rpc/do_thing` was already
  excluded because a table name cannot contain a slash, and a table legitimately
  called `rpc_helpers` was being refused for its prefix. Excluding by shape
  rather than by prefix is the point, and there is now a fixture asserting
  `rpc_helpers`, `rpcs` and `auth_events` are read as the ordinary table names
  they are.
- Service description reads the project's OpenAPI document under its **own**
  grant and its own operation, returns relation names only — no column names, no
  types, no values — and reduces coverage to `partial` when unavailable rather
  than inventing a list. A probe grant is not a description grant.
- Added `src/exposure-narration.js` and `docs/reference/exposure-findings.md`:
  saying what a finding means, in words, without a model. A stored finding is a
  rule name, a path, a line and four version numbers — enough to act on if you
  already know what `contextual-provider-secret` implies, and the person who
  most needs to act is the one least likely to know.
- **It is a lookup table, not a generator.** A generator would be shorter and
  would drift: the same finding would be worded differently between runs, a
  reader comparing two scans could not tell whether the wording or the world had
  changed, and nobody could review sentences nobody can enumerate. The test
  asserts one entry per rule, no orphan entries for rules that do not exist, and
  that narration is a pure function of the record — no clock, no randomness, no
  environment.
- The consequence comes first, in the reader's terms. "A GitHub personal access
  token" is what it is; "anyone who has this can act as the account that issued
  it" is what it means, and only the second tells somebody whether to stop what
  they are doing. Every entry also says what to do, and says that revoking is
  what ends an exposure because the credential stays in the repository history.
- No narration carries the credential, any prefix of it, or the fingerprint —
  a finding should be safe to paste into a ticket and show on a screen in an
  open-plan office. The one path by which a secret could reach a sentence is a
  **file whose name is itself credential-shaped**, and that is handled rather
  than reasoned about: such a name is described instead of quoted, while the
  directory is still shown so the file can be found.
- The reference document is registered in the manifest under the `current`
  lifecycle, and it is checked against the code rather than trusted. Its
  disposition and verification tables must have one row per value the code
  defines — checked at row level, because every disposition is also named in the
  summary table at the top and a word-level check passes while the row
  explaining it has been deleted. Four sentences it must never contain are
  asserted absent by pattern.
- Twenty-three sabotages, twenty-three failures across both modules and the
  document, after four survivors were corrected: two test helpers that defeated
  their own assertions with `||` defaults, a leak check aimed at column names
  rather than row values, and the `rpc` prefix bug above.

### Bounded, Restart-Safe Repository Scanning

- Added `src/exposure-reader.js` and `src/exposure-worker.js`: reading a
  repository without having a copy of it, and running that read on one free web
  service without keeping anything.
- **Every ordinary way to read a Git repository runs code.** `git clone` runs
  hooks and clean/smudge filters, a checkout turns LFS pointers into network
  fetches, a submodule is a second repository under somebody else's control, and
  installing dependencies to inspect them is running the thing you were trying
  to inspect. So this reads the provider's tree and blob APIs and nothing else —
  no subprocess, no working directory, no clone to clean up. Tests assert the
  source contains no `child_process`, no `fs`, no `spawn`, no `exec`, no
  `mkdtemp` and no bare `fetch`, with comments stripped first so the sentence
  explaining why `git clone` is unavailable does not trip the check on itself.
- Not writing anything down is also what makes recovery work. A `finally` block
  cannot run after SIGKILL, so a design whose recovery needs a disk is a design
  whose recovery does not work. There is no cursor either: a restarted scan asks
  the provider again at the same immutable commit, and what is in the database
  is all there is.
- **A Git tree is not a list of files**, and each kind is a decision this reader
  makes explicitly: a directory, a symlink whose blob content is a path, a
  submodule gitlink, a blob larger than this server will hold, a path that is
  absolute or contains a traversal or a newline or `.git` at any level, a
  malformed object id, an entry with no size. Twenty-two classification cases,
  plus five paths that merely look alarming (`dot.git.js`, `a/..b/c.js`,
  `src/.env.example`) and are correctly read as ordinary.
- Binary blobs are skipped, not scanned: running text rules over arbitrary bytes
  produces matches that are not credentials, and a reader shown one stops
  trusting the rest. NUL bytes, invalid UTF-8 and a lone surrogate all count.
  An **LFS pointer** is recognised and the object behind it is never fetched —
  that fetch is exactly the smudge a clone would have done.
- The declared size is the provider's claim; the bytes are the fact. A response
  that decodes to more than the ceiling is over the ceiling whatever its `size`
  field said.
- **A 401 stops the scan; a 403, 404 or 500 skips one file.** The session being
  gone means every remaining read would fail identically, and the scan stops
  holding the credential rather than keeping it to retry with. A single
  unreadable file must not end a scan of ten thousand.
- An unreadable tree is an error, never an empty repository. Returning zero
  entries there would produce a scan that completed, found nothing, and told
  somebody their repository was clean.
- There is a reader for GitHub and for nothing else. A guessed tree API returns
  nothing and looks successful, which for a security feature is worse than
  refusing — so `gitlab`, `gitea` and anything unknown are refused by code, and
  the capability registry says so with that reason rather than the generic one.
- **One commit, never a ref.** The worker reads the commit the scan row carries
  and never the ref name; a branch that moves between the tree read and the blob
  reads would otherwise produce a finding set assembled from two trees, with
  locations that never existed together. A row carrying a ref, a short sha or
  nothing is refused rather than read at "the current tip", which would be
  inventing consent for a tree nobody authorised. A full object id in upper case
  is normalised, and that is asserted too, because "normalise" and "accept
  whatever arrives" look identical from outside.
- **Every ceiling produces visibly partial coverage.** Files, bytes, wall clock,
  a truncated tree, and any file the reader declined — all of them mean
  `partial` with the reason named. Silently stopping at a limit and reporting
  success is the worst thing this feature could do: it tells somebody their
  repository is clean because the scan gave up. The budget floors are 1 rather
  than a comfortable minimum, because silently raising a configured ceiling
  produces a scan that read more than it was told to and nobody reading the
  configuration would know.
- **Cancellation is the lease renewal**, which is already periodic and already
  returns false exactly when the scan is no longer running-and-ours — cancelled
  by its owner, or reclaimed because this worker was thought dead. One mechanism
  for both means neither is the one nobody wired up, and a lost claim stops the
  scan mid-file rather than between jobs. A worker that lost its claim
  deliberately does not finalise: the owner already did, or somebody else holds
  it now.
- The loop yields to the event loop between files, and the test proves it with a
  timer that must tick *during* the scan. This process also answers HTTP, and a
  loop that reads two thousand blobs without yielding stops answering requests
  for as long as it runs.
- **Killed, not thrown.** The recovery test stops the first worker between a
  write and a finalise — no finalise, no `finally`, nothing — then has a second
  worker reclaim the same scan through the store's expired-lease path and read
  the same immutable commit again.
- A background job holds no credential and cannot verify anything. The session
  is resolved at execution from a live signed-in session belonging to the actor
  who asked, so a disconnect or a revocation simply stops the next read instead
  of leaving a copied token in a job row. Verifying a credential needs a
  per-candidate signed authorization only a reader can give, so the worker
  cannot reach the verifier at all — asserted by requiring its source not to
  mention it.
- Added a third guard to the transport: **a credential must never appear in a
  URL, on any profile.** The verification profile's query-string ban covers the
  profile whose whole request is sensitive; this covers the mistake it cannot
  reach, a call site on a profile that legitimately carries both a credential
  and a query string — a provider read, which sends the reader's own session
  token — interpolating the token into the address. A URL survives into access
  logs, referrer headers and every proxy in between. The floor on length keeps
  it from refusing every URL containing a short header value.
- `exposure.scan` is declared in the capability registry as `Unavailable` for
  all three providers, and **the worker starts only when the document says
  otherwise**. That is the wire being correct rather than missing: a poller
  asking for work no route can create would spend a query every fifteen seconds
  of a free service's budget for nothing. An entry that reports Unavailable is
  still an entry — the registry's default for an unknown feature is also
  Unavailable, so a feature nobody declared and a feature declared not-ready are
  otherwise indistinguishable, and one of them is a typo.
- Added the `authorization-revoked` skipped reason, distinct from a transport
  refusal because retrying will not help: somebody disconnected the provider.
- Twenty-nine sabotages, twenty-nine failures, across the reader, the worker,
  the capability document and the server wiring. Two survivors were corrected
  fixtures rather than code: a byte budget below the clamp floor, and an
  expectation that an upper-case object id should be refused when normalising it
  is right.

### Exposure Storage

- Added `db/migrations/022_exposure_scans.sql`, `src/exposure-store.js` and two
  gates. One rule decides the whole shape: the server stores what it **learned
  about** a repository and never any part of the repository itself. No file
  contents, no source excerpt, no redacted line, no probe response, no provider
  credential, no session.
- **The privacy claim is the schema's, not a serializer's.** A serializer is a
  promise in application code and the next person to add a column will not read
  it. So the locations of a credential inside a file are stored as
  `integer[]` — a caller who tried to keep a source line alongside a finding
  would be writing text into an integer column, and PostgreSQL refuses before
  any application logic is consulted. Fingerprints, identity keys, commits and
  subject digests are constrained to fixed-length hex. Every text column is
  length-bounded or shape-constrained; no `bytea` and no `jsonb` column exists
  at all. The absence of a column named `secret` proves nothing, and the
  contract test says so in as many words.
- The placeholder column is matched against `^<[a-z-]+ #[0-9]+>$`. A partial
  redaction — the usual instinct — publishes the prefix of a token, which is the
  part identifying the provider and often the account, so that mistake is a
  failed insert. The store refuses it earlier with a message that says why.
- Idempotency and execution ownership are both the database's. Repeating an
  idempotency key returns the same scan (proved with ten simultaneous requests
  resolving to one row), and a partial unique index allows exactly one live scan
  per repository. One `ON CONFLICT DO NOTHING` without a target settles both,
  which is what makes the two outcomes distinguishable afterwards: no row with a
  matching key is a replay, no row without one is a conflicting live scan.
  Naming a constraint in the conflict clause would have made the other case an
  exception instead of an answer.
- Work is claimed with a **fresh fencing token per claim**, so a worker that
  stalled through its lease and woke up finalising a job somebody else now owns
  matches zero rows. An expired lease is reclaimable, which makes a killed
  worker's job recoverable with no heartbeat to trust and no `finally` block to
  hope ran. Both are tested against a real server, including the reclaim
  fencing the original holder out.
- **What makes two workers unable to claim one scan is the predicate, not
  `SKIP LOCKED`** — and that is in the code comment because sabotaging the
  obvious candidate did not break the test. Under READ COMMITTED a second
  claimer that blocks on the row re-evaluates the qualifying conditions when the
  first commits, and by then the scan is running with a live lease. `SKIP
  LOCKED` only decides whether that claimer waits to be told no.
- Observations are append-only: written once, `ON CONFLICT DO NOTHING` so a
  retry is free, and the contract test asserts the store contains no `UPDATE` or
  `DELETE` against that table at all. Retention deletes expired **scans**, whose
  observations cascade, and leaves the findings — so what was seen where ages
  out while the fact that a credential was ever exposed does not.
- **Nothing concludes a credential is gone without the evidence.**
  `concludeRemovedFromTree` refuses, with a reason, when the scan was canceled,
  failed, truncated, finished with partial coverage, has no recorded
  predecessor, is compared against a different ref, or ran under different rule,
  engine, key or config versions. That last one is the quiet catastrophe it
  exists to prevent: rotate the fingerprint key and every fingerprint changes at
  once, so every previous finding is missing from the new scan for a reason that
  has nothing to do with the repository — and a naive diff would mark the entire
  backlog resolved. Seven refusal cases, each asserting its own reason and that
  every finding was left exactly as it was.
- **And even when it concludes, the word is not "resolved".** A credential
  absent from HEAD is still in the repository's history, reachable by anyone
  with a clone. The disposition is `removed-from-tree` and it says that much and
  no more. `credential-rejected` — the issuing provider saying the credential no
  longer works — is the only disposition that means the exposure is over, and it
  does not overturn a person's `accepted-risk`. A credential that reappears in
  the tree goes back to `open`, because the removal claim was simply wrong.
- Only a person's decision names a person: a schema CHECK makes
  `disposition_by` present exactly when the disposition is `accepted-risk`, so a
  provider's refusal or a tree comparison cannot invent an approval.
- Every read carries the identity boundary **in the WHERE clause** rather than
  checking it afterwards. A scan id is a uuid somebody could hold without
  owning, and "fetch then compare" is one forgotten comparison away from a
  cross-tenant read. The contract test extracts every statement in the store,
  requires each one touching a scan or a finding to carry an identity, a claim
  token or one of four stated exceptions, and asserts the scan found statements
  at all.
- The tester purge was **extended, not duplicated**. Two deletes alongside the
  existing ones, by the same `identity_key` every other table here uses, rather
  than a second model of who owns what. Observations are deliberately not listed
  because they cascade, and both the contract test and the real-SQL purge
  regression assert that — a cascade is exactly the kind of thing that looks
  right in a migration and does not happen.
- **The store gate needs a real PostgreSQL server and refuses without one.**
  Nearly every property here belongs to the database rather than to JavaScript,
  and a fake that decides a conflict atomically does so because it was written
  to — so a store that read and then wrote would pass against the fake and race
  against a server. Added as `npm run test:exposure-store` with its own CI step
  against the same service the migration gate uses.
- The strong form of the leak check runs there too: every value in every column
  of all three tables, dumped via `to_jsonb`, searched for a synthetic
  credential and slices of it, with the number of cells examined asserted so a
  sweep over an empty database cannot pass. The array element types are checked
  against the live catalog rather than the migration text.
- All 22 migrations applied, verified and re-applied clean against PostgreSQL
  16, and the extended purge regression passed there. Twenty-two sabotages,
  twenty-two failures — after three that initially survived were traced to bad
  sabotages of my own (`&&` binds tighter than `||`, so disabling one clause of
  a four-clause guard leaves it firing) and one genuine gap: no test produced a
  scan that finished cleanly with partial coverage, which is the case the
  coverage check exists for.

### Stable Finding Identity

- Added `src/exposure-detection.js`, which finds **every** credential in a
  file rather than proving one exists. The release gate stops at the first match
  per rule per file — correct for a gate, since one is enough to fail a build,
  and wrong for a reader triaging an exposure. A scan reporting one token in a
  file holding four has told them the repository is clean three times over.
- The rules are imported, not restated, so there is one definition of what a
  credential looks like in this repository and a rule improved for the gate
  improves the scan. `test/secret-scanner.test.js` now carries compatibility
  coverage that the two never disagree about existence: for every finding the
  gate reports, the scanner must report the same rule with the same first line,
  and the file the gate leaves alone stays quiet in both.
- **The shared-regex-state test was wrong before it was right, and the reason is
  worth recording.** A global expression carries `lastIndex` between calls, so
  sharing a compiled rule across files skips the second file's beginning. But an
  `exec` loop that runs to completion resets `lastIndex` on the way out — so the
  obvious two-file check passes whether the rules are shared or not, and it did.
  The path that actually leaves stale state is the match ceiling, which exits
  the loop early. The test now scans a file that hits the ceiling and then a
  small file whose only credential is on line one, and it fails when rules are
  shared.
- A bare `\r` is a line ending. Counting only `\n` puts every credential in a
  legacy Mac-encoded file on line 1, which sends a reader to the wrong place in
  a file they may not be able to open. CRLF and LF produce identical locations.
- Every dimension is bounded — bytes read, matches walked, candidates kept,
  locations per candidate — and a result that hit a cap says `truncated`. The
  occurrence **count** is not capped with the occurrence **list**: "found 400
  times, here are the first 20" is useful and "found 20 times" is wrong. A file
  past the size ceiling reports `scanned: false` rather than an empty candidate
  list, because an empty list reads as an all-clear.
- A placeholder is a generated label (`<github-token #1>`), never a redacted
  prefix. Showing the first characters of a token is the usual instinct and it
  publishes the part identifying the provider and often the account — most of
  what the leak was worth. A test asserts no placeholder contains any prefix of
  any credential in the file, at every length from 4 to 12.
- Added `src/exposure-findings.js`: a **keyed** fingerprint over the scope, the
  exact Git path, the rule and the credential bytes, with the key, rules and
  engine versions all part of the message and recorded on the finding. Keyed
  rather than hashed because the population of a provider's token format is
  small enough to walk offline, so an unkeyed digest published on a finding is
  the credential for anyone with hardware to spend.
- Nothing in identity is folded. `README` and `readme` are two entries in a Git
  tree even where a filesystem disagrees, and a name written with a combining
  accent is a different name from the same name composed — so two distinct paths
  never collapse into one finding. A test asserts the module source contains no
  `normalize`, `toLowerCase` or `toUpperCase` at all.
- A line number is a location, not an identity: adding imports above a
  credential changes its occurrences and not its fingerprint. Two credentials
  sharing a 30-character prefix are two findings. The same credential in two
  repositories is two findings, neither reachable from the other's record.
- **Reconciliation refuses rather than diffs across a version change.** Rotate
  the fingerprint key or edit a rule and every fingerprint changes at once; an
  ordinary diff then shows every previous finding resolved and every current one
  new, which reads to a human as "everything was fixed". `reconcileFindings`
  returns `comparable: false` with a reason and reports nothing resolved. A
  previous set written under two key versions is refused for the same reason —
  picking the majority would silently resolve the minority.
- The credential travels on a probe guarded by **two independent mechanisms**,
  and the distinction is load-bearing rather than belt-and-braces. The private
  field covers the accidents that enumerate — a spread while building a record,
  an `Object.values` in a serializer — which never consult `toJSON` at all. The
  `toJSON`, `toString` and inspect hooks cover the accidents that stringify, and
  they say `[redacted]` rather than rendering an empty object: `CandidateSecret {}`
  in a log leaves a reader unable to tell whether the value was absent, empty or
  withheld. Both are sabotage-verified, and `Symbol.toPrimitive` was **removed**
  once no test could distinguish its presence from `toString` alone.
- `revealForVerification` is the single deliberate exit, and it refuses a
  fabricated probe. That guard is what keeps the wrapper from becoming optional:
  a refactor that started passing plain objects through would drop every
  protection above without changing a single leakage assertion, because a plain
  string secret has nothing to leak *from*. It hands the verifier a candidate
  the verifier's own classifier accepts, so there is no translation layer
  between the two tasks.
- Nothing here claims a JavaScript string can be wiped. It is immutable and the
  engine copies it at will, so the stated claim is the weaker true one: as few
  copies as possible, held as briefly as possible, and never stored.
- Added the `EXPOSURE_FINDING_FINGERPRINT` key purpose.
- Twenty-two sabotages. Four initially survived and all four were defects in the
  tests rather than the code: the shared-regex premise above, two
  separator-collision fixtures that shifted a boundary instead of crossing one,
  and an assertion that a private field was unreadable when it was already
  unreadable by construction. Each is now written to fail for the stated reason.

### Credential Liveness Verification

- Added `src/credential-verification.js`: asking the provider that issued a
  discovered credential whether it is still live. The scanner already finds
  credentials; what it could not say is whether the one it found still works,
  and that is the difference between a finding to triage and a finding to act
  on this hour. Only the issuing provider knows, so the only way to find out is
  to use the credential — which is why almost all of this module is about not
  doing that.
- **A repository read is not permission to use what is inside it.** A probe
  requires a separate signed authorization bound to the actor, the repository,
  the commit, the exact candidate fingerprint, the adapter and the target,
  valid for at most ten minutes. Twelve refusal cases are tested and every one
  of them makes **zero** network calls: no authorization, an empty one, a forged
  signature, one signed under another key, an expired one, one issued in the
  future, one that outlives the ceiling, and one bound to another candidate,
  repository, commit, adapter, target or actor. The check runs before a socket
  exists, because a probe refused afterwards has already used the credential
  and no later verdict takes that back.
- The answer is three-state and deliberately asymmetric. `verified` means an
  identity endpoint confirmed it. `rejected` means a documented, unambiguous
  refusal. Everything else is `unverifiable` — because "we could not tell" and
  "it is harmless" are different sentences and only one of them is true.
- GitHub uses `/user`, not `/rate_limit`. The rate limit endpoint answers 200 to
  an unauthenticated caller, so a 200 there proves nothing at all; `/user`
  requires a user credential and returns the user it belongs to. A 200 whose
  body is not an identity — no login, a numeric login, a missing id, unparseable
  — is `malformed-identity-response`, not a pass.
- A GitHub 403 is never read as a refusal. It is primary throttling, secondary
  throttling, or an organisation policy blocking this token from this resource,
  and all three describe a credential that works. The reason and a **bounded**
  retry window are preserved; a `Retry-After` of eleven days is clamped to an
  hour, because that header is the provider's opinion and not our scheduler.
- Slack's `invalid_auth` is reported as ambiguous, which is the point of having
  the adapter. Slack returns it both for a revoked token and for a live token
  presented from an address the workspace restricts, so calling it revoked tells
  a reader the exposure is over while the credential still works. `token_revoked`,
  `token_expired`, `account_inactive` and `invalid_token` are the unambiguous
  ones; `ekm_access_denied` is policy; `ratelimited` is throttling; anything
  Slack adds later is `provider-unexpected-status` rather than a guess.
- **There is no AWS adapter, on purpose.** The rule finds an access key ID,
  which is a name and not a credential: signing needs the secret access key too,
  and a session token for a temporary one. So an access key ID is
  `incomplete-credential` and is never sent anywhere, and no combination of a
  found ID with a nearby-looking string is ever attempted — that would be
  guessing at somebody's account with their own data.
- Installation, refresh, deploy, runner, agent, app and session token classes
  are recognised and deliberately not probed: each authenticates against a
  different surface, and an unreviewed guess at the right endpoint is a verdict
  with no evidence behind it. Private keys, authenticated URLs and contextual
  secrets stay detected and unverifiable rather than being submitted to an
  unrelated authority.
- A run is bounded three ways: the same credential found in four files is one
  probe, a provider that says it is throttling is not asked again in that run,
  and a run asks at most fifty times however large the repository is. Throttling
  one provider does not stop another. Every request still gets a record — the
  bounds change what is asked, never what is accounted for.
- Nothing carries the credential back out. The module writes nothing at all, no
  transport error message reaches a record (it can quote the request it failed
  to send), and the probe target comes from the adapter's own constants so a
  candidate can never contribute an origin, a path or a query string. The leak
  sweep drives six probes whose fixtures echo the token back — in a 401 message,
  a 500 body, a Slack error object and a thrown transport error — then searches
  every record, error, stack and console write for the synthetic credential and
  for a twenty-character slice of it.
- The provider identity that comes back is recorded as a **keyed** digest under
  its own derived purpose, never the login. Two keys over the same subject
  disagree and no key produces no digest, which is what makes it a digest: a
  provider user id is a short integer, so an unkeyed hash of one is the id with
  extra steps.
- Going stale is not a verdict. An observation is good for a day and
  `verificationFreshness` reports `fresh` or `stale`; a `verified` record whose
  deadline has passed still records a credential seen live. Letting staleness
  read as `rejected` would resolve findings by waiting.
- Liveness is not severity: the record has no severity field and a test asserts
  its shape is closed, so a field added later has to be considered for leakage
  first. Records and runs are frozen — an attempt is history.
- Added the third transport profile Task 1 called for. `credential-verify` may
  POST, because which method a provider documents for its identity endpoint is
  that provider's decision and not this repository's, and it may not carry a
  query string **at all** — a query string is the part of a request that
  survives into an access log, a referrer header and every proxy in between, and
  this is the one profile whose request contains a secret. Tests assert the
  webhook profile does not acquire GET and a provider read does not acquire
  POST, so no profile borrows another's half.
- Added `EXPOSURE_VERIFICATION_AUTHORIZATION` and `EXPOSURE_VERIFICATION_SUBJECT`
  key purposes. They are separate from each other for the same reason every
  label in that file is separate: one is a MAC over a grant this server issued,
  the other a MAC over a value a provider told us.
- Eighteen sabotages, eighteen failures. The one that initially passed is
  recorded here because it was a real gap: replacing the keyed subject digest
  with an unkeyed hash was invisible to the first version of the test, which
  only matched a hex shape. The test now compares digests under two keys.

### Guarded Outbound Transport

- Added `src/guarded-fetch.js`: one outbound path for everything this server
  reaches on the public internet. The webhook worker already resolved a
  hostname, validated every answer against a public-address policy, and pinned
  the socket to the address it had checked so a second DNS answer could not
  move it. That part worked and is unchanged. What it lacked, and what an
  exposure scan needs before it sends a discovered credential anywhere, is a
  **total deadline**, a **bound on the response it reads**, and a notion of a
  caller other than a signed POST.
- Two profiles, and the point of the extraction is that the second cannot widen
  the first. `signed-webhook` is POST-only, sends no query string and reads no
  response body; `provider-read` allows GET and HEAD, a query string, and a
  bounded body. A profile is not a suggestion: the method, the query string and
  whether a body is read are all decided by the profile, so a scan cannot reach
  the webhook's policy and the webhook cannot start reading response bodies.
- The deadline is total, which a socket timeout is not: a response that delivers
  one byte inside every timeout window never times out and holds a connection
  for as long as it likes. `guardedFetch` abandons the request on its own clock
  regardless of how the bytes are paced.
- The deadline timer is deliberately **not** unref'd, and that is the bug this
  work found in its own first draft. An unreferenced timer lets Node exit while
  a request is still in flight, so the deadline never fires and nothing learns
  the request was abandoned — which showed up as a test suite leaving with a
  success code having proved nothing. The test's watchdog is not unref'd for the
  same reason: a hang is the one failure mode that looks like nothing happened.
- No message this module raises is built from caller input. A verification probe
  sends a discovered credential in a header, so an error that quotes what it was
  given is an error that writes a secret into a log. The underlying failure
  contributes its code; the message is fixed text. A test asserts no credential
  and no `Bearer` appears in the message, the stack, or the JSON form.
- Compression is refused rather than bounded on the profiles that read a body:
  `accept-encoding` is never sent, and a `content-encoding` that arrives anyway
  is refused by code. A bound on decompressed bytes is a bound you have to
  decompress to enforce, which is the wrong side of the decision.
- Repointed `sendPinnedHttpsWebhook` at the shared transport with its recorded
  error vocabulary preserved, and made the translation **total rather than
  defaulted**. `terminal` is decided from the code this file records, so a
  translation that goes missing is not cosmetic — a permanently misconfigured
  destination would be written down as a generic transport error and retried to
  the attempt ceiling instead of dead-lettered once. The transport now publishes
  its codes, the worker has a line for every one of them, and two tests check
  that both ways: a dropped line fails, and so does a translation that invents a
  code nothing reading delivery attempts has ever seen.
- The worker hands its already-validated addresses to the transport instead of
  letting it resolve again. A second lookup is a second chance for the name to
  answer differently, which is precisely the window pinning exists to close.
  Passed-in addresses are still validated.
- Added `test/guarded-fetch.test.js`: URL policy for both profiles, 21 private
  and reserved addresses including `169.254.169.254`, `100.64.0.1` and
  `::ffff:127.0.0.1`, a mixed answer set refused whole, the pin and the SNI name
  held apart, a redirect returned rather than followed, the response bound, the
  encoding refusal, the total deadline, and a refused address never reaching a
  socket. Every guard was checked by breaking the module and watching the test
  fail: eight sabotages, eight failures.
- Brought `src/guarded-fetch.js`, `src/rate-limit-store.js` and — with the first,
  since an import cannot be excluded — `src/governance-delivery.js` into the
  type-checked set, which needed two real annotations rather than a loosened
  flag: a CSV column pair that inference widened until its reader stopped being
  callable, and two store methods whose destructured options the checker could
  only see through their defaults.

### Uploads and the Neural graph

- Fixed a zip of more than a hundred files failing after all the work rather
  than before it. The browser accepted up to 500 extracted files and queued them
  as one batch; the server commits at most 100 operations at once, so every blob
  uploaded first and the commit was refused at the end. The queue is now planned
  before anything leaves the browser: a queue that fits is one commit and says
  so, a queue that does not is offered as the several atomic commits it really
  takes, and neither is started without the choice being made. A run that stops
  part-way reports which parts landed, because those commits are on the branch
  whatever happens next.
- Added `public/upload-planning.js` with the browser's copy of the batch limit,
  held equal to the server's `file.batch` contract by a test that also asserts
  the server refuses one operation beyond it — a number that merely matches
  another number is not a limit.
- The zip error no longer calls 500 the batch limit; 500 is what can be
  extracted at once.
- Verified that zip and folder uploads keep their structure: nested paths are
  normalised by the archive guard, backslashes from a Windows zip included, and
  land at the same relative path under the destination folder.
- Added an enlarge control to the Neural graph. The stage shares a row with a
  rail and an inspector, and is a few hundred pixels tall on a phone, so a graph
  of any size was read through a letterbox — 635×694 on a desktop and 370×426 on
  a phone, now the whole viewport in both. Expansion is CSS rather than the
  Fullscreen API because element fullscreen does not exist on iOS Safari. The
  shell steps aside while expanded, which is both the focused mode this wants
  and the only reliable way to do it: the bottom navigation painted over the
  stage regardless of stacking order, and raising the stage to `z-index: 999`
  did not change which element won the hit test.
- The filter checkbox is now built from the supplied reference rather than
  reinterpreted from it: a transparent glass body whose colour is entirely inset
  shadow forming a lit rim, a white shape behind it that morphs from a rounded
  square to a narrow bar, the sparkle highlight and the cast shadow. Everything
  in the reference is expressed in em, so one font-size scales the whole control
  to the 24px pointer target WCAG 2.5.8 asks for.
- One deviation, stated rather than hidden: the reference's rim colours clear
  3:1 against a dark panel and, for red, against a light one — 3.69 and 5.00 —
  but its green measures 1.83 against this app's near-white light theme. That
  single lightness drops from 45% to 34% in the light theme and nothing else
  changes. Removing that one line fails the guard by name.
- The signal filters are one control again, not three. Colouring each checkbox
  by its severity made three rows read as three different kinds of control when
  the only thing varying between them is on or off; the label and the key dot
  beside it already say which signal a row is about. One design now — a hollow
  ring when muted, a filled accent orb when live — and the severity dot is back
  beside each label, keyed to the colour the graph draws that signal in. It was
  removed in the first attempt at this, which was never something that had been
  asked for.
- Rebuilt the signal filter controls twice. The first attempt kept the sphere
  soft and low-contrast, which vanished at 24px and left the muted state as a
  muddy blob; rendering it beside the reference at matched size made that
  obvious in a way looking at it alone had not. The shipped control is a hollow
  ring in the signal's colour when muted and a filled, rim-lit orb when live —
  a silhouette difference that survives the size the control is actually used
  at.
- Fixed the muted ring failing WCAG 1.4.11. The ring is the control's visible
  boundary, so it owes 3:1 against its panel, and at the opacity it started on
  it gave 2.65, 4.01 and 4.59 in the dark theme and 2.27, 1.58 and 1.45 in the
  light one. The accessibility audit reported zero findings throughout: axe has
  no way to know a CSS ring is what marks a control. Rings are full strength
  now, with amber and cyan darkened for the light theme, and a browser test
  measures the composited colour against the painted panel in both themes.
- Rebuilt the signal filter controls. The severity swatch and the checkbox were
  two objects saying related things — a 7px dot for which signal this is, and a
  stock checkbox for whether it is on — so they are one object now: an orb in
  the signal's own colour that lights when the filter is live. A native checkbox
  at 24px is a blunt square whatever `accent-color` it is given, so the control
  is rebuilt rather than tinted. State never rests on colour alone: the centre
  mark changes shape as well as brightness, a dot while the signal is live and a
  dash once it is muted. The 24px pointer target and the focus ring both
  survive, which the accessibility audit and a browser guard now hold.
- The enlarged graph keeps the controls that decide what it shows. The modes,
  filters and response controls live in a rail beside the stage, and enlarging
  covered it, so changing intelligence mode meant collapsing, changing and
  enlarging again — three steps to do the thing the enlarged view exists for.
  The rail is now moved into the stage rather than copied into it: one set of
  controls, one set of listeners, nothing to drift. A panel control shows and
  hides it, open by default where there is room for both and closed on a phone
  where there is not, and Escape backs out one step at a time.
- Docked, the rail is a tall panel rather than the cramped strip it is above the
  graph on a phone, so it stops dropping things there: the modes get one column
  and their full labels back, and the signal filters appear, which a phone
  otherwise never gets at all.
- Fixed two of the graph's tool buttons drawing nothing in dark mode. Nothing
  styled the icons inside `.neural-tool`, so a bare `<svg><path>` fell back to
  the SVG default of a black fill and no stroke: invisible against the dark
  button, and a filled smudge instead of an outline against the light one. It
  read as a dark-mode bug because that is where it disappears, but both themes
  were wrong. Tool icons are now stroked in the button's own colour, and the one
  solid icon keeps its fill through a class the pause control also writes into
  the markup it rebuilds.
- Centred the tool icons. The buttons never centred their contents, so every
  icon sat on the text baseline 1.5px above the middle of its own button and the
  single text glyph among them centred differently again. All five now measure
  zero offset in both themes.
- Gave the enlarge control its own icon. It had been drawn as outward corner
  brackets, which is what the fit control beside it already used.
- Fixed the repository, snapshot, safety and scan nodes rendering the word
  "undefined" in the middle of the node. Those four were moved from a typed
  character to a drawn mark, and the node builder was left copying only the
  character, so they reached the canvas with neither and `fillText(undefined)`
  painted the word — on the repository itself, the largest node on screen. The
  builder now carries the mark, an absent glyph is never drawn, and a guard
  holds both halves.

### Safe Passage

- Added a `protected-paths-review` template, "Protected sensitive paths (review
  required)", beside the deny posture. The same patterns, held for review on the
  repository's default branch rather than refused everywhere, which is what
  leaves a route to a pull request open. A protected-path declaration can now
  name the branch it applies to, and the expansion states that scope as a limit:
  the same change on another branch is not gated, and that is the point rather
  than an oversight.
- The review template also holds `pull.merge` for approval. Without it the route
  out of a refusal would end at a pull request the same person could merge,
  which would make "needs approval" mean "open a pull request and merge it
  yourself". The guard asserts the merge is gated, and removing that rule fails
  it.
- Where the default branch cannot be resolved, the review template generates no
  path rules and reports `default-branch-unresolved` rather than falling back to
  an unscoped requirement. An unscoped requirement would read as stronger
  protection while quietly removing the route to review.

- A write refused because it needs approval now carries the route to approval
  instead of ending at a dead end. The gateway is the only place still holding
  the whole attempt when it refuses, so it is the only place that can hand back
  a branch, a commit and a pull request into the branch that refused the change.
  The cost of a refusal — reconstructing the compliant route by hand — is why
  enforcement gets configured and never switched on.
- A route is offered only after every step of it has been put to the same active
  policy set that refused the original, and only when the policy allows all
  three. Effective effect is checked alongside enforcement outcome, so a step is
  permitted because policy permits it rather than because enforcement happens to
  be off. A `deny` has no compliant route by definition and is never given one:
  under a blanket deny the branch write is refused too, which the guard asserts.
- Added `GovernanceStore.resolveActivePolicySetInScope`, a read-only resolver.
  Asking the runtime evaluator whether a route is permitted would append a
  decision to the hash-chained ledger for a mutation nobody performed, so the
  policy set is read in a read-only transaction and judged by the pure
  evaluator. The contract guard slices that method out of the source and asserts
  it contains no insert, update, delete, advisory lock or decision identifier.
- The offer commits to the exact bytes by hash and carries none of them:
  content in an error response is content in a log. The branch is derived from
  the base branch, the path and that hash, so the same change refused twice is
  offered the same branch rather than scattering new ones.
- Taking the route uses the ordinary governed endpoints — branch create, file
  write, pull create — rather than a new privileged path, because the safest
  version of "never a bypass" is not adding a door at all. It is offered, never
  taken automatically, and the editor is left untouched afterwards: the change
  is on another branch, and marking the file clean here would be a comfortable
  lie.
- A step that cannot be evaluated is reported as unevaluated rather than as
  refused. Both mean no route, but only one is a policy decision, and telling an
  operator their policy refused something it never saw sends them looking for a
  rule that does not exist.

### Protected Paths

- Fixed the coverage of path-scoped policy rules. A rule reaches only the paths
  a mutation reports about itself, and three actions reported one:
  `file.rename` reported `from` and `to`, `directory.move` the same,
  `commit.restore-paths` a prefix, and `file.batch` reported item counts and
  hashes but no paths at all, though `normalizeFileBatch` had the whole list in
  hand at that moment. A rule protecting `.github/workflows/**` therefore
  stopped a write and a delete and let the same file be renamed away, moved
  with its directory, or changed inside a batch — and the gateway then recorded
  an allow, correctly, for a mutation the operator believed was blocked.
- Added `src/protected-paths.js`. Every content-changing action now reports the
  complete set of paths it touches together with how completely it knows them:
  `exact` for a set that is all of them, `subtree` for a root whose members are
  not knowable when the gateway decides, and `unbounded` for `commit.revert`,
  `commit.restore` and `branch.reset`, which can rewrite anything and so
  describe themselves as such rather than claiming a narrow set. A path that
  cannot be normalised stops the set claiming to be exact instead of being
  dropped from it, and a set too large for the governance envelope is refused
  with `MUTATION_PATH_SET_TOO_LARGE` rather than trimmed to fit.
- Added a `protected-paths` policy template, "Protected sensitive paths",
  beside the existing baselines. One declared pattern expands deterministically
  into a rule for every action that can change a path, including the
  directories that hold it — a file under `.github/workflows` travels with a
  move of `.github`, so protecting the file means covering its ancestors too.
  The expansion reports what it could not narrow rather than leaving it to be
  discovered, and the generated document states that it records and does not
  block until the policy is activated in warn or block mode.
- The generated-baseline dialog now shows the policy's own description as
  prose above the JSON, with its rule count and enforcement mode. A baseline
  can run to hundreds of rules, and the sentence that matters most should not
  have to be found inside them.

### Interface Correctness and Configuration Discoverability

- Fixed a defect that emptied the workbench from a link. `switchTab` marks the
  chosen tab by toggling `active` against every tab and pane, so a name matching
  no tab did not select nothing, it deselected everything. Deep links carry that
  name straight from the URL, and `/files` — the route form this project's own
  browser tests used to enter the workbench — is one of those names, so ten
  tests had been asserting around an empty screen. Both halves are guarded.
- Replaced the workbench tab strip's horizontal scroll with a wrap. Ten
  destinations wanted 944px in an 835px box, leaving Governance showing 17px of
  its 120 underneath the 18px fade meant to advertise it; the earlier edge fade
  worked as a mechanism and did not solve the problem. The guard now asserts the
  outcome — every tab inside the strip — rather than the apparatus.
- Put the trust summary behind a disclosure below 900px. Five fields of prose
  drew 393px of an 820px screen and pushed the editor's empty state under the
  bottom navigation. The rollup keeps every evidence state on screen, counted
  and named for the weakest present; only the prose costs a tap.
- Made an empty repository stop instructing the reader to pick a file from a
  tree that has none.
- Replaced typed Unicode glyphs with drawn marks across the file tree, the five
  evidence states, six empty states, the five intelligence modes and the
  governance state orbs. A file in the tree had been U+00B7 — a period — at 15px
  in the muted colour. The evidence states became one family of circles rather
  than five unrelated shapes, which also freed the shield for Governance alone.
- Rebuilt the Emergency Shield control on the danger palette. It ran a gradient
  from rose to brand violet, the only one in the product crossing hues, and its
  rose was the literal dark-theme value, so in light mode this one control
  painted from the wrong palette.

### Accessibility Conformance

- Added `scripts/accessibility-audit.js` (`npm run a11y:audit`), which walks
  both themes, both viewports and all ten workbench destinations, keeps findings
  at every impact, and checks pointer target size, focus visibility and reflow.
  The regression suite checks seven points on the golden path at critical and
  serious impact in one theme; Neural, Governance and every destination past
  Editor had never been scanned.
- Fixed what it found: the neural signal filters were 15px targets 14px apart,
  too small for WCAG 2.5.8 and too close for its spacing exception; the replay
  slider input was four pixels tall and eight hundred wide; `.check` boxes were
  18px; and the intelligence-mode list was 774px of destinations inside a 270px
  sideways scroller. Governance did not fit a 320px screen once it had to show
  an error, because `.gov-shell` is a grid whose items keep `min-width:auto` and
  the message carries an unbreakable URL.
- The floating action retracts while the reader moves down the page and returns
  on the way up, near the top, while its menu is open, and on focus. The focus
  restore is in CSS on `:focus-within` rather than a listener, because a control
  that can be focused while invisible is a keyboard trap.

### Configuration Discoverability and Maintenance Mode

- Added `src/config-registry.js` and `scripts/doctor.js` (`npm run doctor`).
  Discovering what a deployment needed meant starting it and reading whichever
  error came first; 112 environment variables across the server, the operator
  scripts and the release-authorization gate were named in no single place. The
  doctor calls the server's own configuration loaders rather than repeating
  their rules, and never prints a value.
- `test/config-registry.test.js` checks the registry against the source in both
  directions and against `render.yaml`, so an entry cannot outlive the code that
  read it and the blueprint cannot configure something nothing reads.
- Implemented `NV_MAINTENANCE_MODE`. The blueprint had set it and a contract
  test had asserted it since it was written, while no code read it — an operator
  flipping it during an incident would have had a documented switch, a passing
  test and a fully serving application. It closes the API with 503 and drains
  readiness while keeping the health check green, because a host recycles an
  instance that fails health.
- Corrected `NV_GIT_HOST_ALLOWLIST` in the registry and the doctor. It is
  checked when a server URL is connected, not at startup, and only for
  self-hosted Git servers; reporting it as a missing production requirement sent
  a reader hunting a value they did not need.

### Continuity State and Release-Identity Correctness

- Added a static identifier-resolution gate (`eslint.config.js`, `no-undef` only)
  that declares the real cross-script global surface of the no-bundler app shell,
  and made `npm run lint` blocking in both the CI and alpha.17 qualification
  workflows.
- Fixed an unresolved identifier in the notification-preferences dialog, where
  `escapeHtml` was called outside the closure that defines it; the four sibling
  governance dialogs already used the app-shell `esc` helper.
- Closed a unit-gate inventory gap: two test programs existed but were never
  executed by the gate chain. Added them (140 to 142 programs) and added a drift
  guard that fails when any discovered `test/*.test.js` is absent from the chain.
- Made the static-asset stamp injective by construction. Deriving it from the
  release-numeric prefix collapsed every 5.3.0 prerelease onto `530`, so a
  returning tester kept a stale service-worker shell cache against a freshly
  deployed server. The stamp now encodes the version's own UTF-8 bytes as
  fixed-width decimal groups and decodes back to the exact version.
- Replaced a hardcoded shell-cache name in the browser matrix and two static
  assertions that passed regardless of the asset stamp, because `express.static`
  ignores the query string.
- Replaced continuity schema 4 with schema 5, which separates shape validation
  from stored values so the record can move as gates advance. Schema 4 accepted
  exactly one frozen position and rejected every legitimate advance as malformed,
  which is why the generated documents kept asserting a state the project had
  already left. Commit identity became a role-tagged set, so one accepted tree
  can be proven through several transport-specific commits. Added ADR-083,
  superseding ADR-071.
- Bound generated gate prose to gate status. The evidence and restriction text in
  `PROJECT_STATE.md` and `CONTINUATION_PROMPT.md` was fixed, so a passed gate
  would have rendered beside prose insisting its evidence was still missing.
- Made the exported `publicAlphaPosition` validate the continuity record before
  returning a release position, so a caller outside the module cannot be told
  `GO` by a hand-built object that never satisfied the gate schema, the run-id
  contract, or the final-release ratchet.

### API Rate Limit Identity

- Fixed the `/api` rate limit counting nothing it could rely on. The bucket key
  was `(getCookie(req, 'nv_session') || req.ip || '').slice(0, 40)` — the
  session cookie as it arrived, which is text the caller controls. Nothing
  required it to unseal, so any value at all opened a fresh 300-request bucket
  and a caller that varied it per request was never limited. A regression test
  sent 301 requests under a cookie that changed each time and received no 429
  at all.
- The same key also reset itself for legitimate callers. `seal` is AES-256-GCM
  with a random 12-byte IV, and 40 base64url characters cover 30 bytes: the IV,
  the whole 16-byte authentication tag, and two bytes of ciphertext. Both of
  those fields are drawn fresh on every seal, so the key held essentially no
  session identity, and every time the server wrote a session back the caller
  returned to zero.
- Those forged keys accumulated in a map whose overflow path deletes
  oldest-first, so unauthenticated traffic could evict the counters of
  authenticated callers as a side effect.
- Added `src/rate-limit-identity.js`, which derives the bucket key from the
  unsealed session rather than the ciphertext. A caller cannot forge a sealed
  payload without `SESSION_SECRET`, so it cannot mint identities; the fields the
  derivation reads — `sid` when a database holds the session, the
  `sessionNonce` when the cookie carries it, the active account before a nonce
  exists — are the ones that survive a reseal. A request with no session, or one
  whose cookie does not unseal, is counted against its address.
- Keys are HMACs under a `RATE_LIMIT_IDENTITY` HKDF purpose, so the bucket map
  holds no session id, nonce or login, and identity parts are length-prefixed
  before hashing so a separator inside a field cannot produce another caller's
  key. The ceiling stays 300, the window stays the same strict minute, and the
  limiter keeps its per-session meaning rather than becoming per-address.
- The webhook limiter is unchanged: it already keys on `req.ip` behind
  `trust proxy`, which a caller cannot choose.

### Overview Card Arrival

- Fixed the overview's cards being read while they were still arriving.
  `nv-arrive` holds a card at opacity 0 with a 22px downward offset until its
  scroll range begins, and the range was written as `entry 5% entry 85%`. A
  percentage of `entry` is a percentage of the card's own travel, so a card only
  finished arriving once its top edge had climbed near the top of the screen.
  Measured on a 727px viewport: a card whose top sat three quarters of the way
  down was at **0.30 opacity with 17px of its offset still applied**, and at
  the middle of the screen it was at 0.48. That is the reading position — so
  the reader was shown a half-transparent card sitting under an empty band.
- Recent activity showed it worst because three things compound there. It is
  the last card, so a reader stops at it instead of scrolling past. Expanding
  its commits makes it taller than the screen, which stretches the distance the
  range is measured against. And expanding it mid-range re-measures that range
  underneath the reader, which is the layer that appeared at the top of the
  card.
- The range is now `entry 0px entry 200px`. Arrival is a fixed distance rather
  than a fraction of the card's travel, so it cannot be stretched by a card
  that outgrows the screen. Measured after the change: the same tall card is
  fully arrived by the time its top reaches three quarters of the way down,
  against 0.30 before.
- The entrance is kept, not removed: a card is still at 0.07 opacity as it
  appears at the bottom edge. `entry` is also kept rather than reverting to
  `cover`, so the last card on the page still reaches its end state instead of
  resting invisible under a gap — the regression this range was rewritten for
  the first time. All three properties are now pinned by
  `test/e2e/overview-card-arrival.spec.js`.
- A percentage range is declared ahead of the length one as a cascade fallback.
  Scroll-driven animations reached WebKit late, and an engine that supports
  `view()` but rejects a length offset would drop the declaration and fall back
  to the initial value — the full `cover` range, which is the behaviour being
  fixed here. The fallback lands such an engine on a range that finishes around
  two thirds of the way down the screen instead. Where both parse the length
  wins; verified in the browser, where `animation-range` computes to
  `entry 0px entry 200px`.

### Step-Up Replay Guard Contract

- Made the step-up replay guard implementable by something other than a `Map`.
  `consumePendingStepUp` rejected any store that was not one — `replayStore
  instanceof Map` — which is a decision about where the guard lives rather than
  what it has to do. A `Map` is per-process, so its guarantee that a grant is
  spent held only for the process that spent it; a second instance would have
  honoured the same grant again, and nothing durable could be passed in to fix
  that.
- Widening the type check alone would not have been enough, and this is the
  part that mattered. The old shape read the guard at the top and wrote it at
  the bottom with the validation in between, which is safe only while the read
  and the write cannot be interleaved — true of a `Map` in one process, false
  of anything asked over a connection. Two requests carrying one grant would
  both get past the read before either wrote, and both would be authorized.
- The guard is now one operation, `consumeOnce({ kind, key, expiresAt, now })`,
  which claims the grant and says whether this caller is the one that claimed
  it. There is no interval to interleave, and the store supplies the
  atomicity — a table does it with an insert whose conflict means "already
  used". A regression test races two consumers of one valid grant against a
  store that takes time to answer and asserts exactly one proceeds.
- Validation now precedes consumption, so a claim naming another action,
  another scope, or no grant at all never reaches the store. Spending a guard
  entry on such a claim would have let anyone who can reach the route burn a
  grant its owner was still entitled to use; a test asserts the store is not
  called at all in those cases.
- A store that cannot answer now denies and reports `STEP_UP_STORE_UNAVAILABLE`
  with a 503, rather than reporting a replay. They are different facts: one
  says try again, the other says this grant is finished, and telling a caller
  its valid grant was spent because a database blinked is a lie it cannot
  recover from. The pending grant survives the failure unspent.
- `consumePendingStepUp` is asynchronous as a result, and its one call site in
  `server.js` awaits it. An un-awaited call assigns a Promise, and a Promise is
  truthy — the sensitive action would run and the audit record reading
  `req.stepUp.action` would write undefined for every field, leaving no trace
  at runtime. `test/security-foundation-server.test.js` pins the `await` at the
  source, and that guard was verified to fail when the `await` is removed.
- The in-memory adapter keeps the semantics the `Map` always had, eviction
  included. A guard that must never be evicted belongs with the durable store,
  which is its own task.

### Durable Single-Use Guards

- Added `nv_single_use_guards` (migration `020`) and `src/single-use-store.js`,
  the durable half of the guard contract the previous change defined. It
  answers `consumeOnce` exactly as the in-memory adapter does and differs only
  in where the answer is kept, so a second process gets the same answer as the
  first.
- One statement decides. Not a `SELECT` and then an `INSERT` — those can be
  interleaved by anything crossing a connection, and two requests carrying one
  grant would both read "unspent" before either wrote. An insert whose conflict
  clause is itself conditional does the reading, deciding and writing in one
  round trip, and PostgreSQL serialises conflicting inserts on the primary key.
  A test asserts a claim is one statement, because that is the property a fake
  database cannot prove on its own: it decides atomically because a real server
  does, so a split implementation would still race correctly against the fake.
- The comparison uses the database's clock, not the caller's. Two instances
  with drifting clocks must not disagree about whether a grant is still alive,
  and the only clock they share is the one attached to the table. The boundary
  matches the in-memory adapter exactly — a record expiring at this instant
  still refuses — because a guard and its replacement disagreeing by one
  millisecond shows up only as an unreproducible replay.
- The table stores a digest, never the grant. A grant id, an OAuth state and a
  restore authorization are each a credential while they live, and a guard
  table is the wrong place to keep a copy of one. The digest is domain
  separated by kind, so one value arriving under two kinds cannot produce one
  key, and the column `CHECK` refuses anything that is not a SHA-256 digest —
  so a caller passing a raw grant fails the insert rather than storing it.
- There is no capacity ceiling, deliberately. The Map being replaced evicted
  its oldest entry once it held ten thousand, so a live grant could be
  forgotten under load and then replayed — a guard that fails open exactly when
  it is under the most pressure. Rows leave when they expire and at no other
  time; the sweep takes a bounded slice of expired rows only, and a test holds
  twenty thousand live guards and asserts the first still refuses.
- Step-up now uses the durable guard whenever `DATABASE_URL` is set, and the
  in-process Map only in the profile allowed to run without a database. Which
  one answers is decided by configuration, never by whether the database
  happens to be reachable: falling back on failure would be the worst of both,
  since every instance would answer "unspent" for a grant another had already
  spent, letting a replay through precisely during an outage. A test pins that
  no failure path reaches the Map.
- The GitHub App OAuth state guard moved onto the same contract. It carried the
  same check-then-set shape — `USED_GITHUB_APP_STATES.has(replayKey)` and then
  `.set(...)` — and the same per-process blindness, so an OAuth state consumed
  on one instance could be redeemed again on another. It is now one claim under
  its own guard kind, and `consumeGithubAppPending` is asynchronous with both
  callback routes awaiting it. An un-awaited claim there would have been a
  truthy Promise, and the callback would have gone on to exchange the code with
  GitHub having verified nothing; a test pins the `await` at the source and was
  checked by removing it.
- A store failure on that path reports `GITHUB_APP_STATE_UNAVAILABLE` with a
  503 rather than a replay, for the same reason as step-up: one is worth
  retrying and the other never is.
- Both guards and the security foundation now share one in-process adapter,
  `memorySingleUseStore`, so the meaning of a claim cannot drift between them.
  It evicts only after the claim it was asked for, so the key being claimed is
  never the one discarded — the previous GitHub App prune ran *before* its
  check, so a capacity eviction could free the very key about to be tested.
- **Fixed the recovery authorization not being single-use at all.** Its check
  and its record sat either side of `await preflightRestoreActions(...)`, a
  series of reads against the provider. Two requests carrying one authorization
  both passed the check while the first was still on the network, both recorded
  it, and both restored the refs. Unlike the other two guards this needed no
  second instance: one process is enough, because an await is all it takes to
  interleave a read and a write. Nothing in the suite asserted the single-use
  property, so nothing noticed.
- The claim is now one operation, and where it sits is the fix: after the
  preflight, so a stale preview still leaves the authorization unspent exactly
  as before; before the first ref is written, so nothing is restored on an
  authorization that was not claimed. Both positions are pinned by tests that
  were checked by moving the claim and watching them fail.
- The guard is no longer reachable directly — a test refuses any
  `USED_RESTORE_AUTHORIZATIONS.set/has/delete` in the server — and a store
  failure reports `RESTORE_AUTHORIZATION_UNAVAILABLE` with a 503 rather than a
  replay.
- One behaviour changes: a token that is both replayed *and* whose preview has
  gone stale now reports `RESTORE_PREVIEW_STALE` rather than
  `RESTORE_AUTHORIZATION_REPLAY`, because the staleness is found first. Both
  are 409 and both tell the reader to regenerate the preview.

### Webhook Delivery Leases

- **Fixed a batch delivering rows whose lease it no longer held.** Deliveries
  are claimed ten at a time under a single sixty-second lease and then sent one
  at a time, each with a ten-second transport timeout. Ten times ten against
  sixty is arithmetic that does not close, and the rows at the back are the
  ones it fails for. `claimWebhookDeliveries` reclaims any row still marked
  `delivering` whose `lease_until` has passed, so another worker takes those
  rows and sends them while the first batch is still working through them — the
  receiver gets the same governance event twice.
- The worker now checks the lease immediately before each send and puts the row
  down instead, reporting it as `released` in the batch summary. Nothing has to
  be written to release it: an expired lease *is* the state that makes a row
  available again. The comparison is `<=`, matching the reclaim query exactly,
  because a boundary the two disagree about is a row one thinks is free while
  the other is still sending it.
- This is deliberately fixed before the send rather than after it. Database
  fencing cannot retract an HTTP request that has already left, so a lease
  check that runs at completion time would record the right thing about a
  delivery the receiver had already been sent twice.
- **Fixed a duplicate delivery on every restart that lands mid-batch.**
  `stop()` cleared the interval and nothing else, so shutdown closed the pool
  underneath a batch still running. A delivery caught that way has already sent
  its request and can no longer record the attempt, leaving its row leased
  until it expires and is sent again. `stop()` now returns the in-flight batch
  so a caller that can wait does, and the shutdown path awaits it before
  closing the pool. The existing ten-second force-exit still bounds this — a
  batch that outlasts it is cut off regardless — but the common case now
  finishes.
- A stopped worker also refuses to begin another batch, which `clearInterval`
  alone did not cover for a directly invoked `run()`.
- None of this makes delivery exactly-once, and it is not meant to. Network
  delivery is at-least-once and receivers must deduplicate on the delivery id.
  What changes is that duplicates now come from genuine retries rather than
  from a worker racing itself.

### Live Stream Backpressure

- **Fixed a stalled live-event reader growing the server's memory without
  bound.** Every SSE write went out as `try { client.write(...) } catch {}`,
  and that catch does nothing for the failure it looks like it is guarding: a
  response stream does not throw when the reader stops reading. `write()`
  returns `false` and Node buffers the payload in memory until it can be sent.
  A paused tab, a phone that lost signal, a proxy that stalls — the socket
  stays open, the writes keep being accepted, and nothing in the process ever
  finds out. The default admission ceiling is a hundred streams.
- The download path already knew this and awaits `'drain'` before its next
  chunk, but an event fan-out cannot wait: it runs inside a request that has
  its own work to finish, and one stalled reader would hold up everyone else's
  events. So a reader that has fallen past a byte bound is disconnected
  instead.
- Disconnecting is safe here precisely because it loses nothing. Intelligence
  events are persisted and the browser reconnects and resumes from its cursor —
  the same path it takes after any dropped connection. Ending the stream is
  what tells it to. Silently skipping the write would not: the client would sit
  on an open socket believing it was current, which is the outcome worth
  avoiding.
- The bound is checked before the write rather than after. After is too late —
  the payload crossing the line has already been taken into memory, and a
  single large event would be accepted however far behind the reader was.
- The keepalive is bounded too, and is what notices a stalled socket on an
  otherwise idle stream: a reader subscribed to a quiet repository takes no
  events, but still takes one keepalive every fifteen seconds.
- `write()` returning `false` is deliberately *not* the signal — that happens
  routinely on healthy connections. Accumulated bytes are.

### Type Checking Without a Build Step

- Added `npm run typecheck`: `tsc --project jsconfig.json`, with `allowJs`,
  `checkJs` and `noEmit`. Nothing is compiled and nothing is produced — the
  checker reads the JavaScript that already runs. `npm start` keeps its
  meaning, `index.html` keeps its unbundled script tags, and no file changes
  language. TypeScript is pinned exactly as a development dependency, like
  every other dependency here, so the gate cannot be a network call.
- **33 of the 51 modules in `src/` are checked from the first commit**, chosen
  because they and their imports already pass. The gate is therefore green
  immediately and any red is a regression rather than inherited debt.
- The set is listed file by file rather than globbed, and that is forced rather
  than preferred: `exclude` does not stop a file being checked when something
  in the set imports it, so a glob minus a deny-list reports errors in files it
  claims to have excluded. An explicit list is the only honest way to say what
  is covered. The remaining eighteen are not suppressed — no `any`, no
  `@ts-nocheck` — they are simply not listed yet.
- Turning it on required documenting the shape of the step-up guard's pending
  state and the single-use store's claim, since the checker could not infer
  through their default-parameter destructuring. Those are contracts worth
  writing down anyway.
- `maxNodeModuleJsDepth: 0` is set deliberately: without it, module resolution
  finds the userland `events`, `punycode` and `string_decoder` packages sitting
  in `node_modules` as transitive dependencies and type-checks *their* source,
  reporting dozens of failures in code this repository neither owns nor can
  fix. `skipLibCheck` does not cover them — it skips `.d.ts`, and those are
  `.js`.
- Both workflows run it immediately after `lint` and before anything expensive,
  and both orderings are pinned by contract tests that were checked by moving
  the step after the browser gates and watching them object. A type error found
  after fifteen minutes of Playwright has been paid for at the wrong price.
- `test/typecheck.test.js` runs the checker rather than grepping for a script
  name: it copies a checked module into a disposable fixture, injects a real
  type error, and asserts a nonzero exit **and that no file was emitted**.

### Route Surface Characterization

- Added `test/route-surface.test.js`, which pins what a caller observes from
  every `/api/security` route: the status and code an anonymous caller gets,
  and the status and code a session gets. Each expectation was taken from the
  running server rather than read off the handler, so a route that never
  behaved the way its source reads is captured as it really is.
- It is deliberately **not** an inventory of methods and paths. A list of routes
  that still exist cannot tell you that one of them lost its `auth`, its
  capability gate or its repository check — the path is still there, still
  answers, and now answers anyone. Removing `auth` from
  `/api/security/sessions` was checked against this test and it objects.
- Behaviour cannot see everything, so the middleware chain is also read as
  text. Dropping `capabilityAccess('upload-security')` from scanner-status
  changes no status any cheap fixture can produce — verified by removing it and
  watching the behavioural half stay green — so the structural half catches
  that one. Neither half is sufficient alone. The source is searched wherever
  these routes live, so moving them out of `server.js` cannot quietly turn the
  structural half into a check of an empty string.
- **Measured the extraction cost of every API route group before extracting
  anything**, and the result contradicts the plan. `/api/security` is 89 lines
  of handler requiring 22 injected dependencies — 4.0 lines per dependency,
  near the bottom of the table — and 1.3% of `server.js`, while containing the
  route that mints step-up grants. `/api/github-app` is 7.7 lines per
  dependency across 240 lines, and `/api/repo` is 20.5 across 2,028 lines, or
  29% of the file. The plan chose `/api/security` for being cohesive by name;
  cohesion by name is not cohesion by dependency. The extraction itself is
  therefore held pending that decision, while the characterization test that
  makes any extraction safe is not.
- **Declined the route-prefix extraction on the evidence, and shipped the half
  that changes the trajectory instead.** Every candidate group needs between 22
  and 99 of `server.js`'s top-level bindings passed in to work. That dependency
  count is the finding rather than an obstacle to route around: routes and
  helpers here are entangled, and moving routes behind a large injected
  dependency object relocates the entanglement across a parameter list without
  reducing it. Extracting *logic* reduces it — `src/single-use-store.js`,
  `src/live-stream.js` and `src/rate-limit-identity.js` each did, and each left
  what remained smaller and separately testable.
- Added a growth ratchet: `server.js` may not register more than the 147 routes
  it holds today, and the ceiling may not drift more than five below the real
  count without being tightened. It is a speed bump with a message rather than
  a proof, and says so — a hardcoded count proves nothing about the code it
  guards. What it does is make growing the file a deliberate act with a diff
  line attached rather than the path of least resistance. A route module under
  `src/routes/` that nothing mounts also fails, because a module that reads as
  covered and serves nothing is worse than no module.
- Closed a vacuity trap in the guards added earlier in this branch. Each one
  scans `server.js` line by line for a call that must be awaited, and a loop
  that finds nothing passes — so moving any of that code out of `server.js`
  would have left four security guards reporting success while checking an
  empty string. All four now assert they found at least one call, verified by
  renaming the call sites and watching them object.

### Shared Rate Limits

- **A limit of N now means N across every instance, not N per process.** Both
  limiters counted in module-scope Maps, so adding an instance loosened the
  ceiling — the opposite of what a limit is for. `nv_rate_limit_buckets`
  (migration `021`) and `src/rate-limit-store.js` count in one conditional
  upsert, and PostgreSQL serialises conflicting inserts on the primary key, so
  two simultaneous requests cannot both read N and both write N+1.
- **Two layers, and the local one exists to protect the shared one.**
  Consulting a shared counter is a query, and a limiter that queries once per
  request hands an attacker a way to turn a flood of cheap HTTP into a flood of
  database work — against a pool of three connections on a free plan. So once
  the shared counter refuses a caller, the process remembers until their window
  closes and refuses again without asking anything. **The caller sending the
  most requests is the one costing no queries at all.** An absolute local
  ceiling sits above that for the case the shared counter never refuses because
  it cannot answer.
- Both window boundaries are preserved rather than unified. The API window
  reopens once *more than* sixty seconds have passed; the webhook window once
  sixty seconds *have*. They differ by one millisecond a minute and only
  because both were written by hand — but silently rounding them together is
  how an unreproducible 429 gets created, so each keeps its own comparison and
  a test pins both.
- A counter that cannot answer refuses with `RATE_LIMIT_UNAVAILABLE` (503)
  rather than falling back to the local count, which would answer "well within"
  on every instance that has not seen the caller. A test refuses any failure
  path that calls `next()`.
- No capacity ceiling. The Map discarded its oldest entry past five thousand,
  so a caller near their limit could be forgotten under load and start again —
  a limit failing open exactly when the most traffic is arriving. A test holds
  twenty thousand counters and asserts the first still has its count.
- The identity is a digest and the namespaces are closed, so the API budget and
  the webhook budget can never be the same row, and a caller identity cannot
  reach the table by mistake.

### Multi-Instance Proof

- Added `test/multi-instance-contract.test.js` and the `test:multi-instance`
  gate: **two real server processes against one PostgreSQL database, one set of
  keys.** Everything else in this work is proved against a fake database or a
  source assertion. Those catch the mistakes they were written for, but none of
  them can settle the actual claim — a limit that is N *per instance* and a
  grant spendable once *per instance* pass every unit test in the repository.
- It refuses rather than skips without a server, for the same reason the
  migration gate does: a gate that quietly passes when its dependency is
  missing is the same as not having the gate.
- **Executed, not just written.** A PostgreSQL server was installed in the
  development container, and against it: all 21 migrations applied, verified
  and re-applied clean — the first real execution of `020` and `021`, which had
  until now only ever met a fake. Then all three guard kinds proved single-use
  across two connections, two simultaneous claims of one grant resolved to
  exactly one winner, a ceiling of 10 held at 10 across two connections rather
  than 20, **two real server processes shared one 300-request ceiling over
  HTTP**, and the no-database profile still booted and served.
- The run also surfaced the fail-closed path under a genuine outage. The local
  server speaks no TLS, so the first attempt saw every request answered 503 by
  the limiter and the flood stopped at the local ceiling — the shared counter
  refusing rather than permitting when it could not answer, which no unit test
  had exercised against a real connection failure.
- Added `docs/architecture/2026-09-21-multi-instance-state.md`: what is shared
  and why, what is deliberately local and why sharing it would be wrong, the
  one ceiling that is still per instance (`LIVE_CLIENTS`, so an operator
  reading the configured number is reading half the true one), the four things
  a deployment must provide, restart semantics, and an explicit statement that
  none of this claims the application has been run on two instances in
  production.

### Key Separation and Dependency Determinism

- Gave every keyed construction its own HKDF-SHA256 derived key. One
  `SESSION_SECRET` previously backed the session cookie, CSRF tokens, step-up
  grants, GitHub App OAuth state, the evidence-ledger hash chain and the
  governance audit secret, while its SHA-256 digest served simultaneously as the
  AES-256-GCM session key and as the HMAC key for offline cache scopes and for
  GitHub App state replay detection. Nothing was exploitable, because the
  message shapes are disjoint and the token codec tags its own kind inside the
  signed payload, but that safety was an unwritten invariant rather than a
  property of the design. The snapshot-signing reuse check still compares
  against the raw secret, which is what it exists to do.
- Pinned every dependency to an exact version and made the lockfile agree.
  A lockfile does not make a range safe: `npm ci` honours the lock but
  `npm install` re-resolves and silently rewrites it, and `express ^4.19.2` had
  already drifted to 4.22.2 and `pg ^8.11.5` to 8.22.0 with no deliberate
  upgrade. Added a contract guard that rejects any range and any disagreement
  between the declared version and the locked one.
- Kept existing evidence chains provable across that key rotation. The ledger is
  tamper-evident, so a record that cannot reproduce its hash is reported as
  tampering; changing the hashing key would have made every record written
  under the old one accuse itself on first deploy. Verification now tries the
  active key and then the retired one and reports which matched, the same shape
  the snapshot signatures already use, and the export states how many records
  verified under the retired key.
- Made that retired key opt-in rather than permanent. Accepting the raw session
  secret forever would have undone half the point of separating it, leaving a
  leaked `SESSION_SECRET` able to forge evidence that verifies. Production now
  accepts it only when `NV_EVIDENCE_LEGACY_SESSION_KEY=true`, matching the rule
  already applied to legacy snapshot keys, and development keeps the
  compatibility path. A deployment that declines the opt-in while still holding
  pre-separation records is told so: verification reports `legacyKeyRequired`
  rather than a bare failure, so an unmigrated chain is distinguishable from
  tampering.
- Kept evidence provable across a `SESSION_SECRET` rotation. The evidence key is
  derived from that secret, so rotating it moved the derived key and every
  record written under the old one stopped reproducing its hash — the same false
  alarm the retired key already prevented for pre-separation records, reachable
  through nothing worse than routine key hygiene. Operators now carry previous
  secrets forward in `NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON`, bounded to
  eight, and malformed input fails at startup rather than silently shrinking the
  keyring.

### Documentation Truth Architecture

- Separated current, vision, architecture, release, operations, qualification,
  reference, historical, and development records under `docs/`.
- Made `WORK_CONTINUITY.json` schema v4 the machine-readable state authority and
  generated project state and continuation instructions deterministically.
- Recorded the exact green alpha.17 automated baseline while keeping the
  documentation successor, live providers, hosted environment, manual
  accessibility, and public alpha explicitly unqualified.
- Recovered the broader founder vision with implemented, committed-roadmap,
  exploratory, and out-of-current-scope maturity labels.
- Preserved historical Task reports/specifications and imported three approved
  public-alpha plans with their original SHA-256 values.

## 5.3.0-alpha.17.0

- Began the controlled hosted public-alpha successor from the qualified alpha.16.3 archive.
- Preserved alpha.16.3 and Task 21 evidence as immutable predecessor records.
- Added explicit provider/deployment capability truth and public-alpha release gates.
- Made the continuity collector accept verified detached CI checkouts while retaining named-branch mismatch, accepted-boundary ancestry, and worktree-state enforcement.
- Added a real temporary-Git regression covering detached JSON and human-readable continuity output.
- Published that four-file correction as sandbox commit `7f721a770df8e658e00163e05ebc259502f99c09`; qualification run `31314330832` then failed safely before authorization because its two-commit checkout could not prove ancestry from the older accepted boundary.
- Required full Git history for the automated qualification job and added an explicit continuity preflight before dependency installation so a future checkout regression fails early with a direct diagnostic.
- Added real-Git negative regressions proving a wrong named branch and an unrelated detached commit remain rejected.

## 5.3.0-alpha.16.3 — Gitea File Mutation Compatibility (Phase 1 Task 21 in progress)

- Preserved alpha.16.1 and alpha.16.2 as immutable failed release candidates.
- Reproduced alpha.16.2's live Gitea HTTP 400 at the real server boundary: the shared GitHub path attempted `POST /git/blobs`, while Gitea file writes are exposed through `/contents/{filepath}`.
- Added a provider-specific Gitea file mutation adapter for create, update and delete without changing GitHub or GitLab transports.
- Creates a disposable branch from the exact expected head, mutates it through the Gitea Contents API, moves the target branch with a non-forced old/new commit compare-and-swap, verifies the resulting head and cleans the disposable branch.
- Added preflight stale-head and post-preflight compare-and-swap race regressions, plus real-server create/delete coverage that rejects every mutating `/git/*` request.
- Made normalized Gitea governance scopes idempotent so warn-mode policy-evaluation fallback does not fail before provider transport.
- Requires a new immutable alpha.16.3 archive, checksum and fresh Node 22 and live Gitea evidence before the gate can open.

## 5.3.0-alpha.16.2 — Gitea Compatibility Correction and Release Requalification (Phase 1 Task 21, release-blocked)

- Preserved immutable alpha.16.1 and its final Task 20 result of 18 passed, 1 failed and 0 unexecuted.
- Added one provider-aware repository-branch normalizer: GitHub reads `commit.sha`; GitLab and Gitea read `commit.id`.
- Routed GitHub, GitLab and Gitea repository detail responses through the same tested normalization boundary.
- Added an independent three-provider regression, including missing-commit behavior.
- Classified the reported high-severity advisory as a dev-only Archiver traversal chain; the production audit is clean and the release packager does not invoke the vulnerable glob path.
- Kept the lockfile unchanged because npm reports no available fix and no supported runtime path is reachable.
- Made release archives byte-deterministic by appending the already sorted file bytes to Archiver in order instead of allowing asynchronous file reads to reorder ZIP entries.
- Added a four-build byte-identity regression and made it part of the default test suite.
- Produced immutable candidate SHA-256 `1a83ddc3a94a42caa5c252e2a4833788c31f540ec8c21860e5aa333d22493564`.
- Passed the credential-free Node 22 candidate matrix, then failed live Gitea requalification during the bounded file write with HTTP 400 because the shared path used Gitea's read-only Git Data API.

## 5.3.0-alpha.16.1 — Candidate-Bound Staging Evidence Hardening (Phase 1 Task 20 in progress)

- Upgraded Task 20 evidence to schema `1.2.0` and bound every record to the exact candidate, catalog, prescribed command/procedure, and verified pass/fail artifact files.
- Made report hashing reproducible across verification times while evidence remains fresh.
- Added a dependency-aware independent test-matrix runner with per-program classification and hashed output.
- Replaced presence-only browser checks with behavioral keyboard, mobile Governance, Cache Storage, and offline-failure assertions.
- Added ADR-054. Task 20 remains incomplete, the staging gate remains closed, and Task 21 remains blocked.

## 5.3.0-alpha.16 — Fail-Closed Staging Validation Checkpoint (Phase 1 Task 20 in progress)

- Added immutable Task 20 validation catalog, canonical evidence schema and deterministic gate report hash.
- Added blocked evidence-plan generation and verification CLI.
- Added browser/accessibility staging specifications and CI contracts.
- Task 20 remains incomplete until live runtime, browser, Neon, provider, destructive and delivery evidence passes.

## 5.3.0-alpha.15 — Governance Notifications, Webhooks and Signed Audit Exports (Phase 1 Task 19)

- Added migration 013 with immutable governance event outbox, notification preferences, webhook configurations, delivery attempts and signed export records.
- Added versioned credential-free event schemas, HMAC-signed webhook payloads and bounded JSON/CSV evidence envelopes.
- Added SSRF-safe webhook validation, DNS revalidation, TLS address pinning, bounded retry/dead-letter behavior and one-time secret rotation.
- Added live-only notification, webhook and export workflows to the Governance interface.
- Added ADR-051 and ADR-052; Task 20 is the next alpha.16 checkpoint.
- External customer-controlled evidence storage remains Phase 5 and was not implemented.

## 5.3.0-alpha.14 — Full Mutation Coverage and Bulk Operation Governance (Phase 1 Task 18)

- Added the immutable machine-readable repository mutation route/action inventory and execution-contract catalog.
- Added provider-write ceilings and deterministic operation IDs inside the Central Mutation Gateway.
- Added bounded, target-bound file-batch normalization with ordered item IDs, batch hash, payload ceiling and required expected branch head.
- Bound recovery policy/exception evaluation to the exact sealed branch-action set and exposed per-item partial outcomes.
- Classified Git receive-pack and Git LFS batch/upload/verification side effects explicitly.
- Added static route/helper coverage, gateway execution and bulk-security regression contracts.
- Added ADR-049 and ADR-050 and set Task 19 as the next alpha.15 checkpoint.
- Added no database migration, dependency, notification/export implementation or external evidence storage.

## 5.3.0-alpha.13 — Policy Digital Twin Interface (Phase 1 Task 17)

- Added one accessible, responsive repository Governance workspace over the Task 16 repeatable-read Digital Twin.
- Added a credential-free server access projection containing only exact repository scope, verified human login, execution type, bounded capability booleans and evidence expiry.
- Added a pure XSS-safe `public/governance-ui.js` renderer for current, proposed, effective and historical policy evidence, including loading, empty, partial, stale and error states.
- Added live workflows for policy creation, server-derived baselines, drafts, immutable versions, simulation, reviewer decisions, activation/rollback, exceptions and decision-chain evidence.
- Kept all governance data network-only and memory-only; repository/account transitions and authoritative read-model changes clear stale client evidence.
- Added authorization-expiry control disabling, complete-versus-limit-bounded verification messaging, responsive layouts, reduced-motion support and labelled focus-contained dialogs.
- Added Task 17 access, renderer, client, workflow, server and UI contracts with no new dependency or database migration.
- Added ADR-048 and set Phase 1 Task 18 as the next alpha.14 checkpoint.

## 5.3.0-alpha.12 — Policy Templates, Repository Baselines and Digital Twin Read Model (Phase 1 Tasks 15–16)

- Added immutable versioned built-in policy templates with deterministic catalog, template and document hashes.
- Added observe-only repository baseline generation from bounded server-resolved facts with exact provenance and readiness warnings.
- Added explicit branch-data completeness and protected-branch truncation evidence and deterministic rules for all resolved protected branches.
- Kept exact baseline generation available in read-only safeguard mode and corrected Gitea branch pagination to prevent silent incomplete facts.
- Added a reader-authorized, credential-free Policy Digital Twin projection derived in one PostgreSQL repeatable-read read-only transaction.
- Added current, proposed, effective and historical sections with active drafts, review state, activation evidence, active-exception summaries, histories, pagination, freshness and completeness.
- Prevented evidence hashes from different activations being combined and prevented truncated history pages from defining operational totals.
- Added four no-store governance read routes without adding a database migration or final UI.
- Added ADR-046 and ADR-047 and set Phase 1 Task 17 as the next alpha.13 checkpoint.

## 5.3.0-alpha.11 — Exceptions, Waivers and Expiry Workflow (Phase 1 Task 14)

- Added immutable, exact-scope policy exception and waiver requests bound to the verified human requester and exact canonical mutation target, with separate author request and administrator approval/rejection.
- Added administrator revocation, synchronous expiry and active-policy-version supersession.
- Added migration `012_governance_exceptions.sql` with append-only request/event tables, composite policy/version constraints, bounded target JSON and deterministic target hashes.
- Added three Central Mutation Gateway actions and repository-scoped governance API routes.
- Added wrong-actor and wrong-target rejection, including verified-human binding for optional GitHub App execution.
- Applied approved records only to covered matched rules, preserving original/effective results, subject identity, target hash and exact runtime evidence.
- Added a 100-active-exception bound per repository/action with serialized approval and runtime overflow detection.
- Preserved historical alpha.10 decisions by retaining engine version 1 and control catalog `1.0.0`; Task 14 uses engine version 2 and catalog `1.1.0`.
- Fixed point-in-time approval/revocation races by evaluating both against one post-lock operation timestamp.
- Updated continuity documents and set combined Phase 1 Tasks 15–16 as the next alpha.12 checkpoint.

## 5.3.0-alpha.10.1 — Planning Records: External Evidence Retention and Provider Scope

- Inserted Phase 5 — Customer-Controlled Evidence Retention under later phases without changing Phase 1 or Task 19.
- Added ADR-041 for future S3-compatible, integrity-preserving customer-controlled evidence storage after Task 19.
- Added ADR-042 recording that Bitbucket remains intentionally unsupported pending concrete customer demand.
- Updated continuity and package contracts for 42 sequential ADRs, four later roadmap phases and the alpha.10.1 canonical package.
- Made no runtime, database, provider, enforcement or Phase 1 sequencing changes; Task 14 remains the next implementation checkpoint and alpha.11 remains reserved for it.

## 5.3.0-alpha.10 — Runtime Policy Enforcement and Control Evidence (Phase 1 Tasks 12–13)

- Hardened deployment with cursor-paginated runtime decision history, repeatable-read chunk verification, a 100-active-policy preflight/activation bound, scoped evaluator-failure logs, and accurate mixed rollout warning evidence.

- Integrated deterministic active-policy evaluation into the Central Mutation Gateway before every registered provider write.
- Added backward-compatible `observe`, bounded `warn`, and pre-provider `block` rollout modes.
- Preserved historical policy hashes by leaving absent legacy enforcement fields absent and interpreting them as observe.
- Added repository-scope shared/exclusive active-policy-set locking across runtime evaluation, activation and rollback.
- Added immutable descriptor-bound policy decisions with active version, document hash, head revision, effect and rollout evidence.
- Added migration `011_governance_policy_decisions.sql` with append-only triggers and relational/JSON consistency constraints.
- Added reader-authorized decision history and HMAC-chain verification endpoints.
- Added a versioned server-side control catalog with deterministic `supports` mappings and explicit unmapped actions.
- Added validated `NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn|block`; Render defaults to warn for initial rollout.
- Kept governance recovery/control-plane mutations non-blocking at the policy layer, including evaluator failures, while preserving existing authorization and lifecycle controls.
- Added bounded policy outcome headers and non-secret runtime failure logs.
- Updated deployment guidance, continuity artifacts and set Phase 1 Task 14 as the next alpha.11 checkpoint.

## 5.3.0-alpha.9 — Evidence-Backed Policy Activation and Rollback (Phase 1 Task 11)

- Added activator-authorized policy activation, rollback and activation-history APIs.
- Added critical Central Mutation Gateway actions for activation and rollback with verified human attribution.
- Recomputed reviewed Task 9–10 simulation evidence against the current target and active baseline before every write.
- Required final Task 8 approval, no rejection, exact policy-head revision and fresh level-50 repository authority.
- Revalidated activator evidence after policy/review lock acquisition to prevent lock-wait expiry races.
- Added immutable migration `010_governance_activation_evidence.sql` with same-policy composite provenance.
- Added atomic activation event, policy-head transition, evidence persistence, HMAC audit append and idempotent response capture.
- Required rollback targets to have prior evidence-backed activation and preserved source activation provenance.
- Added canonical no-policy baseline verification and bounded activation-specific input/error contracts.
- Preserved PAT, OAuth, optional GitHub App, GitLab, Gitea, Render Free and optional Neon compatibility.
- Updated continuity documents and set combined Phase 1 Tasks 12–13 as the next alpha.10 checkpoint.

## 5.3.0-alpha.8 — Policy Simulation and Explainable Impact (Phase 1 Tasks 9–10)

- Added a deterministic, read-only policy simulation engine using the Central Mutation Gateway action registry.
- Added bounded repository mutation scenarios with exact registered actions and credential/raw-content rejection.
- Added exact rule matching, deterministic effect precedence, conflict evidence and default-allow simulation behavior.
- Added active-policy or no-policy comparison with strengthened, relaxed and unchanged impact classifications.
- Added repository scope, scenario-set, evaluation, result and complete simulation hashes.
- Added action-class, risk-level, unsupported-action and bounded warning evidence for later activation review.
- Added a reader-authorized simulation API route with no provider, governance-store, audit or mutation-gateway write.
- Reverified stored immutable policy document hashes before simulation.
- Preserved PAT, OAuth, optional GitHub App, GitLab, Gitea, Render Free and optional Neon compatibility.
- Updated continuity documents and set Phase 1 Task 11 as the next alpha.9 checkpoint.

## 5.3.0-alpha.7 — Reviewer Assignment and Approval Workflow (Phase 1 Task 8)

- Added repository-scoped reviewer self-claim from fresh server-derived reviewer authority.
- Added immutable reviewer assignments and immutable approve/reject decisions.
- Added deterministic pending, approved, rejected, quorum, and terminal review state.
- Enforced author/reviewer separation when configured and required rationale for rejection.
- Preserved optional GitHub App installation/human identity separation and PAT/OAuth/GitLab/Gitea compatibility.
- Added Central Mutation Gateway actions `governance.reviewer.assign` and `governance.approval.decide`.
- Added optional hashed idempotency for reviewer claims and decisions.
- Added append-only migration `009_governance_reviews.sql`.
- Excluded legacy unassigned approval primitives from Task 8 review and future activation counts.
- Added bounded review input, stale-evidence, credential-text, scope, concurrency, finality, and retry protections.
- Updated continuity documents and set combined Phase 1 Tasks 9–10 as the next alpha.8 checkpoint.

## 5.3.0-alpha.6 — Governance API and Policy Draft Workflow (Phase 1 Tasks 6–7)

- Added one authenticated, repository-scoped governance API authorization boundary.
- Added durable author-owned policy drafts with optimistic revisions.
- Added atomic submission into ordered immutable policy versions and linked audit evidence.
- Added four Central Mutation Gateway governance actions with verified human attribution.
- Added optional hashed, transactionally isolated idempotency for governance writes.
- Added migration `008_governance_drafts.sql`.
- Added optional stable `NV_GOVERNANCE_AUDIT_SECRET` configuration.
- Preserved GitHub PAT/OAuth, optional GitHub App, GitLab and Gitea compatibility.
- Corrected case-sensitive self-hosted Gitea scope comparison and rejected prototype-control keys in governance JSON.
- Updated continuity documents and set Phase 1 Task 8 as the next implementation gate.

## 5.3.0-alpha.5 — Provider Permission and Governance Role Resolver (Phase 1 Task 5)

- Added deeply immutable, credential-free repository authorization snapshots.
- Added server-derived GitHub PAT/OAuth, GitLab and Gitea permission normalization.
- Kept GitHub App installation capability separate from verified human governance authority.
- Added exact GitHub App repository-selection proof before human role resolution.
- Added conservative reader, author, reviewer, activator and administrator derivation.
- Kept GitLab Maintainer distinct from Owner to prevent privilege inflation.
- Added bounded fail-closed evidence states, cache expiry, identity isolation and request coalescing.
- Added snapshot consistency, sensitive-field, repository-scope and mutation-actor validation.
- Attached authorization evidence to every Central Mutation Gateway descriptor without enabling policy enforcement yet.
- Updated continuity documents and set Phase 1 Task 6 as the next implementation gate.

## 5.3.0-alpha.4 — Central Mutation Gateway Foundation (Phase 1 Task 4)

- Added a canonical registry of 28 repository mutation actions.
- Added immutable provider-authority/repository/actor/route-bound mutation descriptors.
- Added `AsyncLocalStorage` execution context for route-to-provider propagation.
- Added fail-closed write assertions to GitHub, Gitea, GitLab, Git push, and Git LFS paths.
- Added action-to-provider-operation binding to prevent same-repository authority confusion.
- Preserved Task 1 step-up proof requirements for deletion, hard reset, and pull merge.
- Added bounded credential-free mutation metadata and minimized lifecycle events.
- Added exact route-coverage, action-binding, continuity, syntax, and package contracts.
- Added self-contained project state, 21-task roadmap, architecture decisions, and continuation prompt.
- Preserved PAT/OAuth/GitLab/Gitea connectivity and optional GitHub App authentication.

## 5.3.0-alpha.3 — Governance Persistence Foundation (Phase 1 Task 3)

- Added provider-authority/repository-scoped governance policy identities that support genuinely distinct authors, reviewers, and activators.
- Added bounded schema-v1 policy documents with deterministic canonicalization, unique rule IDs, explicit effects, and SHA-256 content hashes.
- Added immutable ordered policy versions, immutable reviewer decisions, transactional active-version heads, activation history, and rollback provenance.
- Added default separation of duties, one decision per reviewer identity, rejection gates, approval thresholds, and decision finality after activation.
- Added optimistic policy revisions plus PostgreSQL advisory/row locking for concurrent review, version, activation, rollback, and audit operations.
- Added an HMAC-linked, sequence-ordered governance audit chain with complete/partial verification status.
- Added database triggers that reject UPDATE, DELETE, and TRUNCATE on policy versions, approvals, activations, and governance audit history.
- Added sensitive-field and size rejection so credentials cannot be persisted in policy or audit JSON.
- Added governance model, migration, store, concurrency, rollback, finality, audit-chain, release, and regression tests.

## 5.3.0-alpha.2 — Optional GitHub App Foundation (Phase 1 Task 2)

- Added opt-in GitHub App configuration that fails safely when absent or incomplete.
- Added signed, session/identity-bound, expiring, single-use user-authorization and installation-claim state.
- Added authorizing-user verification and installation ownership checks before local registration.
- Added a server-only GitHub App JWT and short-lived installation-token broker with refresh margin, request coalescing, and cache invalidation.
- Added a single provider-credential boundary so stored GitHub App accounts remain tokenless while PAT, OAuth, GitLab, and Gitea behavior stays compatible.
- Added optional Neon installation metadata and non-secret lifecycle audit tables.
- Added Settings UI for installation scope, authorizer, health refresh, reauthorization, and local disconnect.
- Added configuration, broker, ownership, persistence, server, disabled-mode, UI, and regression tests.

## 5.3.0-alpha.1 — Phase 1 Security Foundation (Task 1)

- Added signed, session- and active-identity-bound CSRF tokens for authenticated unsafe API requests.
- Added Fetch Metadata and explicit Origin enforcement while retaining the existing application-request header.
- Added five-minute, action- and scope-bound, single-use step-up authorization grants.
- Added provider-backed confirmation for repository deletion, hard reset, pull-request merge, and revoking other sessions.
- Added bounded replay protection for parallel requests and cleared grants before sensitive handlers execute.
- Preserved PAT, OAuth, GitLab, and Gitea flows; GitHub App remains optional.
- Added security-foundation unit, integration-contract, and server-smoke coverage.

> Prerelease note: this is Task 1 of the approved 21-task Phase 1 plan, not the final v5.3 release.

## 5.2.2 — Phase 0 Stabilization

- Adopted **Nebulaverse-X** as the official package, UI and Render service name.
- Made `package.json` the single authored release-version source.
- Replaced the shared permanent API cache with opt-in, repository-scoped, account/session-isolated offline caches.
- Added 24-hour TTL, 100-entry, 1 MiB object and 25 MiB total private-cache limits.
- Added identity-boundary cache purging and fail-safe local logout cleanup.
- Added numbered, checksummed Neon migrations with an advisory lock.
- Added release hygiene, deterministic ZIP packaging, CI and browser-regression foundations.

## 5.2.0 — Verified Intelligence Edition

### Added

- GitHub webhook creation and HMAC-SHA256 raw-payload verification
- Neon-backed normalized intelligence-event history
- Authenticated Server-Sent Events for Neural live updates
- Deterministic repository-event risk scoring with explicit reasons
- Shortest-path “Explain this connection” graph analysis
- Shadow Access Radar for collaborators, deploy keys, webhook posture, and deterministic access risk
- Stable timestamp/event-ID event cursors with persisted SSE catch-up
- JSON/CSV/Markdown activity export including available verified intelligence events
- Upload-scanner posture nodes in the Neural Security/Dependencies views
- Snapshot comparison, restore-impact preview, typed recovery confirmation, short-lived preview authorization, replay rejection, and stale-branch preflight
- Signed server-side Emergency Shield containment manifest
- Whole-file built-in upload signature scanning and optional administrator-managed bounded YARA adapter
- Persistent read-only, synchronization-freeze, and protected-path state
- Folder and wildcard protected-path policies
- Signed reference/file-manifest snapshots with verification status
- Chained evidence records and JSON evidence export
- `/readyz` database-readiness endpoint
- Event/session retention maintenance
- Indexed session ownership for complete identity-scoped containment
- Bounded ZIP/archive preflight before decompression
- Bounded evidence-chain records in JSON export
- Explicit partial snapshot and dependency-scan availability states
- Webhook delivery abuse limiting
- Repository vulnerability alert event support

### Security
- Neutralized spreadsheet formula injection in downloaded CSV activity reports and added dedicated regression tests.

- JSON/CSV activity export neutralizes spreadsheet formula injection in provider-controlled cells

- Network-only service-worker handling for all authenticated APIs
- Markdown preview fails closed when DOMPurify is unavailable
- Stronger CSP with `object-src`, `base-uri`, and `form-action`
- Exact vendor/font proxy allowlists and bounded upstream response sizes
- Configured Neon sessions fail closed during database outages
- Parent-folder restore/move policies are evaluated against every affected child path
- Repository-local drafts, recents, snapshots, incidents, and queued writes are purged at logout/account boundaries
- Provider avatar attributes and label colors are escaped or format-constrained before HTML insertion
- Graceful SIGTERM/SIGINT shutdown closes live streams and the Neon pool
- Production webhook callback no longer trusts an arbitrary Host header
- Case-insensitive protected-repository matching
- Public npm registry lockfile URLs

### Preserved

- Render Free web service
- Existing optional Neon database
- Existing GitHub/GitLab/Gitea features
- SmartPush/Git LFS, Time Machine, safeguards, dependency audit, and Neural UI

### Known boundaries

- GitHub-only verified webhooks in v5.2
- Provider-side protected-path enforcement not yet automated
- Signed snapshots are not complete off-platform backups
- Full isolated antivirus/malware sandbox worker not included; optional local YARA adapter is disabled by default
