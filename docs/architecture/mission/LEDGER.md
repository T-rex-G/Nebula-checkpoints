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

### D1 — The platform leaves in strict TypeScript

- **Sixteen modules moved from `src/` into `apps/api/src`** as strict TypeScript ES modules, behaviour unchanged. The CommonJS server, scripts and tests `require()` them by their new paths. 122 require sites were rewritten mechanically, and the path text in checks and comments was updated with them.
  - `platform/release`: `version`, `release-fingerprint`, and the three C4 helpers `directory-digest`, `server-runtime` and `web-build`.
  - `platform/config`: `config`.
  - `platform/persistence`: `database-pool`, `migrations`, and `hosted-readiness`, which `config` reads. Placed as the Phase A inventory owns it.
  - `platform/network`: `guarded-fetch`.
  - `platform/files`: `file-security`.
  - `platform/rate-limit`: `rate-limit-identity`, `rate-limit-store`, `single-use-store`.
  - `platform/crypto`: `key-derivation`. The inventory placed it in identity-access. It is the HKDF primitive behind the session cookie, CSRF, step-up, the evidence ledger and Pulsar's own keys, so placing it there would make Pulsar depend on identity-access for a primitive.
  - `http/errors.ts`: the public error mapping, where the target tree puts it.
  - New: `platform/persistence/queryable.ts`, the one query interface the stores and the migrator take, so a fake drives them without pretending to be a pool.
- **A platform no longer reaches into a product module.** `guarded-fetch` took its address policy (`isPublicAddress`) from Kepler's webhook model. The policy now lives in `platform/network/public-address.ts`. Kepler reads it from there and no longer exports it.
- **Where the migrations are is said, not assumed.** `runMigrations` and `verifyMigrations` now require `{ directory }`. Every production caller already named it except the invite CLI, which now does. The refusal caught a slip in ten tests, which passed `loadMigrations(...)`'s list where the options belong. It was read as "no options" and applied the default directory.
  - In one test that hid a gap. The audit-history test meant to apply every migration before 032, write a legacy row, then upgrade. Its first call applied 032 as well, so the upgrade was never run. It now applies a real pre-032 directory, checks the column is absent, and requires the upgrade to start at 032. The claim it makes, that 032 keeps a legacy audit's analysis proof unknown, holds.
  - The change also keeps `migrations.ts` free of `import.meta`. Playwright compiles a required `.ts` file to CommonJS, where `import.meta` cannot exist, and the integration fixture requires the migrator.
- **Defects the port found, each with a test that failed first:**
  - *Inherited names were outbound profiles.* The profile table was an ordinary object, so `constructor`, `toString` and their kin passed the lookup and crashed on a missing method list with a TypeError instead of a refusal. Lookups are now by own key. The new test fails on the old lookup.
  - *The type-check proof proved less than it said.* `test/typecheck.test.js` planted its error in a copy of a file that failed the strict fixture before the error was added. It now copies files shown to pass unchanged, so the planted error is the only difference. It proves both checkers: the remaining JavaScript, and a strict server module.
- **Kept exactly:**
  - Error objects keep their own-property order (name, code, then status or transportCode). `transportCode` stays absent unless set. Ordinary class fields are used: Playwright's loader rejects `declare` fields, and the browser specs import server modules.
  - Byte coercion in the upload scan accepts what it did.
  - Applied migration ids are compared as the database returns them.
- **Gates that moved with the code:**
  - `node --check` reads JavaScript only, so `.ts` files leave the syntax manifest. The package contract counts a `.ts` source as checked when the typecheck gate runs its project.
  - `jsconfig.json` drops the moved files; `apps/api/tsconfig.json` checks them strictly.
  - The code catalogue, configuration registry and boundary tests read `apps/api/src`. The resolver's no-record answers (`ENODATA`, `ENOTFOUND`, `NXDOMAIN`) are declared platform codes.
  - One fixture swapped `pg` through `Module._load`, which an ES module's own imports never pass through. It now substitutes the pool module the server requires, under either runtime's extension.
- **Checks:**
  - unit gate (250 programs) green;
  - typecheck under all four projects, lint, syntax, secrets, docs and inventory green;
  - migrations, database resilience, multi-instance, Exposure store, audit history, governance lifecycle, staging gate and release green on PostgreSQL;
  - the compiled server builds deterministically, and all 27 server programs pass against it;
  - Playwright loads every browser and integration spec.
- **Next:** D2 (break cycle N-01 with a `PolicyEvaluator` port).

### D2 — Cycle N-01 broken

