# Uranus semantic analysis and decision evidence

## Decision

Start with the identity of JavaScript and TypeScript calls that can erase a tracked value. Use the existing function summaries, lexical scopes and import bindings. Give a transformation a security contract for a specific output context only when the available binding and call support it. Preserve uncertainty through unresolved calls. Keep the existing file, memory, recursion and time budgets. Record the resulting change in detector identity.

At the 2.5 checkpoint (`61654df`), changing the name of a local, constant-behavior identity function could remove its caller's traced finding. Conversely, importing a real HTML encoder under an unrelated name could cause a confirmed finding on its escaped output. Both effects occurred on small, fully read files with the ordinary analyzer. Tuning file selection, increasing worker memory or changing severity weights would leave the cause intact. A project-authored positive/safe pair distinguishes these effects. Independent source evaluations measure how far the finding generalizes.

## Where evidence originates

| Question | Evidence available at the checkpoint | Boundary that matters |
|---|---|---|
| Which source did we read? | The repository reader resolves a ref to a commit. Intake selects files within count and byte limits, reads additional files for patterns, and counts eligible files it could not read. | A read file may receive pattern checks only. A clipped Git tree prevents establishing the full denominator. |
| How did an input reach a call? | JS/TS and Python use bounded token walks, bindings, field tracking, endpoint roles and summaries. Go, Java and PHP have separate readers. A finding can retain its source, steps, sink and a validation blocker. | Dynamic dispatch, calculated properties, aliasing, mixed branches and framework wrappers can change the answer. A path in source does not establish runtime execution. |
| Who can perform an operation? | The route and service readers relate recognized handlers, guards, resource ownership and bounded indirect access to ACC findings. | A role name, a browser check or missing middleware in the selected source cannot establish a cross-tenant violation. Unresolved service identities and background jobs require review. |
| Is a dependency relevant? | Inventory and advisory answers identify affected versions. Usage and lock relationships support separate import, build, test and transitive tiers. Known exploitation and probability signals are distinct inputs. | An installed version, an import, an affected function and a deployed execution are separate observations. Runtime configuration and customer assets need independent evidence. |
| Is a finding fixed or a merge justified? | History retains finding IDs, detector identity and family-specific completeness. The merge gate reads the PR revisions and retained audits. Kepler owns policy and enforcement. | Digest changes, missing base evidence, unresolved checks and stale revisions limit fix credit. The scanner has no production authority or fleet-wide view of all repositories. |

The relevant implementation starts in [repository intake](../../apps/api/src/modules/uranus/application/audit-repository.ts), [worker budgets](../../apps/api/src/modules/uranus/application/audit-worker.ts), [flow analysis](../../apps/api/src/modules/uranus/domain/uranus-flow.ts), [service resolution](../../apps/api/src/modules/uranus/domain/uranus-services.ts), [dependency relevance](../../apps/api/src/modules/uranus/domain/uranus-reach.ts), [history evidence](../../apps/api/src/modules/uranus/domain/audit-evidence.ts) and the [merge gate](../../apps/api/src/modules/uranus/application/merge-gate.ts).

## Frontend cost and evolution

