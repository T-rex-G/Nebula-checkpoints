# Nebulaverse-X Neural Command Center v5.3
The Neural Command Center is an operational graph built from repository, identity, policy, dependency, recovery, and verified event data. It is not a decorative background and it does not require an AI API.

## Reading the graph

The repository is the hub at the centre, drawn as the Nebulaverse-X app icon:
violet plates on a deep violet orb, with a violet halo and rim.
Every other node belongs to a group -- branches, workflows, identities,
vulnerabilities and so on -- and each group is a panel: a header with the
group's icon and name and its count in a pill, then one row per member, its
icon on a disc and its name beside it. Rows are ordered critical first, then
warning, then in the source's own order where it has one (newest commit,
newest run, the default branch first), then by name. A panel shows six rows;
a larger group shows five and a sixth row, `+ n more`, which opens it. An
opened group shows ten rows at a time with a pager at its foot
(`‹ 11–20 of 60 ›`) and **Show fewer**; every page is as tall as the first,
so turning one never moves the panels below.

On a wide stage the panels stand in two columns either side of the hub. Groups
keep a side by meaning -- identities, credentials, sessions, protected assets,
safeguards and recovery on the left; branches, commits, workflows, webhooks,
packages and their advisories on the right -- so a group is found where it was
last time. When one column is clearly longer than the other, only groups
without a natural side (releases, tags, pull requests, issues, external
targets, scans, snapshots, safety controls, webhooks) cross over. On a tall stage -- a
phone held upright, or a narrow window -- the panels stack in one column. One
spine then leaves the bottom of the hub on its centre line and runs down beside them; each row
branches from it once, and a band in the group's colour marks where a group's
rows leave it, so there are never more wires than rows. On the spine only a
critical node's signal, or the selected node's, travels all the way to the
hub; the rest pulse along their own branch. Turning a phone sideways re-lays
the graph in two columns; turning it back restores the column.

Each row is joined to the hub by a strand in its group's colour, so a column of
strands reads as that group from across the stage; a critical node's strand
turns red and carries a moving signal toward the hub. Severity is shown on the
row as well as the strand: the disc's ring turns amber or red, and a badge sits
on its rim -- a critical node also breathes, one expanding red ring.

**Pressing a row** -- its icon or its name -- opens the node's card beside the
panel, joined to the row by a line that follows it as the graph moves: what it
is, its severity, the facts the graph holds about it, what it connects to, and
the actions available for it. Every connection in the card is a button that
moves to that node. The rest of the graph dims to the node's neighbourhood and
the links into it animate. On a narrow stage the card docks along the bottom
edge; on a phone it opens as a sheet over the page. Escape, the close button,
or pressing empty ground closes it.

**Pressing a panel's header**, or the same group under **Groups on screen**,
lights the group and frames it; pressing empty ground lets it go.

**Groups on screen** in the side panel lists the groups by what they are
about -- Access, Code, Delivery, Supply chain, Protection -- each with its
icon, its critical and warning counts and its count. Its eye hides the group
from the graph; a hidden group stays in the list, dimmed, and pressing its
name or **Show all** brings it back. Which groups are hidden is remembered in
this browser only. **Open all** and **Fold all** open or fold every group at
once.

Dragging from empty ground or from a row moves the stage; rows never leave
their panels. **Dragging a panel by its header** moves the panel, its rows and
their strands together. Where panels were put is remembered in this browser
for that repository, mode and layout (two columns or one), and **Reset
layout** puts them back -- under Groups on screen, and on the stage itself as
a chip at the bottom while anything has been moved, so the full view has it
without opening the rail. Signing out or switching account clears it with the
rest of the repository's browser state.

On the page, the graph does not trap scrolling: the wheel and a one-finger
swipe scroll the page past it. Ctrl or Cmd with the wheel, a pinch, or two
fingers zoom and move the graph, and a short hint says so when the wheel or a
swipe lands on it. In the full view the wheel zooms and one finger moves the
stage. `+`, `-` and the zoom buttons -- shown only in the full view -- zoom in
steps; `F`, double-click or double-tap fits the graph. Held sideways, the
tools wrap into a second column rather than running off the stage, and the
minimap is drawn smaller in the full view and left out of the short stage on
the page.

