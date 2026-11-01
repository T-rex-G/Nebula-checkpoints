/*
 * Who may read and change a repository's governance, and the context a
 * governance change runs in.
 *
 * governanceAccess resolves the reader's authorization for the repository and
 * holds it to the role the route needs. Reader access everyone has on a public
 * repository is accepted only where the route opts in (OWN_WORK): routes whose
 * data is the reader's own -- their audits and their scans, keyed by identity.
 * Everything the repository's collaborators share stays theirs.
 *
 * governanceMutationContext describes the change from that authorization and
 * runs the route inside the mutation gateway, as a repository change does. It
 * records a decision in this server's own ledger rather than writing to a
 * provider, and answers its failures as governance's own.
 */
import { isPublicReaderAccess } from '../../../platform/authorization/authorization-resolver.ts';
import { runInMutationContext, type ContextRequest, type ContextResponse } from '../../../platform/mutation-gateway/mutation-context.ts';
import type { MutationGateway } from '../../../platform/mutation-gateway/mutation-gateway.ts';
import { assertGovernanceAuthorization } from '../application/governance-api.ts';
import { governanceMutationMetadata } from '../domain/governance-mutation-metadata.ts';
import { governanceFailure } from './governance-routes.ts';

export const OWN_WORK = Object.freeze({ publicRepositories: true });

interface GovernanceRequest extends ContextRequest {
  governance?: {
    readonly scope: { readonly provider: unknown; readonly owner: unknown; readonly repo: unknown };
    readonly actor: { readonly identityKey: unknown };
    readonly authorization: unknown;
    [field: string]: unknown;
  };
}

interface GovernanceResponse extends ContextResponse {
  status(code: number): GovernanceResponse;
  json(body: unknown): unknown;
}

export interface GovernanceContextDeps {
  readonly gateway: MutationGateway;
  /* The governance service, once its store is ready. */
  readonly governanceService: () => Promise<unknown>;
  /* The repository authorization snapshot (authorization-resolver.ts). */
  readonly resolveAuthorization: (input: { account: unknown; owner: unknown; repo: unknown; actorIdentityKey: string }) => Promise<unknown>;
  readonly identityKey: (account: never) => string;
  /* The actor the ledger keeps for the request. */
  readonly retainedActor: (req: never) => unknown;
}

export function createGovernanceContext(deps: GovernanceContextDeps) {
  const call = deps as unknown as { identityKey(account: unknown): string; retainedActor(req: GovernanceRequest): unknown };
  const failure = governanceFailure as unknown as (res: GovernanceResponse, error: unknown) => unknown;

  function governanceAccess(requiredRole: string, options: { readonly publicRepositories?: boolean } = {}) {
    return async function authorizeGovernance(req: GovernanceRequest, res: GovernanceResponse, next: () => void) {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const params = req.params as Readonly<Record<string, unknown>>;
        const service = await deps.governanceService();
        const authorization = await deps.resolveAuthorization({
          account: req.gh,
          owner: params.owner,
          repo: params.repo,
          actorIdentityKey: call.identityKey(req.gh)
        });
        const context = assertGovernanceAuthorization({
          authorization,
          scope: {
            provider: req.gh.provider || 'github',
            baseUrl: req.gh.baseUrl || '',
            owner: params.owner,
            repo: params.repo
          },
          requiredRole
        } as Parameters<typeof assertGovernanceAuthorization>[0]);
        if (isPublicReaderAccess(context.authorization) && options.publicRepositories !== true) {
          throw Object.assign(new Error('This is shared by the repository’s collaborators, and reading a public repository does not make you one'), {
            status: 403, code: 'GOVERNANCE_COLLABORATORS_ONLY'
          });
        }
        req.governance = { ...context, service, publicReader: isPublicReaderAccess(context.authorization) } as unknown as GovernanceRequest['governance'];
        next();
      } catch (error) { return failure(res, error); }
      return undefined;
    };
  }

  function governanceMutationContext(action: string) {
    return async function enterGovernanceMutationContext(req: GovernanceRequest, res: GovernanceResponse, next: () => void) {
      let descriptor: unknown;
      try {
        if (!req.governance) throw Object.assign(new Error('Governance authorization is required'), { status: 403, code: 'GOVERNANCE_AUTHORIZATION_REQUIRED' });
        descriptor = {
          action,
          provider: req.governance.scope.provider,
          baseUrl: req.gh.baseUrl || '',
          owner: req.governance.scope.owner,
          repo: req.governance.scope.repo,
          actorIdentityKey: req.governance.actor.identityKey,
          actorLogin: call.retainedActor(req),
          method: req.method,
          route: req.route && req.route.path ? String(req.route.path) : req.path,
          metadata: governanceMutationMetadata(req, action),
          security: {},
          authorization: req.governance.authorization
        };
      } catch (error) { return failure(res, error); }
      runInMutationContext(deps.gateway, descriptor, req, res, next).catch(error => {
        if (!res.headersSent) return failure(res, error);
        console.error(JSON.stringify({
          t: new Date().toISOString(), warn: 'governance mutation context failed after headers',
          action, code: error && error.code || 'GOVERNANCE_MUTATION_FAILED'
        }));
        return undefined;
      });
      return undefined;
    };
  }

  return { governanceAccess, governanceMutationContext };
}

export type GovernanceGuards = ReturnType<typeof createGovernanceContext>;
