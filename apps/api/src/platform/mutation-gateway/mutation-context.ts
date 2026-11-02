/*
 * The context a repository change runs in.
 *
 * Before the route runs, the change is described: who asks, for which
 * repository, through which route, with what authorization, and the metadata
 * the policy and the ledger read. A merge's facts (its branches and what the
 * latest audit of its head says) are read first, so the policy judges the same
 * facts the ledger records. The route then runs inside the mutation gateway,
 * which records the change and refuses a provider write the policy does not
 * allow. The context ends when the answer is sent or the connection closes.
 *
 * Every content-changing action reports the complete set of repository paths
 * it touches, so a path-scoped policy rule reaches a rename, a batch and a
 * directory move the same way it reaches a single write (protected-paths.ts).
 *
 * A change the policy refuses because it needs approval is offered the route
 * to approval rather than a dead end, judged by the same active policy set,
 * read without writing (safe-passage.ts). Building the offer never changes
 * the refusal: any failure there simply means no offer.
 */
import { createUnavailableAuthorizationSnapshot } from '../authorization/authorization-resolver.ts';
import { cleanText } from '../values/text.ts';
import { normalizeFileBatch, summarizeBatchItems } from './mutation-coverage.ts';
import { normalizeMutationDescriptor, type MutationGateway } from './mutation-gateway.ts';
import { pathFactsForAction } from './protected-paths.ts';
import { offerSafePassage, type StepEvaluator } from './safe-passage.ts';

/* A request as the contexts read it; every field is read where it is used. */
export interface ContextRequest {
  readonly body?: unknown;
  readonly query?: unknown;
  readonly params?: unknown;
  readonly method?: string;
  readonly path?: string;
  readonly route?: { readonly path?: unknown } | null;
  /* Attached by the session guards, which run before a mutation's context on every route that has one. */
  readonly gh?: { readonly provider?: unknown; readonly baseUrl?: unknown; readonly login?: unknown; [field: string]: unknown };
  readonly alpha?: unknown;
  readonly stepUp?: { readonly action?: unknown; readonly assurance?: unknown; readonly authorizedAt?: unknown } | null;
  authorization?: unknown;
  mergeFacts?: unknown;
  mutation?: unknown;
}

export interface ContextResponse {
  readonly headersSent: boolean;
  setHeader(name: string, value: string): unknown;
  once(event: 'finish' | 'close', listener: () => void): unknown;
  removeListener(event: 'finish' | 'close', listener: () => void): unknown;
}

type Fields = Readonly<Record<string, unknown>>;

/* The policy's decision, as headers on the answer. */
interface PolicyDecisionFields {
  readonly enforcementOutcome: string;
  readonly rolloutMode: string;
  readonly decisionId?: string;
  readonly warningCodes?: readonly string[];
}

export function applyPolicyDecisionHeaders(res: ContextResponse, decision: unknown): void {
  if (!decision) return;
  const d = decision as PolicyDecisionFields;
  res.setHeader('X-Nebulaverse-Policy-Outcome', d.enforcementOutcome);
  res.setHeader('X-Nebulaverse-Policy-Mode', d.rolloutMode);
  if (d.decisionId) res.setHeader('X-Nebulaverse-Policy-Decision', d.decisionId);
  if (d.warningCodes && d.warningCodes.length) {
    res.setHeader('X-Nebulaverse-Policy-Warning', d.warningCodes.slice(0, 8).join(','));
  }
}

/*
 * Runs the route inside the gateway for a described change, until the answer
 * is sent or the connection closes. A route that throws synchronously rejects
 * the run; the caller decides how to answer.
 */
export function runInMutationContext(gateway: MutationGateway, descriptor: unknown, req: ContextRequest, res: ContextResponse, next: () => void): Promise<void> {
  return gateway.run(descriptor, () => new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res.removeListener('finish', finish);
      res.removeListener('close', finish);
      resolve();
    };
    res.once('finish', finish);
    res.once('close', finish);
    req.mutation = gateway.current();
    applyPolicyDecisionHeaders(res, req.mutation && (req.mutation as Fields).policyDecision);
    try { next(); }
    catch (error) {
      res.removeListener('finish', finish);
      res.removeListener('close', finish);
      reject(error);
    }
  }));
}

