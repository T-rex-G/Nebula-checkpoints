'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { GovernanceStore } = require('../src/governance-store');
const { policyDocumentHash } = require('../src/governance-model');

class Client {
  constructor(steps) { this.steps = [...steps]; }
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const step = this.steps.shift();
    assert(step, `unexpected query: ${text}`);
    if (step.match) assert.match(text, step.match);
    if (step.check) step.check(params);
    return step.result || { rows: [], rowCount: 0 };
  }
  release() {}
}
class Pool { constructor(client) { this.client = client; } connect() { return Promise.resolve(this.client); } query(sql, params) { return this.client.query(sql, params); } }
const policyId = '10000000-0000-4000-8000-000000000001';
const versionId = '20000000-0000-4000-8000-000000000002';
const actor = { identityKey: 'a'.repeat(64), login: 'activator' };
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const documentHash = 'c'.repeat(64);
const noPolicyHash = policyDocumentHash({ schemaVersion: 1, rules: [] });
function simulation(overrides = {}) {
  return {
    schemaVersion: 1, engineVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
    scenarioSetHash: 'd'.repeat(64), resultHash: 'e'.repeat(64), simulationHash: 'f'.repeat(64),
    proposed: { versionId, documentHash },
    baseline: { kind: 'no-policy', versionId: null, documentHash: noPolicyHash },
    summary: { scenarioCount: 1, strengthenedCount: 1, relaxedCount: 0, changedCount: 0 },
    activationReadiness: { eligible: true, blockers: [] },
    ...overrides
  };
}
function input(overrides = {}) {
  const evidence = simulation();
  return {
    policyId, versionId, scope, actor, expectedRevision: 0, reason: 'Activate reviewed policy',
    authorizationEvidence: { accessLevel: 50, providerRole: 'admin', source: 'github.collaborator.permission', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T18:01:00.000Z' },
    simulationEvidence: evidence, expectedSimulationHash: evidence.simulationHash,
    ...overrides
  };
}
(async () => {
  {
    const client = new Client([
      { match: /^BEGIN$/ },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, ['nv-governance-active-set:github:github.com:acme/demo']); } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance:${policyId}`]); } },
      { match: /pg_advisory_xact_lock/, check(params) { assert.deepStrictEqual(params, [`nv-governance-review:${versionId}`]); } },
      { match: /^ROLLBACK$/ }
    ]);
    const times = [new Date('2026-07-22T18:00:30.000Z'), new Date('2026-07-22T18:01:01.000Z')];
    const store = new GovernanceStore(new Pool(client), {
      secret: 'activation-store-secret-0123456789abcdef',
      idFactory: () => crypto.randomUUID(),
      now: () => times.length ? times.shift() : new Date('2026-07-22T18:01:01.000Z')
    });
    await assert.rejects(() => store.activateVersion(input()), error => error.code === 'GOVERNANCE_ACTIVATION_AUTHORIZATION_INVALID');
  }
  {
    const bad = simulation({ baseline: { kind: 'no-policy', versionId: null, documentHash: '0'.repeat(64) } });
    const client = new Client([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ },
      { match: /SELECT v\.\*,p\.scope_key,h\.active_version_id/, result: { rows: [{
        version_id: versionId, policy_id: policyId, version_number: 1, document_hash: documentHash,
        authored_by_identity_key: 'b'.repeat(64), authored_by_login: 'author', required_approvals: 1,
        disallow_author_approval: true, scope_key: 'github:github.com:acme/demo', active_version_id: null,
        active_document_hash: null, revision: 0
      }] } },
      { match: /^ROLLBACK$/ }
    ]);
    const store = new GovernanceStore(new Pool(client), {
      secret: 'activation-store-secret-0123456789abcdef',
      idFactory: () => crypto.randomUUID(),
      now: () => new Date('2026-07-22T18:00:30.000Z')
    });
    await assert.rejects(
      () => store.activateVersion(input({ simulationEvidence: bad, expectedSimulationHash: bad.simulationHash })),
      error => error.code === 'GOVERNANCE_SIMULATION_STALE'
    );
  }
  {
    const client = new Client([
      { match: /^BEGIN$/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ }, { match: /pg_advisory_xact_lock/ },
      { match: /SELECT v\.\*,p\.scope_key,h\.active_version_id/, result: { rows: [{
        version_id: versionId, policy_id: policyId, version_number: 1, document_hash: documentHash,
        authored_by_identity_key: 'b'.repeat(64), authored_by_login: 'author', required_approvals: 1,
        disallow_author_approval: true, scope_key: 'github:github.com:acme/demo', active_version_id: null,
        active_document_hash: null, revision: 0
      }] } },
      { match: /count\(\*\).*active_policy_count/i, result: { rows: [{ active_policy_count: 100 }] } },
      { match: /^ROLLBACK$/ }
    ]);
    const store = new GovernanceStore(new Pool(client), {
      secret: 'activation-store-secret-0123456789abcdef',
      idFactory: () => crypto.randomUUID(),
      now: () => new Date('2026-07-22T18:00:30.000Z')
    });
    await assert.rejects(
      () => store.activateVersion(input()),
      error => error.code === 'GOVERNANCE_ACTIVE_POLICY_LIMIT_REACHED'
    );
  }
  console.log('governance activation store tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
