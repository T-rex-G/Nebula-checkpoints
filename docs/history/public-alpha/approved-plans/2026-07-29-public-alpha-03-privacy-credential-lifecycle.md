# Public Alpha Privacy and Credential Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider disconnect, alpha-session ending, webhook cleanup, retention, tester data deletion, feedback and support evidence match the public-alpha privacy promise.

**Architecture:** Provider credentials remain inside the existing encrypted server session and are linked to the active alpha tester only through pseudonymous identity bindings. One cleanup service owns disconnect and provider-webhook cleanup; one privacy store owns tester-scoped retention and purge. The application never reports deletion complete while an alpha-created provider resource remains unverified.

**Tech Stack:** Node.js 22, CommonJS, Express 4, PostgreSQL, existing provider adapters and browser cache/IndexedDB APIs.

## Global Constraints

- Inherit every constraint from the master sequence and Plans 1–2.
- “Disconnect from Nebulaverse-X,” “Revoke at provider,” “End alpha session” and “Delete alpha data” remain distinct actions.
- PAT disconnect cannot be described as provider-side revocation.
- No source content, diff, credential, full API payload or private event body enters feedback or a support bundle.
- Provider cleanup failure is a pending state, not success.
- Token-bearing state is removed before a completed deletion response.
- Minimal pseudonymous hash-chain metadata may remain only when removal would invalidate tamper evidence, and the limitation is disclosed before consent.
- Alpha/provider sessions: seven days maximum.
- Verified events: 30 days.
- Operational logs: 14 days where platform controls permit.
- Snapshots and evidence exports: 30 days.
- Invite/revocation metadata: 30 days after cohort close.
- Persistent alpha records use a pseudonymous tester actor label, not a provider login, wherever a human-readable actor field is required.

---

## File structure

**Create:**

- `db/migrations/015_alpha_privacy.sql` — provider bindings, cleanup tasks, feedback, deletion requests and purge reports.
- `src/alpha-privacy.js` — retention policy, support bundle sanitizer, feedback sanitizer and provider revocation guidance.
- `src/alpha-privacy-store.js` — tester binding, retention, deletion and report persistence.
- `src/provider-disconnect.js` — one provider/account cleanup transaction.
- `scripts/alpha-privacy.js` — operator retention, cleanup-status and cohort-close CLI.
- `test/alpha-privacy.test.js`
- `test/alpha-privacy-persistence-contract.test.js`
- `test/alpha-privacy-store.test.js`
- `test/provider-disconnect.test.js`
- `test/alpha-privacy-server-contract.test.js`
- `test/alpha-browser-purge.test.js`
- `test/alpha-privacy-cli.test.js`

**Modify:**

- `server.js` — bind provider identities to testers, use central disconnect, add privacy/feedback/deletion routes.
- `public/app.js`, `public/index.html`, `public/sw.js` — distinct actions and complete local purge.
- `src/governance-api.js`, `src/governance-store.js` and evidence write call sites — use pseudonymous alpha actor presentation for retained records.
- `package.json`, `scripts/verify.js`, `test/migrations.test.js`, `test/package-contract.test.js`.
- `PUBLIC_ALPHA.md`, `ARCHITECTURE.md`, `ARCHITECTURE_DECISIONS.md`.

## Public interfaces

```js
alphaRetentionPolicy() -> frozen retention-day map
alphaActorLabel(alpha) -> "alpha:<12 lowercase hex>"
sanitizeFeedback(input, context) -> safe feedback record
buildSupportBundle(input) -> safe support record
providerRevocationGuidance(account) -> { label, url, automatic }

disconnectProviderAccount(input) -> {
  providerStateRemoved, webhookCleanup, brokerCacheCleared, providerRevoked
}

new AlphaPrivacyStore({ pool, now })
store.bindProviderIdentity(input)
store.createCleanupTask(input)
store.completeCleanupTask(input)
store.createDeletionRequest(input)
store.purgeTester(input)
store.runRetention()
store.recordFeedback(input)
store.cohortClose(input)
```

### Task 1: Define privacy-safe data contracts

