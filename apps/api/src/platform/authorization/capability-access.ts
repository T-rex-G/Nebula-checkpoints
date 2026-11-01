/*
 * What the account can do here, by the capability document.
 *
 * A feature's capability is resolved for the account's provider and
 * authority, this deployment, how the account signed in and what kind of
 * token it holds. A route that needs a feature refuses before it reads the
 * request when the feature is unavailable, saying which feature; a route that
 * needs it for only some of its requests checks those. The legacy capability
 * map the page reads says the same thing, with notifications resolved apart
 * (never for a GitHub App installation, which has no notification inbox).
 * LFS is qualified for GitHub on github.com only.
 *
 * The capability document and its registry are the deployment's
 * (src/capability-registry.js); the account's authority and token kind are the
 * identity and provider modules'. All of them come in as dependencies.
 */

interface CapabilityAccount { readonly provider?: unknown; readonly authMethod?: unknown; [field: string]: unknown }

export interface CapabilityContext {
  readonly provider: unknown;
  readonly authority: unknown;
  readonly deployment: string;
  readonly feature?: string;
  readonly authMethod: unknown;
  readonly tokenKind: unknown;
}

export interface CapabilityRegistry {
  resolveCapability(document: unknown, context: unknown): { readonly status: string };
  assertCapabilityAvailable(document: unknown, context: unknown, options?: unknown): unknown;
  legacyCapsFor(document: unknown, context: unknown): Record<string, unknown>;
  readonly CapabilityError: new (message: string, code: string, status?: number) => Error;
}

export interface CapabilityAccessDeps {
  readonly document: unknown;
  /* The capabilities a staging deployment is still qualifying. */
  readonly qualification: unknown;
  readonly deployment: string;
  readonly registry: CapabilityRegistry;
  readonly providerAuthority: (account: never) => unknown;
  readonly githubTokenKind: (account: never) => unknown;
}

interface CapabilityRequest { readonly gh: CapabilityAccount; capability?: unknown }
interface CapabilityResponse { status(code: number): CapabilityResponse; json(body: unknown): unknown }

export function createCapabilityAccess(deps: CapabilityAccessDeps) {
  const authority = deps.providerAuthority as unknown as (account: unknown) => unknown;
  const tokenKind = deps.githubTokenKind as unknown as (account: unknown) => unknown;
  const { registry } = deps;

  function providerCapabilities(account: CapabilityAccount | null | undefined) {
    const context = {
      provider: String(account && account.provider || 'github'),
      authority: authority(account),
      deployment: deps.deployment,
      authMethod: account && account.authMethod,
      tokenKind: tokenKind(account || {})
    };
    const legacy = registry.legacyCapsFor(deps.document, context);
    if (context.provider === 'github' && account && account.authMethod === 'github-app') {
      return { ...legacy, notif: false };
    }
    return { ...legacy, notif: registry.resolveCapability(deps.document, { ...context, feature: 'notifications' }).status !== 'Unavailable' };
  }

  function providerCapabilityContext(account: CapabilityAccount | null | undefined, feature: string): CapabilityContext {
    return {
      provider: account && account.provider || 'github',
      authority: authority(account),
      deployment: deps.deployment,
      feature,
      authMethod: account && account.authMethod,
      tokenKind: tokenKind(account || {})
    };
  }

  function assertProviderCapability(account: CapabilityAccount | null | undefined, feature: string) {
    return registry.assertCapabilityAvailable(
      deps.document,
      providerCapabilityContext(account, feature),
      { qualification: deps.qualification }
    );
  }

  function capabilityAccess(feature: string) {
    return function enforceCapability(req: CapabilityRequest, res: CapabilityResponse, next: () => void) {
      try {
        req.capability = assertProviderCapability(req.gh, feature);
        next();
      } catch (e) {
        const error = e as { readonly status?: number; readonly message?: unknown; readonly code?: unknown };
        res.status(error.status || 409).json({
          error: error.message,
          code: error.code || 'PROVIDER_CAPABILITY_UNAVAILABLE',
          feature
        });
      }
    };
  }

  /*
   * A capability only some of a route's requests use, checked before the body
   * is read whenever the request asks for it; the handler still asserts it at
   * the point of use for the requests that come to need it on their own.
   */
  function capabilityAccessWhen(feature: string, applies: (req: CapabilityRequest) => boolean) {
    const check = capabilityAccess(feature);
    return function enforceCapabilityWhen(req: CapabilityRequest, res: CapabilityResponse, next: () => void) {
      if (!applies(req)) return next();
      return check(req, res, next);
    };
  }

  function requestSupportsCapability(req: CapabilityRequest, feature: string): boolean {
    return registry.resolveCapability(
      deps.document,
      providerCapabilityContext(req.gh, feature)
    ).status === 'Supported';
  }

  function assertProviderBoundLfs(account: CapabilityAccount | null | undefined) {
    const context = providerCapabilityContext(account, 'lfs');
    if (context.provider !== 'github' || context.authority !== 'github.com') {
      throw new registry.CapabilityError(
        'LFS is not qualified for this provider and deployment.',
        'PROVIDER_CAPABILITY_UNAVAILABLE'
      );
    }
    return registry.assertCapabilityAvailable(deps.document, context);
  }

  return {
    providerCapabilities, providerCapabilityContext, assertProviderCapability, capabilityAccess, capabilityAccessWhen,
    requestSupportsCapability, assertProviderBoundLfs
  };
}

export type CapabilityAccess = ReturnType<typeof createCapabilityAccess>;
