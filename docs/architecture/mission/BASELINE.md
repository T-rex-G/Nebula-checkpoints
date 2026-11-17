# Architecture mission baseline

The tree, deployment and measurements the architecture mission started from. Every later parity claim is made against this record.

## Identity

| Item | Value | How it was established |
|---|---|---|
| Baseline commit | `3bf017a8cdb11e8ef86af7ff857add9b61b6f242` (merge of PR #81) | `git rev-parse origin/main` on 18 October 2026 |
| Baseline tree | `ef58bee9705b1768aa6bf8063b8400e0e7c22c86` | Identical to the qualified PR #81 head `4cb63c5` |
| Release fingerprint | `5171b77e425ecb43df24fc795198783367191f08f11843cab5b0e64279fb4392` | Read from production `/api/version`; equal to the qualified candidate's |
| Post-merge CI | Run `39124744111`, all nine jobs green | GitHub Actions API |
| Production readiness | `{"ok":true,"database":"connected","migration":"032_code_audit_analysis_coverage"}` | Production `/readyz` |
| Production service | `srv-dabg6ufqj5pc739takeg`, free plan, auto-deploy from `main`, build `npm ci --omit=dev`, start `npm start` | Render API |
| Runtime | Node 22.23.1 (pinned in `.nvmrc`, `engines` and every CI job), Express 4.22.3, pg 8.22.0, TypeScript 5.9.3 | `package.json`, `package-lock.json` |

## Size

| Region | Files | Lines |
|---|---:|---:|
| `server.js` | 1 | 8,926 |
| `src/` | 96 | 45,310 |
| `public/` first-party JavaScript | 30 | 28,094 |
| `public/` vendored JavaScript | 15 | 14,465 |
| `public/style.css` | 1 | 9,342 |
| `public/index.html` | 1 | 2,151 |
| `test/` | 499 | 76,073 (JavaScript) |
| `scripts/` and `ci/` | 39 | 12,538 |
| `docs/` | 98 | 14,514 |
| `db/migrations` | 32 | 2,689 |
| **Tracked files** | **859** | |

## Captured oracles

Recorded from this tree before anything moved, and compared at every later checkpoint.

| Oracle | File | What it holds | Reproduced |
|---|---|---|---|
| Route policy | [`test/oracles/route-policy.json`](../../../test/oracles/route-policy.json) | 195 routes and 14 pipeline steps in registration order; each route's guard chain as written; which routes sit in front of the alpha access boundary | Read twice from source; identical |
| Negative-request matrix | [`test/oracles/negative-matrix.json`](../../../test/oracles/negative-matrix.json) | 1,011 status-and-code answers across 8 caller contexts: anonymous, missing app header, cross-site, foreign origin, forged session, reader without CSRF, reader, administrator without step-up | Two runs, 0 differences |
| DOM contract | [`test/oracles/dom-contract/`](../../../test/oracles/dom-contract/) | Visible IDs, classes, roles, data attributes and accessible labels for 19 views (7 pages, 13 workbench tabs) on desktop and mobile | Recorded with 3 workers, re-read in compare mode, 38 of 38 equal |

The route policy and the matrix are held by `test/architecture-oracles.test.js`; the DOM contract by `test/e2e/dom-contract.spec.js`.

## Generated inventories

Written by `scripts/architecture-inventory.js` from the baseline commit; `--check` proves them current.

| File | Content |
|---|---|
| [FILE_INVENTORY.json](FILE_INVENTORY.json) | All 859 files: class, owner, proof. 616 active, 170 fixtures, 34 immutable history, 32 vendor, 6 generated, 1 unreferenced, 0 unknown |
| [DEPENDENCIES.json](DEPENDENCIES.json) | Backend require graph with fan-in and fan-out, packages, built-ins, the one dependency cycle, and the three entry files loaded by path |
| [ROUTE_INVENTORY.json](ROUTE_INVENTORY.json) | The 195 routes by owning module |
| [FRONTEND_SURFACE.json](FRONTEND_SURFACE.json) | Script order, published and consumed globals, HTML sinks, listeners and API calls per browser file |
| [RESIDUE_REGISTER.md](RESIDUE_REGISTER.md) | Files outside active source, and the mechanisms the architecture retires |

## Test baseline

See [BASELINE_TESTS.md](BASELINE_TESTS.md).
