'use strict';

/*
 * The rest of a policy's life, against a real PostgreSQL server.
 *
 * Switching a policy off, archiving it, restoring it, discarding a draft,
 * withdrawing a version and resetting a repository are each a few statements
 * whose correctness belongs to the database: a CHECK that now admits
 * "deactivate", a partial unique index that lets an archived key be reused, a
 * trigger that keeps withdrawals append-only, and an outbox constraint that has
 * to accept every new event type or the whole transaction fails. None of that
 * can be proved against a fake, so this gate needs a server and refuses
 * without one.
 *
 * It drives the service rather than the store, so the simulation evidence each
 * activation needs is the real engine's, not a hand-built object.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client, Pool } = require('pg');

const { loadMigrations, runMigrations } = require('../src/migrations');
const { GovernanceStore } = require('../src/governance-store');
const { createGovernanceApiService } = require('../src/governance-api');
const { DEFAULT_NOTIFICATION_EVENT_TYPES } = require('../src/governance-delivery');

const DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');
const ADMIN_URL = String(process.env.NV_TEST_DATABASE_URL || '').trim();

if (!ADMIN_URL) {
  throw new Error(
    'NV_TEST_DATABASE_URL is required: this gate runs the governance lifecycle against a real PostgreSQL server'
  );
}

function scratchName() {
  return `nvx_governance_lifecycle_${crypto.randomBytes(6).toString('hex')}`;
}
function urlForDatabase(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}
async function withClient(connectionString, run) {
  const client = new Client({ connectionString });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

const key = value => crypto.createHash('sha256').update(value).digest('hex');
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const scopeKey = 'github:github.com:acme/demo';

/* An administrator who writes and activates, and a reviewer who can review and
 * author but not administer. The author of a version cannot approve it, so the
 * two are needed for anything to reach activation at all. */
function authorizationFor(login, level) {
  const identityKey = key(login);
  const now = Date.now();
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey },
    executionPrincipal: { kind: 'user', identityKey, login, authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey, login, verified: true },
    repositoryAccess: {
      baseRole: level >= 50 ? 'admin' : 'maintain', providerRole: level >= 50 ? 'admin' : 'maintain',
      level, source: 'github.collaborator.permission', complete: true
    },
    governanceRoles: { reader: true, author: level >= 30, reviewer: level >= 40, activator: level >= 50, administrator: level >= 50 },
    installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), reasonCode: null }
  };
}
const admin = () => authorizationFor('admin-ada', 50);
const reviewer = () => authorizationFor('reviewer-rey', 40);

const DOCUMENT = { schemaVersion: 1, rules: [{ id: 'deny-reset', action: 'branch.reset', effect: 'deny' }] };
const SECOND_DOCUMENT = { schemaVersion: 1, rules: [{ id: 'deny-merge', action: 'pull.merge', effect: 'deny' }] };
const APPROVAL = { requiredApprovals: 1, disallowAuthorApproval: true };
const SIMULATION = {
  schemaVersion: 1,
  scenarios: [
    { id: 'reset', action: 'branch.reset', attributes: { branch: 'main' } },
    { id: 'merge', action: 'pull.merge', attributes: { branch: 'main' } }
  ]
};

