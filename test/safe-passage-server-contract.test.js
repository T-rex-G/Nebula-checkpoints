'use strict';

/*
 * Safe Passage only means something if the refusal path actually consults it,
 * and it is only safe if the policy set it consults is read without being
 * written. Both are bound here, because a module that offers routes nobody
 * asks for, or a resolver that quietly appends a decision for a mutation
 * nobody performed, would each fail silently.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src', 'governance-store.js'), 'utf8');
const publicErrors = fs.readFileSync(path.join(root, 'src', 'public-errors.js'), 'utf8');

const { GovernanceStore } = require('../src/governance-store');
const { offerSafePassage, ROUTABLE_ACTIONS } = require('../src/safe-passage');

assert(server.includes("require('./src/safe-passage')"), 'server must load the safe passage module');
assert(
  server.includes('const passage = await safePassageFor(req, action, descriptor, error);'),
  'the refusal path must consult safe passage before answering'
);
assert(
  server.includes("if (!error || error.code !== 'POLICY_APPROVAL_REQUIRED' || !descriptor) return null;"),
  'safe passage must only be offered for an approval-required refusal'
);
assert(
  server.includes('res.status(status).json(passage ? { ...body, safePassage: passage } : body)'),
  'a refusal carrying a route must answer with it alongside the unchanged error body'
);

/* The public error contract itself is untouched: the route rides beside it, not
 * inside it, so every other refusal answers exactly as it did. */
assert(!publicErrors.includes('safePassage'), 'the public error body must not gain a safe passage field');

/* Building an offer must never change the outcome of a refusal that is already
 * decided, so the helper swallows its own failures. */
assert(
  /async function safePassageFor\([\s\S]*?\} catch \(offerError\) \{[\s\S]*?return null;\s*\}\s*\}/.test(server),
  'a failure while building an offer must mean no offer, never a different status'
);

/* The resolver reads the active policy set and writes nothing. Asking the
 * runtime evaluator instead would append a decision to the hash chain for a
 * mutation that was never performed. */
assert.strictEqual(
  typeof GovernanceStore.prototype.resolveActivePolicySetInScope,
  'function',
  'the store must expose a read-only active policy set resolver'
);
const resolverStart = store.indexOf('async resolveActivePolicySetInScope(');
assert(resolverStart > 0, 'resolver must exist in the store source');
const resolverEnd = store.indexOf('async listPolicyDecisionsInScope(', resolverStart);
assert(resolverEnd > resolverStart, 'resolver must be bounded by the next store method');
const resolver = store.slice(resolverStart, resolverEnd);
assert(resolver.includes('READ ONLY'), 'the resolver must run in a read-only transaction');
for (const write of ['INSERT', 'UPDATE ', 'DELETE ', 'pg_advisory_xact_lock(']) {
  assert(!resolver.includes(write), `the resolver must not ${write.trim().toLowerCase()}`);
}
assert(!resolver.includes('idFactory'), 'the resolver must not mint a decision identifier');

/* Only actions whose payload is wholly in hand at refusal are routable. */
assert.deepStrictEqual([...ROUTABLE_ACTIONS], ['file.write']);
assert(
  server.includes("if (action !== 'file.write') return null;"),
  'the server must offer routes only for the actions the module can carry'
);

/* An offer is never built from a refusal that was not an approval refusal. */
for (const blockCode of ['POLICY_MUTATION_BLOCKED', 'POLICY_EVALUATION_UNAVAILABLE', 'POLICY_UNSUPPORTED_ACTIVE_RULES', '']) {
  const offer = offerSafePassage({ descriptor: null, blockCode, content: 'x' });
  assert.strictEqual(offer.available, false, `${blockCode || '(none)'} must not produce an offer`);
}

console.log('safe passage server contract tests passed');
