'use strict';

/* API retries and active-set admission need real transactions and locks. */
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client, Pool } = require('pg');
const { loadMigrations, runMigrations } = require('../src/migrations');
const { GovernanceStore } = require('../src/governance-store');
const { createGovernanceApiService } = require('../src/governance-api');
const { normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { createGovernanceRuntime } = require('../src/governance-enforcement');

const ADMIN_URL = String(process.env.NV_TEST_DATABASE_URL || '').trim();
if (!ADMIN_URL) throw new Error('NV_TEST_DATABASE_URL is required for governance activation PostgreSQL tests');
const scope = { provider: 'github', owner: 'Acme', repo: 'Activation' };
const scopeKey = 'github:github.com:acme/activation';
const key = value => crypto.createHash('sha256').update(value).digest('hex');
function authorizationFor(login, level = 50, targetScope = scope) {
  const identityKey = key(login);
  const now = Date.now();
  return {
    schemaVersion: 1,
    scope: { ...targetScope, authority: 'github.com', scopeKey: `github:github.com:${targetScope.owner.toLowerCase()}/${targetScope.repo.toLowerCase()}` },
    executionPrincipal: { kind: 'user', identityKey, login, authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey, login, verified: true },
    repositoryAccess: { baseRole: level === 50 ? 'admin' : 'maintain', providerRole: level === 50 ? 'admin' : 'maintain', level, source: 'github.collaborator.permission', complete: true },
    governanceRoles: { reader: true, author: true, reviewer: true, activator: level === 50, administrator: level === 50 },
    installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), reasonCode: null }
  };
}
const DOCUMENT = { schemaVersion: 1, enforcement: { mode: 'block' }, rules: [{ id: 'deny-write', action: 'file.write', effect: 'deny' }] };
const SCENARIOS = { schemaVersion: 1, scenarios: [{ id: 'write', action: 'file.write', attributes: { branch: 'main', path: 'README.md' } }] };
const actor = { identityKey: key('author'), login: 'author' };
const idem = () => crypto.randomUUID();
const json = value => JSON.parse(JSON.stringify(value));
const rejects = (promise, code) => assert.rejects(promise, error => {
  assert.strictEqual(error.code, code, `${error.code}: ${error.message}`);
  return true;
});

