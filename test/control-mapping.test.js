'use strict';
const assert = require('assert');
let controls = {};
try { controls = require('../src/control-catalog'); } catch {}
for (const name of ['CONTROL_CATALOG', 'TASK_14_CONTROL_CATALOG', 'LEGACY_CONTROL_CATALOG', 'normalizeControlRefs', 'deriveControlMapping', 'normalizeControlMapping']) {
  assert(controls[name], `${name} must be implemented`);
}
const { CONTROL_CATALOG, TASK_14_CONTROL_CATALOG, LEGACY_CONTROL_CATALOG, normalizeControlRefs, deriveControlMapping, normalizeControlMapping } = controls;
const { MUTATION_ACTIONS } = require('../src/mutation-gateway');
assert.strictEqual(CONTROL_CATALOG.id, 'nebulaverse-control-catalog');
assert.strictEqual(CONTROL_CATALOG.version, '1.4.0');
assert.strictEqual(TASK_14_CONTROL_CATALOG.version, '1.1.0');
assert.strictEqual(LEGACY_CONTROL_CATALOG.id, 'nebulaverse-control-catalog');
assert.strictEqual(LEGACY_CONTROL_CATALOG.version, '1.0.0');
assert.match(CONTROL_CATALOG.hash, /^[0-9a-f]{64}$/);
assert.match(TASK_14_CONTROL_CATALOG.hash, /^[0-9a-f]{64}$/);
assert.match(LEGACY_CONTROL_CATALOG.hash, /^[0-9a-f]{64}$/);
assert.notStrictEqual(CONTROL_CATALOG.hash, TASK_14_CONTROL_CATALOG.hash, 'catalog revisions must have distinct immutable hashes');
assert.notStrictEqual(TASK_14_CONTROL_CATALOG.hash, LEGACY_CONTROL_CATALOG.hash, 'catalog revisions must have distinct immutable hashes');
assert.deepStrictEqual(normalizeControlRefs(['SOC2-TSC:CC8.1', 'SOC2-TSC:CC6.1', 'SOC2-TSC:CC8.1']), ['SOC2-TSC:CC6.1', 'SOC2-TSC:CC8.1']);
assert.throws(() => normalizeControlRefs(['SOC2-TSC:CC99.9']), error => error.code === 'GOVERNANCE_CONTROL_UNKNOWN');

const multi = deriveControlMapping({
  action: 'branch.reset',
  policyEvaluations: [{
    policyId: '10000000-0000-4000-8000-000000000001',
    versionId: '20000000-0000-4000-8000-000000000002',
    matchedRules: [{ id: 'deny-reset', controlRefs: ['SOC2-TSC:CC8.1', 'SOC2-TSC:CC6.1'] }]
  }]
});
assert.strictEqual(multi.status, 'mapped');
assert.deepStrictEqual(multi.controls.map(item => `${item.framework}:${item.controlId}`), ['SOC2-TSC:CC6.1', 'SOC2-TSC:CC8.1']);
assert(multi.controls.every(item => item.relationship === 'supports'));
assert.match(multi.mappingHash, /^[0-9a-f]{64}$/);
assert(Object.isFrozen(multi) && Object.isFrozen(multi.controls));

const historical = deriveControlMapping({
  action: 'branch.reset',
  catalogVersion: '1.0.0',
  policyEvaluations: []
});
assert.strictEqual(historical.catalog.version, '1.0.0');
assert.strictEqual(normalizeControlMapping(historical).mappingHash, historical.mappingHash);

const task14Historical = deriveControlMapping({
  action: 'governance.exception.request',
  catalogVersion: '1.1.0',
  policyEvaluations: []
});
assert.strictEqual(task14Historical.catalog.version, '1.1.0');
assert.strictEqual(normalizeControlMapping(task14Historical).mappingHash, task14Historical.mappingHash);

const reordered = deriveControlMapping({
  action: 'branch.reset',
  policyEvaluations: [{
    policyId: '10000000-0000-4000-8000-000000000001',
    versionId: '20000000-0000-4000-8000-000000000002',
    matchedRules: [{ id: 'deny-reset', controlRefs: ['SOC2-TSC:CC6.1', 'SOC2-TSC:CC8.1'] }]
  }]
});
assert.strictEqual(multi.mappingHash, reordered.mappingHash, 'mapping must be deterministic');

const unmapped = deriveControlMapping({ action: 'repository.star', policyEvaluations: [] });
assert.strictEqual(unmapped.status, 'unmapped');
assert.deepStrictEqual(unmapped.controls, []);
assert(unmapped.unmappedReasons.includes('NO_APPROVED_CONTROL_FOR_ACTION'));


for (const action of Object.keys(MUTATION_ACTIONS).sort()) {
  const mapping = deriveControlMapping({ action, policyEvaluations: [] });
  const expectedUnmapped = action === 'repository.star' || action === 'repository.unstar';
  assert.strictEqual(mapping.status === 'unmapped', expectedUnmapped, `catalog coverage for ${action} must be explicit`);
}

