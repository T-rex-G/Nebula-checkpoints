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
 *
 * The policy itself is handed in. The caller gives a step evaluator that
 * judges a descriptor by the policy set that refused the original; this module
 * imports no policy engine, so the platform does not depend on the module that
 * governs it.
 */

import { createHash } from 'node:crypto';
import { normalizeMutationDescriptor } from './mutation-gateway.ts';
import { pathFactsForAction } from './protected-paths.ts';
import { isMutationAction } from '../../../../../packages/contracts/src/mutation.ts';
import type { MutationDescriptor } from '../../../../../packages/contracts/src/mutation.ts';

export const APPROVAL_BLOCK_CODE = 'POLICY_APPROVAL_REQUIRED';
const BRANCH_PREFIX = 'safe-passage';
const MAX_CONTENT_BYTES = 40 * 1024 * 1024;

export class SafePassageError extends Error {
  override readonly name = 'SafePassageError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const SAFE_PASSAGE_KIND = Object.freeze({ PULL_REQUEST: 'pull-request' } as const);

/* Only the actions whose whole payload the gateway is holding when it refuses.
 * A streamed upload or a native push is not one of them, and claiming a route
 * for work this module cannot actually carry would be the same lie as a
 * narrowed path set. */
export const ROUTABLE_ACTIONS: readonly string[] = Object.freeze(['file.write']);

/* What the policy says of one step: permitted only when both are 'allow'. */
export interface StepDecision {
  readonly effectiveEffect: unknown;
  readonly enforcementOutcome: unknown;
}

/* Judges one step of the route by the active policy set that refused the original, writing nothing. */
export type StepEvaluator = (descriptor: MutationDescriptor) => StepDecision;

export interface RouteStep {
  readonly action: string;
  readonly method: string;
  readonly route: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SafePassageUnavailable {
  readonly available: false;
  readonly reason: string;
  readonly refusedStep: string | null;
  readonly evaluated?: boolean;
}

export interface SafePassageOffer {
  readonly available: true;
  readonly kind: (typeof SAFE_PASSAGE_KIND)['PULL_REQUEST'];
  readonly baseBranch: string;
  readonly branch: string;
  readonly path: string;
  readonly contentHash: string;
  readonly steps: readonly RouteStep[];
  readonly summary: string;
}

export interface SafePassageInput {
  readonly descriptor?: MutationDescriptor | null;
  readonly blockCode?: unknown;
  readonly content?: unknown;
  readonly evaluateStep?: StepEvaluator;
}

function unavailable(reason: string, extra: { readonly refusedStep?: string; readonly evaluated?: boolean } = {}): SafePassageUnavailable {
  return Object.freeze({ available: false, reason, refusedStep: null, ...extra });
}

function sha256(value: string | Buffer): string {
  const hash = createHash('sha256');
  return (typeof value === 'string' ? hash.update(value, 'utf8') : hash.update(value)).digest('hex');
}

function contentHashOf(content: unknown): string {
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
export function branchFor(baseBranch: string, path: string, contentHash: string): string {
  return `${BRANCH_PREFIX}/${sha256(`${baseBranch}\n${path}\n${contentHash}`).slice(0, 12)}`;
}

/* Hypothetical descriptors need an identifier of the right shape. It is derived
 * so the offer is stable, and it is never persisted: these mutations are being
 * asked about, not performed. */
function syntheticMutationId(seed: string): string {
  const digest = sha256(seed);
  return [
    digest.slice(0, 8), digest.slice(8, 12),
    `4${digest.slice(13, 16)}`, `8${digest.slice(17, 20)}`,
    digest.slice(20, 32)
  ].join('-');
}

function stepsFor({ baseBranch, branch, path }: { readonly baseBranch: string; readonly branch: string; readonly path: string }): readonly RouteStep[] {
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
function firstRefusedStep({ descriptor, steps, evaluateStep }: {
  readonly descriptor: MutationDescriptor;
  readonly steps: readonly RouteStep[];
  readonly evaluateStep: StepEvaluator;
}): { readonly action: string; readonly evaluated: boolean } | null {
  for (const step of steps) {
    let decision: StepDecision;
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
      decision = evaluateStep(stepDescriptor);
    } catch {
      /* A step this module cannot even pose as a question is a step it cannot
       * stand behind. It is reported as unevaluated rather than as refused:
       * a malformed policy set is an operational fault, and calling it a
       * policy decision would put words in the policy's mouth. */
      return { action: step.action, evaluated: false };
    }
    if (!decision || decision.effectiveEffect !== 'allow' || decision.enforcementOutcome !== 'allow') {
      return { action: step.action, evaluated: true };
    }
  }
  return null;
}

/*
 * The offer, or an explicit statement of why there is none.
 */
export function offerSafePassage(input: SafePassageInput = {}): SafePassageOffer | SafePassageUnavailable {
  const descriptor = input && input.descriptor;
  const blockCode = String(input.blockCode || '').trim();

  if (!descriptor || !isMutationAction(descriptor.action)) {
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

  /* With nothing to judge the route by, there is no route: a wiring defect, said loudly. */
  const evaluateStep = input.evaluateStep;
  if (typeof evaluateStep !== 'function') {
    throw new TypeError('Safe Passage needs evaluateStep(descriptor) to judge the route by the active policy set');
  }

  const branch = branchFor(baseBranch, path, contentHash);
  const steps = stepsFor({ baseBranch, branch, path });
  const refusal = firstRefusedStep({ descriptor, steps, evaluateStep });
  if (refusal) {
    return unavailable(
      refusal.evaluated
        ? `The compliant route is itself refused at ${refusal.action}, so it is not offered.`
        : `The compliant route could not be evaluated at ${refusal.action}, so it is not offered.`,
      { refusedStep: refusal.action, evaluated: refusal.evaluated }
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
