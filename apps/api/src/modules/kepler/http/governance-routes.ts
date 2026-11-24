/*
 * Kepler's governance routes: templates and baselines, the digital twin,
 * notifications, outbound webhooks and evidence exports, policies and their
 * drafts, versions, simulations, reviews, decisions and exceptions -- and, in
 * a second registration because the route policy keeps them apart
 * (test/oracles/route-policy.json), the rest of a policy's life: exception
 * revocation, activation and rollback, deactivation, archive and restore,
 * withdrawal, and a reset of the repository's governance.
 *
 * Every route stands behind the governance guard, which resolves the
 * repository's scope and the caller's authorization and attaches the
 * governance service; each handler is one service call with what the request
 * names. The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { cleanText } from '../../../platform/values/text.ts';
import { member } from '../../../platform/values/fields.ts';
import { projectGovernanceInterfaceAccess } from '../domain/governance-interface.ts';
import type { createGovernanceApiService } from '../application/governance-api.ts';

/* What the governance guard attaches to a request. */
export interface GovernanceRequest {
  readonly service: ReturnType<typeof createGovernanceApiService>;
  readonly scope: unknown;
  readonly authorization: unknown;
}

export interface GovernanceRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  readonly governanceAccess: (role: string) => RequestHandler;
  readonly governanceMutationContext: (action: string) => RequestHandler;
  /* What the governance guard attached. */
  readonly governance: (req: Request) => GovernanceRequest;
  /* The provider account the session is acting as, for the facts a baseline is generated from. */
  readonly account: (req: Request) => unknown;
  gh(account: unknown, apiPath: string): Promise<unknown>;
}

/*
 * A governance failure as the caller may see it: a governance, mutation,
 * authorization, simulation or policy error keeps its words, status and
 * code; anything else is logged by its code alone and answered as a failure
 * of the operation, without its message.
 */
/* A response a failure is answered on: any that answers a status with a JSON body, Express's among them. */
interface FailureAnswer { status(code: number): { json(body: unknown): unknown } }

export function governanceFailure(res: FailureAnswer, error: unknown): unknown {
  const code = String((error && member(error, 'code')) || '');
  const known = /^(?:GOVERNANCE|MUTATION|AUTHORIZATION|SIMULATION|POLICY)_/.test(code);
  const rawStatus = Number(error && member(error, 'status'));
  const status = known && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  if (!known) {
    console.error(JSON.stringify({
      t: new Date().toISOString(), warn: 'governance operation failed',
      code: code || 'GOVERNANCE_OPERATION_FAILED'
    }));
  }
  return res.status(status).json({
    error: known ? cleanText(String(member(error, 'message') || 'Governance operation failed'), 300) : 'Governance operation failed',
    code: known ? code : 'GOVERNANCE_OPERATION_FAILED'
  });
}

