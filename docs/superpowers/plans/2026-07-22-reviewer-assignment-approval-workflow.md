# Task 8 implementation plan

- [x] Add failing review-state model tests.
- [x] Add failing migration and append-only persistence contract tests.
- [x] Add failing store tests for self-claim, author separation, one assignment, current authorization evidence, immutable decision, rejection rationale, terminal state, quorum, scope isolation, concurrency lock, and idempotency.
- [x] Add failing API tests for reviewer role enforcement, browser identity rejection, GitHub App human attribution, review reads, claims, and decisions.
- [x] Add failing server/gateway route contract tests.
- [x] Implement migration 009 and model helpers.
- [x] Implement review store methods and deterministic review read model.
- [x] Implement API methods and exact routes through the Mutation Gateway.
- [x] Run focused tests, broad dependency-free regression, syntax, build, secrets, and package contracts.
- [x] Perform independent read-only security/regression review.
- [x] Update release metadata, roadmap, reports, build evidence, and continuation prompt.
- [x] Build deterministic alpha.7 ZIP twice, compare SHA-256, validate clean extraction, and re-run packaged tests.
