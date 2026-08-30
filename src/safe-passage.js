'use strict';

/*
 * Safe Passage — the route to approval, offered at the moment of refusal.
 *
 * A policy that answers "this needs approval" and then simply returns 403 has
 * told the truth and left the person holding work they now have to re-route by
 * hand: branch, commit, pull request, reviewers. That cost is why enforcement
 * gets configured and never switched on. The gateway is the one place that
 * still holds the whole attempt when the refusal happens, so it is the one
 * place that can hand the compliant route back instead of a dead end.
 *
 * Three rules decide everything here.
 *
 * Never automatic. This module only describes a route; taking it is a separate
 * act by the caller. Nothing is written on anyone's behalf.
 *
 * Never altered. The offer commits to the exact bytes that were refused, by
 * hash, and carries none of them. What eventually lands is checked against
 * that hash or it does not land.
 *
 * Never a bypass. A route is offered only after every step of it has been
 * evaluated against the same active policy set that just refused the original,
 * and only if the policy permits all of them. A refusal that is a deny has no
 * compliant route by definition and is never given one. This is verified here
 * rather than promised, because a helpful-looking hole is still a hole.
 */

const crypto = require('crypto');
const { normalizeMutationDescriptor, MUTATION_ACTIONS } = require('./mutation-gateway');
const { evaluateActivePolicySet } = require('./governance-enforcement');
const { pathFactsForAction } = require('./protected-paths');

const APPROVAL_BLOCK_CODE = 'POLICY_APPROVAL_REQUIRED';
const BRANCH_PREFIX = 'safe-passage';
const MAX_CONTENT_BYTES = 40 * 1024 * 1024;

class SafePassageError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'SafePassageError';
    this.code = code;
    this.status = status;
  }
}

const SAFE_PASSAGE_KIND = Object.freeze({ PULL_REQUEST: 'pull-request' });

/* Only the actions whose whole payload the gateway is holding when it refuses.
 * A streamed upload or a native push is not one of them, and claiming a route
 * for work this module cannot actually carry would be the same lie as a
 * narrowed path set. */
const ROUTABLE_ACTIONS = Object.freeze(['file.write']);

function unavailable(reason, extra = {}) {
  return Object.freeze({ available: false, reason, refusedStep: null, ...extra });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, typeof value === 'string' ? 'utf8' : undefined).digest('hex');
}

function contentHashOf(content) {
  if (typeof content === 'string') {
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) return '';
    return sha256(content);
  }
  if (Buffer.isBuffer(content)) {
    if (content.length > MAX_CONTENT_BYTES) return '';
    return sha256(content);
  }
  return '';
}

/* The same refused change offers the same branch every time, so retrying a
 * blocked write does not scatter branches across the repository. */
function branchFor(baseBranch, path, contentHash) {
  return `${BRANCH_PREFIX}/${sha256(`${baseBranch}\n${path}\n${contentHash}`).slice(0, 12)}`;
}

/* Hypothetical descriptors need an identifier of the right shape. It is derived
 * so the offer is stable, and it is never persisted: these mutations are being
 * asked about, not performed. */
function syntheticMutationId(seed) {
  const digest = sha256(seed);
  return [
    digest.slice(0, 8), digest.slice(8, 12),
    `4${digest.slice(13, 16)}`, `8${digest.slice(17, 20)}`,
    digest.slice(20, 32)
  ].join('-');
}

function stepsFor({ baseBranch, branch, path }) {
  return [
    {
      action: 'branch.create',
      method: 'POST',
      route: '/api/repo/:owner/:repo/branches',
      metadata: { branch, sourceBranch: baseBranch }
    },
    {
      action: 'file.write',
      method: 'PUT',
      route: '/api/repo/:owner/:repo/file',
      metadata: { branch, path }
    },
    {
      action: 'pull.create',
      method: 'POST',
      route: '/api/repo/:owner/:repo/pulls',
      metadata: { head: branch, base: baseBranch, draft: false }
    }
  ].map(step => Object.freeze({
    ...step,
    metadata: Object.freeze({ ...step.metadata, ...pathFactsForAction(step.action, step.metadata) })
  }));
}