export function registerGovernanceRoutes(app: Application, deps: GovernanceRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, governanceAccess, governanceMutationContext, governance, account } = deps;
  const repositoryPath = (req: Request): string => `/repos/${req.params.owner}/${req.params.repo}`;

  /* The repository facts a baseline is generated from: its default branch, visibility and protected branches. */
  const readRepositoryFacts = async (req: Request): Promise<Record<string, unknown>> => {
    const [repository, branches] = await Promise.all([
      deps.gh(account(req), repositoryPath(req)),
      deps.gh(account(req), `${repositoryPath(req)}/branches?per_page=100`)
    ]);
    const info = {
      defaultBranch: member(repository, 'default_branch') || null,
      visibility: member(repository, 'visibility') || (member(repository, 'private') ? 'private' : 'public'),
      archived: !!member(repository, 'archived'),
      pullRequestsEnabled: true
    };
    const branchRows: readonly unknown[] = Array.isArray(branches) ? branches : [];
    const protectedCandidates = branchRows
      .filter(branch => branch && member(branch, 'protected') === true && member(branch, 'name'))
      .map(branch => String(member(branch, 'name')))
      .sort((a, b) => a.localeCompare(b));
    const protectedBranches = protectedCandidates.slice(0, 50);
    return {
      schemaVersion: 1,
      defaultBranch: info.defaultBranch,
      protectedBranches,
      pullRequestsEnabled: info.pullRequestsEnabled,
      visibility: info.visibility,
      archived: info.archived,
      branchesComplete: branchRows.length < 100,
      protectedBranchesTruncated: protectedCandidates.length > 50,
      resolvedForScopeKey: member(governance(req).scope, 'scopeKey')
    };
  };

  app.get('/api/repo/:owner/:repo/governance/templates', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const templates = await governance(req).service.listPolicyTemplates({ scope: governance(req).scope, authorization: governance(req).authorization });
      res.json({ templates });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/templates/:templateId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const template = await governance(req).service.getPolicyTemplate({ scope: governance(req).scope, authorization: governance(req).authorization, templateId: req.params.templateId });
      res.json({ template });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/baselines/generate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), capabilityAccess('branches.read'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const repositoryFacts = await readRepositoryFacts(req);
      const baseline = await governance(req).service.generateRepositoryBaseline({
        scope: governance(req).scope,
        authorization: governance(req).authorization,
        input: req.body,
        repositoryFacts
      });
      res.json({ baseline });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/digital-twin', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const digitalTwin = await governance(req).service.getPolicyDigitalTwin({
        scope: governance(req).scope,
        authorization: governance(req).authorization,
        historyLimit: req.query.historyLimit,
        afterDecisionSeq: req.query.afterDecisionSeq,
        beforeDecisionSeq: req.query.beforeDecisionSeq
      });
      const access = projectGovernanceInterfaceAccess(governance(req).authorization);
      res.json({ digitalTwin, access });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/notifications/preferences', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const preferences = await governance(req).service.getNotificationPreferences({ scope: governance(req).scope, authorization: governance(req).authorization });
      res.json({ preferences });
    } catch (error) { governanceFailure(res, error); }
  });

  app.put('/api/repo/:owner/:repo/governance/notifications/preferences', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), governanceMutationContext('governance.notification.preferences.update'), async (req: Request, res: Response) => {
    try {
      const preferences = await governance(req).service.updateNotificationPreferences({
        scope: governance(req).scope, authorization: governance(req).authorization, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.json({ preferences });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/notifications', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const notifications = await governance(req).service.listNotifications({
        scope: governance(req).scope, authorization: governance(req).authorization,
        limit: req.query.limit, afterSeq: req.query.afterSeq
      });
      res.json(notifications);
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/notifications/read', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), governanceMutationContext('governance.notification.read'), async (req: Request, res: Response) => {
    try {
      const preferences = await governance(req).service.markNotificationsRead({
        scope: governance(req).scope, authorization: governance(req).authorization, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.json({ preferences });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/webhooks', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), async (req: Request, res: Response) => {
    try {
      const webhooks = await governance(req).service.listWebhooks({ scope: governance(req).scope, authorization: governance(req).authorization });
      res.json({ webhooks });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/webhooks', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.webhook.create'), async (req: Request, res: Response) => {
    try {
      const result = await governance(req).service.createWebhook({
        scope: governance(req).scope, authorization: governance(req).authorization, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json(result);
    } catch (error) { governanceFailure(res, error); }
  });

  app.patch('/api/repo/:owner/:repo/governance/webhooks/:webhookId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.webhook.update'), async (req: Request, res: Response) => {
    try {
      const webhook = await governance(req).service.updateWebhook({
        scope: governance(req).scope, authorization: governance(req).authorization,
        webhookId: req.params.webhookId, input: req.body, idempotencyKey: req.get('Idempotency-Key')
      });
      res.json({ webhook });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/webhooks/:webhookId/rotate-secret', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.webhook.rotate'), async (req: Request, res: Response) => {
    try {
      const result = await governance(req).service.rotateWebhookSecret({
        scope: governance(req).scope, authorization: governance(req).authorization,
        webhookId: req.params.webhookId, input: req.body, idempotencyKey: req.get('Idempotency-Key')
      });
      res.json(result);
    } catch (error) { governanceFailure(res, error); }
  });

  app.delete('/api/repo/:owner/:repo/governance/webhooks/:webhookId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.webhook.delete'), async (req: Request, res: Response) => {
    try {
      const webhook = await governance(req).service.deleteWebhook({
        scope: governance(req).scope, authorization: governance(req).authorization,
        webhookId: req.params.webhookId, input: req.body, idempotencyKey: req.get('Idempotency-Key')
      });
      res.json({ webhook });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/webhooks/:webhookId/deliveries', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), async (req: Request, res: Response) => {
    try {
      const deliveries = await governance(req).service.listWebhookDeliveries({
        scope: governance(req).scope, authorization: governance(req).authorization,
        webhookId: req.params.webhookId, limit: req.query.limit
      });
      res.json({ deliveries });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/exports', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const exports = await governance(req).service.listEvidenceExports({
        scope: governance(req).scope, authorization: governance(req).authorization, limit: req.query.limit
      });
      res.json({ exports });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/exports', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), governanceMutationContext('governance.audit.export.create'), async (req: Request, res: Response) => {
    try {
      const evidenceExport = await governance(req).service.createEvidenceExport({
        scope: governance(req).scope, authorization: governance(req).authorization, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ export: evidenceExport });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/exports/:exportId/verify', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const verification = await governance(req).service.verifyEvidenceExport({
        scope: governance(req).scope, authorization: governance(req).authorization, exportId: req.params.exportId
      });
      res.json({ verification });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/exports/:exportId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const evidenceExport = await governance(req).service.getEvidenceExport({
        scope: governance(req).scope, authorization: governance(req).authorization, exportId: req.params.exportId
      });
      res.setHeader('Content-Disposition', `attachment; filename="nebulaverse-governance-${req.params.exportId}.json"`);
      res.type('application/vnd.nebulaverse.governance-evidence-envelope+json').send(JSON.stringify(evidenceExport));
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/policies', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const policies = await governance(req).service.listPolicies({
        scope: governance(req).scope, authorization: governance(req).authorization, limit: req.query.limit
      });
      res.json({ policies });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/decisions/verify', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const verification = await governance(req).service.verifyPolicyDecisionChain({
        scope: governance(req).scope, authorization: governance(req).authorization, limit: req.query.limit
      });
      res.json({ verification });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/decisions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const result = await governance(req).service.listPolicyDecisions({
        scope: governance(req).scope, authorization: governance(req).authorization, limit: req.query.limit, afterSeq: req.query.afterSeq, beforeSeq: req.query.beforeSeq
      });
      res.json(result);
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.policy.create'), async (req: Request, res: Response) => {
    try {
      const policy = await governance(req).service.createPolicy({
        scope: governance(req).scope, authorization: governance(req).authorization, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ policy });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/policies/:policyId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const policy = await governance(req).service.getPolicy({
        scope: governance(req).scope, authorization: governance(req).authorization, policyId: req.params.policyId
      });
      res.json({ policy });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/validate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), async (req: Request, res: Response) => {
    try {
      const validation = await governance(req).service.validatePolicyVersion({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, input: req.body
      });
      res.json({ validation });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.draft.create'), async (req: Request, res: Response) => {
    try {
      const draft = await governance(req).service.createDraft({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ draft });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), async (req: Request, res: Response) => {
    try {
      const draft = await governance(req).service.getDraft({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, draftId: req.params.draftId
      });
      res.json({ draft });
    } catch (error) { governanceFailure(res, error); }
  });

  app.patch('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.draft.update'), async (req: Request, res: Response) => {
    try {
      const draft = await governance(req).service.updateDraft({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, draftId: req.params.draftId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.json({ draft });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/validate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), async (req: Request, res: Response) => {
    try {
      const validation = await governance(req).service.validateDraft({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, draftId: req.params.draftId
      });
      res.json({ validation });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/submit', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.draft.submit'), async (req: Request, res: Response) => {
    try {
      const version = await governance(req).service.submitDraft({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, draftId: req.params.draftId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ version });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const versions = await governance(req).service.listVersions({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, limit: req.query.limit
      });
      res.json({ versions });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const version = await governance(req).service.getVersion({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId
      });
      res.json({ version });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/simulate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const simulation = await governance(req).service.simulateVersion({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId, input: req.body
      });
      res.json({ simulation });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/review', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const review = await governance(req).service.getReviewState({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId
      });
      res.json({ review });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/reviewers/me', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reviewer'), governanceMutationContext('governance.reviewer.assign'), async (req: Request, res: Response) => {
    try {
      const result = await governance(req).service.claimReviewer({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json(result);
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/decisions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reviewer'), governanceMutationContext('governance.approval.decide'), async (req: Request, res: Response) => {
    try {
      const result = await governance(req).service.recordReviewDecision({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json(result);
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const exceptions = await governance(req).service.listExceptions({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId, limit: req.query.limit
      });
      res.json({ exceptions });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.exception.request'), async (req: Request, res: Response) => {
    try {
      const exception = await governance(req).service.createException({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ exception });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/exceptions/:exceptionId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const exception = await governance(req).service.getException({
        scope: governance(req).scope, authorization: governance(req).authorization,
        exceptionId: req.params.exceptionId
      });
      res.json({ exception });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/exceptions/:exceptionId/decision', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.exception.decide'), async (req: Request, res: Response) => {
    try {
      const exception = await governance(req).service.decideException({
        scope: governance(req).scope, authorization: governance(req).authorization,
        exceptionId: req.params.exceptionId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ exception });
    } catch (error) { governanceFailure(res, error); }
  });
}

export function registerGovernanceLifecycleRoutes(app: Application, deps: GovernanceRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, governanceAccess, governanceMutationContext, governance } = deps;

  app.post('/api/repo/:owner/:repo/governance/exceptions/:exceptionId/revoke', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.exception.revoke'), async (req: Request, res: Response) => {
    try {
      const exception = await governance(req).service.revokeException({
        scope: governance(req).scope, authorization: governance(req).authorization,
        exceptionId: req.params.exceptionId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ exception });
    } catch (error) { governanceFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/governance/policies/:policyId/activations', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const activations = await governance(req).service.listActivationHistory({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, limit: req.query.limit
      });
      res.json({ activations });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/activate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('activator'), governanceMutationContext('governance.policy.activate'), async (req: Request, res: Response) => {
    try {
      const activation = await governance(req).service.activateVersion({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ activation });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/rollback', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('activator'), governanceMutationContext('governance.policy.rollback'), async (req: Request, res: Response) => {
    try {
      const activation = await governance(req).service.rollbackVersion({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ activation });
    } catch (error) { governanceFailure(res, error); }
  });

  /*
   * The rest of a policy's life. Each route states its role twice on purpose:
   * once here, where the request is refused before any work is done, and again
   * in the service, which does not trust that it was only ever called from here.
   */
  app.get('/api/repo/:owner/:repo/governance/archive', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const policies = await governance(req).service.listArchivedPolicies({
        scope: governance(req).scope, authorization: governance(req).authorization, limit: req.query.limit
      });
      res.json({ policies });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/deactivate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('activator'), governanceMutationContext('governance.policy.deactivate'), async (req: Request, res: Response) => {
    try {
      const deactivation = await governance(req).service.deactivatePolicy({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ deactivation });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/archive', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.policy.archive'), async (req: Request, res: Response) => {
    try {
      const archive = await governance(req).service.archivePolicy({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ archive });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/restore', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.policy.restore'), async (req: Request, res: Response) => {
    try {
      const restore = await governance(req).service.restorePolicy({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ restore });
    } catch (error) { governanceFailure(res, error); }
  });

  app.delete('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.draft.discard'), async (req: Request, res: Response) => {
    try {
      const draft = await governance(req).service.discardDraft({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, draftId: req.params.draftId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.json({ draft });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/withdraw', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.version.withdraw'), async (req: Request, res: Response) => {
    try {
      const withdrawal = await governance(req).service.withdrawVersion({
        scope: governance(req).scope, authorization: governance(req).authorization,
        policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
        idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ withdrawal });
    } catch (error) { governanceFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/governance/reset', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.reset'), async (req: Request, res: Response) => {
    try {
      const reset = await governance(req).service.resetGovernance({
        scope: governance(req).scope, authorization: governance(req).authorization,
        input: req.body, idempotencyKey: req.get('Idempotency-Key')
      });
      res.status(201).json({ reset });
    } catch (error) { governanceFailure(res, error); }
  });
}