assert.throws(() => normalizeControlMapping({ ...multi, accessToken: 'secret' }), error => error.code === 'POLICY_CONTROL_MAPPING_INVALID');
const tampered = JSON.parse(JSON.stringify(multi));
tampered.controls[0].controlId = 'CC99.9';
assert.throws(() => normalizeControlMapping(tampered), error => error.code === 'POLICY_CONTROL_MAPPING_INVALID');
/*
 * Exposure findings are governable, which means the actions that produce and
 * dispose of them map to controls like every other governed action.
 *
 * The catalog revision matters more here than the mapping does. A stored
 * policy names a catalog version and hash, so revisions are append-only: 1.2.0
 * must still exist, still hash the same, and still contain exactly what it did
 * when somebody's policy was written against it. Adding actions to the current
 * revision rather than editing an old one is what keeps an already-approved
 * policy meaning what its approver agreed to.
 */
const EXPOSURE_ACTIONS = [
  'exposure.scan.request',
  'exposure.scan.cancel',
  'exposure.credential.verify',
  'exposure.readability.probe',
  'exposure.finding.accept-risk',
  'exposure.finding.export'
];
for (const action of EXPOSURE_ACTIONS) {
  const mapping = deriveControlMapping({ action, policyEvaluations: [] });
  assert.strictEqual(mapping.status, 'mapped', `${action} must map to a control`);
  assert.deepStrictEqual(
    mapping.controls.map(item => `${item.framework}:${item.controlId}`),
    ['SOC2-TSC:CC6.1', 'SOC2-TSC:CC8.1'],
    action
  );
}

/* The earlier revisions do not know about them, and must not. */
for (const action of EXPOSURE_ACTIONS) {
  for (const catalogVersion of ['1.0.0', '1.1.0']) {
    const historicalMapping = deriveControlMapping({ action, catalogVersion, policyEvaluations: [] });
    assert.strictEqual(
      historicalMapping.status, 'unmapped',
      `${action} must not appear in catalog ${catalogVersion}: a policy approved against it never covered this`
    );
  }
}

/* And the current catalog lists them, so the document a reviewer reads is the
   document the code uses. */
{
  const listed = new Set(CONTROL_CATALOG.actionMappings.map(item => item.action));
  for (const action of EXPOSURE_ACTIONS) {
    assert(listed.has(action), `the catalog must list ${action}`);
  }
  const previous = new Set(TASK_14_CONTROL_CATALOG.actionMappings.map(item => item.action));
  for (const action of previous) {
    assert(listed.has(action), `a revision may only add: ${action} went missing`);
  }
}

/*
 * Accepting the risk of a live credential is a governance decision, not a
 * repository action, and the binding says so: the actor who accepts must hold
 * a governance role rather than merely being able to read the repository the
 * finding is in.
 */
{
  const { MUTATION_ACTIONS: actions } = require('../src/mutation-gateway');
  assert.strictEqual(actions['exposure.finding.accept-risk'].actorBinding, 'governance');
  assert.strictEqual(actions['exposure.finding.accept-risk'].risk, 'critical');
  /* Using a discovered credential is the highest-risk thing this feature
     does, and the catalog should not pretend otherwise. */
  assert.strictEqual(actions['exposure.credential.verify'].risk, 'high');
  assert.strictEqual(actions['exposure.readability.probe'].risk, 'high');
  /* Asking for a scan is not: it reads a repository the caller can already read. */
  assert.strictEqual(actions['exposure.scan.request'].risk, 'medium');
  assert.strictEqual(actions['exposure.scan.request'].actorBinding, 'execution');
  /* None of them touches a provider write operation. */
  for (const action of EXPOSURE_ACTIONS) {
    assert.deepStrictEqual(actions[action].operations, [], `${action} must perform no provider mutation`);
  }
}

/*
 * 1.4.0 adds clearing an exposure history, and only that. 1.3.0 must still
 * exist, still hash what it hashed, and still not know the new action -- a
 * policy approved against it never covered clearing anything.
 */
{
  const current = CONTROL_CATALOG;
  const previous = controls.TASK_20_CONTROL_CATALOG;
  assert(previous && previous.version === '1.3.0', '1.3.0 must still be published');
  assert.notStrictEqual(current.hash, previous.hash);
  const before = new Set(previous.actionMappings.map(item => item.action));
  const after = new Set(current.actionMappings.map(item => item.action));
  assert.deepStrictEqual([...after].filter(action => !before.has(action)), ['exposure.history.clear'], '1.4.0 adds exactly one action');
  assert.deepStrictEqual([...before].filter(action => !after.has(action)), [], 'a revision may only add');
  for (const action of EXPOSURE_ACTIONS) assert(before.has(action), `1.3.0 still maps ${action}`);

  assert.strictEqual(deriveControlMapping({ action: 'exposure.history.clear', policyEvaluations: [] }).status, 'mapped');
  assert.strictEqual(
    deriveControlMapping({ action: 'exposure.history.clear', catalogVersion: '1.3.0', policyEvaluations: [] }).status,
    'unmapped',
    'a policy approved against 1.3.0 never covered clearing a history'
  );
  const { MUTATION_ACTIONS: actions } = require('../src/mutation-gateway');
  assert.strictEqual(actions['exposure.history.clear'].actorBinding, 'execution', 'a person clears their own record');
  assert.strictEqual(actions['exposure.history.clear'].risk, 'medium', 'irreversible, so not low');
  assert.deepStrictEqual(actions['exposure.history.clear'].operations, []);
}

console.log('control mapping tests passed');
