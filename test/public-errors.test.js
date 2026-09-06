'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

/*
 * A provider's own explanation has to reach the operator.
 *
 * publicErrorBody passes a message through only when the error carries a
 * recognised code. Neither provider helper in server.js attached one, so every
 * refusal GitHub or GitLab took the trouble to explain -- a workflow file
 * rejected for want of scope, a conflict, a rate limit -- arrived as
 * "Operation could not be completed", and an operator staring at that had no
 * way to tell those apart. It cost an hour of guessing at one upload failure.
 *
 * Both halves are asserted here: the message survives when the error is
 * classified, and a message that looks like it carries a credential is still
 * suppressed whether it is classified or not.
 */
const providerReason = 'refusing to allow a Personal Access Token to create or update workflow without workflow scope';

const unclassified = publicErrorBody(Object.assign(new Error(providerReason), { status: 403 }));
assert.strictEqual(
  unclassified.error,
  'Operation could not be completed',
  'an unclassified provider failure is still generic — this is the state the classifier exists to prevent'
);

const classified = publicErrorBody(Object.assign(new Error(providerReason), { status: 403, code: 'PROVIDER_FORBIDDEN' }));
assert.strictEqual(
  classified.error,
  providerReason,
  "a classified provider failure must carry the provider's own reason"
);
assert.strictEqual(classified.code, 'PROVIDER_FORBIDDEN');

const leaky = publicErrorBody(Object.assign(new Error('push failed using token=ghp_examplevalue'), {
  status: 403,
  code: 'PROVIDER_FORBIDDEN'
}));
assert.strictEqual(
  leaky.error,
  'Operation could not be completed',
  'classifying an error must not defeat the credential redaction'
);

/*
 * And the classifier has to be attached where the failures are raised. Both
 * provider helpers construct their error from the response; a code that is not
 * set there never reaches the model above.
 */
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
for (const marker of [
  "err.status = r.status; err.body = data;\n    err.code = providerFailureCode(r.status);",
  "err.status = r.status; err.code = providerFailureCode(r.status); throw err;"
]) {
  assert(server.includes(marker), 'both provider helpers must classify their failures before throwing');
}

console.log('public error model tests passed');
