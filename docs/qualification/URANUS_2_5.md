# Uranus 2.5 qualification

**Release assessment.** Uranus can support advisory source review. The evidence supports withholding a clean merge decision when required checks did not finish. Java and Python recall remains too low to make a clean scan the sole enterprise release criterion.

The comparison uses PR #82 at `3475d70` and engine commit `a99f1e1`, on Node 22.23.5. The independently labelled OWASP suites measure cases. Four published Juice Shop locations exercise the repository audit and its triage path. All three inputs were read as source. [PR #82](https://github.com/T-rex-G/Nebula-checkpoints/pull/82) · [2.5 engine](https://github.com/T-rex-G/Nebula-checkpoints/commit/a99f1e1b4b6cf4279645b49fc7296c8583d71f3c)

## What the results establish

| Corpus and threshold | Cases scored | True positives | False positives | False negatives | True negatives | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|---:|
| Java 2.4, all or confirmed | 2,038 | 527 | 309 | 504 | 698 | 63.0% | 51.1% |
| Java 2.5, all findings | 2,038 | 527 | 309 | 504 | 698 | 63.0% | 51.1% |
| Java 2.5, confirmed | 2,038 | 165 | 67 | 866 | 940 | 71.1% | 16.0% |
| Python 2.4 and 2.5, all findings | 827 | 115 | 56 | 181 | 475 | 67.3% | 38.9% |
| Python 2.4 and 2.5, confirmed | 827 | 83 | 36 | 213 | 495 | 69.7% | 28.0% |

A hit requires the mapped rule in the labelled case file. Java supplied 2,740 labels and Python supplied 1,230. The scorer excluded categories without matching rule and CWE coverage. Confidence thresholds use the same findings from one scan. On Java, 242 safe cases and 362 positive cases moved from confirmed to review. All 527 positive cases detected by 2.4 still have findings. Both thresholds gave identical case-level results on Python. Four project-authored Java fixture verdicts also moved to review. Their positive labels and IDs stayed intact. The project corpus found 208 of 208 expected findings, with 16 extra reports across 337 cases. [BenchmarkJava revision](https://github.com/OWASP-Benchmark/BenchmarkJava/tree/a452b3aafd232245d0753e54eb243d6651f8ef96) · [BenchmarkPython revision](https://github.com/OWASP-Benchmark/BenchmarkPython/tree/f1291485808b66e20ddb6b01b10dc71b3df8c8ba)

**OWASP Juice Shop v20.4.0.** Uranus read 999 of 1,000 eligible files, checked 399 of the files by rules alone, and reported 28 confirmed findings and 103 leads. An eligible oversized JavaScript asset kept file coverage incomplete. Of the 131 findings, 91 were in conventionally named example, test or asset paths and 40 were elsewhere. The two SQL locations remained confirmed. The profile-image request and review-update handler gained traced leads. The review update is reported at the call on line 17, adjacent to the labelled selector on line 18. The four locations are a spot check, with no repository-wide accuracy denominator. Grouping findings by path keeps findings in examples, assets and tests available. A path group says where a finding lives. [Juice Shop revision](https://github.com/juice-shop/juice-shop/tree/266448aba68cd8ba5915f526a128da4fa7bc3f9f)

**Efficiency.** File selection gives application source priority over conventionally named examples and assets within the existing trace budget. Go, Java and PHP now classify nested functions without scanning every function against every other. On a 4,000-method Java file, the full language pass used a median of 104.2 ms of process CPU on PR #82 and 43.6 ms on 2.5. Nine paired repetitions alternated run order after a warmup. Both revisions read all 4,000 functions and emitted zero findings. Production latency and incremental p95 remain unmeasured.

## Evidence and operating limits

- The same JavaScript reassignment that scored 99/A in PR #82 again produces a confirmed SQL finding and 49/F. Sibling-field, replacement, spread, scope and branch controls exercise the opposite outcomes. JavaScript statement boundaries also preserve the next statement when a semicolon is omitted.
- Unread eligible files count in the file denominator. Timeouts, a per-file flow cap, pattern-only components and unanswered lookups affect the relevant evidence. For the two-file oversize test, the worker and history mark the result incomplete and the gate returns unavailable. Existing confirmed blockers can still hold a merge. The gate checks the head SHA and ruleset. Crediting a newly introduced finding also requires a complete base audit from the matching pull request revision.
- The engine records its SHA-256 ruleset digest in the audit, stored history and SARIF. An equal display version with a changed or missing digest starts a fresh comparison. On PostgreSQL 17 the migration preserved legacy rows with unknown provenance, and outages produced fix credit only for detectors with enough evidence. Applying migration 033 before deploying the application enables the new reader and writer. The older binary tolerates the added nullable column.

## Remaining market gaps

On a separate, matched Python revision, the archived Bandit 1.8.6 run found 11 of 11 SQL positives with 23 false alarms. Uranus found seven with two false alarms. On weak randomness Bandit found 83 of 104 positives, Uranus found zero, and neither flagged a negative. Uranus's rule targets randomness used for secrets. The comparison covers those two rule pairs only. [Upstream Bandit benchmark and SARIF](https://github.com/OWASP-Benchmark/BenchmarkPython/tree/7cf0674b9a33788ac3105e4c4a75a7fdce4c44bd)

CodeQL and Semgrep document configurable library or taint models. Uranus still needs customer-defined framework models with safe controls, repository-scoped shared baselines and multi-repository TypeScript accuracy data. Vue, Svelte and Astro scripts receive pattern checks. Business-logic coverage and running-application assurance remain outside these measurements. No commercial scanner was run for this comparison. [CodeQL model extensions](https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-javascript/) · [Semgrep taint models](https://docs.semgrep.dev/writing-rules/data-flow/taint-mode/overview)

## Reproducing the checks

Use the repository's pinned Node version, install with `npm ci`, and check out the corpus revisions linked above. The OWASP commands report both thresholds and list unscored categories.

```sh
node scripts/uranus-owasp-benchmark.js ../BenchmarkJava --json
node scripts/uranus-owasp-benchmark.js ../BenchmarkPython --json
node scripts/uranus-benchmark.js
node test/uranus-finding-ids.test.js
node scripts/uranus-ruleset.js
npm run test:code-audit-history
```

The database suite requires `NV_TEST_DATABASE_URL` pointing to a disposable PostgreSQL instance. After editing detector inputs, regenerate the checked-in digest with `node scripts/uranus-ruleset.js --write`.