**Files:**
- Create: `src/alpha-privacy.js`
- Create: `test/alpha-privacy.test.js`

**Interfaces:**
- Produces the pure retention, pseudonymization, feedback, support and revocation functions.

- [ ] **Step 1: Write the failing privacy test**

Create `test/alpha-privacy.test.js`:

```js
'use strict';
const assert = require('assert');
const {
  alphaRetentionPolicy, alphaActorLabel, sanitizeFeedback,
  buildSupportBundle, providerRevocationGuidance
} = require('../src/alpha-privacy');

assert.deepStrictEqual(alphaRetentionPolicy(), {
  alphaSessionsDays: 7,
  verifiedEventsDays: 30,
  operationalLogsDays: 14,
  snapshotsDays: 30,
  evidenceExportsDays: 30,
  inviteMetadataDaysAfterClose: 30
});
assert.strictEqual(
  alphaActorLabel({ testerId: '12345678-1234-4234-9234-123456789abc' }),
  'alpha:123456781234'
);

const feedback = sanitizeFeedback({
  feature: 'repository-health',
  description: 'The state stayed stale after refresh.',
  repositoryContent: 'private source',
  token: 'ghp_secret',
  providerPayload: { private: true }
}, {
  releaseVersion: '5.3.0-alpha.17.0',
  correlationId: 'nvx-1234567890abcdef',
  provider: 'github',
  capabilityStatus: 'Supported',
  errorCode: 'EVIDENCE_STALE',
  timestamp: '2026-07-29T18:00:00.000Z',
  runtime: 'Safari iOS'
});
assert.strictEqual(feedback.description, 'The state stayed stale after refresh.');
assert(!JSON.stringify(feedback).includes('private source'));
assert(!JSON.stringify(feedback).includes('ghp_secret'));
assert(!JSON.stringify(feedback).includes('providerPayload'));

const bundle = buildSupportBundle({
  releaseVersion: '5.3.0-alpha.17.0',
  correlationId: 'nvx-1234567890abcdef',
  provider: 'github',
  feature: 'repository-health',
  capabilityStatus: 'Supported',
  errorCode: 'EVIDENCE_STALE',
  timestamp: '2026-07-29T18:00:00.000Z',
  runtime: 'Safari iOS',
  description: 'Refresh did not recover.'
});
assert.deepStrictEqual(Object.keys(bundle).sort(), [
  'capabilityStatus', 'correlationId', 'description', 'errorCode',
  'feature', 'provider', 'releaseVersion', 'runtime', 'timestamp'
].sort());

assert.deepStrictEqual(providerRevocationGuidance({
  provider: 'github', authMethod: 'token', baseUrl: ''
}), {
  label: 'Revoke the token on GitHub',
  url: 'https://github.com/settings/tokens',
  automatic: false
});
assert.deepStrictEqual(providerRevocationGuidance({
  provider: 'gitlab', authMethod: 'token', baseUrl: 'https://gitlab.com'
}), {
  label: 'Revoke the token on GitLab',
  url: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  automatic: false
});
console.log('alpha privacy model tests passed');
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node test/alpha-privacy.test.js
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the pure model**

Create `src/alpha-privacy.js`:

```js
'use strict';

const clean = (value, max) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .trim()
  .slice(0, max);

function alphaRetentionPolicy() {
  return Object.freeze({
    alphaSessionsDays: 7,
    verifiedEventsDays: 30,
    operationalLogsDays: 14,
    snapshotsDays: 30,
    evidenceExportsDays: 30,
    inviteMetadataDaysAfterClose: 30
  });
}

