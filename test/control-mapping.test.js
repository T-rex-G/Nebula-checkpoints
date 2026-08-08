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
assert.strictEqual(CONTROL_CATALOG.version, '1.2.0');
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
console.log('control mapping tests passed');
