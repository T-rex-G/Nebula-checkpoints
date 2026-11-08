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

### D7c follow-up — An error names itself first

- **What was wrong.** Three D7c error classes (`CodeAuditHistoryError`, `CodeAuditTriageError`, `AuditLimitError`) set `this.name` in their constructors, after their declared fields. A field declaration is defined as soon as `super()` returns, so the name came after the code and status (or the limit). The JavaScript they replaced had the name first. `ContractError` in the shared contracts had the same order.
- **The fix.** Each declares `override readonly name` as its first field, as the other modules' errors already did. The own-property order of each D7c error now matches the original JavaScript's, checked side by side. The guards contract is version 2, and its shape is re-recorded.
- **Now a test.** The module boundary test refuses an error class that declares fields and assigns `this.name` in its constructor, or declares `name` after another field. It failed on `CodeAuditTriageError` and `ContractError` before the fix.

### Qualifier — a press is not lost to a card's repaint

- **What failed.** The candidate qualification's mobile slice on 98ffe34 failed one test. "Show the numbers" on the trust card was pressed, and its table never opened.
  - The trace showed the press delivered with nothing intercepting it, and the disclosure still closed afterwards, with no request in between.
  - The Overview cards are rebuilt whenever a reading they show arrives, up to five times after sign-in. The browser delivers a click only where a press began and ended on one element. A rebuild between the press and the release replaced the summary under the pointer, so no click was fired at all.
  - A bare page reproduced it on desktop and mobile Chromium: a rebuild on `mousedown` gave no click and a closed disclosure; keeping the element gave one click and an open disclosure.
  - The same holds for every control on a rebuilt card: a repository's name on the security posture card, and a pull request or "Read again" on the pull board.
- **The fix.** `apps/web/src/components/held-repaint.ts` holds a card's repaint while a pointer, Space or Enter is down inside it.
  - The held repaint runs, with the latest reading, once the press has been delivered: after its click, or 400 ms after a release that brings none, as a touch can. No press holds a card longer than five seconds.
  - A repaint asked for by the click itself is drawn at once and supersedes the held one, so an older reading is never drawn over a newer one.
  - The workspace pulse's three cards and its activity feed, the security posture card and the pull board all repaint through it.
- **Tests that failed first.** One for each card presses, has a reading land, and releases: the numbers open, the repository's audit opens, the pull request opens. All six runs (three cards, desktop and mobile) failed against the unfixed cards and pass now.
- **Pressing on a settled page.** On CI's first run of these tests (8e45b99), the page had scrolled back to the top once its route finished loading, so the press landed on the page heading, not the card. The CI screen capture showed it. `test/e2e/press.js` now presses only after the network is idle and nothing is moving, with the control confirmed under the pointer and pressed. Each test then fails only on its own claim: all six still fail against the unfixed cards, and pass four times in a row against the fix.
- **A press is seen as the page sees it.** On 98cf33c, CI's mobile Chromium 149 did not set `:active` on a pressed summary. The helper now records the control's own `pointerdown` instead, which is also what the held repaint listens for. The pulse, posture and pull-board press tests pass three times in a row on desktop and mobile.
- **Checks:**
  - lint, typecheck and the inventory;
  - the pulse, posture, pull-board and module-boundary programs;
  - every browser spec that draws the Overview, on desktop and mobile Chromium.

### D8 — Parallax, the deployed-site module

- **One module, behind its index.** `modules/parallax` holds the anonymous site check and the rendered audit:
  - `domain/`:
    - `site-rules.ts`: the thirty-seven rules, the files that must never be served, the debug and directory-listing signatures and the library banners, as data. A rule's id is a type, so a finding cannot name a rule that does not exist.
    - `site-address.ts`: the origin a check accepts, a repository's declared site, the domain whose email policy is read, and a path as it may be shown.
    - `site-headers.ts`: what the response headers enforce, and the cookies.
    - `site-markup.ts`: what a page's markup loads, sends and links to, the libraries it names, and robots.txt.
    - `site-email.ts`: the SPF and DMARC readings, taken out of the check's body.
    - `rendered-address.ts`: the rendered audit's bounds, viewports and addresses.
    - `url-privacy.ts`: which path segments are never repeated.
  - `application/`:
    - `site-check.ts`: the check itself. It stands on Uranus for the grade and the advisory lookup, on posture for the standards and on Quasar for credential detection, so it is application, not domain. Its concurrency is the platform's `boundedMap`.
    - `rendered-audit.ts`: one page in the browser, every request fulfilled through the guarded transport.
    - `rendered-runner.ts`: the disposable child process and the process-tree kill.
    - `rendered-worker.ts`: the child's entry.
  - The index exports `privatePathSegment` and two namespaces with their original names, `siteCheck` and `renderedAudit`: the two share `LIMITS`.
- **The fork entry.** `rendered-site-worker` is a TypeScript entry in `entrypoint.ts`. The compiled tree starts `apps/api/src/modules/parallax/application/rendered-worker.js`, and the compiled-tree test checks it. The entry now starts only in a process with an IPC channel. Loaded anywhere else, it had registered a message listener and a disconnect listener that killed its own process tree.
- **In-page code without the DOM in the server's types.** The server is not compiled against the DOM. The functions the audit runs inside the page declare the slice of it they read, and check for it before reading. They run from their source text and can reach nothing of the module, so each check is written inline.
- **Defects the port found, each with a test that failed first against the original:**
  - *A CDN's library name found inherited names.* An address such as `/ajax/libs/constructor/1.2.3/` or `/npm/__proto__@1.2.3/` was recognised as a library named after a built-in. The report carried a nameless library, and OSV was asked about a package with no name. The CDN table now has no prototype.
  - *A content encoding found inherited names.*
    - A resource sent with `content-encoding: constructor` was handed to the browser undecoded, with its encoding header taken away, as though it had been decoded.
    - With `__proto__`, the request failed as a fetch error.
    - The decoders are now a table without a prototype, so both are refused as unsupported, as any encoding the audit cannot decode is.
- **Behaviour otherwise unchanged**, by two oracles that ran the original JavaScript beside the port:
  - *The site check.*
    - 25,041 comparisons of the pure functions: origins, declared sites, email domains, path privacy, robots.txt, banners and CDN addresses.
    - 1,500 generated sites: every redirect shape, header, certificate, plain-HTTP answer, CORS reply, probe, security.txt, robots policy, page, script, source map, advisory answer, DNS record, request budget, cancellation and a ticking clock. Each compared the report or error, every request made with its bounds, every advisory request and every progress update.
    - All thirty-seven rules fired, and every ledger state was reached. All identical.
  - *The rendered audit*, through a scripted browser: 1,500 scenarios of routed requests, encodings, redirects, limits, page errors, accessibility results, screenshots and documents that change while their evidence is collected. The report and the full log of routing, fulfilment and abort were identical, except where the encoding was an inherited name.
  - Errors keep their own-property order.
- **Removed:** `src/site-check.js`, `src/site-url-privacy.js` and the three `src/rendered-site-*` files. The routes in `src/routes/rendered-audit.js` stay in `src/` until D12 and reach Parallax through its index. So do the server, the tests and the browser fixtures. The baseline inventories keep their baseline paths.
- **Checks:**
  - typecheck under all four projects, lint, syntax, secrets, docs, inventory and verify;
  - the site-check, accuracy, rendered-audit, landing-claims, standards, jobs, audit-UI and route-surface programs;
  - the contracts and the module boundaries;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests;
  - the rendered-audit browser test on real Chromium.
- **Next:** D9 (Pulsar).

### D9 — Pulsar, the live-activity module, and `src/intelligence.js` divided

- **`src/intelligence.js` was four things in one file.** It held webhook intake, the platform's stable hashing and text cleaning, GitHub reference reading, and Corona's evidence, safeguards and snapshots. Each part has gone where it belongs, except Corona's, which goes in D10:
  - `platform/values/stable-hash.ts`: the server's stable JSON, `hashJson` and `hmacJson`. It is not the contracts' canonical JSON. That form differs on `undefined` and `toJSON`, while stored event ids, evidence payload hashes and the session account merge were taken over these bytes, so they are kept byte for byte.
  - `platform/values/text.ts`: `cleanText` and `cleanPath`.
  - `platform/values/path-patterns.ts`: `globToRegExp` and `pathMatches`, which Pulsar's event risk and Corona's safeguards both use.
  - `platform/values/fields.ts` gains `member`. It reads a field as JavaScript reads `value.key`, so code that has always failed on a null value keeps failing the same way, where `read` would forgive it.
  - `modules/github-provider/domain/provider-references.ts`: `referenceSha` and `normalizeProviderBranches`, which read GitHub's answers.
- **`modules/pulsar`, behind its index:**
  - `domain/webhook-events.ts`: a delivery normalised into one event, and its risk.
  - `domain/webhook-signature.ts`: the `X-Hub-Signature-256` check.
  - `domain/activity-feed.ts`: the feed merged from per-repository answers.
  - `application/live-stream.ts`: the bounded writer that drops a reader too far behind, and the live-client admission.
  - The index exports the webhook, signature and stream names flat, and the feed as the `activityFeed` namespace: its `KINDS` and `instant` mean other things elsewhere.
- **What stays in `src/intelligence.js`** is Corona's, unchanged, for D10: the evidence keyrings and record hashes, the protected-path patterns, the repository path, branch and commit validators, the snapshot comparison, the access-surface risk and the access graph's shortest path. An oracle compared each function's source with the original, and all are byte for byte the same.
- **Behaviour unchanged**, by an oracle that ran the original three files beside their new homes. It made 121,548 comparisons, all identical:
  - stable JSON, both hashes and both text cleaners over 4,000 generated values of every shape;
  - 6,000 glob matches;
  - 3,000 reference and branch readings, and live-client admissions;
  - 2,000 signature checks, with any secret `crypto` refuses still refused by a throw;
  - 20,000 webhook deliveries across every event kind. Payloads, commits and repositories were null, primitive or partial. A delivery that failed before still fails, and the same way: a null payload, or a null commit, is a TypeError as it always was.
  - the risk of every normalised and hand-made event;
  - 6,000 repository selections, feeds and timestamps;
  - 4,000 live-stream writes against clients that are healthy, ended, destroyed, full, without `destroy` or `end`, or that throw.
- **Removed:** `src/activity-feed.js` and `src/live-stream.js`. The server, `src/snapshot-signatures.js`, the hosted-drill script and every test reach the new homes. `jsconfig.json` no longer lists the two files.
- **One closure that needed a file.** The continuity-generation test copies the smallest set of files the generator needs into a scratch archive. Since GitHub's reference readers now use the platform's field helpers, that set includes `platform/values/fields.ts`.
- **Checks:**
  - typecheck under all four projects, lint, syntax, secrets, docs, inventory and verify;
  - the intelligence, feed, live-stream, exposure-review, snapshot-signature, recovery, safe-passage and repository-boundary programs;
  - the contracts, codes, module boundaries and the route surface;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.
- **Next:** D10 (Corona).

### D10 — Corona, the safeguards and recovery module

- **One module, behind its index.** `modules/corona/domain` holds what was left of `src/intelligence.js` after D9, and the snapshot signatures:
  - `evidence-ledger.ts`: a record's hash, and the two keyrings. One decides what verifies; the other only explains a failure as an unmigrated chain rather than tampering.
  - `safeguards.ts`: the paths a person has protected in a repository.
  - `recovery-names.ts`: the repository path, branch and commit a restore may act on, and a path as a Git LFS attribute pattern.
  - `snapshots.ts`: what a restore would do, from two snapshots.
  - `snapshot-signatures.ts`: signing under the active key, verifying under the retired and legacy keyrings.
  - `access-surface.ts`: the deploy-key, webhook and collaborator risk, and the access graph's shortest path.
- **Where the baseline put them.** The baseline inventory's file rule grouped `src/intelligence.js` and `src/snapshot-signatures.js` with Pulsar. The inventory's route rule gives every evidence, snapshot, restore, safety and access-surface route to Corona. The code follows its routes: Pulsar has the webhooks, the live stream and the feed (D9), and Corona has the rest.
- **The backup format is platform.** `src/backup-format.js` became `platform/persistence/backup-format.ts`, as the dependency map placed it. Its only callers are the operator's database tool (`scripts/alpha-db.js`) and its tests.
- **Shared helpers:**
  - `platform/crypto/hmac.ts` keys an HMAC-SHA256 with whatever the caller holds, and lets `crypto` refuse a bad key with its own error. The webhook signature, the evidence hash, the snapshot signatures and `hmacJson` all use it, so each fails on such a key exactly as it did calling `crypto` directly.
  - `platform/values/fields.ts` gains `iterable`, which throws the engine's own "is not iterable" TypeError, naming the expression as the engine does.
- **Two variables the configuration registry never knew.** The registry's test finds what the code reads by scanning for `env.NAME` and `process.env.NAME`. The evidence ledger read its two variables as `source.NAME`, so `NV_EVIDENCE_LEGACY_SESSION_KEY` and `NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON` were documented in `.env.example` and the deployment guide but missing from the registry and from the doctor. Both modules now take a typed environment and read each variable by its literal name. The two variables are registered beside `SESSION_SECRET`, whose history they hold.
- **Contracts.** The SHA-256 and commit-id checks use the ids contract. The adoption record loses five copies: one in `src/intelligence.js`, three in `src/snapshot-signatures.js` and one in `src/backup-format.js`.
- **Behaviour unchanged**, by an oracle that ran the three original files beside the port. It made 137,788 comparisons, all identical, and every refusal kept its error class, message, code, status and own-property order:
  - 3,000 evidence key histories: environments, retired-secret lists, opt-ins and keyrings, against genuine, upper-cased and malformed record hashes;
  - 6,000 protected-path maps, branch names, repository paths and LFS patterns;
  - a commit id ending in every code point of the Basic Multilingual Plane, so the contract's lower-case check matches the old case-insensitive one everywhere;
  - 6,000 snapshot comparisons, access surfaces and shortest paths. A forward edge on a path is still the graph's own object;
  - 3,000 snapshot signing configurations, signatures and verifications, retired, legacy and forged among them;
  - the backup format: each implementation's backup opened by the other, the same manifest shape, the same refusals of bad manifests, keys and outputs, and a tampered ciphertext refused with no output left behind.
- **Removed:** `src/intelligence.js`, `src/snapshot-signatures.js` and `src/backup-format.js`. The server, `scripts/alpha-db.js`, the tests, `verify.js` (which now parses every Parallax, Pulsar and Corona file), the syntax manifest, `jsconfig.json` and the package contract reach the new homes.
- **Checks:**
  - typecheck under all four projects, lint, syntax, secrets, docs, inventory and verify;
  - the intelligence, recovery, safe-passage, repository-boundary, backup-format, alpha-db, snapshot-signature, live-stream and exposure-review programs;
  - the contracts, codes, module boundaries, package contract, route surface and continuity generation;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests;
  - the D9 oracle again, over the shared HMAC helper: 121,533 comparisons identical.
- **Next:** D11 (the HTTP pipeline).

### Qualifier — a press test that missed its own press

- **What failed.** On `dbe8c70` the qualification's mobile slice failed "a reading that lands during the press on a repository does not swallow it" before the reading landed: the test helper reported that the repository's name was not being pressed.
- **Why.** The helper attached its `pointerdown` listener to the control and then pressed. Hovering scrolls the control into view, which can start the pull board's reading after the page has gone quiet, and that reading redraws the Overview cards. A redraw between the listener and the press left the listener on an element the page no longer showed, while the press landed on its replacement. A probe that redraws at exactly that moment reproduced it on desktop and mobile.
- **Fix.** `test/e2e/press.js` records the press's target at the window and looks for it in the control as the locator finds it after the press. The product's behaviour is unchanged: a redraw before the press was never held, and one during it still is. The probe passes with the new check, and the six press tests pass three times in a row on desktop and mobile.

### D11 — The HTTP pipeline

- **Each global step is a factory in `apps/api/src/http/pipeline`, behind one index:**
  - `legacy-cookies.ts`: the owner cookies from before provider authentication, cleared on sight and never adopted;
  - `correlation-id.ts` and `request-log.ts`: one safe request identity, and the structured line written once an API answer has gone;
  - `security-headers.ts`: the framing, sniffing, isolation and feature policy, the CSP, and HSTS and `upgrade-insecure-requests` in production;
  - `api-cache.ts`: every API answer no-store, except a 200 the offline binding vouches for. The binding is handed in;
  - `same-origin.ts`: the app header, fetch metadata and origin checks on unsafe API calls, and `SAFE_API_METHODS`, which CSRF verification also reads;
  - `rate-admission.ts`: the local bucket in front of the shared counter. The caller's identity and the counter are handed in, so the order that keeps a throttled flood from becoming a query per request can be tested by watching it;
  - `maintenance.ts`: the switch, read once, and the API's 503;
  - `static-files.ts`: the JSON body and the built page's files.
- **Order stays where it is policy.** The server installs each step where the inline middleware was, so its position among the routes is unchanged. The route policy reads the steps by their factory names now: `test/oracles/route-policy.js` gives each label the baseline's inline signature and the factory's name, and the record is unchanged: 195 routes, 13 steps, the same 1,011 negative-matrix answers.
- **Environment reads stay per request where they were.** The cookie, header and origin steps take the environment and read `NODE_ENV`, `PUBLIC_BASE_URL` and `RENDER_EXTERNAL_URL` by name on each request, as the inline code did. Maintenance is read once at startup, as before.
- **The contracts' names, not copies.** The steps read and write the correlation, app and offline headers by the names `packages/contracts` gives them, and check a supplied correlation id with `isCorrelationId`. The adoption record shrinks: `server.js` holds 9 copies, not 19, and six contract exports that waited for a consumer now have one. The contracts spell header names in lower case, so three response headers (`x-nebulaverse-correlation-id`, `x-nv-offline-scope` and `x-nv-offline-repo`) and two `Vary` entries are now written in lower case. HTTP compares field names without case (RFC 9110, section 5.1), and every reader in the product and its tests already did, so no answer changes.
- **The alpha access boundary moves with its routes in D12.** It shares the alpha session helpers with the alpha routes, so it moves with them into identity-access rather than being split from them here.
- **Behaviour unchanged**, by an oracle that cut each inline middleware out of the previous server source and ran it beside its factory. It made 264,048 comparisons, every call on the response compared in order, header names without case:
  - the cookie, header and origin steps over 24,000 generated requests across six environments, production and public origins among them;
  - 6,000 correlation identities and their log lines;
  - 6,000 offline bindings, each status line written in every form `writeHead` accepts;
  - 12 rate-admission rounds of 4,000 to 16,000 requests, with and without a shared counter that allows, refuses and fails, clock jumps across the window and the stale sweep, and three rounds that hold more than 5,000 live buckets so the size cap decides. Mutants that remove the cap, or shift it by one at the break, fail the oracle;
  - maintenance over twelve spellings of the switch.
- **Six source-reading checks became behavioural:**
  - `rate-limit-server-contract` drives the admission step with a counter that records every question: a refused caller is answered from memory, a failing counter answers 503 and never `next()`, and the local ceiling refuses without a query. Mutants that consult the counter first, or let a failure through, fail it.
  - `public-errors-server-contract` runs the correlation and logging steps, including identities that must be replaced rather than echoed. It reads the order from the route policy.
  - `security-foundation-contract` sends the same-origin step the cross-site and foreign-origin requests it exists to refuse, and reads from the route policy that it stands in front of every API route.
  - `offline-cache-policy` writes status lines through the no-store step and reads the binding headers it leaves.
  - `overlay-motion` and `verify.js` read the CSP from `contentSecurityPolicy`, in both environments, rather than from the server's text.
- **New:** `test/http-pipeline.test.js` holds each step's guarantees in both environments, so they outlive `server.js`.
- **Checks:**
  - typecheck under all four projects, lint, syntax, secrets, docs, inventory and verify (which now parses every pipeline file);
  - the architecture oracles, server smoke, maintenance mode, configuration registry, rate-limit and public-error contracts, the alpha access and privacy server contracts and module boundaries;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.
- **Next:** D12 (routes).

### D12a — Routes leave the server: Parallax first, and the route policy follows them

- **How a route leaves `server.js`.** A module's routes move to a registration function in its `http` folder, `register...Routes(app, deps)`, behind the module's index. The guards are handed in and destructured under the names the route policy records, so each guard chain reads as it always has. The server calls the function where the routes were, so their place among the other routes and middleware is unchanged.
- **The route policy reads registration functions in place.** `test/oracles/route-policy.js` reads a call to any `register...` function defined in an `http` folder under `apps/api/src`: the routes its body registers, in that order, and the registration functions it calls in turn. A name defined in two files is resolved within the calling file, and refused from the server rather than guessed at. `src/routes/rendered-audit.js` was the one route file before this, read by a rule that named it; that rule is gone with the file. The record is unchanged: 195 routes, 13 steps, the same 1,011 negative-matrix answers.
- **Parallax.** `modules/parallax/http/parallax-routes.ts` registers the rendered audit's four routes and the site check's two, in the recorded order, and returns both job queues for the server's account cleanup and shutdown. The job belongs to `viewer(req)`, which the server supplies from the provider session, so the module reads no request property the server sets. `src/routes/rendered-audit.js` is removed.
  - The rendered audit's environment switch and browser path are read by name in the module, so the configuration registry still sees both.
  - A progress value from the browser worker that is not an object is passed to the jobs as `null`. The jobs ignored it either way, and a structured clone never carries a function.
  - The site check is handed in like the rendered audit's runner, `checkSite` unless a test supplies one.
- **Tests that read where routes were now read the route policy:**
  - `provider-route-inventory` takes each authenticated route's capabilities from its guard chain as the policy reads it, wherever the route is registered, and scans every file that registers a route for capability names and the experimental opt-in.
  - `route-surface` requires every registration function a module's `http` folder exports to be called by the server. Its ratchet on routes registered in `server.js` itself falls from 187 to 185, and falls again with each move.
- **Behaviour unchanged**, by an oracle that ran the previous `src/routes/rendered-audit.js` and the site-check handler cut from the previous `server.js` beside the new module. It ran 90 rounds of 250 scripted requests on a held clock, with every route, viewer and address, launches that report, fail, throw or hang, cancellations, and the browser enabled, disabled or missing. 45,000 answers were identical in status, headers and body, and every kind of answer was reached: both throttle messages, in progress, busy, cancelled, failed and complete reports. Mutants that move either throttle window by a second, or trim the rendered audit's recent launches, fail the oracle.
- **New:** `test/parallax-site-check-routes.test.js` holds the site check's routes over HTTP, with the check handed in and the clock held. It covers who may ask, the addresses refused before anything runs, the job and its poll, both throttles and their `Retry-After`, one check per viewer, and the repository route. Until now no test reached these routes.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new file);
  - the architecture oracles, route surface, provider route inventory, module boundaries and configuration registry;
  - the rendered audit and site-check route tests;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.
- **Next:** the other modules' routes, smallest first, each receiving the guards it uses as Parallax does. Identity-access goes last: it owns those guards, the sessions and the alpha access boundary.

### D12b — Posture's routes

- **Two registration functions, because the routes sit in two places.** The workspace posture, the security posture and the findings inbox are registered together where they were; branch protection is registered later, among the repository routes. `modules/posture/http/posture-routes.ts` therefore exports `registerWorkspacePostureRoutes` and `registerBranchProtectionRoutes`, and the server calls each at its route's place. The route policy is unchanged.
- **What the routes are handed.** Each route receives its guards, the session's provider account through `account(req)`, and the server's error answer. The workspace routes also receive the database's state and the stores as the server builds them: Uranus's audit history, Quasar's exposure scans and Kepler's governance store. They also receive Quasar's rule severity and path masking, and Kepler's triage vocabulary. The posture reader is built inside the module from the same ports, so the server no longer holds it. Branch protection reads the provider through the server's transport, and checks a branch name with Corona's `normalizeBranchName`, as it always did.
- **One order kept on purpose.** The security posture and the inbox refuse a non-GitHub account first, then answer "not configured" or "database unavailable", and only then work out the workspace scope. The first port computed the scope before the database checks. An account whose scope cannot be normalised would then have been refused where it had always been told there was no database. The oracle below found it, and a mutant that restores that order fails it.
- **Behaviour unchanged**, by an oracle that ran the four handlers cut from the previous `server.js` beside the module. Each handler got its own world from the same seed, and the oracle compared every answer (status, `Cache-Control`, body) and every call made to the database, the stores and the provider. Across 6,000 scenarios it varied:
  - ten account shapes, among them none, other providers, an Enterprise base URL, an unparseable one, no login, and a number;
  - a database that is absent, ready, down or throwing;
  - each of six store readings answering, rejecting or throwing;
  - provider answers that succeed, deny or fail;
  - nine branch names.

  All 12,000 comparisons were identical, and every outcome was reached: available, not configured, database unavailable, refused, scope invalid, identity invalid, branch rules unsupported, not found, provider failed and internal.
- **Source-reading checks became one behavioural test.** `posture-summary`, `findings-inbox` and `workspace-posture` each read their route out of `server.js`. They now test their domain only. `test/posture-routes.test.js` holds all four routes over HTTP, with the stores handed in:
  - their guard chains, from the route policy;
  - no-store on every answer;
  - the two workspace readings never reading the credential (a getter on the account reports it) and never asking the provider;
  - every store asked for this identity only;
  - paths masked on the server;
  - a failing store leaving only its own part unmeasured;
  - the database's absence said, with nothing asked;
  - branch protection reading only the open repository and refusing a bad branch name.

  The posture route's body is still checked by its text for the token, since the reader it calls reads the token by design.
- **Ratchet:** the routes `server.js` registers itself fall from 185 to 181.
- **Checks:** typecheck, lint, syntax, secrets, docs, inventory and verify; the architecture oracles, route surface, provider route inventory and module boundaries; the posture tests; the full unit gate and every verify-job gate on Node 22.23.4; the compiled-server tests.

### D12c — Pulsar's routes, and the live-stream registry

- **Two registration functions.** The repository's activity and the overview's feed are registered together; the five live-event routes come later among the repository routes. `modules/pulsar/http/activity-routes.ts` therefore exports `registerActivityRoutes`, and `live-event-routes.ts` exports `registerLiveEventRoutes`. The route policy is unchanged.
- **The live-stream registry is Pulsar's.** The streams open on an instance were a module-level map that five places in `server.js` reached into: the stream route, the webhook broadcast, sign-out and session replacement, emergency containment, and shutdown. `application/live-hub.ts` now holds them behind one interface: admission under both caps, add and remove, broadcast with the slow-reader drop, closing a session's streams, closing an alpha stream, and shutdown. Each stream's provider session is kept beside the stream rather than set on the response. The server creates one hub, and every one of those places uses it.
- **The event cursor** (`domain/event-cursor.ts`) leaves `server.js` with the only route that reads it.
- **Provider answers are read as JavaScript read them.** These handlers walk the provider's JSON (`c.commit.author.name`, `p.merged_at`). In the module, every such step is a `member` read, which fails on a missing entry as property access does and leaves a missing property out. A message that is not text fails the request as `.split` on it did, and a date is constructed exactly as `new Date(value)` would. What reaches a caller is decided by the public error body, as before.
- **What the routes are handed:** their guards and the session's account; the provider transport and the database; the evidence ledger's key, append and retained actor; the alpha's switch, tester, session and webhook records; the provider resource key and authority; this deployment's public address and the session seal; the session a request belongs to; and the hub.
- **Behaviour unchanged**, by an oracle that ran the seven handlers cut from the previous `server.js`, with the previous registry and cursor code, beside the module. Each handler got its own world from the same seed, and the oracle compared every answer (status, headers, body, and what a stream wrote), the registry's state after each request, and every call to the provider, the database, the alpha records and the ledger, in order. The 20,000 scenarios varied:
  - account shapes;
  - provider lists that are empty, full, truncated, malformed or failing;
  - webhook rows that are active, inactive, recorded under the expected resource, under another one, or missing;
  - hook creation, deletion and read-back each succeeding, denied, gone or failing;
  - every alpha cleanup answer, and database failures at each statement;
  - cursors, and streams already open against both caps.

  All 40,000 comparisons were identical, and every outcome was reached. Mutants that take a successful provider deletion as proof the webhook is gone, or that admit a stream past its caps, fail it.
