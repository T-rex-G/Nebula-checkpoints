'use strict';

const assert = require('assert');
let templates = {};
try { templates = require('../src/governance-templates'); } catch {}
for (const name of ['listPolicyTemplates', 'getPolicyTemplate', 'generateRepositoryBaseline', 'TEMPLATE_CATALOG']) {
  assert(templates[name], `${name} must be implemented`);
}
const { listPolicyTemplates, getPolicyTemplate, generateRepositoryBaseline, TEMPLATE_CATALOG } = templates;
const scope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const facts = { schemaVersion: 1, defaultBranch: 'main', protectedBranches: ['main', 'release'], pullRequestsEnabled: true, branchesComplete: true, protectedBranchesTruncated: false };

assert(Object.isFrozen(TEMPLATE_CATALOG));
const listed = listPolicyTemplates();
assert(listed.length >= 3);
assert.deepStrictEqual(listed.map(item => item.templateId), [...listed.map(item => item.templateId)].sort());
assert(listed.every(item => !Object.prototype.hasOwnProperty.call(item, 'document')), 'list response must not expose mutable internal document references');
assert(Object.isFrozen(listed) && Object.isFrozen(listed[0]));

const template = getPolicyTemplate('protected-default-branch');
assert.strictEqual(template.templateId, 'protected-default-branch');
assert.strictEqual(template.document.enforcement.mode, 'observe');
assert.match(template.templateHash, /^[0-9a-f]{64}$/);
assert(Object.isFrozen(template) && Object.isFrozen(template.document));
assert.throws(() => getPolicyTemplate('missing'), error => error.code === 'GOVERNANCE_TEMPLATE_NOT_FOUND' && error.status === 404);

const one = generateRepositoryBaseline({ scope, templateId: 'protected-default-branch', facts });
const two = generateRepositoryBaseline({ facts: { protectedBranchesTruncated: false, branchesComplete: true, pullRequestsEnabled: true, protectedBranches: ['release', 'main'], defaultBranch: 'main', schemaVersion: 1 }, templateId: 'protected-default-branch', scope });
assert.deepStrictEqual(one, two, 'baseline output must be deterministic');
assert.strictEqual(one.scope.scopeKey, 'github:github.com:acme/demo');
assert.strictEqual(one.document.enforcement.mode, 'observe');
assert.strictEqual(one.provenance.templateId, 'protected-default-branch');
assert.strictEqual(one.provenance.factsSource, 'server-resolved');
assert(one.document.rules.some(rule => rule.conditions && rule.conditions.branch === 'release'));
assert.strictEqual(one.readiness.status, 'ready');
assert.match(one.documentHash, /^[0-9a-f]{64}$/);
assert.match(one.baselineHash, /^[0-9a-f]{64}$/);
assert(!JSON.stringify(one).match(/token|password|secret/i));
assert(!Object.prototype.hasOwnProperty.call(one, 'active'));
assert(Object.isFrozen(one));

assert.throws(
  () => generateRepositoryBaseline({ scope, templateId: 'protected-default-branch', facts: { schemaVersion: 1, accessToken: 'github_pat_abcdefghijklmnopqrstuvwxyz' } }),
  error => error.code === 'GOVERNANCE_BASELINE_FACTS_INVALID'
);
assert.throws(
  () => generateRepositoryBaseline({ scope, templateId: 'protected-default-branch', facts: { schemaVersion: 1, protectedBranches: Array(51).fill('main') } }),
  error => error.code === 'GOVERNANCE_BASELINE_FACTS_INVALID'
);
console.log('governance template and baseline tests passed');
