/*
 * Which repositories a request may reach, and the guards around a
 * repository's own lifecycle.
 *
 * In the hosted alpha an invitation names the repositories its tester may
 * use; outside it every repository the account reaches is in scope. A
 * repository the invitation does not name is refused alike whether the
 * invitation, the account or the name is what does not fit, so a refusal
 * never says which. A list is filtered rather than refused, and the safety
 * controls a tester sees are those of the repositories they may use; the
 * alpha's global switches (read-only, the sync freeze) are the deployment's.
 *
 * A new repository is validated, and in the alpha must be one the invitation
 * pre-authorized by its exact name: an invitation never gains a broader grant
 * as a side effect. A deletion needs the full owner/repository typed back. A
 * code search is held to the invitation's repositories. A step-up grant for a
 * repository is checked against the invitation before it is issued.
 *
 * The ledger's actor is the tester's label in the alpha and the account's
 * login otherwise.
 */
import { normalizeStepUpRequest } from '../../../platform/authorization/security-foundation.ts';
import { AlphaAccessError, canonicalRepositoryScope, inviteUnbound, repositoryAllowed } from '../domain/alpha-access.ts';
import { alphaActorLabel } from '../domain/alpha-privacy.ts';
import { identityKey } from '../domain/account-identity.ts';

type Next = () => void;

interface AccessResponse {
  status(code: number): AccessResponse;
  json(body: unknown): unknown;
}

interface Account { readonly provider?: unknown; readonly baseUrl?: unknown; readonly login?: unknown; [field: string]: unknown }

interface Alpha { readonly repositoryScopes?: unknown; [field: string]: unknown }

/* An Express request as these guards read it. The account is attached by providerSessionAccess or auth, which run first on every route these guard. */
export interface AccessRequest {
  readonly alpha?: Alpha;
  readonly gh?: Account;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly query: { readonly q?: unknown; [field: string]: unknown };
  alphaRepository?: unknown;
  alphaStepUpOperation?: unknown;
}

export interface SafetyView {
  readonly readOnly: boolean;
  readonly freezeSync: boolean;
  readonly protected: Readonly<Record<string, unknown>>;
}

export interface RepositoryAccessDeps {
  readonly alphaEnabled: boolean;
  /* A failed request's answer (http/errors.ts). */
  readonly fail: (res: never, error: unknown) => unknown;
  /* What a stored safety record reads as (Corona). */
  readonly defaultSafety: (state: unknown) => SafetyView;
  /* GitHub's own rules for a new repository's name and a code search (the GitHub provider). */
  readonly validateRepositoryCreation: (body: unknown) => unknown;
  readonly validateCodeQuery: (query: unknown) => unknown;
  readonly githubRepositoryScopes: (scopes: unknown) => Iterable<unknown>;
  readonly scopedCodeQuery: (query: unknown, repository: unknown) => unknown;
}

type Fields = Readonly<Record<string, unknown>>;

