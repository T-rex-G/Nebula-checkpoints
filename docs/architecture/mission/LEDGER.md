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