let keyCounter = 0;
const idem = label => `lifecycle-${label}-${++keyCounter}-${crypto.randomUUID()}`;

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.strictEqual(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

(async () => {
  const databaseName = scratchName();
  await withClient(ADMIN_URL, client => client.query(`CREATE DATABASE ${databaseName}`));
  const scratchUrl = urlForDatabase(ADMIN_URL, databaseName);
  const pool = new Pool({ connectionString: scratchUrl, max: 4 });
  try {
    await withClient(scratchUrl, client => runMigrations(client, loadMigrations(DIRECTORY)));
    const store = new GovernanceStore(pool, { secret: 'governance-lifecycle-secret-0123456789abcdef' });
    const service = createGovernanceApiService({ store });
    const call = (method, authorization, extra = {}) => service[method]({ scope, authorization, ...extra });

    /* Everything a version needs to become active: a draft, a submission, an
     * independent approval, and a simulation the engine itself ran. */
    async function proposeVersion(policyId, document) {
      const draft = await call('createDraft', admin(), { policyId, input: { document, approvalPolicy: APPROVAL }, idempotencyKey: idem('draft') });
      const version = await call('submitDraft', admin(), { policyId, draftId: draft.draftId, input: { expectedRevision: 0 }, idempotencyKey: idem('submit') });
      return version;
    }
    async function approve(policyId, versionId) {
      await call('claimReviewer', reviewer(), { policyId, versionId, input: {}, idempotencyKey: idem('claim') });
      await call('recordReviewDecision', reviewer(), { policyId, versionId, input: { decision: 'approve', rationale: 'Reviewed.' }, idempotencyKey: idem('approve') });
    }
    async function switchOn(method, policyId, versionId) {
      const policy = await call('getPolicy', admin(), { policyId });
      const simulation = await call('simulateVersion', admin(), { policyId, versionId, input: SIMULATION });
      assert.strictEqual(simulation.activationReadiness.eligible, true, 'the fixture simulation must be eligible');
      return call(method, admin(), {
        policyId, versionId, idempotencyKey: idem(method),
        input: { expectedRevision: policy.revision, reason: `${method} for the lifecycle test`, simulation: { simulationHash: simulation.simulationHash, request: SIMULATION } }
      });
    }
    const twin = () => call('getPolicyDigitalTwin', admin(), {});
    const enforced = async () => (await store.resolveActivePolicySetInScope({ scope, action: 'branch.reset' })).activePolicies;
    const auditTypes = async policyId => (await pool.query(
      'SELECT event_type,details FROM nv_governance_audit WHERE policy_id=$1 ORDER BY seq ASC', [policyId]
    )).rows;
    const outboxTypes = async () => (await pool.query(
      'SELECT event_type FROM nv_governance_event_outbox WHERE scope_key=$1 ORDER BY event_seq ASC', [scopeKey]
    )).rows.map(row => row.event_type);

    /* ---- A policy that runs --------------------------------------------- */

    const policy = await call('createPolicy', admin(), { input: { policyKey: 'release-safety', name: 'Release safety' }, idempotencyKey: idem('policy') });
    const v1 = await proposeVersion(policy.policyId, DOCUMENT);
    await approve(policy.policyId, v1.versionId);
    await switchOn('activateVersion', policy.policyId, v1.versionId);
    assert.strictEqual((await enforced()).length, 1, 'the activated policy is enforced');

    /* ---- Switching it off ---------------------------------------------- */

    {
      const state = await call('getPolicy', admin(), { policyId: policy.policyId });
      await rejects(call('deactivatePolicy', reviewer(), {
        policyId: policy.policyId, input: { expectedRevision: state.revision, reason: 'Not mine to do.' }, idempotencyKey: idem('off')
      }), 'GOVERNANCE_ROLE_REQUIRED');
      await rejects(call('deactivatePolicy', admin(), {
        policyId: policy.policyId, input: { expectedRevision: state.revision + 5, reason: 'Stale page.' }, idempotencyKey: idem('off')
      }), 'GOVERNANCE_REVISION_CONFLICT');
      await rejects(call('deactivatePolicy', admin(), {
        policyId: policy.policyId, input: { expectedRevision: state.revision, reason: 'x', actorLogin: 'someone-else' }, idempotencyKey: idem('off')
      }), 'GOVERNANCE_LIFECYCLE_IDENTITY_FORBIDDEN');

      const off = await call('deactivatePolicy', admin(), {
        policyId: policy.policyId, input: { expectedRevision: state.revision, reason: 'Pausing enforcement during the migration.' }, idempotencyKey: idem('off')
      });
      assert.strictEqual(off.action, 'deactivate');
      assert.strictEqual(off.previousVersionId, v1.versionId);
      assert.strictEqual(off.revision, state.revision + 1);
      assert.deepStrictEqual(await enforced(), [], 'a switched-off policy enforces nothing');

      const row = (await pool.query(
        `SELECT action,version_id,previous_version_id FROM nv_governance_activations WHERE activation_id=$1`, [off.activationId]
      )).rows[0];
      assert.deepStrictEqual(row, { action: 'deactivate', version_id: v1.versionId, previous_version_id: v1.versionId });

      const view = await twin();
      const entry = view.current.policies.find(item => item.policyId === policy.policyId);
      assert.strictEqual(entry.active, null);
      assert.deepStrictEqual(entry.switchedOff, { versionId: v1.versionId, versionNumber: 1 });
      assert(!view.proposed.versions.some(item => item.versionId === v1.versionId),
        'a version that already ran is not offered as proposed; it is offered as "turn back on"');
      assert(view.history.activations.some(item => item.action === 'deactivate'));

      await rejects(call('deactivatePolicy', admin(), {
        policyId: policy.policyId, input: { expectedRevision: off.revision, reason: 'Again.' }, idempotencyKey: idem('off')
      }), 'GOVERNANCE_POLICY_NOT_ACTIVE');

      /* Turning it back on is the rollback workflow, simulated against no policy. */
      const on = await switchOn('rollbackVersion', policy.policyId, v1.versionId);
      assert.strictEqual(on.action, 'rollback');
      assert.strictEqual((await enforced()).length, 1);
    }

    /* ---- Withdrawing a version that never ran --------------------------- */

    {
      const v2 = await proposeVersion(policy.policyId, SECOND_DOCUMENT);
      await rejects(call('withdrawVersion', reviewer(), {
        policyId: policy.policyId, versionId: v2.versionId, input: { reason: 'Not my version.' }, idempotencyKey: idem('withdraw')
      }), 'GOVERNANCE_VERSION_NOT_OWNED');
      const withdrawn = await call('withdrawVersion', admin(), {
        policyId: policy.policyId, versionId: v2.versionId, input: { reason: 'Superseded before review.' }, idempotencyKey: idem('withdraw')
      });
      assert.strictEqual(withdrawn.withdrawn, true);
      await rejects(call('withdrawVersion', admin(), {
        policyId: policy.policyId, versionId: v2.versionId, input: { reason: 'Twice.' }, idempotencyKey: idem('withdraw')
      }), 'GOVERNANCE_VERSION_WITHDRAWN');
      await rejects(call('claimReviewer', reviewer(), {
        policyId: policy.policyId, versionId: v2.versionId, input: {}, idempotencyKey: idem('claim')
      }), 'GOVERNANCE_VERSION_WITHDRAWN');
      await rejects(switchOn('activateVersion', policy.policyId, v2.versionId), 'GOVERNANCE_VERSION_WITHDRAWN');
      await rejects(call('withdrawVersion', admin(), {
        policyId: policy.policyId, versionId: v1.versionId, input: { reason: 'It ran.' }, idempotencyKey: idem('withdraw')
      }), 'GOVERNANCE_VERSION_FINALIZED');
      const view = await twin();
      assert(!view.proposed.versions.some(item => item.versionId === v2.versionId), 'a withdrawn version is not proposed');

      /* The ledger is append-only for withdrawals too. */
      await assert.rejects(pool.query('UPDATE nv_governance_version_withdrawals SET created_at=now()'), /append-only/);
      await assert.rejects(pool.query('DELETE FROM nv_governance_version_withdrawals'), /append-only/);
    }

    /* ---- Discarding drafts ---------------------------------------------- */

    {
      const mine = await call('createDraft', reviewer(), { policyId: policy.policyId, input: { document: SECOND_DOCUMENT, approvalPolicy: APPROVAL }, idempotencyKey: idem('draft') });
      const theirs = await call('createDraft', admin(), { policyId: policy.policyId, input: { document: DOCUMENT, approvalPolicy: APPROVAL }, idempotencyKey: idem('draft') });
      await rejects(call('discardDraft', reviewer(), {
        policyId: policy.policyId, draftId: theirs.draftId, input: { expectedRevision: 0 }, idempotencyKey: idem('discard')
      }), 'GOVERNANCE_DRAFT_NOT_OWNED');
      await rejects(call('discardDraft', reviewer(), {
        policyId: policy.policyId, draftId: mine.draftId, input: { expectedRevision: 3 }, idempotencyKey: idem('discard')
      }), 'GOVERNANCE_DRAFT_REVISION_CONFLICT');
      await call('discardDraft', reviewer(), { policyId: policy.policyId, draftId: mine.draftId, input: { expectedRevision: 0 }, idempotencyKey: idem('discard') });
      /* An administrator can clear somebody else's stale draft. */
      await call('discardDraft', admin(), { policyId: policy.policyId, draftId: theirs.draftId, input: { expectedRevision: 0 }, idempotencyKey: idem('discard') });
      assert.strictEqual((await twin()).proposed.draftCount, 0);
    }

    /* ---- Archiving, reusing the key, restoring -------------------------- */

    {
      const state = await call('getPolicy', admin(), { policyId: policy.policyId });
      await rejects(call('archivePolicy', reviewer(), {
        policyId: policy.policyId, input: { expectedRevision: state.revision, reason: 'No.' }, idempotencyKey: idem('archive')
      }), 'GOVERNANCE_ROLE_REQUIRED');
      const archived = await call('archivePolicy', admin(), {
        policyId: policy.policyId, input: { expectedRevision: state.revision, reason: 'Replaced by the new release process.' }, idempotencyKey: idem('archive')
      });
      assert.strictEqual(archived.deactivated, true, 'archiving a running policy switches it off first');
      assert.deepStrictEqual(await enforced(), []);
      assert.strictEqual((await twin()).current.policyCount, 0, 'an archived policy leaves the twin');
      const list = await call('listArchivedPolicies', admin(), {});
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].policyKey, 'release-safety');
      assert.strictEqual(list[0].keyInUse, false);
      const types = (await auditTypes(policy.policyId)).map(row => row.event_type);
      assert.deepStrictEqual(types.slice(-2), ['policy.deactivated', 'policy.archived']);

      /* The key is free again ... */
      const replacement = await call('createPolicy', admin(), { input: { policyKey: 'release-safety', name: 'Release safety v2' }, idempotencyKey: idem('policy') });
      assert.strictEqual((await call('listArchivedPolicies', admin(), {}))[0].keyInUse, true);
      /* ... so restoring the old one has to wait until the new one steps aside. */
      await rejects(call('restorePolicy', admin(), {
        policyId: policy.policyId, input: { reason: 'Bring it back.' }, idempotencyKey: idem('restore')
      }), 'GOVERNANCE_POLICY_KEY_IN_USE');
      /* And a live key still cannot be taken twice. */
      await rejects(call('createPolicy', admin(), { input: { policyKey: 'release-safety', name: 'Third' }, idempotencyKey: idem('policy') }), 'GOVERNANCE_POLICY_EXISTS');

      const replacementState = await call('getPolicy', admin(), { policyId: replacement.policyId });
      await call('archivePolicy', admin(), {
        policyId: replacement.policyId, input: { expectedRevision: replacementState.revision, reason: 'Trial over.' }, idempotencyKey: idem('archive')
      });
      const restored = await call('restorePolicy', admin(), {
        policyId: policy.policyId, input: { reason: 'The old process is back.' }, idempotencyKey: idem('restore')
      });
      assert.deepStrictEqual(restored, { policyId: policy.policyId, restored: true, active: false });
      const view = await twin();
      const entry = view.current.policies.find(item => item.policyId === policy.policyId);
      assert(entry && entry.active === null, 'a restored policy comes back switched off');
      assert.deepStrictEqual(entry.switchedOff, { versionId: v1.versionId, versionNumber: 1 });
      await rejects(call('restorePolicy', admin(), {
        policyId: policy.policyId, input: { reason: 'Twice.' }, idempotencyKey: idem('restore')
      }), 'GOVERNANCE_POLICY_NOT_FOUND');
      await switchOn('rollbackVersion', policy.policyId, v1.versionId);
    }

    /* ---- Resetting the repository --------------------------------------- */

    {
      const quiet = await call('createPolicy', admin(), { input: { policyKey: 'quiet-policy', name: 'Never switched on' }, idempotencyKey: idem('policy') });
      await rejects(call('resetGovernance', admin(), { input: { reason: 'Start again.', confirm: 'acme/other' }, idempotencyKey: idem('reset') }), 'GOVERNANCE_RESET_CONFIRMATION_REQUIRED');
      await rejects(call('resetGovernance', reviewer(), { input: { reason: 'Start again.', confirm: 'Acme/Demo' }, idempotencyKey: idem('reset') }), 'GOVERNANCE_ROLE_REQUIRED');
      await rejects(call('resetGovernance', admin(), { input: { reason: 'Start again.', confirm: 'Acme/Demo' } }), 'GOVERNANCE_IDEMPOTENCY_KEY_REQUIRED');

      const resetKey = idem('reset');
      const reset = await call('resetGovernance', admin(), { input: { reason: 'Start again from the baseline.', confirm: 'acme/demo' }, idempotencyKey: resetKey });
      assert.strictEqual(reset.archivedCount, 2);
      assert.strictEqual(reset.deactivatedCount, 1);
      /* The same key replays the same answer instead of resetting twice. */
      assert.deepStrictEqual(
        await call('resetGovernance', admin(), { input: { reason: 'Start again from the baseline.', confirm: 'acme/demo' }, idempotencyKey: resetKey }),
        reset
      );
      assert.deepStrictEqual(await enforced(), []);
      assert.strictEqual((await twin()).current.policyCount, 0);
      assert.strictEqual((await call('listArchivedPolicies', admin(), {})).length, 3);
      for (const id of [policy.policyId, quiet.policyId]) {
        const last = (await auditTypes(id)).at(-1);
        assert.strictEqual(last.event_type, 'policy.archived');
        assert.strictEqual(last.details.resetId, reset.resetId, 'every record of a reset names the reset');
      }
      /* Nothing about the history was removed to get here. */
      const audit = await store.verifyAudit(policy.policyId);
      assert.strictEqual(audit.valid, true, 'the audit chain still verifies after a reset');
    }

    /* ---- Delivery accepts every new event type -------------------------- */

    {
      const seen = new Set(await outboxTypes());
      for (const type of ['policy.deactivated', 'policy.archived', 'policy.restored', 'draft.discarded', 'version.withdrawn']) {
        assert(seen.has(type), `the outbox must carry ${type}`);
      }
      /* The default subscription is every type but "allow" -- longer than the
       * old bound of fifteen, which the migration had to lift. */
      assert(DEFAULT_NOTIFICATION_EVENT_TYPES.length > 15);
      await call('updateNotificationPreferences', admin(), {
        input: { enabled: true, eventTypes: DEFAULT_NOTIFICATION_EVENT_TYPES }, idempotencyKey: idem('prefs')
      });
    }

    console.log('governance lifecycle postgres tests passed');
  } finally {
    await pool.end();
    await withClient(ADMIN_URL, client => client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`));
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
