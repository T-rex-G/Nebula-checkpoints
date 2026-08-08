'use strict';

const assert = require('assert');
const { createCorrelationId, publicErrorBody } = require('../src/public-errors');

assert.strictEqual(
  createCorrelationId(() => Buffer.from('0123456789abcdef', 'hex')),
  'nvx-0123456789abcdef'
);

const body = publicErrorBody(Object.assign(new Error('Provider refused the write'), {
  code: 'PROVIDER_WRITE_DENIED',
  providerChanged: false,
  safeState: 'The repository is unchanged.',
  nextAction: 'Confirm the provider permission and retry.'
}), { correlationId: 'nvx-0123456789abcdef' });
assert.deepStrictEqual(body, {
  error: 'Provider refused the write',
  code: 'PROVIDER_WRITE_DENIED',
  correlationId: 'nvx-0123456789abcdef',
  providerChanged: 'no',
  safeState: 'The repository is unchanged.',
  nextAction: 'Confirm the provider permission and retry.'
});

for (const unsafeError of [
  Object.assign(new Error('token=ghp_secret\nprivate payload'), { body: { token: 'ghp_secret' } }),
  Object.assign(new Error('Authorization: Bearer private-value'), { code: 'PROVIDER_FAILED' }),
  Object.assign(new Error('password=hunter2'), { code: 'PROVIDER_FAILED' }),
  Object.assign(new Error('postgresql://alpha:secret@example.test/db'), { code: 'DATABASE_FAILED' })
]) {
  const unsafe = publicErrorBody(unsafeError, { correlationId: 'nvx-0123456789abcdef' });
  assert.strictEqual(unsafe.error, 'Operation could not be completed');
  assert(!JSON.stringify(unsafe).includes('ghp_secret'));
  assert(!JSON.stringify(unsafe).includes('hunter2'));
  assert(!JSON.stringify(unsafe).includes('postgresql://'));
  assert.strictEqual(unsafe.providerChanged, 'unknown');
}

const malformed = publicErrorBody(Object.assign(new Error('Safe-looking text'), {
  code: 'lowercase-code',
  providerChanged: true
}), { correlationId: 'browser-supplied' });
assert.strictEqual(malformed.code, 'OPERATION_FAILED');
assert.strictEqual(malformed.error, 'Operation could not be completed');
assert.match(malformed.correlationId, /^nvx-[0-9a-f]{16}$/);
assert.strictEqual(malformed.providerChanged, 'yes');
assert(Object.isFrozen(malformed));

console.log('public error model tests passed');
