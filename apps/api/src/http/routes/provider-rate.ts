/*
 * The signed-in account's GitHub API budget: how many core requests remain,
 * of how many, and when the window resets.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { member, type Fields } from '../../platform/values/fields.ts';

export interface ProviderRateRouteDeps {
  readonly auth: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly gh: (account: Fields, apiPath: string) => Promise<unknown>;
}

export function registerProviderRateRoute(app: Application, deps: ProviderRateRouteDeps): void {
  const { auth, capabilityAccess, account, fail, gh } = deps;
  app.get('/api/rate', auth, capabilityAccess('rate.read'), async (req: Request, res: Response) => {
    try {
      const r = await gh(account(req), '/rate_limit');
      const core = () => member(member(r, 'resources'), 'core');
      res.json({ remaining: member(core(), 'remaining'), limit: member(core(), 'limit'), reset: member(core(), 'reset') });
    } catch (e) { fail(res, e); }
  });
}
