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

### C3 — The shared contracts

- **Fourteen contracts** in `packages/contracts/src`, strict TypeScript and free of any platform's types.
  - New:
    - `guards` (the refusal every guard takes);
    - `ids` (identifier formats, one name per meaning);
    - `scope` (the repository a request is about);
    - `actor` (the authorization snapshot: who acts, on whose authority, with what evidence);
    - `capability`, `evidence` (completeness), `jobs` (polled jobs and scan states);
    - `mutation` (the action catalogue and the descriptor), `api-envelope` (headers and the error body);
    - `codes` (the code catalogue).
  - Already there: `findings`, `codeowners`, `offline-cache-policy`, `upload-planning`.
- **Ported, not copied.** Each validator moved from its server module into its contract with its messages, codes and statuses unchanged, and the server module now calls it. A guard refuses through the caller's own refusal, so every boundary keeps its error class. A bad scope inside an authorization snapshot is still governance's error, and the snapshot's own faults are still the resolver's.
  - Moved: `normalizePolicyScope`, `normalizeAuthorizationSnapshot`, `validateCapabilityDocument`, `normalizeMutationDescriptor` with its metadata and step-up guards, and `publicErrorBody`.
  - Also moved: the job stages and codes, the scan states and coverage, and the audit watch states.
- **Versions** (ADR-090). Every contract declares a `…_CONTRACT_VERSION`, and its shape (types, vocabularies and signatures, without implementation) is recorded in `test/oracles/contract-shapes.json`. A shape that changes under the same version fails. Re-recording refuses an unbumped change.
- **Codes.** `codes.ts` lists the 580 codes the system speaks: refusals, reasons and warnings. It also declares one family, `WEBHOOK_HTTP_<status>`. `test/codes.test.js` reads every code position in the source by syntax, resolving calls against the parameters they pass to, and holds the catalogue equal to what it finds. It also fails when:
  - the page or the server waits for a code nothing produces;
  - a composed code is undeclared;
  - a browser mock sends a code the server never does.
- **Completeness.** One scale (complete, partial, unknown, unavailable). Every part's own vocabulary is declared once and mapped to it, typed so that an unmapped word does not compile. The Overview posture now decides "measured" with it, identically for every answer the server can send.
- **Adoption, enforced.** `test/oracles/contract-adoption.json` records two lists, and both may only shrink:
  - 92 literal copies of contract-owned patterns and header names (`server.js` 19, the classic page 13, the rest in `src`). The server's go as Phase D dissolves `server.js`, the page's as Phase E dissolves the classic page.
  - 39 exports still waiting for their consumer.
- **Defects the port found, each fixed with a test that failed first:**
  - *Inherited names were actions.* The catalogue was an ordinary object, so `constructor` and `__proto__` passed every "is this an action" lookup: the descriptor, exception requests, simulation scenarios, policy rules and the execution-contract lookup. Some of these names come from the client. The catalogue now has no prototype, and the execution contracts are read by own key.
  - *A role refusal read as a failure.* Checking a credential or probing a project as a non-administrator showed "could not be checked" or "could not be asked". The page waited for `GOV_ROLE_REQUIRED`; the server sends `GOVERNANCE_ROLE_REQUIRED`. Two browser tests cover it.
  - *A branch that could never run.* The page tolerated a `BRANCH_EXISTS` code nothing sends; the 422 it actually receives already covers it.
  - *Mocks that production contradicts.* Nine browser-mock codes, and one status, were never what the server sends. For example, a policy block is `POLICY_MUTATION_BLOCKED` with 403, not `MUTATION_BLOCKED` with 409. Each now matches the server's real answer. The one deliberate fixture-only code is declared with its reason.
- **Moved text, honest tests.** Seven source-text tests read text that moved into the contracts. Where the check could be behavioural it is now: action registration is an own-key lookup in the gateway's catalogue, and policy-input refusal and authorization normalization are calls with their codes and error classes asserted. The rest read the contract. `jsconfig.json` reads the `.ts` contracts the checked JavaScript requires.
- **Checks:**
  - unit gate (249 programs) green;
  - typecheck under all four projects, lint, `verify.js`, syntax, secrets, docs and inventory green;
  - two builds give one `servedAssetsSha256`;
  - the full browser suite on both projects (see the commit).