- **A correction to the D11, D12a and D12b oracles.** Building this one showed that the generator those three drew their scenarios from lost precision and cycled, so they explored fewer distinct cases than their counts suggest. They were rerun with mulberry32, the generator D8 to D10 used. Each still made the same number of comparisons, all identical, and every mutant named in its entry still fails it. The D11 oracle now also catches a rate-admission cap shifted by one, which the cycling generator missed.
- **Source-reading checks became behavioural or follow the policy:**
  - `test/pulsar-live-event-routes.test.js` holds the registry and the five routes over a database, provider and alpha records handed in. It covers admission under both caps, closing only the named sessions, a webhook the server could not record being removed with its row, and the alpha's claim on connect. On disconnect it checks ownership decided before any provider deletion, a deletion trusted only after a read-back finds the webhook gone, and a shared or foreign webhook left alone. It also covers paging by cursor and the stream's readiness and release. It replaces the live-event slices of `provider-disconnect-server-contract` and the orphan-cleanup line of `hardening-contract`.
  - `mutation-gateway-server-contract` and `mutation-coverage-server-contract` read each route's mutation context, and the unclassified repository writes, from the route policy, so they follow a route into whichever module registers it.
  - `verify.js` holds the server to calling `registerLiveEventRoutes`, and Pulsar's file to registering the connect and stream routes.
  - `hardening-contract` holds the server to creating the hub with both caps, and reads the stored-events paging from Pulsar's file; `corona-recovery` cuts its routes up to Pulsar's registration.
- **Ratchet:** the routes `server.js` registers itself fall from 181 to 174.
- **Checks:** typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the four new files); the architecture oracles, route surface, provider route inventory, module boundaries and configuration registry; the live-stream, Pulsar reliability, provider-stream, alpha boundary and contract tests; the full unit gate and every verify-job gate on Node 22.23.4; the compiled-server tests.

### Qualifier — the press is made where the control is, not where it was

- **What CI found.** With the settling helper (`26b21ea`), CI's mobile slice named where a missed press landed: a severity bar beside the repository's name, in the security posture card.
- **Why.** `hover()` leaves the pointer where the control was when it scrolled into view, and a reading that the scroll starts can move the card after that. The helper waited for the page to hold still and checked the control's new centre, but pressed wherever the pointer had been left. A probe that moves the card after the hover reproduced the miss on desktop and mobile. It also showed that the move can carry the control out of view.
- **Fix.** After settling, `test/e2e/press.js` scrolls the control back into view if it left, settles again, moves the pointer to the control's centre as it is now, and checks and presses that point. The probe presses the control with the fix. The six press tests pass three times in a row on desktop and mobile. The earlier qualifier entries on these tests stand: the redraw race was real, and this was a second cause behind it.
- **Held in CI.** On `63b8a74`, all 27 checks that run without the owner's authorization passed: every browser shard on both runs, the browser matrix, integration, verify, the compiled server and the qualification's `automated` run. The four live jobs were skipped, as designed.

### D12d — Quasar's routes

- **One registration.** The twelve exposure routes were contiguous in `server.js`, so `modules/quasar/http/exposure-routes.ts` exports a single `registerExposureRoutes`. It registers them where they stood and in their order, so the route policy is unchanged.
- **What moved with them:**
  - The finding payload, with the set of rules a verifier exists for (`http/finding-payload.ts`).
  - The severity lookup a scan's history sums by (`exposureSeverityOf`, now in `domain/exposure-narration.ts`). The security posture's registration takes it from Quasar's index.
  - The comment that explains why the chain is load-bearing.
- **What stays in the server.** The store is shared with the scan worker, so `exposureService` stays in `server.js` and is handed in. The failure helper also stays, because the code-audit routes use it until Uranus's routes move.
- **What the routes are handed:**
  - their guards, including the governance role, `OWN_WORK` and the mutation context;
  - the governance context and the session's account;
  - the retained actor, the public error body and the store;
  - the worker's nudge;
  - the four keys, each under its own name;
  - the repository reader, the credential verifier and the readability prober.

  The two outbound clients are handed in rather than imported, so a test can give them a stand-in transport.
- **One deliberate change.** The old severity lookup indexed the narration table directly. A rule named after an inherited property, such as `constructor`, found the prototype's member, and a history summed it as `undefined`. The lookup now uses the table's own entries, as `narrationForRule` does, so such a rule counts as serious, like any rule without an entry. Stored rules are detection rule names, so no stored finding can reach this case. `exposure-narration.test.js` now checks the lookup for every rule and for these names.
- **Behaviour unchanged otherwise**, by an oracle that ran the twelve handlers cut from the previous `server.js` beside the module. The old side included the previous payload, severity lookup and failure helper. Both sides used the real detection, fingerprints, grant signing, project discovery and public error body, a held clock and the same UUIDs.

  The 20,000 scenarios varied:
  - store answers, and failures that are coded, uncoded, carry a credential in their message, or carry a status that is not an integer;
  - a missing database;
  - files that are missing, unreadable, changed, not text, or without a project reference;
  - fingerprints in either case and under either key version;
  - every body shape, including a Buffer, a string and confirmations given as arrays;
  - governance contexts and accounts that are missing;
  - queries.

  The oracle compared every answer and every call to the store, the reader, the verifier, the prober, the nudge and the actor lookup, in order. All 40,000 comparisons were identical, including 183 verifications and 63 probes that went out. Fourteen mutants fail it, each on a comparison rather than a crash:
  - a confirmation without `authorized: true`;
  - an accept-risk without the identity;
  - history on any truthy value;
  - a two-minute grant;
  - a probe grant signed with the verification key;
  - `probeable` naming another rule;
  - a fingerprint left in its case;
  - failures defaulting to 400;
  - a clear that reaches the store before its confirmation;
  - every severity summed as serious;
  - a scan request that does not start the worker;
  - untrimmed columns;
  - a verification recorded under a fixed name;
  - a probe that reads the file before refusing a key that is not anonymous.
- **Source-reading checks became behavioural or follow the policy:**
  - `test/quasar-exposure-routes.test.js` reads each route's chain from the route policy. Over HTTP, it checks:
    - the identity in every store call;
    - each explicit word refused before the store or the repository is read;
    - the file read at the finding's commit, and the candidate matched by fingerprint;
    - grants that the real verifier and prober accept, through a stand-in transport, with a one-minute life and bound to the project and question;
    - a grant signed with the wrong key refused before the network;
    - neither credential in a response or a record;
    - both sentences on every finding, and the path masked;
    - every route failing through the public error body without repeating a message.

    It replaces the route sections of `exposure-worker.test.js`, which keeps how the server hands the routes their keys and clients.
  - `authorization-resolver-server-contract` reads the identity-scoped and administrator routes from the route policy, and counts `OWN_WORK` in both files that hold it.
  - `exposure-report-client` uses the module's payload rather than evaluating a slice of `server.js`.
- **Ratchet:** the routes `server.js` registers itself fall from 174 to 162.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the two new files);
  - the architecture oracles, route surface, module boundaries, contracts and configuration registry;
  - the exposure, narration, report-client and authorization tests;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.

### D12e — Uranus's routes, and the code-audit service

- **A service as well as routes.** Uranus's twelve code-audit routes were contiguous in `server.js`, but their helpers were not only theirs. The governed merge reads the merge gate and a pull request's facts, sign-out forgets an account's audit, shutdown closes the jobs, and the security posture reads the kept history. `modules/uranus/application/code-audit-service.ts` holds all of it, and the server builds it once:
  - the audit jobs;
  - the lazily opened history, watch and triage stores;
  - one audit run, start to finish: the per-audit provider pool, the guarded transports, the off-thread analysis, the team's decisions, the record and the clocks;
  - the record that never fails an audit, except by its cancellation;
  - a collaborator's decisions;
  - a pull request's facts, the merge gate and the policies a merge would meet.

  `http/code-audit-routes.ts` registers the twelve routes in the route policy's order, answering from the service. The history guard, the ref and finding-id checks and the failure helper move with them, so the last copy of that helper leaves `server.js`.
- **Ports.** The service takes its run ports (the session pool, the guarded transport, the repository audit and the two off-thread functions) and its stores, each with the real ones by default. A test can stand them in without a database or a worker thread.
- **The worker's answer is checked where it crosses.** The off-thread analysis returns what the worker posted, which TypeScript cannot vouch for. The run now checks the parts the audit reads before passing the rest through: the components and the two status objects of an analysis, and the raw matches and packages of a rules-only batch. Anything else fails the audit, or leaves that batch unread, as reading those parts already did. The worker always posts the engine's own output, so no reachable answer changes. No type assertion was added.
- **Behaviour unchanged otherwise**, by an oracle that evaluated that whole region of the previous `server.js` beside the module's routes and service. The old region kept its audit jobs, stores, record, triage, clock, pull-request, merge-gate and failure helpers. Both sides used the real triage rules, clocks, merge gate, kept-audit description, watch, authorization check and public error body, and the same held clock.

  The 20,000 scenarios varied:
  - every job answer, and audits a job launched, run to their end or aborted before they start, after the analysis, during the team's decisions or during the record;
  - audits that fail, results with and without a clock policy, and record outcomes that succeed, fail or are cancelled;
  - authorization snapshots for a collaborator, a reader, a public reader and another repository, and a resolver that fails;
  - decisions in force, lapsed and under another rule, and a decision store that fails;
  - store failures at each method, with and without a database;
  - pull requests from the same repository in another case, from a fork, missing their branches or naming no repository, and a provider that fails;
  - a policy store that is not ready or fails;
  - finding ids of every length and case, reviewer roles that are not booleans, every body, ref, run, refresh and pull value, and missing governance contexts and accounts.

  The oracle compared every answer, every launched audit's result or failure, and every call to the jobs, the pool, the audit, the worker, the provider, the resolver, the stores, the policy store and the warnings, in order. All 60,000 comparisons were identical, over 1,669 launched audits. Eighteen mutants fail it, each on a comparison:
  - an audit without the team's decisions;
  - a record without the signal;
  - no clocks;
  - a cancellation swallowed as a history failure;
  - a public reader's audit carrying the team's decisions;
  - the pool left open;
  - a fork compared by case;
  - a stage's detail dropped;
  - GraphQL reads through the pool;
  - a gate whose policy store failed answering nothing;
  - a clear on another word;
  - a finding id of twenty characters;
  - metrics reading decisions for a public reader;
  - an unavailable history refusing a read;
  - anyone able to decide;
  - a decision under another key;
  - another retry interval;
  - a job under another identity.

  Two of these survived the first generator, which drew no finding id of that length and no reviewer role that is not a boolean. It now draws both.
- **Tests:**
  - `test/uranus-code-audit-routes.test.js` reads each route's chain from the route policy. Over HTTP, on the real service with stood-in ports and stores, it checks:
    - an audit started and its result fetched by run id;
    - the decided finding moved out of the open ones, and the open one's clock;
    - no history without a database, and the gate unavailable;
    - kept audits read for this identity and refused for a missing or overlong ref;
    - the clear's word checked before the store;
    - `canDecide` only for a literal true;
    - a decision made in the reviewer's name, and refused for a bad id before the store;
    - the pure grade;
    - metrics that leave decided findings out for a collaborator and ask nobody for a public reader;
    - a fork's head never read, and the same repository in another case not treated as a fork;
    - a failing policy store, and failures without their message.
  - `code-audit-cancellation-server` drives the route and the service rather than a slice of `server.js`.
  - `authorization-resolver-server-contract` counts `OWN_WORK` in each module that receives it, with one hand-over per module.
- **Ratchet:** the routes `server.js` registers itself fall from 162 to 150.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the two new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the code-audit, merge-gate, authorization and posture tests;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.

### D12f — Corona's routes, and recovery

- **Five registrations.** Corona's fifteen routes stand in four places in the route policy, with the workbench's, Pulsar's, Uranus's and Parallax's routes between them. There is one registration per concern in `modules/corona/http/`, each where its routes stood, in the policy's order:
  - `registerCommitRecoveryRoutes`: a repository or some of its paths restored as a new commit, a commit's file listing, and a branch moved back;
  - `registerSafeguardRoutes`: the session's safety state, read and changed;
  - `registerSnapshotRoutes`: a snapshot of the references, a comparison, a restore preview, signed snapshots, the emergency manifest, and the restore that spends a preview's grant;
  - `registerAccessSurfaceRoutes`: who and what can reach a repository;
  - `registerEvidenceRoutes`: the evidence chain with its events and signed snapshots.
- **Recovery is a service.** `application/recovery.ts` holds the snapshot capture, its paging, the comparison against a kept snapshot, and the restore grant: issued, inspected, prepared, claimed once and preflighted. The mutation descriptor reads a grant before the restore runs, so the server builds the service once and both use it. The grants' in-process store belongs to the service. The shared store is handed in for when a database is configured.
- **What stays in the server.** The safety state, the sessions and their revocation, and the live streams belong to identity-access and Pulsar's wiring until those move. The commit writer and the head checks belong to the workbench. They are handed in. The two snapshot limits read the environment, so they stay where the configuration is read.
- **Behaviour unchanged**, by an oracle that evaluated those five regions of the previous `server.js` beside the module's registrations over the recovery service. Both sides used the workbench's head checks, the real name normalizers, snapshot comparison, reference shapes, single-use store, access-surface risk and public error body, the same seal, and a held clock and UUIDs.

  The 20,000 scenarios varied:
  - branch and tag lists in both providers' shapes, empty, a page long or longer, failing or not a list;
  - default-branch trees that are full, truncated, missing or not a list, against every manifest limit, including one equal to the file count;
  - commits and their messages, heads that are present, moved or missing, and branch reads that fail;
  - forced writes refused as conflicts, and reference creation refused because the branch exists;
  - protected paths, safety states and their store refusing or unavailable;
  - evidence, session inventories and revocations, signature checks, database readiness and failures, and the mutation gateway's operations;
  - every kind of restore grant: from a real preview, recreations, resets, expired, for another repository, identity or provider, too many actions, duplicate branches, a bad commit, the wrong kind, garbage, empty and oversized, each also replayed;
  - snapshots of every kind, for other repositories and providers, with too many references, without references, or not objects;
  - collaborators, deploy keys and webhooks with each permission and address shape, and each list failing in turn;
  - hosted alpha on and off, and accounts for both providers or none.

  The oracle compared every answer, the grant each side reads, the branch heads afterwards, and every call to the provider, the commit writer, the protected-path check, the safety store, the ledger, the sessions, the database, the signatures and the single-use store, in order. All 60,000 comparisons were identical, including 233 restores that went through, 151 that partly failed and 107 replays refused. Twenty mutants fail it, each on a comparison:
  - a restore that never spends its grant;
  - a twenty-minute grant;
  - a grant for anyone;
  - duplicate branches in a grant;
  - a manifest cut one late;
  - an unread tag list reported as read;
  - every preflight failure read as a missing branch;
  - the shared store used without a database;
  - one reference too many accepted;
  - a forced restore;
  - a reset without its head check;
  - a preview that ignores read-only mode;
  - containment in a hosted alpha;
  - one more snapshot kept;
  - a partial failure not told apart;
  - a ledger failure failing a safety change;
  - a safety change recorded under another repository;
  - write access named by its flag;
  - insecure delivery read backwards;
  - an evidence snapshot trusted unchecked.

  Two of these survived the first generator, which drew no manifest limit equal to the file count and no branch read that failed other than as missing. It now draws both.
- **Tests:**
  - `test/corona-routes.test.js` checks each route's chain against the baseline inventory. Over HTTP, on the recovery service with a scripted provider, it checks:
    - a restore committed on the head it read and never forced, and refused on a head that moved;
    - a path restore refused for a protected path before anything is written;
    - a reset that checks its head;
    - a safety change committed, then evidenced, then copied, and kept when the ledger fails;
    - both providers' reference shapes and a disclosed tag failure;
    - a truncated manifest;
    - signed snapshots pruned and verified;
    - containment that revokes only the other sessions and closes their streams;
    - a hosted alpha's containment refused before anything happens;
    - an access surface that keeps only a webhook's host and says when it is partial;
    - evidence verified as it is read.
  - `corona-recovery` drives the snapshot routes and the service rather than evaluating slices of `server.js`.
  - The source checks follow the code into the module, or read the route policy:
    - `alpha-access-server-contract` reads every route's alpha boundary from the policy, so it now holds all 135 repository routes, not only those left in `server.js`, and its mutation cases edit the policy;
    - `capability-registry-server-contract` and `provider-disconnect-server-contract` read each route where the policy finds it;
    - `hardening-contract`, `mutation-coverage-server-contract` and `security-foundation-server` read the recovery service and routes for the grant's claim, its placement and the retention query.
- **Ratchet:** the routes `server.js` registers itself fall from 150 to 135.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the five new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - every converted contract and the recovery tests;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.
  - A cut of `server.js` is also checked by comparing its top-level statements before and after. That check caught a first cut that had taken the Uranus and Parallax registrations with the access surface, before anything ran.

### Qualifier fix — the release test inside its time

- **What failed.** The qualification's runtime matrix on D12f (`5f9ba1b`) failed two programs. `package-release` was stopped at the matrix's 45-second limit. `public-alpha-provenance` then failed 32 ms in, because the release test had moved `PUBLIC_ALPHA_PROVENANCE.json` aside for its missing-artifact case when it was stopped. The second failure follows from the first.
- **Why.** The release test cuts a release twelve times, and every cut runs the foundation gate's six checks one after another. Over the mission those checks grew:
  - `verify` now parses each TypeScript module;
  - the route checks read the route policy through the TypeScript parser;
  - the server boots TypeScript modules.

  Measured on this container, the test took 60 s on D12f against 29 s on `main`, and a gate took about 6.2 s against 3.4 s. This was not a flake: the test was over the limit wherever it ran slower than CI's runner.
- **The fix**, with no check removed, weakened or skipped:
  - **Concurrent checks.** The gate runs its checks at once. They share no port, file or state: the one that starts a server picks a random port and logs to a file named by its own process. Each check's output is held and printed in the checks' order, up to and including the first that fails, and that check is the failure the gate reports. This is what running them in turn showed.
  - **Cheap checks first.** The packager settles where the archive may go, and whether the generated documents are current, before the gate. A release refused for either is refused at once. The manifest is still read after the gate, which reports a missing foundation artifact by name.
  - **The server boots in parallel.** `capability-registry-server-contract` starts its server before it loads its modules and runs its source and route-policy checks, so the boot overlaps them. The server is stopped, and its provider log removed, however the program ends. A static check made to fail leaves no server behind.
- **Result.** On a clean checkout of D12f with the fix:
  - the release test takes 37–39 s, where it took 60 s (`main` takes 29 s);
  - a gate takes about 3 s;
  - the contract check takes 1.9 s, where it took 2.3–2.6 s.
- **Checks:** the release test, the contract (whole and focused), lint, and the full unit gate and every verify-job gate on Node 22.23.4, on a clean checkout with the fix.

### D12g — Kepler's routes

- **Two registrations.** Kepler's fifty governance routes stand in two runs in the route policy, with Quasar's exposure routes between them. `modules/kepler/http/governance-routes.ts` registers each run where it stood:
  - `registerGovernanceRoutes`: templates and baselines, the digital twin, notifications, webhooks and evidence exports, policies with their drafts, versions, simulations, reviews and decisions, and exceptions up to their decision (39 routes);
  - `registerGovernanceLifecycleRoutes`: the rest of a policy's life, from an exception's revocation through activation and rollback, deactivation, archive and restore, a draft's discard and a version's withdrawal, to a reset of the repository's governance (11 routes).
- **What moved with them.** `governanceFailure`, the answer a governance failure gets, moves into the module and is exported, because the server's governance guard and its two mutation guards still answer with it. The repository facts a baseline is generated from move in as `readRepositoryFacts`, reading the provider through the `gh` that is handed in. The routes load the access projection from Kepler's own domain, so the server no longer imports it.
- **What stays in the server.** The governance guard resolves the caller's authorization and attaches the service. The mutation guards build each action's descriptor. The read-only exemptions name the control-plane routes. All of these belong to the pipeline and to identity-access's authorization until those move. The routes read what the guard attached through `governance(req)`, so the request is the only thing they share with it.
- **Behaviour unchanged**, by an oracle that evaluated both regions of the previous `server.js`, with the failure and facts helpers they used, beside the module's two registrations.

  The 20,000 scenarios varied:
  - each of the fifty routes;
  - a governance service that answers or fails per method, with governance, mutation, authorization, simulation and policy errors, statuses out of range, long and control-character messages, raw errors, thrown strings and null;
  - every path parameter present or absent, including empty and traversal-shaped ones;
  - query values that are numbers, words, empty or repeated;
  - bodies that are absent, empty, objects, text or null, with and without an idempotency key;
  - governance contexts with and without a service, a scope key or an authorization;
  - repositories of every visibility, archived or not, with branch lists that are empty, mixed, a full page, not a list or failing.

  The oracle compared every answer (its status, headers, body, and a sent export's type and bytes), every service call with its input, the provider reads and the logged failures, in order. All 40,000 comparisons were identical, including 231 export downloads and 1,934 reads that failed as unknown. Twelve mutants fail it, each on a comparison:
  - a policy error answered as unknown;
  - a shorter message;
  - an unknown failure not logged;
  - a twin without its access;
  - an export under another name;
  - an export as plain JSON;
  - preferences without their idempotency key;
  - one protected branch fewer;
  - a full page of branches read as complete;
  - a reset answered as a read;
  - notifications without their cursor;
  - protected branches left unsorted.
- **Tests:**
  - `test/kepler-governance-routes.test.js` checks each route's chain against the baseline inventory. Over HTTP, on the real governance service with a store that records what it is asked, it checks:
    - templates served from the catalogue, touching neither the store nor the provider;
    - a baseline built from the repository's own facts, equal to the domain's own build from those facts: only protected branches, sorted and bounded at fifty, with a full page of branches, the truncation and an archived repository each warned of;
    - a provider failure during a baseline answered as unknown, and logged by its code alone;
    - a role the service refuses before the store is touched;
    - the server's scope and actor on each call, with roles in a body never passed on;
    - query, path, body and key reaching the store for reads, revocations, archives and discards, each through its gateway action;
    - an archive without its key refused before the store;
    - an export downloaded as its envelope under its own name and type;
    - a digital twin whose access is the caller's, a reader's and an administrator's apart;
    - a raw failure's words kept from the answer and the log, and a governance error's kept, bounded, with a status outside 4xx and 5xx answered as 500.
  - The source checks read the route policy or the module:
    - the eight governance server contracts (activation, API, delivery, enforcement, exceptions, interface, simulation, and templates with the digital twin) find each route, its role and its gateway action in the policy, and the handlers' code in the module;
    - `capability-registry-server-contract` reads the governance routes' guards from the policy;
    - `verify` reads the digital twin's access projection in the module.
- **Ratchet:** the routes `server.js` registers itself fall from 135 to 85.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new file);
  - the architecture oracles, route surface, module boundaries and contracts;
  - every converted contract and the new route test;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.
  - Comparing `server.js`'s top-level statements before and after the cut left only the fifty routes, the two helpers and the import change.

### D12h — the workbench's repository, content and history routes

- **A new module.** `apps/api/src/modules/workbench` is the repository as a person works in it. This step moves the first twenty of its forty-five routes, in the two runs the route policy keeps them in:
  - `registerCodeownersRoute`: who owns what, by the repository's CODEOWNERS file;
  - `registerRepositoryRoutes`: the repositories a session may see and a new one, a repository's view, its deletion and archive, a branch created or deleted, and two refs compared;
  - `registerContentRoutes`: a folder's listing, a branch's file paths, a file, its raw bytes, and the writes (a file saved or deleted, a rename, and a batch);
  - `registerHistoryRoutes`: a branch's commits, one commit, and a revert.

  The other twenty-five (pulls, issues, notifications, stars, actions, releases, search, uploads, the folder move and the dependency audit) follow in D12i.
- **Services.** The services are built once by the server and handed to the routes and to the code that still needs them:
  - **The commit writer** (`application/commit-writer.ts`). It is the one way content changes: a commit of tree entries on the head the change was made against, the branch moved without force, and an entry's mode kept from the path it replaces. Corona's recoveries and the uploads still in the server use the same writer.
  - **The repository list** (`application/repository-list.ts`). It holds the hosted alpha's list filter in one place for the repositories page, the activity feed and the safeguards.
  - **LFS storage** (`application/lfs.ts`): the download behind a pointer, and the HTTPS-only address check the server's upload still uses.
- **Domain.** The pure rules are in `domain/`:
  - the head checks and the refusal of an occupied destination;
  - the account's permission in a repository;
  - how a file's bytes are served: content a browser would run is a download, and an LFS pointer is recognised by its exact text.
- **Dead code.** `uploadViaContents` was a wrapper nothing called. It stays in the server until D12i moves the uploads, and is then removed. The server no longer imports what only these routes used: the repository creation and deletion checks, branch normalising, the declared-site reader, the CODEOWNERS contract, `Readable`, `encodePath` and `requireCommitSha`.
- **Behaviour unchanged.** The route code reads a provider's answer as the inline code did, failures included:
  - A list that is not one, or a text that is not one, throws the TypeError the engine throws for the same expression, named as the engine names it. A text can still be sliced.
  - A field the provider sends to `Buffer.from` or `Readable.fromWeb` is passed to the real function, so Node refuses it as it always did.
  - `server.js` is not strict mode, so its writes to a request body that is not an object did nothing; the module's writes keep that.

  An oracle evaluated those regions of the previous `server.js`, with the commit writer, head checks and MIME guess they used, on one express app. It ran the module's registrations on another, against a scripted provider that answers both sides alike.

  The 20,000 scenarios varied:
  - every route, with bodies that are valid, missing fields, malformed or not objects, and queries with lists, empty and unusual values;
  - repositories, lists and installations in every shape, including the alpha filter hiding some;
  - branches, refs, commits and trees (full, truncated, failing or malformed);
  - contents, CODEOWNERS (absent, a folder, bounded or too large) and raw bytes (text, LFS pointers whole or split, active content);
  - LFS negotiations (HTTPS, plain HTTP, embedded credentials, missing, refused) and storage that answers or fails;
  - archives, a branch that moves under a write, refs the provider refuses, and protected paths.

  The oracle compared each answer (status, the headers that matter, the bytes), and every call to the provider, LFS storage, the archive, the alpha filter, the protected-path check, the LFS qualification, the mutation gateway and the failure answer, in order. All 40,000 comparisons were identical. They included 942 successful writes (saves, deletions, renames, batches, reverts, branches and new repositories) and 573 raw downloads.

  Twenty-five mutants each fail on a comparison:
  - a forced branch update;
  - a refused ref not read as a moved branch;
  - a replaced path losing its mode;
  - destinations never checked;
  - a truncated tree not looked up;
  - an expected head compared by case;
  - an aggregate change without its head;
  - the alpha list filter skipped;
  - maintain read as write;
  - SVG rendered inline;
  - an LFS object without its length;
  - a large file shown;
  - a rename onto a taken path;
  - a batch without its operations;
  - a revert past a protected path;
  - a renamed file's old path not restored;
  - commit pages capped at 100;
  - a refused deletion said to have changed things;
  - an archive name keeping slashes;
  - a comparison keeping 19 commits;
  - plain-HTTP storage accepted;
  - storage redirects followed;
  - a missing CODEOWNERS answered as a failure;
  - a smaller CODEOWNERS bound;
  - folders listed after files.

  The first runs let four survive. One was an equivalent mutant: lower-casing an aggregate head no comparison can see. It was replaced by an aggregate change without its head. The other three showed gaps in the oracle: no active-content path, no record of the redirect setting, and no CODEOWNERS between the two bounds. It now has all three.