export interface RepositoryMutationContextDeps {
  readonly gateway: MutationGateway;
  readonly identityKey: (account: never) => string;
  /* The actor the ledger keeps for the request (the alpha's label, or the account's login). */
  readonly retainedActor: (req: never) => unknown;
  /* The repository authorization snapshot (authorization-resolver.ts). */
  readonly resolveAuthorization: (input: { account: unknown; owner: unknown; repo: unknown; actorIdentityKey: string }) => Promise<unknown>;
  /* In the alpha, the principal is recorded under the tester's label. */
  readonly alphaEnabled: boolean;
  readonly alphaActorLabel: (alpha: never) => string;
  /* A merge's facts for the policy (Uranus). */
  readonly mergeFacts: (req: never) => Promise<unknown>;
  /* What a restore preview's authorization would do, without spending it (Corona). */
  readonly inspectRestoreAuthorization: (target: { account: unknown; owner: unknown; repo: unknown }, authorization: unknown) => { readonly actions: unknown };
  /* For the safe passage: the database's readiness, the active policy set, and its step evaluator (Kepler). */
  readonly ready: () => Promise<boolean>;
  readonly resolveActivePolicySet: (input: { scope: unknown; action: unknown }) => Promise<{ readonly activePolicies?: unknown; readonly activeExceptions?: unknown; readonly resolvedAt?: unknown }>;
  readonly stepEvaluator: (input: { scope: unknown; activePolicies: unknown; activeExceptions: unknown; evaluatedAt: unknown }) => StepEvaluator;
  /* A failed request's answer (http/errors.ts). */
  readonly fail: (res: never, error: unknown) => unknown;
}