The full view fits itself to the screen it is on. It frames the graph in the
part of the stage nothing covers -- measured from the status, the search, the
tools and an open side panel, not assumed -- and re-frames it whenever the
screen changes size: a window dragged wider, a browser's bars coming and
going, a phone turned. Once the reader zooms or moves the graph, a resize
leaves their view alone until they fit it again. On an installed iPhone app the
full view keeps to the safe area: the status and search sit below the clock,
the tools and minimap above the home bar, and the side panel's first mode
below the status bar rather than cut by it.

The graph refreshes itself every two minutes and after an action. Only the
first load covers the stage with its "Mapping…" screen; a refresh keeps the
graph, its strands and signals on screen, shows `SYNCING` in the status, and
keeps the camera where the reader left it. With the canvas focused, the arrow
keys move to the nearest node in that direction, Enter opens the card, and
Page Down and Page Up turn the selected node's group (the selection keeps its
row); each move is announced to screen readers. Selecting a node that is on
another page -- from a card's connections, the keyboard or the timeline --
turns its group to that page.

## Large repositories

A repository can have more of most things than a graph can show. The graph
holds up to 60 branches, collaborators and protected paths, 40 vulnerable
packages, 30 deploy keys and webhooks, 24 tags and 12 sessions; activity is
the recent window (22 commits, 14 workflow runs, 10 pull requests, 8 issues,
7 releases). Where the repository has more than the graph holds, the panel's
pill says so (`60/312`) and the side panel says `60 of 312`. The branches the
graph keeps are the default branch, the working branch and the protected
branches first, then the rest by name.

A fit never shrinks the graph past the point where a row can be read: a
topology taller than the stage is fitted at a readable zoom around the hub,
and a **minimap** appears in the corner showing the whole graph with the part
on screen outlined. Pressing or dragging on the minimap moves the stage there;
when the whole graph fits again, it goes away.

Drawing is split in two. The graph -- panels, strands, nodes, hub -- is drawn
while something moves and once when it settles, and then left alone; an
effects layer above it, which takes no pointer events, redraws only what
animates (the signals on the strands, a critical node's breathing ring, the
hub's arcs, the relationship dashes and the card's line), at half rate once
the graph is at rest. Paused, or scrolled out of view, or in a hidden tab, the
graph does not draw at all. The ground is CSS, painted once by the browser,
and follows the design preset: in Nebula, the violet deep of the nebula (a
lavender field in light); in Obsidian, a black with a cool undertone, a soft
light behind the hub, a diagonal sheen and a vignette, or quartz, a warm milky
white, in light. A soft light follows the pointer across it; it is behind the
canvas, so the graph is never redrawn for it, and it stays put with motion off.
The canvas palette follows the preset too, and the search is focused as one
control: the ring goes round the whole box, not inside it.