- **Tests:**
  - `test/workbench-repository-routes.test.js` checks the twenty chains against the baseline inventory. Over HTTP, on the module's commit writer, repository list and LFS transfer with a scripted GitHub, it checks:
    - CODEOWNERS found where GitHub looks first, and bounded;
    - the list held to the alpha filter, and an installation's own list;
    - a repository's permission, archive state and site;
    - a deletion refused before the provider for an account that cannot administer, and a refusal that changed nothing;
    - the archive's sanitised name;
    - a comparison of the latest twenty;
    - folders first;
    - LFS pointers and large files named for what they are;
    - active content downloaded, and an LFS object served from storage with its length and no redirect, refused over plain HTTP;
    - writes on the head the view had, never forced, keeping an executable's mode, a moved head and a refused ref answered as a moved branch;
    - a rename that will not overwrite or move a folder, and links the same blob;
    - a batch that must name its head;
    - a revert refused for a merge or a protected path before anything is written, and its inverse entries and message.
  - The source checks follow the code into the module:
    - `capability-probes` finds each probed route in `server.js` or the workbench's registrations;
    - `findings-inbox` reads the CODEOWNERS route;
    - `github-app-server-contract` reads the installation listing;
    - `mutation-coverage-server-contract` reads the batch's provider operations;
    - `provider-disconnect-server-contract` reads the LFS validator and download, and counts both LFS negotiations across the server and the module.
- **Ratchet:** the routes `server.js` registers itself fall from 85 to 65.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the twelve new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - every converted contract and the new route test;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.
  - Comparing `server.js`'s top-level statements before and after the cut left only the twenty routes, their helpers, the commit writer and head checks, the MIME guess and the imports that went with them.

### CI — a slow package mirror kept out of the tests' time

- **What happened.** CI's browser shard 4 on D12g (`591e612`) was stopped at its 20-minute limit while its tests were still passing.
  - Installing the browser's system packages took eleven minutes: the Ubuntu mirror served a few megabytes a minute. That left about eight minutes for 175 tests that take eight and a half.
  - The same shard passed on the same commit in the push run, and once more when re-run. The re-run's install took ten minutes, and the job finished a minute inside its limit.
- **The fix.** Every job that installs the browser bounds that step on its own, at 15 minutes:
  - CI's browser shards and the qualification's browser matrix also bound their tests at 18 minutes, with 40 for the job;
  - CI's integration job now has 30;
  - the qualification's `automated` job had no job limit and still has none.

  A slow mirror now fails the install step by name instead of taking the tests' time, and a hung spec still fails at 18 minutes. No test, shard or check changed.
- **Checks:** both workflows parse, and every contract that reads them passes (the workflow, package, alpha.17 harness and staging contracts among them).

### CI — the browsers' system packages kept between runs

- **What happened.** On `2472d78` the new 15-minute bound did what it was set to do: CI's `integration` job and the qualification's `automated` job each stopped at their browser install, by name.
  - The Ubuntu mirror served its signed indexes at about 10 MB/s and the packages at about 150 KB/s. Chromium and WebKit need 119 MB of them, and 15 minutes fetched about a third.
  - Nothing ran after the install in either job, so no test failed; neither job was re-run.
- **The fix.** The packages apt downloads are kept in the Actions cache (`ci/browser-packages.sh`). Every job that installs a browser now:
  - restores the last set it kept into apt's own archive before the install;
  - collects apt's archive after the install, even when the install fails or times out, minus the versions the index no longer offers;
  - saves that set under a name taken from the package file names: an unchanged set is never saved twice, and a run cut short leaves the next one less to fetch;
  - keeps one set for Chromium and one for Chromium with WebKit.

  apt checks every archived package against the signed index it has just fetched and downloads again whatever does not match. A cached package is only ever a skipped download, never a package trusted because the cache supplied it. The cache steps cannot fail a job: when one fails, the install simply downloads everything, as before. The bounds are unchanged.
- **Checks:**
  - the script was exercised against apt's real archive: an empty archive, a first set, an unchanged set (same name, no second save), a changed set (a new name) and bad usage;
  - the workflow contract now requires the restore, the install, the collection (`if: always()`) and the save in that order in every installing job, keyed for that job's browsers. A missing `always()` and a key for the wrong set each fail it;
  - both workflows parse, the local CI runner still reads every gate, and the full unit gate and every verify-job gate pass on Node 22.23.4.

### D12i — the rest of the workbench's routes

- **Routes.** The workbench's other twenty-five routes move into the module, in the order the route policy keeps them:
  - `registerCollaborationRoutes`: code search held to the repository; pull requests listed, read, opened, merged on the head the reviewer saw, and reviewed; issues listed, read, opened, commented on, closed or reopened; the account's notifications and code search across what it may see; a repository's star; workflow runs, their jobs and a re-run; releases listed and created (21 routes);
  - `registerUploadRoutes`: a blob for a batch commit, and the smart upload (2);
  - `registerFolderMoveRoute`: a folder moved in one commit (1);
  - `registerDependencyAuditRoute`: the dependency audit (1).
- **Services.** The server builds these once and hands them to the routes:
  - **The upload intake** (`application/upload-intake.ts`): the slot among this deployment's concurrent uploads, refused before anything is read when the declared size is over the route's limit or the temporary disk cannot hold it, and the bytes streamed to a private file, stopped the moment they pass the limit;
  - **The native push** (`application/native-push.ts`): the branch's head read from the remote's advertisement and held to the head the view had, the trees on the file's path read through the API, and one push at a time;
  - **LFS storage** (`application/lfs.ts`) now carries the upload too: the batch, the transfer and the verification, each asked of the mutation gateway, and the pointer committed with the path's attribute when `.gitattributes` does not already name it.
- **Contracts.** The merge's head check names the commit-SHA contract (`isCommitSha` from `packages/contracts/src/ids.ts`) instead of carrying a copy of its pattern. `server.js`'s recorded copies fall from 9 to 8.
- **Domain.** The Git objects a push builds (`domain/git-objects.ts`: pkt-lines, the advertisement, the blob, trees and commit, the pack and the push report), and the manifests the audit reads (`domain/manifests.ts`).
- **Dead code.** `uploadViaContents`, the wrapper nothing called, is gone, as D12h said it would be. The server no longer imports what only these routes used: `zlib`, the upload planner, the notification and global search readers, the pull-list item, the LFS attribute pattern and URL validator, the path and branch normalisers, and the `requireRepoPath`, `requireBranchName` and `R` shorthands. `pipeline` goes too: D12h moved the last routes that streamed with it and missed the import.
- **Behaviour unchanged.** The route code reads a provider's answer as the inline code did, failures included, with the helpers D12h introduced. `sliced` now takes an end as well, because an advisory's `aliases` was sliced to three whether it was a list or a text.

  An oracle evaluated those regions of the previous `server.js` (the slot and intake, the twenty-five routes, the Git object encoder, the push, the three uploads, the folder move and the audit with its parsers) on one express app. It ran the module's registrations on another, against a scripted provider, Git remote, LFS store and OSV that answer both sides alike, on a clock held still.

  The 20,000 scenarios varied:
  - every route, with bodies and queries valid, missing, malformed or not objects, and pull, issue and run numbers that are not numbers;
  - accounts on GitHub by OAuth or as an installation, on another provider, without a provider, and on a custom server; invitations with and without a valid repository scope;
  - pull requests, issues, notifications, runs, releases and search results in every shape, a merge the provider refuses, and protected paths in a pull request's files;
  - uploads of every size around each limit, sent whole or chunked, scanned clean or blocked, by each transport the plan can choose and each the ladder falls to;
  - advertisements (the branch present, missing, upper-case, refused, garbage), trees with symlinks, submodules and sub-folders, and push reports that accept, refuse or fail;
  - LFS batches that offer an upload and a verification, report the object stored, report an error, name plain HTTP or embedded credentials, refuse or answer garbage, and `.gitattributes` that does or does not already name the path;
  - folders moved into themselves, onto files, past protected paths, over 800 files and from a head that moved;
  - manifests of each kind (valid, approximate, malformed), OSV answering, failing, refusing or malformed, with more than eight advisories for a package, and Dependabot answering or refused.

  The oracle compared each answer and every call to the provider, the transport, the commit writer, the scan, the protected-path checks, the mutation gateway, the account checks, the console and the failure answer, in order. After each upload it checked that the temporary directory held nothing the upload had left behind. All 40,000 comparisons were identical. They included 354 uploads that landed (87 by the Git Data API, 45 by native push, 171 laddered from a push to the Git Data API, and 51 by LFS, 7 of them as a run-time fallback), 310 blobs, 43 folder moves and 1,429 audits.

  Three probes then held requests open, and each answered the same on both sides:
  - with one upload holding the only slot, a second is refused with a 429; a declaration over the limit, for an upload or a blob, is refused for its size first; and the slot is free again once the first finishes;
  - a second push while the first holds the remote ladders to the Git Data API;
  - an upload whose bytes stop arriving is cut off at the deployment's limit, and leaves no file behind.
  Fifty-three mutants each fail on a comparison or a probe:
  - **collaboration:** search results not held to the repository; the protected merge check skipped; a merge scanned past 1,000 files; a renamed file's old path unchecked; a merge without the reviewed head; a moved head answered as a plain conflict; pull requests listed as issues; a GitHub App's stars read; a review on any number; a re-run of any id; notifications cacheable; global search outside the invitation; a release named nothing;
  - **uploads:** a too-large blob not answered 413; an LFS upload past a protected path; an unsupported account laddered; a planned transport swap unreported; an upload scanned under the path asked for rather than the one written; an upload leaving its file; a blob held to the upload limit;
  - **intake:** a slot never released; uploads unlimited; an upload that never times out; the streamed limit a byte late; an upload file others can read; a declared size over the limit taken;
  - **native push and Git objects:** two pushes at once; a push past a moved head; a push following redirects; a push without its gateway check; a rejected push accepted; tree entries in the wrong order; a symlink overwritten; a pack of the wrong version; a refusal's reason lost;
  - **LFS upload:** `.gitattributes` rewritten when it already names the path; GitHub's verification without credentials; plain-HTTP storage; an upload unqualified; the transfer checked as a batch; a storage error passed over;
  - **folder move:** a folder moved into itself; more than 800 files moved; a move onto taken paths; a move past a protected path;
  - **audit and manifests:** a lockfile not ending the search; an audit complete without OSV; packages counted twice; Dependabot asked of every provider; eight advisories become nine; a version's leading `v` kept; nested packages misnamed; devDependencies skipped.

  The first run left ten alive. Nine were the oracle's gaps, and it now covers them: invitation scopes that parse, normalised paths, an attribute already present, a package listed twice, more than eight advisories, pushes that reach a symlink, a bounded wait on a stalled upload, and oversized declarations sent while the slot is held. The tenth, "a moved branch laddered", could not be told apart, because a moved head is a 409 and the status test already rethrows it. It was replaced by "an unsupported account laddered". All fifty-three were then run again on the final oracle.
- **Two differences found and fixed before this landed.** Neither reached a commit:
  - the pull request view read the head before the number, so a pull request the provider answered as `null` failed naming `head` rather than `number`;
  - the audit refused an advisory whose `aliases` was a text, where the inline code sliced it.
- **Tests.**
  - `test/workbench-collaboration-routes.test.js` drives the routes over HTTP on the module's own intake, push and LFS transfer:
    - search, notifications and global search held to the repositories the session may see;
    - a merge pinned to the reviewed head, and refused over a protected path, including a renamed file's old path, before GitHub is asked;
    - an installation never asked to star;
    - an upload refused over its limit, scanned before anything is written, written for this process alone, and leaving no file behind;
    - a native push whose pack is decoded and holds exactly the uploaded blob, the trees with their neighbours and modes kept, and the commit on the head it read; a moved head refused before anything is pushed; a symlink never overwritten;
    - LFS storage reached over HTTPS only, the account's credentials sent to GitHub's verification and not to storage's own host, and the pointer and its attribute committed once;
    - a folder move that will not nest, overflow, overwrite or pass a protected path;
    - an audit that ends at a lockfile, caps a package's advisories at eight, checks a package listed twice once, and says when OSV could not answer.
  - The source checks follow the code into the module:
    - `capability-probes` finds the probed routes in the collaboration and folder-move registrations;
    - `github-app-server-contract` reads the notifications chain from the route policy, and the installation refusals from the collaboration routes;
    - `hardening-contract` reads the folder move's protected-path check;
    - `lfs-probe-contract` holds the probe to the workbench's LFS upload;
    - `mutation-coverage-server-contract` and `mutation-gateway-server-contract` require the native push and the LFS upload to ask the gateway, with the server handing both the gateway's check;
    - `provider-disconnect-server-contract` reads both LFS negotiations, the validator, the download and the upload from the LFS transfer, and none from `server.js`;
    - `pull-list` and `upload-transport-choice` read the list and upload routes, and the ceilings the server hands the upload route.
  - `upload-transport-choice` matches the planner import as a pattern. As a quoted relative path, the candidate qualifier read it as a file the test loads, one outside the tree.
  - The comments in the alpha.17 harness and the qualification evidence name the workbench's LFS upload.
- **Ratchet:** the routes `server.js` registers itself fall from 65 to 40.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the eight new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - every converted contract and the new route test;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.
  - Comparing `server.js`'s top-level statements before and after the cut left only the twenty-five routes, their helpers, the upload slot and intake, the Git object encoder, the manifests and the imports that went with them.

### CI — apt under bounds of our own

- **What happened.** On `9a51f65` the qualification's browser shard 5 stopped at its 15-minute install bound. The cache from the previous entry could not help: it never reached the package downloads.
  - Its Azure mirror did not answer, and apt fell back to archive.ubuntu.com.
  - There `apt-get update` fetched three release files and then printed nothing for fourteen and a half minutes.
  - The other five shards installed in about twenty seconds and saved the Chromium set to the cache.
  - `playwright install --with-deps` runs `apt-get update` and `apt-get install` with no bound of its own, so a stalled mirror holds it for as long as the job allows.
- **The fix.** `ci/install-browser.sh` now installs the system packages itself, then has Playwright fetch only the browsers:
  - apt gives up on a connection after 20 seconds of silence, and retries it (`Acquire::http(s)::Timeout`, `Acquire::Retries`);
  - the index refresh has a wall clock of 150 seconds and three tries;
  - the package list is Playwright's own, read from its dry run (`install-deps --dry-run`, which simulates the install without touching the network);
  - the packages are downloaded first, with a wall clock of 240 seconds and three tries, so what a retry cuts short is a download and never dpkg; then they are installed;
  - the browsers are fetched with five minutes and two tries;
  - and Playwright's dry run must then report nothing missing, or the step fails by name.

  The cached packages from the previous entry still go back into apt's archive first, so with the cache warm the download step fetches nothing.
- **Checks:**
  - the dry run's output was parsed as Playwright prints it, with packages missing and with none;
  - the workflow contract now requires the network timeouts, the bounded index refresh, the bounded download before the install, the dry run at the end, and no `--with-deps`. Removing any of the first four fails it;
  - the full unit gate and every verify-job gate pass on Node 22.23.4.

### D12j — the platform's own routes

- **Routes.** The seventeen routes that belong to no module move to `apps/api/src/http/routes`, beside D11's pipeline. Each group is registered where the route policy records it among the pipeline's steps:
  - `registerProbeRoutes`: health and readiness (`probes.ts`);
  - `registerPublicFileRoutes`: security.txt, robots.txt and the two home-screen icon aliases (`public-files.ts`);
  - `registerVendorRoute`: the browser's libraries and fonts, from disk or the CDN, with the response bound and the cache (`vendor.ts`);
  - `registerWebhookIntakeRoute`: GitHub's deliveries, read raw before the JSON parser (`webhook-intake.ts`);
  - `registerWebShellRoutes`: the page and its service worker (`public-files.ts`);
  - `registerConfigRoutes`: the deployment's configuration and capabilities, and the account's (`config.ts`);
  - `registerProviderRateRoute`: the account's GitHub API budget (`provider-rate.ts`);
  - `registerVersionRoute`: the build's identity, by digest (`release.ts`);
  - `registerShellFallback`: the page for a route the browser owns, and a 404 for an API path or a file that is not there, last of all (`public-files.ts`).

  The comments that explained each route moved with it. `server.js` now registers only identity-access's twenty-seven routes itself.
- **Dead code.** The server no longer has the vendor cache, its allowlist, the bounded reader, the public-origin helper, `fs` or `hostedConfigProjection`, which only these routes used.
- **One wiring fault, caught before this landed.** The draft handed the probes `Boolean(DB_URL)` when they were registered, but the server declares `DB_URL` further down, so the server would not start. The old readiness route read it per request. The probes now read it when asked. The oracle compares the route code and could not see this; the tests that start the server could, and did.
- **Behaviour unchanged.** An oracle evaluated those regions of the previous `server.js` on one express app, and the platform's registrations on another. It ran five pairs, for the settings fixed at startup: maintenance on and off, a database or none, the hosted or local profile, with and without qualification capabilities and a compiled build.

  The 20,000 scenarios varied:
  - the database ready, not ready, failing its check or its round trip, and its readiness state;
  - the security contact and the public origin (HTTPS, plain HTTP, trailing slashes, none), and the Host the request arrived with;
  - vendor paths bundled, fetched or refused (outside the allowlist, a dot-dot path, an encoded one, a different case);
  - CDN answers small, just under 2 MB, over 2 MB as streamed or as declared, missing, empty or failing, mostly near 2 MB, so the 24 MB cache filled and evicted;
  - webhook bodies of every content type, empty, malformed and over 2 MB;
  - capability queries naming other providers and authorities, accounts by OAuth or as an installation, and API budgets in every shape;
  - HEAD as well as GET, and unknown routes, API paths and dotfiles for the fallback.

  The oracle compared each answer (status, the headers that matter, the bytes), every call to the database, the CDN, the provider, the webhook receiver and the failure answer, in order, and the readiness left behind. All 60,000 comparisons were identical. They included 3,343 vendor files served, 523 webhook deliveries accepted, 664 ready answers and 1,406 not-ready ones.

  Thirty-four mutants each fail on a comparison:
  - **probes:** health saying alive in maintenance; readiness during maintenance; no Retry-After; a hosted deployment ready without its database; ready without asking the database; a failed check not invalidating readiness; a database not ready answered ready;
  - **public files:** an HTTP origin taken as canonical; a trailing slash kept; security.txt expiring in a year; robots letting the API be indexed; one icon alias dropped; the service worker cached; the service worker scoped to its folder; an unknown API path given the page; a missing dotfile given the page;
  - **vendor:** a path outside the allowlist fetched; the declared size trusted; the streamed size unbounded; the cache never consulted; a cached asset served without its type; the cache never evicting; the newest entry evicted; a bundled file fetched anyway; a failed upstream passed through; the fallback without its User-Agent;
  - **webhook:** a larger body accepted;
  - **configuration:** the qualification capabilities hidden; the Git Data boundary unpublished; another provider projected; public capabilities uncached; account capabilities shared between cookies;
  - **budget and build:** the reset time dropped; a compiled build without its digest.

  The first run left four alive. Two could not be told apart from the original, because the allowlist holds only lower-case paths with no `..`. One dropped the dot-dot check and the other lower-cased the CDN path. They were replaced, by "a cached asset served without its type" and "the fallback without its User-Agent". The two eviction mutants survived because the scripted CDN never filled the cache. It now mostly answers near 2 MB, and both are caught. All thirty-four were then run again on the final oracle.
- **Tests.**
  - `test/platform-routes.test.js` drives the registrations over HTTP. It covers:
    - each route's chain and its place: the webhook before the JSON parser, the page before the API's maintenance gate, the fallback last;
    - health naming no release, and readiness draining for maintenance and for a hosted deployment without its database;
    - security.txt canonical only on a configured HTTPS origin, and expiring six months out;
    - vendor files only from the allowlist, from disk when bundled, bounded and cached from the CDN, and the oldest evicted first;
    - the webhook's exact bytes, and its 2 MB limit;
    - the configuration's fields, and the private, per-cookie account capabilities;
    - the build named by digest;
    - a 404, not the page, for an API path or a missing file.
  - The source checks follow the code:
    - `hardening-contract` reads the vendor route's bound and allowlist, and ends the account-switch block at the next statement;
    - `package-contract` reads the DOMPurify path from the vendor route;
    - `scripts/verify.js` reads the webhook intake, the vendor allowlist and its CDN fallback, the self-hosted faces, the absence of a font proxy, and readiness from the routes, and the wiring from the server.
- **Ratchet:** the routes `server.js` registers itself fall from 40 to 27.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the eight new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - every converted contract and the new route test;
  - the full unit gate and every verify-job gate on Node 22.23.4;
  - the compiled-server tests.
  - Comparing `server.js`'s top-level statements before and after the cut left only the seventeen routes, the vendor helpers and the imports that went with them.

### D12k — identity and access, step one: the alpha's front door

- **Routes.** identity-access's twenty-seven routes move in three steps. This first one takes the alpha access boundary and the three routes behind it that a visitor meets first:
  - `createAlphaSessions` (`identity-access/http/alpha-sessions.ts`) holds the access cookie, the session read from the store, the refusal answers, the deletion recovery and the boundary itself;
  - `registerAlphaAccessRoutes` (`identity-access/http/alpha-access-routes.ts`) registers the boundary on `/api`, then the status, the redemption of an invitation and the end of a session.

  The server builds the sessions once, from the alpha's configuration, its store, the sealed-cookie codec and the cookie reader, and registers them where the boundary always was. The alpha deletion route, which moves in step two, clears the cookie through `alphaSessions.setCookie`. The comments that explained the boundary moved with it.
- **One contract named, three copies gone.** The tester id is the ids contract's `MUTATION_ID` format (an RFC 9562 UUID, versions 1 to 5). The server held three copies of its pattern, in the session reader, the deletion recovery and the redemption. The module names the contract once, and `server.js`'s copies fall from 8 to 5 in the adoption record.
- **Dead code.** The server no longer has the cookie's name and lifetime, the public-route list, the refusal tables, the fourteen helpers or the boundary, nor its import of `AlphaAccessOperationalError`.
- **Behaviour unchanged.** An oracle evaluated that region of the previous `server.js` on one express app, and the module's registration on another. It ran five pairs, for the settings fixed at startup: the alpha on with its store (twice), off without one, and the two combinations the server never builds, on without a store and off with one, so that each branch on either is reached.

  The 20,000 scenarios varied:
  - the cookie: absent, unsealable, sealed around null, a number, text or an array, a session id empty or not text, a tester id upper-cased, another tester's, empty or null, a version-6 or malformed one, and a tester alone for deletion;
  - the cookie header around it, other cookies first, a name sharing its prefix, padding;
  - what the store answered: a valid session, upper-cased or another tester's, fields missing or mistyped, null, each refusal by code, an unknown code, `constructor` as a code, the store unreachable and a plain error;
  - each redemption outcome: a valid session, the session id missing, empty or a number, the tester invalid, missing or with a bad scope list, null or text, a rejected or locked invitation, a refusal from the wrong family, the store unreachable;
  - the body the boundary saw (parsed, absent, null, text, zero, an array, the deletion confirmation in either case, a redemption with and without its fields);
  - production or not, and twenty-five requests: the public ones with and without a query, the alpha's own, HEAD, wrong methods, a different case, a trailing slash, the deletion route with a query, other API routes, `/api` itself, `/apix` and a page.

  The oracle compared each answer (status, type, caching, Retry-After, every Set-Cookie byte), every call to the cookie reader, the codec and the store, in order, and what the boundary left on the request: the session, whether it was frozen and the session id. All 40,000 comparisons were identical. They included 146 cookies issued and 7,877 cleared, and answers of 200, 401, 403, 404, 429, 500 and 503.

  Thirty-six mutants each fail on a comparison:
  - **the cookie:** readable by scripts; never Secure; sent cross-site; kept for thirty days;
  - **the answers:** an unreachable store taken for a refusal; no Retry-After; a revoked session answered 401; a locked redemption answered 403; any redemption error answered as a rejected invitation; a store failing a redemption answered 500;
  - **the session:** non-text terms accepted; the query string kept in the route's name; the configuration made private; a stored tester id not lower-cased; a cookie naming another tester accepted; an empty session id accepted;
  - **deletion recovery:** without the confirmation; on any route; for a looser tester id; left unfrozen;
  - **the boundary:** the cookie kept on a refusal; cleared when the store is down; the session id not left on the request; enforced with the alpha off;
  - **the status:** always authenticated; clearing the cookie when the store is down; any failure answered as signed out; cacheable;
  - **the redemption:** with the alpha off; the accepted terms not passed on; the caller's address not passed on; an empty session id or an invalid tester id accepted; the cookie without its tester; the answer without its expiry;
  - **the end:** keeping the cookie.

  The new HTTP test, run as the judge in the oracle's place, catches all thirty-six too. Its first draft let one through, a redemption with the alpha off, because its "off" server had no store; it now also runs off with a store to hand.
- **Tests.**
  - `test/alpha-access-routes.test.js` drives the registration over HTTP. It covers:
    - the three routes and the boundary registered by identity and access, and every route in the baseline inventory still on the side of the boundary it recorded;
    - the alpha off: nothing gated, nothing to redeem, even with a store to hand;
    - the public routes open, the rest refused with the cookie cleared, and the boundary on the API only;
    - the issued cookie's attributes and sealed contents, Secure in production, and each redemption failure answered without a cookie;
    - a valid session reaching the route behind with its tester and session id; each refusal, a tester mismatch and a malformed store answer;
    - the store down answered 503 with Retry-After and the cookie kept, by the boundary and the status alike;
    - deletion recovery on the sealed tester alone, confirmed, on that one route, frozen;
    - the end clearing the cookie.
  - The source checks follow the code: `alpha-privacy-server-contract` reads the deletion recovery, the boundary and the redemption from the module; `provider-disconnect-server-contract` reads the session reader from it.
- **Ratchet:** the routes `server.js` registers itself fall from 27 to 24.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the three new files);
  - the architecture oracles, the route policy (208 entries, every guard in order, the boundary where it was), route surface, module boundaries and contracts;
  - the converted contracts and the new route test;
  - the full unit gate and every verify-job gate on Node 22.23.4.
  - Comparing `server.js`'s top-level statements before and after the cut left only the boundary, its helpers and constants, the three routes and the import that went with them.

### D12k — identity and access, step two: the accounts and the tester's own data