export function createRepositoryAccess(deps: RepositoryAccessDeps) {
  const fail = deps.fail as unknown as (res: AccessResponse, error: unknown) => unknown;

  /* Who acted, as evidence and audit rows keep it: any request object, with what the session guards attached. */
  function retainedActor(req: object & { readonly alpha?: unknown; readonly gh?: Account | null }): string {
    return deps.alphaEnabled && req.alpha
      ? alphaActorLabel(req.alpha)
      : String(req.gh && req.gh.login || 'unknown');
  }

  function alphaRepositoryTarget(account: Account | null | undefined, owner: unknown, repo: unknown) {
    const provider = account && account.provider || 'github';
    return {
      provider,
      authority: provider === 'github'
        ? 'github.com'
        : account && account.baseUrl,
      owner,
      repo
    };
  }

  function alphaRepositoryDecision(alpha: Alpha | undefined, account: Account | null | undefined, owner: unknown, repo: unknown) {
    const target = alphaRepositoryTarget(account, owner, repo);
    const canonical = canonicalRepositoryScope(target);
    return {
      allowed: !deps.alphaEnabled
        || inviteUnbound(alpha && alpha.repositoryScopes)
        || repositoryAllowed(alpha && alpha.repositoryScopes, target),
      canonical
    };
  }

  function alphaRepositoryDenied() {
    return Object.assign(
      new Error('This repository is not allowed for this alpha invitation'),
      { status: 403, code: 'ALPHA_REPOSITORY_NOT_ALLOWED' }
    );
  }

  function assertAlphaRepositoryAllowed(alpha: Alpha | undefined, account: Account | null | undefined, owner: unknown, repo: unknown) {
    try {
      const decision = alphaRepositoryDecision(alpha, account, owner, repo);
      if (!decision.allowed) throw alphaRepositoryDenied();
      return decision;
    } catch (error) {
      if (error && (error as Fields).code === 'ALPHA_REPOSITORY_NOT_ALLOWED') throw error;
      if (error instanceof AlphaAccessError || error instanceof TypeError) {
        throw alphaRepositoryDenied();
      }
      throw error;
    }
  }

  function alphaRepositoryAccess(req: AccessRequest, res: AccessResponse, next: Next) {
    if (!deps.alphaEnabled) return next();
    try {
      req.alphaRepository = assertAlphaRepositoryAllowed(
        req.alpha,
        req.gh,
        req.params.owner,
        req.params.repo
      );
      return next();
    } catch {
      const error = alphaRepositoryDenied();
      return res.status(error.status).json({
        error: error.message,
        code: error.code
      });
    }
  }

  function alphaRepositoryListAllowed(req: AccessRequest, owner: unknown, repo: unknown): boolean {
    if (!deps.alphaEnabled) return true;
    try {
      return alphaRepositoryDecision(
        req.alpha,
        req.gh,
        owner,
        repo
      ).allowed;
    } catch {
      return false;
    }
  }

  function alphaRepositoryListAccess(req: AccessRequest, res: AccessResponse, next: Next) {
    if (!deps.alphaEnabled) return next();
    try {
      canonicalRepositoryScope(
        alphaRepositoryTarget(req.gh, 'alpha-authority', 'root-validation')
      );
      return next();
    } catch {
      const error = alphaRepositoryDenied();
      return res.status(error.status).json({
        error: error.message,
        code: error.code
      });
    }
  }

  function repositoryCreationAccess(req: AccessRequest, res: AccessResponse, next: Next) {
    try {
      deps.validateRepositoryCreation(req.body);
      // Pre-authorized exact names work even before the repository exists.
      // Existing invitations never acquire a broader grant as a side effect.
      if (deps.alphaEnabled) assertAlphaRepositoryAllowed(req.alpha, req.gh, req.gh!.login, (req.body as Fields).name);
      next();
    } catch (error) { fail(res, error); }
  }

  function repositoryDeletionConfirmation(req: AccessRequest, res: AccessResponse, next: Next) {
    const expected = `${req.params.owner}/${req.params.repo}`;
    if (!req.body || (req.body as Fields).confirmation !== expected) {
      return fail(res, Object.assign(new Error('Type the full owner/repository name to confirm deletion.'), {
        status: 400, code: 'REPOSITORY_DELETE_CONFIRMATION_REQUIRED', providerChanged: false
      }));
    }
    next();
    return undefined;
  }

  function githubSearchAccess(req: AccessRequest, res: AccessResponse, next: Next) {
    try {
      deps.validateCodeQuery(req.query.q);
      if (deps.alphaEnabled) {
        for (const repository of deps.githubRepositoryScopes(req.alpha && req.alpha.repositoryScopes)) {
          deps.scopedCodeQuery(req.query.q, repository);
        }
      }
      next();
    } catch (error) { fail(res, error); }
  }

  function alphaStepUpRepositoryAccess(req: AccessRequest, res: AccessResponse, next: Next) {
    try {
      const body = (req.body || {}) as Fields;
      const operation = normalizeStepUpRequest(body.action, body.scope, {
        provider: req.gh!.provider || 'github',
        identityKey: identityKey(req.gh as Parameters<typeof identityKey>[0])
      });
      const scope = operation.scope as Fields;
      if (deps.alphaEnabled && scope.owner && scope.repo) {
        req.alphaRepository = assertAlphaRepositoryAllowed(
          req.alpha,
          req.gh,
          scope.owner,
          scope.repo
        );
      }
      req.alphaStepUpOperation = operation;
      next();
    } catch (error) {
      fail(res, error);
    }
  }

  /*
   * The safety state a reader may see. `globalControls` says whether read-only
   * and the sync freeze can be changed from here: a hosted alpha scopes every
   * change to a repository and refuses the global switches, so the Safeguards
   * panel shows them as the deployment's rather than as switches that bounce.
   */
  function alphaSafetyView(req: AccessRequest, state: unknown) {
    const view = deps.defaultSafety(state);
    if (!deps.alphaEnabled) return { ...view, globalControls: true };
    const protectedRepositories: Record<string, unknown> = {};
    for (const [repository, patterns] of Object.entries(view.protected)) {
      const match = String(repository).match(/^([^/\s]+)\/([^/\s]+)$/);
      if (!match) continue;
      try {
        if (alphaRepositoryDecision(req.alpha, req.gh, match[1], match[2]).allowed) {
          protectedRepositories[repository] = patterns;
        }
      } catch {}
    }
    return { ...view, protected: protectedRepositories, globalControls: false };
  }

  function alphaSafetyMutationAccess(req: AccessRequest, res: AccessResponse, next: Next) {
    if (!deps.alphaEnabled) return next();
    const body = (req.body || {}) as Fields;
    if (typeof body.readOnly === 'boolean' || typeof body.freezeSync === 'boolean') {
      return res.status(403).json({
        error: 'Global safety changes require an unscoped deployment',
        code: 'ALPHA_REPOSITORY_SCOPE_REQUIRED'
      });
    }
    const repository = body.protect && (body.protect as Fields).repo;
    const match = String(repository || '').trim().match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!match) {
      return res.status(repository ? 400 : 403).json(repository
        ? { error: 'Invalid repository key' }
        : {
            error: 'A repository scope is required for hosted-alpha safety changes',
            code: 'ALPHA_REPOSITORY_SCOPE_REQUIRED'
          });
    }
    try {
      req.alphaRepository = assertAlphaRepositoryAllowed(
        req.alpha,
        req.gh,
        match[1],
        match[2]
      );
      next();
    } catch (error) {
      fail(res, error);
    }
    return undefined;
  }

  return {
    retainedActor, assertAlphaRepositoryAllowed, alphaRepositoryAccess, alphaRepositoryListAllowed, alphaRepositoryListAccess,
    repositoryCreationAccess, repositoryDeletionConfirmation, githubSearchAccess, alphaStepUpRepositoryAccess,
    alphaSafetyView, alphaSafetyMutationAccess
  };
}

export type RepositoryAccess = ReturnType<typeof createRepositoryAccess>;