- **The cycle.** The baseline's only backend dependency cycle ran through the security core. The mutation gateway lazily required governance enforcement for `normalizePolicyDecision`. Simulation, enforcement and exceptions each required the gateway for the action catalogue and the metadata guard.
- **The port.** The mutation contract (version 2) declares `PolicyEvaluator`, the policy port the gateway is handed. It has two halves: `evaluate(descriptor)` answers for a descriptor, and `verify(decision, descriptor)` refuses any answer that is not well formed or not bound to that descriptor.
  - Kepler's governance runtime is the port: `verify` is `normalizePolicyDecision`.
  - The composition root (`server.js`) hands the runtime to the gateway. The gateway imports no policy module.
  - A port without both halves is refused at construction, a bare evaluator function included, since nothing would then verify its answer.
- **Policy reads the contract.** Simulation, enforcement and exceptions take `MUTATION_ACTIONS` and `normalizeMutationMetadata` from `packages/contracts/src/mutation.ts`, the same objects the gateway re-exports. Exceptions reads only the refusal's status, which the contract's refusal carries unchanged.
- **One more guard, fail closed.** The gateway acts only on an outcome it knows (`POLICY_OUTCOMES`: allow, warn, block). It always did, through Kepler's own validator. Now that the verifier is handed in rather than imported, the gateway checks the outcome itself. A misspelt or missing outcome is refused as `POLICY_EVALUATION_UNAVAILABLE` (503), and the mutation never runs. Without the check, a verifier that passed a strange outcome through would let the mutation run, because only an exact `block` stops it.
- **The check covers the whole backend.** `test/module-boundaries.test.js` now builds one graph over `server.js`, `src`, `apps/api` and `packages` (116 files) instead of two. A cycle that runs from the CommonJS server through a TypeScript module and back is caught. The recorded list is empty, so any cycle fails. It was shown to fail on a planted cross-language cycle.
- **Tests:**
  - loading the gateway alone loads no part of the policy engine;
  - four malformed ports are refused;
  - four unknown outcomes are refused before the mutation runs;
  - the decision-mismatch and fail-closed cases now run through the port as the server wires it.
- **Next:** D3 (`platform/authorization` and `platform/mutation-gateway` to TypeScript). The gateway's remaining reach into Kepler is `governance-model`'s scope normalizer, chosen for its error class. D3 settles it while converting the gateway.

### D3 — The authorization and mutation-gateway platform in strict TypeScript

- **Moved, typed strictly, behaviour unchanged.** `platform/authorization` holds the authorization resolver, the security foundation (CSRF and step-up tokens, the replay guard) and the local session policy. `platform/mutation-gateway` holds the gateway, its coverage inventory, the protected path sets and Safe Passage. CommonJS callers require them by path.
- **The platform no longer depends on Kepler.**
  - *The scope.* The resolver and the gateway read a repository scope through governance's reader, borrowed for its error class. `platform/authorization/repository-scope.ts` reads it by the scope contract's rules and refuses with the same codes and messages and the same 400, as a `ContractError`. Nothing maps a refusal by its class, and a test pins the code, message and status.
  - *Safe Passage.* It required governance enforcement to judge each step of the route it offers. It is now handed a step evaluator, as the gateway is handed its policy port. Kepler supplies it (`activePolicySetStepEvaluator`): the same active policy set, the same evaluation, nothing recorded. Without an evaluator Safe Passage throws rather than offer a route it could not judge, and an evaluator that answers nothing refuses the route.
  - *A rule keeps it so.* `test/module-boundaries.test.js` now refuses any platform import outside the platform and the contracts. The rule was shown to catch a planted import of `src/governance-model.js`.
- **Copies replaced by the contract's names.** The gateway's mutation-id pattern and the step-up commit-SHA pattern are now `isMutationId` and `isCommitSha`. Two copies are gone, and four waiting exports gained a consumer; the adoption record says so.
- **Defects the port found, each with a test that failed first:**
  - *Inherited names had path facts.* `pathFactsForAction('constructor')` and its kin threw a TypeError from a missing source list. Lookups are now by own key, and such a name has no facts.