- **Routes.** Eleven more routes move into identity and access, each group registered where the route policy records it:
  - `registerAccountRoutes` (`identity-access/http/account-routes.ts`): sign-in with a token, the accounts listed, switched by index or by login, and one removed;
  - `registerAlphaPrivacyRoutes` (`alpha-lifecycle-routes.ts`): the privacy notice and the feedback a tester sends;
  - `registerSignOutRoute` (`account-routes.ts`): signing out;
  - `registerAlphaDisconnectRoutes` (`alpha-lifecycle-routes.ts`): every provider disconnected at once, and deletion, with its confirmation and authentication guards and its blocked answer;
  - `registerMeRoute` (`account-routes.ts`): who the selected account is, with the build a tester quotes.

  `disconnect-answers.ts` holds what a disconnect answers wherever one is asked for: the 202 for a cleanup still in progress, and the revocation guidance, once per distinct step. The GitHub App disconnect, which moves in step three, takes the pending answer from there already.

  The session store, the account writer, the provider disconnect and the cookie helpers stay in the server for D13, and are handed to the routes, as is the build's version: the module does not import the release module itself, because the root JavaScript type check reaches identity and access through the GitHub provider, and that project cannot read the release module's JSON import. The routes read the request's session again after each disconnect, as the inline code did, because the disconnect replaces it.
- **Dead code.** The server no longer has the feedback fields, their check and failure answer, the two deletion guards, the blocked answer, the guidance helper or the pending answer, nor its imports of `alphaRetentionPolicy` and `sanitizeFeedback`, which the routes now take from the module's own domain.
- **Behaviour unchanged.** An oracle evaluated those regions of the previous `server.js` on one express app, and the module's registrations on another. It ran four pairs: the alpha on with its privacy store (twice), off without one, and on without one, which the server never builds, so that each branch on the store is reached.

  Each of the 20,000 scenarios scripted:
  - the session the account guard attached, or its refusal: one account or several, token, OAuth and App connections, a retired GitLab account and a GitHub Enterprise one, a selection out of range or written as text, none left;
  - what the store reads back after a removal, and what each disconnect leaves on the request, as the server's helper does: a new session without those accounts, reselected;
  - the tester the boundary admitted, or a deletion recovery, frozen or with its flag as text;
  - the body: tokens padded, empty or not text, other providers and custom servers, indexes negative, too large, text, `true` or `null`, feedback with unnamed fields, as an array, without a plain prototype, long or mistyped;
  - every answer the server's functions and stores give: identities, refusals by status and code, cleanups complete, pending or with guidance to dedupe, failed writes, feedback recorded or refused by code, deletion requests recorded or blocked with bad, oversized and too many blocks, purges verified or not.

  The oracle compared each answer (status, type, caching, every Set-Cookie) and every call, with its arguments, in order. All 40,000 comparisons were identical. They included 5,465 answers of 200 (42 completed deletions among them), 152 feedback records, 708 pending cleanups and 867 conflicts.

  Fifty-three mutants each fail on a comparison:
  - **disconnect answers:** the guidance not deduplicated or marked automatic; a pending cleanup answered 200, or without its results;
  - **sign-in:** another provider or a custom server accepted; the token not trimmed; an alpha refusal answered as a bad token; a token account added as OAuth;
  - **the list and the switches:** an App connection listed by its installation in the alpha; a retired account listed as current; the host listed with its path; the selection not clamped; a retired account chosen by index or by login; a switch keeping the step-up; a negative index accepted;
  - **removal:** not waiting for its cleanup; the retired accounts left behind by the last one; an alpha session destroyed; the guidance dropped; the alpha session not read again; a retired account selected after it;
  - **signing out:** an alpha session destroyed; the retired accounts not disconnected;
  - **the account:** a retired selection answered; an App connection shown by its installation in the alpha; cacheable; without its release;
  - **privacy and feedback:** the notice with the alpha off; source content said to feed analytics; unnamed fields, a body without a plain prototype or an absent one accepted or answered wrongly; a leaving tester's feedback or invalid feedback answered 500; feedback recorded under another release or unsanitized; always reported recorded;
  - **disconnecting every provider:** with the alpha off; keeping the cookie;
  - **deletion:** without the exact confirmation; recovery on a truthy flag; without the account guard; with providers still connected; a blocked request ignored; an unverified purge accepted; the blocks unbounded, their counts unclamped, malformed codes kept; either cookie kept; the recovery path and the full one swapped.

  The first run left one alive: "feedback as an array accepted". It cannot be told apart from the original, because an array's prototype is not `Object.prototype` and the next check refuses it. It was replaced by "an absent body answered as invalid fields", which is caught. The new HTTP test, run as the judge in the oracle's place, also catches all fifty-three. Its first draft let five through; it now covers bodies only code before the route can leave (null, absent, without a prototype), a correlation id the sanitizer changes, a store that does not say it recorded, and an alpha selection read back from the store.
- **Tests.**
  - `test/identity-account-routes.test.js` drives the registrations over HTTP. It covers:
    - each route's chain, as the baseline inventory recorded it, registered by identity and access;
    - sign-in: GitHub only, no custom server, the token trimmed, a bad token told apart from an alpha refusal;
    - the list, with retired accounts, hosts and App connections, locally and in the alpha;
    - the switches, refusing a retired account and clearing the step-up;
    - removal: waiting for the cleanup, a GitHub account selected after it, the last one taking the retired ones with it, the guidance once per step, and the alpha reading its session back from the store;
    - signing out, every account included; the account, a retired selection refused, an App connection described from the session;
    - the privacy notice and feedback, refused rather than stripped, recorded as sanitized, each failure by code;
    - disconnecting every provider; deletion's confirmation, its waits and blocks, both cookies cleared, and a recovery going straight to the purge.
  - The source checks follow the code: `alpha-privacy-server-contract` reads the notice, feedback, the disconnect and deletion from the module, and checks the server hands them the privacy store and the central disconnect; `provider-disconnect-server-contract` finds the central disconnect in the module's routes as well as the server's, and counts its uses across both; `hardening-contract` reads the account routes' failure handling from the module.
- **Ratchet:** the routes `server.js` registers itself fall from 24 to 13.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the four new files);
  - the architecture oracles, the route policy (208 entries, every guard in order), route surface, module boundaries and contracts;
  - the converted contracts and the new route test;
  - the full unit gate and every verify-job gate on Node 22.23.4.
  - Comparing `server.js`'s top-level statements before and after the cut left only the eleven routes, the eight helpers and the imports that went with them.

### D12k — identity and access, step three: the GitHub App, the session's own security and OAuth

- **Routes.** The last thirteen routes `server.js` registered move into identity and access, each group where the route policy records it:
  - `registerGithubAppRoutes` (`identity-access/http/github-app-routes.ts`): connecting an App, GitHub's two returns (the user authorization, then the installation), the status, a refresh and a disconnect;
  - `registerSecurityRoutes` (`security-routes.ts`): the upload scanner's state, the CSRF token and a step-up grant;
  - `registerOAuthRoutes` (`oauth-routes.ts`): sign-in with GitHub's OAuth app, out and back;
  - `registerSessionContainmentRoutes` (`security-routes.ts`): the sessions an identity holds elsewhere, and ending them.

  With the App's routes went the flow's helpers: the guard that needs the App configured, the pending states and their single spend, the callback's session binding, the redirect home, and the constant-time text comparison only they used. `createGithubAppConnectionView` is the one view of an App connection; the account list, the account and the App routes all use it.
- **What is handed in, and why.** The GitHub provider's App client (its signed states, its error and the broker) is handed in, not imported. The provider already depends on identity and access, and a dependency back would make a cycle the module rules refuse. The upload scanner's state is handed in for a different reason. The scanner reads the file system, and domain code in two other modules (the GitHub provider's account operations and Quasar's exposure session) reaches identity and access's index, which carries its HTTP routes; the module rules refuse I/O in domain code, and caught the draft's import. The secrets, the session store, the account writer, the provider disconnect, the audit and the installation record stay in the server for D13.
- **One contract named, two copies gone.** A connection key is an identity key, the ids contract's 64-hex format. The disconnect's check and the setup's check of the new account name `IDENTITY_KEY`, and `server.js`'s copies fall from 5 to 3.
- **Dead code.** The server no longer has the App flow's constants, its replay map and the eight helpers, `secureTextEqual`, nor its imports of the CSRF and step-up signers, the scope hash and the in-process single-use guard.
- **Behaviour unchanged.** An oracle evaluated those regions of the previous `server.js` on one express app, and the module's registrations on another. It ran six pairs, for the settings fixed at startup: the App configured with a broker, without one, and switched off with one still built; the alpha on or off; a database, which shares a spent state across instances, or none; and an OAuth client or none.

  Randomness came from a counter both sides restarted for each scenario, and the clock was held, so the states, grants, tokens and nonces each side signed were the same bytes. The real App state signer, the security foundation's CSRF tokens and step-up grants, the in-process single-use guard and the text cleaner ran on both sides.

  Each of the 20,000 scenarios scripted:
  - the session the guards attached, or each guard's refusal: token, OAuth, App and retired accounts, selections out of range or as text, a session binding valid, malformed or missing;
  - the App flow's pending state and the signed state GitHub returns: valid, for another purpose, tampered, expired, for another nonce or identity, a pending state for another identity or expired, missing, garbage or none;
  - the broker's answers: user codes exchanged with lifetimes long, short, zero or none, or refused; authorized users matching or not by id and login case; installations the user can see or not, owned by the same account in another case, suspended, gone or malformed;
  - what the session store reads back (the session, another, a retired selection, none), what the account writer leaves (a valid identity, an invalid one, another installation), each disconnect's cleanup and the session it leaves;
  - step-up bodies (each action, scopes valid and not, the login typed padded or wrong, a fresh credential present, missing or oversized) and the provider's answers to it, including a 401; an alpha operation already on the request;
  - OAuth: the state cookie present, absent or different, a code or none, and token exchanges answering a token, a refusal, an HTML page, `null`, a number, or failing;
  - the session inventory available, single, unavailable or failing.

  The oracle compared each answer (status, Location, type, caching, every Set-Cookie, the bytes, with the stack in Express's own error page reduced to its message) and every call, with its arguments, in order: the audits, the installation records, the spends, the session writes and the broker's calls. All 40,000 comparisons were identical. They included 83 installations connected, 91 user authorizations sent on to the installation, 96 refreshes and 76 disconnects completed, 181 step-up grants, 652 CSRF tokens, 100 OAuth sign-ins and 261 revocations; and 544 replays and 75 unverifiable spends refused, 149 users and 67 installation owners that did not match.

  Seventy mutants each fail on a comparison:
  - **the App's states:** the routes open with the App switched off; a pending state kept after its check; one for another nonce or identity, or expired, accepted; an unverifiable spend answered as a replay; a refused spend accepted; every spend kept in this process; the spent key without the identity;
  - **the callbacks:** a retired selection let through; no session binding made first; the error redirect without its code; another user, or a login in another case, refused or accepted wrongly; the installation state outliving the user token; the user token not kept for it;
  - **connecting and setup:** from an App connection; with an incomplete identity; the user authorization signed for another purpose; its pending state outliving the state; a refusal audited as something else; an invalid installation id looked up; an installation the user cannot see, or owners compared by case; the App account added with a token or without its authorizer; a connection without a valid identity accepted; the installation recorded under the wrong identity, or not recorded;
  - **status, refresh and disconnect:** every account listed; webhooks claimed; an alpha connection addressed by its installation; the local credential not invalidated; the step-up kept; a suspended installation not marked; every refreshed connection shown as active; a malformed key or a fractional id accepted; not waiting for the cleanup; the last alpha connection leaving the cookie; an emptied local session kept;
  - **security:** the scanner's state cacheable; a CSRF token said to last longer; the confirmation untrimmed; a token step-up without a fresh credential, or with an oversized one; a refused credential answered as a fault; a credential, an installation or an OAuth session for another identity accepted; the alpha's operation ignored; the grant outliving its window, not bound to its scope, or not written to the session;
  - **sessions:** the current one listed as another; revoking without confirmation, or the current session too; the revoked sessions' streams left open;
  - **OAuth:** offered unconfigured; its state cookie never Secure or readable by scripts; deletion asked for by default; a callback for another state or without a code accepted; the exchange following redirects; the state cookie kept after a failure; the provider's refusal hidden; an unreadable answer reported as unexpected; the account added as a token; no entered marker.

  The first run left two alive, because the 6,000 scenarios a mutant runs rarely addressed a connection in the session: "a suspended installation not marked" and "an emptied local session kept". Requests that address one are now common, and both are caught. The new HTTP test, run as the judge in the oracle's place, also catches all seventy. Its first draft let six through. It now covers the App switched off with a broker built, the same nonce for another identity, a session that needs its binding made, webhooks not configured, a refreshed connection that is not the selected one, and the CSRF token's exact lifetime.
- **Tests.**
  - `test/identity-security-routes.test.js` drives the registrations over HTTP with the real states and grants. It covers:
    - each route's chain, as the baseline inventory recorded it, registered by identity and access, and no route registered by `server.js`;
    - the App needing its configuration and its broker;
    - connecting: the state's purpose and bindings and the pending state written with it;
    - both returns: each state spent once, before anything else, and refused for another nonce, identity, purpose, an expired pending state or a tampered state; the same nonce accepted for another identity; the session bound first; another user refused;
    - setup: the installation accepted only for an owner the user can see, the account added without a token, recorded locally under the user who connected it and in the alpha under its own identity; the database's spend shared, refused or unverifiable;
    - status, refresh and disconnect, locally by installation and in the alpha by hashed key, with the shared broker left alone there;
    - the scanner, the CSRF token, and step-up: a credential entered now, an App checked against its installation, an OAuth session checked against the provider, the grant bound to its scope, and the alpha's operation used;
    - the session inventory and revoking only the others, their streams closed;
    - OAuth: the scopes, the state cookie, each failure's reason with the cookie cleared, and the exchange refusing redirects.
  - The source checks follow the code:
    - `github-app-server-contract` reads the App flow from the module and checks the state is spent before GitHub is asked;
    - `provider-disconnect-server-contract` reads the connection view, the hashed-key addressing, the broker invalidation and the OAuth exchange from the module, and counts three routes handed the central disconnect;
    - `security-foundation-contract` finds the CSRF and step-up routes through the route policy;
    - `security-foundation-server` checks every spend of an App state is awaited where the flow now lives; the gates caught that it still read the server for it;
    - `hardening-contract`, `route-surface` and `scripts/verify.js` read the security routes from the module; `overlay-motion` reads the OAuth callback there.
  - `continuity-generation` builds its minimal archive with the platform files the index's HTTP layer reads, and the shared contracts as one package.
- **Ratchet:** the routes `server.js` registers itself fall from 13 to 0. D12 is complete: every route is a module's or the platform's, registered where the baseline recorded it, with every guard in order.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the four new files);
  - the architecture oracles, the route policy (208 entries, every guard in order), route surface, module boundaries and contracts;
  - the converted contracts and the new route test;
  - the full unit gate and every verify-job gate on Node 22.23.4.
  - Comparing `server.js`'s top-level statements before and after the cut left only the thirteen routes, the App flow's helpers and constants, `secureTextEqual` and the imports that went with them.

### D13a — the server's startup settings

- **What moved.** D13 dissolves what is left of `server.js` into the platform and the modules, leaf first, with `apps/api/src/main.ts` composing them at the end. The first leaf is the settings the environment fixes at startup. They move to `apps/api/src/platform/config/server-settings.ts` as two readings, because the server reads them in two places:
  - `loadServerSecrets`: the port, the session secret and its production checks, the deployment profile, the migration mode, and the twelve keys derived from the secret, each for its own purpose;
  - `loadServerSettings`, after Corona has read its evidence keyrings and snapshot signing keys: the GitHub App configuration, the governance failure mode, the hosted alpha's limits or the local ones, the database URL, the alpha's access configuration, the retention periods, the governance audit key, the live-stream limits, the OAuth client, and the snapshot limits.

  The comments on why each key has its own purpose moved with the keys. The server takes the values under their old names, so nothing else in it changes yet.
- **Why two readings, in that order.** A deployment with a setting wrong is refused at startup with the first wrong thing named. Corona's two loaders can refuse too, and the server has always read them between the secrets and the rest. One reading would name a platform setting first where the server used to name Corona's, whenever both were wrong. Reading in two parts keeps every check in its place, with the same message.
- **The trusted proxies stay where they were.** The route policy records the application's settings word for word, and `app.set('trust proxy', loadTrustedProxies(process.env.NV_TRUSTED_PROXIES))` is the first of them. The draft moved it into the secrets, and the architecture oracle refused the change. It stays in the composition, set before anything else, as before.
- **Dead code.** The server no longer has the 45 constants, the six startup checks, or its imports of the five configuration loaders and the key derivation.
- **Behaviour unchanged.** An oracle evaluated those statements of the previous `server.js` against the two readings with Corona's between them, as the server now composes them, over 30,000 environments. Each started from a valid development or production one, local or hosted, with or without a database, an invitation-only alpha and a GitHub App. Then nothing, one, two or three of 25 variables were broken or pushed to an edge: the secret absent, the default, short or counted in multi-byte characters; profiles and modes in other cases or unknown; proxy lists valid, universal or malformed; database URLs without TLS, with the opt-out spelt otherwise, of another scheme or unreadable; invitation, audit, governance, OAuth, App, evidence and snapshot variables each malformed; and every limit as text, a fraction, an exponent, zero, negative or out of range.

  The oracle compared every value (keys by their bytes, configurations and keyrings as data) and the trust-proxy setting or, when startup refused, the error thrown first. Both sides read the one environment object, as the server does, so a loader's default argument sees what the server sees. All 30,000 were identical: 8,916 started (4,798 in development and 4,118 in production), and 21,084 were refused across 56 different messages, each reached alone and beside another.

  Thirty-four mutants each fail on a comparison:
  - **the secrets:** another default port; the profile untrimmed or an unknown one accepted; the migration mode read by case; a hosted production applying migrations; the development secret in production; the secret measured in characters; the CSRF key under the step-up purpose; a rate-limit key derived as text; the readability grant under the verification purpose;
  - **the providers and governance:** the App configuration read as development; the governance failure mode from another variable;
  - **the limits:** hosted limits read locally; the published limits read from the environment; a hosted Git Data limit ignored; the Git Data ceiling raised; the native push floor raised; the upload floor lowered; more uploads at once; another upload timeout by default; stale uploads kept for less; a limit read as any number rather than a whole one; events kept for a day; sessions kept for another default; more streams per repository or in all; a smaller snapshot manifest; fewer snapshots kept;
  - **the database and the alpha:** any value disabling database TLS; the database URL read as development; invitations without a database;
  - **the audit and OAuth:** a short audit secret accepted; the audit key ignoring its own secret; the OAuth client untrimmed.

  The new test, run as the judge in the oracle's place, catches all thirty-four too. Its first draft let two through; it now covers a production App configuration with a plain-HTTP public URL, and the hosted defaults where they differ from the local ones.
- **Tests.**
  - `test/server-settings.test.js` covers each refusal and its message, the first of two named, the secret's length in bytes, every key from its own purpose and no two alike, the local defaults, floors and ceilings, a limit read as a whole number, the hosted alpha's published limits winning and refusing what they cannot hold, the database's TLS rule and its literal opt-out, an invitation needing a database, the audit key's own secret and its production length, the OAuth client trimmed and the App configuration read for production.
  - The source checks follow the code: `exposure-worker` derives the three probe grants through the settings and checks the server takes each under its own name; `github-app-server-contract` and `scripts/verify.js` read the App configuration and the database URL from the settings; `governance-enforcement-server-contract` reads the failure mode's validation there and checks the server hands the runtime the validated value. The full gate found that last one still reading `server.js`, and the release's secret scan read the documented development secret, written out in the new test, as a credential; the test now spells it in parts.
- **Ratchet:** `test/route-surface.test.js` now also holds `server.js`'s lines to a ceiling that each D13 step lowers: 3,332 to 3,248.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles (the route policy, every guard and setting in order, and the negative matrix), route surface, module boundaries and contracts;
  - the converted contracts and the new test;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### Test servers on ports no listener holds

- **What failed.** The full gate run for D13a failed `test/security-foundation-server.test.js` against the compiled server in a tenth of a second, and it passed when run again. The rerun of the unit gate failed `test/server-smoke.test.js` the same way. Neither failure was in the code under test.
- **Root cause.** Nineteen tests start the server on a random port from a range of their own, and the ranges overlap: the security foundation's 28,500–29,499 meets the local session lifecycle's, the trusted proxies' and the disabled App's. Each test then waits for any answer to `/healthz`. When the port drawn was still held, by a server another test had not finished stopping, that other server answered, and the assertions ran against a server the test had not configured. A tenth of a second is too short for a fresh server to start, and long enough to ask one that is already running.
- **Why not a port from the operating system.** The first draft asked the operating system for one. `test/test-matrix.test.js` refused it, rightly: the operating system hands out ports from the ephemeral range, where a port can be the local end of an outbound connection, the tests' own PostgreSQL clients among them, and a server then exits on `EADDRINUSE`. That is why the ranges were kept below 32,768 in the first place.
- **The fix.** `test/helpers/free-port.js` draws a port from 16,384 to 32,767 and binds it, on every interface as the server binds it, before handing it out; a port that is held is passed over for another. All nineteen tests take theirs from it: the eighteen in `test/` and `test/integration/database-resilience.js`. The two tests that start a server with a fixed port are refusals that exit before they listen, and keep it.
- **The guard.** `test/test-matrix.test.js` no longer scans for ranges. It checks the helper's range stays below the ephemeral one, that a port a listener holds is refused and the same port handed out once it is free, that no test draws its own port, and that every server test takes one from the helper.
- **Checks:** the nineteen tests natively and against the compiled server, the test matrix, lint, and the full unit gate and every verify-job gate.

### D13b — the database's lifecycle

- **What moved.** The server's one pool, whether the store behind it is ready, and the upkeep a ready store is given move to `apps/api/src/platform/persistence/database-lifecycle.ts` as `createDatabaseLifecycle`. It takes what reaches the database as dependencies, the pool's constructor and the migration runner's three operations, so the composition names them and a test can stand in for them. The alpha's daily privacy retention moves to identity and access, `application/alpha-privacy-retention.ts`, as `createAlphaPrivacyRetention`, and the lifecycle starts it through an `onReady` hook: the platform does not import a module.
- **What the lifecycle keeps.** One shared initialization while it is pending, so a burst of requests on a cold start migrates once. Fifteen seconds of backoff after a failure. A generation that keeps an initialization finishing after an invalidation from undoing it. What the readiness probe publishes: waking, connected, unavailable or a mismatch. Verify mode, which checks the store and never migrates it. The retention deletes started once, every twelve hours, with a timer that does not hold the process open. A connection lost while idle, logged by its SQLSTATE alone.
- **The server.** It composes the lifecycle after its settings, keeps `pool`, `dbReady` and `invalidateDatabaseReady` as the names its remaining code calls, hands the probes and the hosted configuration the lifecycle's readiness, and closes the pool through it on shutdown. It no longer has the pool, the seven pieces of readiness state, the initialization, the upkeep, the retention or its import of the readiness builder.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the two factories, composed as the server composes them, over 6,000 scripted runs. Every operation that would reach the database was a deferred the script settled in an order of its choosing, with success or one of ten failures: connections, verification, migration, each retention delete, the privacy run and closing the pool. Between them the script asked for readiness again, lost the database while idle, invalidated it with each reason and none, moved the clock across the backoff and onto its edge, and fired the timers. The record of each side (every call and argument, log line, timer, readiness, promise identity and settlement) was identical in all 6,000. Between them, 22,972 readiness requests started an answer of their own (the rest shared one), with 2,135 verifications, 2,022 migrations, 5,886 retention deletes and 700 privacy runs, and 2,680 idle losses logged. 1,247 of those answers were true; the rest were false, or rejected where a failure that is not an `Error` makes the original's log line throw, which is kept.

  Fifty mutants each fail on a comparison:
  - **the lifecycle:** the backoff shortened, ignored, counted from the epoch or one millisecond longer; the upkeep hourly, started twice, unreported when it fails, or holding the process; any idle code logged, or an idle loss not invalidating; a configured database connected or unavailable at start; the first migration reported; verify mode migrating; the verified migration not recorded; a mismatch published as connected or reported ready; migration progress cut short, applied migrations miscounted, the product unnamed or verification counts crossed; a migrated store left waking; the client never given back; event and session retention crossed; idempotency keys kept a week; an invalidation keeping the shared answer or not advancing the generation; a waking loss published as unavailable, or a loss waking by default; a database dialled without a URL; one initialization per caller; an initialization published as unavailable; a late success believed, or left published; upkeep for a mismatched store; the ready hook never told; a failure left published as waking, or reworded; closing leaving the pool open; a pool per caller;
  - **the retention:** started twice or while the alpha is off; run hourly; fractions counted; any code, or a lower-case one, logged; no run at start; its timer holding the process; its failure reworded.

  `test/database-lifecycle.test.js` and `test/alpha-privacy-retention.test.js`, run as the judge in the oracle's place, catch all fifty too. Their first draft let five through: a mutant that left an operation waiting left the test waiting with it, and Node exits cleanly when nothing is left to run. Both tests now fail when they do not finish. One mutant first listed, a database without a URL marked required, was equivalent (such a database is connected, and that decides the state) and was replaced.
- **Tests.** `test/database-lifecycle.test.js` covers a server without a database, a cold start shared by its callers, the upkeep's three deletes, its timer and a failed round, verify mode and a mismatch that stands until the store is invalidated, a failure and the backoff to the millisecond, an invalidation racing an initialization, each reason for a loss, the idle loss and its log, and one pool and one upkeep for the life of the process. `test/alpha-privacy-retention.test.js` covers an alpha that is off or has no store, the run at start and the daily run, a second start, counts only, and each failure logged by a well-formed code and never by its message. `scripts/verify.js`'s strict database check reads the pool's constructor through the lifecycle, and `test/alpha-privacy-cli.test.js` reads the retention in its module and its start in the composition. The full gate found that last one still reading `server.js`.
- **Ratchet:** `server.js` falls from 3,248 lines to 3,103.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the database resilience gate, which starts the server against PostgreSQL and takes it away;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### The scan history's day names at midnight

- **What failed.** The qualification's first browser shard on `cf1e574` failed `scan history is grouped by day, newest first, and each scan opens into its report`: the newest group was headed "Yesterday" where the test expected "Today". The run reached that test a moment before midnight UTC.
- **Root cause.** The test dated its scans from the runner's clock, and the page names a day by its own clock when it draws the history. The run crossed midnight between the two, so today's scans were drawn as yesterday's. Pinning the page's clock just past midnight under the old test reproduced it exactly, "Yesterday" eighteen times in the retry log. The page was right: a scan from before midnight is yesterday's once midnight has passed. The test was not, and no other browser test names a day.
- **The fix.** The test takes one instant, dates the scans from it, and holds the page's clock there (`page.clock.setFixedTime`). The morning scan falls halfway between that day's midnight and the instant, so it is earlier the same day at any hour; before, it was 00:30, which was later than "now" for a run in the first half hour.
- **Checks:** the failure reproduced, then the fixed test with the instant pinned at 23:59:59.900 and at exactly midnight; the whole exposure suite on desktop, and the history test on desktop and mobile; lint.

### D13c — the session cookie and the provider session

