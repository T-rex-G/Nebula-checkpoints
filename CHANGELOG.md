# Changelog

## Unreleased

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