- **Kept exactly:**
  - Error objects keep their own-property order (name, code, status, then the protected-path refusal's three facts).
  - Each step-up action cleans its scope fields in the order its refusals were always reported. The action list is now a typed table, and the scope builder covers every action or does not compile.
  - The security foundation's canonical JSON, bound into signed step-up grants, stays byte for byte. The server has eight such copies in three variants, differing on undefined and on objects with `toJSON`. **Carried to Phase G:** unify them only with proof over every value each one hashes.
- **Checks:** typecheck under all four projects and lint green; every unit program that touches these modules green; Playwright loads every browser and integration spec.
- **Next:** D4 (the identity-access and GitHub provider modules, behind their indexes).

### D4 — Identity and access, and the GitHub provider, as modules

- **Two modules, each behind its index.**
  - `modules/identity-access`: invitation and repository-scope rules, the privacy policy and provider disconnect (`domain/`), and the access and privacy stores (`persistence/`).
  - `modules/github-provider`: the GitHub App client and its credential broker (`client/`), and the account operations and credential resolution (`domain/`).
  - The server, the scripts and the CI harnesses reach both through `index.ts` only. The server's thirteen separate requires of these files are now two.
- **Typed strictly, behaviour unchanged.**
  - The 2,500-line privacy store keeps every SQL statement as it was. Rows are checked values; a statement answered without rows fails as it always did, and a `RETURNING` row is read by one helper that says so when it is missing.
  - Disconnect steps handed in by the server are still called as methods of what supplied them, so a store's own `this` holds.
  - Error objects keep their own-property order, and the App's state tokens keep their canonical JSON byte for byte (one of the eight copies carried to Phase G).
- **The boundary rule reaches the CommonJS server.** The import-graph test already held modules to each other's indexes; it now holds `server.js` and `src/` to them as well. It was shown to catch a planted reach past the identity-access index.
- **Copies replaced by the contract's names.** Three copied SHA-256 patterns are `isSha256Hex`; the adoption record shrinks by three copies and one waiting export.
- **Tests that moved with the code:**
  - The boundary fixture swaps the stores and the credential resolver in each module's index, under either runtime's extension, instead of matching the old file requests.
  - The continuity archive test carries both module trees and the ES-module scope file, so the generator it isolates still runs.
  - The source-text contracts read the server's one require of each index.
  - `node --check` reads JavaScript only, so the moved files leave the syntax manifest; `verify.js` counts a server `.ts` source as checked when the `apps/api` project typechecks, as the package contract does.
- **Checks:** typecheck under all four projects and lint green; every unit program that touches these modules green, the PostgreSQL privacy purge and migrations included; both server runtimes; Playwright loads every browser and integration spec.
- **Next:** D5 (Kepler, the governance module).

### Qualifier — a failing browser slice names its tests

- **The defect.** On C4 the alpha17 candidate gate failed in browser slice 4/4, and its message named only a web server warning. Each slice ran with the blob reporter alone, which writes nothing readable, and a failure was described by the slice's stderr, which holds only the server's warnings. The failing tests were not named anywhere a reader could see.
- **The fix.** Each slice now also runs the line reporter, and a failing slice is described by the end of that output, without terminal colour codes: each failed test's error, then the failed and flaky tests by name. The blob report is still the slice's evidence, one zip per slice. The test that pins this failed first on the old message.
- **The run itself.** The same slice of the same commit passes outside CI (241 passed, 6 skipped, one worker), so the next CI run names whatever failed rather than leaving it to be guessed.

### D5 — Kepler, the governance module

- **One module, behind its index.** `modules/kepler` holds all of governance, each layer in its own directory:
  - `domain/`: the policy model, the control catalogue, the audit SLA policy, simulation, exceptions, templates, the digital twin, the interface access projection, and the enforcement engine the mutation gateway consults.
  - `persistence/`: the store.
  - `delivery/`: governance events, notifications, webhooks and signed evidence exports, and the webhook worker.
  - `application/`: the governance API service the routes call.
  - The server's seven requires of governance files are now one, of `index.ts`. Every caller in `src/`, the scripts and the tests reaches Kepler the same way.
- **Typed strictly, behaviour unchanged.**
  - The 2,959-line store keeps every SQL statement as it was. Rows are checked values: a statement answered without rows fails as it always did, a `RETURNING` row is read by one helper that says so when it is missing, and an idempotent replay returns the stored answer.
  - Each converted file was compared with its original after its types were stripped. What differs is listed below or is the same expression written so the checker can follow it.
  - Error objects keep their own-property order. Policy, audit-chain and decision hashes are unchanged, and every governance test passes against them, PostgreSQL included.
- **Canonical JSON is a contract.** `packages/contracts/src/canonical-json.ts` holds the canonical form Kepler signs its policies, audit chain and decisions over. It is the same function, moved, so its bytes are unchanged. It is the first of the server's eight canonical copies to become a contract. The other variants differ on `undefined` and on `toJSON`, and stay where they are until they can be unified with proof.
  - The matrix runner and staging validation hash their evidence with it, and the candidate qualifier trusts that file and its guard in place of the governance model. Without the move, the matrix runner would have loaded all of Kepler from the candidate, and none of it is trust-compared.
- **Defects the port found, each with a test that failed first:**
  - *Inherited names were catalogue entries.* `deriveControlMapping` crashed with a TypeError on an action or catalogue version named after an `Object.prototype` member. A stored mapping citing such an action as its source passed the source check, so only its hash stood in the way. Lookups are now by own key: such an action is unmapped, such a version is unsupported, and such a mapping is refused.
  - *A non-text actor login crashed decision verification.* A decision built from a descriptor whose actor login was not text reached a string method the login did not have and threw a TypeError. Verification now refuses it as `MUTATION_POLICY_DECISION_MISMATCH` (500), as it refuses any other descriptor the decision does not match.
- **Hardened, with no change for any real input:**
  - A scenario's condition fields and the webhook's code translation are read by own key.
  - The webhook's code table is typed against the transport's code registry, so a missing line no longer compiles. The test that checks the same thing at run time stays.
  - 26 copied identifier and hash patterns are now the contract's names (`isSha256Hex`, `isIdentityKey`, `isPolicyKey`, `isRecordId`, `MUTATION_ID`, `POLICY_KEY`). Three waiting exports gained their first consumer. The adoption record says so.
- **Removed as dead:** a text normalizer and an event-id pattern nothing called, an unused `https` import, and a nullable branch of the hash reader no caller took.
- **Tests that moved with the code:**
  - The boundary fixture holds the webhook worker still through the Kepler index, under either runtime's extension.
  - The source-text contracts read the server's one Kepler require. The Safe Passage contract reads the store at its new path.
  - The simulation contract no longer asks the syntax manifest for its module: `node --check` reads JavaScript only, and the `apps/api` typecheck covers it.
  - The code catalogue, the hardening and package contracts, the verifier and the qualifier's tamper test name the new paths. The tamper test also covers the canonical contract's guard.
- **Found, and closed next:** the qualifier compares only the programs it runs. What those programs load is not compared: the platform release helpers the web build uses, the persistence platform the database drills use, and the restore drill's backup format and harness. A tampered archive could change them and still qualify. This gap predates the mission and was widened by C4 and D1. The next commit closes it.
- **Checks:** typecheck under all four projects, lint, syntax, secrets, docs, inventory and verify green; every governance program green, PostgreSQL included; the boundary fixture under both runtimes; the full unit gate.
- **Next:** the qualifier closure, then D6 (Quasar).

### Qualifier — what a qualification program loads is compared with it

- **The defect.** The candidate qualifier compared the programs it runs, and the tests, byte for byte against the trusted tree. It did not compare what those programs load, or how their requires resolve. Each of these passed the old check, and the test that pins each one failed on the old qualifier:
  - *A tampered helper.* The web build runs from the candidate, and its release helpers (`web-build`, `directory-digest`, `version`) and the public asset list were never read. An archive could change how its own page was built and still qualify.
  - *A file placed in front of another.* The matrix launcher requires `../src/test-matrix`. A candidate file named `src/test-matrix`, with no extension, is loaded in place of the trusted `.js`.
  - *An added spec.* Only the trusted tree's tests were listed, so a spec the candidate added ran in the browser matrix unread.
- **The fix.**
  - Every local file the trusted programs load is followed from their sources: `require`, `import … from`, `export … from`, `import '…'` and `import()`. The sources are read in the trusted tree, and each file found is compared like the programs. The closure is derived, not listed, so a new dependency is compared the day it is added.
  - Each specifier in a compared file is resolved in both trees by the CommonJS rules Node applies: the path, then `.js`, `.json` and `.node`, then a directory's index. The two answers must be the same file. A directory that declares its own package is refused rather than followed.
  - The tests and the drills' harnesses (`test/` and `ci/`) are compared whole. A file the candidate adds there is refused before anything runs.
  - What the tests load from the product is the product under test, so it is not part of the comparison.
- **On the real tree** the closure adds the three release helpers, the public asset list and the secret scanner, and a tree compared with itself passes.
- **Next:** D6 (Quasar).

### D6 — Quasar, the exposure module

- **One module, behind its index.** `modules/quasar` holds all of credential exposure, each layer in its own directory:
  - `domain/`: Supabase key kinds, the exposure rules, detection, keyed findings, archives, the words a finding is described in, and the outcome vocabularies of a verification and a readability probe.
  - `client/`: the three parties Quasar speaks to: the repository reader, the credential verifier and the readability probe.
  - `application/`: the scan worker and the session resolver it reads a live token through.
  - `persistence/`: the store.
  - The index exports the domain, the worker and the store by name, and each client as a namespace of its own (`exposureReader`, `credentialVerifier`, `readabilityProbe`): the three share words such as `REASONS` and `DEFAULT_TRANSPORT`, each meaning something different. The server's nine requires of exposure files are one, of `index.ts`. Every caller in `src/`, `ci/`, the scripts and the tests reaches Quasar the same way.
- **The secret scanner is platform, not Quasar.** The plan placed `secret-scanner` in `modules/quasar`. It is the release gate's scanner: `scripts/check-secrets.js` and the candidate qualifier run it, and the platform may import no module, so the gate would have had to load all of Quasar to run. It moved to `platform/release` in two files:
  - `secret-rules.ts`: the rules, as data.
  - `secret-scanner.ts`: the tree walk, which uses `fs` and `git`.
  - Detection imports the rules and nothing else, so a decision about a credential does not load the code that walks a disk for one. The baseline inventory keeps its baseline owner, because it records the baseline.
- **Layering is now a test.** The module boundary test refuses a domain file that imports its own module's client, application or persistence layer, or that loads a file importing a transport, persistence or process package at any depth. It failed first on Quasar: detection loaded the scanner's `fs` and `child_process`. Narration needed the verification and probe vocabularies, which lived in the clients; they moved to `domain/verification-outcomes.ts` and `domain/readability-outcomes.ts`, and the clients re-export them.
- **Typed strictly, behaviour unchanged.**
  - The 2,079-line store keeps every SQL statement as it was. A row read by `RETURNING` or an aggregate goes through one helper that says when it is missing, and a cursor is rebuilt from fields checked one by one after its signature is.
  - The worker is typed against the ports it is handed: the store, the reader and the session resolver. The reads it starts ahead of the scan are held in two queues, the tree's and then history's, where one array served both.
  - Each converted file was compared with its original after its types were stripped. What differs is listed here or is the same expression written so the checker can follow it. One difference has no effect: a read that rejects with no reason at all now propagates that, not the TypeError it caused. Either way the scan is left for its lease to expire, as an error nobody understands must be.
  - Error objects keep their own-property order, and fingerprints, cursors and narration are byte for byte the same. Every exposure test passes against them, PostgreSQL included.
- **Defects the port found, each with a test that failed first against the original:**
  - *Inherited names were table entries.*
    - A provider named after an `Object.prototype` member had a reader, so a read failed on a missing function instead of being refused as unsupported.
    - A rule named after one had a verification adapter, so a whole verification run crashed with a TypeError.
    - The narration tables answered with built-in functions. A verification or probe sentence printed a function's source text, a disposition returned one, and a finding was described with no severity at all.
    - The findings view tallied such a rule under a key named after a function, holding `NaN`, while the query that filters by severity counted it as serious.
    - Every one of these lookups is now by own key.
  - *A renewed session was trusted on less than the first one.* The scan starts only with a string token, but the renewal accepted anything truthy and handed it to the reader as a credential. The renewal now applies the same test: a session without a string token is revoked, and nothing is read with it.
- **Hardened, with no change for any real input:**
  - The copied object-id and digest patterns are the contract's guards (`isCommitSha`, `isSha256Hex`): in the reader, the worker, the store's fingerprint lists, narration's introducing commit and both authorization signatures. The contract adoption record holds no copy in Quasar.
  - The store's verification freshness is the verifier's constant, not a copy of it.
  - The source-text guards forbid an ES-module import of a network, file-system or process package, as well as a `require` of one. They had matched only `require`, which a TypeScript module never contains, so they would have passed whatever it imported. Their first run found the reader's type-only `node:http` import, which is gone.
- **Removed as dead:** the file path the worker handed a detector that never reads it, and an unused error binding.
- **Tests that moved with the code:**
  - The source-text contracts read the server's one Quasar require and the files at their new paths.
  - The reason-vocabulary contract reads the declaration in the domain and its use in the verifier.
  - The package and release contracts, the verifier, the syntax manifest, `jsconfig` and the adoption record name the new paths or drop the old ones.
- **Checks:** typecheck under all four projects, lint, syntax, secrets, docs, inventory and verify green; every exposure program green, the PostgreSQL store included; the module boundaries; the full unit gate.
- **Next:** D7 (Uranus).

### D7a — Posture, the module Uranus stands on

- **Why before Uranus.** The audit engine files every finding under the standards in `security-standards`, and the plan places that file in `modules/posture`, which D4–D9 did not schedule. Uranus could not become a module that imports CommonJS from `src/`, so posture converts first. Its six files depended on nothing.
- **One module, behind its index.** `modules/posture`:
  - `domain/`: the standards every finding is filed under, a credential's reach and the exposure summary, the security posture, the findings inbox, the pull-request board's item, and what GitHub's branch rules mean, control by control.
  - `application/`: the posture reader and the branch protection reading, each typed against the ports the server hands it (the guarded provider transport, the database, the stores, a repository read).
  - `persistence/`: the recovery points query, which the reader used to issue inline.
  - The index exports them by name. Three generic names are qualified: `STANDARDS_MAP`, `INBOX_STATES` and `BRANCH_CONTROLS`. The server's five posture requires are one, and Uranus, the site check and the tests reach the module the same way.
- **One way to read an untyped value.** `platform/values/fields.ts` holds `read`, `fieldsOf`, `listOf`, `ownEntry` and `dateFrom`, which posture uses and Uranus will. A value is read by name only when it is an object, and comes back `unknown`. They claim nothing the language does not guarantee, so posture adds no type assertion. Gate D moves the earlier modules' per-file helpers onto it.
- **Defects the port found, each with a test that failed first against the original:**
  - `standardsFor('constructor')`, or any name `Object.prototype` carries, threw `entry is not iterable`, because the table answered with a built-in. It now answers null, as for any rule it does not map.
  - The findings inbox kept a severity named after an `Object.prototype` member as it was, and sorted it by `NaN`. Its tallies added a count to a built-in function, `"function Object() { [native code] }1"`, or lost it to `__proto__`. Severities are now the three it ranks. Each tally is built in a Map and returned with own keys only, so any word is counted like any other.
  - A branch-rules provider named after an `Object.prototype` member had a reader. `constructor` returned its own argument and the reading failed with a TypeError, not the refusal an unknown provider gets. The readers are a Map, and such a provider is refused with 501 before anything is read.
  - The pull-request board deduplicated label names before cutting them to length, so two labels that read the same once cut appeared twice. They are cut first.
- **Behaviour otherwise unchanged.**
  - Every file was compared with its original after its types were stripped. Each difference is listed here or is the same expression written so the checker can follow it.
  - The SQL is unchanged.
  - One difference is in input no store produces. A row that is not an object is skipped where the original threw on reading its fields, and a series that is not an array reads as empty. The exposure summary already skipped such rows.
- **Checks:** typecheck, lint, the posture programs, the PostgreSQL posture test, the route surface, module boundaries, contracts, the package contract and the full unit gate.
- **Next:** D7 (Uranus).

### D7b — Uranus, the audit engine and its tracers

- **One module, behind its index.** `modules/uranus` takes the ten engine files from `src/`:
  - `domain/`: the lexers, the JavaScript and Python tracer (`uranus-flow`), the Go, Java and PHP tracer (`uranus-cfamily`), the endpoint map, reach and risk, the ecosystems, the licences and the popular names. The audit itself is split at its own section seams:
    - which files are read (`audit-files`) and the rule catalogue (`audit-catalog`);
    - the line and workflow rules (`line-rules`), the database rules, committed secrets and infrastructure;
    - dependencies and versions, advisories and their risk;
    - how a finding reads and how sure it is (`audit-findings`), the coverage ledger and the controls (`audit-ledger`);
    - the analysis that puts them together (`code-audit`).
  - `client/`: OSV and the registries (`advisory-lookup`), exploit intelligence, and the deps.dev licence lookup, each through its own profile of the guarded transport.
  - `application/`: the audit of a repository through the guarded reader, cancellable at every step (`audit-repository`), and the wiring that hands the analysis what it needs from other modules (`audit-engine`).
  - The index exports the engine's names as before. Sub-engines whose names would clash are namespaces: `cfamily`, `surface`, `ecosystems`, `exploitIntel` and `licences`. `licences` holds the licence rules and the deps.dev lookup together, as the old file did.
- **Ports, not reaches.** The analysis called Exposure's detectors and Kepler's audit policy directly, and their indexes load delivery and transport code that the domain rule forbids.
  - The domain now takes them as `AuditPorts`: `detectSecrets`, `narrationOf` and `readAuditPolicy`. The policy path is a parameter of the file selection.
  - `application/audit-engine.ts` passes the real ones. The index exports the wired `analyse`, `scanRules` and `selectFiles`, with their old signatures.
- **Shared helpers.**
  - `platform/concurrency/bounded-map.ts` replaces two copies of the same function, the audit's and the licence lookup's.
  - `platform/values/fields.ts` gains `lookupTable`, a null-prototype table typed by its entries.
- **Size.**
  - The JavaScript and Python tracer (2910 lines with its types) and the C-family tracer (2334) stay whole. They are recorded as engines for the size ratchet.
  - The 3474-line audit is now twelve domain files, none over 720 lines, plus a client and an application file.
  - No type assertion was added. The count stays at 319.
- **Defects the port found, each with a test that failed first against the original:**
  - **Development requirements.** The inventory read a requirements file named for development (`requirements-dev.txt`) without its name, so it treated those packages as ones the application installs and did not soften their advisories. The inventory and the registry pass now pass the name.
  - **CVSS vectors.** A vector whose metric value was the name of an `Object.prototype` member (`AV:constructor`) was weighed with a built-in and scored `NaN`. The weights are Maps, and such a vector has no score.
  - **Advisory ids.** In an OSV answer, a vulnerability with no id, a bare string, or an id that is a list became an advisory named `"undefined"` or a second copy of one, and the answer still counted as complete. An id must now be a string in advisory-id form, and anything else leaves the answer partial.
- **Behaviour otherwise unchanged.**
  - The tracer was compared with its original after its types were stripped. Then both were run over the repository, the benchmark corpus and every file on its own: 852 runs, identical output.
  - The audit was run against its original over the benchmark corpus (`analyse` and `scanRules`, 276 runs) and over the repository's own manifests and lockfile, with made-up advisories, exploit intelligence, registry and licence answers (12 runs over 296 package versions). The output was identical.
  - The risk weighing now keeps the inventory entry and the advisories beside each finding, where they used to be fields deleted from it afterwards. The findings come out the same.
  - Behaviour differs only where the original threw:
    - a token read past the end of its list now matches nothing, so the walk of that file goes on instead of failing it;
    - an advisory record whose range events are not objects reads as having none;
    - an unknown rule id now fails with an error that names it;
    - a negative score has no grade.
- **Checks:** typecheck, lint, module boundaries, the Uranus, audit, licence, ecosystem, exploit-intelligence, site-check and route-surface programs, the benchmark, and the full unit gate.
- **Next:** D7c, the audit's worker, jobs, watch, triage and history.

### S1 — The October 2026 dependency advisories

Three advisories published from 21 to 23 October hit pinned dependencies. npm's audit and an OSV query over all 296 locked package versions agree on exactly these three.

- **body-parser 1.20.8 → 1.20.9** (GHSA-27r3-jxmh-p828, CVE-2026-111181, high). Express 4.22.3 takes it through its own `~1.20.5` range, so only the lockfile moves.
  - A compressed request body (`Content-Encoding: gzip`) followed by trailing bytes crashed the process. Upstream's shape is one gzip frame, a zero byte, then 100 KB that arrive after the decoder has finished. The decoder stayed piped with no error listener, and its error ended the server. Parsing runs before routing and before any session check.
  - On this server it reached every body parser: the JSON parser mounted for the whole app, which an API path reaches once the `x-nv` header is sent, and the GitHub webhook's raw parser.
  - Reproduced on 1.20.8 under Node 22.23.1 and 22.23.4. `test/request-body-decompression-server.test.js` sends that body to all three entry points and requires the same process to answer afterwards. It failed against 1.20.8 and passes on 1.20.9, natively and compiled.
  - The production service runs the merged `3bf017a`, which carries 1.20.8.
- **DOMPurify 3.4.16 → 3.4.17** (GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f; npm rates it critical).
  - None reaches this page's configuration: string output, the HTML profile, no hooks, no `IN_PLACE`, no DOM return mode, no XHTML parser. It moves anyway, as a patch release.
  - The vendored copy moves to `public/vendor/dompurify/3.4.17/`. The package contract now also refuses a 3.4.16 asset left behind.
  - The baseline inventories keep 3.4.16: they describe the baseline commit.
- **Vite 8.3.2 → 8.3.5** (six advisories, dev server only).
  - Two concern the dev server's own middleware and file serving, which this repository uses only to build. The build is unchanged in kind and still deterministic (`build:web:check`).
- **Not affected:**
  - the pinned GitHub Actions: download-artifact v4.3.0 is past the fix for its one advisory, and the rest have none;
  - `pg` 8.22.0;
  - Playwright's bundled Chromium. It reaches only CI: the rendered audit is off in production and needs a browser the Render build does not install.
- **Checks:** the full unit gate, every verify-job gate including the PostgreSQL suites, the production audit, the release test, and all 28 server tests on the compiled runtime.

### S2 — Node 22.23.4

- **Why now.** 22.23.4 (21 October) is the second security release on the Node 22 line since the 22.23.1 pin. The first was 22.23.2 in July.
  - Its fixes sit on paths this service uses: the guarded transport's agent pools, DNS lookups and TLS on pinned addresses; the decompression of content an attacker writes; and, from July, inbound header limits and HTTPS identity on reused sessions.
  - ADR-095 is amended with each CVE and where it meets the code.
- **What moved, in one commit** (the lockfile's root `engines` with them):
  - `.nvmrc` and `engines.node`;
  - the eleven workflow steps;
  - the candidate qualifier and the qualification-evidence validator;
  - the contract tests, which now also refuse 22.23.1 and 22.23.3 by name.
- **Measured on 22.23.4** (npm 10.9.9), from a clean `npm ci` of the unchanged lockfile:
  - the full unit gate and every verify-job gate, the PostgreSQL suites among them;
  - the deterministic browser build;
  - the production audit;
  - all 28 server tests on the compiled runtime.
- **Production** is unchanged until a deploy the owner approves: Node 22.23.1 on `3bf017a`.

### D7c — Uranus after the analysis: the worker, the watch, the history and triage

- **Where each file went.** The last five audit files leave `src/`:
  - `application/audit-worker.ts`: the analysis on a worker thread, bounded by heap and clock. It is the `code-audit-worker` entry, now a TypeScript entry in `entrypoint.ts`. The compiled tree starts `apps/api/src/modules/uranus/application/audit-worker.js`, and the compiled-tree test runs a rules-only scan through it.
  - `application/audit-watch.ts`: the watch over stored dependencies, with the service that refreshes a branch's latest audit (`createAuditWatch`), which used to live in the history file.
  - The history, split at its seams:
    - `persistence/audit-history-rows.ts`: the reduction into rows, the privacy boundary;
    - `persistence/audit-history-records.ts`: the serializers back out;
    - `persistence/audit-history-sql.ts`: the shared SQL fragments;
    - `persistence/audit-history-store.ts`: the store;
    - `persistence/audit-workspace-reads.ts`: the two workspace-wide reads.
  - Triage, split by what it stands on:
    - `domain/audit-triage.ts`: decisions, `applyTriage`, `rescore`, `openRows`;
    - `application/merge-gate.ts`: the gate and the policy preview, which need Kepler's clocks and policy evaluation;
    - `persistence/audit-triage-store.ts`: the decisions and their events.
  - `domain/audit-cancellation.ts`: `assertAuditActive`, which the worker and the store share. The store no longer reaches into an application file for it.
  - The job runner is `platform/jobs/audit-jobs.ts`, not Uranus. The deployed-site check and the rendered audit are jobs of the same kind, and the jobs contract names all three.
- **The index.** Each old file's surface is one namespace with its original names: `auditWorker`, `auditWatch`, `auditHistory`, `auditTriage`. They are not spread flat because several share `LIMITS` or `SHAPE`. The server, the routes, the tests and the browser fixtures reach them there.
- **Types at the boundaries.**
  - What the database returns is read column by column. NOT NULL text is read as text. An enumerated column must hold one of its values, or the read is refused with `CODE_AUDIT_ROW_INVALID`. The migration's CHECK constraints already refuse anything else, so the refusal cannot fire on stored rows.
  - What a worker thread posts is `unknown`. It crosses by structured clone, and this side does not claim to know its type.
  - The engine's `score` and `priorities` take a `ScoredFinding`: the fields they read. So `rescore` hands them the page's findings without a cast.
  - `queryAdvisoryIds` is generic: the entries it hands back keep their own type.
  - No type assertion was added.
- **Contracts.**
  - The jobs contract's `RunningJob.limit` was declared a number, but the runner has always sent `'memory'` or `'time'`. It is now that union. The contract is version 2, and its shape is re-recorded.
  - The history and triage shapes take the commit, identity-key and UUID patterns from the ids contract, not copies. The adoption record loses four copies, and `COMMIT_SHA` gains its first consumer.
- **Two harness fixes the move needed:**
  - *The browser suites load server TypeScript natively.* Playwright compiles the `.ts` files a test loads into CommonJS, where `import.meta` cannot be written. Since the Uranus index loads the worker, which loads `entrypoint.ts`, every browser fixture that reads Uranus failed to load. Both Playwright configs now leave `apps/` and `packages/` to Node's own type stripping (`build.external`), the way the server loads them: 988 tests list again, and the integration suite's two as well.
  - *The code catalogue keeps its version on rewrite.* The history's row refusal is a new code, `CODE_AUDIT_ROW_INVALID`. A new code changes the catalogue's shape, so its contract is version 2. The writer in `test/codes.test.js` used to write version 1 back over any bump. It now keeps the catalogue's own version.
- **Behaviour unchanged**, by an oracle that ran the original JavaScript beside the port. It used 139 analyses (the benchmark corpus and the repository's own manifests), each in eight variants, and compared:
  - the reduction into rows and its detector evidence (1,112 results);
  - alert reduction;
  - the serializers and `describeKept`;
  - `applyTriage`, `summarizeDecisions`, `rescore` and `normalizeDecision`;
  - 13,344 merge-gate readings across three clocks;
  - the policy preview over the six policy templates.

  All 39,733 comparisons were identical.
- **Size.** The 1,305-line history is now five files, the largest 594 lines. The 616-line triage file is three.
- **Checks:**
  - typecheck and lint;
  - the audit programs: jobs, worker, watch, triage, the triage and history contracts, UI, coverage and accuracy;
  - the contracts, module boundaries and the route surface;
  - the full unit gate and every verify-job gate on Node 22.23.4, the PostgreSQL suites among them;
  - all 28 server tests on the compiled runtime;
  - 56 browser tests on Chromium: audit triage and history, the audit run, risk, licences, polyglot and fold views, the findings inbox and the DOM contract.
