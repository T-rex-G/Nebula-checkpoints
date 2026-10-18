# Architecture mission ledger

One entry per checkpoint: what changed, what was run, and what comes next. A session resumes from the last entry, not from memory.

The plan is the owner-approved *Architecture Foundation — Independent Review and Execution Plan, Revision 2* (18 October 2026). Phases: A baseline and oracles · B decisions and pilots · C foundation · D backend · E frontend · F release tooling · G truth, residue and reports · R dress rehearsal · Q freeze and final qualification · H decision.

Standing limits from the owner's approval: no `LICENSE` file, no branch deletion, no change to GitHub protection settings; the project stays proprietary. Live qualification, database or production changes, merging and deployment each need the owner's word at the time.

## Entries

### A1–A3 — Baseline and oracles

- **Baseline:** `3bf017a` / tree `ef58bee`, production serving `5171b77e…` at migration 032 ([BASELINE.md](BASELINE.md)).
- **Added:**
  - `scripts/architecture-inventory.js` and its five outputs in this folder.
  - `test/oracles/route-policy.js`, `negative-matrix.js`, `current-route-policy.js` and the recorded `route-policy.json` and `negative-matrix.json`.
  - `test/architecture-oracles.test.js`, `test/e2e/dom-contract.spec.js` and its 38 recorded contracts.
  - `test/fixtures/oracle-provider-fetch.js` and `test/helpers/server-entry.js`.
- **Checks:** the inventory regenerated twice with identical bytes. The matrix ran twice with 0 differences. The DOM contract was recorded, then re-read 38 of 38 equal.
- **Next:** Phase B — decision records, the Vite build pilot and the React pilot.

### B1 — Decisions

- ADR-087 to ADR-094 written into `docs/architecture/ARCHITECTURE_DECISIONS.md`, the project's one decision log, rather than a separate folder: every earlier decision lives there and its contract test counts them.

### B2 — The browser build

- **Moved, once, to final homes:** the 30 browser files into `apps/web/src` (features, visualizations, components, offline, and `legacy/app.js` until it is dissolved). The three files the server also loads (offline cache policy, upload planning, CODEOWNERS matching) went to `packages/contracts/src`. The page, icons, manifest and `theme-boot.js` moved to `apps/web`.
- **ES modules, not classic scripts:** Vite cannot bundle a classic script, so the pilot converted the scripts' wrappers rather than leaving them classic. Every module keeps the object it published, so behaviour is unchanged. The one implicit dependency (`neural.js` on 16 workbench names) became an import. The browser suite still calls 13 workbench functions by name; those are published explicitly and listed in one place.
- **Vite 8 build (`npm run build`) into `dist/web`:** content-hashed names under `/build/`, no source maps, nothing inlined. Source commentary is dropped and licence notices kept, with a generated `licenses.txt` covering the 11 bundled packages.
- **Service worker built from source:** its shell list and cache version are generated from the build output.
- **Server:** serves the build, refuses to start without it, and reports `servedAssetsSha256` in `/api/version`. Hashed files are cached immutably; everything else is revalidated.
- **Retired:**
  - the run-time comment stripper (its middleware is listed as an intended change in the route-policy oracle);
  - the version-derived asset stamp (`src/asset-stamp.js`, `ASSET_VERSION`);
  - the hand-kept precache list;
  - the page's use of `public/vendor/`. The copies and the `/vendor/*` route go in Phase G with their proof.
- **Hosting:** `render.yaml` now builds with `npm ci && npm run build && npm prune --omit=dev` (ADR-091). The live service's build command is an owner-applied deployment step, ahead of any merge.
- **Checks:**
  - unit gate green;
  - route policy equal except the recorded retirement, and the negative matrix unchanged (1,011 answers);
  - DOM contract 38 of 38 equal;
  - two builds give one `servedAssetsSha256`;
  - CSP header byte-identical;
  - lint, typecheck and docs green.

  Two browser tests failed once under three local workers and passed alone (load timing). The DOM-contract reader now waits for the view to settle.
- **Next:** the TypeScript foundation (C1, C2), then the React pilot (B3).

### B2 follow-up — What the browser matrix caught

CI's browser shards failed on the pilot's head. Every failure was real; none was a flake.

- **Stylesheet:** the CSS minifier had rewritten the cascade. It read `backdrop-filter:none; -webkit-backdrop-filter:none` as one property declared twice and kept only the prefixed copy, so phone messages were blurred again. It also respelled custom-property values that scripts read as text. The stylesheet now ships as written, less comments, through the stripper the server used before. A unit test holds the built sheet equal to the imported sheets in order.
- **Page state:** `state` had been put on `window` for the browser suite. The classic page never exposed it, and the no-credential guard depends on that. It is reachable again only through the harness marker (ADR-092): set before boot, read once, absent in production. Four browser tests opt in.
- **Mock data:** a mechanical path rewrite had renamed files in the mocked repository of two browser tests. Restored.
- **DOM contract:** two equal readings 700 ms apart can fall between two polls of a running job, and the first recording had caught eleven views mid-load. A view must now hold still for 2.5 s, longer than the page's slowest poll. The 38 contracts were re-recorded from the baseline application twice, with identical bytes, and the current build matches all 38.
- **Release plumbing:** the qualification workflow and the candidate qualifier now build the page before any program starts a server. The foundation gate builds when no build is present. The build program and its configuration are trust-compared like every other program the qualifier runs. The negative matrix's synthetic session key was renamed so the secret gate stays strict.
- **Checks:**
  - 295 affected browser tests green;
  - unit gate (246 programs) green;
  - lint, typecheck, docs, secrets and inventory green;
  - two packaged archives identical. The candidate's own build gives the checkout's `servedAssetsSha256`.

