/*
 * Uranus's routes: the repository audit, its kept history and watch, the
 * team's decisions about its findings, the grade for what a page holds, where
 * a branch stands against its clocks, and the merge gate. Each answers from
 * the code-audit service (application/code-audit-service.ts), which the
 * server builds once because the governed merge, sign-out and shutdown reach
 * it too.
 *
 * The guards are handed in under the names the route policy records
 * (test/oracles/route-policy.json), and the routes are registered in its
 * order. A kept audit is the reader's own work, keyed by identity, so a
 * public repository's reader may keep one; a decision about a finding is the
 * repository's, shared by its collaborators -- reading the decisions takes
 * the reader role on the repository itself, and deciding takes the reviewer
 * role, so a person who can push cannot wave away a finding in their own
 * change. Each decision and each reopening is a governed action as well,
 * recorded in the evidence ledger with the actor's name on it.
 */
import type { Application, NextFunction, Request, RequestHandler, Response } from 'express';
import { isFields, member } from '../../../platform/values/fields.ts';
import type { Fields } from '../../../platform/values/fields.ts';
import { VOCABULARY as TRIAGE_VOCABULARY, inForce, rescore, summarizeDecisions } from '../domain/audit-triage.ts';
import { mergeAttributes } from '../application/merge-gate.ts';
import { describeKeptAudit } from '../persistence/audit-history-records.ts';
import type { CodeAuditService } from '../application/code-audit-service.ts';

/* What a governance role check may admit beyond the repository's collaborators. */
export interface GovernanceAccessOptions {
  readonly publicRepositories?: boolean;
}

export interface CodeAuditRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  /* The account check alone, for the one route that names no repository. */
  readonly accountAuth: RequestHandler;
  readonly governanceAccess: (role: string, options?: GovernanceAccessOptions) => RequestHandler;
  /* Admits a public repository's reader to the routes whose data is their own. */
  readonly OWN_WORK: GovernanceAccessOptions;
  readonly governanceMutationContext: (action: string) => RequestHandler;
  /* What the governance guard attached: the scope, the actor, the authorization and whether the reader is only a public one. */
  readonly governance: (req: Request) => unknown;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => unknown;
  /* The server's public error answer, and its public error body. */
  readonly fail: (res: Response, error: unknown) => unknown;
  publicErrorBody(error: unknown): unknown;
  /* Who a decision is recorded as made by. */
  retainedActor(req: Request): unknown;
  identityKey(account: unknown): string;
  readonly service: CodeAuditService;
}

/* A request body that is a plain object, or an empty one. */
function bodyOf(value: unknown): Fields {
  return isFields(value) && !Buffer.isBuffer(value) ? value : {};
}

/* The branch a kept audit is read for. */
function auditHistoryRef(req: Request): string {
  const ref = String(req.query.ref || '').trim();
  if (!ref || ref.length > 255) throw Object.assign(new Error('ref is required'), { status: 400, code: 'AUDIT_REF_REQUIRED' });
  return ref;
}

/* A finding of an audit, as its id names it. */
function findingParam(req: Request): string {
  const id = String(req.params.findingId || '').toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(id)) throw Object.assign(new Error('That is not a finding of an audit'), { status: 400, code: 'CODE_AUDIT_FINDING_INVALID' });
  return id;
}

/* A store the server did not build is a failure of that one request, as calling it on null always was. */
function present<T>(store: T | null): T {
  if (store === null) throw new TypeError('the store is not configured');
  return store;
}