- **What moved.**
  - The session cookie's seal, reading a cookie and writing the session cookie go to the platform, `apps/api/src/platform/authorization/session-cookie.ts`: `createSessionSeal(key)`, `readCookie`, and `createSessionCookieWriter(production)`, which asks whether this is production on every write as before.
  - Who an account is goes to identity and access's domain, `domain/account-identity.ts`: the identity key, now checked against the contract's `IDENTITY_KEY` instead of its own copy of the pattern; the stable provider identity the alpha binds to; the provider's authority; which accounts are served; the session as a request may act through it; and the session as it is stored.
  - The merge of a hosted session written by two requests at once goes to `domain/hosted-session-merge.ts`.
  - Where the provider session is kept goes to `application/provider-sessions.ts`: a row with a database, the privacy store's in the hosted alpha, the cookie without either. It holds `createProviderSessions` (writing, reading and ending a session, and the session id a cookie names), the two symbols a request carries its hosted base and revision under, and the answers to the store's refusals.
- **The server.** It composes the seal under the session's own key, the cookie writer and the provider sessions where the code they replace stood, and keeps the names its remaining code calls. The symbols come from the module, so the server's account code and the store read the same ones. It no longer has the 299 lines.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the three modules, composed as the server composes them, over 20,000 scripted runs: 7,720 with a database, 6,312 in the hosted alpha and 5,968 without a database, in production and not.
  - The scripts wrote sessions new, over and when asked for a new one; read them with and without retired accounts; read one and wrote it back on the same request; ended them, and sent the ended cookie again.
  - They sent cookies forged, cut, sealed under another key, repeated, padded, behind a longer name, naming a session, and whole beside a database.
  - The database was sometimes not ready, a row was sometimes gone or its write refused, and a read sometimes failed. The privacy store refused for each of its reasons, or had been written by another request in between.
  - Accounts came in every shape: tokens, App installations, retired providers, servers of their own, accounts carrying a key or one out of shape, and values that are not accounts.

  Randomness was one seeded stream replayed for each side, so seals and session ids matched byte for byte, and the clock was fixed. All 20,000 were identical across 230,089 steps: 35,846 writes, 35,159 reads, 8,828 sign-outs, 8,401 hosted writes, 7,602 hosted reads and 2,505 refused rewrites.

  Sixty-six mutants each fail on a comparison:
  - **the cookie:** a longer IV; the tag read from the wrong place; a cookie that does not open read as empty; a name matched by prefix; a value untrimmed; Secure outside production; a day by default; Strict same-site; a cookie scripts can read;
  - **who an account is:** any identity key trusted; an App's authorizer by case; an installation id as text; no default provider; an unnamed provider not GitHub; another App identity domain; an App identity without its account; account id zero, or an unsafe one, used; an unnamed provider refused; a custom server accepted; a list accepted as an account; a session with retired accounts returned whole; the selection unclamped or reset; a retired selection hidden; step-up kept beside retired accounts; `retiredSelection` stored;
  - **the merge:** an unchanged field overwriting the other request; a removed field kept; fields replaced rather than merged; lists merged as objects; a removed account kept; a changed account not written; the other request's accounts dropped, or put first; the selection by index; a base without a list of accounts merged;
  - **the store:** a new session not made when asked; a shorter session id; an unready store written or read; an alpha write without a named session, or ignoring what it read; an ended alpha write left a fault; an alpha refusal unmapped on a write or a read; the written or read revision forgotten; an identity listed twice; a write to an ended session accepted; a local cookie living ten times longer; a local sign-out asking for the database, or not revoked; live streams left open; a whole cookie accepted beside a database; an alpha read without the tester; an ended alpha session read as a fault; a read outage taken as no session; retired accounts always kept; an invalid local cookie accepted;
  - **the answers:** another tester's session answered as missing access; an unavailable tester not refused; a deletion in progress as a lock; a retired identity said to have changed; a full session, or a binding conflict, not answered.

  The three new tests, run as the judge in the oracle's place, catch all sixty-six. The first pass let five past the oracle and four past the tests. The oracle had never read and written on one request, sent a cookie again after sign-out, put a longer name before the cookie, or sent a whole session beside a database; the tests had never written as a tester whose cookie names no session, signed out an id cookie without a database, or sent a whole session that is valid without one. Each is covered now. One mutant first listed, an authority by case, was equivalent, because the URL parser already lowercases hosts, and was dropped.
- **Tests.** `test/session-cookie.test.js` covers the seal's format byte by byte, every way a cookie fails to open, reading a cookie and writing the session cookie. `test/account-identity.test.js` covers the identity key, the authority, the stable identity, the served accounts and their refusals, the session a request may act through, and the hosted merge field by field and account by account. `test/provider-sessions.test.js` covers each of the three stores: writing, rewriting, a new session when asked, a refused rewrite, outages, reading with and without retired accounts, signing out, the local policy's lifetime and revocation, the hosted alpha's merge with another request's write, and each refusal. The source checks follow the code: `hardening-contract` reads the store's fail-closed rules in the module and the server's database flag, and `provider-disconnect-server-contract` reads the hosted read and write in the module and the stable identity in the domain. The contracts record falls: `server.js` writes out two of the shared identifier patterns, down from three. The continuity archive now takes the platform's stable hash and its HMAC, which identity and access reaches through the identity key; the full gate found the archive without them.
- **Ratchet:** `server.js` falls from 3,103 lines to 2,804.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13d — the session's own security

- **What moved.** The session's security goes to identity and access, `application/session-security.ts`, as `createSessionSecurity`. It holds:
  - the nonce that binds a session's tokens to it, made when a session has none, which also ends any step-up it held;
  - the security context a token is bound to: this session's nonce and the identity acting;
  - the CSRF check for a changing request;
  - step-up: the grant verified for this action and scope, then claimed once from the replay guard, and the spent state written back. The guard is the in-process Map without a database and the shared single-use store with one, chosen by configuration. The comment on why moved with it;
  - the offline cache's scope (this session, or this cookie's digest, and this identity) and the binding a cached response must prove.

  The two token lifetimes move with it and are exported for the security routes.
- **The server.** It composes the session pieces (the seal, the alpha's two stores, the cookie writer, the provider sessions and now the session security) right after the database lifecycle, before the pipeline that reads them, so `apiNoStore(offlineCacheResponseBinding)` is handed a binding that exists. They are constructions with no effect of their own, and the route policy is unchanged. The shared single-use store stays in the server for now, since the GitHub App and the recovery use it too. The server no longer imports the CSRF and step-up verifiers, the step-up consumer or the offline cache policy.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside `createSessionSecurity`, composed as the server composes it, over 12,000 scripted runs, with and without a database. The tokens were real: CSRF tokens and step-up grants were minted with the platform's own functions under the same secrets. They were made for this session and identity or another, fresh or expired, for this action and scope or another, and some were tampered with. Pending step-ups were armed, expired, spent or missing. The shared guard claimed, refused or failed. Requests came with every method, with and without an account and in every cookie shape. URLs were mount-relative, as Express hands them to a middleware at `/api`, for listings, repositories (encoded too), sensitive and uncacheable paths, with the scope and repository headers right or wrong. All 12,000 were identical: 9,340 CSRF checks passed and 10,771 were refused, 2,891 step-ups were claimed and 22,088 refused, with 1,891 calls to the shared guard, and 1,438 cache bindings held.

  Thirty-five mutants each fail on a comparison: each lifetime changed; the nonce read by case, or shorter; step-up kept across a new nonce; a new nonce not written; a security value that is not an object kept; step-up cleared to nothing; a context without an identity or a nonce, or bound to the login; CSRF skipped for GET alone, read from another header, not required, or checked under the step-up secret; step-up read from another header, not required, checked under the CSRF secret, or accepted for another scope; the in-process guard beside a database, or the shared one without; the spent grant not written; the authorization not kept for the audit; the consumption not awaited; a cache bound to the cookie beside a session; a cache scope without an identity, shorter, or blind to the identity; the mount-relative URL read; the account listing keyed as a repository; a repository key by case, without its default provider, or not decoded; another scope or another repository bound.

  `test/session-security.test.js`, run as the judge in the oracle's place, catches all thirty-five too. The first pass let one past both: neither had sent a repository name that is percent-encoded but decodes to plain characters. Both do now. Two mutants first listed were equivalent and were dropped. A path that names no repository is never a private-cache path, and a decision other than private-cache carries no scope to match.
- **Tests.** `test/session-security.test.js` covers the state, the nonce and its case, the context and its refusals, CSRF for every method and every wrong token, step-up with and without a database (claimed, spent, refused elsewhere, a guard that cannot answer, another action or scope), the offline cache's scope from a session or a cookie, and the binding for every path and header. The source checks follow the code: `security-foundation-server` reads the awaited consumption, the asynchronous step-up and the configuration's choice of guard in the module, and the server's database flag; `offline-cache-policy` reads the binding's comparison in the module; `scripts/verify.js`'s replay check reads the module and the composition.
- **Contracts.** The module reads the CSRF and step-up header names from the shared contract (`packages/contracts/src/api-envelope.ts`) rather than writing them out; the contracts test refused the first draft for those two copies. They are the two exports' first consumers, and with them `server.js` writes out no shared pattern or header at all: the adoption record falls from 26 copies to 24 and from 24 waiting exports to 22.
- **Ratchet:** `server.js` falls from 2,804 lines to 2,720.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13e — the provider transport

- **What moved.**
  - The timed fetch goes to the platform, `apps/api/src/platform/network/timed-fetch.ts`, as `fetchWithDeadline`. Its deadline covers the whole response: it aborts a request that has not finished by then, keeps running while the body is read, and is cleared once the body has been read to its end, failed, or been cancelled. Its timer never holds the process open.
  - GitHub's REST client and the archive transport go to the GitHub provider, `client/github-rest.ts`, as `createGithubRestClient`. Every call is for a GitHub account on github.com. Every change is asked of the mutation gateway first. Reads are conditional on the last answer for the same credential and path, in a cache of 400 that lets the oldest go. A refusal carries its code, and a rate limit hidden in a 403 becomes a 429 with GitHub's wait. A refused App token is dropped outside the alpha. The two refusal helpers move with it, comments and all, as `providerFailureCode` and `providerRateLimit`, with the API's address and version.
  - The archive follows GitHub's redirect only to codeload, for the same repository, with no credentials, fragment or other path, and without the account's token. It releases the authenticated answer's body first.
  - The failure answer goes to the HTTP layer, `apps/api/src/http/errors.ts`, as `sendFailure`. It compares a status as it came, so a status written as text is read as it always was.
- **The server.** It composes the client after the App broker and the mutation gateway, and keeps `gh`, `githubArchiveResponse`, `fetchT` and `fail` as the names its remaining code calls. It no longer has the 196 lines, the API constants or the ETag cache.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the three modules, composed as the server composes them, over 4,000 scripted runs. The network was a fake that answered each request as the script chose: the status, the headers (ETags, retry-after, the rate-limit headers, redirect locations), and a body that arrived whole, in chunks, stalled or failed, or was cancelled. The deadline's timer fired when the script said, or when a call was still waiting once everything else had run, as the real one would.
  - The script made calls with every method and option, for every kind of account: tokens, App installations, bare strings, retired providers and servers of their own. It read a path GitHub had tagged and read it again, raw, under another media type or answered "not modified". It filled the cache past its size and read the oldest, a middle and the newest entries again. It drew archives through every kind of redirect, and failed requests with every kind of error into fresh, sent and destroyed responses.
  - All 4,000 were identical: 2,416 reads answered and 8,761 refused, 1,361 archives drawn and 1,219 refused, 3,195 timed fetches, 32,677 conditional reads, 3,708 changes asked of the gateway, 280 App tokens dropped, and 3,867 failures answered.

  Sixty mutants each fail on a comparison:
  - **the deadline:** ten seconds by default; holding the process; ended with the headers; left running after a failed request, a body read to its end, a failed body or a cancelled one; aborting nothing; not saying how long; the status text or the headers dropped;
  - **the client:** a HEAD asked of the gateway, or a DELETE not; a raw read made conditional; the cache shared between credentials or between paths; a 304 not answered from the cache; another media type or API version; the token under another scheme; JSON declared without a body; a call's own headers dropped; redirects followed; a raw transfer on the read deadline; a body that is not JSON dropped; an App token dropped in the alpha, or on a 403; a rate limit left a 403; the wait not passed on; a refusal without its code; a cache ten times larger; the whole cache dropped when full;
  - **the refusal helpers:** a 401 or a 404 without its code; a 500 not unavailable; every 403 a rate limit; GitHub's words read by case; the reset ignored; a wait of nothing or of two hours; half a minute by default;
  - **the archive:** for another provider; a redirect anywhere, for another owner by case or another repository, with credentials or a fragment, or to another path; the first answer left open; codeload asked with a credential, or its redirects followed; a reference unencoded; a 307 not followed;
  - **the failure answer:** a second answer after the headers; a destroyed response destroyed again; a redirect status passed on; a wait sent for any status, or a wait of nothing; the safe passage dropped; the request's reference ignored.

  `test/github-rest.test.js`, with `test/public-errors.test.js`, catches all sixty too. The first pass let eight past the oracle and six past the test, each closed since.
  - The oracle had never called the timed fetch without a deadline, read raw after a cached read, met a 304 for a cached path, read the cache again after filling it, seen a wait of nothing or a redirect to another repository, or met an App token refused in the alpha or a limit stated only as "Rate Limit".
  - The test had never seen a body fail, read raw after a cached read, read the middle of a full cache, or seen the authenticated answer's body released.
  - Nor had it cancelled a body whose first chunk was already taken. A cancelled body's own clear only matters then: when a read is still in flight, the cancel ends that read, and the read clears the deadline itself.

  One mutant first listed, a padded retry-after ignored, was equivalent and was dropped: `fetch`'s `Headers` already trims a header's value, so no padded value reaches the check.
- **Tests.** `test/github-rest.test.js` covers the deadline through every way a response ends, the refusal codes and every shape of rate limit, the client's headers, gateway, cache (credential, path, raw, media type, 304, eviction), bodies and refusals, the App token's invalidation and when it does not happen, every archive redirect accepted and refused, and the failure answer for every status, wait, passage and late response. The source checks follow the code: `public-errors` reads the refusal's classification in the client; `public-errors-server-contract` and `safe-passage-server-contract` read the failure answer in the HTTP layer and the server's use of it; `provider-disconnect-server-contract` reads the alpha's broker rule and the redirect rule in the client, with the server's alpha flag; `capability-registry-server-contract` reads the archive's body release in the client; `mutation-coverage-server-contract` reads the gateway check in the client and the server's wiring of it to the gateway.
- **A timing test made exact.** `test/uranus-linear.test.js` bounded each crafted file's reading by the wall clock, and on a runner busy with other tests a reading that spends 0.8 seconds read as 2.8 against a bound of 2.5. It now bounds the CPU time the reading spends, which is what "not quadratic" is about: six copies run at once all pass, and a quadratic reading still spends seconds.
- **Ratchet:** `server.js` falls from 2,720 lines to 2,524.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13f — the safety controls and the evidence chain

- **What moved.**
  - A person's safety controls go to Corona's domain, `domain/safety-controls.ts`: `defaultSafety`, what a stored record reads as, and `applySafetyPatch`, how a change is applied. A missing or malformed record reads as the controls all off. A change sets only the switches it names, to a boolean, and protects or releases one cleaned path, at most 100 to a repository and 30 repositories. It never changes the controls it was given.
  - Where they are kept goes to Corona's application, `application/safety-state.ts`, as `createSafetyState`. With a database they belong to the identity and the session holds a copy. A store that cannot answer is unavailable, never "all off". A change runs under the identity's lock, applied to the stored controls rather than the request's snapshot. A refused change says why, and any other failure is unavailable. A session copy that cannot be written because the session ended does not undo a committed change. `safetyUnavailable` moves with it.
  - The evidence chain goes to Corona's application, `application/evidence-chain.ts`, as `createEvidenceChain`. A record is appended under the repository's lock, chained onto the last with the ledger's key. A record already written is answered as written, marked deduplicated. Verification walks at most 5,000 records from the genesis, says whether it walked the whole chain, and counts records under a retired key. It tells an unmigrated chain from tampering when the legacy key is not accepted. The genesis and the walk's limit are named, `EVIDENCE_GENESIS` and `EVIDENCE_VERIFY_LIMIT`.
- **The server.** It composes the safety store and the chain after the single-use guard, and passes the keyrings it already built. It keeps `defaultSafety`, the loads and saves and the chain's two calls as the names its remaining code uses. It no longer has the 143 lines or the three keyring constants.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside Corona's three files, composed as the server composes them, over 6,000 scripted runs.
  - Every call to the database or the session was held until the script answered it, in the order the script chose. That covered readiness, connections, each statement of a transaction, plain queries and the session write. Each could answer, fail with every kind of error, or find a row in any shape.
  - The chains verification read were real: records hashed under the ledger's key, a retired derived key, the raw session key or a key nobody holds, some then tampered with. They were read under keyrings from random deployments, and now and then an acceptance that disagreed with its keyring.
  - The script loaded, changed and copied controls with every kind of patch and stored record, appended and verified evidence with every limit, and read a record and applied a change directly.
  - All 6,000 were identical: 8,747 loads, 10,478 changes (3,331 saved, 5,319 unavailable), 5,104 session copies (267 after the session ended), 6,862 appends (771 deduplicated) and 6,992 walks. Of the walks, 1,586 were valid and 2,098 failed; 328 named an unmigrated chain, 1,312 counted retired-key records and 2,414 were cut short.

  Seventy-five mutants each fail on a comparison:
  - **reading:** read-only or the freeze from a truthy value; protected paths from a non-object;
  - **changing:** the stored paths changed in place; read-only from a word; the freeze dropped; a path without a repository; a repository key untrimmed or with a third part; a bad key refused as 422; backslashes, a leading slash, doubled slashes or padding kept; a path climbing out; a path of 512 refused; an empty path kept; a path released by any falsy flag; a 101st path or a 31st repository kept; paths unsorted; an emptied repository kept; a refusal without its code, or claiming a provider change;
  - **keeping:** unavailable as a 500; the session read with a database that is not ready, or whose read failed; the stored controls read raw; a missing row read as no controls; a change saved while not ready; a failed connection unexplained; a change without its lock, or with a lock shared with other kinds; a change applied to the snapshot or to nothing; never committed; not rolled back, or a failed rollback thrown; a refusal reported as unavailable, or a 500 passed on; a client kept; the session's copy not updated; a copy failure swallowed without a database; every copy failure swallowed; a 503, a revoked session or a revision conflict thrown;
  - **the chain:** an append while not ready or without its lock; a record chained twice, a duplicate not marked or left open; another genesis; a chain onto nothing; a payload unhashed; a record under the session key; an append never committed, not rolled back, or its client kept; a walk while not ready; no floor on the limit; a ceiling of 1,000; a default of 100; a missing count as not a number; retired-key records not counted; a broken link or a bad hash accepted; an unmigrated chain reported on the opt-in, on a broken link, or probed with the keyring; the failure counted from zero or without its record; a partial walk called complete; the head not passed on; a walk that never moves.

  `test/corona-safety-state.test.js` and `test/corona-evidence-chain.test.js` catch all seventy-five too. The first pass let four past the oracle and one past the tests, each closed since.
  - The oracle had never stored a freeze as a truthy non-boolean, filled a repository to 100 paths and added one, counted a chain with no total, or been given an acceptance that disagreed with its keyring. The server never passes one, but the functions take them separately.
  - The tests had never switched read-only with a falsy non-boolean.

  One mutant first listed, a text record read as itself, was equivalent and was dropped: a primitive has none of the three controls, so reading it as itself or as an empty object gives the same.
- **Tests.** `test/corona-safety-state.test.js` covers every stored shape, every kind of change and refusal at its edges, every statement of a change with its values, every failure inside it, and the session copy for each way a session ends. `test/corona-evidence-chain.test.js` covers an append's statements, chaining, deduplication and failures, and a walk's limits, counts, partial walks, broken links, bad hashes, retired keys, an unmigrated chain and forged records, against an in-memory table. The source checks follow the code: `corona-safety-persistence-server` runs Corona's store, as the server composes it, against PostgreSQL rather than evaluating a slice of `server.js`; `hardening-contract` reads the idempotent append in Corona and the server's use of it.
- **Ratchet:** `server.js` falls from 2,524 lines to 2,381.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13g — the safety guard and the webhook intake

- **What moved.**
  - What the safety controls refuse goes to Corona's domain, `domain/safety-guard.ts`: `guardSafety` and the pieces it is made of (`safetyOf`, `candidatePaths`, `protectedPatternsForReq`, `protectedPathHit`, `protectedPathError`, `enforceProtectedPaths`, the governance control-plane classifier and the exempt prefixes). Read-only mode refuses every write. Protected paths refuse a write that names one, and, while any are protected, a write that acts on the whole repository. The controls themselves, the session's security, sign-out, the accounts, the GitHub App, the read-only recovery routes and governance's lifecycle stay reachable.
  - The key a repository's evidence is kept under goes to Corona's domain, `domain/evidence-keys.ts` (`repoKey`, `scopedEvidenceKey`).
  - Corona's safety store gains `protectedPatternsForIdentity`, the read a webhook delivery scores against. It is the same statement the server sent, and a failed read is still the caller's failure, never "nothing protected".
  - The webhook limiter goes to Pulsar's application, `application/webhook-limiter.ts`: 120 deliveries a minute for one sender and hook, the local bucket in front of the shared counter, the window that reopens once sixty seconds have passed, and the sweep past 2,000 senders. It now says how many senders it tracks (`tracked`), so the sweep can be tested.
  - The intake goes to Pulsar's application, `application/webhook-intake.ts`, with the broadcast it makes: the hook looked up, the signature checked against the hook's own secret, the event scored, stored once, recorded in the identity's evidence chain and written to the identity's live streams. It takes the protected paths, the evidence key and the chain from Corona through its dependencies, so Pulsar does not read Corona's table.
  - The address GitHub delivers to goes to Pulsar's domain, `domain/public-callback.ts`, as `publicCallbackBase(req, env)`.
- **The server.** The intake's route is mounted before the JSON parser, so what it needs now exists by then: the safety store, the evidence chain and the live hub are composed beside the session, and the limiter and the intake just before the route. It no longer has the 221 lines, and no longer imports the webhook's signature, normalizer or risk, the path matcher or the stable hash.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the new files, composed as the server composes them, over 3,000 scripted runs, each with four drives.
  - **The guard and the keys:** 40 random requests a run, over every method, the routes the guard treats specially and ordinary ones, every place a request can name a path, and controls from the request, the session or malformed stored keys.
  - **The limiter:** deliveries from a few senders to a few hooks, bursts past the local ceiling, floods of new senders past the sweep size, a clock moved across the window's edges, and a shared counter that answers, refuses, fails or is absent, each answer held until the script settles it.
  - **The intake:** deliveries signed with the hook's secret or not, with every header, payload and repository, and every answer the database and the evidence chain can give.
  - **The callback address:** every environment and request.

  All 3,000 were identical:
  - 120,000 guarded requests: 4,897 refused for read-only mode, 3,357 for a protected path and 1,262 as repository-wide; 19,159 on governance's control plane; 3,749 refused by `enforceProtectedPaths`;
  - 6,331,585 deliveries allowed and 466,541 refused by the limiter, 17,728 shared counts;
  - 981 deliveries accepted, 7,533 refused, 1,696 failed, 853 broadcasts;
  - 99,000 callback addresses.

  Ninety-six mutants each fail on the tests. The oracle catches ninety-five. The ninety-sixth, buckets never swept, changes only how much the limiter remembers: the server's limiter gave no way to see its buckets, so the oracle cannot observe it, and the test catches it through `tracked`.
  - **the guard:** the controls, or the App, no longer exempt; the session's copy over the loaded controls; a body's path, a move's destination, a rename's old path, a prefix, the query, a batch's paths, an upload's files or a commit's operations ignored; a leading slash kept; a request without a repository protected; any pattern a hit; a hit not named; a protected path as a 403; governance's draft edits and deletions, a policy's restore, its reset or a baseline refused; governance on any route under it, by the method's case, or on a longer path; a read guarded or a PUT unguarded; governance, a restore preview or an emergency manifest guarded; an exemption anywhere in the path; read-only ignored; a named protected path allowed; a restore, a reset, a reference restore, a repository deletion or a branch deletion allowed; a deeper deletion or a branch's creation repository-wide; repository-wide refusal without protection;
  - **the keys:** another default provider; an owner or a repository by case; an empty identity not anonymous; a longer identity;
  - **the protected-path read:** another identity's; a failed read swallowed;
  - **the limiter:** a window of thirty seconds; a limit of 100; no local excess; a window reopened only after it ends; a bucket per sender only; an address unbounded; buckets never swept, or fresh ones swept; a refusal forgotten; one over the limit allowed; another namespace; the API limiter's window rule; an unanswerable counter as permission; a shared refusal not held;
  - **the intake:** a hook id of any length or by case; the rate ignored; a delivery without a database; another provider's hook; an inactive hook delivered; an unsigned delivery read; a bad signature as a 403; a delivery without its id or its event; an event name unbounded; a bad payload as a failure; the payload unhashed; another repository's delivery, or a repository by case; the protected paths ignored; an event stored alike for every identity; GitHub's event id not kept; the stored time ignored; evidence under GitHub's id; a redelivery broadcast again, or a completed chain not broadcast; a ping answered 202; a redelivery called accepted; a failure not logged, or explained; a broadcast under another event name, or to the whole repository;
  - **the callback address:** the Render address ignored; a trailing slash kept; an inferred address, or plain HTTP, in production; credentials in the address; any scheme; the address normalised.

  The first pass let five past the oracle and one past the tests, each closed since.
  - The oracle had never met a malformed stored key that names no owner, a governance route longer than its own, an exempt prefix inside another path, or a long event name on an accepted delivery.
  - The tests had never met that malformed key either.

  One mutant first listed was itself broken: its replacement held `$'`, which `String.replace` reads as "the text after the match". It was rewritten.

  Four mutants first listed were equivalent and were dropped:
  - a stored record read raw for the protected paths: a non-object reads as no paths either way;
  - a broadcast id unfiltered: the id is always the stored event's hex digest;
  - a local refusal not held: it would end exactly when the bucket resets anyway;
  - the default branch ignored: the risk falls back to the event's own default branch.
- **Tests.**
  - `test/corona-safety-guard.test.js` covers whose controls apply, every place a path is named, the patterns and their hits, every governance control-plane route and its near misses, every refusal and exemption, and the evidence key.
  - `test/pulsar-webhook-intake.test.js` covers the limiter alone and with the shared counter (windows, refusals held and lifted, an unanswerable counter, the local ceiling, the sweep), a delivery that passes every check with what it stores, records and broadcasts, a redelivery and a completed chain, every refusal and what it does not reach, failures past the checks, and the callback address.
  - `test/corona-safety-state.test.js` covers the protected-path read.
  - The source checks follow the code: `governance-api-server-contract`, `governance-simulation-server-contract` and `governance-template-digital-twin-server-contract` read the guard in Corona; `rate-limit-server-contract` reads the webhook window in Pulsar; `hardening-contract` reads the protected-path read in Corona and the intake in Pulsar, with the server's composition of them; `verify.js` reads the intake and the limiter.
- **Ratchet:** `server.js` falls from 2,381 lines to 2,160.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13h — the request guards

- **What moved.** The guards a request passes before a route reads or changes anything go to identity and access's application, `application/request-guards.ts`, as `createRequestGuards`:
  - `providerSessionAccess` attaches the signed-in session and its GitHub account, for a read.
  - `auth` does that, resolves the account's credential, checks the session's security and the request's CSRF token, loads the identity's safety controls and refuses what they refuse, and spends a step-up grant for a sensitive operation.
  - `accountAuth` does the same for account management. It accepts a retired account and neither resolves a credential nor asks for step-up.
  - `signedOutWithoutGithub` answers a session with no GitHub account left.

  The account's resolution (the GitHub provider, with the App broker), the safety controls and their guard (Corona) come in as dependencies, since identity and access cannot import either.
- **The server.** It composes the guards where they were, after the safety store and the session's security. It no longer has the 78 lines, or the sensitive-operation table's import.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the guards, composed as the server composes them, over 20,000 scripted requests through all four.
  - A request carried a session or not, with GitHub accounts, retired ones or a mixture, any active index, and a retired selection.
  - Every dependency answered as the script chose, or failed with any kind of error, a null one included. Those were the stored session, the account's resolution, the session's security, the CSRF check, the safety controls and the step-up grant.
  - The safety guard and the sensitive-operation table were the real ones, over writes and reads of every route that matters to them. A route itself sometimes threw.
  - All 20,000 were identical: 3,834 passed, 686 locked by the controls, 11,118 refused, 2,470 failed, 346 step-ups spent, 3,825 credentials resolved, 2,495 signed out for want of a GitHub account, and 583 that threw out of the guard (a null error, as before).

  Thirty-three mutants each fail on a comparison:
  - **attaching:** the stored session over the request's; retired accounts always dropped; no session as a 403; a retired selection served, or refused to account management, or without its code; the session not attached; the active index unbounded; the first account always; a retired account served; the session's account shared rather than copied;
  - **answering:** a failure without its status, message or code; a read let through unsigned;
  - **auth:** the session's own credential kept; the session's security, the CSRF check or the controls skipped; the controls ignored; a lock as a 403 or not marked; the step-up for another provider, or without the request's body; a sensitive operation without step-up; a failure without its status or code;
  - **signed out:** signed in with any account; signed out as a 403;
  - **account management:** refusing retired accounts; without CSRF; ignoring the controls; resolving the credential.

  `test/request-guards.test.js` catches all thirty-three too, on its first pass. The oracle let one past at first, the step-up for the session's account rather than the resolved one's. It was equivalent and was dropped: the sensitive-operation table never reads the identity key it is given.
- **Tests.** `test/request-guards.test.js` covers which session and account each guard attaches, every check of `auth` and `accountAuth` in order, the step-up each sensitive operation spends (and the refusal of a provider other than GitHub), every refusal and failure with its status, message and code, and when a session counts as signed out. The source checks follow the code:
  - `hardening-contract` and `security-foundation-contract` read the guards in identity and access, with the server's composition of them.
  - `security-foundation-server` checks that every step-up consumption in the server and its modules is awaited, skipping declarations.
- **Ratchet:** `server.js` falls from 2,160 lines to 2,082.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13i — the mutation contexts

- **What moved.**
  - The context a repository change runs in goes to the platform, `platform/mutation-gateway/mutation-context.ts`, as `createRepositoryMutationContext`. It describes the change: who asks, for which repository, through which route, with what authorization, and the metadata the policy and the ledger read, path facts included. A merge's facts are read first. The route then runs inside the mutation gateway, and the context ends when the answer is sent or the connection closes. An approval refusal of a write is offered the safe passage, judged by the active policy set read without writing.
  - The wrapper both contexts share, which runs the route until the answer or the close and leaves no listener behind, is exported as `runInMutationContext`, with `applyPolicyDecisionHeaders`. The server had written it twice.
  - The modules' parts come in as dependencies, since the platform imports only the platform: the authorization resolver, the alpha's actor label, Uranus's merge facts, Corona's restore inspection, Kepler's active policy set and step evaluator, and the failure answer.
  - Who may read and change a repository's governance, and the context a governance change runs in, go to Kepler, `http/governance-context.ts`, as `createGovernanceContext`, with `OWN_WORK`. What the ledger records about each governance-shaped change goes to Kepler's domain, `domain/governance-mutation-metadata.ts`. That covers governance's own actions and the exposure and code-audit decisions recorded the same way.
  - A merge's facts go to Uranus, `application/merge-facts.ts`, as `mergeFactsFor`. It reads the pull request and the merge gate through the audit service, as the server did.
- **The server.** It composes both contexts where they were. It no longer has the 446 lines, or the imports of the batch, path, safe-passage, snapshot and audit-triage helpers they used.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the new files, composed as the server composes them, over 8,000 scripted requests for every repository and governance action.
  - **The gateway** refused before the route (an approval refusal or another), ran it with or without a policy decision, or failed after it.
  - **The route** answered, threw, or left the answer open while the connection closed, and the answer was sometimes already sent when a failure arrived.
  - **The dependencies:** authorization resolved with every role, publicly or not, or failed. The governance service, the merge's pull request and gate, a restore preview's inspection and the active policy set each answered or failed.
  - **The inputs:** bodies and parameters were random, raw, malformed, valid or long, for every field any action reads. Accounts came with and without a provider. Alpha testers were valid and invalid, inside and outside the alpha.
  - The safe passage and its step evaluator were the real ones.

  All 8,000 were identical: 5,535 repository and 2,465 governance requests; 2,885 routes run and 3,917 failures answered; 161 safe passages offered; 1,383 governance refusals; 6,627 policy headers; 187 failures after the answer had begun; 827 merges and 1,258 restores described.

  A hundred mutants each fail on a comparison:
  - **the headers:** a decision without its outcome, mode or id; every warning sent, or an empty list sent;
  - **the run:** ended at the answer only or the close only; listeners left behind, after either end or a throwing route; a throwing route swallowed; the context not on the request; no policy headers;
  - **the repository metadata:** path facts dropped; texts unbounded; a repository private or initialised only when asked; a branch from nowhere; a reset without its target; a write without its head; a rename or a folder move without an end; a batch without its summary; a revert without its commit; a path restore without its prefix; a draft pull request not said; a merge's facts unread, its method not defaulted, or its audit dropped; a review without its event; an issue update without its state; a release by GitHub's field names ignored; an upload's LFS mode not defaulted; a restore not inspected, or its confirmation unbounded;
  - **the descriptor:** another default provider; a new repository under the route's owner; the actor's login not kept; the route as requested rather than declared; the step-up, or its time, not recorded; the authorization not recorded;
  - **the authorization:** a new repository resolved, or for another reason; the alpha's label applied outside the alpha or never; the principal or the governance actor not relabelled;
  - **the safe passage:** offered for any refusal, any action, without content or without a database; judged by no policy; an unavailable passage offered; a failure unlogged;
  - **the repository context:** the authorization not on the request; a merge without its facts, or every change read as a merge; a refusal without its passage; a late failure answered again, unlogged, or without its code;
  - **governance access:** answers cached; no service; another provider's scope; the role ignored; a public reader among collaborators, or refused everywhere, or refused as a 401, or not marked; own work closed to public readers;
  - **the governance context:** a change without governance access; the session's provider, or the session's identity, in place of the authorization's; a step-up recorded; the authorization dropped; the metadata dropped; a late failure answered again;
  - **the governance metadata:** a policy key or an identifier unbounded; a negative revision kept; a decision, a triage reason, a simulation hash or an export format by case; rule ids unsorted or unbounded; a target list kept; the rule count capped; a reset's text recorded, or confirmed by case; a triage of 3,651 days; a probe's column count uncapped; notifications enabled by a word; a webhook's address recorded, or disabled by default; an export from a negative event; an unknown action described;
  - **the merge facts:** a pull number as text; an unreadable pull request failing the merge; the gate never asked.

  `test/mutation-context.test.js` and `test/governance-context.test.js` catch all hundred too.
  - **The first pass** let seven past the oracle. It had never sent a valid batch, an account without a provider, a valid alpha tester, a listed policy set, a provider name in another case, or a reset confirmation that matched.
  - **After that widening** one more slipped past: the restore confirmation's bound, since the restore mode only sent a short confirmation. It now sends a long one too.
  - **The tests** let three past at first: a new repository whose route names another owner, and that a refusal without approval, or a write without content, never reads the policy set.
  - **The final judge** ran again over the oracle as it now stands.

  Two mutants first listed were equivalent and were dropped:
  - a raw body read as the body: a `Buffer` has none of the fields the metadata reads;
  - line breaks kept: `cleanText` already turns them into spaces.
- **Tests.** `test/mutation-context.test.js` covers the policy headers, the run and how it ends, the metadata and descriptor of every action, the authorization and its alpha relabelling, every case of the safe passage, the context when it runs, refuses or fails after the answer has begun, and a merge's facts. `test/governance-context.test.js` covers governance access for every role, public reader and scope, the governance context and its failures, and the metadata of every governance-shaped action. The source checks follow the code:
  - `authorization-resolver-server-contract`, `mutation-gateway-server-contract`, `protected-paths-server-contract`, `safe-passage-server-contract`, `mutation-coverage-server-contract` and `governance-enforcement-server-contract` read the platform's mutation context and the server's composition of it.
  - `governance-api-server-contract`, `governance-template-digital-twin-server-contract` and `governance-exception-server-contract` read Kepler's governance context and metadata.
  - `verify.js` reads the batch and restore summaries in the platform.
- **Ratchet:** `server.js` falls from 2,082 lines to 1,636.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13j — repository and capability access

- **What moved.**
  - Which repositories a request may reach, and the guards around a repository's own lifecycle, go to identity and access's application, `application/repository-access.ts`, as `createRepositoryAccess`:
    - **the alpha's scope:** for a route, a list, a new repository (by its exact pre-authorized name), a step-up grant and a safety change;
    - **the guards:** the deletion confirmation and the code search held to the invitation;
    - **the safety view:** the controls a tester sees;
    - **the actor:** the one the ledger keeps.

    A repository the invitation does not name is refused alike whatever does not fit. GitHub's own rules for a name and a search, and Corona's reading of the safety record, come in as dependencies.
  - What the account can do here goes to the platform, `platform/authorization/capability-access.ts`, as `createCapabilityAccess`: the context a feature is resolved in, the capability map the page reads, the route guards and their refusals, and LFS's rule (GitHub on github.com only). The capability document and its registry (`src/capability-registry.js`), the account's authority and its token kind come in as dependencies.
- **The server.** It composes both right after the failure answer, before the mutation contexts, since those take the ledger's actor. It no longer has the 269 lines, or its imports of the scope rules, the actor label's error type and the step-up normalizer.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the two files, composed as the server composes them, over 20,000 scripted runs through every guard:
  - inside and outside the alpha;
  - with invitations that name repositories, name none, are malformed or are missing;
  - for accounts of GitHub (with tokens or an App, with or without a provider, on an enterprise address), of retired providers, with a name whose text cannot be read, or none;
  - with new repositories, deletions, searches, step-up requests and safety changes of every shape;
  - for every capability the document lists.

  Half the runs asked a scripted registry and authority, given alike to both sides, for answers the real document never gives: planned, experimental and unavailable features, refusals with their own status, and an error with none. All 20,000 were identical: 132,224 requests passed, 57,743 refused, 70,033 failures answered, 7,562 alpha grants and 2,688 step-up operations kept on the request, 35,279 capability refusals, and 13,711 safety views filtered for a tester.

  Fifty-six mutants each fail on a comparison:
  - **the actor:** the tester's label outside the alpha; an unknown actor not named;
  - **the alpha's scope:** another default provider; GitHub's authority from the account; every repository allowed; an unbound invitation refused; the scope not canonical; a refusal as a 404 or not raised; a malformed scope passed on;
  - **the guards:** checked outside the alpha (a route, a list, a safety change); the grant not kept on the request; a refusal without its code; a malformed list entry kept; a list for any account;
  - **a new repository:** unvalidated, unscoped in the alpha, or scoped outside it;
  - **a deletion:** confirmed by case or not at all; its refusal said to change the provider;
  - **a search:** unvalidated, unscoped in the alpha, or scoped outside it;
  - **a step-up:** for another provider; its repository unscoped, or scoped outside the alpha; without its operation;
  - **the safety view and changes:** the global switches in the alpha or said to be here; every repository's protection or a malformed key shown; a global switch accepted; a global refusal as a 400; a padded key refused; a missing scope as a 400; a protection unscoped;
  - **the capabilities:** for another provider or deployment; notifications for an installation or when only planned; a context for another provider or without its token kind; qualification ignored; the capability not on the request; an unavailable capability as a 403; a refusal's own status ignored; a refusal without its feature; every request checked; a planned capability supported; LFS for any authority or any provider, or unchecked by the document.

  `test/repository-access.test.js` and `test/capability-access.test.js` catch all fifty-six too.
  - **The first pass** let ten past the oracle. It had never sent a valid new repository's body, a GitHub App or retired provider whose capabilities differ, a qualification that matters, a refusal with its own status or none, or an account on github.com that is not GitHub's. The scripted registry and authority closed those.
  - **The tests** let three past at first: a retired provider creating a repository inside and outside the alpha, and an empty search outside it.
  - **The final judge** ran over the oracle as it now stands.

  One mutant first listed, a type error passed on rather than refused as not allowed, was equivalent and was dropped. The scope rules raise their own error for every malformed input, so no type error reaches that arm on these paths.
- **Tests.**
  - `test/repository-access.test.js` covers every guard inside and outside the alpha, with each way a request fits or does not, and what each keeps on the request. `test/capability-access.test.js` covers the context, the capability map, the guards and their refusals, and LFS against a scripted registry, and once against the real document.
  - The source checks follow the code:
    - `github-app-server-contract` reads the installation's notifications in the platform.
    - `provider-disconnect-server-contract` reads the ledger's actor in identity and access, with the server's alpha flag.
    - `security-foundation-contract` checks that the guards which enforce the security foundation import it, and that the server composes them. It names the module's path without the `from` before it: the candidate archive's check reads `from '…'` in any program as an import, and this one would lead out of the tree.
- **Ratchet:** `server.js` falls from 1,636 lines to 1,367.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13k — the account lifecycle

- **What moved.** An account's life in a session goes to identity and access's application, `application/account-lifecycle.ts`, as `createAccountLifecycle`:
  - **who an account is:** an App installation as it says, any other account as its provider says;
  - **signing in:** one entry per identity up to the account cap, the new one selected. In the alpha the account joins the tester's own provider session, a new one when the cookie names a session that ended; elsewhere a sign-in that replaces a row holding only retired accounts removes that row and its credentials;
  - **disconnecting:** outside the alpha, an App installation's grant dropped and recorded, the selected identity kept selected, and what to revoke at a retired provider named. In the alpha, each account through the provider disconnect until one cannot remove its provider state; a retired account's credential leaves the session at once and its cleanup waits for the operator;
  - **a provider session's cookie** ended with its live streams; **sessions elsewhere** revoked, and an identity's sessions found.

  The GitHub client, the App broker and its audit trail, the session and its cookie, the held audits and the alpha's privacy store come in as dependencies. `RETIRED_CLEANUP` is exported with it.
- **The server.** It composes the lifecycle where `providerIdentity` stood. It no longer has the 327 lines, or its imports of the hosted account key, the revocation guidance, the provider disconnect, the alpha's identity key, the connection refusal and the hosted session's base and revision.
- **One read dropped.** The identity's sessions read the account's base URL and never used it; the read is gone.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the module, composed as the server composes it, over 20,000 scripted runs:
  - inside and outside the alpha, with and without a database;
  - for accounts of GitHub (token, OAuth, App), retired providers, none and an unknown one, and GitHub's by another spelling;
  - with existing sessions and none, cookies naming sessions and not;
  - with a provider, a pool and a privacy store that answer, refuse or fail as one seeded script says for both sides.

  The provider disconnect, the identity keys and the alpha's refusals are the real ones. Randomness and time were fixed alike. Every call each side made, with what it passed, every answer and failure, and what the request and session were left holding, was identical: 40,091 disconnects (1,822 accounts verified gone, 509 retired, 11,511 pending), 25,652 sign-ins (9,395 into a tester's session, 9,341 refused), 4,866 session lists and 9,928 revocations.

  Eighty-seven mutants each fail on a comparison:
  - **who an account is:** an App identity asked of the provider or without its avatar; the wrong path;
  - **disconnecting, outside the alpha:** a malformed account kept; held audits kept; the alpha path taken; a token account treated as an App; the broker kept warm; an installation's grant kept or its leaving unrecorded; the selection by clamped index, read unclamped, or handed to a retired account; accounts not removed; a step-up kept; no guidance for a retired account;
  - **disconnecting, in the alpha:** without the tester, or refused as a 403; the account resolved each time; webhooks of every identity, without their stored hash or by their local id; a removal claimed or made with GET; the readback skipped; an unencoded path; a token account's broker invalidated; cleanup recorded against another identity or as a webhook; a retired account stopping the rest, or a pending one not; an App disconnect unrecorded; a retired credential kept; the hosted selection, base or revision lost or shared; a retired cleanup counted complete; no manual cleanup named;
  - **the cookie and revocation:** a live session left open; the cookie not cleared; nothing to revoke still asked; revoked as asked rather than as done; the wrong column;
  - **signing in:** an unknown method kept; a login untrimmed; an account id kept as text; an incomplete identity as a 500; a fractional installation accepted; an installation's text unbounded; every repository selected; permissions shared; a verification time made up; an installation listed twice or replaced across authorizers; no credential; a token account listed twice or replaced across providers; the alpha keyed like the legacy session; a held session ignored or a numeric one held; the cap ignored, exceeded or applied to the newest; an ended session not restarted, restarted on any refusal, or restarted under its own name; a refusal passed raw; the connected session, its base or its cookie lost; the new account not selected; a retired selection or a step-up kept; a replaced row or its live streams kept; a row replaced over an existing session; a new session never created;
  - **sessions elsewhere:** listed without a cookie or for another provider; released or unowned sessions listed; legacy rows not read; a row listed twice, unreadable or not the identity's; the current session unmarked.

  `test/account-lifecycle.test.js` catches all eighty-seven too.
  - **The first pass** let five past the oracle. It had never compared the hosted base with the session itself, signed an App in with another authorizer's installation, or sent a long account type. Recording whether the base is a copy, and those sign-ins, closed them. Two more came through when the plan changed: a retired account selected, and an installation replaced across authorizers. A drive that disconnects the selected account, and an App sign-in into every scenario's session, closed those.
  - **The final judge** ran over the oracle as it now stands.

  Three mutants first listed were equivalent and were dropped:
  - **the binding's provider:** the provider disconnect lowercases it, and only GitHub's reaches the binding;
  - **a partial disconnect supported-complete:** a shorter list of results always ends with an account whose state stayed, which fails the check anyway;
  - **a hook removed at a retired provider:** removal is reached only with a valid binding, which needs GitHub's own authority.