### C1–C3 — The TypeScript foundation and the shared contracts

- **Scopes:** `tsconfig.base.json` holds the strict settings (`strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`). `packages/contracts`, `apps/api` and `apps/web` extend it for their platforms. `npm run typecheck` checks the contracts under all three: no platform, Node and the DOM.
- **Boundaries:** `test/module-boundaries.test.js` joins the unit gate. It checks:
  - the root stays CommonJS and the scopes declare only `"type":"module"`;
  - no top-level await, and no stray entry-file paths;
  - the page, server and contracts boundaries;
  - module indexes and domain purity;
  - no new dependency cycle. The baseline's one recorded cycle goes in D2.
- **Contracts:** the offline cache policy, upload planning and CODEOWNERS matching are strict TypeScript, typed and exported by name. They publish nothing on `window`: the page and the service worker import them, and the server requires them with an explicit `.ts`, run by Node's own type stripping. That removes three page globals.

### Runtime and framework assessments (owner's request, 18 October 2026)

Two questions were assessed without changing the qualified baseline: Node 24 LTS as a production target, and Express 5 as the HTTP foundation. Each was run out of tree against commit `e09bfcc`, in its own worktree, through the gates the mission runs.

| Gate | Node 24.22.0 | Express 5.3.0 |
|---|---|---|
| Clean install from the lockfile | unchanged | 4 packages added, 18 removed; production 101 → 98, audit clean |
| Browser build | byte-identical `servedAssetsSha256` | byte-identical `servedAssetsSha256` |
| Route policy (195 routes) | equal | equal, except two wildcard spellings |
| Negative matrix (1,011 answers) | equal | equal |
| Unit gate (246 programs) | 245; the one failure is the deliberate Node pin | 244; the failures are the two spellings and `text/javascript` |
| Desktop browser subset (117) | all pass | all pass |
| Server warnings | none | none |

Node 22.23.3, the current Node 22 patch release, passed the same gates as Node 24, again failing only the pin.

The findings and recommendations are ADR-095 (runtime) and ADR-096 (HTTP framework). Neither changes this mission:

- Node 22.23.1 and Express 4.22.3 stay qualified.
- The 22.23.3 security patch is an owner decision before final qualification.
- Node 24 and Express 5 each follow as their own qualified change after the merge.

### B3 — The React pilot: the findings page

- **Migrated, not mocked:** the workspace findings inbox is now React 19 and strict TypeScript.
  - `packages/contracts/src/findings.ts` types what `GET /api/workspace/findings` sends.
  - `apps/web/src/features/findings/findings-model.ts` is the inbox's pure model (filters in the address, views, facets, the timeline), ported line for line. Its unit tests import it unchanged.
  - `FindingsInbox.tsx` draws it. The classic `findings-inbox-ui.js` is deleted, and with it the `window.NebulaFindingsInbox` global.
- **Rendering:**
  - one root per host, rendered synchronously (`flushSync`), so the page's existing callers see the inbox drawn when the call returns, as before;
  - the search box stays uncontrolled, so typing is never overwritten by a poll;
  - open rows and the bulk bar's choices live in component state and survive a refresh of the list;
  - no inline script, no `innerHTML` and no `style` attribute.
- **Build:** the JSX runtime is React's automatic runtime, set in `apps/web/tsconfig.json`; the bundle holds no `createElement` calls. React adds 68,896 bytes (gzip) to the main chunk, from 313,295 to 382,191. Every surface moves to it in Phase E, so this is the framework's one-time cost, not this page's.
- **CSP at run time:** the DOM-contract walk now fails if any view raises a `securitypolicyviolation`. A throwaway probe confirmed the listener catches a real refusal. All 38 views raise none.
- **Checks:**
  - findings browser tests and the DOM contract on both projects, 60 of 60 (the findings page's contract unchanged);
  - DOM contract with the CSP check, 38 of 38;
  - unit gate (247 programs) green;
  - typecheck under all four projects, lint and `verify.js` green;
  - the CSP header unchanged (no server change);
  - two builds give one `servedAssetsSha256`.
- **Gate B:** passed.
- **Next:** the remaining C3 contracts, then C4 (the server's runtime and build identity in `/api/version`, the compiled-server CI job and the qualification double build).
