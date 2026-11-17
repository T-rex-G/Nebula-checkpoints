/*
 * What the browser needs to know about this deployment before anyone signs
 * in, and what a signed-in account may do here.
 *
 * The configuration names the hosting profile, the alpha's mode and terms,
 * the hosted limits and the database's readiness, which sign-in routes are
 * set up, and the upload ceilings the browser plans against: the server's own
 * numbers, published so the browser never keeps a copy that could drift. A
 * qualification deployment names the capabilities it serves ahead of their
 * proof. The capability projection is GitHub's on github.com, the only
 * provider served; an account's own is private to it.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { hostedConfigProjection, type HostedConfigInput } from '../../platform/persistence/hosted-readiness.ts';
import type { Fields } from '../../platform/values/fields.ts';

export interface UploadCeilings {
  readonly uploadMaxMb: number;
  readonly gitDataMaxMb: number;
  readonly nativePushMaxMb: number;
  /* The boundary above which an upload leaves the blob API for a native push. */
  readonly contentsMaxMb: number;
}

export interface ConfigRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  /* The hosted projection's inputs as they stand when asked: the database's readiness changes. */
  hostedConfig(): HostedConfigInput;
  /* Whether GitHub OAuth sign-in is configured, and the GitHub App's state. */
  readonly oauth: boolean;
  readonly githubApp: { readonly enabled: boolean; readonly webhookConfigured: boolean };
  readonly uploads: UploadCeilings;
  /* The capabilities a qualification deployment serves ahead of their proof; empty elsewhere. */
  readonly qualificationCapabilities: readonly string[];
  /* The capability document projected for a provider, an authority and this deployment. */
  projectCapabilities(context: unknown): unknown;
  readonly deployment: string;
  /* The capability context of the account the session is acting as. */
  accountCapabilityContext(account: Fields): unknown;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
}

export function registerConfigRoutes(app: Application, deps: ConfigRouteDeps): void {
  const { providerSessionAccess } = deps;

  app.get('/api/config', (req: Request, res: Response) => res.json({
    ...hostedConfigProjection(deps.hostedConfig()),
    oauth: deps.oauth,
    githubApp: { enabled: deps.githubApp.enabled, webhookConfigured: deps.githubApp.webhookConfigured },
    uploadMaxMb: deps.uploads.uploadMaxMb,
    gitDataMaxMb: deps.uploads.gitDataMaxMb,
    nativePushMaxMb: deps.uploads.nativePushMaxMb,
    contentsMaxMb: deps.uploads.contentsMaxMb,
    ...(deps.qualificationCapabilities.length ? { qualification: { capabilities: [...deps.qualificationCapabilities] } } : {})
  }));

  app.get('/api/capabilities', (req: Request, res: Response) => {
    if (req.query.provider !== undefined && req.query.provider !== 'github') {
      res.status(400).json({ error: 'Only GitHub is supported', code: 'PROVIDER_UNSUPPORTED' });
      return;
    }
    if (req.query.authority !== undefined && req.query.authority !== 'github.com') {
      res.status(400).json({ error: 'Only github.com is supported', code: 'PROVIDER_AUTHORITY_UNSUPPORTED' });
      return;
    }
    const provider = 'github';
    const authority = 'github.com';
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(deps.projectCapabilities({ provider, authority, deployment: deps.deployment }));
  });

  app.get('/api/account/capabilities', providerSessionAccess, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Cookie');
    res.json(deps.projectCapabilities(deps.accountCapabilityContext(deps.account(req))));
  });
}