The syntax experiment read 63 regular TypeScript route files (173,703 bytes) at Juice Shop `266448a`. It ran seven alternating pairs in new Node 22.23.5 processes on Linux with a two-CPU quota and a 224 MiB old-space limit. One file warmed each frontend. Git reads and initial module loading were outside the traversal timer. RSS is the whole process peak. The compiler emitted zero syntax diagnostics on this tree. [Corpus revision and MIT license](https://github.com/juice-shop/juice-shop/tree/266448aba68cd8ba5915f526a128da4fa7bc3f9f)

| Frontend operation | Median load | Median wall | Median process CPU | Median peak RSS |
|---|---:|---:|---:|---:|
| Current lexer and bracket pairing | 4.2 ms | 36.5 ms | 78.1 ms | 85.3 MiB |
| TypeScript 5.9.3 syntax tree per file | 220.3 ms | 104.6 ms | 238.4 ms | 128.3 MiB |

The compiler provides structure that tokens cannot express directly. This experiment priced syntax construction on one corpus. Neither path performed type checking or a full security analysis. TypeScript already has an Apache-2.0 development dependency in the project. A runtime frontend would need separate packaging and memory qualification. The probe reads Git blobs and uses `createSourceFile` without consulting the target's compiler configuration, plugins or installed modules. [Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) · [Compiler license](https://github.com/microsoft/TypeScript/blob/v5.9.3/LICENSE.txt)

Run each command in a fresh process from this checkout, alternating the order for subsequent pairs.

```sh
node --max-old-space-size=224 scripts/uranus-frontend-probe.js tokens ../juice-shop routes
node --max-old-space-size=224 scripts/uranus-frontend-probe.js syntax ../juice-shop routes
```

1. **Build binding-aware summaries first.** Reuse resolved symbols and existing per-parameter return summaries. Join possible flows at branches. A sink-specific guarantee must survive every possible contributing path before it can clear a value. Repeat safe, unsafe, shadowed and unresolved twins after a model change.
2. **Research an opt-in syntax frontend for difficult bindings.** Emit a small shared representation of binding identity, call origin, receiver/field access, source span and explicit unresolved reason. Add CFG edges around guards and exception/async exits before considering SSA for individual functions. On a parse error or budget cutoff, retain existing observations and record the scope the frontend could not resolve.
3. **Defer whole-program graphs and disk caches.** Recursion requires a bounded fixed point and an explicit unknown when it does not converge. A cache key needs the blob, analysis options, ruleset and imported summary identities. Reusing results across tenants would also require an access-control and retention design. Reachability over interprocedural graphs is a published algorithmic foundation, with assumptions about the finite fact domain and transfer functions. It supplies no automatic solution for library or runtime modeling. [Reps, Horwitz and Sagiv, POPL 1995](https://research.cs.wisc.edu/wpis/papers/popl95.pdf)

## Product investments

| Decision | Impact and engineering cost | Required evidence |
|---|---|---|
| **BUILD** scoped call contracts and a retained-audit coverage proof | One analysis path and one read-only evidence boundary. A repository owner can see why a call changed a verdict and what a particular retained scan actually covered. | Regression and mutation twins, preserved IDs, exact revision/model matching, tamper and scope tests, offline verification. |
| **RESEARCH FURTHER** framework models and agentic workflow review | A validated, versioned declarative model could cover organization-specific wrappers and auth boundaries. A repository-native agent rule needs an observed transition from untrusted input to an authorized tool action. | Start with labelled positive and safe controls on separate repositories. Validate model provenance, permissions and precedence. Merely importing an AI package supplies no such evidence. |
| **RESEARCH FURTHER** typed links to repository topology and telemetry | An evidence edge could identify a static endpoint and its guarded operation. Neural and the event system would own their topology and observations. Deployment and identity links each need their own collection authority. | Keep observed, inferred and conditional edges separate. Exercise missing joins and revocation before presenting cross-module conclusions. |
| **DEFER** verified repairs and signing | A repair needs independent behavioral regression evidence tied to the old and new revisions. An attestation needs a named issuer, trusted verifier, key lifecycle and revocation. | Use retained comparable audits and controlled safe tests first. A digest proves byte integrity only relative to a trusted reference. [SLSA verification summary](https://slsa.dev/spec/v1.2/verification_summary) |
| **REJECT** executing repository configuration, inferring safety from a name, or silently reducing coverage to improve a benchmark | Each can produce an apparently decisive answer without the evidence to support it. | Record unsupported syntax and resource cutoffs. Keep findings and conditional leads inspectable. |

Use ASVS and CWE as common requirements and classifications. Favor review for unresolved business logic. Keep workflow privileges and dependency intelligence with their source modules. Evidence consumers must retain tenant scope, source revision, timestamps and assurance, including when a fetch failed. [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) · [CWE](https://cwe.mitre.org/)