function alphaActorLabel(alpha) {
  const compact = String(alpha && alpha.testerId || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new TypeError('alpha testerId is invalid');
  return `alpha:${compact.slice(0, 12)}`;
}

function buildSupportBundle(input) {
  return Object.freeze({
    releaseVersion: clean(input.releaseVersion, 80),
    correlationId: clean(input.correlationId, 80),
    provider: clean(input.provider, 20),
    feature: clean(input.feature, 80),
    capabilityStatus: clean(input.capabilityStatus, 20),
    errorCode: clean(input.errorCode, 80),
    timestamp: new Date(input.timestamp).toISOString(),
    runtime: clean(input.runtime, 200),
    description: clean(input.description, 2000)
  });
}

function sanitizeFeedback(input, context) {
  return buildSupportBundle({
    ...context,
    feature: input.feature,
    description: input.description
  });
}

function providerRevocationGuidance(account) {
  const provider = String(account && account.provider || 'github');
  if (provider === 'github') {
    return Object.freeze({
      label: account && account.authMethod === 'github-app'
        ? 'Manage or uninstall the GitHub App'
        : 'Revoke the token on GitHub',
      url: account && account.authMethod === 'github-app'
        ? 'https://github.com/settings/installations'
        : 'https://github.com/settings/tokens',
      automatic: false
    });
  }
  if (provider === 'gitlab') {
    const base = new URL(account && account.baseUrl || 'https://gitlab.com');
    return Object.freeze({
      label: 'Revoke the token on GitLab',
      url: new URL('/-/user_settings/personal_access_tokens', base).toString(),
      automatic: false
    });
  }
  const base = new URL(account && account.baseUrl);
  return Object.freeze({
    label: 'Revoke the token on Gitea',
    url: new URL('/user/settings/applications', base).toString(),
    automatic: false
  });
}

module.exports = Object.freeze({
  alphaRetentionPolicy, alphaActorLabel, sanitizeFeedback,
  buildSupportBundle, providerRevocationGuidance
});
```

- [ ] **Step 4: Run the model test**

Run:

```bash
node test/alpha-privacy.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/alpha-privacy.js test/alpha-privacy.test.js
git commit -m "feat(alpha): define privacy-safe records"
```

### Task 2: Add privacy, cleanup and deletion persistence

**Files:**
- Create: `db/migrations/015_alpha_privacy.sql`
- Create: `src/alpha-privacy-store.js`
- Create: `test/alpha-privacy-persistence-contract.test.js`
- Create: `test/alpha-privacy-store.test.js`
- Modify: `test/migrations.test.js`

**Interfaces:**
- Associates a tester with provider identity hashes without storing credentials.
- Represents cleanup incompleteness explicitly.

- [ ] **Step 1: Write the failing persistence contract**

Create `test/alpha-privacy-persistence-contract.test.js`:

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '015_alpha_privacy.sql'),
  'utf8'
);
for (const table of [
  'nv_alpha_provider_bindings', 'nv_alpha_cleanup_tasks',
  'nv_alpha_feedback', 'nv_alpha_deletion_requests', 'nv_alpha_purge_reports'
]) assert(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `missing ${table}`);
assert(sql.includes("CHECK (status IN ('pending','verified','failed'))"));
assert(sql.includes("CHECK (status IN ('requested','blocked','complete'))"));
assert(!/token|secret_enc|repository_content/i.test(
  sql.replace(/secret_digest/g, '')
), 'privacy schema must not add token or source-content fields');
console.log('alpha privacy persistence contract tests passed');
```

- [ ] **Step 2: Create the migration**

Create `db/migrations/015_alpha_privacy.sql`:

```sql
CREATE TABLE IF NOT EXISTS nv_alpha_provider_bindings (
  tester_id uuid NOT NULL REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  authority text NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  PRIMARY KEY(tester_id, identity_key)
);
CREATE INDEX IF NOT EXISTS nv_alpha_provider_bindings_identity_idx
  ON nv_alpha_provider_bindings(identity_key, tester_id);

CREATE TABLE IF NOT EXISTS nv_alpha_cleanup_tasks (
  cleanup_id uuid PRIMARY KEY,
  tester_id uuid NOT NULL REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
  resource_type text NOT NULL CHECK (resource_type IN ('provider-webhook','temporary-branch','provider-session')),
  resource_key_hash text NOT NULL CHECK (resource_key_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','verified','failed')),
  reason_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE INDEX IF NOT EXISTS nv_alpha_cleanup_tasks_tester_idx
  ON nv_alpha_cleanup_tasks(tester_id, status, created_at);

CREATE TABLE IF NOT EXISTS nv_alpha_feedback (
  feedback_id uuid PRIMARY KEY,
  tester_id uuid NOT NULL REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  release_version text NOT NULL,
  correlation_id text NOT NULL,
  provider text NOT NULL,
  feature text NOT NULL,
  capability_status text NOT NULL,
  error_code text NOT NULL,
  runtime text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nv_alpha_deletion_requests (
  request_id uuid PRIMARY KEY,
  tester_id uuid NOT NULL REFERENCES nv_alpha_testers(tester_id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('requested','blocked','complete')),
  blocked_cleanup_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS nv_alpha_purge_reports (
  report_id uuid PRIMARY KEY,
  tester_id_hash text NOT NULL CHECK (tester_id_hash ~ '^[0-9a-f]{64}$'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Update `test/migrations.test.js`:

```js
assert.strictEqual(projectMigrations.at(-1).id, '015_alpha_privacy');
```

- [ ] **Step 3: Write store tests**

Create `test/alpha-privacy-store.test.js` with a fake pool and assert:

```js
await store.bindProviderIdentity({
  testerId, identityKey: 'a'.repeat(64),
  provider: 'github', authority: 'github.com'
});
assert(fake.calls.some(call => /nv_alpha_provider_bindings/.test(call.sql)));

const blocked = await store.createDeletionRequest({ testerId });
assert.strictEqual(blocked.status, 'blocked');
assert.strictEqual(blocked.blockedCleanupIds.length, 1);

fake.cleanupTasks[0].status = 'verified';
const complete = await store.purgeTester({ testerId });
assert.strictEqual(complete.status, 'complete');
assert.strictEqual(complete.tokenBearingStateRemoved, true);
assert.strictEqual(complete.retainedIntegrityMetadata, true);
assert(!JSON.stringify(complete).includes('identityKey'));
```

- [ ] **Step 4: Implement `AlphaPrivacyStore`**

The implementation must:

- wrap binding, cleanup completion, deletion and purge transitions in transactions;
- delete `nv_sessions` rows whose `identity_keys` contain tester-bound identities when no other active tester binding shares that identity;
- delete tester-scoped `nv_webhooks`, `nv_intelligence_events`, `nv_recovery_snapshots`, GitHub App installation rows and security state only when no active binding shares the identity;
- retain `nv_evidence_chain` hashes and immutable governance decision/audit rows as disclosed integrity metadata;
- delete feedback after copying only counts and timestamps into the purge report;
- revoke all `nv_alpha_sessions`;
- preserve invite/revocation metadata until the configured cohort-close retention boundary;
- never include identity keys, provider payloads or credentials in a returned purge report.

Use this report shape:

```js
{
  status: 'complete',
  tokenBearingStateRemoved: true,
  providerCleanupVerified: true,
  retainedIntegrityMetadata: true,
  removed: {
    providerSessions: 0,
    webhooks: 0,
    events: 0,
    snapshots: 0,
    feedback: 0
  },
  completedAt: now.toISOString()
}
```

- [ ] **Step 5: Run persistence tests**

Run:

```bash
node test/alpha-privacy-persistence-contract.test.js
node test/alpha-privacy-store.test.js
node test/migrations.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/015_alpha_privacy.sql src/alpha-privacy-store.js test/alpha-privacy-persistence-contract.test.js test/alpha-privacy-store.test.js test/migrations.test.js
git commit -m "feat(alpha): persist privacy and cleanup lifecycle"
```

### Task 3: Centralize provider disconnect and webhook cleanup

**Files:**
- Create: `src/provider-disconnect.js`
- Create: `test/provider-disconnect.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: active provider account, tester, DB, GitHub App broker and provider transport.
- Produces: verified local/provider cleanup outcome.

- [ ] **Step 1: Write failing disconnect tests**

Create `test/provider-disconnect.test.js` with dependency fakes and assert:

```js
const result = await disconnectProviderAccount({
  account: githubPatAccount,
  tester,
  removeProviderWebhook: async () => ({ verifiedAbsent: true }),
  removeInstallationRecord: async () => true,
  invalidateBroker: () => {},
  markBindingDisconnected: async () => true,
  createCleanupTask: async () => { throw new Error('must not create task'); }
});
assert.deepStrictEqual(result, {
  providerStateRemoved: true,
  webhookCleanup: 'verified',
  brokerCacheCleared: true,
  providerRevoked: false,
  revocationGuidance: {
    label: 'Revoke the token on GitHub',
    url: 'https://github.com/settings/tokens',
    automatic: false
  }
});

const pending = await disconnectProviderAccount({
  account: githubPatAccount,
  tester,
  removeProviderWebhook: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); },
  removeInstallationRecord: async () => true,
  invalidateBroker: () => {},
  markBindingDisconnected: async () => true,
  createCleanupTask: async () => 'cleanup-id'
});
assert.strictEqual(pending.webhookCleanup, 'pending');
assert.strictEqual(pending.cleanupId, 'cleanup-id');
```

- [ ] **Step 2: Implement the disconnect service**

Create `src/provider-disconnect.js` exporting:

```js
async function disconnectProviderAccount(options)
```

Rules:

```text
1. Enumerate alpha-created provider webhooks for the tester identity.
2. Delete each provider hook with the still-present credential.
3. Treat provider 404 as verified absent.
4. Verify absence when the provider supports readback.
5. Create a hashed cleanup task for any non-404 failure.
6. Remove the local webhook record only after provider absence is verified.
7. Invalidate GitHub App broker cache and remove local installation state.
8. Mark the provider binding disconnected.
9. Return providerRevoked=false for PAT, OAuth and GitHub App local disconnect.
10. Never include the credential or provider hook ID in the result.
```

- [ ] **Step 3: Replace duplicated account-removal paths**

In `server.js`, call `disconnectProviderAccount()` from:

```text
POST /api/accounts/remove
POST /api/github-app/disconnect
POST /api/logout
POST /api/alpha/providers/disconnect-all
POST /api/alpha/delete
```

Bind a provider identity to `req.alpha.testerId` immediately after successful PAT, OAuth or GitHub App connection:

```js
await alphaPrivacyStore.bindProviderIdentity({
  testerId: req.alpha.testerId,
  identityKey: identityKey(account),
  provider: account.provider || 'github',
  authority: providerAuthority(account)
});
```

- [ ] **Step 4: Use pseudonymous actors for retained alpha records**

Add:

```js
function retainedActor(req) {
  return ALPHA_CONFIG.enabled && req.alpha
    ? alphaActorLabel(req.alpha)
    : String(req.gh && req.gh.login || 'unknown');
}
```

Replace human-readable actor/login values passed into new persistent evidence, snapshots and governance writes with `retainedActor(req)`. Provider transport still uses the real provider account internally.

Add a contract test that rejects direct persistence patterns containing:

```text
actor: req.gh.login
actorLogin: req.gh.login
created_by_login: req.gh.login
```

inside hosted-alpha persistence call sites.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node test/provider-disconnect.test.js
node test/account-boundary.test.js
node test/hardening-contract.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/provider-disconnect.js server.js test/provider-disconnect.test.js
git commit -m "feat(alpha): verify provider disconnect cleanup"
```

### Task 4: Add privacy, feedback and deletion APIs

**Files:**
- Modify: `server.js`
- Create: `test/alpha-privacy-server-contract.test.js`

**Interfaces:**
- `GET /api/alpha/privacy`
- `POST /api/alpha/feedback`
- `POST /api/alpha/providers/disconnect-all`
- `POST /api/alpha/delete`

- [ ] **Step 1: Write the failing server contract**

Create `test/alpha-privacy-server-contract.test.js`:

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
for (const route of [
  "app.get('/api/alpha/privacy'",
  "app.post('/api/alpha/feedback'",
  "app.post('/api/alpha/providers/disconnect-all'",
  "app.post('/api/alpha/delete'"
]) assert(server.includes(route), `missing ${route}`);
assert(server.includes('sanitizeFeedback'));
assert(server.includes('disconnectProviderAccount'));
assert(server.includes('providerCleanupVerified'));
assert(server.includes('ALPHA_DELETION_BLOCKED'));
console.log('alpha privacy server contract tests passed');
```

- [ ] **Step 2: Add the API behavior**

`GET /api/alpha/privacy` returns:

```js
{
  termsVersion: ALPHA_CONFIG.termsVersion,
  retention: alphaRetentionPolicy(),
  retainedIntegrityMetadata: true,
  sourceContentUsedForAnalytics: false
}
```

`POST /api/alpha/feedback` accepts only:

```js
{ feature, description, correlationId, provider, capabilityStatus, errorCode, runtime }
```

and stores only `sanitizeFeedback()` output.

`POST /api/alpha/providers/disconnect-all` disconnects accounts sequentially, purges local provider sessions and returns safe revocation guidance for each provider.

`POST /api/alpha/delete` requires body:

```json
{ "confirm": "DELETE ALPHA DATA" }
```

It must:

1. disconnect provider accounts while credentials still exist;
2. stop and return `409 ALPHA_DELETION_BLOCKED` if any cleanup task is pending;
3. purge tester data;
4. destroy provider and alpha sessions;
5. clear both cookies;
6. return the non-secret purge report.

- [ ] **Step 3: Run the contract**

Run:

```bash
node test/alpha-privacy-server-contract.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js test/alpha-privacy-server-contract.test.js
git commit -m "feat(alpha): add privacy and deletion APIs"
```

### Task 5: Complete browser-side credential and data removal

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/sw.js`
- Create: `test/alpha-browser-purge.test.js`

**Interfaces:**
- Distinct UI actions for local disconnect, provider revocation, alpha-session end and deletion.
- `purgeLocalData()` clears every identity-bound browser store.

- [ ] **Step 1: Write the failing browser purge contract**

Create `test/alpha-browser-purge.test.js`:

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

for (const label of [
  'Disconnect from Nebulaverse-X',
  'Revoke at provider',
  'End alpha session',
  'Delete alpha data'
]) assert(html.includes(label), `missing distinct privacy action: ${label}`);

const start = app.indexOf('async function purgeLocalData');
const end = app.indexOf('async function doLogout', start);
const block = app.slice(start, end);
assert(block.includes("tx.objectStore('queue').clear()"));
assert(block.includes("sessionStorage.clear()"));
assert(block.includes("localStorage.removeItem('nv_me')"));
assert(block.includes('purgePrivateCaches'));
assert(block.includes('state.staged = []'));
assert(block.includes('state.file = null'));
assert(block.includes('clearCsrfToken'));
assert(app.includes('/api/alpha/providers/disconnect-all'));
assert(app.includes('/api/alpha/delete'));
console.log('alpha browser purge tests passed');
```

- [ ] **Step 2: Add the privacy controls**

Add a privacy section to Settings with four distinct actions and provider-specific guidance from the server. Destructive deletion requires a modal with typed `DELETE ALPHA DATA`.

- [ ] **Step 3: Expand `purgeLocalData()`**

In addition to its existing behavior:

```js
sessionStorage.clear();
state.staged = [];
state.file = null;
state.work = null;
state.repos = [];
state.me = null;
```

Tell the active service worker to clear identity caches:

```js
if (navigator.serviceWorker.controller) {
  navigator.serviceWorker.controller.postMessage({ type: 'NV_PURGE_PRIVATE_DATA' });
}
```

Handle that message in `public/sw.js` by deleting only caches whose names start with `nv-api-`; preserve static assets.

- [ ] **Step 4: Run browser boundary tests**

Run:

```bash
node test/alpha-browser-purge.test.js
node test/account-boundary.test.js
node test/offline-cache-policy.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/sw.js test/alpha-browser-purge.test.js
git commit -m "feat(alpha): expose complete disconnect and deletion"
```

### Task 6: Add retention and cohort-close operator commands

**Files:**
- Create: `scripts/alpha-privacy.js`
- Create: `test/alpha-privacy-cli.test.js`
- Modify: `server.js`

**Interfaces:**

```text
node scripts/alpha-privacy.js retention
node scripts/alpha-privacy.js cleanup-status
node scripts/alpha-privacy.js retry-cleanup --cleanup UUID
node scripts/alpha-privacy.js cohort-close --confirm CLOSE-ALPHA
```

- [ ] **Step 1: Write CLI parsing tests**

Assert:

```js
assert.deepStrictEqual(parseArgs(['retention']), { command: 'retention' });
assert.deepStrictEqual(parseArgs(['cleanup-status']), { command: 'cleanup-status' });
assert.deepStrictEqual(parseArgs(['cohort-close', '--confirm', 'CLOSE-ALPHA']), {
  command: 'cohort-close', confirm: 'CLOSE-ALPHA'
});
assert.throws(() => parseArgs(['cohort-close']), /CLOSE-ALPHA/);
```

- [ ] **Step 2: Implement the CLI**

Rules:

- `retention` runs the exact cutoffs from `alphaRetentionPolicy()`;
- `cleanup-status` outputs counts and hashed task references only;
- `retry-cleanup` requires provider credentials through environment variables and never prints them;
- `cohort-close` revokes all testers, verifies no pending cleanup, runs purge, and writes a non-secret report;
- any pending cleanup makes `cohort-close` exit `1`;
- report output contains counts, timestamps and digests, never tester labels, repository names, identity keys or credentials.

- [ ] **Step 3: Start periodic retention only in invite mode**

In `server.js`, run `alphaPrivacyStore.runRetention()` at startup and every 24 hours. Use an unref'd timer and log only counts.

- [ ] **Step 4: Run CLI tests**

Run:

```bash
node test/alpha-privacy-cli.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/alpha-privacy.js test/alpha-privacy-cli.test.js server.js
git commit -m "feat(alpha): automate retention and cohort close"
```

### Task 7: Bind privacy work into build and documentation

**Files:**
- Modify: `package.json`
- Modify: `scripts/verify.js`
- Modify: `test/package-contract.test.js`
- Modify: `PUBLIC_ALPHA.md`
- Modify: `ARCHITECTURE.md`
- Modify: `ARCHITECTURE_DECISIONS.md`

**Interfaces:**
- Produces: full checkpoint failure when privacy files/tests are missing.

- [ ] **Step 1: Add tests and syntax checks**

Add every new test to `test:unit`, and add:

```text
src/alpha-privacy.js
src/alpha-privacy-store.js
src/provider-disconnect.js
scripts/alpha-privacy.js
```

to `check:syntax`.

- [ ] **Step 2: Document the exact privacy promise**

`PUBLIC_ALPHA.md` must distinguish all four user actions, list retention periods and disclose retained pseudonymous integrity metadata.

- [ ] **Step 3: Append ADR-058**

```markdown
## ADR-058 — Provider cleanup is a verified lifecycle and deletion fails closed while cleanup is pending

**Status:** Accepted

Provider disconnect removes token-bearing application state, but it does not falsely claim provider-side PAT/OAuth/App revocation. Alpha-created webhooks and temporary resources must be deleted or verified absent. A failed cleanup creates a non-secret pending task and blocks completed data deletion and cohort close.
```

- [ ] **Step 4: Run the full privacy checkpoint**

Run:

```bash
npm run check:syntax
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/verify.js test/package-contract.test.js PUBLIC_ALPHA.md ARCHITECTURE.md ARCHITECTURE_DECISIONS.md
git commit -m "test(alpha): bind privacy lifecycle checkpoint"
```

## Plan 3 review checkpoint

Review must prove:

- disconnect removes token-bearing application state;
- provider revocation guidance is accurate and safe;
- webhook absence is verified before deletion succeeds;
- pending cleanup is visible and blocks false completion;
- retained human-readable actor fields are alpha-pseudonymous;
- support/feedback data contains no repository content or provider payloads;
- all browser caches, offline writes and identity state are purged;
- retention cutoffs match the published policy;
- cohort close cannot pass with active sessions or cleanup tasks;
- a non-secret deletion report is produced;
- no live provider or Neon mutation occurred without separate authorization.
