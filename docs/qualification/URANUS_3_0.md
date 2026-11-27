# Uranus 3.0 qualification

Uranus 3.0 corrected five verdicts on eight controlled JavaScript/TypeScript transformations. Four previously silent flows now retain a review lead, and a confirmed alert on genuinely escaped HTML text disappeared. Across 2,938 independently labelled cases and controls, **zero case outcomes changed**. The release also lets an authorized audit owner export the recorded coverage decision for an exact revision and verify it offline. Uranus remains suitable for advisory review. Independent recall is too low to treat a quiet scan as release clearance.

The comparison begins at 2.5 commit `61654dfc588a972ed4e88fcf9652aabcf7cb2586`. The candidate was frozen at `b761f86a8917e6b9144be6e09ac6fb8799a67914` before the held-back labels were opened. A subsequent file-size check required moving the identical member-chain parser into the token-shape module. The full evaluation was rerun on the combined product at `96ba4641da016190a7957e2dffa68906bf118d86`, ruleset `07fa4da9fc33ce964763a62eacbd76a3790b0464d23b67877bd17a3f1128673c`. The two fingerprints identify distinct source graphs. The held-back set was blind for the first freeze only. [Machine-readable results](uranus-3.0-results.json) · [Architecture and four investment decisions](../architecture/URANUS_SEMANTIC_EVIDENCE.md)

## What changed for a reviewer

The analyzer resolves the call's value binding before granting a sink-specific guarantee. It follows bounded local and imported function summaries, recognizes a small set of exact library exports, and accounts for shadowing, reassignment and type-only imports. A modeled encoder can clear a value used as HTML text. A computed receiver, a policy-dependent transform or an insertion into an attribute or script can keep a review lead at the transform or sink. A matching name alone previously hid paths and could also make an alias of a trusted export look dangerous. The release uses the established finding IDs and assurance vocabulary. [Controlled semantic cases](../../test/uranus.test.js) · [Transform contracts](../../apps/api/src/modules/uranus/domain/uranus-sanitise.ts)

| Controlled operation on the same request field before HTML text output | 2.5 | 3.0 |
|---|---|---|
| Local identity function named like an encoder, shadowed numeric parser | Silent on both | Review on both, with the local guard location |
| Imported transform with unavailable implementation, method on unresolved receiver | Silent on both | Review on both, with the unverified transform location |
| Genuine text encoder imported under a different name | Confirmed | Silent |
| Genuine numeric conversion, recognized encoder under its usual name, local helper returning a fixed literal | Silent on all three | Silent on all three |

Against the 337 original project fixtures, 208/208 expected alerts survived and all 261 pre-existing IDs and verdicts matched. Extras rose from 16 to **17**. `javascript/path-basename` acquired SEC-022, ID `edc75175ddf78881556c5d74`, at line 6. A filename operation does not on its own establish containment for all possible components. The safe-labelled case still counts against precision, which moved from 92.9% to 92.4% on the project's finding-based metric. Two isolated mutations reinstated name-only erasure and discarded the resolved library member, respectively. The semantic suite failed each mutant and passed the unmodified engine. [ID oracle](../../test/oracles/uranus-finding-ids.json)

## Independent accuracy

Each row gives the identical result for both versions. “All” includes confirmed findings and review leads. FPR uses all labelled negatives and FNR uses all labelled positives. A dash denotes an undefined precision because there were zero predictions. The data file gives the confusion matrix and rates by language and CWE at both thresholds, excluded categories, case-outcome hashes and recorded trace gaps. [Detailed measurements](uranus-3.0-results.json)