(async () => {
  const database = `nvx_governance_activation_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const scratch = new URL(ADMIN_URL);
  scratch.pathname = `/${database}`;
  const pool = new Pool({ connectionString: scratch.toString(), max: 4 });
  try {
    const client = await pool.connect();
    try { await runMigrations(client, loadMigrations(path.join(__dirname, '../db/migrations'))); }
    finally { client.release(); }
    const store = new GovernanceStore(pool, { secret: 'activation-postgres-secret-0123456789abcdef' });
    const service = createGovernanceApiService({ store });
    const call = (method, input, login = 'author', level = 50) => service[method]({ scope, authorization: authorizationFor(login, level), ...input });
    async function versionFor(policyId) {
      const version = await store.createVersion({ policyId, actor, document: { ...DOCUMENT, description: `Reviewed version ${crypto.randomUUID()}` }, approvalPolicy: { requiredApprovals: 1, disallowAuthorApproval: true } });
      const refs = { policyId, versionId: version.versionId };
      await call('claimReviewer', { ...refs, input: {} }, 'reviewer', 40);
      await call('recordReviewDecision', { ...refs, input: { decision: 'approve', rationale: 'Reviewed fixture' } }, 'reviewer', 40);
      return refs;
    }
    async function create(name) {
      const policy = await call('createPolicy', { input: { policyKey: name, name } });
      return versionFor(policy.policyId);
    }
    async function activationRequest(refs) {
      const policy = await call('getPolicy', refs);
      const simulation = await call('simulateVersion', { ...refs, input: SCENARIOS });
      return { ...refs, idempotencyKey: idem(), input: { expectedRevision: policy.revision, reason: 'Activate reviewed fixture', simulation: { simulationHash: simulation.simulationHash, request: SCENARIOS } } };
    }
    async function switchOff(refs) {
      const policy = await call('getPolicy', refs);
      return call('deactivatePolicy', { ...refs, idempotencyKey: idem(), input: { expectedRevision: policy.revision, reason: 'Pause fixture' } });
    }
    const activeSet = () => store.resolveActivePolicySetInScope({ scope, action: 'file.write' });

    const target = await create('reactivation-target');
    const firstRequest = await activationRequest(target);
    const first = await call('activateVersion', firstRequest);
    assert.deepStrictEqual(json(await call('activateVersion', firstRequest)), json(first), 'lost activation responses must be replayable after the head changes');
    for (const altered of [
      { ...firstRequest, input: { ...firstRequest.input, reason: 'Changed reason' } },
      { ...firstRequest, input: { ...firstRequest.input, expectedRevision: 91 } },
      { ...firstRequest, versionId: crypto.randomUUID() },
      { ...firstRequest, policyId: crypto.randomUUID() },
      { ...firstRequest, input: { ...firstRequest.input, simulation: { ...firstRequest.input.simulation, simulationHash: 'f'.repeat(64) } } },
      { ...firstRequest, input: { ...firstRequest.input, simulation: { ...firstRequest.input.simulation, request: { schemaVersion: 1, scenarios: [{ id: 'different', action: 'issue.create' }] } } } }
    ]) await rejects(call('activateVersion', altered), 'GOVERNANCE_IDEMPOTENCY_CONFLICT');
    await rejects(call('activateVersion', firstRequest, 'another-admin'), 'GOVERNANCE_REVISION_CONFLICT');
    const otherScope = { ...scope, repo: 'Other' };
    await rejects(service.activateVersion({ ...firstRequest, scope: otherScope, authorization: authorizationFor('author', 50, otherScope) }), 'GOVERNANCE_VERSION_NOT_FOUND');
    const stale = authorizationFor('author');
    stale.evidence.fetchedAt = new Date(Date.now() - 120000).toISOString();
    stale.evidence.expiresAt = new Date(Date.now() - 60000).toISOString();
    await rejects(service.activateVersion({ ...firstRequest, scope, authorization: stale }), 'GOVERNANCE_AUTHORIZATION_STALE');

    const replacement = await versionFor(target.policyId);
    const replaceRequest = await activationRequest(replacement);
    const concurrent = await Promise.all([call('activateVersion', replaceRequest), call('activateVersion', replaceRequest)]);
    assert.deepStrictEqual(json(concurrent[0]), json(concurrent[1]), 'concurrent activation retries return one receipt');
    const rollbackRequest = await activationRequest(target);
    const rollbacks = await Promise.all([call('rollbackVersion', rollbackRequest), call('rollbackVersion', rollbackRequest)]);
    assert.deepStrictEqual(json(rollbacks[0]), json(rollbacks[1]), 'concurrent rollback retries return one receipt');
    assert.deepStrictEqual(json(await call('rollbackVersion', rollbackRequest)), json(rollbacks[0]));
    assert.deepStrictEqual(json(await call('activateVersion', firstRequest)), json(first), 'old receipts remain replayable after later transitions');
    const ledger = await pool.query('SELECT count(*)::int AS count FROM nv_governance_activations WHERE policy_id=$1', [target.policyId]);
    assert.strictEqual(ledger.rows[0].count, 3, 'retries do not append duplicate activations');
    await switchOff(target);

    /* Newest-first evidence stays stable while new decisions are appended;
     * the existing ascending API remains available for ledger consumers. */
    const emit = async (targetScope = scope) => {
      const authorization = authorizationFor('author', 50, targetScope);
      const descriptor = normalizeMutationDescriptor({ ...targetScope, actorIdentityKey: actor.identityKey, actorLogin: actor.login, action: 'file.write', method: 'PUT', route: '/api/repo/:owner/:repo/file', authorization, metadata: { branch: 'main', path: 'README.md' } });
      return store.evaluateAndAppendPolicyDecision({ scope: targetScope, descriptor });
    };
    const initialIds = [];
    for (let index = 0; index < 12; index += 1) {
      initialIds.push((await emit()).decisionId);
      if (index % 3 === 0) await emit(otherScope);
    }
    const chronological = await call('listPolicyDecisions', { afterSeq: 0, limit: 50 });
    assert.deepStrictEqual(chronological.decisions.map(item => item.decisionId), initialIds, 'legacy ascending pages remain scoped and ordered');
    const initialSeqs = chronological.decisions.map(item => item.seq);
    const initialTwin = await call('getPolicyDigitalTwin', { historyLimit: 5 });
    assert.strictEqual(initialTwin.history.decisionOrder, 'desc');
    assert.deepStrictEqual(initialTwin.history.decisions.map(item => item.seq), initialSeqs.slice(-5).reverse(), 'the twin must initially show the latest decisions');
    assert.strictEqual(initialTwin.history.nextDecisionSeq, null);
    assert.strictEqual(initialTwin.history.nextBeforeDecisionSeq, initialSeqs.at(-5));
    assert.strictEqual(initialTwin.freshness.completeness.decisions, false);
    const arriving = await emit();
    const seenSeqs = initialTwin.history.decisions.map(item => item.seq);
    let beforeSeq = initialTwin.history.nextBeforeDecisionSeq;
    while (beforeSeq != null) {
      const page = await call('listPolicyDecisions', { beforeSeq, limit: 5 });
      assert(page.decisions.every(item => item.seq < beforeSeq));
      assert(!page.decisions.some(item => item.decisionId === arriving.decisionId));
      seenSeqs.push(...page.decisions.map(item => item.seq));
      beforeSeq = page.nextBeforeSeq;
      assert.strictEqual(page.complete, beforeSeq == null);
    }
    assert.deepStrictEqual(seenSeqs, [...initialSeqs].reverse(), 'older pages have no gaps or duplicates despite concurrent appends and other scopes');
    const completeTwin = await call('getPolicyDigitalTwin', { historyLimit: 50 });
    assert.strictEqual(completeTwin.history.nextBeforeDecisionSeq, null, 'a complete page must not advertise more evidence');
    assert.strictEqual(completeTwin.freshness.completeness.decisions, true);
    const olderTwin = await call('getPolicyDigitalTwin', { historyLimit: 5, beforeDecisionSeq: initialSeqs.at(-5) });
    assert.deepStrictEqual(olderTwin.history.decisions.map(item => item.seq), initialSeqs.slice(2, 7).reverse());
    const legacyTwin = await call('getPolicyDigitalTwin', { historyLimit: 5, afterDecisionSeq: 0 });
    assert.strictEqual(legacyTwin.history.decisionOrder, 'asc');
    assert.deepStrictEqual(legacyTwin.history.decisions.map(item => item.seq), initialSeqs.slice(0, 5));
    assert.strictEqual(legacyTwin.history.nextDecisionSeq, initialSeqs[4]);
    assert.strictEqual(legacyTwin.history.nextBeforeDecisionSeq, null);
    const exhausted = await call('listPolicyDecisions', { beforeSeq: 0 });
    assert.deepStrictEqual(exhausted.decisions, []);
    assert.strictEqual(exhausted.nextBeforeSeq, null);
    for (const beforeSeq of ['1e3', '0x10', '1.2', '-1', '9007199254740992', [], true]) {
      await rejects(call('listPolicyDecisions', { beforeSeq }), 'GOVERNANCE_CURSOR_INVALID');
    }
    await rejects(call('listPolicyDecisions', { beforeSeq: 5, afterSeq: 0 }), 'GOVERNANCE_CURSOR_INVALID');
    await rejects(call('getPolicyDigitalTwin', { beforeDecisionSeq: 5, afterDecisionSeq: 0 }), 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');

    // Failed fresh requests must retain simulation and revision enforcement.
    const badHash = await activationRequest(target);
    badHash.input.simulation.simulationHash = 'f'.repeat(64);
    await rejects(call('rollbackVersion', badHash), 'GOVERNANCE_SIMULATION_MISMATCH');
    const missingRules = { schemaVersion: 1, scenarios: [{ id: 'unrelated', action: 'issue.create' }] };
    const blocked = await call('simulateVersion', { ...target, input: missingRules });
    const blockedRequest = await activationRequest(target);
    blockedRequest.input.simulation = { simulationHash: blocked.simulationHash, request: missingRules };
    await rejects(call('rollbackVersion', blockedRequest), 'GOVERNANCE_SIMULATION_BLOCKED');

    const fillers = [];
    for (let index = 0; index < 100; index += 1) {
      const refs = await create(`filler-${String(index).padStart(3, '0')}`);
      await call('activateVersion', await activationRequest(refs));
      fillers.push(refs);
    }
    assert.strictEqual((await activeSet()).activePolicies.length, 100);
    await rejects(call('rollbackVersion', await activationRequest(target)), 'GOVERNANCE_ACTIVE_POLICY_LIMIT_REACHED');
    assert.strictEqual((await activeSet()).activePolicies.length, 100, 'refused reactivation leaves all active policies evaluable');
    await switchOff(fillers[0]);
    const newcomer = await create('newcomer');
    const [resumeRequest, newRequest] = await Promise.all([activationRequest(target), activationRequest(newcomer)]);
    const admission = await Promise.allSettled([call('rollbackVersion', resumeRequest), call('activateVersion', newRequest)]);
    assert.strictEqual(admission.filter(item => item.status === 'fulfilled').length, 1, 'only one concurrent transition may claim the last active-policy slot');
    assert.strictEqual(admission.find(item => item.status === 'rejected').reason.code, 'GOVERNANCE_ACTIVE_POLICY_LIMIT_REACHED');
    const existingReplacement = await versionFor(fillers[1].policyId);
    await call('activateVersion', await activationRequest(existingReplacement));
    await call('rollbackVersion', await activationRequest(fillers[1]));
    assert.strictEqual((await activeSet()).activePolicies.length, 100, 'replacing an active version does not consume another slot');
    const descriptor = normalizeMutationDescriptor({ ...scope, actorIdentityKey: actor.identityKey, actorLogin: actor.login, action: 'file.write', method: 'PUT', route: '/api/repo/:owner/:repo/file', authorization: authorizationFor('author'), metadata: { branch: 'main', path: 'README.md' } });
    const decision = await createGovernanceRuntime({ store }).evaluate(descriptor);
    assert.strictEqual(decision.source, 'active-policy-set');
    assert.strictEqual(decision.enforcementOutcome, 'block', 'active policies still enforce their deny rules at capacity');
    assert.strictEqual((await store.verifyAudit(target.policyId)).valid, true);
    console.log('governance activation postgres tests passed');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