/*
 * Ask the policy about each step. A step is permitted only when the policy
 * allows it outright — not merely when the policy happens not to be enforcing
 * at the moment, which is why the effective effect is checked alongside the
 * enforcement outcome.
 */
function firstRefusedStep({ descriptor, steps, scope, activePolicies, activeExceptions, evaluatedAt }) {
  for (const step of steps) {
    let decision;
    try {
      const stepDescriptor = normalizeMutationDescriptor({
        mutationId: syntheticMutationId(`${descriptor.mutationId}\n${step.action}`),
        action: step.action,
        provider: descriptor.provider,
        owner: descriptor.owner,
        repo: descriptor.repo,
        actorIdentityKey: descriptor.actorIdentityKey,
        actorLogin: descriptor.actorLogin,
        method: step.method,
        route: step.route,
        metadata: step.metadata,
        authorization: descriptor.authorization
      });
      decision = evaluateActivePolicySet({
        scope, descriptor: stepDescriptor, activePolicies, activeExceptions, evaluatedAt
      });
    } catch {
      /* A step this module cannot even pose as a question is a step it cannot
       * stand behind. */
      return step.action;
    }
    if (decision.effectiveEffect !== 'allow' || decision.enforcementOutcome !== 'allow') return step.action;
  }
  return null;
}

/*
 * The offer, or an explicit statement of why there is none.
 */
function offerSafePassage(input = {}) {
  const descriptor = input && input.descriptor;
  const blockCode = String(input.blockCode || '').trim();

  if (!descriptor || !MUTATION_ACTIONS[descriptor.action]) {
    return unavailable('This mutation cannot be routed.');
  }
  if (blockCode !== APPROVAL_BLOCK_CODE) {
    /* A deny is a wall, and an unavailable evaluation is not a refusal to route
     * around — it is a refusal to judge at all. */
    return unavailable(
      blockCode
        ? 'This change was refused outright, so there is no compliant route to offer.'
        : 'This change was not refused, so there is nothing to route.'
    );
  }
  if (!ROUTABLE_ACTIONS.includes(descriptor.action)) {
    return unavailable(`A ${descriptor.action} refusal cannot be carried to a compliant route yet.`);
  }

  const baseBranch = String(descriptor.metadata && descriptor.metadata.branch || '').trim();
  const path = String(descriptor.metadata && descriptor.metadata.path || '').trim();
  if (!baseBranch || !path) {
    return unavailable('The refused change does not name a branch and a path to route.');
  }

  const contentHash = contentHashOf(input.content);
  if (!contentHash) {
    return unavailable('The refused content could not be carried, so no route is offered.');
  }

  const branch = branchFor(baseBranch, path, contentHash);
  const steps = stepsFor({ baseBranch, branch, path });
  const refusedStep = firstRefusedStep({
    descriptor,
    steps,
    scope: input.scope,
    activePolicies: Array.isArray(input.activePolicies) ? input.activePolicies : [],
    activeExceptions: Array.isArray(input.activeExceptions) ? input.activeExceptions : [],
    evaluatedAt: input.evaluatedAt
  });
  if (refusedStep) {
    return unavailable(
      `The compliant route is itself refused at ${refusedStep}, so it is not offered.`,
      { refusedStep }
    );
  }

  return Object.freeze({
    available: true,
    kind: SAFE_PASSAGE_KIND.PULL_REQUEST,
    baseBranch,
    branch,
    path,
    contentHash,
    steps: Object.freeze(steps),
    summary: `This change needs approval on ${baseBranch}. It can go to ${branch} and open a pull request for review instead.`
  });
}

module.exports = Object.freeze({
  SafePassageError,
  SAFE_PASSAGE_KIND,
  ROUTABLE_ACTIONS,
  APPROVAL_BLOCK_CODE,
  branchFor,
  offerSafePassage
});