- **Tests.**
  - `test/account-lifecycle.test.js` covers who an account is; signing in outside the alpha (trimmed and keyed, replacing the right entries, the cap, a replaced row) and into a tester's session (the held session, a numeric cookie, an ended session restarted, refusals); disconnecting outside the alpha (selection, an installation's grant) and through the provider disconnect (each hook removed and read back, a hash that disagrees, an installation, a retired account's cleanup and session, an account that stops the rest); the cookie; revocation; and an identity's sessions.
  - The source checks follow the code:
    - `provider-disconnect-server-contract` reads the disconnect, the sign-in, the containment and the session inventory in the lifecycle, and counts the lifecycle among the places that may not call the central disconnect.
    - `alpha-privacy-server-contract` checks that the lifecycle takes the revocation guidance from the privacy policy.
    - `github-app-server-contract` reads the broker's invalidation in the lifecycle, handed the server's broker.
    - `hardening-contract` reads the session inventory's query in the lifecycle.
    - `security-foundation-contract` reads the default sign-in method in the lifecycle.
- **Ratchet:** `server.js` falls from 1,367 lines to 1,040.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13l — the GitHub App records, the upload scan and the durable stores

- **What moved.**
  - A GitHub App installation's record and its audit trail go to identity and access, as `createGithubAppRecords` (`application/github-app-records.ts`): the audit's log line and row, the tester the alpha names as its actor, and an installation's metadata kept and removed outside the alpha. What an audit detail may keep is its domain rule, `safeGithubAppAuditDetails` (`domain/github-app-audit.ts`).
  - How many accounts a session may hold goes to identity and access's account identity, as `sessionAccountCapacity`: ten where sessions are kept in the database, three where the whole session is sealed into its cookie.
  - The scan every uploaded file passes goes to the workbench, as `createUploadScan` (`application/upload-scan.ts`): a blocked file refused with 422 and recorded on the repository's evidence chain, a clean one's answer. The platform's scanner, Corona's evidence chain and its key come in as dependencies.
  - The upkeep of the files an upload leaves behind goes beside it, as `createUploadUpkeep` (`application/upload-upkeep.ts`): only the upload routes' own names, only regular files older than the stale-upload age, at startup and then at most hourly.
  - The stores a request's admission and its single-use grants are kept in go to the platform, as `createDurableStores` (`platform/rate-limit/durable-stores.ts`), each built on first use over the one pool.
- **The server.** It composes the stores and the App records right after the database, since the session security, the rate admission and the App broker take them; and the scan and the upkeep with the workbench's other services. It no longer has the 140 lines, or its imports of the file system, the operating system and the two store classes.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the five files, composed as the server composes them, over 20,000 scripted runs:
  - scan results blocked and clean, of every shape, for requests with and without a repository, with an evidence chain that answers, rejects or throws;
  - temporary directories of every kind of name, age and file, that fail to be read, stat or unlinked, run directly and as the timer runs them;
  - the stores with and without a database;
  - App lifecycle events, installations and removals inside and outside the alpha, with a database that is ready or not, answers, or fails.

  Randomness, time and the timers were fixed alike, and a promise either side left rejected was recorded. Every call each side made, with what it passed, every log line, answer and failure, was identical: 14,072 uploads refused and 18,187 passed, 6,378 evidence records, 20,034 stale files removed, 44,490 audit events logged and 33,549 written, 5,627 installations kept and 22,285 removed.

  Sixty-seven mutants each fail on a comparison:
  - **what an audit keeps:** a provider login; the reason dropped; a null detail kept; a detail unbounded, or an expiry bounded like the rest; a list of permissions kept; a permission of any name or any level; every permission kept;
  - **the audit:** a tester looked up outside the alpha; disconnected bindings counted; a shared identity labelled; an identity or event type unbounded; a nameless identity unnamed; an installation id kept in the alpha, or an unsafe one kept; details unfiltered; a supplied actor of any shape; the bound tester ignored; an unknown actor kept; the event unlogged; a row written without a database, with its raw details, or reusing its id;
  - **an installation:** kept in the alpha or without a database; a suspension never cleared; permissions written as given; a status or the authorizer's id lost; an absent suspension written as given; removed without a database, or for every identity;
  - **the scan:** a blocked file allowed; an engine unnamed; a rule unbounded; a severity lowered; evidence without a repository, without its actor, or not recorded; a path unbounded; a size as given; a failed record refusing differently; a refusal as a 400 or without its rules; the built-in matches uncounted; YARA said to be configured or available; YARA's error unbounded or dropped;
  - **the upkeep:** any file in the temporary directory, or an upload's name by any case; the stale age in minutes; an unreadable directory, or one failure, stopping upkeep; a fresh file, a directory or a file at the cutoff removed; no upkeep at startup; upkeep more often than hourly; the timer keeping the process alive;
  - **the stores and the capacity:** a rate store without a database; a new store each time; a cookie session's capacity raised, or a database session's lowered.

  `test/github-app-records.test.js`, `test/upload-scan.test.js` and `test/durable-stores.test.js` catch all sixty-seven too.
  - **The first pass** let two past the oracle and crashed it on three. It had never passed a provider login among the details, or asked for the tester outside the alpha directly; and a rejected promise nobody answered stopped the oracle rather than counting as a difference. The oracle now passes both, and records an unanswered rejection.
  - **The tests** let one past at first: the tester asked for outside the alpha.
  - **The final judge** ran over the oracle as it now stands.
- **Tests.**
  - `test/github-app-records.test.js` covers what an audit detail may keep, the audit inside and outside the alpha (the tester named, the log line, the row, without a database), and an installation kept and removed. `test/upload-scan.test.js` covers a clean file's answer, a blocked file's refusal and record, and which temporary files the upkeep removes, when. `test/durable-stores.test.js` covers both stores and the session's account capacity.
  - The source checks follow the code:
    - `github-app-server-contract` reads the installation and audit tables in the App records.
    - `provider-disconnect-server-contract` reads the alpha's refusal to keep installation metadata, the audit's fields and the tester lookup in identity and access, and checks that the evidence a disconnect or a blocked upload leaves names the retained actor.
    - `hardening-contract` and `scripts/verify.js` read the malware refusal in the upload scan, composed over the platform's scanner and handed to the upload routes.
- **Ratchet:** `server.js` falls from 1,040 lines to 900.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13m — governance's and exposure scanning's life in the process, and the shutdown

- **What moved.**
  - Governance's life in the process goes to Kepler, as `createGovernanceHost` (`application/governance-host.ts`):
    - the store, its API service and the webhook delivery worker, built once on first need;
    - the runtime the mutation gateway consults, with its failure log and the decisions it records;
    - delivery started at boot once the database answers, retried every thirty seconds until it does, never without a database or once shutdown has begun;
    - stopping, which clears the retry and hands back the batch in flight.
  - Exposure scanning's goes to Quasar, as `createExposureHost` (`application/exposure-host.ts`): the capability document's gate, the worker with its store, reader, fingerprint key, a scan's session and its pinned transport, a nudge, the store the routes read, and stopping.
  - Stopping goes to the platform, as `createGracefulShutdown` (`platform/lifecycle/graceful-shutdown.ts`): once, on the first signal; the job queues, the log line, the live streams and the workers in order; then the workers' work waited for in turn, the pool closed and a clean exit, bounded by a forced exit after ten seconds.
- **The server.** It composes the shutdown and the governance host where the runtime was built, before the mutation gateway that takes the runtime, and the exposure host where its worker was. It hands the shutdown's flag to both hosts and both hosts' `stop` to the shutdown. It no longer has the 171 lines, or its imports of the store, service, worker and runtime constructors, the guarded transport and the text cleaner.
- **Behaviour unchanged.** An oracle evaluated the previous statements of `server.js` beside the three files, composed as the server composes them, over 20,000 scripted runs. What the hosts build is a recording stand-in, handed to the old statements as parameters and to the hosts through module hooks, so every construction is compared with what it was given. Each run applies a seeded sequence of operations:
  - the runtime's decisions and its failure log;
  - delivery started at boot and retried, the API service, a delivery failure's log;
  - the capability document read for scanning, the worker started and nudged, a scan's session and transport, the store the routes read;
  - a shutdown with workers and a pool that finish, fail or never answer.

  These run with or without a database, a database that answers or not, a failure mode valid or not, and a capability document of every shape. Time and the timers were fixed alike, the workers finish only once the server has closed, and a promise either side left rejected was recorded. Every construction and call, every log line, answer, failure and timer was identical: 17,987 hosts built and 2,013 refused for their failure mode, 17,032 stores, 13,401 delivery workers, 1,185 retries, 12,568 decisions, 1,518 scan workers, 2,089 nudged runs, 7,504 sessions resolved, and 11,465 shutdowns.

  Sixty-four mutants each fail on a comparison:
  - **the governance host:** a retry every second; a refusal as a 500; a store built each time or without its secret; no API service or delivery worker; delivery under another secret; a delivery failure unlogged, unbounded or without its code; the runtime's failure mode ignored; a policy failure unlogged, or without its code, action, scope or mode; a decision recorded without a database; delivery started without a database, during shutdown, twice, or before the database answers; delivery never retried, or its retry keeping the process alive; a service without a database or without its store; the retry left running at shutdown; delivery not drained;
  - **the exposure host:** scanning on a planned capability, by any deployment, or on an entry that only reads like a tuple; an experimental capability refused; a session without a database or without the pool; a worker without a database, during shutdown, whatever the document says, or a second one; the worker's store kept apart from the routes', or its cursor unkeyed; findings unfingerprinted; a scan without a session; a scan read by another profile or over unbounded sockets; a nudge that starts nothing, or whose failure goes unanswered; the routes' store without a database, refused as a 500, or built for each route; a scan not drained;
  - **the shutdown:** a second signal stopping again; shutdown never said to begin; jobs kept open; the stop unlogged; the streams not told why; the workers stopped after the server; the exit forced at once, or said to succeed; the force timer keeping the process alive or left set; the workers' work not waited for, or a worker's failure holding the exit; the pool left open, or closed before the workers finish; a clean stop said to fail.

  `test/governance-host.test.js`, `test/exposure-host.test.js` and `test/graceful-shutdown.test.js` catch all sixty-four too. The first two hand the hosts recording stand-ins through a module hook, as the oracle does.
  - **The first pass** let three past the oracle and crashed it on one. It had never read a malformed entry that is not a list, and its workers finished the moment they were stopped, so a shutdown that did not wait for them, or closed the pool first, looked the same; and a drain that failed before anyone awaited it stopped the oracle. The oracle now reads such an entry, holds each worker's work until the server has closed, and records an unanswered rejection.
  - **The tests** let one past at first: delivery started a second time asks the database again. The test now counts what it asks.
  - **The final judge** ran over the oracle as it now stands.

  One mutant first listed was equivalent and was dropped: **a nudge that runs at once.** The worker's run is asynchronous and never throws where it is called, so starting it one microtask sooner changes nothing a caller sees.
- **Tests.**
  - `test/governance-host.test.js` covers the runtime's decisions and failure log, the store, service and worker built once, delivery at boot and its retries, a delivery failure's log, and stopping. `test/exposure-host.test.js` covers the capability gate, the worker and what it is given, a nudge, the routes' store, a scan's session, and stopping. `test/graceful-shutdown.test.js` covers the order of a shutdown, a second signal, the workers waited for in turn whatever they do, the pool, the clean exit and the forced one.
  - The source checks follow the code:
    - `exposure-worker` reads the capability gate, the worker's conditions, the session resolver and the transport in the exposure host, and the drain in the platform's shutdown, waited for before the pool closes.
    - `governance-api-server-contract`, `governance-delivery-server-contract`, `governance-enforcement-server-contract` and `governance-enforcement-deployment-contract` read the store, the API service, the worker, its drain, the runtime and its failure log in the governance host, composed with the deployment's failure mode.
- **Ratchet:** `server.js` falls from 900 lines to 729.
- **Checks:**
  - typecheck, lint, syntax, secrets, docs, inventory and verify (which parses the new files);
  - the architecture oracles, route surface, module boundaries and contracts;
  - the full unit gate and every verify-job gate on Node 22.23.4.

### D13n — one reading of the server's composition root

- **What changed.** Forty files read or name `server.js`: thirty-six test programs, the route-policy oracle's two files, the server-entry helper and `scripts/verify.js`. Most read it as text, to see how the server wires the platform and the modules together. The composition root is about to become `apps/api/src/main.ts` and the composition it calls, so the source checks now read it through one helper, `test/helpers/server-source.js`:
  - `serverFiles()` names the root's files: `server.js` while it is the root; then `apps/api/src/main.ts` and `apps/api/src/composition/`, in that order.
  - `serverSource()` reads them as one text, so a check holds wherever in the root the wiring it reads lives.
  - `serverLoads()` and `serverImports()` read what the root loads from its module syntax, not its text. `const { a, b: c } = require('…')` and `import { a, b as c } from '…'` both take `a` and `b`, the names the module exports, whatever the root calls them. A type-only import loads nothing and is not counted.
- **The checks.**
  - Twenty-nine that read the text, `scripts/verify.js` among them, read `serverSource()`.
  - Five that parsed `server.js`'s `require` of a module's index now read `serverImports()`.
  - Five that looked for a `require('…')` string now ask `serverLoads()`.
  - The code and contract inventories, the provider route inventory, the security route sources and `scripts/verify.js`'s lists of required and parsed files take the root's files from `serverFiles()`.
  - The `OWN_WORK` check counts the routes of every root file.
  - The provider disconnect contract reads a route's file as it is.
- **Behaviour unchanged.** While `server.js` is the root, each helper reads exactly what the check read before. The files that name `server.js` rather than read it -- the route-policy oracle, the server-entry helper, the compiled-tree checks, the runtime and release-fingerprint tests and the module graph -- change with the root itself, in D13o.
- **Checks:** every converted test passes, with lint and verify; the full unit gate and every verify-job gate on Node 22.23.4.

### Reading a canvas without changing it

- **What failed.** The pull request's fifth browser shard on 0d998cf failed `turning the phone re-lays the graph and keeps it moving` on mobile Chromium. The effects canvas, read twice 400 ms apart once the graph had settled, gave the same pixels both times. The same commit passed the test in its push run and in the qualification.
- **What the trace showed.** The page was right. Its DOM snapshots have the effects layer visible, on its own, through both readings. Its screen capture has the signals moving along their strands every 40 ms between them, with nothing left behind where they had been. Chromium's warning about repeated readbacks was logged during the second reading.
- **Root cause.** Reading a page's canvas with `getImageData` changes it. On the second readback Chromium moves a GPU canvas to the CPU, rebuilding its backing from a snapshot inside that call. The readback made in that switch came back with the first one's pixels while the canvas went on drawing on screen. A local Chromium 141 switches the same way, and read correctly in all 18 runs of a bare animated page and all 20 runs of the unchanged test. CI's newer Chromium got it wrong once.
- **The fix.** `test/e2e/canvas-ink.js` reads a page's canvas through a copy. It draws the canvas into one of its own, made to be read often, and reads that, so the page's canvas stays on the GPU as the reader has it.
  - The rotation test reads the effects layer through it. It also checks the layer is visible before and after the wait, and that the loop drew during it: its last draw moved on. That keeps the 400 ms bound, and the pixels are polled until they move.
  - The field's light test read the field canvas twice the same way, and now reads it through the copy.
  - The landing showcase's effects check polled its canvas the same way, and does too.
- **Checks:** lint; the three specs on desktop and mobile Chromium; the rotation and field-light tests ten times each.

### D13o, step one — the seams the composition passes, typed

- **Why.** `server.js` is JavaScript, so nothing checked what it hands from one module to another. A draft of it in TypeScript, converted line for line, failed strict checking 230 times. Every failure was at a seam: a dependency one module declared for itself, given a function another module declared for itself. This step makes the modules agree, so the composition written next type-checks with no cast. The draft's own glue is left to that rewrite: the reads of what a guard attached, the alpha's stores that are off outside it, and three untyped files in `src/` (65 of the 230).
- **The request a guard reads.** A guard is a handler Express calls with its own request, and Express knows nothing of what the guards before it attached. Each guard's view of the request now lists those fields as optional. Where the code read one that an earlier guard on every such route attaches, it says so with `!`, which leaves the JavaScript as it was. A view naming nothing Express's request has is written `object & {…}`: the access, capability, mutation and governance contexts, the lifecycle, the actor label, the safety state and the upload scan.
- **What a route caught.** `sendFailure` and the envelope's error body take anything thrown, and read it as JavaScript reads a member of it.
- **The provider account and its transport.**
  - The REST client takes whatever account a route holds.
  - `assertGithubAccount` says in its type what it lets through.
  - The timed fetch takes the address and options a caller holds, often named by a provider's answer.
  - Uranus's transport is typed as answering with a status and a body, as the repository reader reads it.
- **The session.**
  - `sessionOf` answers only sessions it found holding a list of accounts, and its type now says so, through `holdsAccounts`.
  - A session is written to the response it sets a cookie on.
  - The seal tries to open whatever was stored or sent.
  - The lifecycle reads the opened cookie field by field.
  - Revoked session ids travel as the store read them, until the live hub compares them.
- **The rest.** Protected paths are matched whatever value names them. The App's configuration, when off, says only that. An account's capability context needs no feature. GitHub's authorizing user may lack a field. The workspace scope is a plain record. The upload scan takes the path and size its routes have. The exposure host's fingerprint key is the Buffer the settings derive. The probes' readiness loss is one of the lifecycle's own.
- **Behaviour unchanged.** These are types only, except where a typed read replaced a direct one: the envelope, the failure answer, the seal, the session's GitHub view, the lifecycle's cookie reads and the webhook's sealed secret.
  - The old and new envelope and failure answer were run side by side over 32 values a route can catch: primitives, a symbol, a bigint, a getter, an inherited field, a status written as text, a retry wait that is not a whole number. Body, status, headers and answer were identical every time.
  - So was `unseal` over 15 inputs, and the session's GitHub view over 10 sessions, down to which session object comes back.
- **The envelope contract is version 2.** Its error body takes what was thrown rather than a failure's facts, so its recorded shape changed; nothing reads the version at run time.
- **Tests.** Two source checks find `setSession` by its signature, and now name the response it writes to. The full unit gate found them.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D13o, step two — the composition root, and `server.js` removed

- **What changed.** The server starts from `apps/api/src/main.ts`, 65 lines of strict TypeScript, and `server.js` is gone. The entry point only puts the parts together, in an order that is itself policy:
  - **What the tree is,** then the proxies to trust, then the secrets and settings (`composition/configuration.ts`). The reads keep the server's order, so a deployment with more than one thing wrong is refused for the same one first.
  - **The services everything stands on** (`composition/core.ts`), in the order the server built them: the database, the stores, the session and its security, the safety controls and evidence chain, the live streams, the GitHub App, the shutdown, governance and the mutation gateway, GitHub's REST client, exposure scanning, recovery and the repository audit. Building one starts nothing. The two things only known later -- Parallax's job queues and the HTTP server -- reach the shutdown through `later`.
  - **Who may do what** (`composition/access.ts`): the alpha's sessions, the guards, repository access, the mutation contexts, governance's context, the account lifecycle and the evidence key. `composition/request-context.ts` reads what the guards attach to a request: the account, the viewer, a governed route's context and the alpha tester and session.
  - **The routes,** in the order the route policy records: the global pipeline and the public routes (`pipeline.ts`), the alpha's boundary and the signed-in person (`session-routes.ts`), working on a repository (`repository-routes.ts`), and what is kept about one, with the page's fallback last (`record-routes.ts`).
  - **Listening,** then governance's webhook delivery and exposure scanning; a signal stops all of it once.
- **Strict, without casts.** The composition type-checks under the API's strict configuration with no `as` and no `any`. A `!` stands only where `server.js` read a field a guard always attaches first. Five module types the composition passes were narrowed to what they are called with:
  - GitHub's REST client answers a raw request with the response itself;
  - the mutation gateway's event sink, and the GitHub App broker's audit, are functions;
  - exposure scanning reads the tester's repository scopes;
  - the lifecycle's REST options carry a method, and its forgotten jobs take an account.
- **The CommonJS modules left in `src/`.** Node hands an ES module a CommonJS module's exports as its default import. These modules freeze what they export, so a named import of one fails as the server starts. `composition/commonjs.ts` imports the three the server reads whole and names their exports once. The API's TypeScript configuration allows JavaScript imports without checking them or anything under `node_modules`; `jsconfig.json` checks the two it now reaches directly.
- **The route policy is the same policy.** The oracle reads registration functions in `composition/` as it reads them in `http/` and `routes/`, and takes the root as `apps/api/src/main.ts` where `server.js` is gone. Read from `server.js` and from `main.ts` and its composition, the policy is identical: 195 routes, and 208 settings, middlewares and routes in order.
- **What names the entry point follows it.** The package's `main`, `start` and syntax check; the browser tests' web server; the lint's CommonJS list; the compiled build's file set and its tree check; the server-entry and server-source helpers; the runtime and database-resilience tests; and every comment that described `server.js` as the present, eighteen files changing for that alone. The release-fingerprint fixture builds the compiled entry where it now is, and the smoke test asks for the new entry's source by path, which is a 404 like the old one.
- **The source checks follow the composition.**
  - The source helper names a loaded module by its path in the tree, resolving a relative import from the folder of the file that holds it. It reads the names an ES module takes from a CommonJS module it imports whole and destructures.
  - Eighteen tests and `scripts/verify.js` read `server.js`'s own names for what they check: `ALPHA_CONFIG`, `DB_URL`, `const fail = sendFailure;`, a guard's attached field read inline. Each now reads the same wiring in the composition: the setting it is handed, the service it is built with, the one failure answer every route is handed and nothing else under its name. None was dropped or loosened. The OWN_WORK count now takes one import per file that hands it to a module.
  - The alpha boundary test boots the server with its stores, credential resolution, migrations, pool and webhook worker replaced. It replaced them through `Module._load`, which an ES module's imports never pass. It now registers module hooks in the server's process: the composition is handed a module that re-exports the real one with the fixture's exports in their place. Each seam records that it was reached, and the test fails if one was not. The webhook worker's seam is reached where governance's host starts the worker. It had matched the server's own import of Kepler's index, which the host stopped reading in D13m, so since then the worker had run against the fixture's pool. It is held still again.
- **The code that ships, read whole.** The coverage test's check for stray control bytes read `server.js`, the modules left in `src/` and the public files. The server's code had left its view, module by module, as Phase D moved it into `apps/api/src`. It now reads the server's code, the shared contracts and the page's sources as well: 302 more files, none carrying a stray byte.
- **The ratchets.** The composition root registers no route itself; `main.ts` may hold 150 lines; `server.js` may not come back; and every registration function a module's `http` folder exports is called by the composition.
- **Removed:** `server.js`. The proof is the identical route policy, the server booting natively from `main.ts` and compiled from `dist/server/apps/api/src/main.js`, and every gate below. The baseline inventories keep their baseline paths.
- **Checks:** typecheck, lint, the route-policy comparison, the unit gate and every verify-job gate on Node 22.23.4, the compiled server's among them.

### The doctor gives the server's answer

- **What was wrong.** `scripts/doctor.js` is the check an operator runs before a deploy, and the deploy guide and operator checklist both say a pass is the answer the server will give at startup. It was not:
  - Its production rules were a copy of the server's. The comment beside them named a test that pinned the two together; that test never existed.
  - The registry called the snapshot signing key optional until half of it was set, so the doctor passed a production deployment without one. The server refuses to start without it, as the README and the security deployment guide say. The doctor's own test called that deployment clean.
  - It never asked about the deployment profile, the migration mode, a hosted alpha's limits, the snapshot keys or the qualification capabilities. The server refuses on each.
- **The server's reading, asked.** The doctor calls the configuration reading the server makes as it starts (`composition/configuration.ts`): `loadCapabilities`, now a function of its own within the release, then `loadSettings`.
  - Each stops at its first refusal, as the server does.
  - A refusal that a loader the doctor already ran has reported is not repeated; any other is reported as the server refusing to start.
  - A precise problem covers every variable it names, so the generic "is required" line beside it goes.
- **Production spelt exactly.** The server compares `NODE_ENV` exactly wherever it reads it. A value that was production in all but its case or spacing started a development server: the development secret accepted, cookies without `Secure`, the database's TLS left to its URL. The server now refuses it before anything else is read. The doctor lists what production will need beside that refusal.
- **Refusals that name their variable.** The snapshot signing refusals spoke of a key ID and a secret, not of the variables that hold them. They now name `NV_SNAPSHOT_SIGNING_KEY_ID` and `NV_SNAPSHOT_SIGNING_SECRET`.
- **The registry.**
  - The snapshot signing key and secret are required in production, with their development fallbacks stated. The secret's format gives its size and says it is not `SESSION_SECRET`.
  - `NODE_ENV`'s format says it is compared exactly.
  - The doctor's snapshot group rule went with the requirement it served: outside production the pair is the server's loader to refuse.
- **Tests.**
  - `test/doctor-startup-agreement.test.js` starts the real server under 26 deployments. Each is one change from a deployment that starts. The doctor is held to what happened: where the server refused, the doctor names the variable the server named; where it started, the doctor does not say it refuses. Every threshold is walked on both sides of its edge, in bytes.
  - The doctor's production fixtures carry a signing key, and a keyring the server cannot read is refused without being quoted.
  - The settings test refuses five near misses of production, and reads every other value as development, as before.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D14, step one — the composed server, asked

- **Why.** D14 replaces the tests that check the server by reading its source. Ninety assertions read the composition's text, in nineteen tests and `scripts/verify.js`, and more read the modules'. A text check passes on a line that never runs, fails on a rename that changes nothing, and says nothing of what the server does with what it was handed.
- **One function puts the application together.** `composition/application.ts`'s `registerApplication(app, root, listening)` builds what `main.ts` built: the configuration, the services, who may do what and every route, in the route policy's order. It returns the parts. `main.ts`, 33 lines, listens with it and starts the work beside requests. The route policy read through it is unchanged: 195 routes, 208 entries in order.
- **The harness.** `test/helpers/composed-application.js` builds that application in a test's own process, from an environment of its own, listening on a port the system picks. Building it starts nothing and leaves no handle open. With `NV_SERVER_RUNTIME=compiled` it builds the compiled tree's application, and the compiled-runtime run picks up every test that uses it.
- **Twenty-three assertions, now behaviour.** `test/composition.test.js` names, for each check, the text it replaced:
  - **The live streams' caps** (three): readers are admitted per repository and in total as the environment sets them.
  - **The font proxy's absence** (three): its former routes reach no third party and serve neither a stylesheet nor a font. `verify.js`'s check for Google's font hosts now reads the server's whole tree, not the composition alone.
  - **What the page is told and served** (three): the four upload ceilings published are the server's own limits; a pinned library is the release's copy, byte for byte; readiness says a database is not configured rather than down.
  - **The webhook intake** (three): its route answers, 120 deliveries a minute reach it, and the next is refused.
  - **GitHub writes and reads** (four): a write with no mutation in progress is refused before anything leaves the server; a read and the resolver's permission question carry the account's own credential.
  - **The GitHub App** (three): off, the page is told so and an App account cannot be used; on, the broker mints the account's credential, proves itself with the configured App's key, and the mint is audited through the App records.
  - **Governance's runtime** (four): in warn mode a mutation whose policy cannot be evaluated runs under a warning; in block mode it is refused before it runs. The log names the mode, and the gateway's events record the decision.
- **Each check fails when its wiring is broken.** Seventeen mutants of the composition, each caught: a cap read from the wrong setting, a re-added font proxy, the wrong vendor root, a limiter that allows everything, the wrong published boundary or ceiling, readiness told a database is configured, a REST client without the gateway, a resolver that never asks GitHub, the App's configuration unpublished, no broker, resolution around it, its audit dropped, no policy evaluator, a fixed failure mode and a silent event sink.
- **What stays.** The module-text halves of these checks stay until their own conversion. The other 67 composition-text assertions come next: those that need a signed-in session, then those that need a database.
- **Checks:** typecheck, lint, the route-policy comparison, the unit gate and every verify-job gate on Node 22.23.4, the composition test against both runtimes.

### D14, step two — a signed-in session, and an upload, asked

- **Why.** Step one asked the composed server what needs no session. The checks here need one: the session's guards and mutation context, the GitHub App's state, what an account can do, and the upload routes.
- **The harness, as a page.** `browser(application)` signs in the way the page does and carries its cookie, app header and origin. It sends a file's bytes the way the page does, and `declare()` sends a request's headers alone, so a ceiling can be asked about before any body is read. `standInForOutbound(routes)` is whatever lies past this machine: GitHub, a font host, a CDN. Each route answers what the test says, anything else is answered 404, and every request that leaves the application is recorded. Step one's four hand-written stand-ins now use it. A body that is not JSON is read as its first words, so a failed check says what was answered.
- **Ten assertions, now behaviour.** `test/composition.test.js` names, for each check, the text it replaced:
  - **A signed-in write** (six): the security-foundation contract's two (the guards; auth's CSRF and step-up), `verify.js`'s two (the security and containment routes; the session's security), and the mutation context in the authorization-resolver and mutation-gateway contracts.
    - A write without the session's CSRF token, or with another session's, is refused before GitHub is asked anything.
    - With it, the account's permission is resolved with its own credential and the write is put to policy. Only then does GitHub see it.
    - A sensitive action needs a step-up grant, earned by proving the credential again and spent the first time it is used.
  - **The GitHub App's state** (one): a state signed with any other key is refused; the server's own passes, once.
  - **What an account can do** (one): an installation's account cannot read notifications, and can do everything else a token can.
  - **Uploads** (two): the hardening contract's scan wiring and the upload-transport contract's four ceilings.
    - A file carrying a malware signature is refused by both upload routes with `MALWARE_DETECTED`, before GitHub is asked anything.
    - The four ceilings are set apart from each other and asked from both sides. A declared length one byte over a route's ceiling is refused before it is read; a body exactly at it is taken.
    - The transport shows in what GitHub is asked first: the Git Data API up to its 40 MB, a native push up to the push ceiling, Git LFS above it.
