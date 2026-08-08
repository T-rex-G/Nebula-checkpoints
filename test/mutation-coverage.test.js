'use strict';
const assert = require('assert');
let coverage = {};
try { coverage = require('../src/mutation-coverage'); } catch {}
for (const name of ['MUTATION_ROUTE_INVENTORY','ACTION_EXECUTION_CONTRACTS','executionContractForAction','normalizeFileBatch','summarizeBatchItems','validateCoverageInventory']) {
  assert(coverage[name], `${name} must be implemented`);
}
const { MUTATION_ACTIONS } = require('../src/mutation-gateway');
const {
  MUTATION_ROUTE_INVENTORY, ACTION_EXECUTION_CONTRACTS, executionContractForAction,
  normalizeFileBatch, summarizeBatchItems, validateCoverageInventory
} = coverage;
assert(Object.isFrozen(MUTATION_ROUTE_INVENTORY));
assert(Object.isFrozen(ACTION_EXECUTION_CONTRACTS));
assert.strictEqual(validateCoverageInventory(MUTATION_ACTIONS), true);
for (const route of MUTATION_ROUTE_INVENTORY) {
  assert(MUTATION_ACTIONS[route.action], `inventory action ${route.action} must be registered`);
  assert(['single','composite','batch-atomic','batch-partial'].includes(route.execution.mode));
  assert(Number.isSafeInteger(route.execution.maxProviderWrites) && route.execution.maxProviderWrites >= 0);
}
const batch = normalizeFileBatch([
  { op: 'put', path: 'src/a.js', content: 'a' },
  { op: 'delete', path: 'old.txt' }
]);
assert.strictEqual(batch.items.length, 2);
assert.strictEqual(batch.itemIds.length, 2);
assert(/^[0-9a-f]{64}$/.test(batch.batchHash));
assert(!JSON.stringify(batch.summary).includes('content'));
assert.throws(() => normalizeFileBatch([]), error => error.code === 'MUTATION_BATCH_SIZE');
assert.throws(() => normalizeFileBatch(Array.from({length:101}, (_,i)=>({op:'delete',path:`p${i}`}))), error => error.code === 'MUTATION_BATCH_SIZE');
assert.throws(() => normalizeFileBatch([{op:'delete',path:'a'},{op:'put',path:'a',content:'x'}]), error => error.code === 'MUTATION_BATCH_DUPLICATE_TARGET');
assert.throws(() => normalizeFileBatch([{op:'move',path:'a'}]), error => error.code === 'MUTATION_BATCH_ITEM_INVALID');
assert.throws(() => normalizeFileBatch([{op:'put',path:'a',content:'x'.repeat(2*1024*1024+1)}]), error => error.code === 'MUTATION_BATCH_PAYLOAD_TOO_LARGE');
const refs = summarizeBatchItems('recovery.restore-refs', [
  { action:'reset', name:'main', from:'a'.repeat(40), to:'b'.repeat(40) },
  { action:'recreate', name:'release', from:'', to:'c'.repeat(40) }
]);
assert.strictEqual(refs.itemCount, 2);
assert.strictEqual(refs.itemIds.length, 2);
assert(/^[0-9a-f]{64}$/.test(refs.batchHash));
assert.strictEqual(executionContractForAction('recovery.restore-refs').partialFailure, true);
console.log('mutation coverage tests passed');
