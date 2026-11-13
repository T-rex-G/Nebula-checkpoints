/*
 * Corona's safeguards routes: the session's safety state -- read-only mode,
 * the sync freeze, and each repository's protected paths -- read and
 * changed. A change commits for the identity first, then its evidence is
 * written, then the session's copy; the answer is the same view the read
 * gives, so no other repository's protected paths come back from a change to
 * this one.
 *
 * The guards are handed in under the names the route policy records.
 */
import crypto from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import { member } from '../../../platform/values/fields.ts';
import type { SafetyState } from './recovery-routes.ts';

export interface SafeguardDeps {
  readonly providerSessionAccess: RequestHandler;
  /* A hosted alpha's refusal of an identity-wide or unscoped change. */
  readonly alphaSafetyMutationAccess: RequestHandler;
  readonly accountAuth: RequestHandler;
  readonly account: (req: Request) => unknown;
  readonly fail: (res: Response, error: unknown) => unknown;
  safetyOf(req: Request): SafetyState;
  /* The safety state a reader may see. */
  alphaSafetyView(req: Request, state: unknown): unknown;
  savePersistentSafety(req: Request, patch: unknown): Promise<SafetyState>;
  saveSessionSafetyCopy(req: Request, res: Response): Promise<unknown>;
  appendEvidence(key: string, kind: string, recordId: string, payload: unknown): Promise<unknown>;
  retainedActor(req: Request): unknown;
  identityKey(account: unknown): string;
}

export function registerSafeguardRoutes(app: Application, deps: SafeguardDeps): void {
  const { providerSessionAccess, alphaSafetyMutationAccess, accountAuth, account, fail } = deps;

  app.get('/api/safety', providerSessionAccess, accountAuth, (req: Request, res: Response) => { res.json(deps.alphaSafetyView(req, deps.safetyOf(req))); });

  app.post('/api/safety', providerSessionAccess, alphaSafetyMutationAccess, accountAuth, async (req: Request, res: Response) => {
    try {
      const patch: unknown = req.body || {};
      const cur = await deps.savePersistentSafety(req, patch);
      Object.assign(req, { effectiveSafety: cur });
      /* The change has committed: its evidence is written before anything else can fail. */
      const protect = member(patch, 'protect');
      const relatedRepo = protect && member(protect, 'repo') ? member(protect, 'repo') : 'identity';
      await deps.appendEvidence(`safety:${deps.identityKey(account(req))}`, 'safety-change', crypto.randomUUID(), {
        actor: deps.retainedActor(req), repository: relatedRepo, readOnly: cur.readOnly, freezeSync: cur.freezeSync,
        protectedCount: Object.values(cur.protected).reduce((n, x) => n + x.length, 0), changedAt: new Date().toISOString()
      }).catch(() => {});
      await deps.saveSessionSafetyCopy(req, res);
      res.json(deps.alphaSafetyView(req, member(req, 'effectiveSafety')));
    } catch (e) { fail(res, e); }
  });
}