- **Each check fails when its wiring is broken.** Twenty-one mutants of the composition, each caught by its check's own message:
  - CSRF unverified; a step-up grant never spent, or signed with the CSRF key.
  - The security or containment routes unregistered.
  - The mutation context resolving nothing, or going around the gateway.
  - The App's state accepted unverified, or verified with another key.
  - Every account given a token's capabilities.
  - The scanner or the upload scan bypassed.
  - Each of the four ceilings read from another setting (nine).
- **Step one's checks, on the shared stand-in.** Its outbound mutants were run again: a font proxy put back, the vendor copies missing, a REST client without the gateway, no App broker, and its audit dropped are each caught.
- **A module-text half goes with them.** The hardening contract read the workbench's upload scan for `MALWARE_DETECTED`; the composed routes now answer it.
- **What stays.** Fifty-seven composition-text assertions remain. They need a database (sessions, the evidence chain, alpha mode, exposure, governance's context, restore authorization) and come next, against PostgreSQL.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4, the composition test against both runtimes (4.5 s).

### A protected folder written with its slash

- **Found by D14's database checks.** A push beneath a protected `.github/workflows/` scored no `PROTECTED_PATH_CHANGED`. The matcher (`platform/values/path-patterns.ts`) treats a plain pattern as a prefix followed by `/`, so `docs/` covered only paths beginning `docs//`, and no file does.
- **What it cost.** Safeguards take "a file, folder or wildcard pattern", and `docs/` is the natural way to write a folder. Written that way, a protection covered nothing:
  - The write guard (`corona/domain/safety-guard.ts`) let writes beneath it through.
  - A pushed change beneath it went unscored.
  - The page, whose matcher mirrors the server's, showed nothing beneath it as protected. The page and the server agreed, so nothing looked wrong.
- **The fix.** A pattern ending in `/` names a folder. `docs/` covers what `docs` does, and `src/*/` what `src/*/**` does. The server's `pathMatches` and the page's `protectedPatternMatch` both read it so; the page also collapses doubled slashes, as the server always did. Stored protections are unchanged, and those written with a slash now take effect as written.
- **One table, both readers.** `test/protected-path-patterns.test.js` puts twenty-nine cases to the server's matcher and the page's, and checks that the write guard refuses what a folder protection covers, written either way. The matcher's cases in `test/intelligence.test.js` moved there.
- **Each part is needed.** Seven mutants, each caught: either matcher reading the slash literally, either not widening a wildcard folder, the page not collapsing doubled slashes in the pattern or in the path, and a guard that ignores protections.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D14, step three — the composed server, on its database

- **Why.** Steps one and two asked the composed server what needs no database. These checks need the store a deployment names: where a session lives, the sessions an identity holds, the protections it sets, what a webhook delivery leaves behind, and the snapshots, evidence and restores Corona keeps.
- **The harness.** `test/helpers/disposable-database.js` creates a database of the test's own on the PostgreSQL service `NV_TEST_DATABASE_URL` names, and drops it afterwards, whatever still holds it. The composed application's `close()` now ends what the server's own shutdown ends, in its order: the job queues, the workers' work, the server, then the pool. `bodyOf()` moved into the harness, shared by both tests.
- **Fifteen assertions, now behaviour.** `test/composition-postgres.test.js` runs in the verify job (`npm run test:composition-postgres`) and in the compiled-runtime job. It names, for each check, the text it replaced:
  - **The store** (`verify.js`, two): `DATABASE_URL` is the store opened, every numbered migration is applied once by the runner, and readiness reports the last one.
  - **Sessions** (the hardening contract, two): the cookie carries the session's key alone, and the session is stored under the identity that holds it. A cookie carrying a whole session, as a server without a database writes one, is no session. With the store configured but down, a session is refused rather than written to the cookie.
    - An identity's two sessions are listed to each other, and another person's is not. Ending the others with a step-up grant signs the second out and leaves the rest signed in.
  - **Protections** (`verify.js`, one): a folder protected from one session holds in another session of the identity, which is refused a write beneath it.
  - **A webhook delivery** (the hardening contract two, `verify.js` one): live events are connected through their route, which gives GitHub the delivery address and its secret. A delivery signed with that secret is accepted, stored for the identity, and scored against the folder it protects. It is chained into the identity's evidence under the stored event's id and sent to the identity's open stream.
  - **Snapshots and evidence** (the hardening contract one, `verify.js` one): six signed snapshots, with `NV_SNAPSHOT_RETENTION_COUNT` at five, keep the latest five. The evidence export verifies the chain and records the connection, the delivery and all six snapshots; evidence is kept when a snapshot is not.
  - **A restore** (the mutation-coverage contract one, `verify.js` two): a snapshot is compared with what GitHub holds, a branch deleted since. While a folder is protected, the preview grants nothing and a restore is refused. Unprotected, the preview grants the branch's recreation, the restore is bound to it and recreates the branch, and the same grant is refused the second time.
  - **The access surface** (`verify.js`, one): a repository's collaborators, deploy keys and webhooks are read for the signed-in identity, and a deploy key that can write is named as a risk.
  - **Uploads** (`verify.js`, one): its check of the scan wiring was step two's upload section's to replace, and goes now.
- **Each check fails when its wiring is broken.** Eighteen mutants of the composition, each caught by its check's own message:
  - The sessions, or the whole configuration, told there is no database.
  - The store opened on no URL or on another database; the migrations never run.
  - The session inventory unavailable, or a revocation that does nothing.
  - The identity's safety not loaded.
  - A delivery not chained, not streamed, keyed to no identity, or not scored against its protections.
  - Snapshots kept to the default count.
  - A restore grant not inspected.
  - The live-event, evidence, access-surface or snapshot routes not registered.
- **Module-text halves go with them.** The behaviour above now proves:
  - the account lifecycle's inventory query by identity;
  - the intake's evidence append under the stored event;
  - the live-event, evidence, access-surface, comparison and preview routes, with the access surface's risk;
  - the migrations that create the evidence chain and the safety state;
  - and the upload scan's `MALWARE_DETECTED`.
- **What stays, counted again.** A parser census of the tests counts every statement that reads the composition's source or its imports. It finds 118 such statements before D14, not ninety: the first count matched the text bound as `server`, and missed files that bind it under another name or read the composition's imports. By statement, steps one to three converted 22, 10 and 15. Seventy-one remain: alpha mode, the GitHub App's records, exposure scanning, governance's context and the workers' drain, the mutation gateway's transports and paths, the public-error sweep, the key purposes, and the checks that read the composition's imports. The next step commits the census as a test that holds the count down.
- **Gated like the other database suites.** The package contract's list of externally gated scripts names `test:composition-postgres`, so CI must keep running it.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4, including the new one; the database test against both runtimes (3.5 s).

### A disconnect that removes what it should

- **Found by D14's invite-only checks.** A tester who connected live events and then disconnected GitHub was answered 202, pending. The webhook stayed on GitHub, and the tester stayed signed in.
- **Why.** The central disconnect (`identity-access/application/account-lifecycle.ts`) removes the webhooks an account registered, then ends its provider session. It made each removal with the REST client outside any mutation. The mutation gateway refuses every provider write made outside a mutation (`MUTATION_GATEWAY_REQUIRED`), so no removal reached GitHub, and the readback found the hook still there. The production baseline (`3bf017a`) does the same, so this is not a regression.
- **The fix.** The platform's mutation context gains `runProviderMutation(req, target, work)`: a provider change a request makes for an account on a repository other than a route's own. It resolves the account's authorization on that repository, describes the change as a route's is (under the route that made it, with the alpha's label for the principal), and runs it inside the gateway. The disconnect removes each webhook through it, as that repository's `webhook.disconnect`, the action the per-repository live-events disconnect already runs as. A removal the gateway or GitHub refuses still leaves the cleanup pending, as before.
- **And one more.** The privacy store's cleanup check handed one transaction client five queries at once. pg 8.22 queues them with a deprecation warning, and pg 9 refuses them. They now run one after another, and both database composition tests fail on the warning if anything overlaps again. A traced run of every database suite found no other source.
- **Proven on the composed server.** `test/composition-alpha.test.js` builds it invite-only on a database of its own; `npm run test:composition-postgres` runs it beside `test/composition-postgres.test.js`. A tester redeems an invitation, signs in, connects live events, and disconnects:
  - the webhook is deleted on GitHub and read back gone, and the server's record of it goes;
  - the removal was put to policy as `webhook.disconnect` for that repository;
  - the provider session ends, and the access session stays.
  - The unit tests hold the runner, in `test/mutation-context.test.js`, and the lifecycle's use of it, in `test/account-lifecycle.test.js`.
  - The test browser (`test/helpers/composed-application.js`) now keeps every cookie the server sets, as a browser does, the invitation's access session beside the provider session's, and clears one set empty or to expire.
- **Each part is needed.** Four mutants, each caught: the removal made outside the gateway again, the runner not handed to the lifecycle, the removal run under another action, and the store's queries handed over at once.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D14, step four — the composed server, invite-only

- **Why.** The hosted alpha runs the server with invitations on. A tester redeems an invitation for an access session, signs in to GitHub in it, and owns the provider session; what is kept names the tester by label. These checks need that server, and its database.
- **Twenty-one statements, now behaviour or the syntax tree.** `test/composition-alpha.test.js`, begun with the disconnect fix, builds the composed server invite-only on a database of its own:
  - **Retention** (the privacy CLI test, two): once the store is ready, the alpha's retention runs, over its own store.
  - **Admission and the owned session** (the privacy server contract one, the disconnect contract three):
    - without an invitation nothing is answered;
    - redeemed, it admits the tester to the repositories it names;
    - the tester signs in, and the provider session is the tester's own, bound to the identity;
    - a repository the invitation does not name is refused.
  - **The privacy routes** (the privacy server contract, one): the notice is the alpha's terms and retention, and feedback is kept for this release.
  - **The central disconnect, from every route** (the privacy server contract two, the disconnect contract two): signing out, removing the account, disconnecting GitHub and deleting the alpha's data each remove the tester's webhook inside the gateway, end the provider session and clear its cookie.
  - **What the alpha keeps** (the disconnect contract, three):
    - the write's policy decision is recorded under the tester's label;
    - a blocked upload's evidence names the label, as matching its hash shows;
    - no column of any table holds a GitHub login.
  - **The composition's imports** (the privacy server contract two, the disconnect contract three): `test/module-boundaries.test.js` already holds every module to its index, and the behaviour above runs each name these checks looked for.
  - **What no request can show** (the disconnect contract, two): `test/composition-root.test.js` holds the composition root, over its syntax tree, to calling no account disconnect and naming no provider host or Git, LFS or REST path. A comment that mentions either passes; a call or a string fails.
- **Each check fails when its wiring is broken.** Thirteen mutants of the composition, each caught by its check's own message:
  - retention never started, or started without the store;
  - the lifecycle without the privacy store;
  - feedback kept for another release;
  - the disconnect routes or the account routes without the central disconnect, or a disconnect that never clears the cookie;
  - the access routes unregistered;
  - the guards or the mutation context told this is not the alpha;
  - the upload's evidence naming the login;
  - and, for the syntax rules, an LFS negotiation or a disconnect call put into the root.
- **The test browser answers redirects.** It no longer follows one. A test reads the server's redirect, and nothing past it is reached: a probe of the GitHub App's flow had followed one to github.com.
- **The census, as a test.** `test/composition-reads.test.js` counts, over the syntax tree, every statement in the tests and scripts that reads the composition's source or imports, and holds the count to its record exactly. A new read fails, and so does a converted one until the record is lowered. Run against earlier commits, it gives 118 before D14 and 86 after step two. Fifty remain: the GitHub App's records, exposure scanning, governance's context and the workers' drain, the mutation gateway's transports and paths, the public-error sweep, the key purposes, the offline cache, and the checks that read the imports.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4, the invite-only test against both runtimes (3.6 s).

### A GitHub App connection that completes

- **Found by D14's App checks.** On the composed server with a database and without invitations, the App's setup answered `GITHUB_APP_ACCOUNT_INVALID`. The account was in the stored session; the installation's record and its connection audit were not.
- **Why.** `setSession` (`identity-access/application/provider-sessions.ts`) keeps a session one of three ways. Invite-only and cookie-only, it leaves the request holding the session it wrote. With a database and no invitations, it saved the row and left the request as first read. The setup adds the installation's account, then finds it in the request's session to record it, and found nothing. The production baseline (`3bf017a`) does the same. The hosted alpha runs invite-only with no App configured, so it was not affected.
- **The fix.** The database path leaves the request holding the session as stored, as the other two do.
- **Proven.** `test/provider-sessions.test.js` holds the request to the session as stored, after a first write and after a rewrite. `test/composition-postgres.test.js` connects the App on the composed server: the person's grant is exchanged, the setup completes, and the installation and its `installation.connected` audit are recorded. Without the fix each fails.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D14, step five — the GitHub App, asked

- **Why.** The composition gives the GitHub App's records, its connection view, the account lifecycle and GitHub's REST client the broker and the alpha's flag. Eight statements read that wiring as text. The composed server can be asked instead.
- **Outside the alpha** (`test/composition-postgres.test.js`; the App contract four, the disconnect contract one). A person connects the App on the composed server with a database:
  - the stored App account carries no token;
  - the broker mints the installation's token once and keeps it, and disconnecting the account drops it, so its next use mints again;
  - the installation is recorded and its connection audited, and no App audit keeps the installation account's login;
  - nothing the server answers in the App's flow, headers included, holds the App's client secret, webhook secret or private key, the person's user token or the installation token.
- **Invite-only** (`test/composition-alpha.test.js`; the disconnect contract three). A tester connects the App:
  - the connection is shown by its stable key alone, with no installation number and no login, and the account by the tester's label;
  - nothing is copied into the legacy installations table;
  - the connection's audit names the tester by label, and no login;
  - the owned App account carries no token;
  - a token GitHub refuses stays in the broker the testers share, rather than being dropped for all of them.
- **Each check fails when its wiring is broken.** Twelve mutants, each caught by its check's own message:
  - the account lifecycle without the broker;
  - the App records, or the connection view, told the wrong mode, either way;
  - the REST client told this is not the alpha;
  - the installation never recorded, or its connection never audited;
  - an App account that keeps a token;
  - an audit that keeps the login, or loses the tester's label;
  - the person's user token put into the redirect to GitHub.

  One candidate is not a fault: a setup audit that supplies no actor still names the tester, because invite-only the App records take the label from the identity.
- **Found on the way.** Connecting the App on a database without invitations always failed. It is fixed in its own commit, *A GitHub App connection that completes*, above.
- **Forty-two remain:** exposure scanning (8), governance's API (8), its delivery and interface (3), the authorization resolver (4), the mutation gateway (3), the public-error sweep (3), the key purposes (3), the security foundation (3), the capability registry and probes (3), safe passage, protected paths, the offline cache and `scripts/verify.js`'s version check.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### A governance webhook to a name that does not resolve

- **Found by D14's lifecycle checks.** On the composed server, adding a governance webhook to `https://receiver.invalid/events` answered `500 GOVERNANCE_OPERATION_FAILED` and logged `ENOTFOUND` as the service failing.
- **Why.** Kepler's governance service (`kepler/application/governance-api.ts`) looks the destination's name up before keeping or changing a webhook. `normalizeWebhookDestination` refuses a lookup that finds nothing as `422 GOVERNANCE_WEBHOOK_DNS_INVALID`. A lookup that throws, as an unresolvable name does, escaped as an error nobody named, and the route answers those as the service failing. The production baseline (`src/governance-api.js`) does the same.
- **The fix.** A failed lookup counts as one that found nothing, for adding and changing alike. The delivery worker already records a failed lookup as a failed attempt.
- **Proven.** `test/governance-delivery-api.test.js` refuses both with `422 GOVERNANCE_WEBHOOK_DNS_INVALID`, before the store is asked. `test/composition-postgres.test.js` asks the composed server: refused, and nothing kept. Without the fix each fails.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D14, step six — the server's own life, asked

- **Why.** `apps/api/src/main.ts` listens with the composed application, then starts what runs beside requests: the upkeep of stale upload files, governance's webhook delivery and exposure scanning's worker. It stops once, on SIGTERM or SIGINT. The composition hands the platform's graceful shutdown the workers to wait for before the pool closes. Six statements read that wiring as text. `test/composition-lifecycle.test.js` asks the server itself, on a database of its own.
- **The work the server takes up** (exposure scanning's test three, governance delivery's contract one). The real server, started as a deployment starts it, on a database holding work from before the start, with no request made of it:
  - its upkeep removes an upload's temporary file older than the stale-upload age, and leaves a recent one and a file that is not an upload's;
  - governance's delivery attempts the delivery it had queued, and, the destination not found, keeps it for another try;
  - exposure scanning's worker runs, at its first look, the scan it had queued, and stops it as asked under another configuration.

  Stopped by SIGTERM, and started again and stopped by SIGINT, it says why and exits cleanly.
- **The work the server waits for** (exposure scanning's test one, governance delivery's contract one). The composed server, stopped as a signal stops it, with the process's exit stood in for:
  - with a delivery batch held at its table, it does not exit; let go, the batch records its attempt, then the pool closes and the exit is clean;
  - with a scan held where it reads its requester's session, likewise: the scan is stopped as revoked before the pool closes.
- **Nothing leaves the machine.** The webhook's destination is a name under `.invalid`, which never resolves (RFC 6761). It is stood in for (`standInForNames`, beside `standInForOutbound`) only while the webhook is kept, and a delivery's lookup fails, as it would. Each scan stops before it reads a repository.
- **Each check fails when its wiring is broken.** Eleven mutants, each caught by its check's own message:
  - main.ts without the upload upkeep, governance's delivery or the exposure worker at start;
  - main.ts deaf to SIGTERM or SIGINT;
  - the shutdown not draining delivery, or not draining scans;
  - the exposure host without the release's capability document;
  - governance told there is no database;
  - the shutdown never closing the pool, or never exiting.
- **A test that proved less than it said.** The first version prepared its work in more than one application. Governance starts its delivery worker on first need, and an application that only queued a scan started one. That worker, not the server under test, made the attempt the check looked for, and the mutant that stops main.ts starting delivery survived. All the work is now left in one application, and its worker is started and stopped before anything is queued, so the mutant is caught.
- **Found on the way.** Adding a governance webhook whose destination does not resolve answered 500. It is fixed in its own commit, *A governance webhook to a name that does not resolve*, above.
- **Thirty-six remain:** exposure scanning's route keys (4), governance's API (8) and interface (1), the authorization resolver (4), the mutation gateway (3), the public-error sweep (3), the key purposes (3), the security foundation (3), the capability registry and probes (3), safe passage, protected paths, the offline cache and `scripts/verify.js`'s version check.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4; the lifecycle test in 40 s.

### D14, step seven — the composed server's guards, asked

- **Why.** Seven statements read how the composition hands out the guards that decide who may write and who may read: the gateway's check to the transports that write to GitHub outside its REST client, Kepler's own-work allowance to the modules whose routes take it, and the resolver and gateway themselves.
- **The transports write only inside a mutation** (the gateway contract, three). The native push and the LFS upload each ask the gateway before they write. `test/composition.test.js` takes both as the server composed them -- the application now names them, as `work.transports` -- and calls each outside any request: each is refused, `MUTATION_GATEWAY_REQUIRED`, before GitHub is asked anything. That the server loads the gateway at all was already asked of it: its writes are checked.
- **A public reader is let into their own work, and nowhere else** (the resolver contract, four). `test/composition-postgres.test.js` signs in a person who reads a public repository and is no collaborator on it:
  - their own exposure scans and audit history of it are answered;
  - its governance is refused, `GOVERNANCE_COLLABORATORS_ONLY`;
  - a request whose body claims governance roles, repository access and another identity is refused as the reader GitHub says the person is, `GOVERNANCE_ROLE_REQUIRED`, and nothing is kept.

  That the server loads the resolver at all was already asked of it: its writes resolve the account's access first.
- **Each check fails when its wiring is broken.** Five mutants: the gateway's check replaced by one that passes everything, for both transports, for the LFS upload alone and for the native push alone; and the own-work allowance replaced by an empty one, for exposure scanning and for audit history.
- **The census's reach.** It counts the statements that read the composition's wiring. Four tests read the composition's files among every other source file -- the error codes, the contracts, the provider-route inventory and the route surface -- for what each file says, not how the server is wired. They are weighed with the tests that read the modules, next.
- **Twenty-nine remain:** exposure scanning's route keys (4), governance's API (8) and interface (1), the public-error sweep (3), the key purposes (3), the security foundation (3), the capability registry and probes (3), safe passage, protected paths, the offline cache and `scripts/verify.js`'s version check.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D14, step eight — a repository's governance, asked

- **Why.** Nine statements read how the composition wires governance: Kepler's index, the host over the durable store, the governance and lifecycle routes, the one guard and the context it attaches, what a request's body may not claim, and Corona's read-only exemption.
- **`test/composition-governance.test.js`** builds the composed server on a database of its own and asks it as three people: the repository's administrator, a maintainer and a reader, as GitHub says.
  - **Governance is the server's, behind one guard** (the API contract five, the interface contract one). The administrator creates a policy, drafts it and submits a version; all three read it. The Digital Twin shows each person exactly what GitHub's answer lets them do: everything for the administrator; reading, authoring and reviewing for the maintainer; reading for the reader. Archived, the policy is listed as such.
  - **A body's claims are not taken** (the API contract two). The reader's request to create a policy, claiming the administrator's roles and identity, is refused as the reader's, `GOVERNANCE_ROLE_REQUIRED`, at the governance guard: no policy decision is recorded for it, and no policy kept. The maintainer's review claimed in the administrator's name is refused, `GOVERNANCE_REVIEWER_IDENTITY_FORBIDDEN`; asked in their own name, the review is theirs.
  - **Read-only mode lets governance's control plane through, and nothing else of it** (the API contract one). With read-only mode on, validating a policy is let through; adding a governance webhook is refused, 423, like any other write.
- **Each check fails when its wiring is broken.** Six mutants: the governance routes or the lifecycle routes unregistered; the routes reading a context whose roles are not GitHub's; the guard letting every role through; governance's host never ready; and a blanket read-only exemption for every route under `/governance`.
- **A guard that the service backs.** Every governance operation is authorized again by the service, so a guard that let every role through still answered the reader's write with the same 403, and the first version of the check let that mutant through. What the guard adds is that it refuses before the mutation gateway is entered, so a refused write leaves no policy decision, and no governance event, behind. The check now holds the server to that.
- **Twenty remain:** exposure scanning's route keys (4), the public-error sweep (3), the key purposes (3), the security foundation (3), the capability registry and probes (3), safe passage, protected paths, the offline cache and `scripts/verify.js`'s version check.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D14, step nine — the last reads: exposure, failures, keys and the release, asked

- **Why.** Twenty statements still read how the composition is wired: the four keys exposure scanning's routes are handed, the central failure answer, the key purposes, session security's store, the capability registry and its probes, safe passage, protected paths, the offline cache and the version `scripts/verify.js` checked. None is read now.
- **Exposure scanning, end to end** (exposure scanning's route keys, four; the key purposes, three). `test/composition-exposure.test.js` builds the composed server on a database of its own, stands in for GitHub and for the credential's provider at the guarded transport -- nothing leaves the machine -- and asks it:
  - a scan asked for is run by the worker the server started; the credential it finds is kept as a keyed fingerprint, the very one made here again from the session secret and the fingerprint's purpose, and never as the credential;
  - confirmed by someone with the right to, the finding's credential is verified with its provider, and the subject the provider names is kept as a digest made with the subject's own key;
  - what the public can read of a Supabase project is asked with its anonymous key alone, for the project the finding names;
  - nothing the server answered or kept holds the token or the key.
- **A failure is answered one way, whichever module's route fails** (the public-error sweep, three). GitHub fails under three routes registered in three places -- the repository list, the workbench's CODEOWNERS and the platform's rate -- and each failure is answered with the central public error body, its keys exactly: what failed, a code, the request's correlation id, whether the provider changed, the safe state and the next action. GitHub's words pass through only when they carry nothing that looks like a credential; these do, and are not repeated.
- **The release and the capabilities are the package's and the registry's** (the capability registry and probes, three; `scripts/verify.js`'s version). A signed-in account is told the release `package.json` names, and the capabilities the registry document gives GitHub, as the registry projects them for this deployment.
- **A production snapshot secret that is the session secret is refused** (the key purposes). The refusal compares the two, so it must be handed the secret itself, not a key derived from it: a production deployment composed with its snapshot secret set to its session secret is refused.
- **An answer is bound to the offline cache only where it was asked for** (the offline cache). Every API answer is no-store, unless the service worker asks to keep it under the account's offline scope, for this repository; then the answer names the same scope and repository. Asked under another scope, it is not bound.
- **A step-up grant is spent once, on whichever instance it is spent** (the security foundation). Two servers share the database, as a deployment's instances do. A grant is spent on the first and held there, with the session's row locked, after the grant is claimed and before the session is written; the second, which still reads the grant as pending, refuses it at once as a replay. Only the shared single-use store can know it is spent: told there is no database, session security keeps a store of its own, and the second instance spends the grant again. The first version of this check let that mutant through, because the session's own row prevented the replay once the first had finished; holding the first open is what makes the shared store the only thing that can refuse.
- **Two rules over the root's syntax** (`test/composition-root.test.js`; safe passage, protected paths and the security foundation's remaining reads). The root makes no keyed construction of its own -- no hash, HMAC, cipher, signature or key derivation is called in it; every key is the settings', derived for its purpose. And every failure answer it hands a route is the central `sendFailure`, and every public error body the central `publicErrorBody`, by name.
- **Each check fails when its wiring is broken.** Twenty mutants:
  - exposure (nine): the routes fingerprinting or digesting the subject with another purpose's key; no verification or readability grant key; the routes unregistered; a reader that finds no file; a verifier without the subject key; the worker fingerprinting with another key; the prober asking another project;
  - the server (six): no offline binding; a release from elsewhere; capabilities from another table; the snapshot refusal handed a derived key; a module answering failures its own way; session security told there is no database;
  - the root's rules (five): a keyed HMAC and a keyed hash called in the root; a failure answer wrapped, and one handed over by shorthand; a public error body of the root's own.
- **The census at zero.** `test/helpers/server-source.js` now offers the root's file list alone, for the checks that scan every source file for what it says. `test/composition-reads.test.js` holds the reads at none and the helper to that one export, so a reader of the wiring cannot come back. Dead bindings to the helper are gone from five more tests. Before D14, 118 statements read how the server is wired.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### Without a database, what is kept offline stays kept

- **Found by D14's step nine.** Moving the offline cache's check onto the composed server showed that, without a database, an answer was never bound for the browser to keep: the scope the account was told stopped matching after its first request. The check was moved onto the database, where it held, and this was kept for its own commit.
- **Why.** `identity-access/application/session-security.ts` named a session by its id, or, where the cookie named none, by the cookie's own digest. Without a database the session lives in its cookie, which `setSession` seals afresh on every write. The guards give a session its nonce on its first signed-in request, which writes it, so the cookie that request was answered with was not the one the scope was made from. Any later write -- a step-up grant, an account switched -- changed it again.
- **The fix.** A session its cookie alone keeps is named by its security nonce, which lasts exactly as long as the session does; a session with neither an id nor a well-formed nonce has no scope. The scope is read without making the session's security state, so asking for it writes nothing. Sessions in the database are still named by their id, so a deployment with a database is unchanged. The binding, an HMAC under the offline cache's own key, shows nothing of the nonce. `readCookie` is no longer handed to session security, and the digest is gone with it.
- **Proven.** `test/session-security.test.js`: a session in the database by its id, even where it also has a nonce; one in its cookie by its nonce, whichever sealed cookie carries it; another nonce, another scope; no id and no nonce, or a malformed nonce, no scope, and the session left as it was. `test/composition.test.js`, on the composed server without a database: the scope the account is told binds the worker's request after the first answer and after a step-up grant, each of which reseals the cookie, and the account is told the same scope again. With the old code the composed check fails at once.
- **Each check fails when the fix is broken.** Six mutants: no nonce binding, by the unit test and by the composed server; any nonce, malformed or not; the nonce before the session's id; asking for the scope making the security state; a constant binding for a session with neither.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### A held query is waited for by what it is

- **Found by the qualification.** On `b76cf89` the qualification's runtime matrix failed `test/composition-lifecycle.test.js` (exit 1 after 34 s). The verify job passed it, and so did every earlier run. Four runs at once, one of eight failed the same way: *the worker has claimed the scan*, the scan still `queued`.
- **Why.** To stop the server mid-scan, the test locks `nv_sessions` and waits until a query is held behind the lock, taking that query to be the worker's session read. It counted any query held on the database. When the store opens, `ready()` starts its retention sweep without waiting for it, and the sweep deletes old sessions. When the test ran slowly, the sweep reached `nv_sessions` after the lock and was held first, before the worker had claimed the scan. No other query touches `nv_sessions` in that window. The step-up hold in `test/composition-postgres.test.js` waited the same way.
- **The fix.** Each hold now waits for its own query: the delivery batch's read of `nv_governance_webhook_deliveries`, the worker's session read, and the spend's session write. The product is unchanged; the sweep running beside them is correct.
- **Proven.** Twelve runs, four at once, all pass. The drain mutants (delivery and scans not drained) and the shared-store mutant (session security told there is no database) are still caught.
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.

### D14, step ten — the modules' text, counted; governance's, asked

- **Why.** The composition's wiring is read nowhere now; the modules' code still is. D14's first step left "the module-text halves of these checks … until their own conversion". This step counts them, and converts governance's.
- **The census.** `test/module-reads.test.js` counts the statements in every test and script that read a file of the server's source as text: `apps/api/src`, the CommonJS modules in `src`, and the contracts in `packages/contracts/src`. It finds them over the syntax tree, with names resolved by the TypeScript checker, so a name is the declaration it means in its own scope.
  - It follows a read through a reader function, a constant path, a loop over paths and a callback handed the text.
  - A read that is never used still counts.
  - Text handed to the parser is not counted; a rule over that syntax tree is what D14 converts to.
  - `require()` reads nothing: that is asking the module.
  - The page's own source (`apps/web/src`) is Phase E's.

  It found 431 statements in 53 files and holds the count exactly, like the composition's census did.
- **The root's last two.** Two checks in `test/composition-root.test.js` that the root hands routes the central failure answer and error body read its files as text. They now count those handovers in its syntax tree. 429.
- **Governance, asked (60 statements in ten tests).** Each property is now asked of the code that does it:
  - Kepler's governance host builds one service over the durable store under the audit secret, starts the delivery worker beside it, hands back the batch in flight when stopped, builds the runtime under the deployment's failure mode and logs what it cannot evaluate with that mode (`test/governance-host.test.js`).
  - The governance guard resolves the reader's authorization, holds it to the route's role, refuses a public reader outside their own work and says why, never lets an answer be cached, and describes a change from the server's evidence (`test/governance-context.test.js`), which also binds an exception's metadata to the rules it targets.
  - The routes read a repository's facts a page of a hundred at a time, show the Digital Twin with its reader's projected access, name an export's attachment, hand the service the request's idempotency key and keep a refusal's code (`test/kepler-governance-routes.test.js`).
  - Read-only mode lets exactly governance's control plane through (`test/corona-safety-guard.test.js`).
  - A mutation resolves one authorization and carries it into the descriptor; it surfaces the policy's outcome in bounded headers; it offers safe passage for an approval refusal of a write with its content in hand, and for nothing else, a failed offer meaning no offer (`test/mutation-context.test.js`).
  - The gateway normalizes and keeps the evidence (`test/mutation-gateway.test.js`), and the central failure answer sends an offer beside the unchanged body (`test/github-rest.test.js`).
  - The service simulates with Kepler's simulation (`test/governance-simulation-api.test.js`). The server reads the failure mode from its environment and announces each evaluation (`test/composition.test.js`).
- **New checks, where none answered.**
  - A governance refusal keeps its code for each of its five families, and a code that only begins like one is a failure (`test/kepler-governance-routes.test.js`). The routes test had covered two of the five.
  - The active policy set that safe passage asks for is read and nothing written. The store is asked through a pool whose every statement is seen: it runs one read-only transaction, writes nothing, takes no lock and mints no identifier, and every governance table holds what it held (`test/governance-lifecycle-postgres.test.js`). Before, a slice of the store's text was searched for `READ ONLY`.
  - The webhook routes are found in the mutation coverage inventory as data, by method, route and action, not by their action's name in its text.
  - **`test/module-rules.test.js`** holds three rules over the server's syntax tree, for defence in depth that no request can show, because a guard refuses first:
    - no module takes governance roles, repository access, an actor's or a reviewer's identity, or an authorization from a request's body, however the body is cast or named;
    - Kepler's routes hand the service only the authorization the governance context resolved;
    - the own-work allowance is a route's allowance and nothing else.
- **Each check fails when what it guards is broken.**
  - Thirty-five mutants of the modules, one for each removed text check, are each caught by the test named.
  - Seven planted violations of the rules are caught. The first version of the body rule missed a body cast with `as`, which TypeScript routes always do; it now sees through casts, assertions and parentheses.
- **Found on the way: an export only a text check named.** The mutation contract exported `normalizeMutationSecurity`. Its only use outside its own file was the text check that read the contract for it, which the contract test counted as a consumer. With the check gone, `test/contracts.test.js` reported the export unconsumed, rightly: it is used only inside the contract, by the descriptor normalizer. It is no longer exported, and the mutation contract is version 3 for the change of shape. A descriptor that needs no step-up carries none (`test/mutation-gateway.test.js`); that test already asked the gateway's descriptor for every other case the contract test had called the function for directly.
- **369 remain.**
- **Checks:** typecheck, lint, the unit gate and every verify-job gate on Node 22.23.4.