export function registerCodeAuditRoutes(app: Application, deps: CodeAuditRouteDeps): void {
  const {
    providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, accountAuth,
    governanceAccess, OWN_WORK, governanceMutationContext, account, fail, service
  } = deps;
  const scopeOf = (req: Request): unknown => member(deps.governance(req), 'scope');
  const identityOf = (req: Request): unknown => member(member(deps.governance(req), 'actor'), 'identityKey');

  /* The public error body, at the error's own status when it carries one. */
  const auditFailure = (res: Response, error: unknown): void => {
    const status = Number.isInteger(error ? member(error, 'status') : error) ? member(error, 'status') : 500;
    res.status(Number(status)).json(deps.publicErrorBody(error));
  };

  /* Without a database there is no history, and the page is told so rather than shown an empty one. */
  const auditHistoryAvailable = (req: Request, res: Response, next: NextFunction): void => {
    if (service.history()) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') { res.json({ available: false }); return; }
    res.status(503).json({ error: 'Audit history requires the configured PostgreSQL DATABASE_URL', code: 'CODE_AUDIT_HISTORY_UNAVAILABLE' });
  };

  /*
   * The repository audit. The first request starts it and answers 202 with a
   * run id; the page asks again with `run` and hears the stage until the
   * result is there.
   */
  app.get('/api/repo/:owner/:repo/code-audit', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const ref = String(req.query.ref || '').trim();
    if (!ref) { res.status(400).json({ error: 'ref is required', code: 'AUDIT_REF_REQUIRED' }); return; }
    const { owner, repo } = req.params;
    const token = member(account(req), 'token');
    const session = account(req);
    const answer = service.jobs.request({
      identity: deps.identityKey(account(req)), owner, repo, ref, run: String(req.query.run || '').trim(),
      launch: async ({ onProgress, signal }) => service.runAudit({ account: session, owner, repo, ref, token, onProgress, signal })
    });
    if ('error' in answer) { fail(res, answer.error); return; }
    if (answer.status === 202) res.setHeader('Retry-After', '2');
    res.status(answer.status).json(answer.body);
  });

  app.get('/api/repo/:owner/:repo/code-audit/history', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const ref = auditHistoryRef(req);
      const listed = await present(service.history()).list({ scope: scopeOf(req), identityKey: identityOf(req), ref });
      res.json({ available: true, ref, audits: listed.audits, branches: listed.branches });
    } catch (error) { auditFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/code-audit/history/:auditId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const found = await present(service.history()).read({ scope: scopeOf(req), identityKey: identityOf(req), auditId: String(req.params.auditId || '') });
      if (!found) { res.status(404).json({ error: 'That audit is not kept for this repository', code: 'CODE_AUDIT_NOT_FOUND' }); return; }
      /* Each kept finding with its rule's words, so the kept audit can be read and exported on its own. */
      res.json(describeKeptAudit(found));
    } catch (error) { auditFailure(res, error); }
  });

  /* The watch answers from what it stored, and asks OSV and CISA again when that answer is six hours old -- or ten minutes, when asked to. */
  app.get('/api/repo/:owner/:repo/code-audit/watch', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const ref = auditHistoryRef(req);
      const watched = await present(service.watch()).refresh({
        scope: scopeOf(req), identityKey: identityOf(req), ref, force: req.query.refresh === '1'
      });
      res.json({ available: true, ref, ...watched });
    } catch (error) { auditFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/code-audit/history/clear', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reader', OWN_WORK), governanceMutationContext('code-audit.history.clear'), async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req.body);
      if (String(body.confirm || '') !== 'clear-audit-history') {
        res.status(400).json({ error: 'Clearing audit history requires an explicit confirmation', code: 'CODE_AUDIT_CLEAR_UNCONFIRMED' });
        return;
      }
      const cleared = await present(service.history()).clear({ scope: scopeOf(req), identityKey: identityOf(req) });
      res.status(201).json({ cleared });
    } catch (error) { auditFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/code-audit/triage', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const decisions = await present(service.triage()).list({ scope: scopeOf(req) });
      res.json({
        available: true,
        canDecide: member(member(member(deps.governance(req), 'authorization'), 'governanceRoles'), 'reviewer') === true,
        vocabulary: TRIAGE_VOCABULARY,
        decisions
      });
    } catch (error) { auditFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/code-audit/findings/:findingId/triage', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reviewer'), governanceMutationContext('code-audit.finding.triage'), async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req.body);
      const decision = await present(service.triage()).decide({
        scope: scopeOf(req),
        findingId: findingParam(req),
        rule: String(body.rule || ''),
        input: { disposition: body.disposition, reason: body.reason, expiresInDays: body.expiresInDays },
        actor: deps.retainedActor(req),
        actorKey: identityOf(req)
      });
      res.status(201).json({ decision });
    } catch (error) { auditFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/code-audit/findings/:findingId/reopen', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reviewer'), governanceMutationContext('code-audit.finding.reopen'), async (req: Request, res: Response) => {
    try {
      const removed = await present(service.triage()).reopen({
        scope: scopeOf(req),
        findingId: findingParam(req),
        actor: deps.retainedActor(req),
        actorKey: identityOf(req)
      });
      if (!removed) { res.status(404).json({ error: 'Nobody has decided anything about that finding', code: 'CODE_AUDIT_TRIAGE_NOT_FOUND' }); return; }
      res.status(201).json({ reopened: removed });
    } catch (error) { auditFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/code-audit/findings/:findingId/triage-events', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const events = await present(service.triage()).events({ scope: scopeOf(req), findingId: findingParam(req) });
      res.json({ events });
    } catch (error) { auditFailure(res, error); }
  });

  /*
   * The grade and the fix-first list for what the page holds, after a decision
   * moved a finding out of it, worked out by the engine's own scoring. Pure: it
   * reads nothing and keeps nothing.
   */
  app.post('/api/code-audit/score', providerSessionAccess, capabilityAccess('code-audit'), accountAuth, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = bodyOf(req.body);
    if (!Array.isArray(body.findings)) { res.status(400).json({ error: 'findings are required', code: 'CODE_AUDIT_SCORE_INVALID' }); return; }
    res.json(rescore(body.findings));
  });

  /*
   * Where a branch stands against its clocks, and how long fixing has taken.
   * The reader's own audits, as the history is; the team's decisions take
   * findings out of the count for a collaborator.
   */
  app.get('/api/repo/:owner/:repo/code-audit/metrics', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, auditHistoryAvailable, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const ref = auditHistoryRef(req);
      const team = member(deps.governance(req), 'publicReader') ? null : await service.triageForAccount(account(req), req.params.owner, req.params.repo);
      const decisions = team && 'decisions' in team && team.decisions ? team.decisions : new Map();
      const now = Date.now();
      const triaged = (finding: { readonly id: unknown; readonly rule: unknown }): boolean => {
        const decision = decisions.get(finding.id);
        return Boolean(decision && decision.rule === finding.rule && inForce(decision, now));
      };
      const metrics = await present(service.history()).metrics({ scope: scopeOf(req), identityKey: identityOf(req), ref, isTriaged: triaged, now });
      res.json({
        available: true, ref, ...metrics,
        triage: team && 'decisions' in team && team.decisions ? summarizeDecisions(team.decisions, now) : null,
        triageUnavailable: Boolean(team && 'unavailable' in team && team.unavailable)
      });
    } catch (error) { auditFailure(res, error); }
  });

  /*
   * The merge gate for the page, before anybody presses Merge, with the
   * active policies' answer beside it -- read without writing, so no decision
   * is recorded for a merge nobody asked for.
   */
  app.get('/api/repo/:owner/:repo/code-audit/gate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth, governanceAccess('reader'), async (req: Request, res: Response) => {
    try {
      const number = Number.parseInt(String(req.query.pull || ''), 10);
      if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
        res.status(400).json({ error: 'pull is required', code: 'AUDIT_GATE_PULL_REQUIRED' });
        return;
      }
      const pull = await service.readPullFacts({ account: account(req), owner: req.params.owner, repo: req.params.repo }, number);
      const gate = await service.mergeGateFor(account(req), req.params.owner, req.params.repo, pull);
      let enforcement: unknown;
      try { enforcement = await service.gatePolicies(scopeOf(req), mergeAttributes(pull, gate)); }
      catch { enforcement = { available: false, policies: [] }; }
      res.json({ available: Boolean(service.history()), pull, gate, enforcement });
    } catch (error) { fail(res, error); }
  });
}