| Corpus and threshold | TP | FP | FN | TN | Precision | Recall | FPR | FNR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Java, all | 527 | 309 | 504 | 698 | 63.0% | 51.1% | 30.7% | 48.9% |
| Java, confirmed | 165 | 67 | 866 | 940 | 71.1% | 16.0% | 6.7% | 84.0% |
| Python, all | 115 | 56 | 181 | 475 | 67.3% | 38.9% | 10.5% | 61.1% |
| Python, confirmed | 83 | 36 | 213 | 495 | 69.7% | 28.0% | 6.8% | 72.0% |
| TypeScript application originals and accepted repairs, all | 3 | 1 | 3 | 5 | 75.0% | 50.0% | 16.7% | 50.0% |
| TypeScript application originals and accepted repairs, confirmed | 2 | 0 | 4 | 6 | 100% | 33.3% | 0% | 66.7% |
| JavaScript/TypeScript DOM policy, all | 3 | 0 | 27 | 31 | 100% | 10.0% | 0% | 90.0% |
| JavaScript/TypeScript DOM policy, confirmed | 0 | 0 | 30 | 31 | — | 0% | 0% | 100% |

- **OWASP Java and Python.** The scorer counted a matching rule in the labelled case file. It scored 2,038 of 2,740 Java cases and 827 of 1,230 Python cases. Both suites excluded weak hash, LDAP, trust boundary and XPath because the engine lacks a matching claim. Java also excluded weak cryptography. The randomness rule models a narrower security use and missed 218/218 positive Java and 99/99 positive Python cases. A reported issue elsewhere in a case file can still score. Both public suites were known during development. [Java pin, GPL-2.0](https://github.com/OWASP-Benchmark/BenchmarkJava/tree/a452b3aafd232245d0753e54eb243d6651f8ef96) · [Python pin, GPL-3.0](https://github.com/OWASP-Benchmark/BenchmarkPython/tree/f1291485808b66e20ddb6b01b10dc71b3df8c8ba)
- **TypeScript application.** Six Juice Shop challenge intervals were paired with six upstream accepted repairs. Both SQL cases were confirmed. The document-query case still fired on its repaired twin. Two client-rendering intervals and one redirect interval were missed. Both thresholds matched 2/7 annotated positive lines exactly. Thirty-one other challenge records fell outside the protocol. The positive and negative labels describe the selected interval and rule only. [Application pin, MIT](https://github.com/juice-shop/juice-shop/tree/266448aba68cd8ba5915f526a128da4fa7bc3f9f)
- **DOM policy.** Of 30 upstream policy violations, three JavaScript cases produced review leads and none of the three TypeScript positives fired. All 31 safe controls stayed quiet. Three of 27 labelled positive lines matched exactly and three cases had no line label. Fifteen cases required custom settings or parsers and two fell outside the property scope. The upstream labels express a source policy where runtime origins may be unknown. They measure policy agreement. [Upstream pin, MPL-2.0](https://github.com/mozilla/eslint-plugin-no-unsanitized/tree/7eb1c8ae4179da3bc3916ece1818cc493f026764)

The framework protocol fixed tests and scoring at `7814ccf1a5b21a1df971dbcb99afa4c2abc5f111`. Its SHA-256 is `f5daa477ed790fe02517654ede21e5e81f248c7222bd457fe7082c2f823304ed`. A separate evaluator held the DOM baseline until the detector freeze. Both framework assays used one file per audit. In these inputs the parser reported zero diagnostics and the engine reported zero trace-budget cutoffs. Framework lifecycle, imports absent from the input, dynamic dispatch and untracked origins can still leave flows unseen. [Scoring protocol](../../test/oracles/uranus-framework-protocol.txt)

## Repository coverage and cost

On the same Juice Shop tree, the production reader and bounded workers read **999 of 1,000** eligible files. One oversized asset left the scan incomplete. The 600-file primary selection included 82 files checked only by patterns, and 399 overflow files received rules-only checks. Both engines reported 131 observations, 28 confirmed and 103 requiring validation. Two SQL locations matched the exact labelled lines, the profile-image request matched exactly at review assurance and the document query was one line adjacent at review assurance. These four sites have no repository-wide negative denominator. Registry and advisory lookups were disabled.

The end-to-end repository replay used 3.75 s wall, 5.29 s CPU and 253.9 MiB peak RSS on 2.5. The final 3.0 replay used 3.92 s wall, 5.49 s CPU and 265.7 MiB peak RSS. Each variant ran once per campaign on a shared Linux x64 host with two CPUs of quota, Node 22.23.5 and default worker limits. The initial freeze and the final replay were separate campaigns. The point measurements do not establish a speedup or a production latency percentile.

The separate frontend experiment traversed 63 TypeScript route files, using seven alternating fresh-process pairs on a two-CPU quota. Median traversal took 36.5 ms for tokens and bracket pairing and 104.6 ms for the TypeScript syntax tree. Median peak RSS rose from 85.3 to 128.3 MiB. The experiment priced syntax construction. Type analysis, enterprise throughput, production p95 and incremental-scan performance still need measurement. [Experiment design and reproduction](../architecture/URANUS_SEMANTIC_EVIDENCE.md)

## Verifying retained coverage

An authorized reader can export an audit they retained using `GET /api/repo/:owner/:repo/code-audit/history/:auditId?proof=coverage`. Save the canonical JSON as `coverage.json`. Pin the response's `X-Uranus-Coverage-Digest` through an independently trusted channel and obtain the expected owner/repository, commit and ruleset from the review being verified. Run the verifier offline.

```sh
node scripts/uranus-verify-coverage.js coverage.json OWNER/REPO COMMIT_SHA RULESET_SHA256 TRUSTED_DIGEST
```

Exit 0 means complete coverage recorded for the supplied subject. Exit 2 means authentic incomplete or unrecorded evidence. Exit 1 rejects malformed, noncanonical, mismatched or unanchored input. The versioned statement binds the repository scope, audit UUID, commit, engine, ruleset, observation time, recorded file and finding counts, and optional watch state. The verifier recomputes the decision under the same coverage predicate as the merge gate. It rejects invalid counts, ambiguous JSON and inputs exceeding 8 KiB. The existing identity-scoped store reads only the summary row. Receipt bodies omit source, findings, paths, branch and actor. A guessable repository name can be correlated with its deterministic scope digest. [Wire contract](../../packages/contracts/src/audit-coverage-proof.ts) · [Verifier and route cases](../../test/helpers/uranus-coverage-proof.js)

The trust anchor authenticates the bytes relative to its source. A matching checksum delivered with an untrusted copy supplies no independent origin assurance. The receipt attests what the service recorded at the audit time. Approval, fix credit, current permissions, current advisory freshness and absence of vulnerabilities each require separate evidence. A legacy row without the required provenance yields `unrecorded`; an absent optional watch makes no freshness claim.

## Reproduction and remaining work

Use a clean checkout with the Node version in `.nvmrc` and run `npm ci` in the trusted engine checkout. Use regular local Git clones of the four upstream revisions cited above. The whole-repository and framework commands read the pinned Git objects. The Java/Python scorer reads the checked-out files, so use the exact detached revision in a clean working tree. These assays consume source as data. They use no upstream build, test runner or package installation. For a historical comparison, prepare a separate trusted 2.5 checkout at the full SHA above. Run the Java/Python and internal scorer in each engine checkout, and pass `--trusted-engine ../uranus-2.5` to the current framework and whole-repository scorers to select the old engine.

```sh
node scripts/uranus-ruleset.js
node test/uranus.test.js
node test/uranus-finding-ids.test.js
node scripts/uranus-benchmark.js --json
node scripts/uranus-owasp-benchmark.js ../BenchmarkJava --json
node scripts/uranus-owasp-benchmark.js ../BenchmarkPython --json
node scripts/uranus-framework-benchmark.js juice-shop ../juice-shop
node scripts/uranus-framework-benchmark.js dom-policy ../eslint-plugin-no-unsanitized
node scripts/uranus-repository-benchmark.js ../juice-shop
```

The next accuracy investment is a narrowly modeled framework source or sink with failing and repaired controls on a newly held-back application. Dynamic property writes across modules, unresolved runtime packages, complex control flow, Python/C-family sanitizer identity and organization-specific authorization remain open. A type-aware frontend needs a bounded fallback and a measured coverage gain. Signing, deployment-linked exposure and behavioral verification of repairs have separate evidence requirements. [Decision and roadmap](../architecture/URANUS_SEMANTIC_EVIDENCE.md)