export function createRepositoryMutationContext(deps: RepositoryMutationContextDeps) {
  const call = deps as unknown as {
    identityKey(account: unknown): string;
    retainedActor(req: ContextRequest): unknown;
    alphaActorLabel(alpha: unknown): string;
    mergeFacts(req: ContextRequest): Promise<unknown>;
    fail(res: ContextResponse, error: unknown): unknown;
  };
  const bodyOf = (req: ContextRequest): Fields => (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}) as Fields;

  function mutationMetadataFor(req: ContextRequest, action: string): Record<string, unknown> {
    const base = baseMutationMetadataFor(req, action);
    return { ...base, ...pathFactsForAction(action, base) };
  }

  function baseMutationMetadataFor(req: ContextRequest, action: string): Record<string, unknown> {
    const body = bodyOf(req);
    const query = (req.query || {}) as Fields;
    const params = (req.params || {}) as Fields;
    const text = (value: unknown, max = 500) => cleanText(value == null ? '' : String(value), max).replace(/[\r\n\0]/g, ' ');
    switch (action) {
      case 'repository.create': return { name: text(body.name, 100), private: body.isPrivate !== false, autoInit: body.autoInit !== false };
      case 'branch.create': return { branch: text(body.name, 255), sourceBranch: text(body.from, 255) };
      case 'branch.delete': return { branch: text(params.name, 255) };
      case 'branch.reset': return { branch: text(body.branch, 255), targetSha: text(body.sha, 40), expectedHeadSha: text(body.expectedHeadSha, 40) };
      case 'file.write':
      case 'file.delete': return { branch: text(body.branch, 255), path: text(body.path, 1000), expectedHeadSha: text(body.expectedHeadSha, 40) };
      case 'file.rename': return { branch: text(body.branch, 255), from: text(body.from, 1000), to: text(body.to, 1000), expectedHeadSha: text(body.expectedHeadSha, 40) };
      case 'file.batch': {
        const batch = normalizeFileBatch(body.ops);
        return { branch: text(body.branch, 255), ...batch.summary, expectedHeadSha: text(body.expectedHeadSha, 40) };
      }
      case 'commit.revert':
      case 'commit.restore': return { branch: text(body.branch, 255), commitSha: text(body.sha, 40), expectedHeadSha: text(body.expectedHeadSha, 40) };
      case 'commit.restore-paths': return { branch: text(body.branch, 255), commitSha: text(body.sha, 40), pathPrefix: text(body.prefix, 1000), expectedHeadSha: text(body.expectedHeadSha, 40) };
      case 'pull.create': return { head: text(body.head, 255), base: text(body.base, 255), draft: !!body.draft };
      case 'pull.merge': {
        /* The branches and the audit gate's attributes, read before the policy is (mergeFacts), so a rule can name them. */
        const facts = (req.mergeFacts || {}) as Fields;
        return {
          pullNumber: Number(params.num || 0), mergeMethod: text(body.method || 'merge', 20),
          ...(facts.branch ? { branch: text(facts.branch, 255) } : {}),
          ...(facts.head ? { head: text(facts.head, 255) } : {}),
          ...(facts.audit ? { audit: facts.audit } : {})
        };
      }
      case 'pull.review': return { pullNumber: Number(params.num || 0), event: text(body.event, 30) };
      case 'issue.create': return {};
      case 'issue.comment': return { issueNumber: Number(params.num || 0) };
      case 'issue.update': return { issueNumber: Number(params.num || 0), state: text(body.state, 20) };
      case 'workflow.rerun': return { runId: text(params.runId, 100) };
      case 'release.create': return { tag: text(body.tag || body.tag_name, 255), target: text(body.target || body.target_commitish, 255) };
      case 'git.blob.create': return { path: text(query.path, 1000) };
      case 'file.upload': return { path: text(query.path, 1000), branch: text(query.branch, 255), lfsMode: text(query.lfs || 'auto', 20), expectedHeadSha: text(query.expectedHeadSha, 40) };
      case 'directory.move': return { branch: text(body.branch, 255), from: text(body.from, 1000), to: text(body.to, 1000), expectedHeadSha: text(body.expectedHeadSha, 40) };
      case 'recovery.restore-refs': {
        const inspected = deps.inspectRestoreAuthorization({ account: req.gh, owner: (req.params as Fields).owner, repo: (req.params as Fields).repo }, body.authorization);
        return { confirmation: text(body.confirm, 20), ...summarizeBatchItems('recovery.restore-refs', inspected.actions) };
      }
      default: return {};
    }
  }

  function mutationDescriptorFor(req: ContextRequest, action: string) {
    const body = bodyOf(req);
    const createRepository = action === 'repository.create';
    return {
      action,
      provider: req.gh!.provider || 'github',
      baseUrl: req.gh!.baseUrl || '',
      owner: createRepository ? req.gh!.login : (req.params as Fields).owner,
      repo: createRepository ? body.name : (req.params as Fields).repo,
      actorIdentityKey: call.identityKey(req.gh),
      actorLogin: call.retainedActor(req),
      method: req.method,
      route: req.route && req.route.path ? String(req.route.path) : req.path,
      metadata: mutationMetadataFor(req, action),
      security: req.stepUp ? {
        stepUpAction: req.stepUp.action,
        assurance: req.stepUp.assurance,
        authorizedAt: req.stepUp.authorizedAt
      } : {},
      authorization: req.authorization
    };
  }

  async function resolveMutationAuthorization(req: ContextRequest, action: string): Promise<unknown> {
    const body = bodyOf(req);
    const createRepository = action === 'repository.create';
    const owner = createRepository ? req.gh!.login : (req.params as Fields).owner;
    const repo = createRepository ? body.name : (req.params as Fields).repo;
    const input = { account: req.gh, owner, repo, actorIdentityKey: call.identityKey(req.gh) };
    if (createRepository) {
      const snapshot = createUnavailableAuthorizationSnapshot({
        ...input, reasonCode: 'AUTHORIZATION_SCOPE_NOT_APPLICABLE'
      } as Parameters<typeof createUnavailableAuthorizationSnapshot>[0]);
      return retainedMutationAuthorization(req, snapshot);
    }
    const snapshot = await deps.resolveAuthorization(input);
    return retainedMutationAuthorization(req, snapshot);
  }

  function retainedMutationAuthorization(req: ContextRequest, snapshot: unknown): unknown {
    if (!deps.alphaEnabled || !req.alpha) return snapshot;
    const actor = call.alphaActorLabel(req.alpha);
    const s = snapshot as { readonly executionPrincipal?: object; readonly governanceActor?: object };
    return {
      ...s,
      executionPrincipal: { ...s.executionPrincipal, login: actor },
      governanceActor: { ...s.governanceActor, login: actor }
    };
  }

  async function safePassageFor(req: ContextRequest, action: string, descriptor: unknown, error: unknown) {
    try {
      if (!error || (error as Fields).code !== 'POLICY_APPROVAL_REQUIRED' || !descriptor) return null;
      if (action !== 'file.write') return null;
      const body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : null) as Fields | null;
      if (!body || typeof body.content !== 'string') return null;
      if (!(await deps.ready())) return null;
      const normalized = normalizeMutationDescriptor(descriptor);
      const resolved = await deps.resolveActivePolicySet({
        scope: normalized.authorization.scope,
        action: normalized.action
      });
      const offer = offerSafePassage({
        descriptor: normalized,
        blockCode: (error as Fields).code,
        content: body.content,
        evaluateStep: deps.stepEvaluator({
          scope: normalized.authorization.scope,
          activePolicies: resolved.activePolicies,
          activeExceptions: resolved.activeExceptions,
          evaluatedAt: resolved.resolvedAt
        })
      });
      return offer && offer.available ? offer : null;
    } catch (offerError) {
      console.error(JSON.stringify({
        t: new Date().toISOString(), warn: 'safe passage offer could not be built',
        action, code: cleanText(String(offerError && (offerError as Fields).code || 'SAFE_PASSAGE_UNAVAILABLE'), 100)
      }));
      return null;
    }
  }

  function mutationContext(action: string) {
    return async function enterMutationContext(req: ContextRequest, res: ContextResponse, next: () => void) {
      let descriptor: unknown;
      try {
        req.authorization = await resolveMutationAuthorization(req, action);
        if (action === 'pull.merge') req.mergeFacts = await call.mergeFacts(req);
        descriptor = mutationDescriptorFor(req, action);
      } catch (error) { return call.fail(res, error); }
      runInMutationContext(deps.gateway, descriptor, req, res, next).catch(async error => {
        if (!res.headersSent) {
          const passage = await safePassageFor(req, action, descriptor, error);
          if (passage) error.safePassage = passage;
          return call.fail(res, error);
        }
        console.error(JSON.stringify({
          t: new Date().toISOString(), warn: 'mutation gateway context failed after headers',
          action, code: error && error.code || 'MUTATION_GATEWAY_FAILED'
        }));
        return undefined;
      });
      return undefined;
    };
  }

  return { mutationContext, mutationDescriptorFor, mutationMetadataFor, safePassageFor };
}

export type RepositoryMutationContext = ReturnType<typeof createRepositoryMutationContext>;