Over that ground lies the **field**, on a canvas of its own beneath the graph
(after Angelo Libero's Surface Field, re-made for a graph). Its dots belong to
the graph's world, so panning moves over them. They bend away from the panels
standing on them -- and flow round a panel while it is dragged -- and sink
toward the repository hub, the one mass in the picture; none is drawn under a
panel or the hub. Under the pointer they brighten, swell and join into a fine
orthogonal mesh, easing out of the hand's way; a press sends a ripple through
them, and so does choosing a node from the keyboard. Zoomed out, the grid
doubles its pitch rather than thickening into a haze. The field redraws only
when the camera or the layout changes, or while its light or a ripple is
moving -- a still graph under a still pointer draws nothing -- and its light
is eased by the clock, so it settles on time on a device drawing few frames.
With motion off, or where the system asks for reduced motion, the bends and
the well stay and the light and the ripples do not.

## Data sources

| Graph information | Source |
|---|---|
| Current repository and operator | Active encrypted Nebulaverse-X session |
| Other Nebulaverse-X sessions | Existing Neon `nv_sessions` store |
| Branches and tags | Provider references APIs |
| Commits, PRs, issues, releases | Provider activity APIs |
| Workflow state | GitHub Actions API |
| Dependencies and advisories | Manifest parsing, OSV, and Dependabot when authorized |
| Safeguards and protected paths | `nv_security_state` in Neon, session fallback without Neon |
| Signed snapshots | `nv_recovery_snapshots` in Neon |
| Verified provider events | GitHub webhook → `nv_intelligence_events` |
| Access posture | GitHub collaborators, deploy keys, and minimized webhook destination metadata |
| Leaked credentials | Exposure findings (`/exposure/findings`), already masked by the server |
| Recovery preview | Live refs/file manifest compared with a selected signed or local snapshot |
| Evidence integrity | `nv_evidence_chain` |

## Verified live mode

The **Connect verified live events** control performs this sequence:

1. Generates a random public hook identifier and 256-bit webhook secret.
2. Encrypts the secret before storing it in Neon.
3. Creates a repository webhook through GitHub.
4. Registers pushes, pull requests, workflows, issues, releases, reference changes, deployments, and repository vulnerability alerts.
5. Receives the exact raw request body at `/hooks/github/:hookId`.
6. Verifies `X-Hub-Signature-256` with a timing-safe HMAC comparison.
7. Confirms the payload belongs to the configured repository.
8. Deduplicates the GitHub delivery ID.
9. Minimizes and stores the event.
10. Scores it with deterministic rules.
11. Appends evidence and streams the event through SSE.
12. On reconnect, requests persisted events after the last opaque timestamp/event-ID cursor and pages until caught up.

A per-hook/IP rate guard rejects excessive webhook deliveries. The webhook receiver never accepts ordinary JSON parsing before signature verification. Cursor tie-breaking prevents events that share one PostgreSQL timestamp from being skipped.

## Risk scoring

Risk scoring is rule-based and capped at 100. A finding contains:

```json
{
  "score": 90,
  "severity": "critical",
  "reasons": [
    { "code": "FORCE_PUSH", "points": 45, "message": "A force push rewrote branch history." },
    { "code": "PROTECTED_PATH_CHANGED", "points": 45, "message": "Protected path change detected..." }
  ]
}
```

Current rules cover:

- Force pushes
- Branch/default-branch deletion
- Default-branch writes
- Protected wildcard/folder/file changes
- Workflow-file changes
- Common sensitive credential paths
- Failed workflow and deployment outcomes
- Repository vulnerability alerts
- Unknown actors

Scores are decision support, not proof of malicious intent. The inspector always shows the underlying reasons.

## Shadow Access Radar

Security and Governance modes add real access-path nodes for GitHub collaborators, deploy keys, and webhook integrations. Writable deploy keys and webhook configurations that disable TLS verification are treated as critical signals. Admin collaborators, inactive integrations, unverified keys, and partial inventories are shown with explicit reasons. The endpoint returns only minimized metadata and never returns deploy-key material, credentials, webhook secrets, or complete destination URLs.

## Explain this connection

Select a starting node, then a destination node. Nebulaverse-X uses breadth-first graph traversal to return the shortest visible relationship path.

Example:

```text
Actor alice
→ verified push
Commit 8ac21f
→ updated ref
Branch main
→ triggered workflow
Deploy production
```

Verified webhook edges are marked separately from relationships inferred from current provider state.

## Timeline and incident replay

The timeline combines provider-polled activity and signature-verified persisted events. Initial loading retrieves the latest bounded history; SSE reconnect, tab wake, and delivery bursts use cursor-based catch-up from Neon. You can:

- Move chronologically through events
- Select previous/next events
- Jump to affected nodes
- Pause graph animation
- Filter by severity
- Search nodes
- Inspect risk reasons and evidence

The current implementation is a deterministic replay surface, not an automated root-cause claim. GitHub push payloads that omit part of a large changeset are marked `CHANGESET_TRUNCATED` rather than treated as fully inspected.

## Protected assets

Safeguards accept:

```text
.github/workflows/deploy.yml   exact file
.github/workflows              folder and descendants
.github/workflows/**           recursive wildcard
src/*.js                       one directory level
```

Protected paths block Nebulaverse-X write routes including edits, uploads, deletes, renames, staged commits, and other operations that expose candidate paths to the guard.

Enforcement label:

```text
🛡 Nebulaverse-X enforced
```

Provider rulesets remain necessary for enforcement outside Nebulaverse-X.

## Verified recovery preview

A snapshot node can open a non-mutating comparison against the current repository. The workflow shows branch resets/recreation, preserved newer branches, file-manifest differences, truncation limits, provider-protected branches, and active Nebulaverse-X policies. Read-only mode or protected-path policies make the preview fail closed until the operator explicitly unlocks them. A second typed confirmation is required before reference changes. The preview also returns a short-lived encrypted server authorization bound to the repository, active identity, and exact branch actions. The write route rejects expired/replayed authorizations and stops with `RESTORE_PREVIEW_STALE` if a branch moved after preview.

## Emergency Shield

Emergency Shield coordinates existing controls:

1. Calls one authenticated server-side containment endpoint.
2. Captures a bounded branch, tag, and file manifest.
3. Enables persistent Nebulaverse-X read-only mode.
4. Freezes offline/background synchronization.
5. Revokes other Neon-backed sessions for the same identity and closes their live streams.
6. Signs the emergency manifest and persists it/evidence when Neon is available.
7. Exports recent repository activity and updates the graph to show containment.

Activation requires typing `FREEZE`.

Read-only mode blocks writes through Nebulaverse-X only. It does not disable direct Git/provider access.

## Dependency and upload security posture

Dependencies are resolved from supported manifests/lockfiles and queried through OSV, with Dependabot data included when authorized. If OSV is unavailable, the graph creates an explicit incomplete-scan node rather than showing a clean result.

The Security and Dependencies views also show the upload malware gate:

- Active whole-file built-in signature scanning for every raw/batch upload
- Optional administrator-managed YARA CLI rules
- Warning state when a configured required scanner is incomplete

YARA is an optional deployment adapter. Render Free does not supply a YARA binary automatically, and the built-in gate is not a substitute for an isolated malware sandbox.

## Signed snapshots and evidence

A signed snapshot contains:

- Repository/provider identity
- Default branch
- Branch names, SHAs, and protection status
- Tags and SHAs, plus an explicit availability/error state when the provider tag inventory cannot be read
- Optional default-branch file manifest with path, blob SHA, size, and Git mode
- Capture timestamp
- Versioned HMAC-SHA256 signature carrying a non-secret key ID

The evidence export includes:

- Recent normalized events
- Signed snapshots and signature-validation status
- Evidence-chain verification result
- The bounded sequence/hash records used by that verification

Production snapshot signatures use `NV_SNAPSHOT_SIGNING_SECRET` independently
from `SESSION_SECRET`; local development may fall back to `SESSION_SECRET` when
no dedicated snapshot key is configured. Rotation assigns a new key ID, while
retired key-ID/secret pairs and pre-migration bare-signature keys remain
verifiable only when operators explicitly retain them in their respective
keyrings. Each keyring is limited to 16 entries. The application does not
enforce snapshot-retention deadlines, so operators must remove retired entries
after the documented compatibility window expires.

## Privacy model

- Authenticated API responses are network-only by default. Only allowlisted small repository reads may use the opt-in, account/session-scoped offline cache; Neural security, live-event, evidence, recovery, session, notification, raw-file and ZIP endpoints remain network-only.
- Sensitive Neural data is not available as stale cross-account browser cache.
- Offline drafts and explicitly queued writes remain in the application's browser storage until sent or cleared.
- Webhook records store minimized fields rather than complete raw GitHub payloads.
- **Leaked credentials** come from the Exposure findings the server has already masked: the rule, the path as a screen may show it, the line, whether it is only in history (and the commit that introduced it), its status and the provider's answer if one was asked. The secret itself never reaches the browser. A finding the provider confirmed live, or of a critical kind, is critical; one the provider refused is quiet. **Open in Exposure** goes to the finding's full report.
- Everything a repository says about itself -- branch names, commit messages, workflow names, webhook hosts, logins, reported paths -- is escaped wherever the graph writes HTML (the card, the groups list, the timeline and the connection explanation), and counts from a server response are coerced to numbers before they reach markup. A provider link is opened only when it is `https:`.

## Operating modes

### Security
Actors, sessions, verified events, workflows, vulnerabilities, leaked credentials, protected assets, and containment.

### Recovery
Branches, tags, snapshots, releases, and recovery gaps.

### Dependencies
Packages, advisories, protected manifests, and affected relationships.

### Governance
Safeguards, protected paths, branch protection, identities, and evidence.

### Activity
Commits, pull requests, issues, releases, workflows, and live provider events.

## Scale limits

The Canvas renderer is built for repository-level views: the limits under
**Large repositories** keep a mode to a few hundred nodes at most, of which a
folded panel draws six rows and an opened one ten. Organization-wide graphs
of thousands of repositories are a different view and are not drawn here.
