# Test baseline

The suites as they stood when the architecture mission began, and the durations every later checkpoint is compared with. The suites are the parity oracle: each stays green at every checkpoint, and no test is deleted or loosened to make a step pass.

## Suites

| Suite | Command | Size at baseline | Duration |
|---|---|---|---|
| Unit gate | `npm test` (pre, main and post hooks) | 246 programs: 6 before, 222 in `test:unit` (221 at baseline plus the architecture oracles), 16 after, 2 in `posttest` | About 3 minutes on one core |
| Migrations | `npm run test:migrations` | Every migration applied to PostgreSQL 17 | Part of the `verify` job |
| Database resilience | `npm run test:database-resilience` | Outage and recovery against a real server | Part of the `verify` job |
| Multi-instance | `npm run test:multi-instance` | 5 programs, two processes on one database | Part of the `verify` job |
| Exposure store | `npm run test:exposure-store` | 1 program | Part of the `verify` job |
| Audit history | `npm run test:code-audit-history` | 3 programs | Part of the `verify` job |
| Governance lifecycle | `npm run test:governance-lifecycle` | 2 programs | Part of the `verify` job |
| Staging gate | `npm run test:staging:gate` | 4 programs | Part of the `verify` job |
| Release | `npm run test:release` | Archive determinism and contents | Part of the `verify` job |
| Browser | `npm run test:e2e`, desktop and mobile projects | 946 tests in 66 files at baseline (473 per project), plus the 38 DOM-contract tests added in Phase A | Six slices of 7 to 9 minutes each |
| Real browsers | `npm run test:restore-integration`, `npm run test:integration` | Restore integration plus 2 Chromium and WebKit tests | About 3 minutes |

## Continuous integration at baseline

Post-merge run `39124744111` on `3bf017a`, all green:

| Job | Duration |
|---|---|
| `verify` | 4 min 19 s |
| `integration` | 2 min 34 s |
| `browser (1)` to `browser (6)` | 6 min 53 s to 8 min 54 s |
| `release` | 19 s |

## Known baseline properties

- `scripts/audit-production.js` reaches the npm registry. When the registry refuses the audit request, its own test still passes, because the test exercises both outcomes with recorded answers.
- `test/package-release.test.js` refuses an untracked releasable file in the working tree. Run it on a clean tree.
- The browser suite is written for one worker per server. Local runs with three workers have, on occasion, timed out in `code-audit` and the landing scene's motion test; both pass in isolation and in CI.
