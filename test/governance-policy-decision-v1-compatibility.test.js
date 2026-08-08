'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fixture = require('./fixtures/governance-policy-decision-v1.json');
const { normalizePolicyDecision } = require('../src/governance-enforcement');
const { stableJson } = require('../src/governance-model');

const normalized = normalizePolicyDecision(fixture.decision, fixture.descriptor);
assert.strictEqual(normalized.engineVersion, 1, 'pre-Task-14 decisions must retain engine version 1');
assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized, 'exceptionSetHash'), false, 'legacy evidence must not be rewritten with Task 14 fields');
assert.strictEqual(stableJson(normalized), stableJson(fixture.decision), 'normalization must preserve the exact canonical v1 decision body');
assert.strictEqual(
  crypto.createHash('sha256').update(stableJson(normalized), 'utf8').digest('hex'),
  crypto.createHash('sha256').update(stableJson(fixture.decision), 'utf8').digest('hex'),
  'historical decision hashes must remain stable'
);
console.log('governance policy decision v1 compatibility tests passed');