- **Next:** C4 (the server's runtime and build identity in `/api/version`, the compiled-server CI job, `apps/api/src/entrypoint.ts` and the qualification double build).

### C4 — Release plumbing: which server runs, and from what

- **One place names an entry.** `apps/api/src/entrypoint.ts` declares the two files a worker thread or child process starts: Uranus's analysis worker and Parallax's rendered-check process. Each resolves from the entry module's own location and extension, so natively it is the source and compiled it is what tsc emitted. Both spawn sites now ask it. `test/module-boundaries.test.js` refuses an entry path written at any spawn site in `server.js` or `src` (99 files). It checks `new Worker`, `fork`, `spawn`, `spawnSync`, `execFile` and `execFileSync`. An entry path is a literal, `__filename`, a `path.join`/`path.resolve` ending in a file, or a `require.resolve`. It is caught whether passed directly, inside the argument list, or through a constant. It was shown to fail on each of eleven forms. The first version missed an entry inside the argument list (`spawn(process.execPath, [file])`).
- **The compiled runtime** (ADR-088). `npm run build:server` builds `dist/server`, which mirrors the release tree as deployed:
  - the server's 114 modules are emitted by tsc, with relative `.ts` specifiers rewritten;
  - every other releasable file is copied, except TypeScript source;
  - the browser build is copied in.
- **Identity.** `/api/version` now reports `serverRuntime` (`native-ts` or `compiled`). A compiled server also reports `serverBuildSha256`, a digest of its own tree read at startup. `releaseTreeSha256` stays the source tree's in both runtimes. The web and server digests share one walker (`src/directory-digest.js`), and `servedAssetsSha256` is unchanged by the move.
- **Both runtimes, same tests.**
  - Every test that starts the server does so through `test/helpers/server-entry.js`: 25 programs, the negative-request matrix and the browser-integration fixture.
  - `NV_SERVER_RUNTIME=compiled` points them at the built tree, and the release smoke and release contract then require that runtime's identity in `/api/version`.
  - `scripts/test-server-runtime.js` finds these programs by how they start the server, so a new one joins without being listed.
  - Compiled, the run adds `test/compiled/server-tree.js`. It checks that the tree holds no TypeScript, that its scoped `package.json` files are copied, and that every relative specifier resolves. It also starts an analysis on a worker thread from the tree and requires the source's answer, a real command-injection finding included. The program sits outside the runtime matrix's discovery because it needs a built tree.
- **CI.** The new `server-compiled` job builds the server twice and requires one digest. It then runs all 26 server programs, plus the tree check, against PostgreSQL 17. `verify` runs the same programs on the source. The local CI runner requires both steps. The qualification workflow's `automated` job now builds the page twice (`build:web:check`), as ci.yml does.
- **Builds stay out of the release.** The release fingerprint test now places a compiled server and a built page in its tree and requires the same identity. The packaging test places a sentinel in `dist/server` and requires the archive to leave it out.
- **Defects found and fixed:**
  - The documentation manifest test walked into `dist/server` and read its copied documents as unregistered. `dist` is now skipped, as the release fingerprint already skips it.
  - The browser-integration fixture started `server.js` by name, so it would have stayed native whatever runtime was asked for.
- **Checks:**
  - unit gate (250 programs) green;
  - `uranus-linear`'s timing bound failed once while the browser suite ran beside it, then passed alone;
  - native 26/26 and compiled 27/27;
  - two server builds give one `serverBuildSha256`;
  - multi-instance, migrations, release, staging gate, typecheck, lint, syntax, secrets, docs and inventory green.
- **Carried by the plan to F2:** the hosted gates still compare only `releaseTreeSha256`. F2 makes them also require the candidate's `servedAssetsSha256` and, for a compiled server, its `serverBuildSha256`.
- **Next:** D1 (platform leaves to `.ts` inside `apps/api`).
