# Uranus — qualification record

Uranus is the code audit's engine: the rules, the tracer that follows a
caller's value to the call that misuses it (JavaScript, TypeScript, Python,
Go, Java, PHP), the endpoint and ownership reading, and the dependency
reach. This record closes the Uranus mission on branch
`claude/failed-ci-pr-merge-399ykp` (draft PR #82). It keeps two kinds of
evidence apart, and says which is which every time a number is given:

- **Internal** — the engine's own corpus, `test/fixtures/uranus-benchmark`,
  written and labelled by the same hands that wrote the engine. It is a
  regression net and a statement of intent. It is not a measure of accuracy
  on code nobody here chose.
- **Independent** — the OWASP Benchmark for Java and for Python, whose cases
  and expected results were written by others, scored by the Benchmark's own
  rule. These are the only accuracy figures in this record that someone
  outside the project labelled.

## Completion criteria

| | Criterion | Status | Evidence |
|---|---|---|---|
| C1 | P0 sink-aware sanitisers and P1 propagation (functions, files, services) land with reproducible unsafe/safe pairs | Met | Commits `5ff3958`, `5770a8f`; mutants in each commit message; `test/uranus-propagation.test.js` |
| C2 | P1b authorization: a record fetched by a caller's id is a lead unless tied to the caller, read through the service the handler calls | Met | Commits `74a3aee`, `a0b15a8`; `owner-*` corpus cases |
| C3 | P2 compatibility: an accuracy change cannot silently move a finding's id, its rule or its verdict | Met | `test/uranus-finding-ids.test.js` against `test/oracles/uranus-finding-ids.json` |
| C4 | P2 coverage: a path the engine stopped following is reported as partial or pattern-checked, never as covered | Met (held) | `audit-ledger.ts` statuses; `test/uranus-linear.test.js` (deep), `test/code-audit-worker.test.js` (time limit, cut), `test/uranus.test.js` (memory limit), `test/code-audit-coverage.test.js` (budget, overflow, unreadable) |
| C5 | P2 dependency risk: imported is not reachable and reachable is not exploitable; what the scan could not see is said to be unknown | Met (held) | `uranus-reach.ts` tiers; the wording guard in `test/code-audit-ui.test.js` |
| C6 | Independent qualification with a committed, tested scorer, both halves of the cases reported, limits written down | Met | `scripts/uranus-owasp-benchmark.js`, `test/uranus-owasp-benchmark.test.js`, the tables below |
| C7 | The corpus's known miss fixed or justified; its known false alarms kept, not suppressed | Met | The PHP variable function is found (`php/variable-function`, safe twin `php/variable-function-fixed`); sixteen pattern leads stay marked `known-fp` |
| C8 | Every gate and CI green on the pushed head | On the commit that carries this record | The unit gate and the twenty verify-job gates locally; PR #82's checks |

Not done, by decision: the optional evidence export for an agent
investigator (the owner ruled out an AI investigator for this mission), and
a run of other scanners for comparison (agreement between scanners is not
ground truth, and this project does not run downloaded binaries).

## Internal corpus

337 cases (132 safe) in JavaScript, TypeScript, Python, Go, Java and PHP,
208 expected findings: **92% precision, 100% recall** on these labels
(`node scripts/uranus-benchmark.js`). The sixteen false alarms are all
pattern leads to confirm, never confirmed findings, and each is marked in its
case: two on a value an allow-list or a shell quoter already made safe, nine
on a statement a helper builds from a parameter no caller hands a request's
value, and five on a value every branch left constant or a constant key read
beside one holding the request's value. In each the trace is quiet and the
line rule cannot know it. They are kept because hiding them would only move
the number.

## Independent: the OWASP Benchmark

### Method

- **Inputs.** BenchmarkJava at `a452b3aafd232245d0753e54eb243d6651f8ef96`
  (`expectedresults-1.2.csv`, 2,740 cases) and BenchmarkPython at
  `f1291485808b66e20ddb6b01b10dc71b3df8c8ba` (`expectedresults-0.1.csv`,
  1,230 cases). Both are read as data from a checkout outside the
  repository; nothing in them is run, and neither is vendored (GPL).
- **One case, one repository.** Each case's file is audited with the
  Benchmark's helper code beside it, by the whole audit, as a repository
  would be. A case is flagged when a finding of the rule that claims its
  category is reported in the case's own file — confirmed or to confirm,
  since a lead is something a reader is shown.
- **What is claimed.** A category is scored only where a Uranus rule claims
  the same CWE: SQL injection (89, SEC-001), command injection (78,
  SEC-011), path traversal (22, SEC-022), cross-site scripting (79,
  SEC-033), code injection (94, SEC-010), open redirect (601, SEC-020),
  deserialization (502, SEC-024), XXE (611, SEC-034), insecure cookie (614,
  SEC-004) and weak randomness (330, SEC-005, whose claim is narrower: a weak
  generator on the line that names a secret). Weak hashing, weak ciphers,
  LDAP, XPath and trust-boundary cases are listed as not claimed and are not
  counted as misses.
- **Score.** The Benchmark's own: true-positive rate less false-positive
  rate (Youden's J), per category, then averaged over the categories.
- **Halves.** The cases are also scored in two halves by the parity of their
  number. Misses from both halves were read while the engine was changed, so
  the halves are not a strict hold-out; they show whether the score hangs on
  the half that was read.

### Results

Before is the engine at `a0b15a8`; after is the commit carrying this record.

**Java** (2,038 claimed cases):

| Category | Rule | Real | Safe | Before TP/FP, score | TP | FN | FP | TN | TPR | FPR | Score |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cmdi | SEC-011 | 126 | 125 | 1/0, 1% | 58 | 68 | 49 | 76 | 46% | 39% | 7% |
| pathtraver | SEC-022 | 133 | 135 | 1/1, 0% | 73 | 60 | 62 | 73 | 55% | 46% | 9% |
| securecookie | SEC-004 | 36 | 31 | 0/0, 0% | 36 | 0 | 0 | 31 | 100% | 0% | 100% |
| sqli | SEC-001 | 272 | 232 | 11/3, 3% | 202 | 70 | 120 | 112 | 74% | 52% | 23% |
| weakrand | SEC-005 | 218 | 275 | 0/0, 0% | 0 | 218 | 0 | 275 | 0% | 0% | 0% |
| xss | SEC-033 | 246 | 209 | 0/0, 0% | 158 | 88 | 78 | 131 | 64% | 37% | 27% |

Average **0.6% → 27.5%**; odd half 26.2%, even half 28.9%.

**Python** (827 claimed cases):

| Category | Rule | Real | Safe | Before TP/FP, score | TP | FN | FP | TN | TPR | FPR | Score |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cmdi | SEC-011 | 13 | 7 | 2/0, 15% | 4 | 9 | 2 | 5 | 31% | 29% | 2% |
| codeinj | SEC-010 | 20 | 33 | 2/1, 7% | 8 | 12 | 2 | 31 | 40% | 6% | 34% |
| deserialization | SEC-024 | 18 | 36 | 18/12, 67% | 18 | 0 | 12 | 24 | 100% | 33% | 67% |
| pathtraver | SEC-022 | 65 | 103 | 4/6, 0% | 31 | 34 | 21 | 82 | 48% | 20% | 27% |
| redirect | SEC-020 | 13 | 21 | 3/2, 14% | 8 | 5 | 7 | 14 | 62% | 33% | 28% |
| securecookie | SEC-004 | 24 | 15 | 0/0, 0% | 24 | 0 | 0 | 15 | 100% | 0% | 100% |
| sqli | SEC-001 | 5 | 11 | 0/0, 0% | 2 | 3 | 0 | 11 | 40% | 0% | 40% |
| weakrand | SEC-005 | 99 | 227 | 0/0, 0% | 0 | 99 | 0 | 227 | 0% | 0% | 0% |
| xss | SEC-033 | 31 | 58 | 0/0, 0% | 17 | 14 | 10 | 48 | 55% | 17% | 38% |
| xxe | SEC-034 | 8 | 20 | 0/0, 0% | 3 | 5 | 2 | 18 | 38% | 10% | 28% |

Average **10.3% → 36.3%**; odd half 28.9%, even half 38.7%. Several Python
categories hold fewer than twenty cases, so a single case moves their score
by five points or more, and the halves differ by more than the engine does.

### What the false alarms are

Of the 309 Java false alarms, 200 are cases whose request value sits in a
branch a constant condition never takes (`(7 * 18) + num > 200 ? safe :
param`, a switch on a constant) and 80 read a list after removing an element,
so the index lands on a constant. In Python, 18 and 12 of 56. The engine is
path-insensitive on purpose: it does not evaluate conditions, and it counts
both arms of a branch as reachable, because in code that was not written as a
test the condition is rarely a constant. Folding these particular constants
would raise the score without making the engine better at real code, so it
was not done. The rest (29 Java, 26 Python) are pattern leads that
the trace would have quieted (a pickle call, a derived value checked against
an allow-list) and values the flow keeps after a transformation that in
these cases makes them safe.

### What is still missed

| Class | Java | Python | Why |
|---|---|---|---|
| Weak randomness | 218 | 99 | SEC-005 claims a weak generator on the line that names a secret; the Benchmark's cases put the random value into a remember-me cookie a few lines later. Following a random value into a cookie is a flow rule this mission did not add. |
| A factory returning one of several implementations | 91 | 10 | `ThingFactory.createThing().doSomething(param)`: the method has several definitions, and the engine follows a call only to one it can name. |
| An encode-then-decode round trip | 69 | 14 | `decodeBase64(encodeBase64(param))`: an encoder is not followed, because an encoded value is safe for most sinks; the decode that undoes it is not paired with it. |
| The Benchmark's own request wrapper | 69 | 22 | `SeparateClassRequest` / `request_wrapper`: a class of the Benchmark's that the engine does not know to be a request. |
| Other | 57 | 36 | Mixed: values through reflection, collections read by computed index, and sinks the engine does not model. |

### What the qualification changed in the engine

Each change is a general idiom, checked first on a pair of unsafe and safe
cases written for the internal corpus, never on a Benchmark name:

- **Branches as arms** (all languages): each arm of an if, else-if, switch,
  loop or catch is read with its own copy of the scope and joined after, so a
  default assigned in one arm no longer overwrites the request's value for
  the code that follows, and a value every arm overwrites is no longer the
  request's.
- **Containers by key** (all languages): what is put in a list, map, builder
  or buffer is held by it; what is put under a literal key is held under that
  key, so reading another key does not find it. Object and dict literals give
  their keys the same way.
- **Java**: a qualified generic type (`java.util.List<String> x`) read as a
  declaration; a conditional expression read as its two values; parameter and
  header names, an enumeration's elements and an iterator's, followed; a
  `Runtime` or a writer held in a local; a method of a type constructed in
  the call (`new Helper().run(x)`); a request value printed to a servlet
  response reported, confirmed where the response is declared HTML and a lead
  where it declares nothing; insecure cookies set by `setSecure(false)`.
- **Python**: a Flask view's plain-text return of a request value is a lead
  (Flask sends text/html by default); `request.get_data()` is the body;
  `codecs.open`, `io.open` and `pathlib.Path` are file paths; minidom and
  pulldom parsing with external entities switched on is XXE, and their
  default parsers, which do not resolve them, are not.
- **Go**: an `http.Cookie` with `Secure: false` or `HttpOnly: false`.
- **PHP**: a function the caller names and the code calls (`$action($arg)`).

Twenty-six mutants of this logic were run against the tests; every one is
caught. The engine's own source, audited by itself, still reports no flows.

### Reproduce

```sh
git clone https://github.com/OWASP-Benchmark/BenchmarkJava   # then check out a452b3a
git clone https://github.com/OWASP-Benchmark/BenchmarkPython # then check out f129148
node scripts/uranus-owasp-benchmark.js ../BenchmarkJava
node scripts/uranus-owasp-benchmark.js ../BenchmarkPython --json
node scripts/uranus-benchmark.js        # the internal corpus
node test/uranus-finding-ids.test.js    # ids, rules and verdicts held to the record
```

## Limitations

- The Benchmark's cases are small, single-servlet or single-view programs
  with deliberate traps. A score on them is evidence about the idioms they
  use, not about Spring, Django or Laravel applications as written.
- The Python Benchmark is at version 0.1, and its labels were taken as they
  are; no case was relabelled.
- The Java and Python figures are measured on the CWEs Uranus claims. They
  say nothing about the categories it does not claim.
- No comparison with another tool was made. Agreement between scanners is
  not ground truth, and no third-party scanner was installed.
- The internal corpus remains the engine's own; its 100% recall is the
  statement that every case written for it passes, not an accuracy figure.
