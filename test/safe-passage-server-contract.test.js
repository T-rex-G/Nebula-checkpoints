'use strict';

/*
 * Safe Passage only means something if the refusal path actually consults it,
 * and it is only safe if the policy set it consults is read without being
 * written. Both are bound here, because a module that offers routes nobody
 * asks for, or a resolver that quietly appends a decision for a mutation
 * nobody performed, would each fail silently.
 */

const assert = require('assert');

const { publicErrorBody } = require('../apps/api/src/http/errors.ts');

const { GovernanceStore } = require('../apps/api/src/modules/kepler/index.ts');
const { offerSafePassage, ROUTABLE_ACTIONS } = require('../apps/api/src/platform/mutation-gateway/safe-passage.ts');

/*
 * The refusal path consults it: the repository mutation context offers a
 * route to approval for an approval refusal of a write whose content is in
 * hand, and for nothing else; a failure while building the offer means no
 * offer, never another answer (test/mutation-context.test.js). The central
 * failure answer sends the offer beside the unchanged error body
 * (test/github-rest.test.js). That the composed server's writes pass through
 * this context is test/composition.test.js's.
 */

/* The public error contract itself is untouched: the route rides beside it, not
 * inside it, so every other refusal answers exactly as it did. */
{
  const refusal = Object.assign(new Error('Approval is required'), {
    code: 'POLICY_APPROVAL_REQUIRED', status: 403, safePassage: { action: 'pull.merge' }
  });
  assert(!Object.hasOwn(publicErrorBody(refusal), 'safePassage'),
    'the public error body must not gain a safe passage field, even from an error that carries one');
}

/*
 * The resolver reads the active policy set and writes nothing. Asking the
 * runtime evaluator instead would append a decision to the hash chain for a
 * mutation that was never performed. That it reads in one read-only
 * transaction, writes nothing, takes no lock and mints no identifier is asked
 * of it, every statement it sends seen, by
 * test/governance-lifecycle-postgres.test.js.
 */
assert.strictEqual(
  typeof GovernanceStore.prototype.resolveActivePolicySetInScope,
  'function',
  'the store must expose a read-only active policy set resolver'
);

/* Only actions whose payload is wholly in hand at refusal are routable. */
assert.deepStrictEqual([...ROUTABLE_ACTIONS], ['file.write']);

/* An offer is never built from a refusal that was not an approval refusal. */
for (const blockCode of ['POLICY_MUTATION_BLOCKED', 'POLICY_EVALUATION_UNAVAILABLE', 'POLICY_UNSUPPORTED_ACTIVE_RULES', '']) {
  const offer = offerSafePassage({ descriptor: null, blockCode, content: 'x' });
  assert.strictEqual(offer.available, false, `${blockCode || '(none)'} must not produce an offer`);
}

console.log('safe passage server contract tests passed');
